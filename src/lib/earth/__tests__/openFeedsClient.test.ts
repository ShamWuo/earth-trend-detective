import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCamsSurfacePm25Series,
  fetchGlofasDischargeSeries,
  fetchNearestUsgsGaugeAnnualSeries,
  isWithinUsgsBounds,
  parseCamsHourlyPm25Payload,
  parseGlofasDailyPayload,
  parseUsgsSiteRdb,
} from "@/lib/earth/openFeedsClient";

describe("Open Physical Earth Feeds Client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks USGS coverage bounds cleanly across US vs Europe/Ocean", () => {
    expect(isWithinUsgsBounds(39.74, -104.99)).toBe(true); // Denver, CO
    expect(isWithinUsgsBounds(64.8, -147.7)).toBe(true); // Fairbanks, AK
    expect(isWithinUsgsBounds(48.85, 2.35)).toBe(false); // Paris, FR
    expect(isWithinUsgsBounds(-3.4, -60.0)).toBe(false); // Amazon basin
  });

  it("parses USGS site RDB and sorts nearest gauges first by geodesic distance", () => {
    const rdb = [
      "# USGS NWIS site file",
      "agency_cd\tsite_no\tstation_nm\tdec_lat_va\tdec_long_va",
      "5s\t15s\t50s\t16s\t16s",
      "USGS\t06714000\tSOUTH PLATTE RIVER AT DENVER, CO\t39.7597\t-105.0020",
      "USGS\t06711565\tSOUTH PLATTE RIVER AT ENGLEWOOD, CO\t39.6660\t-105.0020",
      "USGS\t06720500\tSOUTH PLATTE RIVER AT HENDERSON, CO\t39.9219\t-104.8686",
    ].join("\n");

    const sites = parseUsgsSiteRdb(rdb, 39.75, -105.0);
    expect(sites).toHaveLength(3);
    expect(sites[0].siteNo).toBe("06714000");
    expect(sites[0].distanceKm).toBeLessThan(sites[1].distanceKm);
    expect(sites[1].distanceKm).toBeLessThan(sites[2].distanceKm);
  });

  it("aggregates GloFAS daily m³/s river discharge into annual and monthly points", () => {
    const times: string[] = [];
    const values: Array<number | null> = [];
    for (let y = 2020; y <= 2025; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 15; d++) {
          times.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
          values.push(m === 6 ? 180 : 60 + (y - 2020) * 5);
        }
      }
    }

    const annual = parseGlofasDailyPayload({ daily: { time: times, river_discharge: values } }, 2020, 2025, "annual");
    expect(annual).toHaveLength(6);
    expect(annual[0].date).toBe("2020");
    expect(annual[5].value).toBeGreaterThan(annual[0].value);

    const monthly = parseGlofasDailyPayload({ daily: { time: times, river_discharge: values } }, 2020, 2025, "monthly");
    expect(monthly.length).toBe(72);
    expect(monthly[5].date).toBe("2020-06");
    expect(monthly[5].value).toBeCloseTo(180, 2);
  });

  it("aggregates Copernicus CAMS hourly PM2.5 (μg/m³) into monthly points", () => {
    const times: string[] = [];
    const values: Array<number | null> = [];
    for (let m = 1; m <= 6; m++) {
      for (let d = 1; d <= 2; d++) {
        for (let h = 0; h < 24; h++) {
          times.push(`2024-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00`);
          values.push(8.5 + m);
        }
      }
    }

    const monthly = parseCamsHourlyPm25Payload({ hourly: { time: times, pm2_5: values } }, 2022, 2025, "monthly");
    expect(monthly).toHaveLength(6);
    expect(monthly[0]).toMatchObject({ date: "2024-01", value: 9.5 });
    expect(monthly[5]).toMatchObject({ date: "2024-06", value: 14.5 });
  });

  it("queries USGS NWIS with mixed-case bBox and converts ft³/s to m³/s via fetch mock", async () => {
    const capturedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      capturedUrls.push(url);
      if (url.includes("/nwis/site/")) {
        return new Response(
          [
            "agency_cd\tsite_no\tstation_nm\tdec_lat_va\tdec_long_va",
            "5s\t15s\t50s\t16s\t16s",
            "USGS\t06714000\tSOUTH PLATTE RIVER AT DENVER, CO\t39.7597\t-105.0020",
          ].join("\n"),
          { status: 200 }
        );
      }
      return new Response(
        [
          "agency_cd\tsite_no\tparameter_cd\tyear_nu\tmean_va",
          "5s\t15s\t5s\t4s\t10s",
          ...[2018, 2019, 2020, 2021, 2022, 2023].map(
            (yr) => `USGS\t06714000\t00060\t${yr}\t100.0`
          ),
        ].join("\n"),
        { status: 200 }
      );
    });

    const result = await fetchNearestUsgsGaugeAnnualSeries(39.75, -105.0, 2015, 2024);
    expect(result).not.toBeNull();
    expect(capturedUrls[0]).toContain("&bBox=");
    expect(result?.provenanceSource).toBe("USGS NWIS River Gauge (Live)");
    expect(result?.unit).toBe("m³/s");
    expect(result?.points).toHaveLength(6);
    expect(result?.points[0].value).toBe(2.8);
  });

  it("fetches GloFAS discharge and CAMS PM2.5 feeds when upstream returns >= 6 buckets", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("flood-api.open-meteo.com")) {
        const times: string[] = [];
        const vals: number[] = [];
        for (let y = 2018; y <= 2023; y++) {
          for (let d = 1; d <= 35; d++) {
            times.push(`${y}-01-${String(((d - 1) % 28) + 1).padStart(2, "0")}`);
            vals.push(42 + (y - 2018));
          }
        }
        return new Response(JSON.stringify({ daily: { time: times, river_discharge: vals } }), {
          status: 200,
        });
      }
      const times: string[] = [];
      const vals: number[] = [];
      for (let m = 1; m <= 7; m++) {
        for (let h = 0; h < 26; h++) {
          const day = h >= 24 ? 2 : 1;
          times.push(`2024-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(h % 24).padStart(2, "0")}:00`);
          vals.push(12 + m);
        }
      }
      return new Response(JSON.stringify({ hourly: { time: times, pm2_5: vals } }), {
        status: 200,
      });
    });

    const glofas = await fetchGlofasDischargeSeries(48.85, 2.35, 2018, 2023, "annual");
    expect(glofas?.provenanceSource).toBe("Copernicus GloFAS v4 (Live)");
    expect(glofas?.points).toHaveLength(6);

    const cams = await fetchCamsSurfacePm25Series(39.74, -104.99, 2022, 2024, "monthly");
    expect(cams?.provenanceSource).toBe("Copernicus CAMS PM2.5 (Live)");
    expect(cams?.points).toHaveLength(7);
    expect(cams?.unit).toBe("μg/m³");
  });
});
