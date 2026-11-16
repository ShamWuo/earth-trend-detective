import {
  analyzeTimeSeries,
  compareRegionalSeries,
  computeSeasonalMannKendall,
} from "@/lib/stats/trendEngine";
import type {
  CrossRegionComparison,
  TimeSeriesPoint,
  TrendAnalysisSummary,
} from "@/types/etg";
import type { SingleDetailPoint } from "@/components/spot/trendChartDetailUtils";

export type TrendDateFormat = "human" | "iso" | "decimal";

export type TrendSeasonFilter =
  | "all"
  | "DJF"
  | "MAM"
  | "JJA"
  | "SON"
  | "m1"
  | "m2"
  | "m3"
  | "m4"
  | "m5"
  | "m6"
  | "m7"
  | "m8"
  | "m9"
  | "m10"
  | "m11"
  | "m12";

export type TrendDatePreset =
  | "all"
  | "5y"
  | "10y"
  | "15y"
  | "20y"
  | "pre_shift"
  | "post_shift";

export const SEASON_FILTER_OPTIONS: ReadonlyArray<{
  value: TrendSeasonFilter;
  label: string;
}> = [
  { value: "all", label: "All Months" },
  { value: "DJF", label: "DJF (Winter)" },
  { value: "MAM", label: "MAM (Spring)" },
  { value: "JJA", label: "JJA (Summer)" },
  { value: "SON", label: "SON (Autumn)" },
  { value: "m1", label: "January" },
  { value: "m2", label: "February" },
  { value: "m3", label: "March" },
  { value: "m4", label: "April" },
  { value: "m5", label: "May" },
  { value: "m6", label: "June" },
  { value: "m7", label: "July" },
  { value: "m8", label: "August" },
  { value: "m9", label: "September" },
  { value: "m10", label: "October" },
  { value: "m11", label: "November" },
  { value: "m12", label: "December" },
];

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface ParsedTrendDateParts {
  year: number;
  month: number | null;
  day: number | null;
  sortKey: number;
}

/**
 * Parse YYYY, YYYY-MM, or YYYY-MM-DD(T...) strings into year/month/day components and sortKey.
 */
