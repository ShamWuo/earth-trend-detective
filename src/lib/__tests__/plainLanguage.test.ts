import { describe, expect, it } from "vitest";
import {
  describeComparisonPlainly,
  describeGeographicZone,
  describeTrendPlainly,
  findNearbyFilteredNodes,
  formatCoordShort,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  ETGNode,
  TrendAnalysisSummary,
} from "@/types/etg";

function makeSummary(
  overrides: Partial<TrendAnalysisSummary> = {}
): TrendAnalysisSummary {
  const basePoints = Array.from({ length: 25 }, (_, i) => ({
    date: String(2000 + i),
    t: 2000 + i,
    value: 14 + i * 0.05,
    movingAverage: 14 + i * 0.05,
    theilSenFit: 14 + i * 0.05,
    zScore: (i - 12) * 0.1,
  }));

  return {
    lat: 37.5,
    lng: -122.1,
    dataset: "nasa_power",
    parameter: "T2M (Temperature)",
    unit: "°C",
    slopeUnit: "°C/yr",
    provenance: "NASA POWER MERRA-2 (Live)",
    mean: 14.6,
    stdDev: 0.45,
    min: 13.8,
    max: 15.6,
    latestValue: 15.4,
    latestAnomalyZ: 1.78,
    mannKendall: {
      n: 25,
      s: 190,
      varS: 1800,
      zScore: 4.45,
      pValue: 0.002,
      tau: 0.63,
      significant: true,
      alpha: 0.05,
      direction: "increasing",
      lag1Autocorrelation: 0.12,
      effectiveSampleSize: 22,
      zScoreAdjusted: 4.1,
      pValueAdjusted: 0.004,
      significantAdjusted: true,
    },
    theilSen: {
      slope: 0.048,
      intercept: -82.0,
      slopeLow95: 0.03,
      slopeHigh95: 0.065,
      pairCount: 300,
    },
    ols: {
      slope: 0.049,
      intercept: -84.0,
      rSquared: 0.72,
      tStat: 7.5,
      pValue: 0.0001,
    },
    changePoint: {
      index: 14,
      date: "2014",
      kStat: 128,
      pValue: 0.015,
      significant: true,
    },
    verdict: "Statistically Significant Increasing Trend",
    points: basePoints,
    ...overrides,
  };
}

