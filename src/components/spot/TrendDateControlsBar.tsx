"use client";

import React, { useId, useState } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Pin,
  PinOff,
  RotateCcw,
} from "lucide-react";
import type { SingleDetailPoint } from "@/components/spot/trendChartDetailUtils";
import {
  computePinnedDateComparison,
  endBoundaryKey,
  formatTrendDate,
  parseTrendDateParts,
  resolvePresetDateRange,
  SEASON_FILTER_OPTIONS,
  startBoundaryKey,
  type TrendDateFormat,
  type TrendDatePreset,
  type TrendSeasonFilter,
} from "@/components/spot/trendDateUtils";

export interface DateSelectPoint {
  date: string;
  t: number;
  value: number;
}

function resolveBoundaryIndex(
  points: ReadonlyArray<DateSelectPoint>,
  targetDate: string | null,
  bound: "start" | "end"
): number {
  if (points.length === 0) return 0;
  if (!targetDate) return bound === "start" ? 0 : points.length - 1;
  const exact = points.findIndex((p) => p.date === targetDate);
  if (exact >= 0) return exact;
  if (bound === "start") {
    const key = startBoundaryKey(targetDate);
    const hit = points.findIndex((p) => parseTrendDateParts(p.date).sortKey >= key);
    return hit >= 0 ? hit : points.length - 1;
  }
  const key = endBoundaryKey(targetDate);
  for (let i = points.length - 1; i >= 0; i--) {
    if (parseTrendDateParts(points[i].date).sortKey <= key) return i;
  }
  return 0;
}

function fmtVal(val: number, decimals = 2): string {
  const clean = Math.abs(val) < Math.pow(10, -(decimals + 2)) ? 0 : val;
  return clean.toFixed(decimals);
}

function fmtSigned(val: number, decimals = 2): string {
  const clean = Math.abs(val) < Math.pow(10, -(decimals + 2)) ? 0 : val;
  return `${clean > 0 ? "+" : ""}${clean.toFixed(decimals)}`;
}

/**
 * Date customization toolbar for setting custom From/To windows, scientific presets,
 * calendar season/month slices, extended NASA archive spans, date display format,
 * dense gridlines, extreme callouts, single-step navigation, and date pinning.
 */
