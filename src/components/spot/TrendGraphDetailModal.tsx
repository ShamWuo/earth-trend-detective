"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  GitBranch,
  PlusCircle,
  Search,
  X,
} from "lucide-react";
import { attachDialogLightDismissFallback } from "@/lib/a11y/dialogLightDismiss";
import { restoreOpenerFocus, trapDialogTabKey } from "@/lib/a11y/dialogFocusTrap";
import { buildExternalExplorerLinks, DATASET_BY_ID } from "@/lib/datasets";
import { isTemperatureUnitString } from "@/lib/earth/currentConditionsClient";
import {
  describeComparisonPlainly,
  describeTrendPlainly,
  formatCoordShort,
} from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  ETGDatasetId,
  ETGNode,
  TemperatureUnit,
  TrendAnalysisSummary,
} from "@/types/etg";
import {
  resolveTemperatureSlopeScale,
  summaryKey,
} from "@/components/spot/spotCardShared";
import { MiniSparkline } from "@/components/spot/SpotTrendChart";
import {
  buildTrendOverlayItems,
  type CompareChartMode,
  computeNiceTicks,
  formatDetailSeriesCsv,
  getOverlayItemTabMeta,
  pickXAxisTickIndices,
  pointerClientXToIndex,
  prepareComparisonDetailSeries,
  prepareSingleDetailSeries,
  type TrendOverlayItem,
} from "@/components/spot/trendChartDetailUtils";
import {
  ComparisonPinnedDateBanner,
  PinnedDateComparisonBanner,
  TrendDateControlsBar,
  TrendRangeNavigatorStrip,
} from "@/components/spot/TrendDateControlsBar";
import {
  buildWindowedComparison,
  buildWindowedTrendSummary,
  findSeriesExtremes,
  formatTrendDate,
  parseTrendDateParts,
  resolvePresetDateRange,
  type TrendDateFormat,
  type TrendDatePreset,
  type TrendSeasonFilter,
} from "@/components/spot/trendDateUtils";

const SVG_W = 840;
const SVG_H = 310;
const PAD_LEFT = 62;
const PAD_RIGHT = 24;
const PAD_TOP = 24;
const PAD_BOTTOM = 38;
const PLOT_W = SVG_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = SVG_H - PAD_TOP - PAD_BOTTOM;

function archiveSummaryKey(s: TrendAnalysisSummary): string {
  return `${s.lat.toFixed(3)}:${s.lng.toFixed(3)}:${summaryKey(s)}`;
}

export interface TrendGraphDetailModalProps {
  open: boolean;
  onClose: () => void;
  cardTitle: string;
  coord: { lat: number; lng: number } | null;
  summaries: readonly TrendAnalysisSummary[];
  allSpotSummaries?: readonly TrendAnalysisSummary[];
  primary: TrendAnalysisSummary | null;
  secondary?: TrendAnalysisSummary | null;
  comparison?: CrossRegionComparison | null;
  labelA: string;
  labelB: string;
  initialItemId?: string | null;
  initialMode?: "raw" | "anomaly";
  initialPreset?: TrendDatePreset | null;
  tempUnit: TemperatureUnit;
  onChangeTempUnit?: (unit: TemperatureUnit) => void;
  onSelectSummary?: (key: string, dataset: ETGDatasetId) => void;
  onSaveToGraph?: (summary: TrendAnalysisSummary) => Promise<void>;
  onOpenInGraphWorkbench?: (nodeUuid: string) => void;
  selectedNode?: ETGNode | null;
}

function formatAxisTick(val: number, span: number): string {
  const decimals = span >= 100 ? 0 : span >= 10 ? 1 : span >= 0.2 ? 2 : 3;
  const clean = Math.abs(val) < Math.pow(10, -(decimals + 2)) ? 0 : val;
  return clean.toFixed(decimals);
}

function formatMetricVal(val: number, decimals = 2): string {
  const clean = Math.abs(val) < Math.pow(10, -(decimals + 2)) ? 0 : val;
  return clean.toFixed(decimals);
}

function formatSignedVal(val: number, decimals = 2): string {
  const clean = Math.abs(val) < Math.pow(10, -(decimals + 2)) ? 0 : val;
  const prefix = clean > 0 ? "+" : "";
  return `${prefix}${clean.toFixed(decimals)}`;
}

/**
 * Wide interactive modal overlay for inspecting each Earth trend graph in full detail
 * with date windowing, drag-to-zoom, date pinning/delta comparison, seasonal slicing,
 * date formatting controls, extended NASA archive loading, stats rigor grid, and CSV export.
 */
