import React from "react";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GET as getTimeSeries } from "@/app/api/earth/timeseries/route";
import { SpotLongTermTrendsSection } from "@/components/spot/SpotLongTermTrendsSection";
import { SpotTrendChart } from "@/components/spot/SpotTrendChart";
import { ComparisonPinnedDateBanner } from "@/components/spot/TrendDateControlsBar";
import { TrendGraphDetailModal } from "@/components/spot/TrendGraphDetailModal";
import {
  buildTrendOverlayItems,
  computeNiceTicks,
  formatDetailSeriesCsv,
  pickXAxisTickIndices,
  pointerClientXToIndex,
  prepareComparisonDetailSeries,
  prepareSingleDetailSeries,
} from "@/components/spot/trendChartDetailUtils";
import {
  buildWindowedComparison,
  buildWindowedTrendSummary,
  computePinnedDateComparison,
  findSeriesExtremes,
  formatTrendDate,
  matchesSeasonFilter,
  parseTrendDateParts,
  resolvePresetDateRange,
} from "@/components/spot/trendDateUtils";
import { clearCurrentConditionsCache } from "@/lib/earth/currentConditionsClient";
import { clearNasaPowerSeriesCache } from "@/lib/nasa/nasaPowerClient";
import { describeTrendPlainly } from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  ETGDatasetId,
  ETGNode,
  TrendAnalysisSummary,
} from "@/types/etg";

function makeSummary(
  dataset: ETGDatasetId,
  parameter: string,
  opts?: {
    unit?: string;
    slopeUnit?: string;
    withMonthly?: boolean;
    changePointDate?: string;
    slope?: number;
  }
): TrendAnalysisSummary {
  const unit = opts?.unit ?? "°C";
  const slopeUnit = opts?.slopeUnit ?? "°C/yr";
  const slope = opts?.slope ?? 0.035;
  const years = [2000, 2005, 2010, 2013, 2015, 2020, 2025];
  const points = years.map((yr, idx) => {
    const val = 27.0 + idx * 0.2;
    return {
      date: `${yr}`,
      t: yr,
      value: val,
      movingAverage: 27.0 + Math.max(0, idx - 0.5) * 0.18,
      theilSenFit: 27.0 + (yr - 2000) * slope,
      zScore: -1 + idx * 0.35,
      anomalyValue: val - 27.47,
    };
  });

  const seasonalPoints = opts?.withMonthly
    ? Array.from({ length: 24 }, (_, idx) => {
        const year = 2022 + Math.floor(idx / 12);
        const month = (idx % 12) + 1;
        const t = year + (month - 0.5) / 12;
        const seasonalWave = Math.sin(((month - 1) / 12) * Math.PI * 2) * 1.4;
        return {
          date: `${year}-${String(month).padStart(2, "0")}`,
          t,
          value: 27.4 + (t - 2022) * slope + seasonalWave,
          anomalyValue: (t - 2022) * slope - 0.04,
        };
      })
    : undefined;

  return {
    lat: 19.9,
    lng: -81.9,
    dataset,
    parameter,
    unit,
    slopeUnit,
    provenance: "NASA POWER MERRA-2 (Live)",
    mean: 27.47,
    stdDev: 0.42,
    min: 27.0,
    max: 28.2,
    latestValue: 28.2,
    latestAnomalyZ: 1.74,
    mannKendall: {
      n: points.length,
      s: 19,
      varS: 44,
      zScore: 2.71,
      pValue: 0.0067,
      tau: 0.9,
      significant: true,
      alpha: 0.05,
      direction: "increasing",
      lag1Autocorrelation: 0.18,
      effectiveSampleSize: 6.4,
      zScoreAdjusted: 2.52,
      pValueAdjusted: 0.0117,
      significantAdjusted: true,
    },
    theilSen: {
      slope,
      intercept: 27.0 - 2000 * slope,
      slopeLow95: slope - 0.012,
      slopeHigh95: slope + 0.014,
      pairCount: 21,
    },
    ols: {
      slope,
      intercept: 27.0 - 2000 * slope,
      rSquared: 0.88,
      tStat: 6.1,
      pValue: 0.0017,
    },
    changePoint: opts?.changePointDate
      ? {
          index: 3,
          date: opts.changePointDate,
          kStat: 12,
          pValue: 0.02,
          significant: true,
        }
      : null,
    seasonalAnalysis: opts?.withMonthly
      ? {
          seasonsDetected: 12,
          totalPairs: 12,
          s: 10,
          varS: 18,
          zScore: 2.35,
          pValue: 0.00004,
          significant: true,
          direction: "increasing",
          seasonalTheilSenSlope: 0.032,
          deseasonalizedValues: seasonalPoints!.map((p) => p.anomalyValue),
        }
      : null,
    seasonalPoints,
    verdict: "Statistically Significant Increasing Trend",
    points,
  };
}