describe("plainLanguage translators", () => {
  it("converts warming Mann-Kendall & Theil-Sen summary into plain per-decade copy with zero jargon", () => {
    const digest = describeTrendPlainly(makeSummary());
    expect(digest.topicLabel).toBe("Temperature");
    expect(digest.headline).toBe("Warming steadily");
    expect(digest.ratePerDecade).toBe("+0.48 °C / decade");
    expect(digest.certaintyLabel).toBe("Clear trend");
    expect(digest.isSignificant).toBe(true);
    expect(digest.summarySentence).toContain("Shifted noticeably around 2014.");

    const combined = `${digest.headline} ${digest.ratePerDecade} ${digest.certaintyLabel} ${digest.summarySentence}`;
    expect(combined).not.toMatch(/Mann-Kendall|Theil-Sen|stationarity|p-value|null hypothesis/i);
  });

  it("translates drying hydrology and non-significant swings into intuitive copy", () => {
    const drying = describeTrendPlainly(
      makeSummary({
        dataset: "hydrology",
        parameter: "PRECTOTCORR",
        unit: "mm/day",
        slopeUnit: "mm/d/yr",
        mannKendall: {
          ...makeSummary().mannKendall,
          pValue: 0.032,
          significant: true,
          direction: "decreasing",
        },
        theilSen: {
          ...makeSummary().theilSen,
          slope: -0.043,
        },
        changePoint: null,
        verdict: "Statistically Significant Decreasing Trend",
      })
    );
    expect(drying.topicLabel).toBe("Water & Rain");
    expect(drying.headline).toBe("Getting drier");
    expect(drying.ratePerDecade).toBe("-0.43 mm/d / decade");
    expect(drying.certaintyLabel).toBe("Likely trend");

    const steady = describeTrendPlainly(
      makeSummary({
        mannKendall: {
          ...makeSummary().mannKendall,
          pValue: 0.42,
          significant: false,
          direction: "no_trend",
        },
        theilSen: { ...makeSummary().theilSen, slope: 0.005 },
        verdict: "Normal Environmental Variability",
      })
    );
    expect(steady.headline).toBe("Steady temperatures");
    expect(steady.certaintyLabel).toBe("Normal swings");
    expect(steady.summarySentence).toContain("normal range");
  });

  it("formats coordinates and geographic zones cleanly", () => {
    expect(formatCoordShort(-36.92, -71.44)).toBe("36.9°S, 71.4°W");
    const nearbyNode: ETGNode = {
      uuid: "n-1",
      label: "Signal",
      properties: {
        name: "Andes Basin",
        description: "Test",
        region: "Central Chile",
        lat: -36.8,
        lng: -71.5,
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    expect(describeGeographicZone(-37.0, -71.4, nearbyNode)).toBe("Near Central Chile");
    expect(describeGeographicZone(74.0, -60.0, null)).toBe("Arctic Region");
    expect(describeGeographicZone(8.0, 20.0, null)).toBe("Tropical Belt");
  });

  it("strips Mann-Kendall and Theil-Sen jargon in humanizeNodeText", () => {
    const raw =
      "NASA POWER MERRA-2 31-year T2M at (37.00°, -122.00°): Statistically Significant Increasing Trend, slope +0.05 °C/yr, Mann-Kendall p=0.0012. Provenance: NASA POWER.";
    const clean = humanizeNodeText(raw);
    expect(clean).not.toMatch(/Mann-Kendall|Statistically Significant/i);
    expect(clean).toContain("Rising trend");
    expect(clean).toContain("Source:");
  });

  it("describes opposite-trend comparisons and timing plainly", () => {
    const cmp: CrossRegionComparison = {
      pearsonR: -0.78,
      spearmanRho: -0.74,
      pValue: 0.001,
      detrendedR: -0.68,
      detrendedPValue: 0.003,
      optimalLagSteps: 1,
      optimalLagR: -0.81,
      optimalLagPValue: 0.0008,
      lagUnit: "years",
      lagProfile: [],
      rollingCorrelations: [],
      slopeRatio: -0.5,
      sharedRegimeShiftYear: 2016,
      mechanism: "Polar Jet Stream Waveguide Shift",
      couplingRegime: "Compound Trend & Variability",
      classification: "opposite_teleconnection",
      alignedPoints: [],
    };
    const digest = describeComparisonPlainly(cmp, "Arctic Ocean", "Central Chile");
    expect(digest.badgeLabel).toBe("Opposite trends");
    expect(digest.strengthLabel).toBe("Strong link");
    expect(digest.explanation).toContain("tend to fall in Central Chile");
    expect(digest.timingNote).toContain("about 1 year before Central Chile");
    expect(digest.timingNote).toContain("around 2016");
  });

  it("finds nearby filtered non-Rule nodes sorted closest first", () => {
    const nodes: ETGNode[] = [
      {
        uuid: "rule-1",
        label: "Rule",
        properties: { name: "Gate", description: "Gate", lat: 37, lng: -122, created_at: "2026-01-01" },
      },
      {
        uuid: "far",
        label: "Signal",
        properties: { name: "Far Spot", description: "d", lat: 10, lng: 10, created_at: "2026-01-01" },
      },
      {
        uuid: "mid",
        label: "Signal",
        properties: { name: "Mid Spot", description: "d", lat: 40, lng: -120, created_at: "2026-01-01" },
      },
      {
        uuid: "near",
        label: "Insight",
        properties: { name: "Near Spot", description: "d", lat: 37.8, lng: -122.4, created_at: "2026-01-01" },
      },
    ];
    const hits = findNearbyFilteredNodes(37.7, -122.3, nodes, 950, 3);
    expect(hits.map((h) => h.node.uuid)).toEqual(["near", "mid"]);
    expect(hits[0].distanceKm).toBeLessThan(hits[1].distanceKm);
  });
});