export function TrendDateControlsBar({
  availablePoints,
  activeStartDate,
  activeEndDate,
  isWindowed,
  onSelectWindow,
  onResetWindow,
  changePointDate,
  showSeasonFilter,
  seasonFilter,
  onChangeSeasonFilter,
  dateFormat,
  onChangeDateFormat,
  denseDates,
  onToggleDenseDates,
  showExtremeDates,
  onToggleExtremeDates,
  showPointControls,
  showExtremeToggle = showPointControls,
  activePointDate,
  activePointT,
  activePointIndex,
  activePointCount,
  onStepPoint,
  pinnedDates,
  onTogglePinActiveDate,
  onClearPins,
  archiveLoading = false,
  archiveError = null,
  activeArchiveRange,
  onFetchArchiveSpan,
}: {
  availablePoints: ReadonlyArray<DateSelectPoint>;
  activeStartDate: string | null;
  activeEndDate: string | null;
  isWindowed: boolean;
  onSelectWindow: (startDate: string | null, endDate: string | null) => void;
  onResetWindow: () => void;
  changePointDate?: string | null;
  showSeasonFilter: boolean;
  seasonFilter: TrendSeasonFilter;
  onChangeSeasonFilter: (filter: TrendSeasonFilter) => void;
  dateFormat: TrendDateFormat;
  onChangeDateFormat: (fmt: TrendDateFormat) => void;
  denseDates: boolean;
  onToggleDenseDates: () => void;
  showExtremeDates: boolean;
  onToggleExtremeDates: () => void;
  showPointControls: boolean;
  showExtremeToggle?: boolean;
  activePointDate: string | null;
  activePointT?: number;
  activePointIndex: number;
  activePointCount: number;
  onStepPoint: (delta: -1 | 1) => void;
  pinnedDates: readonly string[];
  onTogglePinActiveDate: () => void;
  onClearPins: () => void;
  archiveLoading?: boolean;
  archiveError?: string | null;
  activeArchiveRange?: { startYear: number; endYear: number } | null;
  onFetchArchiveSpan?: (startYear: number, endYear: number) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const seasonId = useId();
  const archiveStartId = useId();
  const archiveEndId = useId();

  const [customStartYr, setCustomStartYr] = useState<number>(
    activeArchiveRange?.startYear ?? 1981
  );
  const [customEndYr, setCustomEndYr] = useState<number>(
    activeArchiveRange?.endYear ?? 2025
  );

  const startIdx = resolveBoundaryIndex(availablePoints, activeStartDate, "start");
  const endIdx = Math.max(
    startIdx,
    resolveBoundaryIndex(availablePoints, activeEndDate, "end")
  );
  const effectiveStart = availablePoints[startIdx]?.date ?? "";
  const effectiveEnd = availablePoints[endIdx]?.date ?? "";

  const totalSpanYears =
    availablePoints.length >= 2
      ? availablePoints[availablePoints.length - 1].t - availablePoints[0].t
      : 0;

  const presets: Array<{ id: TrendDatePreset; label: string }> = [
    { id: "all", label: "All" },
    ...(totalSpanYears >= 22 ? [{ id: "20y" as const, label: "20y" }] : []),
    ...(totalSpanYears >= 12 ? [{ id: "10y" as const, label: "10y" }] : []),
    ...(totalSpanYears >= 7 ? [{ id: "5y" as const, label: "5y" }] : []),
    ...(changePointDate
      ? [
          { id: "pre_shift" as const, label: "Pre-Shift" },
          { id: "post_shift" as const, label: "Post-Shift" },
        ]
      : []),
  ];

  const minSpan = Math.min(2, Math.max(0, availablePoints.length - 1));

  const handleStartChange = (nextStart: string) => {
    const nextStartIdx = availablePoints.findIndex((p) => p.date === nextStart);
    if (nextStartIdx < 0) return;
    const clampedStartIdx = Math.min(
      nextStartIdx,
      Math.max(0, availablePoints.length - 1 - minSpan)
    );
    const nextEndIdx = Math.max(
      endIdx,
      Math.min(availablePoints.length - 1, clampedStartIdx + minSpan)
    );
    if (clampedStartIdx === 0 && nextEndIdx === availablePoints.length - 1) {
      onSelectWindow(null, null);
      return;
    }
    onSelectWindow(
      availablePoints[clampedStartIdx].date,
      availablePoints[nextEndIdx].date
    );
  };

  const handleEndChange = (nextEnd: string) => {
    const nextEndIdx = availablePoints.findIndex((p) => p.date === nextEnd);
    if (nextEndIdx < 0) return;
    const clampedEndIdx = Math.max(
      nextEndIdx,
      Math.min(availablePoints.length - 1, minSpan)
    );
    const nextStartIdx = Math.min(startIdx, Math.max(0, clampedEndIdx - minSpan));
    if (nextStartIdx === 0 && clampedEndIdx === availablePoints.length - 1) {
      onSelectWindow(null, null);
      return;
    }
    onSelectWindow(
      availablePoints[nextStartIdx].date,
      availablePoints[clampedEndIdx].date
    );
  };

  const applyPreset = (preset: TrendDatePreset) => {
    if (preset === "all") {
      onResetWindow();
      return;
    }
    const range = resolvePresetDateRange(availablePoints, preset, changePointDate);
    if (!range) return;
    onSelectWindow(range.startDate, range.endDate);
  };

  const isPinnedActive = Boolean(
    activePointDate && pinnedDates.includes(activePointDate)
  );

  const archiveYearsStart = Array.from({ length: 40 }, (_, i) => 1981 + i);
  const archiveYearsEnd = Array.from({ length: 42 }, (_, i) => 1985 + i);

  return (
    <div className="ws-inset space-y-2 rounded-md p-2.5 text-[11px]">
      {/* Row 1: Exact From / To Date Selectors + Scientific Presets + Reset */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
            <Calendar className="h-3.5 w-3.5 text-accent-fg" aria-hidden="true" />
            <span>Date Window</span>
          </span>

          {availablePoints.length >= 2 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <label htmlFor={fromId} className="text-[10.5px] text-text-subtle">
                From
              </label>
              <select
                id={fromId}
                aria-label="Start date"
                value={effectiveStart}
                onChange={(e) => handleStartChange(e.target.value)}
                className="ws-numeric rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text-primary cursor-pointer"
              >
                {availablePoints.map((pt) => (
                  <option key={`from-${pt.date}`} value={pt.date}>
                    {formatTrendDate(pt.date, dateFormat, pt.t)}
                  </option>
                ))}
              </select>

              <label htmlFor={toId} className="text-[10.5px] text-text-subtle">
                To
              </label>
              <select
                id={toId}
                aria-label="End date"
                value={effectiveEnd}
                onChange={(e) => handleEndChange(e.target.value)}
                className="ws-numeric rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text-primary cursor-pointer"
              >
                {availablePoints.map((pt) => (
                  <option key={`to-${pt.date}`} value={pt.date}>
                    {formatTrendDate(pt.date, dateFormat, pt.t)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Date window presets"
        >
          {presets.map((p) => {
            const range =
              p.id === "all"
                ? null
                : resolvePresetDateRange(availablePoints, p.id, changePointDate);
            const active =
              p.id === "all"
                ? !isWindowed
                : Boolean(
                    isWindowed &&
                      range &&
                      activeStartDate === range.startDate &&
                      activeEndDate === range.endDate
                  );
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                onClick={() => applyPreset(p.id)}
                className={`rounded-xs border px-2 py-0.5 text-[10.5px] font-medium transition-colors cursor-pointer ${
                  active
                    ? "border-accent-fg bg-amber-950/70 text-amber-200"
                    : "border-border bg-surface text-text-muted hover:text-text-primary"
                }`}
              >
                {p.label}
              </button>
            );
          })}

          {isWindowed && (
            <button
              type="button"
              onClick={onResetWindow}
              title="Reset custom date window and season filter"
              className="inline-flex items-center gap-1 rounded-xs border border-border-strong bg-surface-elevated px-2 py-0.5 text-[10.5px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* Row 2: Season/Month Filter, Date Display Format, Dense/Peak Toggles, Date Stepper & Pin */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2">
        <div className="flex flex-wrap items-center gap-2">
          {showSeasonFilter && (
            <div className="flex items-center gap-1">
              <label htmlFor={seasonId} className="text-[10.5px] text-text-subtle">
                Season
              </label>
              <select
                id={seasonId}
                aria-label="Filter by season or calendar month"
                value={seasonFilter}
                onChange={(e) =>
                  onChangeSeasonFilter(e.target.value as TrendSeasonFilter)
                }
                className="rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text-primary cursor-pointer"
              >
                {SEASON_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div
            className="inline-flex items-center gap-0.5 rounded-sm border border-border bg-surface p-0.5"
            role="group"
            aria-label="Date display format"
          >
            {(
              [
                { id: "human", label: "Human" },
                { id: "iso", label: "ISO" },
                { id: "decimal", label: "Decimal" },
              ] as const
            ).map((fmt) => (
              <button
                key={fmt.id}
                type="button"
                aria-pressed={dateFormat === fmt.id}
                onClick={() => onChangeDateFormat(fmt.id)}
                className={`rounded-xs px-1.5 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                  dateFormat === fmt.id
                    ? "bg-surface-elevated text-text-primary"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                {fmt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            aria-pressed={denseDates}
            onClick={onToggleDenseDates}
            className={`rounded-xs border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
              denseDates
                ? "border-sky-400 bg-sky-950/70 text-sky-200"
                : "border-border bg-surface text-text-muted hover:text-text-primary"
            }`}
          >
            Dense Dates
          </button>

          {showExtremeToggle && (
            <button
              type="button"
              aria-pressed={showExtremeDates}
              onClick={onToggleExtremeDates}
              className={`rounded-xs border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                showExtremeDates
                  ? "border-emerald-400 bg-emerald-950/70 text-emerald-200"
                  : "border-border bg-surface text-text-muted hover:text-text-primary"
              }`}
            >
              Peak / Low
            </button>
          )}
        </div>

        {/* Stepper & Date Pin Controls */}
        {showPointControls && activePointDate && (
          <div className="flex flex-wrap items-center gap-1.5">
            <div
              className="inline-flex items-center rounded-sm border border-border bg-surface"
              role="group"
              aria-label="Step observation date"
            >
              <button
                type="button"
                disabled={activePointIndex <= 0}
                onClick={() => onStepPoint(-1)}
                aria-label="Previous date"
                className="inline-flex h-6 w-6 items-center justify-center text-text-muted hover:bg-surface-elevated hover:text-text-primary disabled:opacity-40 cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span className="ws-numeric border-x border-border px-2 font-mono text-[10.5px] font-medium text-text-primary">
                {formatTrendDate(activePointDate, dateFormat, activePointT)}
              </span>
              <button
                type="button"
                disabled={activePointIndex >= activePointCount - 1}
                onClick={() => onStepPoint(1)}
                aria-label="Next date"
                className="inline-flex h-6 w-6 items-center justify-center text-text-muted hover:bg-surface-elevated hover:text-text-primary disabled:opacity-40 cursor-pointer"
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <button
              type="button"
              onClick={onTogglePinActiveDate}
              aria-pressed={isPinnedActive}
              title="Pin this date on the chart (pin 2 dates to compare Δ)"
              className={`inline-flex items-center gap-1 rounded-xs border px-2 py-0.5 text-[10.5px] font-medium transition-colors cursor-pointer ${
                isPinnedActive
                  ? "border-amber-400 bg-amber-950 text-amber-200"
                  : "border-border bg-surface text-text-muted hover:text-text-primary"
              }`}
            >
              <Pin className="h-3 w-3" aria-hidden="true" />
              <span>{isPinnedActive ? "Pinned" : "Pin Date"}</span>
            </button>

            {pinnedDates.length > 0 && (
              <button
                type="button"
                onClick={onClearPins}
                aria-label="Clear pinned dates"
                className="inline-flex items-center gap-1 rounded-xs border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle hover:text-text-primary cursor-pointer"
              >
                <PinOff className="h-3 w-3" aria-hidden="true" />
                <span>Clear ({pinnedDates.length})</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Row 3: Optional Extended NASA Historical Archive Fetch (1981-2025) */}
      {onFetchArchiveSpan && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-text-subtle">
            <span className="font-medium text-text-muted">Archive Span:</span>
            <button
              type="button"
              disabled={archiveLoading}
              onClick={() => {
                setCustomStartYr(1981);
                setCustomEndYr(2025);
                onFetchArchiveSpan(1981, 2025);
              }}
              className={`rounded-xs border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                activeArchiveRange?.startYear === 1981 &&
                activeArchiveRange?.endYear === 2025
                  ? "border-sky-400 bg-sky-950 text-sky-200"
                  : "border-border bg-surface text-text-muted hover:text-text-primary"
              }`}
            >
              1981–2025 (45y Full MERRA-2)
            </button>
            <button
              type="button"
              disabled={archiveLoading}
              onClick={() => {
                setCustomStartYr(1995);
                setCustomEndYr(2025);
                onFetchArchiveSpan(1995, 2025);
              }}
              className={`rounded-xs border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                !activeArchiveRange ||
                (activeArchiveRange.startYear === 1995 &&
                  activeArchiveRange.endYear === 2025)
                  ? "border-accent-fg bg-amber-950/60 text-amber-200"
                  : "border-border bg-surface text-text-muted hover:text-text-primary"
              }`}
            >
              1995–2025 (Default)
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={archiveStartId} className="sr-only">
              Archive start year
            </label>
            <select
              id={archiveStartId}
              aria-label="Archive start year"
              value={customStartYr}
              onChange={(e) => {
                const yr = Number(e.target.value);
                setCustomStartYr(yr);
                if (customEndYr < yr + 4) setCustomEndYr(Math.min(2026, yr + 4));
              }}
              className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-primary"
            >
              {archiveYearsStart.map((yr) => (
                <option key={yr} value={yr}>
                  {yr}
                </option>
              ))}
            </select>
            <span className="text-text-subtle">–</span>
            <label htmlFor={archiveEndId} className="sr-only">
              Archive end year
            </label>
            <select
              id={archiveEndId}
              aria-label="Archive end year"
              value={customEndYr}
              onChange={(e) => {
                const yr = Number(e.target.value);
                setCustomEndYr(yr);
                if (customStartYr > yr - 4) setCustomStartYr(Math.max(1981, yr - 4));
              }}
              className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-primary"
            >
              {archiveYearsEnd.map((yr) => (
                <option key={yr} value={yr}>
                  {yr}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={archiveLoading}
              onClick={() => onFetchArchiveSpan(customStartYr, customEndYr)}
              className="rounded-xs border border-border-strong bg-surface-elevated px-2 py-0.5 text-[10.5px] font-semibold text-text-primary hover:border-accent-fg disabled:opacity-50 cursor-pointer"
            >
              {archiveLoading ? "Loading…" : "Load"}
            </button>
          </div>
        </div>
      )}

      {archiveError && (
        <div role="alert" className="text-[10.5px] text-rose-300">
          {archiveError}
        </div>
      )}
    </div>
  );
}

/**
 * Full-record mini timeline navigator showing the entire series sparkline, shaded curtain
 * outside the custom window, adjustable start/end bounds, and sliding window pan controls.
 */
export function TrendRangeNavigatorStrip({
  points,
  startDate,
  endDate,
  dateFormat,
  lineColor,
  onSelectWindow,
}: {
  points: ReadonlyArray<DateSelectPoint>;
  startDate: string | null;
  endDate: string | null;
  dateFormat: TrendDateFormat;
  lineColor: string;
  onSelectWindow: (startDate: string | null, endDate: string | null) => void;
}) {
  if (points.length < 4) return null;

  const firstIdx = 0;
  const lastIdx = points.length - 1;
  const minWindowCount = Math.min(3, points.length);

  const startIdx = resolveBoundaryIndex(points, startDate, "start");
  const endIdx = Math.max(startIdx, resolveBoundaryIndex(points, endDate, "end"));

  const w = 780;
  const h = 34;
  const padX = 4;
  const padY = 4;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;

  const minV = Math.min(...points.map((p) => p.value));
  const maxV = Math.max(...points.map((p) => p.value));
  const span = Math.max(1e-6, maxV - minV);

  const xAt = (idx: number) => padX + (idx / Math.max(1, lastIdx)) * innerW;
  const yAt = (val: number) => padY + innerH - ((val - minV) / span) * innerH;

  const sparkPath = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.value).toFixed(1)}`
    )
    .join(" ");

  const selLeft = xAt(startIdx);
  const selRight = xAt(endIdx);
  const isZoomed = startIdx > 0 || endIdx < lastIdx;
  const windowStepWidth = Math.max(1, endIdx - startIdx);

  const handleStartSlider = (nextStart: number) => {
    const clamped = Math.max(
      0,
      Math.min(nextStart, Math.max(0, endIdx - (minWindowCount - 1)))
    );
    if (clamped === 0 && endIdx === lastIdx) {
      onSelectWindow(null, null);
      return;
    }
    onSelectWindow(points[clamped].date, points[endIdx].date);
  };

  const handleEndSlider = (nextEnd: number) => {
    const clamped = Math.min(
      lastIdx,
      Math.max(nextEnd, Math.min(lastIdx, startIdx + (minWindowCount - 1)))
    );
    if (startIdx === 0 && clamped === lastIdx) {
      onSelectWindow(null, null);
      return;
    }
    onSelectWindow(points[startIdx].date, points[clamped].date);
  };

  const panWindow = (dir: -1 | 1) => {
    const step = Math.max(1, Math.round(windowStepWidth * 0.35)) * dir;
    let nextStart = startIdx + step;
    let nextEnd = endIdx + step;
    if (nextStart < 0) {
      nextEnd -= nextStart;
      nextStart = 0;
    }
    if (nextEnd > lastIdx) {
      nextStart -= nextEnd - lastIdx;
      nextEnd = lastIdx;
    }
    nextStart = Math.max(0, nextStart);
    nextEnd = Math.min(lastIdx, nextEnd);
    onSelectWindow(points[nextStart].date, points[nextEnd].date);
  };

  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-text-subtle">
        <span className="ws-numeric font-mono">
          Range Navigator:{" "}
          <strong className="text-text-primary">
            {formatTrendDate(points[startIdx].date, dateFormat, points[startIdx].t)}
          </strong>{" "}
          –{" "}
          <strong className="text-text-primary">
            {formatTrendDate(points[endIdx].date, dateFormat, points[endIdx].t)}
          </strong>{" "}
          ({endIdx - startIdx + 1} / {points.length} pts)
        </span>
        <div className="flex items-center gap-1">
          {isZoomed && (
            <>
              <button
                type="button"
                disabled={startIdx <= 0}
                onClick={() => panWindow(-1)}
                className="rounded-xs border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary disabled:opacity-40 cursor-pointer"
              >
                ◀ Window
              </button>
              <button
                type="button"
                disabled={endIdx >= lastIdx}
                onClick={() => panWindow(1)}
                className="rounded-xs border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary disabled:opacity-40 cursor-pointer"
              >
                Window ▶
              </button>
            </>
          )}
          <span className="hidden sm:inline text-text-faint">
            Drag chart above to zoom or click to pin dates
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-9 w-full rounded-xs border border-border-subtle bg-surface"
        aria-hidden="true"
      >
        <path
          d={sparkPath}
          fill="none"
          stroke={lineColor}
          strokeOpacity={0.55}
          strokeWidth={1.3}
        />
        {startIdx > 0 && (
          <rect
            x={0}
            y={0}
            width={Math.max(0, selLeft)}
            height={h}
            fill="var(--bg)"
            fillOpacity={0.62}
          />
        )}
        {endIdx < lastIdx && (
          <rect
            x={selRight}
            y={0}
            width={Math.max(0, w - selRight)}
            height={h}
            fill="var(--bg)"
            fillOpacity={0.62}
          />
        )}
        <rect
          x={selLeft}
          y={1}
          width={Math.max(4, selRight - selLeft)}
          height={h - 2}
          fill="none"
          stroke="var(--accent-fg)"
          strokeWidth={1.4}
        />
      </svg>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-[10px] text-text-subtle">
          <span className="shrink-0">Start</span>
          <input
            type="range"
            aria-label="Custom window start index"
            className="etg-slider"
            min={0}
            max={lastIdx}
            step={1}
            value={startIdx}
            style={
              {
                "--control-value": startIdx,
                "--slider-progress": `${((startIdx / Math.max(1, lastIdx)) * 100).toFixed(1)}%`,
              } as React.CSSProperties
            }
            onChange={(e) => handleStartSlider(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-2 text-[10px] text-text-subtle">
          <span className="shrink-0">End</span>
          <input
            type="range"
            aria-label="Custom window end index"
            className="etg-slider"
            min={0}
            max={lastIdx}
            step={1}
            value={endIdx}
            style={
              {
                "--control-value": endIdx,
                "--slider-progress": `${((endIdx / Math.max(1, lastIdx)) * 100).toFixed(1)}%`,
              } as React.CSSProperties
            }
            onChange={(e) => handleEndSlider(Number(e.target.value))}
          />
        </label>
      </div>
    </div>
  );
}

/**
 * Displays single-date pin details or two-date delta comparison (elapsed time, value Δ,
 * anomaly Δ, Z-score Δ, and decadal rate equivalent).
 */
export function PinnedDateComparisonBanner({
  pinnedPoints,
  unit,
  slopeUnit,
  dateFormat,
  onClearPins,
}: {
  pinnedPoints: readonly SingleDetailPoint[];
  unit: string;
  slopeUnit: string;
  dateFormat: TrendDateFormat;
  onClearPins: () => void;
}) {
  if (pinnedPoints.length === 0) return null;

  if (pinnedPoints.length === 1) {
    const p = pinnedPoints[0];
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-amber-400/50 bg-amber-950/35 px-2.5 py-1.5 text-[11px] text-amber-100">
        <div className="ws-numeric flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono">
          <span className="font-semibold text-amber-300">
            Pin A: {formatTrendDate(p.date, dateFormat, p.t)}
          </span>
          <span>
            {fmtVal(p.value, 2)} {unit}
          </span>
          <span className="text-amber-200/85">
            (Anom {fmtSigned(p.anomaly, 2)}, Z = {fmtSigned(p.zScore, 2)}σ)
          </span>
          <span className="font-sans text-[10.5px] text-amber-200/80">
            Click another point on the chart (or step &amp; click Pin Date) to measure change.
          </span>
        </div>
        <button
          type="button"
          onClick={onClearPins}
          className="shrink-0 font-medium text-amber-300 hover:underline cursor-pointer"
        >
          Clear
        </button>
      </div>
    );
  }

  const cmp = computePinnedDateComparison(pinnedPoints[0], pinnedPoints[1]);
  const decUnit = slopeUnit.replace("/yr", "/dec");

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-amber-400/60 bg-amber-950/40 px-2.5 py-1.5 text-[11px] text-amber-100">
      <div className="ws-numeric flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
        <span className="font-semibold text-amber-300">
          {formatTrendDate(cmp.earlier.date, dateFormat, cmp.earlier.t)} →{" "}
          {formatTrendDate(cmp.later.date, dateFormat, cmp.later.t)}
        </span>
        <span className="text-text-muted">({cmp.elapsedYears.toFixed(1)} yrs)</span>
        <span>
          Δ{" "}
          <strong className="text-text-primary">
            {fmtSigned(cmp.valueDelta, 2)} {unit}
          </strong>
          {cmp.pctChange !== null ? ` (${fmtSigned(cmp.pctChange, 1)}%)` : ""}
        </span>
        {cmp.decadeRateEquivalent !== null && (
          <span className="text-sky-300">
            Rate {fmtSigned(cmp.decadeRateEquivalent, 2)} {decUnit}
          </span>
        )}
        <span className="text-amber-200/85">
          Δ Anom {fmtSigned(cmp.anomalyDelta, 2)} · ΔZ {fmtSigned(cmp.zDelta, 2)}σ
        </span>
      </div>
      <button
        type="button"
        onClick={onClearPins}
        className="shrink-0 font-medium text-amber-300 hover:underline cursor-pointer"
      >
        Clear Pins
      </button>
    </div>
  );
}

/**
 * Displays single-date or two-date chronological Δz and raw value shifts in comparison mode.
 */
export function ComparisonPinnedDateBanner({
  pinnedPoints,
  labelA,
  labelB,
  unitA,
  unitB,
  dateFormat,
  onRemovePin,
  onClearPins,
}: {
  pinnedPoints: ReadonlyArray<{
    date: string;
    t: number;
    zA: number;
    zB: number;
    rawA: number;
    rawB: number;
  }>;
  labelA: string;
  labelB: string;
  unitA: string;
  unitB: string;
  dateFormat: TrendDateFormat;
  onRemovePin: (date: string) => void;
  onClearPins: () => void;
}) {
  if (pinnedPoints.length === 0) return null;

  const fmtUnit = (u: string) => (u && u !== "value" ? ` ${u}` : "");

  if (pinnedPoints.length === 1) {
    const p = pinnedPoints[0];
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-amber-400/50 bg-amber-950/35 px-2.5 py-1.5 text-[11px] text-amber-100">
        <div className="ws-numeric flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono">
          <span className="font-semibold text-amber-300">
            Pin A: {formatTrendDate(p.date, dateFormat, p.t)}
          </span>
          <span className="text-amber-200">
            {labelA}: {fmtSigned(p.zA, 2)}σ ({fmtVal(p.rawA, 2)}
            {fmtUnit(unitA)})
          </span>
          <span className="text-sky-200">
            {labelB}: {fmtSigned(p.zB, 2)}σ ({fmtVal(p.rawB, 2)}
            {fmtUnit(unitB)})
          </span>
          <span className="font-sans text-[10.5px] text-amber-200/80">
            Click or pin a 2nd date on the comparison chart to measure Δz &amp; raw shifts
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onRemovePin(p.date)}
            className="font-medium text-amber-300 hover:underline cursor-pointer"
          >
            Unpin
          </button>
          <button
            type="button"
            onClick={onClearPins}
            className="font-medium text-amber-300 hover:underline cursor-pointer"
          >
            Clear
          </button>
        </div>
      </div>
    );
  }

  const p0 = pinnedPoints[0];
  const p1 = pinnedPoints[1];
  const p0First =
    p0.t !== p1.t
      ? p0.t <= p1.t
      : parseTrendDateParts(p0.date).sortKey <= parseTrendDateParts(p1.date).sortKey;
  const earlier = p0First ? p0 : p1;
  const later = p0First ? p1 : p0;
  const elapsedYears = Math.max(0, later.t - earlier.t);
  const dzA = later.zA - earlier.zA;
  const dzB = later.zB - earlier.zB;
  const dRawA = later.rawA - earlier.rawA;
  const dRawB = later.rawB - earlier.rawB;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-amber-400/60 bg-amber-950/40 px-2.5 py-1.5 text-[11px] text-amber-100">
      <div className="ws-numeric flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
        <span className="font-semibold text-amber-300">
          {formatTrendDate(earlier.date, dateFormat, earlier.t)} →{" "}
          {formatTrendDate(later.date, dateFormat, later.t)}
        </span>
        <span className="text-text-muted">({elapsedYears.toFixed(1)} yrs)</span>
        <span className="text-amber-200">
          {labelA}: Δz {fmtSigned(dzA, 2)}σ · Δ {fmtSigned(dRawA, 2)}
          {fmtUnit(unitA)}
        </span>
        <span className="text-sky-200">
          {labelB}: Δz {fmtSigned(dzB, 2)}σ · Δ {fmtSigned(dRawB, 2)}
          {fmtUnit(unitB)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onRemovePin(earlier.date)}
          className="font-medium text-amber-200 hover:underline cursor-pointer"
        >
          Unpin {formatTrendDate(earlier.date, dateFormat, earlier.t)}
        </button>
        <button
          type="button"
          onClick={() => onRemovePin(later.date)}
          className="font-medium text-amber-200 hover:underline cursor-pointer"
        >
          Unpin {formatTrendDate(later.date, dateFormat, later.t)}
        </button>
        <button
          type="button"
          onClick={onClearPins}
          className="font-medium text-amber-300 hover:underline cursor-pointer"
        >
          Clear Pins
        </button>
      </div>
    </div>
  );
}