export function parseTrendDateParts(dateStr: string): ParsedTrendDateParts {
  const base = dateStr.trim().split(/[T\s]/)[0] ?? "";
  const ymd = base.match(/^(-?\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Math.max(1, Math.min(12, Number(ymd[2])));
    const day = Math.max(1, Math.min(31, Number(ymd[3])));
    return {
      year,
      month,
      day,
      sortKey: year * 10000 + month * 100 + day,
    };
  }
  const ym = base.match(/^(-?\d{4})-(\d{1,2})$/);
  if (ym) {
    const year = Number(ym[1]);
    const month = Math.max(1, Math.min(12, Number(ym[2])));
    return {
      year,
      month,
      day: null,
      sortKey: year * 10000 + month * 100 + 15,
    };
  }
  const y = base.match(/^(-?\d{4})$/);
  if (y) {
    const year = Number(y[1]);
    return {
      year,
      month: null,
      day: null,
      sortKey: year * 10000 + 615,
    };
  }
  const anyYear = base.match(/(-?\d{4})/);
  const year = anyYear ? Number(anyYear[1]) : 0;
  return {
    year,
    month: null,
    day: null,
    sortKey: year * 10000 + 615,
  };
}

export function startBoundaryKey(dateStr: string): number {
  const parts = parseTrendDateParts(dateStr);
  return parts.year * 10000 + (parts.month ?? 1) * 100 + (parts.day ?? 1);
}

export function endBoundaryKey(dateStr: string): number {
  const parts = parseTrendDateParts(dateStr);
  return parts.year * 10000 + (parts.month ?? 12) * 100 + (parts.day ?? 31);
}

/**
 * Format an observation date string in Human, ISO, or Decimal Year style.
 */
export function formatTrendDate(
  dateStr: string,
  format: TrendDateFormat,
  t?: number
): string {
  const trimmed = dateStr.trim();
  if (!trimmed) return "";
  const isoBase = trimmed.split(/[T\s]/)[0] ?? trimmed;
  if (format === "iso") {
    return isoBase;
  }

  const parts = parseTrendDateParts(isoBase);
  if (format === "decimal") {
    if (typeof t === "number" && Number.isFinite(t)) {
      return Number.isInteger(t) ? String(t) : t.toFixed(2);
    }
    if (parts.year === 0) return isoBase;
    if (parts.month !== null && parts.day !== null) {
      return (parts.year + (parts.month - 1 + (parts.day - 0.5) / 30.5) / 12).toFixed(2);
    }
    if (parts.month !== null) {
      return (parts.year + (parts.month - 0.5) / 12).toFixed(2);
    }
    return String(parts.year);
  }

  // "human"
  if (parts.year === 0) return isoBase;
  if (parts.month !== null && parts.day !== null) {
    const mName = SHORT_MONTHS[parts.month - 1] ?? String(parts.month);
    return `${parts.day} ${mName} ${parts.year}`;
  }
  if (parts.month !== null) {
    const mName = SHORT_MONTHS[parts.month - 1] ?? String(parts.month);
    return `${mName} ${parts.year}`;
  }
  return String(parts.year);
}

/**
 * Test whether a monthly/daily observation date falls within a season or single-month filter.
 */
export function matchesSeasonFilter(
  dateStr: string,
  filter: TrendSeasonFilter
): boolean {
  if (filter === "all") return true;
  const { month } = parseTrendDateParts(dateStr);
  if (month === null) return false;
  switch (filter) {
    case "DJF":
      return month === 12 || month === 1 || month === 2;
    case "MAM":
      return month === 3 || month === 4 || month === 5;
    case "JJA":
      return month === 6 || month === 7 || month === 8;
    case "SON":
      return month === 9 || month === 10 || month === 11;
    default: {
      if (filter.startsWith("m")) {
        const target = Number(filter.slice(1));
        return Number.isInteger(target) && month === target;
      }
      return true;
    }
  }
}

/**
 * Resolve concrete start/end dates for presets ("all", "5y", "10y", "15y", "20y",
 * "pre_shift", "post_shift") while preserving at least 3 points when available.
 */
export function resolvePresetDateRange(
  points: ReadonlyArray<{ date: string; t: number }>,
  preset: TrendDatePreset,
  changePointDate?: string | null
): { startDate: string; endDate: string } | null {
  if (points.length < 2) return null;
  const minKeep = Math.min(3, points.length);
  const lastIdx = points.length - 1;

  if (preset === "all") {
    return { startDate: points[0].date, endDate: points[lastIdx].date };
  }

  if (preset === "pre_shift" || preset === "post_shift") {
    if (!changePointDate) return null;
    const cpYear = changePointDate.slice(0, 4);
    let idx = points.findIndex((p) => p.date === changePointDate);
    if (idx < 0) {
      idx = points.findIndex((p) => p.date.slice(0, 4) === cpYear);
    }
    if (idx < 0) {
      const targetKey = startBoundaryKey(changePointDate);
      idx = points.findIndex((p) => startBoundaryKey(p.date) >= targetKey);
    }
    if (idx < 0) return null;

    if (preset === "pre_shift") {
      const endIdx = Math.min(lastIdx, Math.max(minKeep - 1, idx - 1));
      return { startDate: points[0].date, endDate: points[endIdx].date };
    }
    const startIdx = Math.min(idx, Math.max(0, points.length - minKeep));
    return { startDate: points[startIdx].date, endDate: points[lastIdx].date };
  }

  const years =
    preset === "5y" ? 5 : preset === "10y" ? 10 : preset === "15y" ? 15 : 20;
  const maxT = points[lastIdx].t;
  const targetT = maxT - years + 0.02;
  let startIdx = points.findIndex((p) => p.t >= targetT);
  if (startIdx < 0) startIdx = 0;
  startIdx = Math.min(startIdx, Math.max(0, points.length - minKeep));
  return {
    startDate: points[startIdx].date,
    endDate: points[lastIdx].date,
  };
}

export interface WindowedSummaryOutcome {
  summary: TrendAnalysisSummary;
  isWindowed: boolean;
  tooFewPoints?: boolean;
}

/**
 * Recompute Mann-Kendall, Hamed-Rao, Theil-Sen, OLS, Pettitt, and Seasonal MK statistics
 * over a custom date window and/or calendar season slice.
 */
export function buildWindowedTrendSummary({
  baseSummary,
  startDate,
  endDate,
  seasonFilter,
  resolution,
}: {
  baseSummary: TrendAnalysisSummary;
  startDate: string | null;
  endDate: string | null;
  seasonFilter: TrendSeasonFilter;
  resolution: "monthly" | "annual";
}): WindowedSummaryOutcome {
  if (!startDate && !endDate && seasonFilter === "all") {
    return { summary: baseSummary, isWindowed: false };
  }

  const annualPts = baseSummary.points;
  const monthlyPts = baseSummary.seasonalPoints ?? [];
  const minKey = startDate ? startBoundaryKey(startDate) : Number.NEGATIVE_INFINITY;
  const maxKey = endDate ? endBoundaryKey(endDate) : Number.POSITIVE_INFINITY;

  // Detect no-op full span
  if (seasonFilter === "all" && annualPts.length > 0) {
    const firstKey = startBoundaryKey(
      monthlyPts.length > 0 ? monthlyPts[0].date : annualPts[0].date
    );
    const lastKey = endBoundaryKey(
      monthlyPts.length > 0
        ? monthlyPts[monthlyPts.length - 1].date
        : annualPts[annualPts.length - 1].date
    );
    if (minKey <= firstKey && maxKey >= lastKey) {
      return { summary: baseSummary, isWindowed: false };
    }
  }

  const annualFiltered = annualPts.filter((p) => {
    const k = parseTrendDateParts(p.date).sortKey;
    return k >= minKey && k <= maxKey;
  });
  const monthlyFiltered = monthlyPts.filter((p) => {
    const k = parseTrendDateParts(p.date).sortKey;
    return k >= minKey && k <= maxKey && matchesSeasonFilter(p.date, seasonFilter);
  });

  const baseOptions = {
    lat: baseSummary.lat,
    lng: baseSummary.lng,
    dataset: baseSummary.dataset,
    parameter: baseSummary.parameter,
    unit: baseSummary.unit,
    slopeUnit: baseSummary.slopeUnit,
    provenance: baseSummary.provenance,
    ...(baseSummary.provenanceMode ? { provenanceMode: baseSummary.provenanceMode } : {}),
  };

  const attachMetadata = (next: TrendAnalysisSummary): TrendAnalysisSummary => ({
    ...next,
    ...(baseSummary.measurementKind
      ? { measurementKind: baseSummary.measurementKind }
      : {}),
    ...(baseSummary.proxyNote ? { proxyNote: baseSummary.proxyNote } : {}),
  });

  // Case A: Season/month slice OR zoomed monthly span where annual has < 3 points
  if (
    (seasonFilter !== "all" || (resolution === "monthly" && annualFiltered.length < 3)) &&
    monthlyFiltered.length >= 3
  ) {
    const rawPts: TimeSeriesPoint[] = monthlyFiltered.map((p) => ({
      date: p.date,
      t: p.t,
      value: p.value,
    }));
    const analyzed = attachMetadata(analyzeTimeSeries(rawPts, baseOptions));
    if (seasonFilter !== "all") {
      // Omit seasonalPoints so detail view plots the filtered season/month series directly
      return { summary: analyzed, isWindowed: true };
    }
    const smk =
      monthlyFiltered.length >= 18 ? computeSeasonalMannKendall(rawPts) : null;
    return {
      summary: {
        ...analyzed,
        seasonalAnalysis: smk,
        seasonalPoints: monthlyFiltered.map((p, idx) => ({
          date: p.date,
          t: p.t,
          value: p.value,
          anomalyValue: smk
            ? Number((smk.deseasonalizedValues[idx] ?? 0).toFixed(4))
            : typeof p.anomalyValue === "number"
              ? p.anomalyValue
              : Number((p.value - analyzed.mean).toFixed(4)),
        })),
      },
      isWindowed: true,
    };
  }

  // Case B: Annual window with >= 3 points (recompute seasonal stats too if >= 18 monthly pts)
  if (seasonFilter === "all" && annualFiltered.length >= 3) {
    const rawAnnual: TimeSeriesPoint[] = annualFiltered.map((p) => ({
      date: p.date,
      t: p.t,
      value: p.value,
    }));
    const analyzed = attachMetadata(analyzeTimeSeries(rawAnnual, baseOptions));
    if (monthlyFiltered.length >= 18) {
      const rawMonthly: TimeSeriesPoint[] = monthlyFiltered.map((p) => ({
        date: p.date,
        t: p.t,
        value: p.value,
      }));
      const smk = computeSeasonalMannKendall(rawMonthly);
      return {
        summary: {
          ...analyzed,
          seasonalAnalysis: smk,
          seasonalPoints: smk
            ? rawMonthly.map((p, idx) => ({
                date: p.date,
                t: p.t,
                value: p.value,
                anomalyValue: Number((smk.deseasonalizedValues[idx] ?? 0).toFixed(4)),
              }))
            : monthlyFiltered,
        },
        isWindowed: true,
      };
    }
    if (resolution === "monthly" && monthlyFiltered.length >= 3) {
      return {
        summary: {
          ...analyzed,
          seasonalAnalysis: baseSummary.seasonalAnalysis,
          seasonalPoints: monthlyFiltered,
        },
        isWindowed: true,
      };
    }
    return { summary: analyzed, isWindowed: true };
  }

  // Fallback if annual resolution selected with a season filter that still has >=3 monthly points
  if (seasonFilter !== "all" && monthlyFiltered.length >= 3) {
    const rawPts: TimeSeriesPoint[] = monthlyFiltered.map((p) => ({
      date: p.date,
      t: p.t,
      value: p.value,
    }));
    return {
      summary: attachMetadata(analyzeTimeSeries(rawPts, baseOptions)),
      isWindowed: true,
    };
  }

  return { summary: baseSummary, isWindowed: false, tooFewPoints: true };
}

/**
 * Recompute two-spot CrossRegionComparison over a custom date window.
 */
export function buildWindowedComparison({
  primary,
  secondary,
  baseComparison,
  startDate,
  endDate,
  mode = "raw",
}: {
  primary: TrendAnalysisSummary;
  secondary: TrendAnalysisSummary;
  baseComparison: CrossRegionComparison;
  startDate: string | null;
  endDate: string | null;
  mode?: "raw" | "anomaly" | "detrended";
}): {
  comparison: CrossRegionComparison;
  primary: TrendAnalysisSummary;
  secondary: TrendAnalysisSummary;
  isWindowed: boolean;
  tooFewPoints?: boolean;
} {
  if (!startDate && !endDate) {
    return { comparison: baseComparison, primary, secondary, isWindowed: false };
  }
  const minKey = startDate ? startBoundaryKey(startDate) : Number.NEGATIVE_INFINITY;
  const maxKey = endDate ? endBoundaryKey(endDate) : Number.POSITIVE_INFINITY;

  const useMonthlyAnomaly =
    mode === "anomaly" &&
    Boolean(
      primary.seasonalPoints &&
        primary.seasonalPoints.length >= 18 &&
        secondary.seasonalPoints &&
        secondary.seasonalPoints.length >= 18
    );

  let firstKey =
    baseComparison.alignedPoints.length > 0
      ? startBoundaryKey(baseComparison.alignedPoints[0].date)
      : Number.POSITIVE_INFINITY;
  let lastKey =
    baseComparison.alignedPoints.length > 0
      ? endBoundaryKey(
          baseComparison.alignedPoints[baseComparison.alignedPoints.length - 1].date
        )
      : Number.NEGATIVE_INFINITY;

  if (useMonthlyAnomaly && primary.seasonalPoints && secondary.seasonalPoints) {
    const secDates = new Set(
      secondary.seasonalPoints
        .filter((p) => typeof p.anomalyValue === "number")
        .map((p) => p.date)
    );
    const pairedDates = primary.seasonalPoints
      .filter((p) => typeof p.anomalyValue === "number" && secDates.has(p.date))
      .map((p) => p.date);
    if (pairedDates.length >= 6) {
      firstKey = startBoundaryKey(pairedDates[0]);
      lastKey = endBoundaryKey(pairedDates[pairedDates.length - 1]);
    }
  }

  if (minKey <= firstKey && maxKey >= lastKey) {
    return { comparison: baseComparison, primary, secondary, isWindowed: false };
  }

  const ptsA: TimeSeriesPoint[] = primary.points
    .filter((p) => {
      const k = parseTrendDateParts(p.date).sortKey;
      return k >= minKey && k <= maxKey;
    })
    .map((p) => ({ date: p.date, t: p.t, value: p.value }));
  const ptsB: TimeSeriesPoint[] = secondary.points
    .filter((p) => {
      const k = parseTrendDateParts(p.date).sortKey;
      return k >= minKey && k <= maxKey;
    })
    .map((p) => ({ date: p.date, t: p.t, value: p.value }));

  const annualComp =
    ptsA.length >= 3 && ptsB.length >= 3
      ? compareRegionalSeries(ptsA, ptsB, {
          latA: primary.lat,
          lngA: primary.lng,
          datasetA: primary.dataset,
          latB: secondary.lat,
          lngB: secondary.lng,
          datasetB: secondary.dataset,
        })
      : null;

  if (annualComp && annualComp.alignedPoints.length >= 3) {
    const resMode: "monthly" | "annual" = useMonthlyAnomaly ? "monthly" : "annual";
    const winA = buildWindowedTrendSummary({
      baseSummary: primary,
      startDate,
      endDate,
      seasonFilter: "all",
      resolution: resMode,
    }).summary;
    const winB = buildWindowedTrendSummary({
      baseSummary: secondary,
      startDate,
      endDate,
      seasonFilter: "all",
      resolution: resMode,
    }).summary;

    return {
      comparison: annualComp,
      primary: winA,
      secondary: winB,
      isWindowed: true,
    };
  }

  if (useMonthlyAnomaly && primary.seasonalPoints && secondary.seasonalPoints) {
    const mapB = new Map<string, { t: number; anom: number }>();
    for (const p of secondary.seasonalPoints) {
      const k = parseTrendDateParts(p.date).sortKey;
      if (k >= minKey && k <= maxKey && typeof p.anomalyValue === "number") {
        mapB.set(p.date, { t: p.t, anom: p.anomalyValue });
      }
    }
    const monthlyA: TimeSeriesPoint[] = [];
    const monthlyB: TimeSeriesPoint[] = [];
    for (const p of primary.seasonalPoints) {
      const k = parseTrendDateParts(p.date).sortKey;
      const hitB = mapB.get(p.date);
      if (k >= minKey && k <= maxKey && typeof p.anomalyValue === "number" && hitB) {
        monthlyA.push({ date: p.date, t: p.t, value: p.anomalyValue });
        monthlyB.push({ date: p.date, t: hitB.t, value: hitB.anom });
      }
    }

    if (monthlyA.length >= 6 && monthlyB.length >= 6) {
      const monthlyComp = compareRegionalSeries(monthlyA, monthlyB, {
        latA: primary.lat,
        lngA: primary.lng,
        datasetA: primary.dataset,
        latB: secondary.lat,
        lngB: secondary.lng,
        datasetB: secondary.dataset,
      });
      if (monthlyComp.alignedPoints.length >= 6) {
        const winA = buildWindowedTrendSummary({
          baseSummary: primary,
          startDate,
          endDate,
          seasonFilter: "all",
          resolution: "monthly",
        }).summary;
        const winB = buildWindowedTrendSummary({
          baseSummary: secondary,
          startDate,
          endDate,
          seasonFilter: "all",
          resolution: "monthly",
        }).summary;
        return {
          comparison: monthlyComp,
          primary: winA,
          secondary: winB,
          isWindowed: true,
        };
      }
    }
  }

  return {
    comparison: baseComparison,
    primary,
    secondary,
    isWindowed: false,
    tooFewPoints: true,
  };
}

/**
 * Find the indices of the minimum and maximum plotted values in a series.
 */
export function findSeriesExtremes(
  points: ReadonlyArray<{ date: string; t: number; value: number }>
): { minIndex: number; maxIndex: number } | null {
  if (points.length === 0) return null;
  let minIndex = 0;
  let maxIndex = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].value < points[minIndex].value) minIndex = i;
    if (points[i].value > points[maxIndex].value) maxIndex = i;
  }
  return { minIndex, maxIndex };
}