function makeComparison(
  primary: TrendAnalysisSummary,
  secondary: TrendAnalysisSummary
): CrossRegionComparison {
  return {
    pearsonR: -0.78,
    spearmanRho: -0.74,
    pValue: 0.0031,
    detrendedR: -0.64,
    detrendedPValue: 0.018,
    optimalLagSteps: 1,
    optimalLagR: -0.81,
    optimalLagPValue: 0.002,
    lagUnit: "years",
    lagProfile: [{ lagSteps: 0, r: -0.78, pValue: 0.0031, n: 7 }],
    rollingCorrelations: [{ date: "2020", r: -0.76, detrendedR: -0.62 }],
    slopeRatio: -0.85,
    sharedRegimeShiftYear: 2013,
    mechanism: "ENSO teleconnection dipole",
    couplingRegime: "Compound Trend & Variability",
    classification: "opposite_teleconnection",
    alignedPoints: primary.points.map((pt, i) => ({
      date: pt.date,
      zA: -1.1 + i * 0.35,
      zB: 1.1 - i * 0.35,
      detrendedZA: (i % 2 === 0 ? 0.3 : -0.3),
      detrendedZB: (i % 2 === 0 ? -0.3 : 0.3),
      rawA: pt.value,
      rawB: secondary.points[i]?.value ?? pt.value - 2,
    })),
  };
}

function countMaxButtonNesting(html: string): number {
  const tokenRegex = /<\/?button\b/gi;
  let depth = 0;
  let maxDepth = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(html)) !== null) {
    if (match[0].startsWith("</")) {
      depth = Math.max(0, depth - 1);
    } else {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    }
  }
  return maxDepth;
}

describe("trendChartDetailUtils", () => {
  it("builds overlay items for multi-dataset single spots and two-spot comparisons", () => {
    const temp = makeSummary("nasa_power", "T2M", { withMonthly: true });
    const ocean = makeSummary("ocean_temp", "TS", { unit: "°C skin" });

    const singleItems = buildTrendOverlayItems({
      summaries: [temp, ocean, temp],
      primary: temp,
      labelA: "Tropical Belt",
      labelB: "Spot B",
    });
    expect(singleItems.map((i) => i.id)).toEqual(["nasa_power:T2M", "ocean_temp:TS"]);

    const comp = makeComparison(temp, ocean);
    const compItems = buildTrendOverlayItems({
      summaries: [temp, ocean],
      primary: temp,
      secondary: ocean,
      comparison: comp,
      labelA: "Tropical Belt",
      labelB: "North Atlantic",
    });
    expect(compItems.map((i) => i.id)).toEqual([
      "compare:both",
      "compare:a",
      "compare:b",
      "ocean_temp:TS",
    ]);
  });

  it("converts temperatures, CI bounds, and switches monthly/annual resolutions accurately", () => {
    const temp = makeSummary("nasa_power", "T2M", {
      withMonthly: true,
      changePointDate: "2013",
      slope: 0.04,
    });

    const annualF = prepareSingleDetailSeries(temp, "raw", "annual", "F");
    expect(annualF.hasDistinctMonthly).toBe(true);
    expect(annualF.effectiveResolution).toBe("annual");
    expect(annualF.displayUnit).toBe("°F");
    expect(annualF.displaySlopeUnit).toBe("°F/yr");
    expect(annualF.points).toHaveLength(7);
    expect(annualF.points[0].value).toBeCloseTo(27.0 * 1.8 + 32, 4);
    expect(annualF.changePointIndex).toBe(3);
    for (const pt of annualF.points) {
      expect(Number.isFinite(pt.smooth)).toBe(true);
      expect(pt.ciLow95).toBeLessThanOrEqual(pt.trendFit + 1e-6);
      expect(pt.ciHigh95).toBeGreaterThanOrEqual(pt.trendFit - 1e-6);
    }

    const monthlyAnomF = prepareSingleDetailSeries(temp, "anomaly", "monthly", "F");
    expect(monthlyAnomF.effectiveResolution).toBe("monthly");
    expect(monthlyAnomF.points).toHaveLength(24);
    expect(monthlyAnomF.referenceY).toBe(0);
    expect(monthlyAnomF.points[0].value).toBeCloseTo(
      temp.seasonalPoints![0].anomalyValue * 1.8,
      4
    );
  });

  it("prepares comparison modes and computes nice ticks, X labels, pointer scrub index, and CSV", () => {
    const temp = makeSummary("nasa_power", "T2M", { withMonthly: true });
    const ocean = makeSummary("ocean_temp", "TS", { withMonthly: true, unit: "°C skin" });
    const comp = makeComparison(temp, ocean);

    const deseasonalized = prepareComparisonDetailSeries({
      primary: temp,
      secondary: ocean,
      comparison: comp,
      mode: "anomaly",
      tempUnit: "C",
    });
    expect(deseasonalized.effectiveMode).toBe("anomaly");
    expect(deseasonalized.points).toHaveLength(24);

    const ticks = computeNiceTicks(26.8, 28.4, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]).toBeLessThanOrEqual(26.8);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(28.4);

    expect(pickXAxisTickIndices(24, 6)).toEqual([0, 5, 9, 14, 18, 23]);
    expect(pointerClientXToIndex(62, 0, 840, 840, 62, 754, 11)).toBe(0);
    expect(pointerClientXToIndex(816, 0, 840, 840, 62, 754, 11)).toBe(10);

    const prepared = prepareSingleDetailSeries(temp, "raw", "annual", "C");
    const csv = formatDetailSeriesCsv(
      'Tropical Belt, "Caribbean"',
      prepared.points.slice(0, 2),
      prepared.displayUnit
    );
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("value (°C)");
    expect(lines[1]).toContain('"Tropical Belt, ""Caribbean"""');
  });
});

