import { DATASET_BY_ID } from "@/lib/datasets";
import {
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  isTemperatureUnitString,
} from "@/lib/earth/currentConditionsClient";
import { describeTrendPlainly } from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  TemperatureUnit,
  TrendAnalysisPoint,
  TrendAnalysisSummary,
} from "@/types/etg";
import {
  resolveTemperatureSlopeScale,
  summaryKey,
} from "@/components/spot/spotCardShared";

export type TrendOverlayItem =
  | {
      id: string;
      kind: "single";
      summary: TrendAnalysisSummary;
      side?: "a" | "b";
      sideLabel?: string;
    }
  | {
      id: "compare:both";
      kind: "compare";
      primary: TrendAnalysisSummary;
      secondary: TrendAnalysisSummary;
      comparison: CrossRegionComparison;
      labelA: string;
      labelB: string;
    };

export interface SingleDetailPoint {
  date: string;
  t: number;
  value: number;
  smooth: number;
  trendFit: number;
  ciLow95: number;
  ciHigh95: number;
  anomaly: number;
  zScore: number;
}

export interface PreparedSingleDetailSeries {
  points: SingleDetailPoint[];
  displayUnit: string;
  displaySlopeUnit: string;
  hasSeasonalAnomaly: boolean;
  hasDistinctMonthly: boolean;
  effectiveResolution: "monthly" | "annual";
  referenceY: number;
  minY: number;
  maxY: number;
  changePointIndex: number | null;
}

export type CompareChartMode = "raw" | "anomaly" | "detrended";

export interface CompareDetailPoint {
  date: string;
  t: number;
  zA: number;
  zB: number;
  rawA: number;
  rawB: number;
  rawAFormatted: string;
  rawBFormatted: string;
}

export interface PreparedComparisonDetailSeries {
  points: CompareDetailPoint[];
  effectiveMode: CompareChartMode;
  canCompareDeseasonalized: boolean;
  unitA: string;
  unitB: string;
  minY: number;
  maxY: number;
}

/**
 * Build the ordered list of trend graphs available for navigation in the detail overlay.
 */
export function buildTrendOverlayItems({
  summaries,
  primary,
  secondary,
  comparison,
  labelA,
  labelB,
}: {
  summaries: readonly TrendAnalysisSummary[];
  primary: TrendAnalysisSummary | null;
  secondary?: TrendAnalysisSummary | null;
  comparison?: CrossRegionComparison | null;
  labelA: string;
  labelB: string;
}): TrendOverlayItem[] {
  const uniqueSummaries: TrendAnalysisSummary[] = [];
  const seenKeys = new Set<string>();
  for (const s of summaries) {
    const key = summaryKey(s);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueSummaries.push(s);
  }

  if (
    comparison &&
    primary &&
    secondary &&
    comparison.alignedPoints.length >= 3
  ) {
    const items: TrendOverlayItem[] = [
      {
        id: "compare:both",
        kind: "compare",
        primary,
        secondary,
        comparison,
        labelA,
        labelB,
      },
      {
        id: "compare:a",
        kind: "single",
        summary: primary,
        side: "a",
        sideLabel: labelA,
      },
      {
        id: "compare:b",
        kind: "single",
        summary: secondary,
        side: "b",
        sideLabel: labelB,
      },
    ];
    const primaryKey = summaryKey(primary);
    for (const s of uniqueSummaries) {
      const k = summaryKey(s);
      if (k !== primaryKey) {
        items.push({ id: k, kind: "single", summary: s });
      }
    }
    return items;
  }

  if (uniqueSummaries.length > 0) {
    return uniqueSummaries.map((s) => ({
      id: summaryKey(s),
      kind: "single",
      summary: s,
    }));
  }

  if (primary) {
    return [{ id: summaryKey(primary), kind: "single", summary: primary }];
  }

  return [];
}

/**
 * Compute trailing rolling mean over a finite numeric array.
 */
function trailingRollingMean(values: readonly number[], windowSize: number): number[] {
  const result: number[] = [];
  let runningSum = 0;
  for (let i = 0; i < values.length; i++) {
    runningSum += values[i];
    if (i >= windowSize) {
      runningSum -= values[i - windowSize];
    }
    const denom = Math.min(i + 1, windowSize);
    result.push(runningSum / denom);
  }
  return result;
}

/**
 * Prepare converted observations, rolling smooth curve, Theil-Sen trend line, 95% CI band,
 * and Pettitt change-point index for a single TrendAnalysisSummary at monthly or annual resolution.
 */
