"use client";

import { useId, useState } from "react";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  convertSlopeUnitLabel,
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
}: {
  summary: TrendAnalysisSummary | null;
  secondarySummary?: TrendAnalysisSummary | null;
  comparison: CrossRegionComparison | null;
  labelA: string;
  labelB: string;
  tempUnit: TemperatureUnit;
}) {
  const chartDescId = useId();
  const [chartMode, setChartMode] = useState<"raw" | "anomaly">("raw");
  const [seriesFocus, setSeriesFocus] = useState<"both" | "a" | "b">("both");
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

    const pts: Array<{ date: string; zA: number; zB: number }> = (() => {
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
      <div className="ws-inset space-y-2 rounded-md p-3">
        <div className="flex items-center justify-between text-[11px] text-text-subtle">
          <span className="font-medium text-text-primary">How the two spots move over time</span>
          <span className="ws-numeric">
            {pts[0]?.date}–{pts[pts.length - 1]?.date}
          </span>
        </div>
        {focusSwitcher}
        {canCompareDeseasonalized && (
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1" role="group" aria-label="Time series display mode">
              <button
                type="button"
                aria-pressed={effectiveCompareMode === "raw"}
                onClick={() => setChartMode("raw")}
                className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                  effectiveCompareMode === "raw"
                    ? "border-accent-fg bg-amber-950 text-amber-300"
                    : "border-border bg-surface text-text-muted hover:text-text-primary"
                }`}
              >
                Raw Values
              </button>
              <button
                type="button"
                aria-pressed={effectiveCompareMode === "anomaly"}
                onClick={() => setChartMode("anomaly")}
                className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                  effectiveCompareMode === "anomaly"
                    ? "border-accent-fg bg-amber-950 text-amber-300"
                    : "border-border bg-surface text-text-muted hover:text-text-primary"
                }`}
              >
                Seasonal Cycle Removed
              </button>
            </div>
            {(saA || saB) && (
              <span className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                {saA ? `A p_s=${saA.pValue < 0.0001 ? "<0.0001" : saA.pValue.toFixed(4)}` : ""}
                {saA && saB ? " · " : ""}
                {saB ? `B p_s=${saB.pValue < 0.0001 ? "<0.0001" : saB.pValue.toFixed(4)}` : ""}
              </span>
            )}
          </div>
        )}
        <svg viewBox={`0 0 ${w} ${h}`} className="h-[118px] w-full" aria-describedby={chartDescId}>
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
            <span className="font-mono text-[10px] text-text-subtle">
              Select A or B for Seasonal MK (p_s)
            </span>
          )}
        </div>
      </div>
    );
  }

  const activeChartSummary =
    effectiveFocus === "b" && secondarySummary ? secondarySummary : summary;

  if (!activeChartSummary || activeChartSummary.points.length < 2) return null;

  const usingMonthlyPoints = Boolean(
    activeChartSummary.seasonalPoints && activeChartSummary.seasonalPoints.length >= 18
  );
  const rawOrMonthlyPts = usingMonthlyPoints
    ? activeChartSummary.seasonalPoints!
    : activeChartSummary.points;
  const hasAnomalyView = Boolean(
    activeChartSummary.seasonalAnalysis &&
      (usingMonthlyPoints ||
        activeChartSummary.points.some((p) => typeof p.anomalyValue === "number"))
  );
  const effectiveMode = hasAnomalyView && chartMode === "anomaly" ? "anomaly" : "raw";

  const hasTempUnit = isTemperatureUnitString(activeChartSummary.unit);
  const toDisplay = (v: number) =>
    hasTempUnit ? convertTemperatureDisplayValue(v, activeChartSummary.unit, tempUnit) : v;
  const toDisplayDelta = (v: number) =>
    hasTempUnit && tempUnit === "F" && !/(?:°\s*f|deg\s*f|fahrenheit)/i.test(activeChartSummary.unit)
      ? v * 1.8
      : v;
  const displayUnit = hasTempUnit
    ? convertTemperatureUnitLabel(activeChartSummary.unit, tempUnit)
    : activeChartSummary.unit;
  const displaySlopeUnit = hasTempUnit
    ? convertSlopeUnitLabel(activeChartSummary.slopeUnit, tempUnit)
    : activeChartSummary.slopeUnit;

  const seriesValues = rawOrMonthlyPts.map((p) =>
    effectiveMode === "anomaly" ? toDisplayDelta(p.anomalyValue ?? 0) : toDisplay(p.value)
  );
  const trendValues =
    effectiveMode === "anomaly" && activeChartSummary.seasonalAnalysis
      ? (() => {
          const sa = activeChartSummary.seasonalAnalysis;
          const midT = (rawOrMonthlyPts[0].t + rawOrMonthlyPts[rawOrMonthlyPts.length - 1].t) / 2;
          const meanAnom = seriesValues.reduce((s, v) => s + v, 0) / seriesValues.length;
          return rawOrMonthlyPts.map(
            (p) => meanAnom + toDisplayDelta(sa.seasonalTheilSenSlope * (p.t - midT))
          );
        })()
      : usingMonthlyPoints
        ? rawOrMonthlyPts.map((p) =>
            toDisplay(activeChartSummary.theilSen.slope * p.t + activeChartSummary.theilSen.intercept)
          )
        : activeChartSummary.points.map((p) => toDisplay(p.theilSenFit));

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
    padX + (i / Math.max(1, rawOrMonthlyPts.length - 1)) * plotW;
  const yAt = (v: number) => padY + plotH - ((v - minY) / span) * plotH;

  const rawPath = seriesValues
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
    .join(" ");
  const trendPath = trendValues
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
    .join(" ");

  const dsMeta = DATASET_BY_ID[activeChartSummary.dataset];
  const lineColor =
    effectiveFocus === "b" ? "#38bdf8" : (dsMeta?.color ?? "#e2a856");
  const digest = describeTrendPlainly(activeChartSummary, tempUnit);
  const sa = activeChartSummary.seasonalAnalysis;
  const dispSeasonalSlope = sa ? toDisplayDelta(sa.seasonalTheilSenSlope) : null;

  return (
    <div className="ws-inset space-y-2 rounded-md p-3">
      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-text-subtle">
        <span className="font-medium text-text-primary">
          {hasOverlay ? `${effectiveFocus === "b" ? labelB : labelA} · ` : ""}
          {digest.topicLabel} · {digest.parameterShort}
        </span>
        <span className="ws-numeric">
          {rawOrMonthlyPts[0]?.date}–{rawOrMonthlyPts[rawOrMonthlyPts.length - 1]?.date}
        </span>
      </div>
      {focusSwitcher}
      {hasAnomalyView && (
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-1" role="group" aria-label="Time series display mode">
            <button
              type="button"
              aria-pressed={effectiveMode === "raw"}
              onClick={() => setChartMode("raw")}
              className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                effectiveMode === "raw"
                  ? "border-accent-fg bg-amber-950 text-amber-300"
                  : "border-border bg-surface text-text-muted hover:text-text-primary"
              }`}
            >
              Raw Values
            </button>
            <button
              type="button"
              aria-pressed={effectiveMode === "anomaly"}
              onClick={() => setChartMode("anomaly")}
              className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                effectiveMode === "anomaly"
                  ? "border-accent-fg bg-amber-950 text-amber-300"
                  : "border-border bg-surface text-text-muted hover:text-text-primary"
              }`}
            >
              Seasonal Cycle Removed
            </button>
          </div>
          {sa && dispSeasonalSlope !== null && (
            <span className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
              p_s={sa.pValue < 0.0001 ? "< 0.0001" : sa.pValue.toFixed(4)} ·{" "}
              {dispSeasonalSlope >= 0 ? "+" : ""}
              {dispSeasonalSlope.toFixed(3)} {displaySlopeUnit}
            </span>
          )}
        </div>
      )}
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[118px] w-full" aria-describedby={chartDescId}>
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
          stroke="var(--text-primary)"
          strokeOpacity={0.78}
          strokeDasharray="4 4"
          strokeWidth={1.6}
        />
      </svg>
      <p id={chartDescId} className="sr-only">
        {digest.topicLabel} {effectiveMode === "anomaly" ? "deseasonalized anomaly" : usingMonthlyPoints ? "monthly raw" : "yearly"} values from {rawOrMonthlyPts[0]?.date} to {rawOrMonthlyPts[rawOrMonthlyPts.length - 1]?.date} showing{" "}
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
