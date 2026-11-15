import { describe, expect, it, vi } from "vitest";
import {
  calibrateStormRiskModel,
  computeUpwindWeight,
  DENVER_CLIMATE_NODES,
  fetchDenverSolarClimateGraph,
  PRECHARGE_CYCLE_COST_USD,
  runThreeWaySolarEvaluation,
  SHORTFALL_SPREAD_USD_PER_KWH,
  type DailyWeatherRow,
} from "@/lib/solar/denverClimateGraph";

function makeSyntheticSeries(
  days: number,
  phaseShift: number,
  noiseSeed: number
): DailyWeatherRow[] {
  const rows: DailyWeatherRow[] = [];
  const start = Date.UTC(2022, 0, 1);
  for (let i = 0; i < days; i++) {
    const dt = new Date(start + i * 86400000);
    const yyyymmdd = dt.toISOString().slice(0, 10).replace(/-/g, "");
    const doy = (i % 365) + 1;
    const clrsky = 5.0 + 2.8 * Math.sin(((doy - 80) * 2 * Math.PI) / 365);
    const wave = Math.sin((i + phaseShift) * 0.45) * 0.22 + ((i * noiseSeed) % 7) * 0.02;
    const kt = Math.max(0.2, Math.min(0.95, 0.72 + wave));
    rows.push({
      date: yyyymmdd,
      allsky: clrsky * kt,
      clrsky,
      kt,
      t2m: 12 + 10 * Math.sin(((doy - 100) * 2 * Math.PI) / 365),
      rh2m: 45 + (1 - kt) * 40,
      precip: kt < 0.45 ? 4.2 : 0.0,
      ws10m: 4.5,
      wd10m: 270, // westerly wind
    });
  }
  return rows;
}