export function prepareSingleDetailSeries(
  summary: TrendAnalysisSummary,
  mode: "raw" | "anomaly",
  resolution: "monthly" | "annual",
  tempUnit: TemperatureUnit
): PreparedSingleDetailSeries {
  const hasSeasonalAnomaly = Boolean(
    summary.seasonalAnalysis &&
      ((summary.seasonalPoints && summary.seasonalPoints.length >= 18) ||
        summary.points.some((p) => typeof p.anomalyValue === "number"))
  );
  const hasDistinctMonthly = Boolean(
    summary.seasonalPoints &&
      summary.seasonalPoints.length >= 18 &&
      summary.seasonalPoints.length !== summary.points.length
  );
  const effectiveResolution: "monthly" | "annual" =
    hasDistinctMonthly && resolution === "monthly" ? "monthly" : "annual";

  const sourcePoints: ReadonlyArray<{
    date: string;
    t: number;
    value: number;
    anomalyValue?: number;
    movingAverage?: number;
    zScore?: number;
  }> =
    effectiveResolution === "monthly" && summary.seasonalPoints
      ? summary.seasonalPoints
      : summary.points;

  const hasTempUnit = isTemperatureUnitString(summary.unit);
  const toDisplay = (v: number) =>
    hasTempUnit ? convertTemperatureDisplayValue(v, summary.unit, tempUnit) : v;
  const { factor: unitDeltaScale } = resolveTemperatureSlopeScale(
    hasTempUnit ? summary.unit : summary.slopeUnit,
    tempUnit,
    hasTempUnit
  );
  const toDisplayDelta = (v: number) => v * unitDeltaScale;

  const displayUnit = hasTempUnit
    ? convertTemperatureUnitLabel(summary.unit, tempUnit)
    : summary.unit;
  const displaySlopeUnit = resolveTemperatureSlopeScale(
    summary.slopeUnit,
    tempUnit,
    hasTempUnit
  ).unit;

  if (sourcePoints.length === 0) {
    return {
      points: [],
      displayUnit,
      displaySlopeUnit,
      hasSeasonalAnomaly,
      hasDistinctMonthly,
      effectiveResolution,
      referenceY: 0,
      minY: 0,
      maxY: 1,
      changePointIndex: null,
    };
  }

  const seriesValues = sourcePoints.map((p) => {
    if (mode === "anomaly") {
      const anom = typeof p.anomalyValue === "number" ? p.anomalyValue : p.value - summary.mean;
      return toDisplayDelta(anom);
    }
    return toDisplay(p.value);
  });

  const smoothValues =
    effectiveResolution === "monthly"
      ? trailingRollingMean(seriesValues, 12)
      : mode === "raw"
        ? (sourcePoints as ReadonlyArray<TrendAnalysisPoint>).map((p, idx) =>
            typeof p.movingAverage === "number" && Number.isFinite(p.movingAverage)
              ? toDisplay(p.movingAverage)
              : trailingRollingMean(seriesValues, 3)[idx]
          )
        : trailingRollingMean(seriesValues, 3);

  const midT = (sourcePoints[0].t + sourcePoints[sourcePoints.length - 1].t) / 2;
  const meanSeries =
    seriesValues.reduce((acc, val) => acc + val, 0) / Math.max(1, seriesValues.length);
  const stdDevSeries = Math.sqrt(
    seriesValues.reduce((acc, val) => acc + (val - meanSeries) ** 2, 0) /
      Math.max(1, seriesValues.length)
  );

  const useSeasonalSlope =
    mode === "anomaly" &&
    Boolean(summary.seasonalAnalysis) &&
    (effectiveResolution === "monthly" ||
      Boolean(summary.seasonalPoints && summary.seasonalPoints.length >= 18));

  const points: SingleDetailPoint[] = sourcePoints.map((p, idx) => {
    const dt = p.t - midT;
    let trendFit: number;
    let ciA: number;
    let ciB: number;

    if (mode === "anomaly") {
      const slope =
        useSeasonalSlope && summary.seasonalAnalysis
          ? toDisplayDelta(summary.seasonalAnalysis.seasonalTheilSenSlope)
          : toDisplayDelta(summary.theilSen.slope);
      const halfWidth =
        useSeasonalSlope && summary.seasonalAnalysis
          ? Math.abs(
              toDisplayDelta(summary.theilSen.slopeHigh95 - summary.theilSen.slopeLow95)
            ) / 2
          : null;
      const slopeLow =
        halfWidth !== null ? slope - halfWidth : toDisplayDelta(summary.theilSen.slopeLow95);
      const slopeHigh =
        halfWidth !== null ? slope + halfWidth : toDisplayDelta(summary.theilSen.slopeHigh95);
      trendFit = meanSeries + slope * dt;
      ciA = meanSeries + slopeLow * dt;
      ciB = meanSeries + slopeHigh * dt;
    } else {
      const slopeLow = toDisplayDelta(summary.theilSen.slopeLow95);
      const slopeHigh = toDisplayDelta(summary.theilSen.slopeHigh95);
      const trendAtMidT = toDisplay(summary.theilSen.slope * midT + summary.theilSen.intercept);
      trendFit = toDisplay(summary.theilSen.slope * p.t + summary.theilSen.intercept);
      ciA = trendAtMidT + slopeLow * dt;
      ciB = trendAtMidT + slopeHigh * dt;
    }

    const rawAnom =
      typeof p.anomalyValue === "number" ? p.anomalyValue : p.value - summary.mean;
    const zScore =
      typeof p.zScore === "number" && Number.isFinite(p.zScore)
        ? p.zScore
        : stdDevSeries > 1e-12
          ? (seriesValues[idx] - meanSeries) / stdDevSeries
          : 0;

    return {
      date: p.date,
      t: p.t,
      value: seriesValues[idx],
      smooth: smoothValues[idx] ?? seriesValues[idx],
      trendFit,
      ciLow95: Math.min(ciA, ciB),
      ciHigh95: Math.max(ciA, ciB),
      anomaly: toDisplayDelta(rawAnom),
      zScore,
    };
  });

  const referenceY = mode === "anomaly" ? 0 : toDisplay(summary.mean);

  let minY = referenceY;
  let maxY = referenceY;
  for (const pt of points) {
    minY = Math.min(minY, pt.value, pt.smooth, pt.trendFit, pt.ciLow95);
    maxY = Math.max(maxY, pt.value, pt.smooth, pt.trendFit, pt.ciHigh95);
  }
  if (Math.abs(maxY - minY) < 1e-6) {
    minY -= 0.5;
    maxY += 0.5;
  }

  let changePointIndex: number | null = null;
  if (summary.changePoint) {
    const cpDate = summary.changePoint.date;
    const exactIdx = points.findIndex((p) => p.date === cpDate);
    if (exactIdx >= 0) {
      changePointIndex = exactIdx;
    } else {
      const cpYear = cpDate.slice(0, 4);
      const yearIdx = points.findIndex((p) => p.date.slice(0, 4) === cpYear);
      if (yearIdx >= 0) {
        changePointIndex = yearIdx;
      }
    }
  }

  return {
    points,
    displayUnit,
    displaySlopeUnit,
    hasSeasonalAnomaly,
    hasDistinctMonthly,
    effectiveResolution,
    referenceY,
    minY,
    maxY,
    changePointIndex,
  };
}