export function TrendGraphDetailModal({
  open,
  onClose,
  cardTitle,
  coord,
  summaries,
  allSpotSummaries,
  primary,
  secondary = null,
  comparison = null,
  labelA,
  labelB,
  initialItemId = null,
  initialMode = "raw",
  initialPreset = null,
  tempUnit,
  onChangeTempUnit,
  onSelectSummary,
  onSaveToGraph,
  onOpenInGraphWorkbench,
  selectedNode = null,
}: TrendGraphDetailModalProps) {
  const titleId = useId();
  const baseId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const sessionInitKeyRef = useRef<string | null>(null);
  const pointerDownRef = useRef<{
    x: number;
    y: number;
    idx: number;
    pointerId: number;
  } | null>(null);

  const [showAllSpotGraphs, setShowAllSpotGraphs] = useState(false);
  const [activeItemId, setActiveItemId] = useState<string | null>(initialItemId);
  const [mode, setMode] = useState<"raw" | "anomaly">(initialMode);
  const [compareMode, setCompareMode] = useState<CompareChartMode>(
    initialMode === "anomaly" ? "anomaly" : "raw"
  );
  const [resolution, setResolution] = useState<"monthly" | "annual">("monthly");
  const [showTrendCi, setShowTrendCi] = useState(true);
  const [showSmooth, setShowSmooth] = useState(true);
  const [showShift, setShowShift] = useState(true);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  // Date customization & viewing state
  const [windowStartDate, setWindowStartDate] = useState<string | null>(null);
  const [windowEndDate, setWindowEndDate] = useState<string | null>(null);
  const [seasonFilter, setSeasonFilter] = useState<TrendSeasonFilter>("all");
  const [dateFormat, setDateFormat] = useState<TrendDateFormat>("human");
  const [denseDates, setDenseDates] = useState(false);
  const [showExtremeDates, setShowExtremeDates] = useState(true);
  const [pinnedDates, setPinnedDates] = useState<string[]>([]);
  const [dragBrush, setDragBrush] = useState<{
    anchorIdx: number;
    currentIdx: number;
    moved: boolean;
  } | null>(null);
  const [tableSearch, setTableSearch] = useState("");
  const [tableSortAsc, setTableSortAsc] = useState(false);

  // Extended archive overrides (e.g. 1981-2025 MERRA-2 fetch)
  const [archiveOverrides, setArchiveOverrides] = useState<
    Record<string, TrendAnalysisSummary>
  >({});
  const [archiveRanges, setArchiveRanges] = useState<
    Record<string, { startYear: number; endYear: number }>
  >({});
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const spotIdentity = coord
    ? `${coord.lat.toFixed(3)}:${coord.lng.toFixed(3)}`
    : cardTitle;

  useEffect(() => {
    setArchiveOverrides({});
    setArchiveRanges({});
    setArchiveError(null);
    setWindowStartDate(null);
    setWindowEndDate(null);
    setSeasonFilter("all");
    setPinnedDates([]);
    setDragBrush(null);
    setTableSearch("");
  }, [spotIdentity]);

  useEffect(() => {
    if (!open) {
      sessionInitKeyRef.current = null;
      return;
    }
    const launchKey = `${initialItemId ?? ""}::${initialMode}::${initialPreset ?? ""}`;
    if (sessionInitKeyRef.current === launchKey) return;
    sessionInitKeyRef.current = launchKey;

    const missingFromVisible = Boolean(
      initialItemId &&
        allSpotSummaries &&
        allSpotSummaries.some((s) => summaryKey(s) === initialItemId) &&
        !summaries.some((s) => summaryKey(s) === initialItemId)
    );
    setShowAllSpotGraphs(missingFromVisible);
    setActiveItemId(initialItemId ?? null);
    setMode(initialMode ?? "raw");
    setCompareMode(initialMode === "anomaly" ? "anomaly" : "raw");
    setScrubIndex(null);
    setSaveMessage(null);
    setPinnedDates([]);
    setDragBrush(null);
    setTableSearch("");
    setArchiveError(null);
    setSeasonFilter("all");

    if (initialPreset && initialPreset !== "all") {
      const pool =
        missingFromVisible && allSpotSummaries ? allSpotSummaries : summaries;
      const targetSummary =
        (initialItemId
          ? pool.find((s) => summaryKey(s) === initialItemId)
          : null) ?? primary;
      const pts =
        targetSummary?.seasonalPoints && targetSummary.seasonalPoints.length >= 18
          ? targetSummary.seasonalPoints
          : targetSummary?.points;
      const resolved = pts
        ? resolvePresetDateRange(pts, initialPreset, targetSummary?.changePoint?.date)
        : null;
      if (resolved) {
        setWindowStartDate(resolved.startDate);
        setWindowEndDate(resolved.endDate);
        return;
      }
    }
    setWindowStartDate(null);
    setWindowEndDate(null);
  }, [
    open,
    initialItemId,
    initialMode,
    initialPreset,
    summaries,
    allSpotSummaries,
    primary,
  ]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;
    return attachDialogLightDismissFallback(
      dialog,
      () => dialog.close("backdrop"),
      contentRef.current
    );
  }, []);

  const handleNativeClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    const opener = openerRef.current;
    openerRef.current = null;
    onClose();
    restoreOpenerFocus(opener);
  };

  const hiddenSpotSummaryCount = useMemo(() => {
    if (!allSpotSummaries || allSpotSummaries.length <= summaries.length) return 0;
    const visSet = new Set(summaries.map((s) => summaryKey(s)));
    return allSpotSummaries.filter((s) => !visSet.has(summaryKey(s))).length;
  }, [allSpotSummaries, summaries]);

  const activeSummaries =
    showAllSpotGraphs && allSpotSummaries && allSpotSummaries.length > 0
      ? allSpotSummaries
      : summaries;

  const items = useMemo(
    () =>
      buildTrendOverlayItems({
        summaries: activeSummaries,
        primary,
        secondary,
        comparison,
        labelA,
        labelB,
      }),
    [activeSummaries, primary, secondary, comparison, labelA, labelB]
  );

  const activeIndex = useMemo(() => {
    if (items.length === 0) return -1;
    if (activeItemId) {
      const idx = items.findIndex((item) => item.id === activeItemId);
      if (idx >= 0) return idx;
    }
    return 0;
  }, [items, activeItemId]);

  const activeItem: TrendOverlayItem | null =
    activeIndex >= 0 ? items[activeIndex] ?? null : null;

  const selectItemByIndex = (nextIdx: number) => {
    if (items.length === 0) return;
    const wrapped = ((nextIdx % items.length) + items.length) % items.length;
    const next = items[wrapped];
    if (!next) return;
    setActiveItemId(next.id);
    setScrubIndex(null);
    setSaveMessage(null);
    setWindowStartDate(null);
    setWindowEndDate(null);
    setSeasonFilter("all");
    setPinnedDates([]);
    setDragBrush(null);
    setTableSearch("");
    setArchiveError(null);
    if (next.kind === "single" && !next.side) {
      onSelectSummary?.(summaryKey(next.summary), next.summary.dataset);
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (items.length <= 1 || activeIndex < 0) return;
    let nextIdx = -1;
    if (e.key === "ArrowRight") nextIdx = (activeIndex + 1) % items.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (activeIndex - 1 + items.length) % items.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = items.length - 1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const targetItem = items[nextIdx];
    selectItemByIndex(nextIdx);
    if (targetItem) {
      tabButtonRefs.current[targetItem.id]?.focus();
    }
  };

  const singleContext = useMemo(() => {
    if (!activeItem || activeItem.kind !== "single") return null;
    const key = summaryKey(activeItem.summary);
    const overrideKey = archiveSummaryKey(activeItem.summary);
    const baseSummary = archiveOverrides[overrideKey] ?? activeItem.summary;
    const unwindowedSummary =
      seasonFilter !== "all"
        ? buildWindowedTrendSummary({
            baseSummary,
            startDate: null,
            endDate: null,
            seasonFilter,
            resolution: "monthly",
          }).summary
        : baseSummary;
    const unwindowed = prepareSingleDetailSeries(
      unwindowedSummary,
      mode,
      seasonFilter !== "all" ? "annual" : resolution,
      tempUnit
    );
    const windowed = buildWindowedTrendSummary({
      baseSummary,
      startDate: windowStartDate,
      endDate: windowEndDate,
      seasonFilter,
      resolution,
    });
    const prepared = windowed.isWindowed
      ? prepareSingleDetailSeries(windowed.summary, mode, resolution, tempUnit)
      : unwindowed;

    return {
      key,
      overrideKey,
      baseSummary,
      unwindowed,
      effectiveSummary: windowed.summary,
      isWindowed: windowed.isWindowed,
      tooFewPoints: Boolean(windowed.tooFewPoints),
      prepared,
      activeArchiveRange: archiveRanges[overrideKey] ?? null,
    };
  }, [
    activeItem,
    archiveOverrides,
    archiveRanges,
    mode,
    resolution,
    tempUnit,
    windowStartDate,
    windowEndDate,
    seasonFilter,
  ]);

  const compareContext = useMemo(() => {
    if (!activeItem || activeItem.kind !== "compare") return null;
    const basePrimary =
      archiveOverrides[archiveSummaryKey(activeItem.primary)] ?? activeItem.primary;
    const baseSecondary =
      archiveOverrides[archiveSummaryKey(activeItem.secondary)] ??
      activeItem.secondary;
    const unwindowedPrepared = prepareComparisonDetailSeries({
      primary: basePrimary,
      secondary: baseSecondary,
      comparison: activeItem.comparison,
      mode: compareMode,
      tempUnit,
    });
    const windowed = buildWindowedComparison({
      primary: basePrimary,
      secondary: baseSecondary,
      baseComparison: activeItem.comparison,
      startDate: windowStartDate,
      endDate: windowEndDate,
      mode: compareMode,
    });
    const prepared = windowed.isWindowed
      ? prepareComparisonDetailSeries({
          primary: windowed.primary,
          secondary: windowed.secondary,
          comparison: windowed.comparison,
          mode: compareMode,
          tempUnit,
        })
      : unwindowedPrepared;

    const availablePoints = unwindowedPrepared.points.map((pt) => {
      const parsed = parseTrendDateParts(pt.date);
      const t =
        parsed.month !== null
          ? parsed.year + (parsed.month - 0.5) / 12
          : parsed.year;
      return { date: pt.date, t, value: pt.zA };
    });

    return {
      baseComparison: activeItem.comparison,
      effectiveComparison: windowed.comparison,
      isWindowed: windowed.isWindowed,
      tooFewPoints: Boolean(windowed.tooFewPoints),
      unwindowedPrepared,
      prepared,
      availablePoints,
    };
  }, [
    activeItem,
    archiveOverrides,
    compareMode,
    tempUnit,
    windowStartDate,
    windowEndDate,
  ]);

  const handleResetWindow = () => {
    setWindowStartDate(null);
    setWindowEndDate(null);
    setSeasonFilter("all");
    setDragBrush(null);
    setScrubIndex(null);
  };

  const handleTogglePinDate = (dateStr: string) => {
    setPinnedDates((prev) => {
      if (prev.includes(dateStr)) {
        return prev.filter((d) => d !== dateStr);
      }
      if (prev.length < 2) {
        return [...prev, dateStr];
      }
      return [prev[1], dateStr];
    });
  };

  const handleFetchArchiveSpan = async (
    summary: TrendAnalysisSummary,
    startYear: number,
    endYear: number
  ) => {
    setArchiveLoading(true);
    setArchiveError(null);
    try {
      const qs = new URLSearchParams({
        lat: String(summary.lat),
        lng: String(summary.lng),
        dataset: summary.dataset,
        start_year: String(startYear),
        end_year: String(endYear),
      });
      const res = await fetch(`/api/earth/timeseries?${qs.toString()}`, {
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as {
        primary?: TrendAnalysisSummary | null;
        summaries?: TrendAnalysisSummary[];
        error?: string;
      } | null;
      if (!res.ok || !data) {
        throw new Error(data?.error || "Failed to load historical archive span");
      }
      const dsKey = summaryKey(summary);
      const overrideKey = archiveSummaryKey(summary);
      const matched =
        data.summaries?.find((s) => summaryKey(s) === dsKey) ?? data.primary ?? null;
      if (!matched || matched.points.length < 3) {
        throw new Error(
          `No archive observations returned for ${startYear}–${endYear}.`
        );
      }
      setArchiveOverrides((prev) => ({ ...prev, [overrideKey]: matched }));
      setArchiveRanges((prev) => ({ ...prev, [overrideKey]: { startYear, endYear } }));
      setWindowStartDate(null);
      setWindowEndDate(null);
      setPinnedDates([]);
      setScrubIndex(null);
    } catch (err) {
      setArchiveError(
        err instanceof Error ? err.message : "Failed to fetch archive span"
      );
    } finally {
      setArchiveLoading(false);
    }
  };

  const handleDownloadCsv = () => {
    if (!activeItem || activeItem.kind !== "single" || !singleContext) return;
    const d = describeTrendPlainly(singleContext.effectiveSummary, tempUnit);
    const title = `${cardTitle} - ${d.topicLabel} (${d.parameterShort})`;
    const csv = formatDetailSeriesCsv(
      title,
      singleContext.prepared.points,
      singleContext.prepared.displayUnit
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${summaryKey(singleContext.effectiveSummary).replace(/[^a-z0-9_-]+/gi, "-")}-trend.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveGraphNode = async (summary: TrendAnalysisSummary) => {
    if (!onSaveToGraph) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      await onSaveToGraph(summary);
      setSaveMessage("Saved trend series to Earth Trend Graph.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={handleNativeClose}
      onKeyDown={(e) => trapDialogTabKey(dialogRef.current, e)}
      className="etg-dialog etg-dialog--wide"
      {...({ closedby: "any" } as Record<string, unknown>)}
    >
      <div
        ref={contentRef}
        className="flex flex-1 min-h-0 flex-col bg-surface text-text-primary"
      >
        {open && (
          <>
            {/* Header */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-band px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2
                    id={titleId}
                    className="truncate text-sm font-semibold text-text-primary"
                  >
                    {cardTitle} — Trend Graph Inspector
                  </h2>
                  {activeItem?.kind === "compare" ? (
                    <span className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-subtle">
                      {formatCoordShort(activeItem.primary.lat, activeItem.primary.lng)} vs{" "}
                      {formatCoordShort(activeItem.secondary.lat, activeItem.secondary.lng)}
                    </span>
                  ) : activeItem?.kind === "single" ? (
                    <span className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-subtle">
                      {formatCoordShort(activeItem.summary.lat, activeItem.summary.lng)}
                    </span>
                  ) : coord ? (
                    <span className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-subtle">
                      {formatCoordShort(coord.lat, coord.lng)}
                    </span>
                  ) : null}
                  {items.length > 0 && (
                    <span className="ws-numeric rounded-xs border border-border bg-surface-inset px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-text-muted">
                      {activeIndex + 1} / {items.length}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {items.length > 1 && (
                  <div
                    className="inline-flex items-center rounded-md border border-border bg-surface-inset p-0.5"
                    role="group"
                    aria-label="Navigate between trend graphs"
                  >
                    <button
                      type="button"
                      onClick={() => selectItemByIndex(activeIndex - 1)}
                      aria-label="Previous trend graph"
                      title="Previous trend graph"
                      className="inline-flex h-6 items-center gap-0.5 rounded-xs px-1.5 text-[11px] font-medium text-text-muted hover:bg-surface-elevated hover:text-text-primary cursor-pointer"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="hidden sm:inline">Prev</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => selectItemByIndex(activeIndex + 1)}
                      aria-label="Next trend graph"
                      title="Next trend graph"
                      className="inline-flex h-6 items-center gap-0.5 rounded-xs px-1.5 text-[11px] font-medium text-text-muted hover:bg-surface-elevated hover:text-text-primary cursor-pointer"
                    >
                      <span className="hidden sm:inline">Next</span>
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}

                {onChangeTempUnit && (
                  <div
                    className="inline-flex h-7 items-center rounded-md border border-border bg-surface-inset p-0.5"
                    role="group"
                    aria-label="Temperature unit"
                  >
                    {(["C", "F"] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        aria-pressed={tempUnit === u}
                        onClick={() => onChangeTempUnit(u)}
                        className="rounded-xs px-1.5 py-0.5 text-[10.5px] font-semibold text-text-muted transition-colors hover:text-text-primary aria-pressed:bg-surface-elevated aria-pressed:text-text-primary cursor-pointer"
                      >
                        °{u}
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => dialogRef.current?.close("close-button")}
                  aria-label="Close trend graph overlay"
                  className="etg-hud-btn inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Graph Navigation Tab Strip */}
            {items.length > 0 && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface pr-3">
                <div
                  role="tablist"
                  aria-label="Available trend graphs at this spot"
                  onKeyDown={handleTabKeyDown}
                  className="etg-tablist flex-1 border-b-0 !px-3.5"
                >
                  {items.map((item, idx) => {
                    const selected = idx === activeIndex;
                    const resolvedItem: TrendOverlayItem =
                      item.kind === "single"
                        ? {
                            ...item,
                            summary:
                              archiveOverrides[archiveSummaryKey(item.summary)] ??
                              item.summary,
                          }
                        : {
                            ...item,
                            primary:
                              archiveOverrides[archiveSummaryKey(item.primary)] ??
                              item.primary,
                            secondary:
                              archiveOverrides[archiveSummaryKey(item.secondary)] ??
                              item.secondary,
                          };
                    const meta = getOverlayItemTabMeta(resolvedItem, tempUnit);
                    const sparkPoints =
                      resolvedItem.kind === "single"
                        ? resolvedItem.summary.points
                        : resolvedItem.primary.points;
                    return (
                      <button
                        key={item.id}
                        ref={(el) => {
                          tabButtonRefs.current[item.id] = el;
                        }}
                        id={`${baseId}-tab-${idx}`}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls={`${baseId}-detail-panel`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => selectItemByIndex(idx)}
                        className="etg-tab inline-flex items-center gap-2 !px-2.5 !py-1.5"
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: meta.color }}
                          aria-hidden="true"
                        />
                        <span className="text-left leading-tight">
                          <span className="block text-[11.5px] font-semibold text-text-primary">
                            {meta.title}
                          </span>
                          <span className="ws-numeric block font-mono text-[10px] text-text-subtle">
                            {meta.subtitle} · {meta.dirSymbol} {meta.rateShort}
                          </span>
                        </span>
                        <MiniSparkline
                          points={sparkPoints}
                          color={meta.color}
                          width={40}
                          height={14}
                        />
                      </button>
                    );
                  })}
                </div>

                {hiddenSpotSummaryCount > 0 && allSpotSummaries && (
                  <button
                    type="button"
                    onClick={() => setShowAllSpotGraphs((v) => !v)}
                    className="shrink-0 rounded-sm border border-border bg-surface-inset px-2 py-1 text-[10.5px] font-medium text-accent-fg hover:border-accent-fg cursor-pointer"
                  >
                    {showAllSpotGraphs
                      ? "Filtered only"
                      : `Show all ${allSpotSummaries.length}`}
                  </button>
                )}
              </div>
            )}

            {/* Main Scrollable Detail Body */}
            <div
              id={`${baseId}-detail-panel`}
              role="tabpanel"
              aria-labelledby={
                activeIndex >= 0 ? `${baseId}-tab-${activeIndex}` : undefined
              }
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain text-xs"
            >
              {!activeItem ? (
                <div className="p-6 text-center text-text-muted">
                  No time-series trend data is available for this coordinate yet.
                </div>
              ) : activeItem.kind === "single" && singleContext ? (
                (() => {
                  const {
                    baseSummary,
                    unwindowed,
                    effectiveSummary: summary,
                    isWindowed,
                    tooFewPoints,
                    prepared: singlePrepared,
                    activeArchiveRange,
                  } = singleContext;

                  const digest = describeTrendPlainly(summary, tempUnit);
                  const fullDigest = isWindowed
                    ? describeTrendPlainly(baseSummary, tempUnit)
                    : null;
                  const dsMeta = DATASET_BY_ID[summary.dataset];
                  const lineColor =
                    activeItem.side === "b" ? "#38bdf8" : (dsMeta?.color ?? "#e2a856");
                  const pts = singlePrepared.points;
                  const effectiveMode = mode;
                  const yTicks = computeNiceTicks(
                    singlePrepared.minY,
                    singlePrepared.maxY,
                    5
                  );
                  const yMin = Math.min(singlePrepared.minY, yTicks[0]);
                  const yMax = Math.max(
                    singlePrepared.maxY,
                    yTicks[yTicks.length - 1]
                  );
                  const ySpan = Math.max(1e-6, yMax - yMin);

                  const xAt = (idx: number) =>
                    PAD_LEFT + (idx / Math.max(1, pts.length - 1)) * PLOT_W;
                  const yAt = (val: number) =>
                    PAD_TOP + PLOT_H - ((val - yMin) / ySpan) * PLOT_H;

                  const obsPath = pts
                    .map(
                      (p, i) =>
                        `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.value).toFixed(1)}`
                    )
                    .join(" ");
                  const smoothPath = pts
                    .map(
                      (p, i) =>
                        `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.smooth).toFixed(1)}`
                    )
                    .join(" ");
                  const trendPath = pts
                    .map(
                      (p, i) =>
                        `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.trendFit).toFixed(1)}`
                    )
                    .join(" ");
                  const ciPolygonPoints =
                    pts.length >= 2
                      ? [
                          ...pts.map(
                            (p, i) =>
                              `${xAt(i).toFixed(1)},${yAt(p.ciHigh95).toFixed(1)}`
                          ),
                          ...pts
                            .slice()
                            .reverse()
                            .map((p, revI) => {
                              const i = pts.length - 1 - revI;
                              return `${xAt(i).toFixed(1)},${yAt(p.ciLow95).toFixed(1)}`;
                            }),
                        ].join(" ")
                      : "";

                  const activeScrubIdx =
                    scrubIndex !== null && scrubIndex >= 0 && scrubIndex < pts.length
                      ? scrubIndex
                      : Math.max(0, pts.length - 1);
                  const activePoint = pts[activeScrubIdx] ?? null;
                  const xTickIndices = pickXAxisTickIndices(
                    pts.length,
                    denseDates ? 12 : 7
                  );
                  const extremes =
                    showExtremeDates && pts.length >= 3
                      ? findSeriesExtremes(pts)
                      : null;

                  const pinnedResolved = pinnedDates
                    .map((d) => {
                      const idx = pts.findIndex((p) => p.date === d);
                      return idx >= 0 ? { idx, pt: pts[idx] } : null;
                    })
                    .filter((item): item is NonNullable<typeof item> => item !== null);

                  const dirSymbol = digest.isSignificant
                    ? digest.tone === "rising"
                      ? "↑"
                      : "↓"
                    : "—";
                  const { factor: slopeScale } = resolveTemperatureSlopeScale(
                    summary.slopeUnit,
                    tempUnit,
                    isTemperatureUnitString(summary.unit)
                  );
                  const dispSlope = summary.theilSen.slope * slopeScale;
                  const dispLow95 = summary.theilSen.slopeLow95 * slopeScale;
                  const dispHigh95 = summary.theilSen.slopeHigh95 * slopeScale;
                  const dispSeasonalSlope = summary.seasonalAnalysis
                    ? summary.seasonalAnalysis.seasonalTheilSenSlope * slopeScale
                    : null;
                  const sliderPct =
                    pts.length > 1
                      ? ((activeScrubIdx / (pts.length - 1)) * 100).toFixed(1)
                      : "100";

                  const canFetchArchive =
                    baseSummary.dataset !== "community" &&
                    baseSummary.provenance !== "Empirical Dataset (Imported)";

                  const trimmedSearch = tableSearch.trim().toLowerCase();
                  const tableRows = (tableSortAsc ? pts : pts.slice().reverse()).filter(
                    (row) => {
                      if (!trimmedSearch) return true;
                      const formatted = formatTrendDate(
                        row.date,
                        dateFormat,
                        row.t
                      ).toLowerCase();
                      return (
                        row.date.toLowerCase().includes(trimmedSearch) ||
                        formatted.includes(trimmedSearch)
                      );
                    }
                  );

                  const brushLo = dragBrush
                    ? Math.min(dragBrush.anchorIdx, dragBrush.currentIdx)
                    : 0;
                  const brushHi = dragBrush
                    ? Math.max(dragBrush.anchorIdx, dragBrush.currentIdx)
                    : 0;

                  return (
                    <div className="space-y-3.5 p-4">
                      {/* Controls Toolbar */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <div
                            className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset p-0.5"
                            role="group"
                            aria-label="Time series display mode"
                          >
                            <button
                              type="button"
                              aria-pressed={effectiveMode === "raw"}
                              onClick={() => setMode("raw")}
                              className={`rounded-xs px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                                effectiveMode === "raw"
                                  ? "bg-surface-elevated text-text-primary shadow-xs"
                                  : "text-text-muted hover:text-text-primary"
                              }`}
                            >
                              Raw
                            </button>
                            <button
                              type="button"
                              aria-pressed={effectiveMode === "anomaly"}
                              onClick={() => setMode("anomaly")}
                              className={`rounded-xs px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                                effectiveMode === "anomaly"
                                  ? "bg-surface-elevated text-text-primary shadow-xs"
                                  : "text-text-muted hover:text-text-primary"
                              }`}
                            >
                              {singlePrepared.hasSeasonalAnomaly
                                ? "Deseasonalized"
                                : "Anomaly Δ"}
                            </button>
                          </div>

                          {(unwindowed.hasDistinctMonthly ||
                            singlePrepared.hasDistinctMonthly ||
                            seasonFilter !== "all") &&
                            baseSummary.seasonalPoints &&
                            (seasonFilter !== "all" ? (
                              <div className="inline-flex items-center gap-1.5 rounded-sm border border-sky-400/50 bg-sky-950/35 px-2.5 py-1 text-[11px] text-sky-200">
                                <span>
                                  Season Slice ({singlePrepared.points.length} pts)
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSeasonFilter("all");
                                    setWindowStartDate(null);
                                    setWindowEndDate(null);
                                    setScrubIndex(null);
                                  }}
                                  className="font-semibold text-sky-300 hover:underline cursor-pointer"
                                >
                                  All Months
                                </button>
                              </div>
                            ) : (
                              <div
                                className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset p-0.5"
                                role="group"
                                aria-label="Time series sampling resolution"
                              >
                                <button
                                  type="button"
                                  aria-pressed={
                                    singlePrepared.effectiveResolution === "monthly"
                                  }
                                  onClick={() => {
                                    setResolution("monthly");
                                    setScrubIndex(null);
                                  }}
                                  className={`rounded-xs px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                                    singlePrepared.effectiveResolution === "monthly"
                                      ? "bg-surface-elevated text-text-primary shadow-xs"
                                      : "text-text-muted hover:text-text-primary"
                                  }`}
                                >
                                  Monthly (
                                  {summary.seasonalPoints?.length ??
                                    baseSummary.seasonalPoints.length}
                                  )
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={
                                    singlePrepared.effectiveResolution === "annual"
                                  }
                                  onClick={() => {
                                    setResolution("annual");
                                    setScrubIndex(null);
                                  }}
                                  className={`rounded-xs px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                                    singlePrepared.effectiveResolution === "annual"
                                      ? "bg-surface-elevated text-text-primary shadow-xs"
                                      : "text-text-muted hover:text-text-primary"
                                  }`}
                                >
                                  Annual ({summary.points.length})
                                </button>
                              </div>
                            ))}
                        </div>

                        <div
                          className="flex flex-wrap items-center gap-1.5"
                          role="group"
                          aria-label="Chart overlay layers"
                        >
                          <button
                            type="button"
                            aria-pressed={showTrendCi}
                            onClick={() => setShowTrendCi((v) => !v)}
                            className={`rounded-sm border px-2 py-1 text-[10.5px] font-medium transition-colors cursor-pointer ${
                              showTrendCi
                                ? "border-accent-fg bg-amber-950/70 text-amber-200"
                                : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                            }`}
                          >
                            Trend + 95% CI
                          </button>
                          <button
                            type="button"
                            aria-pressed={showSmooth}
                            onClick={() => setShowSmooth((v) => !v)}
                            className={`rounded-sm border px-2 py-1 text-[10.5px] font-medium transition-colors cursor-pointer ${
                              showSmooth
                                ? "border-sky-400 bg-sky-950/70 text-sky-200"
                                : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                            }`}
                          >
                            Rolling Smooth
                          </button>
                          {summary.changePoint && (
                            <button
                              type="button"
                              aria-pressed={showShift}
                              onClick={() => setShowShift((v) => !v)}
                              className={`rounded-sm border px-2 py-1 text-[10.5px] font-medium transition-colors cursor-pointer ${
                                showShift
                                  ? "border-amber-400 bg-amber-950 text-amber-200"
                                  : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                              }`}
                            >
                              Shift Marker
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Date Customization, Viewing & Archive Controls */}
                      <TrendDateControlsBar
                        availablePoints={unwindowed.points}
                        activeStartDate={windowStartDate}
                        activeEndDate={windowEndDate}
                        isWindowed={isWindowed}
                        onSelectWindow={(start, end) => {
                          setWindowStartDate(start);
                          setWindowEndDate(end);
                          setScrubIndex(null);
                        }}
                        onResetWindow={handleResetWindow}
                        changePointDate={baseSummary.changePoint?.date ?? null}
                        showSeasonFilter={Boolean(
                          baseSummary.seasonalPoints &&
                            baseSummary.seasonalPoints.length >= 18
                        )}
                        seasonFilter={seasonFilter}
                        onChangeSeasonFilter={(next) => {
                          setSeasonFilter(next);
                          setScrubIndex(null);
                        }}
                        dateFormat={dateFormat}
                        onChangeDateFormat={setDateFormat}
                        denseDates={denseDates}
                        onToggleDenseDates={() => setDenseDates((v) => !v)}
                        showExtremeDates={showExtremeDates}
                        onToggleExtremeDates={() => setShowExtremeDates((v) => !v)}
                        showPointControls={true}
                        activePointDate={activePoint?.date ?? null}
                        activePointT={activePoint?.t}
                        activePointIndex={activeScrubIdx}
                        activePointCount={pts.length}
                        onStepPoint={(delta) => {
                          const next = Math.max(
                            0,
                            Math.min(pts.length - 1, activeScrubIdx + delta)
                          );
                          setScrubIndex(next);
                        }}
                        pinnedDates={pinnedDates}
                        onTogglePinActiveDate={() => {
                          if (activePoint) handleTogglePinDate(activePoint.date);
                        }}
                        onClearPins={() => setPinnedDates([])}
                        archiveLoading={archiveLoading}
                        archiveError={archiveError}
                        activeArchiveRange={activeArchiveRange}
                        onFetchArchiveSpan={
                          canFetchArchive
                            ? (startYr, endYr) =>
                                void handleFetchArchiveSpan(baseSummary, startYr, endYr)
                            : undefined
                        }
                      />

                      {tooFewPoints && (
                        <div
                          role="status"
                          className="rounded-sm border border-amber-400/50 bg-amber-950/35 px-2.5 py-1 text-[11px] text-amber-200"
                        >
                          Selected date slice has fewer than 3 observations — displaying full record instead.
                        </div>
                      )}

                      <PinnedDateComparisonBanner
                        pinnedPoints={pinnedResolved.map((p) => p.pt)}
                        unit={singlePrepared.displayUnit}
                        slopeUnit={singlePrepared.displaySlopeUnit}
                        dateFormat={dateFormat}
                        onClearPins={() => setPinnedDates([])}
                      />

                      {/* Chart Container */}
                      <div className="ws-inset space-y-2 rounded-md p-3">
                        {/* Live Scrub Readout Bar */}
                        {activePoint && (
                          <div className="ws-numeric flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border-subtle pb-2 font-mono text-[11px]">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="font-semibold text-text-primary">
                                {formatTrendDate(
                                  activePoint.date,
                                  dateFormat,
                                  activePoint.t
                                )}
                              </span>
                              <span className="text-text-muted">
                                {effectiveMode === "anomaly" ? "Anomaly Δ" : "Observed"}:{" "}
                                <strong className="text-text-primary">
                                  {effectiveMode === "anomaly"
                                    ? formatSignedVal(activePoint.value, 2)
                                    : formatMetricVal(activePoint.value, 2)}{" "}
                                  {singlePrepared.displayUnit}
                                </strong>
                              </span>
                              {showSmooth && (
                                <span className="text-text-muted">
                                  Smooth:{" "}
                                  <strong className="text-sky-300">
                                    {formatMetricVal(activePoint.smooth, 2)}{" "}
                                    {singlePrepared.displayUnit}
                                  </strong>
                                </span>
                              )}
                              {showTrendCi && (
                                <span className="text-text-muted">
                                  Trend Fit:{" "}
                                  <strong className="text-text-primary">
                                    {formatMetricVal(activePoint.trendFit, 2)}
                                  </strong>{" "}
                                  <span className="text-text-subtle">
                                    [{formatMetricVal(activePoint.ciLow95, 2)},{" "}
                                    {formatMetricVal(activePoint.ciHigh95, 2)}]
                                  </span>
                                </span>
                              )}
                            </div>
                            <span className="text-text-subtle">
                              Z = {formatSignedVal(activePoint.zScore, 2)}σ
                            </span>
                          </div>
                        )}

                        {/* Interactive Wide SVG Plot (supports drag-to-zoom & click-to-pin) */}
                        <svg
                          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                          className="h-auto w-full cursor-crosshair touch-pan-y select-none"
                          role="img"
                          aria-label={`${digest.topicLabel} ${digest.parameterShort} detailed trend chart`}
                          onPointerDown={(e) => {
                            if (e.button !== 0 || pts.length < 2) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const idx = pointerClientXToIndex(
                              e.clientX,
                              rect.left,
                              rect.width,
                              SVG_W,
                              PAD_LEFT,
                              PLOT_W,
                              pts.length
                            );
                            pointerDownRef.current = {
                              x: e.clientX,
                              y: e.clientY,
                              idx,
                              pointerId: e.pointerId,
                            };
                            setDragBrush({ anchorIdx: idx, currentIdx: idx, moved: false });
                          }}
                          onPointerMove={(e) => {
                            if (pts.length <= 1) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const idx = pointerClientXToIndex(
                              e.clientX,
                              rect.left,
                              rect.width,
                              SVG_W,
                              PAD_LEFT,
                              PLOT_W,
                              pts.length
                            );
                            setScrubIndex(idx);
                            const down = pointerDownRef.current;
                            if (down) {
                              const moved = Math.abs(e.clientX - down.x) >= 6;
                              if (moved) {
                                try {
                                  e.currentTarget.setPointerCapture?.(down.pointerId);
                                } catch {
                                  // Ignore pointer capture errors
                                }
                              }
                              setDragBrush((prev) => ({
                                anchorIdx: down.idx,
                                currentIdx: idx,
                                moved: Boolean(prev?.moved || moved),
                              }));
                            }
                          }}
                          onPointerUp={(e) => {
                            const down = pointerDownRef.current;
                            if (!down) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const idx = pointerClientXToIndex(
                              e.clientX,
                              rect.left,
                              rect.width,
                              SVG_W,
                              PAD_LEFT,
                              PLOT_W,
                              pts.length
                            );
                            const moved =
                              Boolean(dragBrush?.moved) ||
                              Math.abs(e.clientX - down.x) >= 6;
                            if (moved) {
                              const lo = Math.min(down.idx, idx);
                              const hi = Math.max(down.idx, idx);
                              if (hi - lo + 1 >= Math.min(3, pts.length)) {
                                setWindowStartDate(pts[lo].date);
                                setWindowEndDate(pts[hi].date);
                                setScrubIndex(null);
                              }
                            } else {
                              const clicked = pts[idx];
                              if (clicked) {
                                handleTogglePinDate(clicked.date);
                              }
                            }
                            pointerDownRef.current = null;
                            setDragBrush(null);
                          }}
                          onPointerCancel={() => {
                            pointerDownRef.current = null;
                            setDragBrush(null);
                          }}
                          onPointerLeave={() => {
                            if (!pointerDownRef.current) {
                              setScrubIndex(null);
                            }
                          }}
                        >
                          {/* Horizontal Gridlines & Y Ticks */}
                          {yTicks.map((tick) => {
                            const ty = yAt(tick);
                            return (
                              <g key={tick}>
                                <line
                                  x1={PAD_LEFT}
                                  y1={ty}
                                  x2={SVG_W - PAD_RIGHT}
                                  y2={ty}
                                  stroke="var(--border-subtle)"
                                  strokeWidth={1}
                                />
                                <text
                                  x={PAD_LEFT - 8}
                                  y={ty + 3.5}
                                  textAnchor="end"
                                  fontSize={10.5}
                                  fontFamily="var(--font-mono)"
                                  fill="var(--text-subtle)"
                                >
                                  {formatAxisTick(tick, ySpan)}
                                </text>
                              </g>
                            );
                          })}

                          {/* Reference Baseline (Mean or 0) */}
                          <line
                            x1={PAD_LEFT}
                            y1={yAt(singlePrepared.referenceY)}
                            x2={SVG_W - PAD_RIGHT}
                            y2={yAt(singlePrepared.referenceY)}
                            stroke="var(--border-strong)"
                            strokeDasharray="3 4"
                            strokeWidth={1}
                          />

                          {/* X-axis Date Ticks (+ optional dense vertical date gridlines) */}
                          {xTickIndices.map((idx) => {
                            const pt = pts[idx];
                            if (!pt) return null;
                            const tx = xAt(idx);
                            const anchor =
                              idx === 0
                                ? "start"
                                : idx === pts.length - 1
                                  ? "end"
                                  : "middle";
                            return (
                              <g key={`${idx}-${pt.date}`}>
                                {denseDates && (
                                  <line
                                    x1={tx}
                                    y1={PAD_TOP}
                                    x2={tx}
                                    y2={PAD_TOP + PLOT_H}
                                    stroke="var(--border-subtle)"
                                    strokeDasharray="2 3"
                                    strokeWidth={1}
                                  />
                                )}
                                <line
                                  x1={tx}
                                  y1={PAD_TOP + PLOT_H}
                                  x2={tx}
                                  y2={PAD_TOP + PLOT_H + 5}
                                  stroke="var(--border-strong)"
                                  strokeWidth={1}
                                />
                                <text
                                  x={tx}
                                  y={SVG_H - 12}
                                  textAnchor={anchor}
                                  fontSize={denseDates ? 9.5 : 10.5}
                                  fontFamily="var(--font-mono)"
                                  fill="var(--text-subtle)"
                                >
                                  {formatTrendDate(pt.date, dateFormat, pt.t)}
                                </text>
                              </g>
                            );
                          })}

                          {/* 95% Theil-Sen CI Shaded Fan */}
                          {showTrendCi && ciPolygonPoints && (
                            <polygon
                              points={ciPolygonPoints}
                              fill={lineColor}
                              fillOpacity={0.13}
                            />
                          )}

                          {/* Active Drag-to-Zoom Brush Band */}
                          {dragBrush?.moved && (
                            <g>
                              <rect
                                x={xAt(brushLo)}
                                y={PAD_TOP}
                                width={Math.max(4, xAt(brushHi) - xAt(brushLo))}
                                height={PLOT_H}
                                fill="var(--accent)"
                                fillOpacity={0.18}
                              />
                              <line
                                x1={xAt(brushLo)}
                                y1={PAD_TOP}
                                x2={xAt(brushLo)}
                                y2={PAD_TOP + PLOT_H}
                                stroke="var(--accent-fg)"
                                strokeDasharray="3 2"
                                strokeWidth={1.2}
                              />
                              <line
                                x1={xAt(brushHi)}
                                y1={PAD_TOP}
                                x2={xAt(brushHi)}
                                y2={PAD_TOP + PLOT_H}
                                stroke="var(--accent-fg)"
                                strokeDasharray="3 2"
                                strokeWidth={1.2}
                              />
                              <text
                                x={(xAt(brushLo) + xAt(brushHi)) / 2}
                                y={PAD_TOP + 12}
                                textAnchor="middle"
                                fontSize={10}
                                fontWeight={600}
                                fontFamily="var(--font-mono)"
                                fill="var(--accent-fg-strong)"
                              >
                                Zoom:{" "}
                                {formatTrendDate(
                                  pts[brushLo].date,
                                  dateFormat,
                                  pts[brushLo].t
                                )}{" "}
                                –{" "}
                                {formatTrendDate(
                                  pts[brushHi].date,
                                  dateFormat,
                                  pts[brushHi].t
                                )}
                              </text>
                            </g>
                          )}

                          {/* Pettitt Change-Point Vertical Marker */}
                          {showShift &&
                            singlePrepared.changePointIndex !== null &&
                            summary.changePoint && (
                              <g>
                                <line
                                  x1={xAt(singlePrepared.changePointIndex)}
                                  y1={PAD_TOP}
                                  x2={xAt(singlePrepared.changePointIndex)}
                                  y2={PAD_TOP + PLOT_H}
                                  stroke="var(--fg-amber-400)"
                                  strokeDasharray="4 3"
                                  strokeWidth={1.3}
                                />
                                <text
                                  x={Math.min(
                                    SVG_W - PAD_RIGHT - 4,
                                    xAt(singlePrepared.changePointIndex) + 5
                                  )}
                                  y={PAD_TOP + 12}
                                  textAnchor={
                                    xAt(singlePrepared.changePointIndex) > SVG_W - 160
                                      ? "end"
                                      : "start"
                                  }
                                  fontSize={10}
                                  fontWeight={600}
                                  fontFamily="var(--font-mono)"
                                  fill="var(--fg-amber-300)"
                                >
                                  Shift{" "}
                                  {formatTrendDate(
                                    summary.changePoint.date,
                                    dateFormat
                                  )}
                                </text>
                              </g>
                            )}

                          {/* Pinned Date Markers */}
                          {pinnedResolved.map((pin, pIdx) => {
                            const px = xAt(pin.idx);
                            const py = yAt(pin.pt.value);
                            const label = pIdx === 0 ? "Pin A" : "Pin B";
                            return (
                              <g key={`pin-${pin.pt.date}`}>
                                <line
                                  x1={px}
                                  y1={PAD_TOP}
                                  x2={px}
                                  y2={PAD_TOP + PLOT_H}
                                  stroke="#fbbf24"
                                  strokeDasharray="2 2"
                                  strokeWidth={1.3}
                                />
                                <circle
                                  cx={px}
                                  cy={py}
                                  r={4.5}
                                  fill="#fbbf24"
                                  stroke="var(--surface)"
                                  strokeWidth={1.5}
                                />
                                <text
                                  x={px}
                                  y={PAD_TOP + PLOT_H - 6}
                                  textAnchor={px > SVG_W - 90 ? "end" : "start"}
                                  fontSize={9.5}
                                  fontWeight={700}
                                  fontFamily="var(--font-mono)"
                                  fill="var(--fg-amber-300)"
                                >
                                  {label}:{" "}
                                  {formatTrendDate(
                                    pin.pt.date,
                                    dateFormat,
                                    pin.pt.t
                                  )}
                                </text>
                              </g>
                            );
                          })}

                          {/* Observed Series Line */}
                          <path
                            d={obsPath}
                            fill="none"
                            stroke={lineColor}
                            strokeWidth={
                              singlePrepared.effectiveResolution === "monthly" ? 1.5 : 2.1
                            }
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />

                          {/* Point markers for sparser annual/short series */}
                          {pts.length <= 80 &&
                            pts.map((p, idx) => (
                              <circle
                                key={`${p.date}-${idx}`}
                                cx={xAt(idx)}
                                cy={yAt(p.value)}
                                r={idx === activeScrubIdx ? 4.2 : 2.1}
                                fill={lineColor}
                                opacity={idx === activeScrubIdx ? 1 : 0.72}
                              />
                            ))}

                          {/* Rolling Smooth Line */}
                          {showSmooth && (
                            <path
                              d={smoothPath}
                              fill="none"
                              stroke="#38bdf8"
                              strokeOpacity={0.88}
                              strokeWidth={1.8}
                              strokeLinecap="round"
                            />
                          )}

                          {/* Theil-Sen Trend Fit */}
                          {showTrendCi && (
                            <path
                              d={trendPath}
                              fill="none"
                              stroke="var(--text-primary)"
                              strokeOpacity={0.82}
                              strokeDasharray="5 4"
                              strokeWidth={1.7}
                            />
                          )}

                          {/* Peak & Low Extreme Date Callouts */}
                          {extremes && (
                            <g>
                              <circle
                                cx={xAt(extremes.maxIndex)}
                                cy={yAt(pts[extremes.maxIndex].value)}
                                r={3.8}
                                fill="#fb7185"
                                stroke="var(--surface)"
                                strokeWidth={1.2}
                              />
                              <text
                                x={xAt(extremes.maxIndex)}
                                y={Math.max(
                                  PAD_TOP + 10,
                                  yAt(pts[extremes.maxIndex].value) - 8
                                )}
                                textAnchor={
                                  xAt(extremes.maxIndex) > SVG_W - 120
                                    ? "end"
                                    : xAt(extremes.maxIndex) < PAD_LEFT + 80
                                      ? "start"
                                      : "middle"
                                }
                                fontSize={9.5}
                                fontWeight={600}
                                fontFamily="var(--font-mono)"
                                fill="var(--fg-rose-300)"
                              >
                                Peak{" "}
                                {formatTrendDate(
                                  pts[extremes.maxIndex].date,
                                  dateFormat,
                                  pts[extremes.maxIndex].t
                                )}
                              </text>

                              <circle
                                cx={xAt(extremes.minIndex)}
                                cy={yAt(pts[extremes.minIndex].value)}
                                r={3.8}
                                fill="#38bdf8"
                                stroke="var(--surface)"
                                strokeWidth={1.2}
                              />
                              <text
                                x={xAt(extremes.minIndex)}
                                y={Math.min(
                                  PAD_TOP + PLOT_H - 6,
                                  yAt(pts[extremes.minIndex].value) + 14
                                )}
                                textAnchor={
                                  xAt(extremes.minIndex) > SVG_W - 120
                                    ? "end"
                                    : xAt(extremes.minIndex) < PAD_LEFT + 80
                                      ? "start"
                                      : "middle"
                                }
                                fontSize={9.5}
                                fontWeight={600}
                                fontFamily="var(--font-mono)"
                                fill="var(--fg-sky-300)"
                              >
                                Low{" "}
                                {formatTrendDate(
                                  pts[extremes.minIndex].date,
                                  dateFormat,
                                  pts[extremes.minIndex].t
                                )}
                              </text>
                            </g>
                          )}

                          {/* Active Scrub Crosshair */}
                          {activePoint && (
                            <g>
                              <line
                                x1={xAt(activeScrubIdx)}
                                y1={PAD_TOP}
                                x2={xAt(activeScrubIdx)}
                                y2={PAD_TOP + PLOT_H}
                                stroke="var(--text-primary)"
                                strokeOpacity={0.35}
                                strokeWidth={1}
                              />
                              <circle
                                cx={xAt(activeScrubIdx)}
                                cy={yAt(activePoint.value)}
                                r={4.8}
                                fill="var(--surface)"
                                stroke={lineColor}
                                strokeWidth={2.2}
                              />
                            </g>
                          )}
                        </svg>

                        {/* Legend + Range Scrubber */}
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-2 text-[11px] text-text-muted">
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="inline-block h-0.5 w-3.5 rounded"
                                style={{ backgroundColor: lineColor }}
                                aria-hidden="true"
                              />
                              <span>
                                {effectiveMode === "anomaly"
                                  ? `Anomaly Δ (${singlePrepared.displayUnit})`
                                  : singlePrepared.effectiveResolution === "monthly"
                                    ? `Monthly Observed (${singlePrepared.displayUnit})`
                                    : `Observed (${singlePrepared.displayUnit})`}
                              </span>
                            </span>
                            {showSmooth && (
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  className="inline-block h-0.5 w-3.5 rounded bg-sky-400"
                                  aria-hidden="true"
                                />
                                <span>
                                  {singlePrepared.effectiveResolution === "monthly"
                                    ? "12-mo Rolling Mean"
                                    : "3-pt Rolling Mean"}
                                </span>
                              </span>
                            )}
                            {showTrendCi && (
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  className="inline-block w-3.5 border-t border-dashed border-text-primary"
                                  aria-hidden="true"
                                />
                                <span>Theil-Sen Trend &amp; 95% CI</span>
                              </span>
                            )}
                          </div>

                          {pts.length > 1 && (
                            <div className="flex min-w-[190px] flex-1 max-w-xs items-center gap-2">
                              <span className="shrink-0 text-[10px] text-text-subtle">
                                Scrub
                              </span>
                              <input
                                type="range"
                                aria-label="Scrub observation point over time"
                                className="etg-slider"
                                min={0}
                                max={pts.length - 1}
                                step={1}
                                value={activeScrubIdx}
                                style={
                                  {
                                    "--control-value": activeScrubIdx,
                                    "--slider-progress": `${sliderPct}%`,
                                  } as React.CSSProperties
                                }
                                onChange={(e) => setScrubIndex(Number(e.target.value))}
                              />
                            </div>
                          )}
                        </div>

                        {/* Full-Record Mini Range Navigator */}
                        <TrendRangeNavigatorStrip
                          points={unwindowed.points}
                          startDate={windowStartDate}
                          endDate={windowEndDate}
                          dateFormat={dateFormat}
                          lineColor={lineColor}
                          onSelectWindow={(start, end) => {
                            setWindowStartDate(start);
                            setWindowEndDate(end);
                            setScrubIndex(null);
                          }}
                        />
                      </div>

                      {/* Plain-English Interpretation & Key Metrics */}
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-[15px] font-semibold text-text-primary">
                              {digest.headline}
                            </h3>
                            <span
                              className={`rounded-sm border px-2 py-0.5 text-[10.5px] font-semibold ${
                                digest.isSignificant
                                  ? digest.tone === "rising"
                                    ? "border-rose-400 bg-rose-950 text-rose-300"
                                    : "border-sky-400 bg-sky-950 text-sky-300"
                                  : "border-border bg-surface-band text-text-subtle"
                              }`}
                            >
                              {dirSymbol} {digest.certaintyLabel}
                            </span>
                            {isWindowed && (
                              <span className="rounded-sm border border-accent-fg bg-amber-950/60 px-2 py-0.5 text-[10.5px] font-medium text-amber-200">
                                Custom Window
                              </span>
                            )}
                            {fullDigest && (
                              <span className="ws-numeric rounded-sm border border-border bg-surface-inset px-2 py-0.5 font-mono text-[10px] text-text-subtle">
                                Full record: {fullDigest.ratePerDecade}
                              </span>
                            )}
                            {digest.isProxy && (
                              <span className="rounded-sm border border-amber-400 bg-amber-950 px-2 py-0.5 text-[10.5px] font-medium text-amber-300">
                                Meteorological Proxy
                              </span>
                            )}
                          </div>
                          <span className="ws-numeric font-mono text-[11px] text-text-subtle">
                            {pts.length >= 2
                              ? `${formatTrendDate(pts[0].date, dateFormat, pts[0].t)} – ${formatTrendDate(pts[pts.length - 1].date, dateFormat, pts[pts.length - 1].t)}`
                              : digest.periodRange}{" "}
                            ({pts.length} pts)
                          </span>
                        </div>

                        <p className="text-[12px] leading-relaxed text-text-muted">
                          {digest.summarySentence}
                        </p>
                        {digest.isProxy && digest.proxyNote && (
                          <p className="rounded-sm border border-amber-400/70 bg-amber-950/40 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                            {digest.proxyNote}
                          </p>
                        )}

                        <div className="ws-numeric grid grid-cols-2 gap-2 font-mono sm:grid-cols-4">
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Recent
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {digest.latestFormatted}
                            </span>
                          </div>
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Mean (Δ)
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {digest.meanFormatted}{" "}
                              <span className="text-[11px] font-normal text-text-muted">
                                ({digest.anomalyFormatted})
                              </span>
                            </span>
                          </div>
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Rate / Decade
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {digest.ratePerDecade}
                            </span>
                          </div>
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Range (Min–Max)
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {digest.rangeFormatted}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Statistical Rigor Grid */}
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="ws-inset space-y-1 p-2.5 font-mono text-[11px]">
                          <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                            Mann-Kendall Trend Test
                          </div>
                          <div className="ws-numeric text-text-primary">
                            p ={" "}
                            {summary.mannKendall.pValue < 0.0001
                              ? "< 0.0001"
                              : summary.mannKendall.pValue.toFixed(4)}
                          </div>
                          <div className="ws-numeric text-text-muted">
                            τ = {summary.mannKendall.tau.toFixed(3)} · Z ={" "}
                            {summary.mannKendall.zScore.toFixed(2)} · n ={" "}
                            {summary.mannKendall.n}
                          </div>
                        </div>

                        <div className="ws-inset space-y-1 p-2.5 font-mono text-[11px]">
                          <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                            Hamed-Rao Serial Adjustment
                          </div>
                          <div className="ws-numeric text-text-primary">
                            p* ={" "}
                            {summary.mannKendall.pValueAdjusted < 0.0001
                              ? "< 0.0001"
                              : summary.mannKendall.pValueAdjusted.toFixed(4)}
                          </div>
                          <div className="ws-numeric text-text-muted">
                            N* = {summary.mannKendall.effectiveSampleSize.toFixed(1)} ·
                            r₁ = {summary.mannKendall.lag1Autocorrelation.toFixed(2)}
                          </div>
                        </div>

                        <div className="ws-inset space-y-1 p-2.5 font-mono text-[11px]">
                          <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                            Theil-Sen Robust Slope
                          </div>
                          <div className="ws-numeric text-text-primary">
                            {dispSlope >= 0 ? "+" : ""}
                            {dispSlope.toFixed(4)} {singlePrepared.displaySlopeUnit}
                          </div>
                          <div className="ws-numeric text-text-muted">
                            95% CI [{dispLow95.toFixed(3)}, {dispHigh95.toFixed(3)}] ·{" "}
                            {summary.theilSen.pairCount} pairs
                          </div>
                        </div>

                        {summary.seasonalAnalysis && dispSeasonalSlope !== null && (
                          <div className="ws-inset space-y-1 p-2.5 font-mono text-[11px]">
                            <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                              Seasonal MK (Hirsch-Slack)
                            </div>
                            <div className="ws-numeric text-text-primary">
                              Seasonal p ={" "}
                              {summary.seasonalAnalysis.pValue < 0.0001
                                ? "< 0.0001"
                                : summary.seasonalAnalysis.pValue.toFixed(4)}
                            </div>
                            <div className="ws-numeric text-text-muted">
                              {dispSeasonalSlope >= 0 ? "+" : ""}
                              {dispSeasonalSlope.toFixed(4)}{" "}
                              {singlePrepared.displaySlopeUnit} (
                              {summary.seasonalAnalysis.seasonsDetected} seasons)
                            </div>
                          </div>
                        )}

                        <div className="ws-inset space-y-1 p-2.5 font-mono text-[11px]">
                          <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                            OLS Fit &amp; Pettitt Shift
                          </div>
                          <div className="ws-numeric text-text-primary">
                            OLS R² = {summary.ols.rSquared.toFixed(2)} · p ={" "}
                            {summary.ols.pValue < 0.0001
                              ? "< 0.0001"
                              : summary.ols.pValue.toFixed(4)}
                          </div>
                          <div className="ws-numeric text-text-muted">
                            {summary.changePoint?.significant
                              ? `Regime shift ${formatTrendDate(summary.changePoint.date, dateFormat)} (K=${Math.round(summary.changePoint.kStat)})`
                              : "No significant Pettitt break"}
                          </div>
                        </div>
                      </div>

                      {/* Provenance & Actions */}
                      {(() => {
                        const itemMatchesSelectedNode = Boolean(
                          selectedNode && activeItem.side !== "b"
                        );
                        return (
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-subtle">
                                {summary.provenance}
                              </span>
                              <a
                                href={
                                  buildExternalExplorerLinks(
                                    summary.lat,
                                    summary.lng,
                                    summary.dataset
                                  ).giovanniUrl
                                }
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-sky-400 hover:underline"
                              >
                                <span>NASA Giovanni</span>
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                              </a>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={handleDownloadCsv}
                                className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                              >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Download CSV</span>
                              </button>

                              {onSaveToGraph && !itemMatchesSelectedNode && (
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void handleSaveGraphNode(summary)}
                                  className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                                >
                                  <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                  <span>{saving ? "Saving…" : "Save to Graph"}</span>
                                </button>
                              )}

                              {itemMatchesSelectedNode &&
                                selectedNode &&
                                onOpenInGraphWorkbench && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      dialogRef.current?.close("workbench");
                                      onOpenInGraphWorkbench(selectedNode.uuid);
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-sm border border-accent-fg bg-amber-950 px-3 py-1.5 text-[11px] font-medium text-amber-200 hover:border-amber-300 cursor-pointer"
                                  >
                                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                                    <span>Open in Graph Workbench</span>
                                  </button>
                                )}
                            </div>
                          </div>
                        );
                      })()}

                      {saveMessage && (
                        <div
                          role="status"
                          className="text-[11px] font-medium text-emerald-400"
                        >
                          {saveMessage}
                        </div>
                      )}

                      {/* Collapsible Date-Searchable Observation Data Table */}
                      <details className="etg-details">
                        <summary>
                          Timestamped observations ({tableRows.length} rows ·{" "}
                          {singlePrepared.displayUnit})
                        </summary>
                        <div className="space-y-2 border-t border-border-subtle p-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="relative min-w-[180px] flex-1 max-w-xs">
                              <Search
                                className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle"
                                aria-hidden="true"
                              />
                              <input
                                type="search"
                                aria-label="Search observation dates"
                                placeholder="Filter dates (e.g. 2013 or Jul)..."
                                value={tableSearch}
                                onChange={(e) => setTableSearch(e.target.value)}
                                className="form-input pl-7 text-[11px]"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => setTableSortAsc((v) => !v)}
                              className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset px-2 py-1 text-[10.5px] font-medium text-text-muted hover:text-text-primary cursor-pointer"
                            >
                              <ArrowDownUp className="h-3 w-3" aria-hidden="true" />
                              <span>
                                {tableSortAsc ? "Oldest first" : "Newest first"}
                              </span>
                            </button>
                          </div>

                          <div
                            className="etg-table-region"
                            tabIndex={0}
                            role="region"
                            aria-label="Detailed trend observation rows"
                            style={
                              {
                                "--col-2": '"Observed"',
                                "--col-3": '"Smooth"',
                                "--col-4": '"Trend Fit"',
                                "--col-5": '"Anomaly Δ"',
                              } as React.CSSProperties
                            }
                          >
                            <table>
                              <thead>
                                <tr>
                                  <th scope="col">Date</th>
                                  <th scope="col">
                                    Observed ({singlePrepared.displayUnit})
                                  </th>
                                  <th scope="col">Smooth</th>
                                  <th scope="col">Trend Fit</th>
                                  <th scope="col">Anomaly Δ</th>
                                </tr>
                              </thead>
                              <tbody>
                                {tableRows.map((row) => {
                                  const isPinned = pinnedDates.includes(row.date);
                                  return (
                                    <tr
                                      key={row.date}
                                      onClick={() => {
                                        const idx = pts.findIndex(
                                          (p) => p.date === row.date
                                        );
                                        if (idx >= 0) setScrubIndex(idx);
                                        handleTogglePinDate(row.date);
                                      }}
                                      title="Click row to jump & pin this date on the chart"
                                      className={`cursor-pointer transition-colors hover:bg-surface-band ${
                                        isPinned ? "bg-amber-950/35" : ""
                                      }`}
                                    >
                                      <th scope="row" className="font-mono">
                                        {formatTrendDate(row.date, dateFormat, row.t)}
                                      </th>
                                      <td className="font-mono">
                                        {formatMetricVal(row.value, 3)}
                                      </td>
                                      <td className="font-mono">
                                        {formatMetricVal(row.smooth, 3)}
                                      </td>
                                      <td className="font-mono">
                                        {formatMetricVal(row.trendFit, 3)}
                                      </td>
                                      <td className="font-mono">
                                        {formatSignedVal(row.anomaly, 3)}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </details>
                    </div>
                  );
                })()
              ) : activeItem.kind === "compare" && compareContext ? (
                (() => {
                  const {
                    effectiveComparison,
                    isWindowed,
                    tooFewPoints,
                    prepared: comparePrepared,
                    availablePoints,
                  } = compareContext;
                  const {
                    points: pts,
                    effectiveMode,
                    canCompareDeseasonalized,
                  } = comparePrepared;
                  const compDigest = describeComparisonPlainly(
                    effectiveComparison,
                    activeItem.labelA,
                    activeItem.labelB
                  );
                  const yTicks = computeNiceTicks(
                    comparePrepared.minY,
                    comparePrepared.maxY,
                    5
                  );
                  const yMin = Math.min(comparePrepared.minY, yTicks[0]);
                  const yMax = Math.max(
                    comparePrepared.maxY,
                    yTicks[yTicks.length - 1]
                  );
                  const ySpan = Math.max(1e-6, yMax - yMin);
                  const xAt = (idx: number) =>
                    PAD_LEFT + (idx / Math.max(1, pts.length - 1)) * PLOT_W;
                  const yAt = (val: number) =>
                    PAD_TOP + PLOT_H - ((val - yMin) / ySpan) * PLOT_H;
                  const pathA = pts
                    .map(
                      (p, i) =>
                        `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zA).toFixed(1)}`
                    )
                    .join(" ");
                  const pathB = pts
                    .map(
                      (p, i) =>
                        `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zB).toFixed(1)}`
                    )
                    .join(" ");
                  const activeScrubIdx =
                    scrubIndex !== null && scrubIndex >= 0 && scrubIndex < pts.length
                      ? scrubIndex
                      : Math.max(0, pts.length - 1);
                  const activePt = pts[activeScrubIdx] ?? null;
                  const xTickIndices = pickXAxisTickIndices(
                    pts.length,
                    denseDates ? 12 : 7
                  );
                  const sliderPct =
                    pts.length > 1
                      ? ((activeScrubIdx / (pts.length - 1)) * 100).toFixed(1)
                      : "100";

                  const brushLo = dragBrush
                    ? Math.min(dragBrush.anchorIdx, dragBrush.currentIdx)
                    : 0;
                  const brushHi = dragBrush
                    ? Math.max(dragBrush.anchorIdx, dragBrush.currentIdx)
                    : 0;

                  const pinnedResolved = pinnedDates
                    .map((d) => {
                      const idx = pts.findIndex((p) => p.date === d);
                      return idx >= 0 ? { idx, pt: pts[idx] } : null;
                    })
                    .filter((item): item is NonNullable<typeof item> => item !== null);

                  return (
                    <div className="space-y-3.5 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div
                          className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset p-0.5"
                          role="group"
                          aria-label="Comparison normalization mode"
                        >
                          <button
                            type="button"
                            aria-pressed={effectiveMode === "raw"}
                            onClick={() => setCompareMode("raw")}
                            className={`rounded-xs px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                              effectiveMode === "raw"
                                ? "bg-surface-elevated text-text-primary"
                                : "text-text-muted hover:text-text-primary"
                            }`}
                          >
                            Normalized Z-Score
                          </button>
                          {canCompareDeseasonalized && (
                            <button
                              type="button"
                              aria-pressed={effectiveMode === "anomaly"}
                              onClick={() => setCompareMode("anomaly")}
                              className={`rounded-xs px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                                effectiveMode === "anomaly"
                                  ? "bg-surface-elevated text-text-primary"
                                  : "text-text-muted hover:text-text-primary"
                              }`}
                            >
                              Deseasonalized Z-Score
                            </button>
                          )}
                          <button
                            type="button"
                            aria-pressed={effectiveMode === "detrended"}
                            onClick={() => setCompareMode("detrended")}
                            className={`rounded-xs px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                              effectiveMode === "detrended"
                                ? "bg-surface-elevated text-text-primary"
                                : "text-text-muted hover:text-text-primary"
                            }`}
                          >
                            Detrended Z-Score
                          </button>
                        </div>

                        <span className="text-[11px] text-text-subtle">
                          Switch to Spot A or Spot B tabs above for individual unit charts
                        </span>
                      </div>

                      <TrendDateControlsBar
                        availablePoints={availablePoints}
                        activeStartDate={windowStartDate}
                        activeEndDate={windowEndDate}
                        isWindowed={isWindowed}
                        onSelectWindow={(start, end) => {
                          setWindowStartDate(start);
                          setWindowEndDate(end);
                          setScrubIndex(null);
                        }}
                        onResetWindow={handleResetWindow}
                        changePointDate={
                          effectiveComparison.sharedRegimeShiftYear
                            ? String(effectiveComparison.sharedRegimeShiftYear)
                            : null
                        }
                        showSeasonFilter={false}
                        seasonFilter={seasonFilter}
                        onChangeSeasonFilter={setSeasonFilter}
                        dateFormat={dateFormat}
                        onChangeDateFormat={setDateFormat}
                        denseDates={denseDates}
                        onToggleDenseDates={() => setDenseDates((v) => !v)}
                        showExtremeDates={showExtremeDates}
                        onToggleExtremeDates={() => setShowExtremeDates((v) => !v)}
                        showPointControls={true}
                        showExtremeToggle={false}
                        activePointDate={activePt?.date ?? null}
                        activePointT={activePt?.t}
                        activePointIndex={activeScrubIdx}
                        activePointCount={pts.length}
                        onStepPoint={(delta) => {
                          const next = Math.max(
                            0,
                            Math.min(pts.length - 1, activeScrubIdx + delta)
                          );
                          setScrubIndex(next);
                        }}
                        pinnedDates={pinnedDates}
                        onTogglePinActiveDate={() => {
                          if (activePt) handleTogglePinDate(activePt.date);
                        }}
                        onClearPins={() => setPinnedDates([])}
                      />

                      {tooFewPoints && (
                        <div
                          role="status"
                          className="rounded-sm border border-amber-400/50 bg-amber-950/35 px-2.5 py-1 text-[11px] text-amber-200"
                        >
                          Selected date slice has fewer than 3 overlapping observations — displaying full comparison.
                        </div>
                      )}

                      <ComparisonPinnedDateBanner
                        pinnedPoints={pinnedResolved.map((p) => p.pt)}
                        labelA={activeItem.labelA}
                        labelB={activeItem.labelB}
                        unitA={comparePrepared.unitA}
                        unitB={comparePrepared.unitB}
                        dateFormat={dateFormat}
                        onRemovePin={(d) => handleTogglePinDate(d)}
                        onClearPins={() => setPinnedDates([])}
                      />

                      <div className="ws-inset space-y-2 rounded-md p-3">
                        {activePt && (
                          <div className="ws-numeric flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-2 font-mono text-[11px]">
                            <span className="font-semibold text-text-primary">
                              {formatTrendDate(activePt.date, dateFormat)}
                            </span>
                            <div className="flex flex-wrap items-center gap-4">
                              <span className="text-amber-300">
                                A ({activeItem.labelA}): {activePt.rawAFormatted} (
                                {formatSignedVal(activePt.zA, 2)}σ)
                              </span>
                              <span className="text-sky-300">
                                B ({activeItem.labelB}): {activePt.rawBFormatted} (
                                {formatSignedVal(activePt.zB, 2)}σ)
                              </span>
                            </div>
                          </div>
                        )}

                        <svg
                          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                          className="h-auto w-full cursor-crosshair touch-pan-y select-none"
                          role="img"
                          aria-label={`Comparison chart between ${activeItem.labelA} and ${activeItem.labelB}`}
                          onPointerDown={(e) => {
                            if (e.button !== 0 || pts.length < 2) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const idx = pointerClientXToIndex(
                              e.clientX,
                              rect.left,
                              rect.width,
                              SVG_W,
                              PAD_LEFT,
                              PLOT_W,
                              pts.length
                            );
                            pointerDownRef.current = {
                              x: e.clientX,
                              y: e.clientY,
                              idx,
                              pointerId: e.pointerId,
                            };
                            setDragBrush({ anchorIdx: idx, currentIdx: idx, moved: false });
                          }}
                          onPointerMove={(e) => {
                            if (pts.length <= 1) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const idx = pointerClientXToIndex(
                              e.clientX,
                              rect.left,
                              rect.width,
                              SVG_W,
                              PAD_LEFT,
                              PLOT_W,
                              pts.length
                            );
                            setScrubIndex(idx);
                            const down = pointerDownRef.current;
                            if (down) {
                              const moved = Math.abs(e.clientX - down.x) >= 6;
                              if (moved) {
                                try {
                                  e.currentTarget.setPointerCapture?.(down.pointerId);
                                } catch {
                                  // Ignore pointer capture errors
                                }
                              }
                              setDragBrush((prev) => ({
                                anchorIdx: down.idx,
                                currentIdx: idx,
                                moved: Boolean(prev?.moved || moved),
                              }));
                            }
                          }}
                          onPointerUp={(e) => {
                            const down = pointerDownRef.current;
                            if (!down) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const idx = pointerClientXToIndex(
                              e.clientX,
                              rect.left,
                              rect.width,
                              SVG_W,
                              PAD_LEFT,
                              PLOT_W,
                              pts.length
                            );
                            const moved =
                              Boolean(dragBrush?.moved) ||
                              Math.abs(e.clientX - down.x) >= 6;
                            if (moved) {
                              const lo = Math.min(down.idx, idx);
                              const hi = Math.max(down.idx, idx);
                              if (hi - lo + 1 >= Math.min(3, pts.length)) {
                                setWindowStartDate(pts[lo].date);
                                setWindowEndDate(pts[hi].date);
                                setScrubIndex(null);
                              }
                            } else {
                              const clicked = pts[idx];
                              if (clicked) handleTogglePinDate(clicked.date);
                            }
                            pointerDownRef.current = null;
                            setDragBrush(null);
                          }}
                          onPointerCancel={() => {
                            pointerDownRef.current = null;
                            setDragBrush(null);
                          }}
                          onPointerLeave={() => {
                            if (!pointerDownRef.current) setScrubIndex(null);
                          }}
                        >
                          {yTicks.map((tick) => {
                            const ty = yAt(tick);
                            return (
                              <g key={tick}>
                                <line
                                  x1={PAD_LEFT}
                                  y1={ty}
                                  x2={SVG_W - PAD_RIGHT}
                                  y2={ty}
                                  stroke="var(--border-subtle)"
                                  strokeWidth={1}
                                />
                                <text
                                  x={PAD_LEFT - 8}
                                  y={ty + 3.5}
                                  textAnchor="end"
                                  fontSize={10.5}
                                  fontFamily="var(--font-mono)"
                                  fill="var(--text-subtle)"
                                >
                                  {formatAxisTick(tick, ySpan)}σ
                                </text>
                              </g>
                            );
                          })}

                          <line
                            x1={PAD_LEFT}
                            y1={yAt(0)}
                            x2={SVG_W - PAD_RIGHT}
                            y2={yAt(0)}
                            stroke="var(--border-strong)"
                            strokeDasharray="3 4"
                            strokeWidth={1}
                          />

                          {xTickIndices.map((idx) => {
                            const pt = pts[idx];
                            if (!pt) return null;
                            const tx = xAt(idx);
                            return (
                              <g key={`${idx}-${pt.date}`}>
                                {denseDates && (
                                  <line
                                    x1={tx}
                                    y1={PAD_TOP}
                                    x2={tx}
                                    y2={PAD_TOP + PLOT_H}
                                    stroke="var(--border-subtle)"
                                    strokeDasharray="2 3"
                                    strokeWidth={1}
                                  />
                                )}
                                <text
                                  x={tx}
                                  y={SVG_H - 12}
                                  textAnchor={
                                    idx === 0
                                      ? "start"
                                      : idx === pts.length - 1
                                        ? "end"
                                        : "middle"
                                  }
                                  fontSize={denseDates ? 9.5 : 10.5}
                                  fontFamily="var(--font-mono)"
                                  fill="var(--text-subtle)"
                                >
                                  {formatTrendDate(pt.date, dateFormat)}
                                </text>
                              </g>
                            );
                          })}

                          {dragBrush?.moved && (
                            <rect
                              x={xAt(brushLo)}
                              y={PAD_TOP}
                              width={Math.max(4, xAt(brushHi) - xAt(brushLo))}
                              height={PLOT_H}
                              fill="var(--accent)"
                              fillOpacity={0.18}
                            />
                          )}

                          {pinnedResolved.map((pin, pIdx) => {
                            const px = xAt(pin.idx);
                            return (
                              <g key={`cmp-pin-${pin.pt.date}`}>
                                <line
                                  x1={px}
                                  y1={PAD_TOP}
                                  x2={px}
                                  y2={PAD_TOP + PLOT_H}
                                  stroke="#fbbf24"
                                  strokeDasharray="2 2"
                                  strokeWidth={1.3}
                                />
                                <text
                                  x={px}
                                  y={PAD_TOP + 12}
                                  textAnchor={px > SVG_W - 90 ? "end" : "start"}
                                  fontSize={9.5}
                                  fontWeight={700}
                                  fontFamily="var(--font-mono)"
                                  fill="var(--fg-amber-300)"
                                >
                                  {pIdx === 0 ? "Pin A" : "Pin B"}:{" "}
                                  {formatTrendDate(pin.pt.date, dateFormat)}
                                </text>
                              </g>
                            );
                          })}

                          <path
                            d={pathA}
                            fill="none"
                            stroke="#facc15"
                            strokeWidth={effectiveMode === "anomaly" ? 1.6 : 2}
                            strokeLinecap="round"
                          />
                          <path
                            d={pathB}
                            fill="none"
                            stroke="#38bdf8"
                            strokeWidth={effectiveMode === "anomaly" ? 1.6 : 2}
                            strokeLinecap="round"
                          />

                          {activePt && (
                            <g>
                              <line
                                x1={xAt(activeScrubIdx)}
                                y1={PAD_TOP}
                                x2={xAt(activeScrubIdx)}
                                y2={PAD_TOP + PLOT_H}
                                stroke="var(--text-primary)"
                                strokeOpacity={0.35}
                              />
                              <circle
                                cx={xAt(activeScrubIdx)}
                                cy={yAt(activePt.zA)}
                                r={4.2}
                                fill="var(--surface)"
                                stroke="#facc15"
                                strokeWidth={2}
                              />
                              <circle
                                cx={xAt(activeScrubIdx)}
                                cy={yAt(activePt.zB)}
                                r={4.2}
                                fill="var(--surface)"
                                stroke="#38bdf8"
                                strokeWidth={2}
                              />
                            </g>
                          )}
                        </svg>

                        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-2 text-[11px] text-text-muted">
                          <div className="flex flex-wrap items-center gap-4">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="h-2 w-2 rounded-full bg-amber-400"
                                aria-hidden="true"
                              />
                              <span>{activeItem.labelA}</span>
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="h-2 w-2 rounded-full bg-sky-400"
                                aria-hidden="true"
                              />
                              <span>{activeItem.labelB}</span>
                            </span>
                          </div>
                          {pts.length > 1 && (
                            <div className="flex min-w-[190px] flex-1 max-w-xs items-center gap-2">
                              <span className="shrink-0 text-[10px] text-text-subtle">
                                Scrub
                              </span>
                              <input
                                type="range"
                                aria-label="Scrub comparison timeline point"
                                className="etg-slider"
                                min={0}
                                max={pts.length - 1}
                                step={1}
                                value={activeScrubIdx}
                                style={
                                  {
                                    "--control-value": activeScrubIdx,
                                    "--slider-progress": `${sliderPct}%`,
                                  } as React.CSSProperties
                                }
                                onChange={(e) => setScrubIndex(Number(e.target.value))}
                              />
                            </div>
                          )}
                        </div>

                        <TrendRangeNavigatorStrip
                          points={availablePoints}
                          startDate={windowStartDate}
                          endDate={windowEndDate}
                          dateFormat={dateFormat}
                          lineColor="#38bdf8"
                          onSelectWindow={(start, end) => {
                            setWindowStartDate(start);
                            setWindowEndDate(end);
                            setScrubIndex(null);
                          }}
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] font-semibold text-text-primary">
                            {compDigest.badgeLabel} · {compDigest.strengthLabel}
                          </span>
                          {isWindowed && (
                            <span className="rounded-sm border border-accent-fg bg-amber-950/60 px-2 py-0.5 text-[10.5px] font-medium text-amber-200">
                              Custom Window
                            </span>
                          )}
                          <span className="text-[14px] font-semibold text-text-primary">
                            {compDigest.headline}
                          </span>
                        </div>
                        <p className="text-[12px] leading-relaxed text-text-muted">
                          {compDigest.explanation} {compDigest.timingNote}
                        </p>
                        <div className="ws-numeric grid grid-cols-2 gap-2 font-mono sm:grid-cols-4">
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Pearson r
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {formatSignedVal(effectiveComparison.pearsonR, 2)} (p=
                              {effectiveComparison.pValue < 0.0001
                                ? "<0.0001"
                                : effectiveComparison.pValue.toFixed(4)}
                              )
                            </span>
                          </div>
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Detrended r*
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {formatSignedVal(effectiveComparison.detrendedR, 2)}
                            </span>
                          </div>
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Optimal Lag
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {effectiveComparison.optimalLagSteps}{" "}
                              {effectiveComparison.lagUnit}
                            </span>
                          </div>
                          <div className="ws-inset p-2.5">
                            <span className="block font-sans text-[10px] uppercase text-text-subtle">
                              Shared Shift
                            </span>
                            <span className="mt-0.5 block text-sm font-semibold text-text-primary">
                              {effectiveComparison.sharedRegimeShiftYear ?? "—"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : null}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
