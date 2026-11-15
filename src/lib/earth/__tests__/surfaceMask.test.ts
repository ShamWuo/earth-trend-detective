import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getTimeSeriesRoute } from "@/app/api/earth/timeseries/route";
import { parseGeocaAhccdJson } from "@/lib/agencies/challengeSourcesClient";
import { parseAgencyFormattedText } from "@/lib/discovery/datasetImport";
import {
  classifyEarthSurface,
  validateDatasetForSurface,
} from "@/lib/earth/surfaceMask";
import { EtgStore, getEtgStore } from "@/lib/graph/etgStore";
import { validateGraphAction } from "@/lib/graph/graphGuard";
import { describeGeographicZone } from "@/lib/plainLanguage";
import type { ETGNode } from "@/types/etg";

function makeAnnualPowerJson(lat: number, lng: number) {
  const mkSeries = (base: number, step: number) => {
    const out: Record<string, number> = {};
    for (let y = 1995; y <= 2025; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        out[`${y}${String(m).padStart(2, "0")}`] = Number(
          (base + (y - 1995) * step + Math.sin(m) * 0.1).toFixed(2)
        );
      }
    }
    return out;
  };
  return {
    geometry: { coordinates: [lng, lat, 0] },
    properties: {
      parameter: {
        T2M: mkSeries(10.0, 0.04),
        T2M_MAX: mkSeries(18.0, 0.05),
        RH2M: mkSeries(48.0, -0.1),
        TS: mkSeries(22.0, 0.03),
        PRECTOTCORR: mkSeries(1.4, 0.01),
        ALLSKY_SFC_SW_DWN: mkSeries(4.8, 0.01),
        EVPTRNS: mkSeries(1.9, -0.01),
        AOD_55: mkSeries(0.12, 0.001),
      },
    },
  };
}

