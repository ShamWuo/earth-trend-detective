import { describe, expect, it } from "vitest";
import {
  analyzeTimeSeries,
  benjaminiHochbergAdjust,
  classifyEarthMechanism,
  compareRegionalSeries,
  computeOlsRegression,
  computePettittChangePoint,
  computeSeasonalMannKendall,
  mannKendallTest,
  theilSenEstimator,
} from "@/lib/stats/trendEngine";

describe("Mann-Kendall & Theil-Sen Statistical Engine", () => {
  it("detects a statistically significant increasing trend with tie correction", () => {
    const values = [10.1, 10.4, 10.4, 11.2, 11.8, 12.5, 13.1, 13.9, 14.4, 15.0, 15.7, 16.3];
    const mk = mannKendallTest(values);

    expect(mk.n).toBe(12);
    expect(mk.s).toBeGreaterThan(0);
    expect(mk.tau).toBeGreaterThan(0.9);
    expect(mk.pValue).toBeLessThan(0.001);
    expect(mk.significant).toBe(true);
    expect(mk.direction).toBe("increasing");
  });

  it("detects a statistically significant decreasing trend", () => {
    const values = [0.82, 0.80, 0.77, 0.74, 0.72, 0.69, 0.66, 0.63, 0.61, 0.58, 0.55, 0.52];
    const mk = mannKendallTest(values);

    expect(mk.s).toBeLessThan(0);
    expect(mk.tau).toBeLessThan(-0.9);
    expect(mk.pValue).toBeLessThan(0.001);
    expect(mk.significant).toBe(true);
    expect(mk.direction).toBe("decreasing");
  });

  it("identifies normal environmental variability when no monotonic trend exists", () => {
    const oscillatory = [20, 21, 19, 20.5, 19.5, 20.2, 19.8, 20.1, 19.9, 20.0, 20.3, 19.7];
    const mk = mannKendallTest(oscillatory);

    expect(mk.significant).toBe(false);
    expect(mk.pValue).toBeGreaterThan(0.05);
    expect(mk.direction).toBe("no_trend");
  });

  it("computes robust Theil-Sen slope resilient to single extreme outlier", () => {
    const points = Array.from({ length: 12 }, (_, idx) => ({
      t: 2020 + idx / 12,
      // True slope = +2.4 per year; inject massive outlier at index 5
      value: idx === 5 ? 999 : 15 + 2.4 * (idx / 12),
    }));
    const ts = theilSenEstimator(points);

    expect(ts.slope).toBeCloseTo(2.4, 1);
    expect(ts.slopeLow95).toBeLessThanOrEqual(ts.slope);
    expect(ts.slopeHigh95).toBeGreaterThanOrEqual(ts.slope);
    expect(ts.pairCount).toBe((12 * 11) / 2);
  });

  it("produces full TrendAnalysisSummary with normal variability verdict when flat", () => {
    const flat = Array.from({ length: 12 }, (_, i) => ({
      date: `2025-${String(i + 1).padStart(2, "0")}`,
      t: 2025 + i / 12,
      value: i % 2 === 0 ? 18.0 : 18.2,
    }));
    const summary = analyzeTimeSeries(flat, {
      lat: 0,
      lng: 0,
      dataset: "nasa_power",
      parameter: "T2M",
      unit: "°C",
      slopeUnit: "°C/yr",
      provenance: "NASA POWER MERRA-2 (Live)",
    });

    expect(summary.verdict).toBe("Normal Environmental Variability");
    expect(summary.points).toHaveLength(12);
    expect(summary.points[0].movingAverage).toBeCloseTo(18.0, 4);
  });

  it("classifies opposite-trend regional teleconnections accurately", () => {
    const warmingPacific = Array.from({ length: 12 }, (_, i) => ({
      date: `2025-${String(i + 1).padStart(2, "0")}`,
      t: 2025 + i / 12,
      value: 26.0 + 0.18 * i,
    }));
    const dryingAmazon = Array.from({ length: 12 }, (_, i) => ({
      date: `2025-${String(i + 1).padStart(2, "0")}`,
      t: 2025 + i / 12,
      value: 0.84 - 0.025 * i,
    }));

    const cmp = compareRegionalSeries(warmingPacific, dryingAmazon);
    expect(cmp.classification).toBe("opposite_teleconnection");
    expect(cmp.pearsonR).toBeLessThan(-0.9);
    expect(cmp.spearmanRho).toBeLessThan(-0.9);
    expect(cmp.pValue).toBeLessThan(0.01);
    expect(cmp.alignedPoints).toHaveLength(12);
  });

  it("applies Hamed & Rao (1998) serial-correlation adjustment to Mann-Kendall variance", () => {
    // Persistent AR(1) red-noise walk + gentle drift creates positive residual autocorrelation
    const values: number[] = [];
    let state = 0;
    for (let i = 0; i < 24; i++) {
      const wave = Math.sin((i / 24) * Math.PI * 2) * 1.4;
      state = 0.78 * state + wave * 0.45;
      values.push(15 + 0.08 * i + state);
    }

    const mk = mannKendallTest(values);
    expect(mk.lag1Autocorrelation).toBeGreaterThan(0.3);
    expect(mk.effectiveSampleSize).toBeLessThan(mk.n);
    expect(mk.effectiveSampleSize).toBeLessThanOrEqual(mk.n);
    expect(Math.abs(mk.zScoreAdjusted)).toBeLessThan(Math.abs(mk.zScore));
    expect(mk.pValueAdjusted).toBeGreaterThanOrEqual(mk.pValue);
    expect(typeof mk.significantAdjusted).toBe("boolean");

    // Alternating negative autocorrelation never inflates effectiveSampleSize above n
    const alternating = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : -1) + 0.05 * i);
    const mkAlt = mannKendallTest(alternating);
    expect(mkAlt.effectiveSampleSize).toBeLessThanOrEqual(mkAlt.n);
    expect(mkAlt.pValueAdjusted).toBeGreaterThanOrEqual(mkAlt.pValue);
  });

  it("computes parametric OLS regression and Student-t p-value accurately", () => {
    const pts = Array.from({ length: 16 }, (_, i) => ({
      date: `${2010 + i}`,
      t: 2010 + i,
      value: 1.5 + 0.4 * (2010 + i),
    }));

    const ols = computeOlsRegression(pts);
    expect(ols.slope).toBeCloseTo(0.4, 6);
    expect(ols.intercept).toBeCloseTo(1.5, 4);
    expect(ols.rSquared).toBeGreaterThan(0.999);
    expect(ols.tStat).toBeGreaterThan(20);
    expect(ols.pValue).toBeLessThan(1e-6);
  });

  it("detects regime shifts via the Pettitt change-point test and wires into analyzeTimeSeries", () => {
    const pts = Array.from({ length: 22 }, (_, i) => ({
      date: `${2000 + i}`,
      t: 2000 + i,
      value: (i < 10 ? 12.2 : 16.4) + ((i % 3) - 1) * 0.15,
    }));

    const cp = computePettittChangePoint(pts);
    expect(cp).not.toBeNull();
    expect(cp!.significant).toBe(true);
    expect(cp!.pValue).toBeLessThan(0.05);
    expect(cp!.kStat).toBeGreaterThan(80);
    expect(Number(cp!.date)).toBeGreaterThanOrEqual(2009);
    expect(Number(cp!.date)).toBeLessThanOrEqual(2011);

    const summary = analyzeTimeSeries(pts, {
      lat: 71.29,
      lng: -156.79,
      dataset: "nasa_power",
      parameter: "TAVG",
      unit: "°C",
      slopeUnit: "°C/yr",
      provenance: "NOAA NCEI CDO (Live)",
    });
    expect(summary.ols.rSquared).toBeGreaterThan(0.6);
    expect(summary.changePoint?.significant).toBe(true);
  });

  it("separates shared secular drift from genuine detrended interannual variability", () => {
    const n = 24;
    const sharedDriftA = Array.from({ length: n }, (_, i) => ({
      date: `${2000 + i}`,
      t: 2000 + i,
      value: 10 + 0.45 * i + Math.sin(i * 1.1) * 0.35,
    }));
    const sharedDriftB = Array.from({ length: n }, (_, i) => ({
      date: `${2000 + i}`,
      t: 2000 + i,
      value: 20 + 0.35 * i + Math.cos(i * 1.1) * 0.35,
    }));

    const driftCmp = compareRegionalSeries(sharedDriftA, sharedDriftB);
    expect(driftCmp.pearsonR).toBeGreaterThan(0.85);
    expect(Math.abs(driftCmp.detrendedR)).toBeLessThan(0.35);
    expect(driftCmp.rollingCorrelations.length).toBeGreaterThan(5);

    const coupledB = Array.from({ length: n }, (_, i) => ({
      date: `${2000 + i}`,
      t: 2000 + i,
      value: 5 + 0.9 * i + Math.sin(i * 1.1) * 0.7,
    }));
    const coupledCmp = compareRegionalSeries(sharedDriftA, coupledB);
    expect(coupledCmp.detrendedR).toBeGreaterThan(0.85);
    expect(coupledCmp.slopeRatio).toBeCloseTo(2.0, 0);
  });

  it("recovers optimal +2 step lead-lag driver via cross-correlogram", () => {
    const n = 28;
    const baseDriver = (i: number) => Math.sin(i * 0.42) + 0.45 * Math.cos(i * 0.93);
    const driver = Array.from({ length: n }, (_, i) => ({
      date: `${1998 + i}`,
      t: 1998 + i,
      value: 0.04 * i + baseDriver(i),
    }));
    const response = Array.from({ length: n }, (_, i) => ({
      date: `${1998 + i}`,
      t: 1998 + i,
      value: 0.03 * i + baseDriver(i - 2) * 0.85,
    }));

    const cmp = compareRegionalSeries(driver, response, {
      latA: 0,
      lngA: -140,
      datasetA: "ocean_temp",
      latB: -3.4,
      lngB: -62.2,
      datasetB: "deforestation",
    });

    expect(cmp.optimalLagSteps).toBe(2);
    expect(cmp.optimalLagR).toBeGreaterThan(0.8);
    expect(cmp.lagUnit).toBe("years");
    expect(cmp.lagProfile.length).toBeGreaterThanOrEqual(5);
  });

  it("classifies physical Earth mechanisms accurately by distance and sphere", () => {
    const localFeedback = classifyEarthMechanism(
      {
        latA: 34.1,
        lngA: -118.2,
        datasetA: "nasa_power",
        latB: 34.3,
        lngB: -118.0,
        datasetB: "hydrology",
      },
      {
        pearsonR: -0.72,
        detrendedR: -0.64,
        optimalLagSteps: 0,
        optimalLagR: -0.64,
        classification: "opposite_teleconnection",
      }
    );
    expect(localFeedback).toBe("Compound Hydro-Thermal Feedback");

    const polarMechanism = classifyEarthMechanism(
      {
        latA: 78.2,
        lngA: 15.6,
        datasetA: "nasa_power",
        latB: 67.5,
        lngB: -133.7,
        datasetB: "hydrology",
      },
      {
        pearsonR: 0.81,
        detrendedR: 0.55,
        optimalLagSteps: 1,
        optimalLagR: 0.62,
        classification: "co_trending",
      }
    );
    expect(polarMechanism).toBe("Polar Amplification Cascade");

    const ensoDipole = classifyEarthMechanism(
      {
        latA: 0,
        lngA: -140,
        datasetA: "ocean_temp",
        latB: -3.4,
        lngB: -62.2,
        datasetB: "deforestation",
      },
      {
        pearsonR: -0.68,
        detrendedR: -0.59,
        optimalLagSteps: 1,
        optimalLagR: -0.71,
        classification: "opposite_teleconnection",
      }
    );
    expect(ensoDipole).toBe("ENSO / Zonal Wave Dipole");
  });

  it("computes Benjamini-Hochberg FDR q-values, cross-granularity alignment, secular-drift flags, and Hamed-Rao verdict gating", () => {
    // 1. Benjamini-Hochberg FDR adjustment
    const qVals = benjaminiHochbergAdjust([0.001, 0.04, 0.5]);
    expect(qVals[0]).toBeCloseTo(0.003, 6);
    expect(qVals[1]).toBeCloseTo(0.06, 6);
    expect(qVals[2]).toBeCloseTo(0.5, 6);

    // 2. Cross-granularity calendar alignment ("2010-06-15" vs "2010") without positional fallback
    const dailyA = Array.from({ length: 15 }, (_, i) => ({
      date: `${2010 + i}-06-15`,
      t: 2010 + i,
      value: 10 + i * 0.5 + Math.sin(i * 0.9) * 0.4,
    }));
    const annualB = Array.from({ length: 15 }, (_, i) => ({
      date: `${2010 + i}`,
      t: 2010 + i,
      value: 20 + i * 0.8 + Math.sin(i * 0.9) * 0.4,
    }));
    const crossGranCmp = compareRegionalSeries(dailyA, annualB);
    expect(crossGranCmp.classification).toBe("co_trending");
    expect(crossGranCmp.alignedPoints).toHaveLength(15);

    // 3. Disjoint calendar epochs never fall back to positional alignment
    const oldEpoch = Array.from({ length: 15 }, (_, i) => ({
      date: `${1990 + i}`,
      t: 1990 + i,
      value: 10 + i,
    }));
    const newEpoch = Array.from({ length: 15 }, (_, i) => ({
      date: `${2010 + i}`,
      t: 2010 + i,
      value: 10 + i,
    }));
    const disjointCmp = compareRegionalSeries(oldEpoch, newEpoch);
    expect(disjointCmp.classification).toBe("decoupled");
    expect(disjointCmp.alignedPoints).toHaveLength(0);

    // 4. Flags pure secular co-drift when orthogonal cycles leave near-zero detrended correlation
    const driftOnlyA = Array.from({ length: 24 }, (_, i) => ({
      date: `${2001 + i}`,
      t: 2001 + i,
      value: 10 + 0.5 * i + Math.sin(i * 0.95) * 0.8,
    }));
    const driftOnlyB = Array.from({ length: 24 }, (_, i) => ({
      date: `${2001 + i}`,
      t: 2001 + i,
      value: 20 + 0.5 * i + Math.cos(i * 1.45) * 0.8,
    }));
    const secularCmp = compareRegionalSeries(driftOnlyA, driftOnlyB);
    expect(secularCmp.pearsonR).toBeGreaterThan(0.75);
    expect(secularCmp.isSecularDriftOnly).toBe(true);

    // 5. Hamed-Rao verdict gate suppresses raw MK false positive when serial autocorrelation reduces ESS
    const redNoiseVals = [
      10.0, 10.2, 10.5, 10.9, 11.4, 11.9, 12.4, 12.9, 13.3, 13.6,
      13.7, 13.6, 13.4, 13.1, 12.8, 12.6, 12.5, 12.6, 12.8, 13.1,
    ];
    const arSeries = redNoiseVals.map((value, i) => ({
      date: `${2005 + i}`,
      t: 2005 + i,
      value,
    }));
    const redSummary = analyzeTimeSeries(arSeries, {
      lat: 40.0,
      lng: -105.0,
      dataset: "nasa_power",
      parameter: "T2M",
      unit: "°C",
      slopeUnit: "°C/yr",
      provenance: "NASA POWER MERRA-2 (Live)",
    });
    expect(redSummary.mannKendall.significant).toBe(true);
    expect(redSummary.mannKendall.significantAdjusted).toBe(false);
    expect(redSummary.verdict).toBe("Normal Environmental Variability");
  });

  it("removes partial-year seasonal phase bias via Hirsch-Slack Seasonal Mann-Kendall", () => {
    // 78 monthly points = 6.5 years (Jan 2020 through Jun 2026) with zero secular drift
    const pureSeasonal = Array.from({ length: 78 }, (_, idx) => {
      const year = 2020 + Math.floor(idx / 12);
      const month = (idx % 12) + 1;
      return {
        date: `${year}-${String(month).padStart(2, "0")}`,
        t: year + (month - 1) / 12,
        value: 15 + 12 * Math.sin(((month - 4) * Math.PI) / 6),
      };
    });

    const seasonal = computeSeasonalMannKendall(pureSeasonal);
    expect(seasonal).not.toBeNull();
    expect(seasonal!.seasonsDetected).toBe(12);
    expect(seasonal!.significant).toBe(false);
    expect(Math.abs(seasonal!.seasonalTheilSenSlope)).toBeLessThan(0.01);
  });

  it("recovers subtle secular warming masked inside a large annual seasonal cycle", () => {
    // 96 monthly points = 8 years with +-12 seasonal swing + 0.08/yr true warming
    const warmingSeasonal = Array.from({ length: 96 }, (_, idx) => {
      const year = 2018 + Math.floor(idx / 12);
      const month = (idx % 12) + 1;
      const t = year + (month - 1) / 12;
      return {
        date: `${year}-${String(month).padStart(2, "0")}`,
        t,
        value: 14 + 12 * Math.sin(((month - 4) * Math.PI) / 6) + 0.08 * (t - 2018),
      };
    });

    const summary = analyzeTimeSeries(warmingSeasonal, {
      lat: 39.74,
      lng: -104.99,
      dataset: "nasa_power",
      parameter: "T2M",
      unit: "°C",
      slopeUnit: "°C/yr",
      provenance: "NASA POWER MERRA-2 (Live)",
    });

    expect(summary.seasonalAnalysis).not.toBeNull();
    expect(summary.seasonalAnalysis!.significant).toBe(true);
    expect(summary.seasonalAnalysis!.pValue).toBeLessThan(0.001);
    expect(summary.seasonalAnalysis!.seasonalTheilSenSlope).toBeCloseTo(0.08, 2);
    expect(summary.points[0].anomalyValue).toBeDefined();
  });
});