export interface PinnedDateComparison {
  earlier: SingleDetailPoint;
  later: SingleDetailPoint;
  elapsedYears: number;
  valueDelta: number;
  anomalyDelta: number;
  zDelta: number;
  pctChange: number | null;
  decadeRateEquivalent: number | null;
}

/**
 * Compute chronological delta, elapsed span, and decadal rate between two pinned dates.
 */
export function computePinnedDateComparison(
  ptA: SingleDetailPoint,
  ptB: SingleDetailPoint
): PinnedDateComparison {
  const aFirst =
    ptA.t !== ptB.t
      ? ptA.t <= ptB.t
      : parseTrendDateParts(ptA.date).sortKey <= parseTrendDateParts(ptB.date).sortKey;
  const earlier = aFirst ? ptA : ptB;
  const later = aFirst ? ptB : ptA;
  const elapsedYears = Math.max(0, later.t - earlier.t);
  const valueDelta = later.value - earlier.value;
  const anomalyDelta = later.anomaly - earlier.anomaly;
  const zDelta = later.zScore - earlier.zScore;
  const pctChange =
    Math.abs(earlier.value) > 1e-9
      ? (valueDelta / Math.abs(earlier.value)) * 100
      : null;
  const decadeRateEquivalent =
    elapsedYears >= 0.08 ? (valueDelta / elapsedYears) * 10 : null;

  return {
    earlier,
    later,
    elapsedYears,
    valueDelta,
    anomalyDelta,
    zDelta,
    pctChange,
    decadeRateEquivalent,
  };
}
