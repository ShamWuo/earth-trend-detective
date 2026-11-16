"use client";

import { useId, useState } from "react";
import { Maximize2 } from "lucide-react";
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
  TrendAnalysisSummary,
} from "@/types/etg";
import { pointerClientXToIndex } from "@/components/spot/trendChartDetailUtils";
import { resolveTemperatureSlopeScale } from "@/components/spot/spotCardShared";
import {
  buildWindowedTrendSummary,
  formatTrendDate,
  parseTrendDateParts,
  resolvePresetDateRange,
  type TrendDatePreset,
} from "@/components/spot/trendDateUtils";

export function MiniSparkline({
  points,
  color,
  width = 56,
  height = 18,
}: {
  points: TrendAnalysisSummary["points"];
  color: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const span = Math.max(1e-6, max - min);
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const d = points
    .map((p, idx) => {
      const x = pad + (idx / Math.max(1, points.length - 1)) * innerW;
      const y = pad + innerH - ((p.value - min) / span) * innerH;
      return `${idx === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SpotTrendChart({
  summary,
  secondarySummary = null,
  comparison,
  labelA,
  labelB,
  tempUnit,
  hideTopicLabel = false,
  onOpenDetail,
}: {
  summary: TrendAnalysisSummary | null;
  secondarySummary?: TrendAnalysisSummary | null;
  comparison: CrossRegionComparison | null;
  labelA: string;
  labelB: string;
  tempUnit: TemperatureUnit;
  hideTopicLabel?: boolean;
  onOpenDetail?: (options: {
    mode: "raw" | "anomaly";
    focus: "both" | "a" | "b";
    preset?: TrendDatePreset;
  }) => void;
}) {
  const chartDescId = useId();
  const [chartMode, setChartMode] = useState<"raw" | "anomaly">("raw");
  const [seriesFocus, setSeriesFocus] = useState<"both" | "a" | "b">("both");
  const [quickPreset, setQuickPreset] = useState<"all" | "20y" | "10y" | "5y">("all");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hasOverlay = Boolean(comparison && comparison.alignedPoints.length >= 3);
  const effectiveFocus = hasOverlay ? seriesFocus : "a";
  const w = 320;
  const h = 132;
  const padX = 16;
  const padY = 14;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;

  const focusSwitcher =
    hasOverlay && (summary || secondarySummary) ? (
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Chart series focus">
        <button
          type="button"
          aria-pressed={effectiveFocus === "both"}
          onClick={() => setSeriesFocus("both")}
          className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
            effectiveFocus === "both"
              ? "border-accent-fg bg-amber-950 text-amber-300"
              : "border-border bg-surface text-text-muted hover:text-text-primary"
          }`}
        >
          Both (Z-Score)
        </button>
        {summary && (
          <button
            type="button"
            aria-pressed={effectiveFocus === "a"}
            onClick={() => setSeriesFocus("a")}
            className={`max-w-[110px] truncate rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
              effectiveFocus === "a"
                ? "border-amber-400 bg-amber-950 text-amber-300"
                : "border-border bg-surface text-text-muted hover:text-text-primary"
            }`}
          >
            A: {labelA}
          </button>
        )}
        {secondarySummary && (
          <button
            type="button"
            aria-pressed={effectiveFocus === "b"}
            onClick={() => setSeriesFocus("b")}
            className={`max-w-[110px] truncate rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
              effectiveFocus === "b"
                ? "border-sky-400 bg-sky-950 text-sky-300"
                : "border-border bg-surface text-text-muted hover:text-text-primary"
            }`}
          >
            B: {labelB}
          </button>
        )}
      </div>
    ) : null;

  if (hasOverlay && comparison && effectiveFocus === "both") {
    const rawPts = comparison.alignedPoints;
    const canCompareDeseasonalized = Boolean(
      summary?.seasonalPoints &&
        summary.seasonalPoints.length >= 18 &&
        secondarySummary?.seasonalPoints &&
        secondarySummary.seasonalPoints.length >= 18
    );
    const effectiveCompareMode =
      canCompareDeseasonalized && chartMode === "anomaly" ? "anomaly" : "raw";

    const basePts: Array<{ date: string; zA: number; zB: number }> = (() => {
      if (effectiveCompareMode !== "anomaly" || !summary?.seasonalPoints || !secondarySummary?.seasonalPoints) {
        return rawPts;
      }
      const mapB = new Map<string, number>();
      for (const p of secondarySummary.seasonalPoints) {
        if (typeof p.anomalyValue === "number") {
          mapB.set(p.date, p.anomalyValue);
        }
      }
      const paired: Array<{ date: string; a: number; b: number }> = [];
      for (const p of summary.seasonalPoints) {
        const bVal = mapB.get(p.date);
        if (typeof p.anomalyValue === "number" && bVal !== undefined) {
          paired.push({ date: p.date, a: p.anomalyValue, b: bVal });
        }
      }
      if (paired.length < 6) return rawPts;
      const zScore = (vals: number[]) => {
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const std = Math.sqrt(
          vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length)
        );
        const denom = std > 1e-9 ? std : 1;
        return vals.map((v) => (v - mean) / denom);
      };
      const zAs = zScore(paired.map((p) => p.a));
      const zBs = zScore(paired.map((p) => p.b));
      return paired.map((p, idx) => ({ date: p.date, zA: zAs[idx], zB: zBs[idx] }));
    })();

    const withT = basePts.map((p) => {
      const parsed = parseTrendDateParts(p.date);
      const t =
        parsed.month !== null
          ? parsed.year + (parsed.month - 0.5) / 12
          : parsed.year;
      return { ...p, t };
    });
    const totalSpanYears =
      withT.length >= 2 ? withT[withT.length - 1].t - withT[0].t : 0;
    const compPresetOptions: Array<"all" | "20y" | "10y" | "5y"> = [
      "all",
      ...(totalSpanYears >= 22 ? (["20y"] as const) : []),
      ...(totalSpanYears >= 12 ? (["10y"] as const) : []),
      ...(totalSpanYears >= 8 ? (["5y"] as const) : []),
    ];
    const effectiveCompPreset = compPresetOptions.includes(
      quickPreset as "all" | "20y" | "10y" | "5y"
    )
      ? quickPreset
      : "all";
    const presetRange =
      effectiveCompPreset !== "all" && totalSpanYears >= 8
        ? resolvePresetDateRange(withT, effectiveCompPreset)
        : null;
    const pts = (() => {
      if (!presetRange) return basePts;
      const sIdx = basePts.findIndex((p) => p.date === presetRange.startDate);
      const eIdx = basePts.findIndex((p) => p.date === presetRange.endDate);
      if (sIdx >= 0 && eIdx >= sIdx && eIdx - sIdx + 1 >= 3) {
        return basePts.slice(sIdx, eIdx + 1);
      }
      return basePts;
    })();

    const activeHoverIdx =
      hoverIndex !== null && hoverIndex >= 0 && hoverIndex < pts.length
        ? hoverIndex
        : null;
    const hoverPt = activeHoverIdx !== null ? pts[activeHoverIdx] : null;

    const allZ = pts.flatMap((p) => [p.zA, p.zB]);
    const minY = Math.min(-2, ...allZ);
    const maxY = Math.max(2, ...allZ);
    const span = Math.max(1e-6, maxY - minY);
    const xAt = (i: number) => padX + (i / Math.max(1, pts.length - 1)) * plotW;
    const yAt = (v: number) => padY + plotH - ((v - minY) / span) * plotH;

    const pathA = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zA).toFixed(1)}`)
      .join(" ");
    const pathB = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zB).toFixed(1)}`)
      .join(" ");

    const saA = summary?.seasonalAnalysis;
    const saB = secondarySummary?.seasonalAnalysis;

    return (
      <div className="ws-inset space-y-1.5 rounded-md p-2">
        <div className="flex items-center justify-between gap-1.5 text-[11px] text-text-subtle">
          <span className="font-medium text-text-primary">How the two spots move over time</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="ws-numeric">
              {hoverPt
                ? `${formatTrendDate(hoverPt.date, "human")} (${hoverPt.zA >= 0 ? "+" : ""}${hoverPt.zA.toFixed(1)}σ / ${hoverPt.zB >= 0 ? "+" : ""}${hoverPt.zB.toFixed(1)}σ)`
                : `${formatTrendDate(pts[0]?.date ?? "", "human")}–${formatTrendDate(pts[pts.length - 1]?.date ?? "", "human")}`}
            </span>
            {onOpenDetail && (
              <button
                type="button"
                onClick={() =>
                  onOpenDetail({
                    mode: effectiveCompareMode,
                    focus: effectiveFocus,
                    preset: effectiveCompPreset,
                  })
                }
                aria-label="Open trend graph in detail overlay"
                title="Open trend graph in detail overlay"
                className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-accent-fg hover:text-text-primary cursor-pointer"
              >
                <Maximize2 className="h-2.5 w-2.5" aria-hidden="true" />
                <span>Detail</span>
              </button>
            )}
          </div>
        </div>
        {focusSwitcher}
        {(canCompareDeseasonalized || compPresetOptions.length > 1) && (
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {canCompareDeseasonalized && (
                <div className="flex items-center gap-1" role="group" aria-label="Time series display mode">
                  <button
                    type="button"
                    aria-pressed={effectiveCompareMode === "raw"}
                    onClick={() => setChartMode("raw")}
                    title="Raw Values"
                    className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                      effectiveCompareMode === "raw"
                        ? "border-accent-fg bg-amber-950 text-amber-300"
                        : "border-border bg-surface text-text-muted hover:text-text-primary"
                    }`}
                  >
                    Raw
                  </button>
                  <button
                    type="button"
                    aria-pressed={effectiveCompareMode === "anomaly"}
                    onClick={() => setChartMode("anomaly")}
                    title="Seasonal Cycle Removed"
                    className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                      effectiveCompareMode === "anomaly"
                        ? "border-accent-fg bg-amber-950 text-amber-300"
                        : "border-border bg-surface text-text-muted hover:text-text-primary"
                    }`}
                  >
                    Deseasonalized
                  </button>
                </div>
              )}
              {compPresetOptions.length > 1 && (
                <div className="flex items-center gap-0.5" role="group" aria-label="Compact date range">
                  {compPresetOptions.map((pr) => (
                    <button
                      key={pr}
                      type="button"
                      aria-pressed={effectiveCompPreset === pr}
                      onClick={() => {
                        setQuickPreset(pr);
                        setHoverIndex(null);
                      }}
                      className={`rounded-xs border px-1.5 py-0.5 text-[9.5px] font-medium transition-colors cursor-pointer ${
                        effectiveCompPreset === pr
                          ? "border-sky-400 bg-sky-950 text-sky-200"
                          : "border-border bg-surface text-text-subtle hover:text-text-primary"
                      }`}
                    >
                      {pr === "all" ? "All" : pr}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {canCompareDeseasonalized && (saA || saB) && (
              <span
                title="Seasonal Mann-Kendall (SMK) tests whether the long-term direction holds across the same calendar months while controlling for annual seasonality."
                className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
              >
                {saA ? `A Seasonal p=${saA.pValue < 0.0001 ? "<0.0001" : saA.pValue.toFixed(4)}` : ""}
                {saA && saB ? " · " : ""}
                {saB ? `B Seasonal p=${saB.pValue < 0.0001 ? "<0.0001" : saB.pValue.toFixed(4)}` : ""}
              </span>
            )}
          </div>
        )}
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className={`h-[94px] w-full ${onOpenDetail ? "cursor-pointer" : ""}`}
          aria-describedby={chartDescId}
          onPointerMove={(e) => {
            if (pts.length <= 1) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setHoverIndex(
              pointerClientXToIndex(
                e.clientX,
                rect.left,
                rect.width,
                w,
                padX,
                plotW,
                pts.length
              )
            );
          }}
          onPointerLeave={() => setHoverIndex(null)}
          onClick={
            onOpenDetail
              ? () =>
                  onOpenDetail({
                    mode: effectiveCompareMode,
                    focus: effectiveFocus,
                    preset: effectiveCompPreset,
                  })
              : undefined
          }
        >
          <line
            x1={padX}
            y1={yAt(0)}
            x2={w - padX}
            y2={yAt(0)}
            stroke="var(--border-strong)"
            strokeDasharray="3 3"
          />
          <path d={pathA} fill="none" stroke="#facc15" strokeWidth={effectiveCompareMode === "anomaly" ? 1.5 : 2} strokeLinecap="round" />
          <path d={pathB} fill="none" stroke="#38bdf8" strokeWidth={effectiveCompareMode === "anomaly" ? 1.5 : 2} strokeLinecap="round" />
          {activeHoverIdx !== null && hoverPt && (
            <g>
              <line
                x1={xAt(activeHoverIdx)}
                y1={padY}
                x2={xAt(activeHoverIdx)}
                y2={h - padY}
                stroke="var(--text-primary)"
                strokeOpacity={0.35}
                strokeWidth={1}
              />
              <circle
                cx={xAt(activeHoverIdx)}
                cy={yAt(hoverPt.zA)}
                r={3}
                fill="#facc15"
              />
              <circle
                cx={xAt(activeHoverIdx)}
                cy={yAt(hoverPt.zB)}
                r={3}
                fill="#38bdf8"
              />
            </g>
          )}
        </svg>
        <p id={chartDescId} className="sr-only">
          Comparison chart showing normalized {effectiveCompareMode === "anomaly" ? "deseasonalized anomalies" : "changes"} over time for {labelA} and {labelB}.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
              <span className="max-w-[130px] truncate">{labelA}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-sky-400" aria-hidden="true" />
              <span className="max-w-[130px] truncate">{labelB}</span>
            </span>
          </div>
          {(saA || saB) && !canCompareDeseasonalized && (
            <span
              title="Seasonal Mann-Kendall tests whether the long-term direction holds across matching calendar seasons"
              className="font-mono text-[10px] text-text-subtle"
            >
              Select A or B for Seasonal MK p-value
            </span>
          )}
        </div>
      </div>
    );
  }

  const activeChartSummary =
    effectiveFocus === "b" && secondarySummary ? secondarySummary : summary;

  if (!activeChartSummary || activeChartSummary.points.length < 2) return null;

  const baseUsingMonthly = Boolean(
    activeChartSummary.seasonalPoints && activeChartSummary.seasonalPoints.length >= 18
  );
  const rawOrMonthlyPts = baseUsingMonthly
    ? activeChartSummary.seasonalPoints!
    : activeChartSummary.points;

  const totalSpanYears =
    rawOrMonthlyPts.length >= 2
      ? rawOrMonthlyPts[rawOrMonthlyPts.length - 1].t - rawOrMonthlyPts[0].t
      : 0;
  const singlePresetOptions: Array<"all" | "20y" | "10y" | "5y"> = [
    "all",
    ...(totalSpanYears >= 22 ? (["20y"] as const) : []),
    ...(totalSpanYears >= 12 ? (["10y"] as const) : []),
    ...(totalSpanYears >= 8 ? (["5y"] as const) : []),
  ];
  const effectiveSinglePreset = singlePresetOptions.includes(
    quickPreset as "all" | "20y" | "10y" | "5y"
  )
    ? quickPreset
    : "all";
  const singlePresetRange =
    effectiveSinglePreset !== "all" && totalSpanYears >= 8
      ? resolvePresetDateRange(rawOrMonthlyPts, effectiveSinglePreset)
      : null;
  const windowedResult = singlePresetRange
    ? buildWindowedTrendSummary({
        baseSummary: activeChartSummary,
        startDate: singlePresetRange.startDate,
        endDate: singlePresetRange.endDate,
        seasonFilter: "all",
        resolution: baseUsingMonthly ? "monthly" : "annual",
      })
    : null;
  const displaySummary =
    windowedResult && windowedResult.isWindowed
      ? windowedResult.summary
      : activeChartSummary;

  const usingMonthlyPoints = Boolean(
    displaySummary.seasonalPoints && displaySummary.seasonalPoints.length >= 18
  );
  const visiblePts = usingMonthlyPoints
    ? displaySummary.seasonalPoints!
    : displaySummary.points;
  const hasAnomalyView = Boolean(
    displaySummary.seasonalAnalysis &&
      (usingMonthlyPoints ||
        displaySummary.points.some((p) => typeof p.anomalyValue === "number"))
  );
  const effectiveMode = hasAnomalyView && chartMode === "anomaly" ? "anomaly" : "raw";

  const hasTempUnit = isTemperatureUnitString(displaySummary.unit);
  const toDisplay = (v: number) =>
    hasTempUnit ? convertTemperatureDisplayValue(v, displaySummary.unit, tempUnit) : v;
  const { factor: unitDeltaScale } = resolveTemperatureSlopeScale(
    hasTempUnit ? displaySummary.unit : displaySummary.slopeUnit,
    tempUnit,
    hasTempUnit
  );
  const toDisplayDelta = (v: number) => v * unitDeltaScale;
  const displayUnit = hasTempUnit
    ? convertTemperatureUnitLabel(displaySummary.unit, tempUnit)
    : displaySummary.unit;
  const displaySlopeUnit = resolveTemperatureSlopeScale(
    displaySummary.slopeUnit,
    tempUnit,
    hasTempUnit
  ).unit;

  const seriesValues = visiblePts.map((p) =>
    effectiveMode === "anomaly" ? toDisplayDelta(p.anomalyValue ?? 0) : toDisplay(p.value)
  );
  const trendValues =
    effectiveMode === "anomaly" && displaySummary.seasonalAnalysis
      ? (() => {
          const saWin = displaySummary.seasonalAnalysis;
          const midT = (visiblePts[0].t + visiblePts[visiblePts.length - 1].t) / 2;
          const meanAnom =
            seriesValues.reduce((s, v) => s + v, 0) / Math.max(1, seriesValues.length);
          return visiblePts.map(
            (p) => meanAnom + toDisplayDelta(saWin.seasonalTheilSenSlope * (p.t - midT))
          );
        })()
      : usingMonthlyPoints
        ? visiblePts.map((p) =>
            toDisplay(displaySummary.theilSen.slope * p.t + displaySummary.theilSen.intercept)
          )
        : displaySummary.points.map((p) => toDisplay(p.theilSenFit));

  const activeHoverIdx =
    hoverIndex !== null && hoverIndex >= 0 && hoverIndex < visiblePts.length
      ? hoverIndex
      : null;
  const hoverPt = activeHoverIdx !== null ? visiblePts[activeHoverIdx] : null;
  const hoverVal = activeHoverIdx !== null ? seriesValues[activeHoverIdx] : null;

  const minY = Math.min(
    effectiveMode === "anomaly" ? 0 : Infinity,
    ...seriesValues,
    ...trendValues
  );
  const maxY = Math.max(
    effectiveMode === "anomaly" ? 0 : -Infinity,
    ...seriesValues,
    ...trendValues
  );
  const span = Math.max(1e-6, maxY - minY);
  const xAt = (i: number) =>
    padX + (i / Math.max(1, visiblePts.length - 1)) * plotW;
  const yAt = (v: number) => padY + plotH - ((v - minY) / span) * plotH;

  const rawPath = seriesValues
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
    .join(" ");
  const trendPath = trendValues
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
    .join(" ");

  const dsMeta = DATASET_BY_ID[displaySummary.dataset];
  const lineColor =
    effectiveFocus === "b" ? "#38bdf8" : (dsMeta?.color ?? "#e2a856");
  const digest = describeTrendPlainly(displaySummary, tempUnit);
  const sa = displaySummary.seasonalAnalysis;
  const dispSeasonalSlope = sa ? toDisplayDelta(sa.seasonalTheilSenSlope) : null;

  return (
    <div className="ws-inset space-y-1.5 rounded-md p-2">
      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-text-subtle">
        <span className={hideTopicLabel && !hasOverlay ? "text-[10.5px] font-medium text-text-muted" : "font-medium text-text-primary"}>
          {hasOverlay ? `${effectiveFocus === "b" ? labelB : labelA} · ` : ""}
          {hideTopicLabel && !hasOverlay ? "Time series" : `${digest.topicLabel} · ${digest.parameterShort}`}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="ws-numeric">
            {hoverPt && hoverVal !== null
              ? `${formatTrendDate(hoverPt.date, "human", hoverPt.t)} · ${hoverVal.toFixed(2)} ${displayUnit}`
              : `${formatTrendDate(visiblePts[0]?.date ?? "", "human", visiblePts[0]?.t)}–${formatTrendDate(visiblePts[visiblePts.length - 1]?.date ?? "", "human", visiblePts[visiblePts.length - 1]?.t)}`}
          </span>
          {onOpenDetail && (
            <button
              type="button"
              onClick={() =>
                onOpenDetail({
                  mode: effectiveMode,
                  focus: effectiveFocus,
                  preset: effectiveSinglePreset,
                })
              }
              aria-label="Open trend graph in detail overlay"
              title="Open trend graph in detail overlay"
              className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-accent-fg hover:text-text-primary cursor-pointer"
            >
              <Maximize2 className="h-2.5 w-2.5" aria-hidden="true" />
              <span>Detail</span>
            </button>
          )}
        </div>
      </div>
      {focusSwitcher}
      {(hasAnomalyView || singlePresetOptions.length > 1) && (
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {hasAnomalyView && (
              <div className="flex items-center gap-1" role="group" aria-label="Time series display mode">
                <button
                  type="button"
                  aria-pressed={effectiveMode === "raw"}
                  onClick={() => setChartMode("raw")}
                  title="Raw Values"
                  className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                    effectiveMode === "raw"
                      ? "border-accent-fg bg-amber-950 text-amber-300"
                      : "border-border bg-surface text-text-muted hover:text-text-primary"
                  }`}
                >
                  Raw
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveMode === "anomaly"}
                  onClick={() => setChartMode("anomaly")}
                  title="Seasonal Cycle Removed"
                  className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                    effectiveMode === "anomaly"
                      ? "border-accent-fg bg-amber-950 text-amber-300"
                      : "border-border bg-surface text-text-muted hover:text-text-primary"
                  }`}
                >
                  Deseasonalized
                </button>
              </div>
            )}
            {singlePresetOptions.length > 1 && (
              <div className="flex items-center gap-0.5" role="group" aria-label="Compact date range">
                {singlePresetOptions.map((pr) => (
                  <button
                    key={pr}
                    type="button"
                    aria-pressed={effectiveSinglePreset === pr}
                    onClick={() => {
                      setQuickPreset(pr);
                      setHoverIndex(null);
                    }}
                    className={`rounded-xs border px-1.5 py-0.5 text-[9.5px] font-medium transition-colors cursor-pointer ${
                      effectiveSinglePreset === pr
                        ? "border-sky-400 bg-sky-950 text-sky-200"
                        : "border-border bg-surface text-text-subtle hover:text-text-primary"
                    }`}
                  >
                    {pr === "all" ? "All" : pr}
                  </button>
                ))}
              </div>
            )}
          </div>
          {hasAnomalyView && sa && dispSeasonalSlope !== null && (
            <span
              title="Seasonal Mann-Kendall p-value tests whether the direction holds across matching calendar seasons"
              className={`ws-numeric rounded-xs border px-1.5 py-0.5 font-mono text-[10px] ${
                sa.significant
                  ? sa.direction === "increasing"
                    ? "border-rose-400/50 bg-rose-950/60 font-medium text-rose-200"
                    : sa.direction === "decreasing"
                      ? "border-sky-400/50 bg-sky-950/60 font-medium text-sky-200"
                      : "border-border bg-surface text-text-muted"
                  : "border-border bg-surface text-text-muted"
              }`}
            >
              Seasonal p={sa.pValue < 0.0001 ? "<0.0001" : sa.pValue.toFixed(4)} ·{" "}
              {dispSeasonalSlope >= 0 ? "+" : ""}
              {dispSeasonalSlope.toFixed(3)} {displaySlopeUnit}
            </span>
          )}
        </div>
      )}
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className={`h-[94px] w-full ${onOpenDetail ? "cursor-pointer" : ""}`}
        aria-describedby={chartDescId}
        onPointerMove={(e) => {
          if (visiblePts.length <= 1) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverIndex(
            pointerClientXToIndex(
              e.clientX,
              rect.left,
              rect.width,
              w,
              padX,
              plotW,
              visiblePts.length
            )
          );
        }}
        onPointerLeave={() => setHoverIndex(null)}
        onClick={
          onOpenDetail
            ? () =>
                onOpenDetail({
                  mode: effectiveMode,
                  focus: effectiveFocus,
                  preset: effectiveSinglePreset,
                })
            : undefined
        }
      >
        {effectiveMode === "anomaly" && (
          <line
            x1={padX}
            y1={yAt(0)}
            x2={w - padX}
            y2={yAt(0)}
            stroke="var(--border-strong)"
            strokeDasharray="2 3"
          />
        )}
        <path d={rawPath} fill="none" stroke={lineColor} strokeWidth={usingMonthlyPoints ? 1.5 : 2} strokeLinecap="round" />
        <path
          d={trendPath}
          fill="none"
          stroke="var(--surface)"
          strokeOpacity={0.72}
          strokeWidth={3.2}
          strokeLinecap="round"
        />
        <path
          d={trendPath}
          fill="none"
          stroke="var(--text-primary)"
          strokeOpacity={0.95}
          strokeDasharray="4 4"
          strokeWidth={1.85}
        />
        {activeHoverIdx !== null && hoverVal !== null && (
          <g>
            <line
              x1={xAt(activeHoverIdx)}
              y1={padY}
              x2={xAt(activeHoverIdx)}
              y2={h - padY}
              stroke="var(--text-primary)"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
            <circle
              cx={xAt(activeHoverIdx)}
              cy={yAt(hoverVal)}
              r={3.2}
              fill="var(--surface)"
              stroke={lineColor}
              strokeWidth={1.8}
            />
          </g>
        )}
      </svg>
      <p id={chartDescId} className="sr-only">
        {digest.topicLabel} {effectiveMode === "anomaly" ? "deseasonalized anomaly" : usingMonthlyPoints ? "monthly raw" : "yearly"} values from {visiblePts[0]?.date} to {visiblePts[visiblePts.length - 1]?.date} showing{" "}
        {digest.headline}.
      </p>
      <div className="flex items-center justify-between text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ backgroundColor: lineColor }}
            aria-hidden="true"
          />
          <span>
            {effectiveMode === "anomaly"
              ? `Anomaly Δ (${displayUnit})`
              : usingMonthlyPoints
                ? `Monthly Raw (${displayUnit})`
                : `Observed (${displayUnit})`}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-3 border-t border-dashed border-text-primary"
            aria-hidden="true"
          />
          <span>{effectiveMode === "anomaly" ? "Seasonal MK trend" : "Long-term trend"}</span>
        </span>
      </div>
    </div>
  );
}