function parseCompareDateT(dateStr: string): number {
  const base = dateStr.trim().split(/[T\s]/)[0] ?? "";
  const ym = base.match(/^(-?\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (ym) {
    const year = Number(ym[1]);
    const month = Math.max(1, Math.min(12, Number(ym[2])));
    const day = ym[3] ? Math.max(1, Math.min(31, Number(ym[3]))) : null;
    return day !== null
      ? year + (month - 1 + (day - 0.5) / 30.5) / 12
      : year + (month - 0.5) / 12;
  }
  const y = base.match(/^(-?\d{4})/);
  return y ? Number(y[1]) : 0;
}

/**
 * Prepare normalized comparison points (raw Z, deseasonalized Z, or detrended Z) for
 * the two-spot cross-region comparison view.
 */
export function prepareComparisonDetailSeries({
  primary,
  secondary,
  comparison,
  mode,
  tempUnit,
}: {
  primary: TrendAnalysisSummary;
  secondary: TrendAnalysisSummary;
  comparison: CrossRegionComparison;
  mode: CompareChartMode;
  tempUnit: TemperatureUnit;
}): PreparedComparisonDetailSeries {
  const pairedDatesB = new Set(
    (secondary.seasonalPoints ?? [])
      .filter((p) => typeof p.anomalyValue === "number")
      .map((p) => p.date)
  );
  let pairedMonthlyCount = 0;
  for (const p of primary.seasonalPoints ?? []) {
    if (typeof p.anomalyValue === "number" && pairedDatesB.has(p.date)) {
      pairedMonthlyCount += 1;
    }
  }
  const canCompareDeseasonalized = pairedMonthlyCount >= 6;
  const effectiveMode: CompareChartMode =
    mode === "anomaly" && !canCompareDeseasonalized ? "raw" : mode;

  const isTempA = isTemperatureUnitString(primary.unit);
  const isTempB = isTemperatureUnitString(secondary.unit);
  const unitA = isTempA
    ? convertTemperatureUnitLabel(primary.unit, tempUnit)
    : primary.unit;
  const unitB = isTempB
    ? convertTemperatureUnitLabel(secondary.unit, tempUnit)
    : secondary.unit;

  const toDisp = (val: number, isTemp: boolean, srcUnit: string) =>
    isTemp ? convertTemperatureDisplayValue(val, srcUnit, tempUnit) : val;

  const fmtDispVal = (dispVal: number, dispUnit: string) => {
    const decimals = Math.abs(dispVal) >= 100 ? 1 : 2;
    return `${dispVal.toFixed(decimals)}${dispUnit && dispUnit !== "value" ? ` ${dispUnit}` : ""}`;
  };

  let points: CompareDetailPoint[];
  if (effectiveMode === "anomaly" && primary.seasonalPoints && secondary.seasonalPoints) {
    const mapB = new Map<string, { t: number; val: number; anom: number }>();
    for (const p of secondary.seasonalPoints) {
      if (typeof p.anomalyValue === "number") {
        mapB.set(p.date, { t: p.t, val: p.value, anom: p.anomalyValue });
      }
    }
    const paired: Array<{
      date: string;
      t: number;
      aAnom: number;
      bAnom: number;
      rawA: number;
      rawB: number;
    }> = [];
    for (const p of primary.seasonalPoints) {
      const hitB = mapB.get(p.date);
      if (typeof p.anomalyValue === "number" && hitB) {
        paired.push({
          date: p.date,
          t: p.t,
          aAnom: p.anomalyValue,
          bAnom: hitB.anom,
          rawA: p.value,
          rawB: hitB.val,
        });
      }
    }
    if (paired.length >= 6) {
      const zScore = (vals: number[]) => {
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const std = Math.sqrt(
          vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length)
        );
        const denom = std > 1e-9 ? std : 1;
        return vals.map((v) => (v - mean) / denom);
      };
      const zAs = zScore(paired.map((p) => p.aAnom));
      const zBs = zScore(paired.map((p) => p.bAnom));
      points = paired.map((p, i) => {
        const dispA = toDisp(p.rawA, isTempA, primary.unit);
        const dispB = toDisp(p.rawB, isTempB, secondary.unit);
        return {
          date: p.date,
          t: p.t,
          zA: zAs[i],
          zB: zBs[i],
          rawA: dispA,
          rawB: dispB,
          rawAFormatted: fmtDispVal(dispA, unitA),
          rawBFormatted: fmtDispVal(dispB, unitB),
        };
      });
    } else {
      points = comparison.alignedPoints.map((p) => {
        const dispA = toDisp(p.rawA, isTempA, primary.unit);
        const dispB = toDisp(p.rawB, isTempB, secondary.unit);
        return {
          date: p.date,
          t: parseCompareDateT(p.date),
          zA: p.zA,
          zB: p.zB,
          rawA: dispA,
          rawB: dispB,
          rawAFormatted: fmtDispVal(dispA, unitA),
          rawBFormatted: fmtDispVal(dispB, unitB),
        };
      });
    }
  } else {
    points = comparison.alignedPoints.map((p) => {
      const dispA = toDisp(p.rawA, isTempA, primary.unit);
      const dispB = toDisp(p.rawB, isTempB, secondary.unit);
      return {
        date: p.date,
        t: parseCompareDateT(p.date),
        zA: effectiveMode === "detrended" ? p.detrendedZA : p.zA,
        zB: effectiveMode === "detrended" ? p.detrendedZB : p.zB,
        rawA: dispA,
        rawB: dispB,
        rawAFormatted: fmtDispVal(dispA, unitA),
        rawBFormatted: fmtDispVal(dispB, unitB),
      };
    });
  }

  const allZ = points.flatMap((p) => [p.zA, p.zB]);
  const minY = Math.min(-2, ...allZ);
  const maxY = Math.max(2, ...allZ);

  return {
    points,
    effectiveMode,
    canCompareDeseasonalized,
    unitA,
    unitB,
    minY,
    maxY,
  };
}

/**
 * Compute finite, readable Y-axis tick values covering [minY, maxY].
 */
export function computeNiceTicks(minY: number, maxY: number, count = 5): number[] {
  const safeCount = Math.max(2, Math.round(count));
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return [0, 1];
  const lo = Math.min(minY, maxY);
  const hi = Math.max(minY, maxY);
  const span = hi - lo;
  if (span <= 1e-9) {
    const step = 0.5;
    return Array.from({ length: safeCount }, (_, i) => lo - step + (i * step * 2) / (safeCount - 1));
  }
  const rawStep = span / (safeCount - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = niceNorm * mag;
  const tickMin = Math.floor(lo / step) * step;
  const tickMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = tickMin; v <= tickMax + step * 0.25; v += step) {
    ticks.push(Number(v.toFixed(6)));
    if (ticks.length > 12) break;
  }
  return ticks.length >= 2 ? ticks : [lo, hi];
}

/**
 * Select evenly spaced X-axis label indices always including the first and last points.
 */
export function pickXAxisTickIndices(length: number, maxTicks = 7): number[] {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const target = Math.max(2, Math.min(length, maxTicks));
  const indices = new Set<number>([0, length - 1]);
  const last = length - 1;
  for (let i = 1; i < target - 1; i++) {
    const idx = Math.round((i / (target - 1)) * last);
    if (idx > 0 && idx < last) indices.add(idx);
  }
  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Map a pointer clientX coordinate over an SVG bounding box to the nearest data point index.
 */
export function pointerClientXToIndex(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  viewBoxWidth: number,
  padLeft: number,
  plotWidth: number,
  pointCount: number
): number {
  if (pointCount <= 1 || rectWidth <= 0 || plotWidth <= 0) return 0;
  const svgX = ((clientX - rectLeft) / rectWidth) * viewBoxWidth;
  const frac = Math.max(0, Math.min(1, (svgX - padLeft) / plotWidth));
  return Math.round(frac * (pointCount - 1));
}

function escapeCsvCell(raw: string): string {
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Format a single trend detail series into RFC-4180-safe CSV text for local download.
 */
export function formatDetailSeriesCsv(
  itemTitle: string,
  rows: ReadonlyArray<{
    date: string;
    value: number;
    smooth: number;
    trendFit: number;
    anomaly: number;
    zScore?: number;
  }>,
  unit: string
): string {
  const safeUnit = unit || "units";
  const header = [
    "series",
    "date",
    `value (${safeUnit})`,
    `rolling_smooth (${safeUnit})`,
    `theil_sen_fit (${safeUnit})`,
    `anomaly_delta (${safeUnit})`,
    "z_score",
  ]
    .map(escapeCsvCell)
    .join(",");

  const lines = rows.map((r) =>
    [
      escapeCsvCell(itemTitle),
      escapeCsvCell(r.date),
      r.value.toFixed(4),
      r.smooth.toFixed(4),
      r.trendFit.toFixed(4),
      r.anomaly.toFixed(4),
      typeof r.zScore === "number" ? r.zScore.toFixed(4) : "",
    ].join(",")
  );

  return [header, ...lines].join("\n");
}

/**
 * Format a compact plain label for a TrendOverlayItem tab button.
 */
export function getOverlayItemTabMeta(
  item: TrendOverlayItem,
  tempUnit: TemperatureUnit
): {
  title: string;
  subtitle: string;
  rateShort: string;
  color: string;
  dirSymbol: "↑" | "↓" | "—";
} {
  if (item.kind === "compare") {
    return {
      title: `${item.labelA} ↔ ${item.labelB}`,
      subtitle: "Normalized Z-Score Comparison",
      rateShort: `r = ${item.comparison.pearsonR >= 0 ? "+" : ""}${item.comparison.pearsonR.toFixed(2)}`,
      color: "#38bdf8",
      dirSymbol: item.comparison.pearsonR >= 0 ? "↑" : "↓",
    };
  }
  const d = describeTrendPlainly(item.summary, tempUnit);
  const meta = DATASET_BY_ID[item.summary.dataset];
  const color = item.side === "b" ? "#38bdf8" : (meta?.color ?? "#e2a856");
  const dirSymbol = d.isSignificant ? (d.tone === "rising" ? "↑" : "↓") : "—";
  const prefix = item.sideLabel ? `${item.side === "b" ? "B" : "A"}: ` : "";
  return {
    title: `${prefix}${d.topicLabel}`,
    subtitle: d.parameterShort,
    rateShort: d.ratePerDecade.replace(" / decade", "/dec"),
    color,
    dirSymbol,
  };
}
