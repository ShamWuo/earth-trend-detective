import { describe, expect, it } from "vitest";
import {
  ALL_RELATION_CATEGORIES,
  classifyRelationCategory,
  describeComparisonPlainly,
  describeGeographicZone,
  describeTrendPlainly,
  findNearbyFilteredNodes,
  formatCompactLag,
  formatCoordShort,
  formatRelationForDisplay,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
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

  it("renders VPD fire-weather headlines, meteorological proxy notes, and shared long-term drift warnings", () => {
    const vpdWildfire = makeSummary({
      dataset: "wildfire",
      parameter: "VPD (T2M_MAX + RH2M)",
      unit: "kPa",
      slopeUnit: "kPa/yr",
      measurementKind: "reanalysis_physical",
      theilSen: {
        slope: 0.032,
        intercept: -60,
        slopeLow95: 0.02,
        slopeHigh95: 0.044,
        pairCount: 300,
      },
      verdict: "Statistically Significant Increasing Trend",
    });
    const wfDigest = describeTrendPlainly(vpdWildfire);
    expect(wfDigest.headline).toBe("Drier air & higher fire risk");
    expect(wfDigest.isProxy).toBe(false);

    const proxyAir = makeSummary({
      dataset: "air_quality",
      measurementKind: "meteorological_proxy",
      proxyNote: "Surface ventilation wind proxy (WS10M) — not a direct PM2.5 sensor.",
      verdict: "Statistically Significant Decreasing Trend",
      theilSen: {
        slope: -0.025,
        intercept: 50,
        slopeLow95: -0.04,
        slopeHigh95: -0.01,
        pairCount: 300,
      },
    });
    const aqDigest = describeTrendPlainly(proxyAir);
    expect(aqDigest.isProxy).toBe(true);
    expect(aqDigest.proxyNote).toContain("WS10M");

    const driftCmp: CrossRegionComparison = {
      pearsonR: 0.86,
      spearmanRho: 0.84,
      pValue: 0.0001,
      detrendedR: 0.09,
      detrendedPValue: 0.71,
      optimalLagSteps: 0,
      optimalLagR: 0.11,
      optimalLagPValue: 0.65,
      lagUnit: "years",
      lagProfile: [],
      rollingCorrelations: [],
      slopeRatio: 1.0,
      sharedRegimeShiftYear: null,
      mechanism: "Independent Regional Signals",
      couplingRegime: "Compound Trend & Variability",
      classification: "co_trending",
      isSecularDriftOnly: true,
      alignedPoints: [],
    };
    const cmpDigest = describeComparisonPlainly(driftCmp, "Place A", "Place B");
    expect(cmpDigest.strengthLabel).toBe("Shared long-term drift");
    expect(cmpDigest.explanation).toContain("year-to-year swings move mostly independently");

    const baseMk = makeSummary().mannKendall;
    const usgsFlow = makeSummary({
      dataset: "hydrology",
      parameter: "River Discharge — SOUTH PLATTE RIVER (1.2 km)",
      unit: "m³/s",
      slopeUnit: "m³/s/yr",
      provenance: "USGS NWIS River Gauge (Live)",
      measurementKind: "direct_observation",
      mannKendall: { ...baseMk, direction: "decreasing", zScore: -3.1, s: -120 },
      verdict: "Statistically Significant Decreasing Trend",
      theilSen: { slope: -0.45, intercept: 900, slopeLow95: -0.7, slopeHigh95: -0.2, pairCount: 300 },
    });
    const flowDigest = describeTrendPlainly(usgsFlow);
    expect(flowDigest.headline).toBe("River flow declining");
    expect(flowDigest.isProxy).toBe(false);

    const camsPm = makeSummary({
      dataset: "air_quality",
      parameter: "Copernicus CAMS Surface PM2.5",
      unit: "μg/m³",
      slopeUnit: "μg/m³/yr",
      provenance: "Copernicus CAMS PM2.5 (Live)",
      measurementKind: "reanalysis_physical",
      verdict: "Statistically Significant Increasing Trend",
      theilSen: { slope: 0.4, intercept: -800, slopeLow95: 0.2, slopeHigh95: 0.6, pairCount: 150 },
    });
    expect(describeTrendPlainly(camsPm).headline).toBe("PM2.5 pollution rising");
    expect(describeTrendPlainly(camsPm).isProxy).toBe(false);

    const aodFeed = makeSummary({
      dataset: "air_quality",
      parameter: "AOD_55 (Aerosol Optical Depth 550nm)",
      unit: "AOD",
      provenance: "NASA POWER AOD_55 (Live)",
      measurementKind: "reanalysis_physical",
      verdict: "Statistically Significant Increasing Trend",
    });
    expect(describeTrendPlainly(aodFeed).headline).toBe("More aerosol haze (AOD)");

    const evapFeed = makeSummary({
      dataset: "deforestation",
      parameter: "EVPTRNS (Canopy Evapotranspiration Flux)",
      unit: "MJ/m²/d",
      provenance: "NASA POWER Evapotranspiration (Live)",
      measurementKind: "reanalysis_physical",
      verdict: "Statistically Significant Increasing Trend",
    });
    expect(describeTrendPlainly(evapFeed).headline).toBe("Higher canopy water flux");
    expect(describeTrendPlainly(evapFeed).isProxy).toBe(false);
  });

  it("populates structured formatting fields and scales °C vs °F deltas without +32 offset", () => {
    const celsiusDigest = describeTrendPlainly(makeSummary(), "C");
    expect(celsiusDigest.parameterShort).toBe("T2M Air");
    expect(celsiusDigest.latestFormatted).toBe("15.40 °C");
    expect(celsiusDigest.meanFormatted).toBe("14.60 °C");
    expect(celsiusDigest.anomalyFormatted).toBe("+0.80 °C");
    expect(celsiusDigest.anomalyZFormatted).toBe("+1.8σ");
    expect(celsiusDigest.rangeFormatted).toBe("13.80–15.60 °C");
    expect(celsiusDigest.windowYears).toBe(25);
    expect(celsiusDigest.periodRange).toBe("2000–2024");
    expect(celsiusDigest.ratePerDecade).toBe("+0.48 °C / decade");

    const fahrenheitDigest = describeTrendPlainly(makeSummary(), "F");
    expect(fahrenheitDigest.latestFormatted).toBe("59.72 °F");
    expect(fahrenheitDigest.meanFormatted).toBe("58.28 °F");
    expect(fahrenheitDigest.anomalyFormatted).toBe("+1.44 °F");
    expect(fahrenheitDigest.ratePerDecade).toBe("+0.86 °F / decade");
    expect(fahrenheitDigest.rangeFormatted).toContain("°F");

    const rainDigest = describeTrendPlainly(
      makeSummary({
        dataset: "hydrology",
        parameter: "PRECTOTCORR (Precipitation)",
        unit: "mm/d",
        slopeUnit: "mm/d/yr",
        latestValue: 3.5,
        mean: 3.0,
        min: 2.1,
        max: 4.2,
      }),
      "F"
    );
    expect(rainDigest.latestFormatted).toBe("3.50 mm/d");
    expect(rainDigest.anomalyFormatted).toBe("+0.50 mm/d");
  });

  it("classifies all 16 ETGRelationshipTypes and formats directional vs symmetric relations", () => {
    const allTypes: ETGRelationshipType[] = [
      "drives_opposite",
      "leads",
      "advects_to",
      "amplifies",
      "dampens",
      "triggers",
      "impacts",
      "correlates_with",
      "teleconnects",
      "relates_to",
      "hypothesized_link",
      "corroborates",
      "supports",
      "verified_by",
      "monitors",
      "supersedes",
    ];
    for (const relType of allTypes) {
      expect(ALL_RELATION_CATEGORIES).toContain(classifyRelationCategory(relType));
    }
    expect(classifyRelationCategory("drives_opposite")).toBe("opposite");
    expect(classifyRelationCategory("leads")).toBe("causal");
    expect(classifyRelationCategory("teleconnects")).toBe("coupled");
    expect(classifyRelationCategory("corroborates")).toBe("corroboration");

    const anchorNode: ETGNode = {
      uuid: "node-a",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "North Pacific Buoy",
        description: "SST anchor",
        region: "North Pacific",
        lat: 38.5,
        lng: -145.0,
        importance: 8,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    };
    const peerNode: ETGNode = {
      uuid: "node-b",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "Central Plains Station",
        description: "Land station",
        region: "Central Plains",
        lat: 38.5,
        lng: -101.2,
        importance: 7,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    };

    const outgoingLeads: ETGEdge = {
      source_uuid: anchorNode.uuid,
      target_uuid: peerNode.uuid,
      type: "leads",
      properties: {
        uuid: "edge-leads",
        is_provisional: false,
        source_snippet: "Test SST lead relation",
        detrended_r: 0.72,
        optimal_lag_steps: 2,
        lag_unit: "months",
        predictive_lift_pct: 18,
      },
    };
    const outFormatted = formatRelationForDisplay(outgoingLeads, anchorNode, peerNode);
    expect(outFormatted.category).toBe("causal");
    expect(outFormatted.direction).toBe("outgoing");
    expect(outFormatted.badgeText).toBe("Leads");
    expect(outFormatted.correlationText).toBe("r* +0.72");
    expect(outFormatted.lagText).toBe("lag 2 months");
    expect(outFormatted.liftText).toBe("+18% skill");
    expect(outFormatted.distanceKm).toBeGreaterThan(3000);

    const inFormatted = formatRelationForDisplay(outgoingLeads, peerNode, anchorNode);
    expect(inFormatted.direction).toBe("incoming");
    expect(inFormatted.badgeText).toBe("Lags behind");

    const oppositeFormatted = formatRelationForDisplay(
      {
        ...outgoingLeads,
        type: "drives_opposite",
        properties: {
          uuid: "edge-opp",
          is_provisional: false,
          source_snippet: "Test opposite relation",
          correlation_r: -0.81,
        },
      },
      anchorNode,
      peerNode
    );
    expect(oppositeFormatted.category).toBe("opposite");
    expect(oppositeFormatted.direction).toBe("undirected");
    expect(oppositeFormatted.correlationText).toBe("r -0.81");

    const corrobFormatted = formatRelationForDisplay(
      {
        ...outgoingLeads,
        type: "corroborates",
        properties: {
          uuid: "edge-corrob",
          is_provisional: false,
          source_snippet: "Test corroboration relation",
        },
      },
      anchorNode,
      peerNode
    );
    expect(corrobFormatted.category).toBe("corroboration");
    expect(corrobFormatted.badgeText).toBe("Corroborates");
  });

  it("labels NASA POWER solar irradiance and wind speed distinctly instead of Temperature", () => {
    const solar = describeTrendPlainly(
      makeSummary({
        dataset: "nasa_power",
        parameter: "ALLSKY_SFC_SW_DWN",
        unit: "kWh/m²/d",
        slopeUnit: "kWh/m²/d/yr",
        latestValue: 2.9,
        mean: 4.88,
        mannKendall: {
          ...makeSummary().mannKendall,
          pValue: 0.42,
          significant: false,
          direction: "no_trend",
        },
        theilSen: { ...makeSummary().theilSen, slope: -0.05 },
        verdict: "Normal Environmental Variability",
      })
    );
    expect(solar.topicLabel).toBe("Solar Irradiance");
    expect(solar.parameterShort).toBe("Solar SW");
    expect(solar.headline).toBe("Steady solar irradiance");
    expect(solar.latestFormatted).toContain("kWh/m²/d");
  });

  it("converts qualified °C skin and °C anom units into °F cleanly and formats lag without slicing", () => {
    const sstDigest = describeTrendPlainly(
      makeSummary({
        dataset: "ocean_temp",
        parameter: "TS (Skin Temp)",
        unit: "°C skin",
        slopeUnit: "°C/yr",
        latestValue: 20,
        mean: 19,
        min: 18,
        max: 21,
        theilSen: {
          slope: 0.05,
          intercept: -80,
          slopeLow95: 0.03,
          slopeHigh95: 0.07,
          pairCount: 300,
        },
      }),
      "F"
    );
    expect(sstDigest.latestFormatted).toBe("68.00 °F skin");
    expect(sstDigest.meanFormatted).toBe("66.20 °F skin");
    expect(sstDigest.anomalyFormatted).toBe("+1.80 °F");
    expect(sstDigest.ratePerDecade).toBe("+0.90 °F / decade");

    const anomDigest = describeTrendPlainly(
      makeSummary({
        dataset: "nasa_power",
        parameter: "GISTEMP 64N-90N",
        unit: "°C anom",
        slopeUnit: "°C/yr",
        latestValue: 1.5,
        mean: 1.0,
        min: 0.2,
        max: 1.8,
        theilSen: {
          slope: 0.06,
          intercept: -119,
          slopeLow95: 0.04,
          slopeHigh95: 0.08,
          pairCount: 300,
        },
      }),
      "F"
    );
    expect(anomDigest.latestFormatted).toBe("2.70 °F anom");
    expect(anomDigest.meanFormatted).toBe("1.80 °F anom");
    expect(anomDigest.ratePerDecade).toBe("+1.08 °F / decade");

    expect(formatCompactLag(0, "days")).toBe("0 lag");
    expect(formatCompactLag(2, "years")).toBe("2 yrs");
    expect(formatCompactLag(1, "years")).toBe("1 yr");
    expect(formatCompactLag(-5, "days")).toBe("-5 d");
    expect(formatCompactLag(3, "months")).toBe("3 mos");
  });
});