describe("Earth surface mask, dataset domain gating & taxonomy sanitization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    getEtgStore().clearGraph(false);
  });

  it("classifies inland land, inland lakes, coastal marine, and open ocean accurately", () => {
    for (const [lat, lng] of [
      [40.0, -105.2], // Boulder, CO
      [39.74, -104.99], // Denver, CO
      [36.53, -116.93], // Death Valley, CA
      [-89.0, 0.0], // Antarctica interior
    ]) {
      const info = classifyEarthSurface(lat, lng);
      expect(info.regime).toBe("inland_land");
      expect(info.hasMarineSurface).toBe(false);
      expect(info.hasTerrestrialSurface).toBe(true);
      expect(validateDatasetForSurface("ocean_temp", lat, lng).applicable).toBe(false);
      expect(validateDatasetForSurface("wildfire", lat, lng).applicable).toBe(true);
    }

    for (const [lat, lng] of [
      [41.1, -112.5], // Great Salt Lake
      [47.7, -87.5], // Lake Superior
      [41.5, 51.0], // Caspian Sea
    ]) {
      const info = classifyEarthSurface(lat, lng);
      expect(info.regime).toBe("inland_lake");
      expect(info.isInlandLake).toBe(true);
      expect(info.hasMarineSurface).toBe(false);
      expect(validateDatasetForSurface("ocean_temp", lat, lng).applicable).toBe(false);
    }

    for (const [lat, lng] of [
      [25.76, -80.19], // Miami, FL
      [37.77, -122.42], // San Francisco, CA
      [21.31, -157.86], // Honolulu, HI
    ]) {
      const info = classifyEarthSurface(lat, lng);
      expect(info.regime).toBe("coastal_marine");
      expect(info.hasMarineSurface).toBe(true);
      expect(info.hasTerrestrialSurface).toBe(true);
      expect(validateDatasetForSurface("ocean_temp", lat, lng).applicable).toBe(true);
      expect(validateDatasetForSurface("wildfire", lat, lng).applicable).toBe(true);
    }

    for (const [lat, lng] of [
      [0.0, -150.0], // Equatorial Pacific
      [30.0, -40.0], // North Atlantic
      [43.5, 34.0], // Black Sea
    ]) {
      const info = classifyEarthSurface(lat, lng);
      expect(info.regime).toBe("open_ocean");
      expect(info.hasMarineSurface).toBe(true);
      expect(info.hasTerrestrialSurface).toBe(false);
      expect(validateDatasetForSurface("ocean_temp", lat, lng).applicable).toBe(true);
      expect(validateDatasetForSurface("nasa_power", lat, lng).applicable).toBe(true);
      expect(validateDatasetForSurface("air_quality", lat, lng).applicable).toBe(true);
      expect(validateDatasetForSurface("wildfire", lat, lng).applicable).toBe(false);
      expect(validateDatasetForSurface("deforestation", lat, lng).applicable).toBe(false);
      expect(validateDatasetForSurface("hydrology", lat, lng).applicable).toBe(false);
    }
  });

  it("excludes ocean_temp in Boulder and excludes terrestrial datasets in open Equatorial Pacific via /api/earth/timeseries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("power.larc.nasa.gov")) {
          const latMatch = url.match(/latitude=([-+]?\d+(?:\.\d+)?)/);
          const lngMatch = url.match(/longitude=([-+]?\d+(?:\.\d+)?)/);
          const lat = latMatch ? Number(latMatch[1]) : 0;
          const lng = lngMatch ? Number(lngMatch[1]) : 0;
          return new Response(JSON.stringify(makeAnnualPowerJson(lat, lng)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      })
    );

    const boulderRes = await getTimeSeriesRoute(
      new NextRequest(
        "http://localhost:3000/api/earth/timeseries?lat=40.01&lng=-105.27&datasets=nasa_power,wildfire,ocean_temp,hydrology,deforestation,air_quality"
      )
    );
    expect(boulderRes.status).toBe(200);
    const boulderJson = (await boulderRes.json()) as {
      summaries: Array<{ dataset: string; parameter: string }>;
      diagnostics?: { datasets?: Array<{ dataset: string; status: string }> };
    };
    const boulderDatasets = boulderJson.summaries.map((s) => s.dataset);
    expect(boulderDatasets).not.toContain("ocean_temp");
    expect(boulderDatasets).toContain("nasa_power");
    expect(
      boulderJson.diagnostics?.datasets?.find((d) => d.dataset === "ocean_temp")?.status
    ).toBe("unavailable");

    const pacificRes = await getTimeSeriesRoute(
      new NextRequest(
        "http://localhost:3000/api/earth/timeseries?lat=0.05&lng=-150.05&datasets=nasa_power,wildfire,ocean_temp,hydrology,deforestation,air_quality"
      )
    );
    expect(pacificRes.status).toBe(200);
    const pacificJson = (await pacificRes.json()) as {
      summaries: Array<{ dataset: string }>;
      diagnostics?: { datasets?: Array<{ dataset: string; status: string }> };
    };
    const pacificDatasets = pacificJson.summaries.map((s) => s.dataset);
    expect(pacificDatasets).toContain("ocean_temp");
    expect(pacificDatasets).not.toContain("wildfire");
    expect(pacificDatasets).not.toContain("deforestation");
    expect(pacificDatasets).not.toContain("hydrology");
  });

  it("never fabricates an inland ocean_temp climatological fallback in Boulder when upstreams fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    const res = await getTimeSeriesRoute(
      new NextRequest(
        "http://localhost:3000/api/earth/timeseries?lat=40.02&lng=-105.28&dataset=ocean_temp&fallback=1"
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      primary: { dataset: string } | null;
      climatologicalFallback?: { dataset: string } | null;
    };
    expect(body.primary?.dataset).not.toBe("ocean_temp");
    expect(body.climatologicalFallback?.dataset).not.toBe("ocean_temp");
  });

  it("classifies Geo.ca AHCCD as nasa_power, distinguishes KNMI .dat domains, and enforces graphGuard surface checks", () => {
    const ahccd = parseGeocaAhccdJson(
      {
        features: Array.from({ length: 6 }, (_, i) => ({
          geometry: { coordinates: [-68.52, 70.49] as [number, number] },
          properties: {
            year__annee: 2020 + i,
            temp_mean__temp_moyenne: -9.5 + i * 0.2,
          },
        })),
      },
      {
        id: "geoca-ahccd-2400573",
        name: "Clyde River AHCCD",
        region: "Nunavut",
        fallbackLat: 70.47,
        fallbackLng: -68.59,
        sourceUrl: "https://api.weather.gc.ca/collections/ahccd-annual/items",
      },
      1995,
      2025
    );
    expect(ahccd?.dataset).toBe("nasa_power");

    const knmiAirRows = parseAgencyFormattedText(
      [
        "# climexp.knmi.nl De Bilt mean temperature",
        "# YEAR JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC",
        "2018 5.1 2.0 4.5 11.2 15.8 18.0 20.9 19.2 14.5 11.2 6.8 5.5",
        "2019 3.9 5.9 7.8 10.6 12.1 17.5 18.7 19.0 14.8 11.5 6.4 5.9",
        "2020 6.2 6.4 6.9 11.3 13.7 17.2 17.3 20.6 15.1 10.9 8.7 5.2",
        "2021 3.7 4.4 6.6 7.3 12.4 18.0 18.4 17.5 15.9 11.7 7.1 5.0",
        "2022 5.4 6.2 7.2 9.4 14.7 17.4 19.2 20.9 14.9 12.6 8.3 3.4",
      ].join("\n"),
      { defaultName: "De Bilt Station Temp", defaultLat: 52.1, defaultLng: 5.18 }
    );
    expect(knmiAirRows[0]?.dataset).toBe("nasa_power");

    const knmiNinoRows = parseAgencyFormattedText(
      [
        "# climexp.knmi.nl Nino3.4 ERSST v5 index",
        "# YEAR JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC",
        "2020 0.5 0.4 0.5 0.4 -0.2 -0.3 -0.2 -0.5 -0.9 -1.2 -1.3 -1.2",
        "2021 -1.0 -0.9 -0.8 -0.7 -0.5 -0.2 -0.3 -0.5 -0.5 -0.8 -0.9 -1.0",
        "2022 -1.0 -0.9 -1.0 -1.1 -1.0 -0.8 -0.7 -0.9 -1.0 -0.9 -0.9 -0.8",
        "2023 -0.7 -0.5 -0.2 0.2 0.5 0.9 1.1 1.3 1.5 1.7 1.9 2.0",
        "2024 1.8 1.5 1.1 0.8 0.3 0.1 -0.1 -0.2 -0.3 -0.3 -0.4 -0.5",
      ].join("\n"),
      { defaultName: "Nino3.4 SST", defaultLat: 0, defaultLng: -140 }
    );
    expect(knmiNinoRows[0]?.dataset).toBe("ocean_temp");

    const store = getEtgStore();
    const inlandOcean = validateGraphAction(store, {
      type: "ingest_live_signal",
      name: "Boulder SST Probe",
      lat: 40.0,
      lng: -105.2,
      dataset: "ocean_temp",
      rationale: "Check inland SST rejection",
    });
    expect(inlandOcean.allowed).toBe(false);

    const oceanWildfire = validateGraphAction(store, {
      type: "ingest_live_signal",
      name: "Pacific Open Ocean Wildfire",
      lat: 0.0,
      lng: -150.0,
      dataset: "wildfire",
      rationale: "Check open ocean wildfire rejection",
    });
    expect(oceanWildfire.allowed).toBe(false);
  });

  it("skips coordinate-only or placeholder regions in describeGeographicZone and sanitizes persisted taxonomy on load", () => {
    const placeholderNode: ETGNode = {
      uuid: "signal-wh-redteam-esp32-01",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "ESP32 Sensor",
        description: "Local sensor",
        lat: 40.01,
        lng: -105.27,
        dataset: "community",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    };
    const empiricalNode: ETGNode = {
      uuid: "signal-emp",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "Empirical",
        description: "Imported",
        lat: 40.0,
        lng: -105.25,
        region: "Empirical Series",
        dataset: "community",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    };
    const namedHubNode: ETGNode = {
      uuid: "signal-solar-denver-target",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "Denver Solar Target",
        description: "Solar hub",
        lat: 39.74,
        lng: -104.99,
        region: "Front Range Hub, CO",
        dataset: "nasa_power",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    };
    expect(
      describeGeographicZone(40.0, -105.2, [placeholderNode, empiricalNode, namedHubNode])
    ).toBe("Near Front Range Hub, CO");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "etg-sanitize-"));
    try {
      const legacyNodes: ETGNode[] = [
        {
          uuid: "signal-geoca-ahccd-2400573",
          label: "Signal",
          is_provisional: false,
          properties: {
            name: "Clyde River AHCCD",
            description: "Air temp",
            lat: 67.55,
            lng: -64.03,
            dataset: "ocean_temp",
            parameter: "AHCCD Mean Temp (Geo.ca)",
            source_system: "CSA / Geo.ca AHCCD",
            created_at: "2025-01-01T00:00:00.000Z",
          },
        },
        {
          uuid: "signal-usgs-mississippi-07374000",
          label: "Signal",
          is_provisional: false,
          properties: {
            name: "Mississippi Discharge",
            description: "Discharge",
            lat: 30.45,
            lng: -91.19,
            dataset: "air_quality",
            parameter: "River Discharge vs SeaWiFS Chl-a",
            created_at: "2025-01-01T00:00:00.000Z",
          },
        },
        {
          uuid: "signal-power-rh-eonet_1",
          label: "Signal",
          is_provisional: false,
          properties: {
            name: "MERRA-2 RH2M",
            description: "Humidity",
            lat: 40.0,
            lng: -105.2,
            dataset: "deforestation",
            parameter: "RH2M",
            created_at: "2025-01-01T00:00:00.000Z",
          },
        },
        {
          uuid: "signal-swot-pass-ocean",
          label: "Signal",
          is_provisional: false,
          properties: {
            name: "SWOT RiverSP Pass",
            description: "Swath midpoint in Norwegian Sea",
            lat: 67.74,
            lng: -3.42,
            dataset: "hydrology",
            parameter: "SWOT_L2_HR_RiverSP_2.0",
            created_at: "2025-01-01T00:00:00.000Z",
          },
        },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "etg-state.json"),
        JSON.stringify({ nodes: legacyNodes, edges: [], activity: [] }),
        "utf8"
      );

      const reloaded = new EtgStore({ persistDir: tmpDir });
      expect(reloaded.getNode("signal-geoca-ahccd-2400573")?.properties.dataset).toBe(
        "nasa_power"
      );
      expect(reloaded.getNode("signal-usgs-mississippi-07374000")?.properties.dataset).toBe(
        "hydrology"
      );
      expect(reloaded.getNode("signal-power-rh-eonet_1")?.properties.dataset).toBe(
        "nasa_power"
      );
      expect(reloaded.getNode("signal-swot-pass-ocean")).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
