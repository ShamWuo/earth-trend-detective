import { describe, expect, it } from "vitest";
import {
  analyzeTimeSeries,
  benjaminiHochbergAdjust,
  computeOlsRegression,
  computePettittChangePoint,
  computeSeasonalMannKendall,
  mannKendallTest,
  normalCdf,
  theilSenEstimator,
  twoTailedNormalPValue,
} from "../trendEngine";
import type { TimeSeriesPoint } from "@/types/etg";

function createDeterministicGaussian(seedStart: number) {
  let state = seedStart >>> 0;
  const nextUniform = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  return () => {
    const u1 = Math.max(1e-12, nextUniform());
    const u2 = nextUniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

function generateAr1Series(n: number, rho: number, seed: number): number[] {
  const randn = createDeterministicGaussian(seed);
  const sigma = Math.sqrt(Math.max(1e-6, 1 - rho * rho));
  const out = new Array<number>(n);
  out[0] = randn();
  for (let i = 1; i < n; i++) {
    out[i] = rho * out[i - 1] + sigma * randn();
  }
  return out;
}

describe("Statistical Edge Pathologies (trendEngine.ts)", () => {
  it("controls false positives under strong AR(1) red noise (rho = 0.85, zero trend) while preserving real-trend power", () => {
    const trials = 160;
    let fpCount48 = 0;
    let fpCount80 = 0;

    for (let trial = 0; trial < trials; trial++) {
      const ar48 = generateAr1Series(48, 0.85, 1000 + trial * 31);
      const mk48 = mannKendallTest(ar48);
      if (mk48.significantAdjusted) fpCount48 += 1;

      const ar80 = generateAr1Series(80, 0.85, 9000 + trial * 37);
      const mk80 = mannKendallTest(ar80);
      if (mk80.significantAdjusted) fpCount80 += 1;
    }

    // Without modified Hamed-Rao + Initial Positive Sequence + Marriott-Pope correction,
    // AR(1) rho=0.85 produces >35-45% false positives at alpha=0.05.
    expect(fpCount48 / trials).toBeLessThanOrEqual(0.18);
    expect(fpCount80 / trials).toBeLessThanOrEqual(0.15);

    // Verify statistical power remains high on real secular trends over AR(1) + white noise.
    let tpCount = 0;
    for (let trial = 0; trial < 40; trial++) {
      const randn = createDeterministicGaussian(50000 + trial * 17);
      const vals = Array.from({ length: 48 }, (_, i) => 0.1 * i + randn());
      const mkTrue = mannKendallTest(vals);
      if (mkTrue.significantAdjusted && mkTrue.direction === "increasing") tpCount += 1;
    }
    expect(tpCount / 40).toBeGreaterThanOrEqual(0.9);
  });

  it("controls monthly AR(1) (rho = 0.85) false positives in computeSeasonalMannKendall via Hirsch-Slack covariance", () => {
    const trials = 100;
    let fpSeasonal = 0;

    for (let trial = 0; trial < trials; trial++) {
      const ar = generateAr1Series(72, 0.85, 7000 + trial * 43);
      const pts: TimeSeriesPoint[] = ar.map((v, i) => ({
        date: `${2019 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
        t: i,
        value: v,
      }));
      const smk = computeSeasonalMannKendall(pts);
      expect(smk).not.toBeNull();
      if (smk!.significant) fpSeasonal += 1;
    }

    // Independent-season Var(S) yields ~50% false positives on monthly AR(1) rho=0.85.
    expect(fpSeasonal / trials).toBeLessThanOrEqual(0.15);
  });

  it("does not manufacture fake trends from pure seasonal sine waves with missing winter months or sub-monthly bursts", () => {
    // Scenario A: 8-year seasonal sine wave where winter months (Dec, Jan, Feb) are dropped in early years 2018-2021
    const missingWinterPts: TimeSeriesPoint[] = [];
    let tIdx = 0;
    for (let y = 2018; y <= 2025; y++) {
      for (let m = 1; m <= 12; m++) {
        if (y <= 2021 && (m === 1 || m === 2 || m === 12)) continue;
        const val = 10 + 9 * Math.sin((2 * Math.PI * (m - 3)) / 12);
        missingWinterPts.push({
          date: `${y}-${String(m).padStart(2, "0")}`,
          t: tIdx++,
          value: val,
        });
      }
    }

    const smkMissing = computeSeasonalMannKendall(missingWinterPts);
    expect(smkMissing).not.toBeNull();
    expect(smkMissing!.significant).toBe(false);
    expect(Math.abs(smkMissing!.seasonalTheilSenSlope)).toBeLessThan(1e-6);

    const analysisMissing = analyzeTimeSeries(missingWinterPts, {
      lat: 40.0,
      lng: -105.0,
      dataset: "nasa_power",
      parameter: "T2M",
      unit: "C",
      slopeUnit: "C/step",
      provenance: "NASA POWER MERRA-2 (Live)",
    });
    expect(analysisMissing.verdict).toBe("Normal Environmental Variability");

    // Scenario B: Sub-monthly growing-season ramp observations inside (year, month) cells
    const subMonthlyPts: TimeSeriesPoint[] = [];
    let tSub = 0;
    for (let y = 2020; y <= 2024; y++) {
      for (const m of [3, 4, 5, 6]) {
        for (const day of [1, 10, 20]) {
          const doyApprox = (m - 1) * 30 + day;
          subMonthlyPts.push({
            date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            t: tSub++,
            value: 5 + 8 * Math.sin((2 * Math.PI * (doyApprox - 70)) / 365),
          });
        }
      }
    }
    const smkSub = computeSeasonalMannKendall(subMonthlyPts);
    expect(smkSub).not.toBeNull();
    expect(smkSub!.significant).toBe(false);
    expect(smkSub!.direction).toBe("no_trend");
    expect(Math.abs(smkSub!.seasonalTheilSenSlope)).toBeLessThan(1e-6);
  });

  it("distinguishes step shifts via O(n^2) Pettitt change-point vs gradual trends", () => {
    const stepPts = Array.from({ length: 40 }, (_, i) => ({
      date: `2022-${String((i % 12) + 1).padStart(2, "0")}`,
      t: i,
      value: (i < 20 ? 10 : 25) + (i % 3) * 0.05,
    }));

    const cp = computePettittChangePoint(stepPts);
    expect(cp).not.toBeNull();
    expect(cp!.index).toBe(20);
    expect(cp!.significant).toBe(true);
    expect(cp!.pValue).toBeLessThan(1e-4);

    // Large n=400 performance sanity for O(n^2) Pettitt recurrence (< 100ms)
    const largeStepPts = Array.from({ length: 400 }, (_, i) => ({
      date: `2000-01`,
      t: i,
      value: i < 200 ? 0 : 5,
    }));
    const startMs = Date.now();
    const largeCp = computePettittChangePoint(largeStepPts);
    const elapsedMs = Date.now() - startMs;
    expect(largeCp).not.toBeNull();
    expect(largeCp!.index).toBe(200);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("handles heavy ties, 0/1/2-point, constant, all-zero, negative, and non-finite series cleanly", () => {
    // 0, 1, 2-point series
    for (const arr of [[], [5], [3, 9]]) {
      const mk = mannKendallTest(arr);
      expect(mk.significant).toBe(false);
      expect(mk.pValue).toBe(1);
      expect(Number.isFinite(mk.zScore)).toBe(true);
    }

    // Constant & all-zero series
    for (const c of [0, 42.5, -17.3]) {
      const vals = Array.from({ length: 30 }, () => c);
      const mk = mannKendallTest(vals);
      expect(mk.s).toBe(0);
      expect(mk.varS).toBe(0);
      expect(mk.pValue).toBe(1);
      expect(mk.significant).toBe(false);
    }

    // Heavy ties with slight downward drift (-ve domain)
    const tiedNeg = [
      ...Array(10).fill(-5),
      ...Array(10).fill(-5),
      ...Array(10).fill(-10),
    ];
    const mkTies = mannKendallTest(tiedNeg);
    expect(mkTies.s).toBeLessThan(0);
    expect(mkTies.varS).toBeGreaterThan(0);
    expect(mkTies.varS).toBeLessThan((30 * 29 * (2 * 30 + 5)) / 18); // tie variance correction strictly smaller than untied var
    expect(Number.isFinite(mkTies.pValueAdjusted)).toBe(true);

    // Non-finite NaN / Infinity values filtered safely without poisoning summary
    const dirtyPts: TimeSeriesPoint[] = [
      { date: "2024-01", t: 0, value: Number.NaN },
      { date: "2024-02", t: 1, value: -10 },
      { date: "2024-03", t: 2, value: Number.POSITIVE_INFINITY },
      { date: "2024-04", t: 3, value: -8 },
      { date: "2024-05", t: 4, value: -6 },
      { date: "2024-06", t: 5, value: -4 },
    ];
    const summary = analyzeTimeSeries(dirtyPts, {
      lat: 0,
      lng: 0,
      dataset: "nasa_power",
      parameter: "T2M",
      unit: "C",
      slopeUnit: "C/step",
      provenance: "NASA POWER MERRA-2 (Live)",
    });
    expect(summary.mannKendall.n).toBe(4);
    expect(Number.isFinite(summary.mean)).toBe(true);
    expect(Number.isFinite(summary.theilSen.slope)).toBe(true);
    expect(normalCdf(Number.NaN)).toBe(0.5);
    expect(twoTailedNormalPValue(Number.NaN)).toBe(1);
    expect(theilSenEstimator([{ t: 0, value: 1 }, { t: 1, value: 3 }]).slope).toBe(2);
    expect(computeOlsRegression([{ t: 0, value: 1 }, { t: 1, value: 3 }]).rSquared).toBe(0);
    expect(computeOlsRegression([{ t: 0, value: 1 }, { t: 1, value: 3 }, { t: 2, value: 5 }]).rSquared).toBe(1);
  });

  it("handles Benjamini-Hochberg FDR adjustment edge cases with full floating precision", () => {
    expect(benjaminiHochbergAdjust([])).toEqual([]);
    expect(benjaminiHochbergAdjust([0.03])).toEqual([0.03]);
    expect(benjaminiHochbergAdjust([0, 0, 0])).toEqual([0, 0, 0]);
    expect(benjaminiHochbergAdjust([1, 1, 1])).toEqual([1, 1, 1]);

    // Clamping invalid/non-finite inputs and preserving monotonicity under ties
    const clamped = benjaminiHochbergAdjust([-0.2, 0.02, 0.02, 1.5, Number.NaN]);
    expect(clamped).toHaveLength(5);
    expect(clamped[0]).toBe(0);
    expect(clamped[1]).toBe(clamped[2]);
    expect(clamped[3]).toBe(1);
    expect(clamped[4]).toBe(1);

    // Ultra-small p-values must NOT round to 0 and violate q >= p
    const tiny = [1e-12, 5e-11, 0.25];
    const qTiny = benjaminiHochbergAdjust(tiny);
    expect(qTiny[0]).toBeGreaterThanOrEqual(tiny[0]);
    expect(qTiny[0]).toBeCloseTo(3e-12, 18);
    expect(qTiny[1]).toBeGreaterThanOrEqual(tiny[1]);
    expect(qTiny[2]).toBe(0.25);
  });
});