describe("Denver Local Climate Graph", () => {
  it("computes upwind alignment weight highest for western Silverthorne under westerly wind", () => {
    const westNode = DENVER_CLIMATE_NODES.find((n) => n.id === "silverthorne-w")!;
    const eastNode = DENVER_CLIMATE_NODES.find((n) => n.id === "limon-e")!;
    const wWest = computeUpwindWeight(270, westNode.lat, westNode.lng);
    const wEast = computeUpwindWeight(270, eastNode.lat, eastNode.lng);
    expect(wWest).toBeGreaterThan(0.85);
    expect(wEast).toBe(0);
  });

  it("runs a strict temporal 3-way comparison and returns valid metrics, decision, and failure case", () => {
    const seriesByNode: Record<string, DailyWeatherRow[]> = {};
    // 1100 days (~3 years: 2022-01-01 to 2025-01-04)
    seriesByNode["denver-target"] = makeSyntheticSeries(1150, 0, 3);
    for (const [idx, node] of DENVER_CLIMATE_NODES.entries()) {
      if (node.id === "denver-target") continue;
      // Upwind western node leads Denver by 1 day
      const lead = node.id === "silverthorne-w" ? 1 : idx;
      seriesByNode[node.id] = makeSyntheticSeries(1150, lead, idx + 2);
    }

    const res = runThreeWaySolarEvaluation(seriesByNode, "20240901");
    expect(res.nodes).toHaveLength(7);
    expect(res.trainDays).toBeGreaterThan(800);
    expect(res.testDays).toBeGreaterThan(100);
    expect(res.metrics.graphAware.rmse).toBeLessThan(res.metrics.persistence.rmse);
    expect(res.metrics.graphAware.calibratedThreshold).toBeGreaterThanOrEqual(3.35);
    expect(res.metrics.graphAware.calibratedThreshold).toBeLessThanOrEqual(4.0);
    expect(res.topFailure.absErrorGraph).toBeGreaterThan(0);
    expect(typeof res.tomorrow.chargeBatteryOvernight).toBe("boolean");
    expect(Number.isFinite(res.economics.annualSavingsVsPersistenceUsd)).toBe(true);
    expect(res.economics.graphPolicy.stormCaptureRecallPct).toBeGreaterThanOrEqual(0);
    expect(res.economics.graphPolicy.stormCaptureRecallPct).toBeLessThanOrEqual(100);
    expect(res.economics.disclaimer.length).toBeGreaterThan(20);
  });

  it("merges evening 18:00-23:00 hourly advection signals from Open-Meteo and tolerates partial outages", async () => {
    const startMs = Date.UTC(2022, 0, 1);
    const totalDays = 960;
    const allsky: Record<string, number> = {};
    const clrsky: Record<string, number> = {};
    const t2m: Record<string, number> = {};
    const rh2m: Record<string, number> = {};
    const precip: Record<string, number> = {};
    const ws10m: Record<string, number> = {};
    const wd10m: Record<string, number> = {};
    const ps: Record<string, number> = {};
    const hourlyTime: string[] = [];
    const hourlyCloud: number[] = [];
    const hourlyPs: number[] = [];
    const hourlyRh: number[] = [];
    const hourlyWs: number[] = [];
    const hourlyWd: number[] = [];

    for (let i = 0; i < totalDays; i++) {
      const dt = new Date(startMs + i * 86400000);
      const iso = dt.toISOString().slice(0, 10);
      const yyyymmdd = iso.replace(/-/g, "");
      const clear = 5.4 + 2.4 * Math.sin(((i % 365) * 2 * Math.PI) / 365);
      const kt = 0.72 + Math.sin(i * 0.37) * 0.18;
      clrsky[yyyymmdd] = clear;
      allsky[yyyymmdd] = clear * kt;
      t2m[yyyymmdd] = 10;
      rh2m[yyyymmdd] = 52;
      precip[yyyymmdd] = kt < 0.55 ? 2.1 : 0;
      ws10m[yyyymmdd] = 4.0;
      wd10m[yyyymmdd] = 270;
      ps[yyyymmdd] = 83;
      for (const hr of ["18:00", "21:00", "23:00"]) {
        hourlyTime.push(`${iso}T${hr}`);
        hourlyCloud.push(kt < 0.6 ? 78 : 18);
        hourlyPs.push(hr === "18:00" ? 830 : 828);
        hourlyRh.push(kt < 0.6 ? 74 : 40);
        hourlyWs.push(5.1);
        hourlyWd.push(270);
      }
    }

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("power.larc.nasa.gov")) {
        return new Response(
          JSON.stringify({
            properties: {
              parameter: {
                ALLSKY_SFC_SW_DWN: allsky,
                CLRSKY_SFC_SW_DWN: clrsky,
                T2M: t2m,
                RH2M: rh2m,
                PRECTOTCORR: precip,
                WS10M: ws10m,
                WD10M: wd10m,
                PS: ps,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("archive-api.open-meteo.com") && url.includes("hourly=")) {
        const nodePayload = {
          hourly: {
            time: hourlyTime,
            cloud_cover: hourlyCloud,
            surface_pressure: hourlyPs,
            relative_humidity_2m: hourlyRh,
            wind_speed_10m: hourlyWs,
            wind_direction_10m: hourlyWd,
          },
        };
        return new Response(JSON.stringify(Array.from({ length: 7 }, () => nodePayload)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("api.open-meteo.com") && url.includes("hourly=")) {
        return new Response(JSON.stringify({ reason: "simulated outage" }), { status: 503 });
      }
      return new Response(JSON.stringify({ daily: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const result = await fetchDenverSolarClimateGraph(2022, 2025, { forceRefresh: true });
      expect(result.liveBridgeSource).toContain("18:00–23:00 Hourly Advection");
      expect(result.dataSource).toContain("Open-Meteo Evening Hourly");
      expect(result.economics.graphPolicy.totalLowSolarDays).toBeGreaterThanOrEqual(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("recovers automatically from NASA POWER future-date HTTP 422 by retrying with end=20251231", async () => {
    const startMs = Date.UTC(2022, 0, 1);
    const totalDays = 1000;
    const allsky: Record<string, number> = {};
    const clrsky: Record<string, number> = {};
    const t2m: Record<string, number> = {};
    const rh2m: Record<string, number> = {};
    const precip: Record<string, number> = {};
    const ws10m: Record<string, number> = {};
    const wd10m: Record<string, number> = {};
    const ps: Record<string, number> = {};

    for (let i = 0; i < totalDays; i++) {
      const dt = new Date(startMs + i * 86400000);
      const yyyymmdd = dt.toISOString().slice(0, 10).replace(/-/g, "");
      const clear = 5.2 + 2.5 * Math.sin(((i % 365) * 2 * Math.PI) / 365);
      const kt = 0.68 + Math.sin(i * 0.4) * 0.2;
      clrsky[yyyymmdd] = clear;
      allsky[yyyymmdd] = clear * kt;
      t2m[yyyymmdd] = 11;
      rh2m[yyyymmdd] = 48;
      precip[yyyymmdd] = kt < 0.5 ? 2.5 : 0;
      ws10m[yyyymmdd] = 4.2;
      wd10m[yyyymmdd] = 270;
      ps[yyyymmdd] = 83;
    }

    const seenEnds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("power.larc.nasa.gov")) {
        const end = new URL(url).searchParams.get("end") ?? "";
        seenEnds.push(end);
        if (end > "20251231") {
          return new Response(JSON.stringify({ message: "Future end date" }), { status: 422 });
        }
        return new Response(
          JSON.stringify({
            properties: {
              parameter: {
                ALLSKY_SFC_SW_DWN: allsky,
                CLRSKY_SFC_SW_DWN: clrsky,
                T2M: t2m,
                RH2M: rh2m,
                PRECTOTCORR: precip,
                WS10M: ws10m,
                WD10M: wd10m,
                PS: ps,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ daily: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const result = await fetchDenverSolarClimateGraph(2022, 2026, { forceRefresh: true });
      expect(result.nodes).toHaveLength(7);
      expect(result.trainDays).toBeGreaterThan(500);
      expect(result.testDays).toBeGreaterThan(50);
      expect(seenEnds.some((e) => e > "20251231")).toBe(true);
      expect(seenEnds.filter((e) => e === "20251231")).toHaveLength(7);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("calibrates monotonic probabilistic P(ALLSKY < 3.5) and Bayes expected-cost dispatch without test leakage", () => {
    const valActuals = [2.4, 3.1, 3.4, 3.8, 4.1, 4.5, 4.9, 5.2, 5.6, 6.1, 2.8, 4.3];
    const valPreds = [2.6, 3.0, 3.6, 3.7, 4.0, 4.4, 4.7, 5.4, 5.5, 5.9, 2.9, 4.4];
    const cal = calibrateStormRiskModel(valActuals, valPreds);

    expect(PRECHARGE_CYCLE_COST_USD).toBeCloseTo(26.25, 4);
    expect(SHORTFALL_SPREAD_USD_PER_KWH).toBeCloseTo(0.205, 4);
    expect(cal.residualStd).toBeGreaterThanOrEqual(0.25);

    const lowForecast = cal.assess(2.0);
    const midForecast = cal.assess(3.5);
    const highForecast = cal.assess(6.2);

    expect(lowForecast.probStormPct).toBeGreaterThanOrEqual(0);
    expect(lowForecast.probStormPct).toBeLessThanOrEqual(100);
    expect(lowForecast.probStormPct).toBeGreaterThan(midForecast.probStormPct);
    expect(midForecast.probStormPct).toBeGreaterThan(highForecast.probStormPct);

    // Bayes expected-cost decision: storm forecast triggers pre-charge, clear sky holds
    expect(lowForecast.prechargeCycleCostUsd).toBeCloseTo(26.25, 2);
    expect(lowForecast.expectedShortfallPenaltyUsd).toBeGreaterThan(
      lowForecast.expectedFalsePrechargeCostUsd
    );
    expect(lowForecast.bayesOptimalPrecharge).toBe(true);
    expect(highForecast.bayesOptimalPrecharge).toBe(false);
    expect(highForecast.expectedShortfallPenaltyUsd).toBeLessThan(
      highForecast.expectedFalsePrechargeCostUsd
    );

    // End-to-end 4-way evaluation & leak-free invariance under unseen test-target mutations
    const baseSeries: Record<string, DailyWeatherRow[]> = {};
    baseSeries["denver-target"] = makeSyntheticSeries(1150, 0, 3);
    for (const [idx, node] of DENVER_CLIMATE_NODES.entries()) {
      if (node.id === "denver-target") continue;
      const lead = node.id === "silverthorne-w" ? 1 : idx;
      baseSeries[node.id] = makeSyntheticSeries(1150, lead, idx + 2);
    }

    const resBefore = runThreeWaySolarEvaluation(baseSeries, "20240901");
    expect(resBefore.metrics.localDailyOnly.name).toContain("Daily");
    expect(resBefore.metrics.graphAware.stormBrierScore).toBeGreaterThanOrEqual(0);
    expect(resBefore.metrics.graphAware.stormBrierScore).toBeLessThanOrEqual(1);
    expect(resBefore.economics.probabilisticGraphPolicy.policyName).toContain("Bayes");
    expect(resBefore.economics.prechargeCycleCostUsd).toBeCloseTo(26.25, 2);
    expect(resBefore.economics.shortfallSpreadUsdPerKwh).toBeCloseTo(0.205, 3);
    expect(resBefore.tomorrow.probStormPct).toBeGreaterThanOrEqual(0);
    expect(resBefore.tomorrow.probStormPct).toBeLessThanOrEqual(100);
    expect(typeof resBefore.tomorrow.bayesOptimalPrecharge).toBe("boolean");
    expect(resBefore.recentTestSeries.every((r) => typeof r.probStormPct === "number")).toBe(true);

    // Mutate only test target days (>= 20240901) without touching latest feature rows
    const mutatedSeries: Record<string, DailyWeatherRow[]> = {
      ...baseSeries,
      "denver-target": baseSeries["denver-target"].map((row, idx, arr) =>
        row.date >= "20240901" && idx < arr.length - 10
          ? { ...row, allsky: 0.4, kt: 0.08 }
          : row
      ),
    };
    const resAfter = runThreeWaySolarEvaluation(mutatedSeries, "20240901");
    // Calibration parameters (`calibratedThreshold`, Bayes break-even threshold, tomorrow risk) must be unchanged
    expect(resAfter.metrics.graphAware.calibratedThreshold).toBe(
      resBefore.metrics.graphAware.calibratedThreshold
    );
    expect(resAfter.economics.probabilisticGraphPolicy.thresholdKwh).toBe(
      resBefore.economics.probabilisticGraphPolicy.thresholdKwh
    );
    expect(resAfter.tomorrow.probStormPct).toBe(resBefore.tomorrow.probStormPct);
  });
});