describe("Trend graph detail triggers and modal rendering", () => {
  it("renders SpotLongTermTrendsSection with zero nested buttons in cards and table layouts", () => {
    const temp = makeSummary("nasa_power", "T2M", { withMonthly: true });
    const ocean = makeSummary("ocean_temp", "TS", { unit: "°C skin" });
    const digest = describeTrendPlainly(temp, "C");

    const cardsHtml = renderToStaticMarkup(
      <SpotLongTermTrendsSection
        trendLayout="cards"
        onChangeTrendLayout={vi.fn()}
        activeTopics={[]}
        onResetTopics={vi.fn()}
        onlyCommunityFilterAtEmptySpot={false}
        visibleSummaries={[temp, ocean]}
        activeSummary={temp}
        activeDigest={digest}
        onFocusSummary={vi.fn()}
        onOpenTrendDetail={vi.fn()}
        tempUnit="C"
        hasStoredNodeMetrics={false}
        selectedNode={null}
        relevantDatasetDiags={[]}
        loading={false}
        microscopeScan={null}
      />
    );
    expect(countMaxButtonNesting(cardsHtml)).toBe(1);
    expect(cardsHtml).toContain("Open Temperature T2M Air trend graph in detail");
    expect(cardsHtml).toContain("Open Oceans &amp; Ice Skin Temp trend graph in detail");
    expect(cardsHtml).toContain("Open active trend graph in detail overlay");

    const tableHtml = renderToStaticMarkup(
      <SpotLongTermTrendsSection
        trendLayout="table"
        onChangeTrendLayout={vi.fn()}
        activeTopics={[]}
        onResetTopics={vi.fn()}
        onlyCommunityFilterAtEmptySpot={false}
        visibleSummaries={[temp, ocean]}
        activeSummary={temp}
        activeDigest={digest}
        onFocusSummary={vi.fn()}
        onOpenTrendDetail={vi.fn()}
        tempUnit="C"
        hasStoredNodeMetrics={false}
        selectedNode={null}
        relevantDatasetDiags={[]}
        loading={false}
        microscopeScan={null}
      />
    );
    expect(countMaxButtonNesting(tableHtml)).toBe(1);
    expect(tableHtml).toContain("Open Temperature T2M Air trend graph in detail");
    expect(tableHtml).toContain("Open Oceans &amp; Ice Skin Temp trend graph in detail");
  });

  it("renders SpotTrendChart detail trigger in single-spot and comparison views", () => {
    const temp = makeSummary("nasa_power", "T2M", { withMonthly: true });
    const ocean = makeSummary("ocean_temp", "TS", { unit: "°C skin" });
    const comp = makeComparison(temp, ocean);

    const singleHtml = renderToStaticMarkup(
      <SpotTrendChart
        summary={temp}
        comparison={null}
        labelA="Tropical Belt"
        labelB="Spot B"
        tempUnit="C"
        onOpenDetail={vi.fn()}
      />
    );
    expect(singleHtml).toContain("Open trend graph in detail overlay");

    const compHtml = renderToStaticMarkup(
      <SpotTrendChart
        summary={temp}
        secondarySummary={ocean}
        comparison={comp}
        labelA="Tropical Belt"
        labelB="North Atlantic"
        tempUnit="C"
        onOpenDetail={vi.fn()}
      />
    );
    expect(compHtml).toContain("Open trend graph in detail overlay");
  });

  it("renders TrendGraphDetailModal with tablist, prev/next navigation, SVG, and full statistics", () => {
    const temp = makeSummary("nasa_power", "T2M", {
      withMonthly: true,
      changePointDate: "2013",
    });
    const ocean = makeSummary("ocean_temp", "TS", { unit: "°C skin" });

    const html = renderToStaticMarkup(
      <TrendGraphDetailModal
        open={true}
        onClose={vi.fn()}
        cardTitle="Tropical Belt"
        coord={{ lat: 19.9, lng: -81.9 }}
        summaries={[temp, ocean]}
        allSpotSummaries={[temp, ocean]}
        primary={temp}
        labelA="Tropical Belt"
        labelB="Spot B"
        initialItemId="nasa_power:T2M"
        tempUnit="C"
      />
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain("Tropical Belt — Trend Graph Inspector");
    expect(html).toContain("1 / 2");
    expect(html).toContain("Previous trend graph");
    expect(html).toContain("Next trend graph");
    expect(html).toContain("Temperature");
    expect(html).toContain("Oceans &amp; Ice");
    expect(html).toContain("Monthly (24)");
    expect(html).toContain("Annual (7)");
    expect(html).toContain("Mann-Kendall Trend Test");
    expect(html).toContain("Hamed-Rao Serial Adjustment");
    expect(html).toContain("Theil-Sen Robust Slope");
    expect(html).toContain("Seasonal MK (Hirsch-Slack)");
    expect(html).toContain("Download CSV");
    expect(html).toContain('aria-label="Start date"');
    expect(html).toContain('aria-label="End date"');
    expect(html).toContain("Pre-Shift");
    expect(html).toContain("Post-Shift");
    expect(html).toContain('aria-label="Filter by season or calendar month"');
    expect(html).toContain("Human");
    expect(html).toContain("ISO");
    expect(html).toContain("Decimal");
    expect(html).toContain("Dense Dates");
    expect(html).toContain("Peak / Low");
    expect(html).toContain("Pin Date");
    expect(html).toContain("Range Navigator:");
    expect(html).toContain('aria-label="Custom window start index"');
    expect(html).toContain('aria-label="Custom window end index"');
    expect(html).toContain('aria-label="Search observation dates"');
    expect(html).toContain("1981–2025 (45y Full MERRA-2)");
    expect(countMaxButtonNesting(html)).toBe(1);
  });
});

describe("trendDateUtils and extended archive API", () => {
  it("parses and formats annual, monthly, and daily dates across Human, ISO, and Decimal modes", () => {
    expect(parseTrendDateParts("2013")).toEqual({
      year: 2013,
      month: null,
      day: null,
      sortKey: 20130615,
    });
    expect(parseTrendDateParts("2013-07")).toEqual({
      year: 2013,
      month: 7,
      day: null,
      sortKey: 20130715,
    });
    expect(parseTrendDateParts("2024-07-15T12:00:00Z")).toEqual({
      year: 2024,
      month: 7,
      day: 15,
      sortKey: 20240715,
    });

    expect(formatTrendDate("2013", "human")).toBe("2013");
    expect(formatTrendDate("2013-07", "human")).toBe("Jul 2013");
    expect(formatTrendDate("2024-07-15", "human")).toBe("15 Jul 2024");
    expect(formatTrendDate("2024-07-15T12:00:00Z", "iso")).toBe("2024-07-15");
    expect(formatTrendDate("2013-07", "decimal", 2013.541)).toBe("2013.54");
    expect(formatTrendDate("2013", "decimal", 2013)).toBe("2013");
  });

  it("matches seasons and calendar months accurately", () => {
    expect(matchesSeasonFilter("2020-01", "all")).toBe(true);
    expect(matchesSeasonFilter("2020-12", "DJF")).toBe(true);
    expect(matchesSeasonFilter("2020-02", "DJF")).toBe(true);
    expect(matchesSeasonFilter("2020-07", "DJF")).toBe(false);
    expect(matchesSeasonFilter("2020-07", "JJA")).toBe(true);
    expect(matchesSeasonFilter("2020-08", "m8")).toBe(true);
    expect(matchesSeasonFilter("2020-09", "m8")).toBe(false);
    expect(matchesSeasonFilter("2020", "m8")).toBe(false);
  });

  it("resolves all, trailing-year, and pre/post-shift date presets", () => {
    const pts = Array.from({ length: 16 }, (_, i) => ({
      date: `${2010 + i}`,
      t: 2010 + i,
    }));
    expect(resolvePresetDateRange(pts, "all")).toEqual({
      startDate: "2010",
      endDate: "2025",
    });
    expect(resolvePresetDateRange(pts, "5y")).toEqual({
      startDate: "2021",
      endDate: "2025",
    });
    expect(resolvePresetDateRange(pts, "10y")).toEqual({
      startDate: "2016",
      endDate: "2025",
    });
    expect(resolvePresetDateRange(pts, "pre_shift", "2018")).toEqual({
      startDate: "2010",
      endDate: "2017",
    });
    expect(resolvePresetDateRange(pts, "post_shift", "2018")).toEqual({
      startDate: "2018",
      endDate: "2025",
    });

    const monthlyPts = Array.from({ length: 48 }, (_, i) => {
      const yr = 2016 + Math.floor(i / 12);
      const mo = (i % 12) + 1;
      return {
        date: `${yr}-${String(mo).padStart(2, "0")}`,
        t: yr + (mo - 0.5) / 12,
      };
    });
    expect(resolvePresetDateRange(monthlyPts, "pre_shift", "2018")).toEqual({
      startDate: "2016-01",
      endDate: "2017-12",
    });
    expect(resolvePresetDateRange(monthlyPts, "post_shift", "2018")).toEqual({
      startDate: "2018-01",
      endDate: "2019-12",
    });
  });

  it("recomputes Mann-Kendall & Theil-Sen over custom date slices and single calendar months", () => {
    const base = makeSummary("nasa_power", "T2M", {
      withMonthly: true,
      changePointDate: "2013",
    });
    // Build a 10-year monthly record so single calendar month "m8" has 10 points
    const longMonthly = Array.from({ length: 120 }, (_, i) => {
      const year = 2015 + Math.floor(i / 12);
      const month = (i % 12) + 1;
      const t = year + (month - 0.5) / 12;
      const val = 26.0 + (year - 2015) * 0.08 + (month === 8 ? 2.5 : 0);
      return {
        date: `${year}-${String(month).padStart(2, "0")}`,
        t,
        value: val,
        anomalyValue: (year - 2015) * 0.08 - 0.3,
      };
    });
    const baseLong: TrendAnalysisSummary = {
      ...base,
      points: Array.from({ length: 11 }, (_, i) => ({
        date: `${2015 + i}`,
        t: 2015 + i,
        value: 26.2 + i * 0.08,
        movingAverage: 26.2 + i * 0.08,
        theilSenFit: 26.2 + i * 0.08,
        zScore: -1 + i * 0.2,
        anomalyValue: i * 0.08 - 0.4,
      })),
      seasonalPoints: longMonthly,
    };

    const sliced = buildWindowedTrendSummary({
      baseSummary: baseLong,
      startDate: "2018",
      endDate: "2024",
      seasonFilter: "all",
      resolution: "annual",
    });
    expect(sliced.isWindowed).toBe(true);
    expect(sliced.summary.points[0].date).toBe("2018");
    expect(sliced.summary.points[sliced.summary.points.length - 1].date).toBe("2024");
    expect(sliced.summary.mannKendall.n).toBe(7);

    const augSlice = buildWindowedTrendSummary({
      baseSummary: baseLong,
      startDate: null,
      endDate: null,
      seasonFilter: "m8",
      resolution: "monthly",
    });
    expect(augSlice.isWindowed).toBe(true);
    expect(augSlice.summary.points).toHaveLength(10);
    expect(augSlice.summary.points.every((p) => p.date.endsWith("-08"))).toBe(true);
    expect(augSlice.summary.theilSen.slope).toBeCloseTo(0.08, 3);

    // Graceful fallback when fewer than 3 points match
    const tiny = buildWindowedTrendSummary({
      baseSummary: baseLong,
      startDate: "2024",
      endDate: "2025",
      seasonFilter: "all",
      resolution: "annual",
    });
    expect(tiny.isWindowed).toBe(false);
    expect(tiny.tooFewPoints).toBe(true);
    expect(tiny.summary.points).toHaveLength(11);
  });

  it("computes series extremes and chronological pinned two-date comparison deltas", () => {
    const temp = makeSummary("nasa_power", "T2M");
    const prepared = prepareSingleDetailSeries(temp, "raw", "annual", "C");
    const extremes = findSeriesExtremes(prepared.points);
    expect(extremes).toEqual({ minIndex: 0, maxIndex: 6 });

    const cmp = computePinnedDateComparison(
      prepared.points[5],
      prepared.points[1]
    );
    expect(cmp.earlier.date).toBe("2005");
    expect(cmp.later.date).toBe("2020");
    expect(cmp.elapsedYears).toBe(15);
    expect(cmp.valueDelta).toBeCloseTo(0.8, 4);
    expect(cmp.decadeRateEquivalent).toBeCloseTo((0.8 / 15) * 10, 4);
  });

  it("GET /api/earth/timeseries respects start_year and end_year bounds", async () => {
    clearNasaPowerSeriesCache();
    clearCurrentConditionsCache();

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Simulated offline test"));

    try {
      const res = await getTimeSeries(
        new NextRequest(
          "http://localhost:3000/api/earth/timeseries?lat=39.99&lng=-105.26&dataset=nasa_power&fallback=1&start_year=1985&end_year=2015"
        )
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        primary: TrendAnalysisSummary | null;
      };
      expect(body.primary).not.toBeNull();
      const dates = body.primary!.points.map((p) => p.date);
      expect(dates[0]).toBe("1985");
      expect(dates[dates.length - 1]).toBe("2015");
      expect(dates).toHaveLength(31);
    } finally {
      spy.mockRestore();
      clearNasaPowerSeriesCache();
      clearCurrentConditionsCache();
    }
  });

  it("supports sub-3-year monthly deseasonalized windows in buildWindowedComparison", () => {
    const baseA = makeSummary("nasa_power", "T2M", { withMonthly: true });
    const baseB = {
      ...makeSummary("ocean_temp", "TS", { withMonthly: true, slope: -0.025 }),
      lat: 64.1,
      lng: -21.9,
    };
    const comp = makeComparison(baseA, baseB);

    const sub3y = buildWindowedComparison({
      primary: baseA,
      secondary: baseB,
      baseComparison: comp,
      startDate: "2022-03",
      endDate: "2023-08",
      mode: "anomaly",
    });
    expect(sub3y.isWindowed).toBe(true);
    expect(sub3y.tooFewPoints).toBeFalsy();
    expect(sub3y.comparison.alignedPoints).toHaveLength(18);

    const prepared = prepareComparisonDetailSeries({
      primary: sub3y.primary,
      secondary: sub3y.secondary,
      comparison: sub3y.comparison,
      mode: "anomaly",
      tempUnit: "C",
    });
    expect(prepared.effectiveMode).toBe("anomaly");
    expect(prepared.points).toHaveLength(18);
    expect(prepared.points[0].date).toBe("2022-03");
    expect(prepared.points[17].date).toBe("2023-08");
  });

  it("scales Fahrenheit anomaly slopes symmetrically when displaying °C in SpotTrendChart", () => {
    const base = makeSummary("nasa_power", "T2M", {
      withMonthly: true,
      unit: "°F",
      slopeUnit: "°F/yr",
      slope: 0.18,
    });
    const fahrenheitSeries: TrendAnalysisSummary = {
      ...base,
      seasonalAnalysis: {
        ...base.seasonalAnalysis!,
        seasonalTheilSenSlope: 0.18,
      },
    };

    const htmlC = renderToStaticMarkup(
      <SpotTrendChart
        summary={fahrenheitSeries}
        comparison={null}
        labelA="Denver"
        labelB="Spot B"
        tempUnit="C"
      />
    );
    expect(htmlC).toContain("+0.100 °C/yr");
  });

  it("uses Spot B coordinates on compare:b and omits Peak/Low toggle on compare:both", () => {
    const spotA = makeSummary("nasa_power", "T2M", { withMonthly: true });
    const spotB: TrendAnalysisSummary = {
      ...makeSummary("nasa_power", "T2M", { withMonthly: true, slope: -0.02 }),
      lat: 64.1,
      lng: -21.9,
    };
    const comp = makeComparison(spotA, spotB);
    const nodeA: ETGNode = {
      uuid: "node-a-1",
      label: "Signal",
      properties: {
        name: "Tropical Belt",
        description: "Tropical Belt node",
        created_at: "2025-01-01T00:00:00Z",
        lat: 19.9,
        lng: -81.9,
      },
    };

    const htmlB = renderToStaticMarkup(
      <TrendGraphDetailModal
        open={true}
        onClose={vi.fn()}
        cardTitle="Tropical Belt vs Reykjavik"
        coord={{ lat: 19.9, lng: -81.9 }}
        summaries={[spotA]}
        allSpotSummaries={[spotA]}
        primary={spotA}
        secondary={spotB}
        comparison={comp}
        labelA="Tropical Belt"
        labelB="Reykjavik"
        initialItemId="compare:b"
        tempUnit="C"
        selectedNode={nodeA}
        onSaveToGraph={vi.fn(async () => {})}
        onOpenInGraphWorkbench={vi.fn()}
      />
    );
    expect(htmlB).toContain("64.1°N, 21.9°W");
    expect(htmlB).toContain("bbox=-23.40,62.60,-20.40,65.60");
    expect(htmlB).toContain("Save to Graph");
    expect(htmlB).not.toContain("Open in Graph Workbench");
    expect(countMaxButtonNesting(htmlB)).toBe(1);

    const htmlBoth = renderToStaticMarkup(
      <TrendGraphDetailModal
        open={true}
        onClose={vi.fn()}
        cardTitle="Tropical Belt vs Reykjavik"
        coord={{ lat: 19.9, lng: -81.9 }}
        summaries={[spotA]}
        allSpotSummaries={[spotA]}
        primary={spotA}
        secondary={spotB}
        comparison={comp}
        labelA="Tropical Belt"
        labelB="Reykjavik"
        initialItemId="compare:both"
        tempUnit="C"
      />
    );
    expect(htmlBoth).not.toContain("Peak / Low");
    expect(htmlBoth).toContain("Pin Date");
    expect(htmlBoth).toContain("19.9°N, 81.9°W vs 64.1°N, 21.9°W");
    expect(countMaxButtonNesting(htmlBoth)).toBe(1);

    const banner1Html = renderToStaticMarkup(
      <ComparisonPinnedDateBanner
        pinnedPoints={[
          { date: "2005", t: 2005, zA: -0.75, zB: 0.75, rawA: 27.2, rawB: 5.4 },
        ]}
        labelA="Tropical Belt"
        labelB="Reykjavik"
        unitA="°C"
        unitB="°C"
        dateFormat="human"
        onRemovePin={vi.fn()}
        onClearPins={vi.fn()}
      />
    );
    expect(banner1Html).toContain("Pin A: 2005");
    expect(banner1Html).toContain("27.20 °C");
    expect(countMaxButtonNesting(banner1Html)).toBe(1);

    const banner2Html = renderToStaticMarkup(
      <ComparisonPinnedDateBanner
        pinnedPoints={[
          { date: "2020", t: 2020, zA: 0.65, zB: -0.65, rawA: 28.0, rawB: 4.1 },
          { date: "2005", t: 2005, zA: -0.75, zB: 0.75, rawA: 27.2, rawB: 5.4 },
        ]}
        labelA="Tropical Belt"
        labelB="Reykjavik"
        unitA="°C"
        unitB="°C"
        dateFormat="human"
        onRemovePin={vi.fn()}
        onClearPins={vi.fn()}
      />
    );
    expect(banner2Html).toContain("2005 → 2020");
    expect(banner2Html).toContain("(15.0 yrs)");
    expect(banner2Html).toContain("Δz +1.40σ");
    expect(banner2Html).toContain("Δ +0.80 °C");
    expect(countMaxButtonNesting(banner2Html)).toBe(1);
  });
});
