"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { VariableGuidePopoverButton } from "@/components/DatasetSelector";
import {
  Activity,
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Droplets,
  Gauge,
  GitBranch,
  GitCompare,
  LayoutGrid,
  List,
  MapPin,
  PlusCircle,
  Radio,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  TrendingDown,
  TrendingUp,
  Wind,
  X,
} from "lucide-react";
import {
  buildExternalExplorerLinks,
  DATASET_BY_ID,
  EARTH_TREND_DATASETS,
} from "@/lib/datasets";
import {
  convertSlopeUnitLabel,
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  formatTemperatureDelta,
  formatTemperatureValue,
  isTemperatureUnitString,
} from "@/lib/earth/currentConditionsClient";
import {
  ALL_RELATION_CATEGORIES,
  RELATION_CATEGORY_META,
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
  CurrentEarthConditions,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  GraphPredictionResult,
  NodeTrendMicroscopeCue,
  RelationCategory,
  TelemetryFailureKind,
  TelemetryQueryDiagnostics,
  TemperatureUnit,
  TrendAnalysisSummary,
  TrendMicroscopeRadarBadge,
  TrendMicroscopeScanResult,
} from "@/types/etg";

interface SpotViewPrefs {
  showCurrent: boolean;
  showTrends: boolean;
  showRelations: boolean;
  showChart: boolean;
  showScience: boolean;
  trendLayout: "cards" | "table";
  showWindHumidity: boolean;
  showAirUv: boolean;
  showPressureSolar: boolean;
}

const DEFAULT_SPOT_VIEW_PREFS: SpotViewPrefs = {
  showCurrent: true,
  showTrends: true,
  showRelations: true,
  showChart: true,
  showScience: false,
  trendLayout: "cards",
  showWindHumidity: true,
  showAirUv: true,
  showPressureSolar: true,
};

const SPOT_VIEW_PREFS_KEY = "etg:spot-view-prefs:v2";

export interface GuidedCaseStudyItem {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  dataset: ETGDatasetId;
  spotAName?: string;
  spotBName?: string;
  spotACoord?: { lat: number; lng: number };
  spotBCoord?: { lat: number; lng: number };
}

interface CompactSpotCardProps {
  selectedNode: ETGNode | null;
  selectedEdge: ETGEdge | null;
  sourceNode: ETGNode | null;
  targetNode: ETGNode | null;
  allNodes: ETGNode[];
  allEdges: ETGEdge[];
  visibleNodes: ETGNode[];
  microscopeScan?: TrendMicroscopeScanResult | null;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  probedCoord: { lat: number; lng: number } | null;
  primary: TrendAnalysisSummary | null;
  secondary: TrendAnalysisSummary | null;
  summaries: TrendAnalysisSummary[];
  focusedSummaryDataset: ETGDatasetId | null;
  comparison: CrossRegionComparison | null;
  current?: CurrentEarthConditions | null;
  secondaryCurrent?: CurrentEarthConditions | null;
  tempUnit?: TemperatureUnit;
  onChangeTempUnit?: (unit: TemperatureUnit) => void;
  mobileCollapsed?: boolean;
  onToggleMobileCollapse?: () => void;
  enabledRelationCategories?: ReadonlyArray<RelationCategory>;
  compareMode: boolean;
  comparePending?: boolean;
  activeTopics: ETGDatasetId[];
  loading: boolean;
  error: string | null;
  diagnostics?: TelemetryQueryDiagnostics | null;
  failureKind?: TelemetryFailureKind | null;
  onRetry?: () => void;
  discoverBusy?: boolean;
  guidedCases?: ReadonlyArray<GuidedCaseStudyItem>;
  activeCaseStudyId?: string | null;
  onSelectCaseStudy?: (caseId: string) => void;
  onToggleTopic: (ds: ETGDatasetId) => void;
  onResetTopics: () => void;
  onFocusSummaryDataset: (ds: ETGDatasetId) => void;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onCompareOpposite: (nodeA: ETGNode, nodeB: ETGNode) => void;
  onToggleCompareMode: () => void;
  onSwapPins: () => void;
  onClearComparison: () => void;
  onDiscoverGlobalTrends?: () => void;
  onCommitToGraph: (summary: TrendAnalysisSummary) => Promise<void>;
  onCommitRelation: (payload: {
    primary: TrendAnalysisSummary;
    secondary: TrendAnalysisSummary;
    comparison: CrossRegionComparison;
    sourceNodeUuid?: string;
    targetNodeUuid?: string;
  }) => Promise<void>;
  onOpenInGraphWorkbench?: (nodeUuid: string) => void;
  onGraphUpdated: () => Promise<void>;
  onClose: () => void;
}

function relationCategoryStyles(cat: RelationCategory): {
  badge: string;
  dot: string;
} {
  switch (cat) {
    case "opposite":
      return {
        badge: "border-rose-400/70 bg-rose-950 text-rose-300",
        dot: "#fb7185",
      };
    case "causal":
      return {
        badge: "border-emerald-400/70 bg-emerald-950 text-emerald-300",
        dot: "#34d399",
      };
    case "coupled":
      return {
        badge: "border-sky-400/70 bg-sky-950 text-sky-300",
        dot: "#38bdf8",
      };
    case "corroboration":
      return {
        badge: "border-violet-400/70 bg-violet-950 text-violet-300",
        dot: "#a78bfa",
      };
  }
}

function summaryKey(s: Pick<TrendAnalysisSummary, "dataset" | "parameter">): string {
  return `${s.dataset}:${s.parameter}`;
}

function formatObservedStamp(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/);
  if (m) return `${m[1]} local`;
  return iso.slice(0, 10);
}

function MiniSparkline({
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

function SpotTrendChart({
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
    const pts = comparison.alignedPoints;
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

    return (
      <div className="ws-inset space-y-2 rounded-md p-3">
        <div className="flex items-center justify-between text-[11px] text-text-subtle">
          <span className="font-medium text-text-primary">How the two spots move over time</span>
          <span className="ws-numeric">
            {pts[0]?.date}–{pts[pts.length - 1]?.date}
          </span>
        </div>
        {focusSwitcher}
        <svg viewBox={`0 0 ${w} ${h}`} className="h-[118px] w-full" aria-describedby={chartDescId}>
          <line
            x1={padX}
            y1={yAt(0)}
            x2={w - padX}
            y2={yAt(0)}
            stroke="var(--border-strong)"
            strokeDasharray="3 3"
          />
          <path d={pathA} fill="none" stroke="#facc15" strokeWidth={2} strokeLinecap="round" />
          <path d={pathB} fill="none" stroke="#38bdf8" strokeWidth={2} strokeLinecap="round" />
        </svg>
        <p id={chartDescId} className="sr-only">
          Comparison chart showing normalized changes over time for {labelA} and {labelB}.
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
          {(summary?.seasonalAnalysis || secondarySummary?.seasonalAnalysis) && (
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

export function CompactSpotCard({
  selectedNode,
  selectedEdge,
  sourceNode,
  targetNode,
  allNodes,
  allEdges,
  visibleNodes,
  microscopeScan = null,
  microscopeByNode,
  probedCoord,
  primary,
  secondary,
  summaries,
  focusedSummaryDataset,
  comparison,
  current = null,
  secondaryCurrent = null,
  tempUnit = "C",
  onChangeTempUnit,
  mobileCollapsed = false,
  onToggleMobileCollapse,
  enabledRelationCategories,
  compareMode,
  comparePending = false,
  activeTopics,
  loading,
  error,
  diagnostics = null,
  failureKind = null,
  onRetry,
  discoverBusy = false,
  guidedCases,
  activeCaseStudyId = null,
  onSelectCaseStudy,
  onToggleTopic,
  onResetTopics,
  onFocusSummaryDataset,
  onSelectNode,
  onSelectEdge,
  onCompareOpposite,
  onToggleCompareMode,
  onSwapPins,
  onClearComparison,
  onDiscoverGlobalTrends,
  onCommitToGraph,
  onCommitRelation,
  onOpenInGraphWorkbench,
  onGraphUpdated,
  onClose,
}: CompactSpotCardProps) {
  const [prefs, setPrefs] = useState<SpotViewPrefs>(DEFAULT_SPOT_VIEW_PREFS);
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [localRelationFilter, setLocalRelationFilter] = useState<
    "all" | RelationCategory
  >("all");
  const [committing, setCommitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Hypothesis revision state (inside Stats & Sources drawer)
  const [showReviseForm, setShowReviseForm] = useState(false);
  const [revName, setRevName] = useState("");
  const [revDesc, setRevDesc] = useState("");
  const [revRationale, setRevRationale] = useState("");
  const [focusedSummaryKey, setFocusedSummaryKey] = useState<string | null>(null);

  // Regional Multi-Scale Graph Forecast state (via /api/graph/predict)
  const [spotPrediction, setSpotPrediction] = useState<GraphPredictionResult | null>(null);
  const [spotPredLoading, setSpotPredLoading] = useState(false);
  const [spotPredError, setSpotPredError] = useState<string | null>(null);
  const forecastAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      forecastAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SPOT_VIEW_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SpotViewPrefs>;
        setPrefs((prev) => ({
          showCurrent:
            typeof parsed.showCurrent === "boolean" ? parsed.showCurrent : prev.showCurrent,
          showTrends:
            typeof parsed.showTrends === "boolean" ? parsed.showTrends : prev.showTrends,
          showRelations:
            typeof parsed.showRelations === "boolean" ? parsed.showRelations : prev.showRelations,
          showChart:
            typeof parsed.showChart === "boolean" ? parsed.showChart : prev.showChart,
          showScience:
            typeof parsed.showScience === "boolean" ? parsed.showScience : prev.showScience,
          trendLayout:
            parsed.trendLayout === "table" || parsed.trendLayout === "cards"
              ? parsed.trendLayout
              : prev.trendLayout,
          showWindHumidity:
            typeof parsed.showWindHumidity === "boolean"
              ? parsed.showWindHumidity
              : prev.showWindHumidity,
          showAirUv:
            typeof parsed.showAirUv === "boolean" ? parsed.showAirUv : prev.showAirUv,
          showPressureSolar:
            typeof parsed.showPressureSolar === "boolean"
              ? parsed.showPressureSolar
              : prev.showPressureSolar,
        }));
      }
    } catch {
      // Ignore storage errors
    } finally {
      setPrefsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      window.localStorage.setItem(SPOT_VIEW_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage errors
    }
  }, [prefsHydrated, prefs]);

  const updatePref = <K extends keyof SpotViewPrefs>(key: K, value: SpotViewPrefs[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  const selectionKey =
    selectedEdge?.properties.uuid ??
    selectedNode?.uuid ??
    (probedCoord ? `${probedCoord.lat.toFixed(2)}:${probedCoord.lng.toFixed(2)}` : "empty");

  // Only reset transient mutation banners/forms on spot switches; keep user-chosen view toggles persistent!
  useEffect(() => {
    forecastAbortRef.current?.abort();
    forecastAbortRef.current = null;
    setActionMsg(null);
    setShowReviseForm(false);
    setSpotPrediction(null);
    setSpotPredError(null);
    setSpotPredLoading(false);
    setFocusedSummaryKey(null);
  }, [selectionKey]);

  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.uuid, n])), [allNodes]);

  const coord = useMemo(() => {
    if (probedCoord) return probedCoord;
    if (
      selectedNode &&
      typeof selectedNode.properties.lat === "number" &&
      typeof selectedNode.properties.lng === "number"
    ) {
      return { lat: selectedNode.properties.lat, lng: selectedNode.properties.lng };
    }
    if (primary) return { lat: primary.lat, lng: primary.lng };
    return null;
  }, [probedCoord, selectedNode, primary]);

  // Nearby matching pins within 1200 km filtered by the user's active topic filters & timeline
  const nearbyMatching = useMemo(() => {
    if (!coord) return [];
    const candidates = visibleNodes.filter((n) => n.uuid !== selectedNode?.uuid);
    return findNearbyFilteredNodes(coord.lat, coord.lng, candidates, 1200, 5);
  }, [coord, visibleNodes, selectedNode]);

  // Filter multi-topic coordinate summaries strictly to active filters
  const visibleSummaries = useMemo(() => {
    if (activeTopics.length === 0) return summaries;
    return summaries.filter((s) => activeTopics.includes(s.dataset));
  }, [summaries, activeTopics]);

  const activeSummary = useMemo(() => {
    if (comparison && primary) return primary;
    if (focusedSummaryKey) {
      const hit = visibleSummaries.find((s) => summaryKey(s) === focusedSummaryKey);
      if (hit) return hit;
    }
    if (focusedSummaryDataset) {
      const hit = visibleSummaries.find((s) => s.dataset === focusedSummaryDataset);
      if (hit) return hit;
    }
    if (selectedNode && primary) return primary;
    if (visibleSummaries.length === 0) {
      return activeTopics.length === 1 && activeTopics[0] === "community" ? null : primary;
    }
    return visibleSummaries[0];
  }, [
    selectedNode,
    primary,
    comparison,
    visibleSummaries,
    activeTopics,
    focusedSummaryKey,
    focusedSummaryDataset,
  ]);

  const activeDatasetId: ETGDatasetId =
    activeSummary?.dataset ?? selectedNode?.properties.dataset ?? activeTopics[0] ?? "nasa_power";

  const handleRunRegionalForecast = async () => {
    forecastAbortRef.current?.abort();
    const controller = new AbortController();
    forecastAbortRef.current = controller;
    setSpotPredLoading(true);
    setSpotPredError(null);
    try {
      const qs = new URLSearchParams();
      if (selectedNode && !probedCoord) {
        qs.set("targetUuid", selectedNode.uuid);
      } else if (coord) {
        qs.set("lat", String(coord.lat));
        qs.set("lng", String(coord.lng));
        qs.set("dataset", activeDatasetId);
        if (selectedNode) qs.set("targetUuid", selectedNode.uuid);
      } else if (selectedNode) {
        qs.set("targetUuid", selectedNode.uuid);
      } else {
        throw new Error("Select a pin or click a coordinate on Earth to run a regional forecast.");
      }
      const res = await fetch(`/api/graph/predict?${qs.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = (await res.json()) as GraphPredictionResult & { error?: string };
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || "Regional forecast failed");
      setSpotPrediction(data);
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setSpotPredError(err instanceof Error ? err.message : "Regional forecast failed");
    } finally {
      if (!controller.signal.aborted) {
        setSpotPredLoading(false);
      }
    }
  };

  // Expand anchor pin lookup to 850 km so probing near continental/ocean trends discovers all connected relations
  const anchorNode = useMemo(() => {
    if (selectedNode) return selectedNode;
    if (nearbyMatching[0] && nearbyMatching[0].distanceKm <= 850) {
      return nearbyMatching[0].node;
    }
    return null;
  }, [selectedNode, nearbyMatching]);

  const categoryPriority: Record<RelationCategory, number> = {
    opposite: 4,
    causal: 3,
    coupled: 2,
    corroboration: 1,
  };

  const allLinkedRelations = useMemo(() => {
    if (!anchorNode) return [];
    const allowedCats = enabledRelationCategories
      ? new Set(enabledRelationCategories)
      : null;

    const seenEdgeIds = new Set<string>();
    const items: Array<{
      edge: ETGEdge;
      peer: ETGNode;
      formatted: ReturnType<typeof formatRelationForDisplay>;
    }> = [];

    for (const edge of allEdges) {
      if (seenEdgeIds.has(edge.properties.uuid)) continue;
      if (edge.source_uuid !== anchorNode.uuid && edge.target_uuid !== anchorNode.uuid) {
        continue;
      }
      const category = classifyRelationCategory(edge.type);
      if (allowedCats && !allowedCats.has(category)) continue;

      const peerId =
        edge.source_uuid === anchorNode.uuid ? edge.target_uuid : edge.source_uuid;
      const peer = nodeMap.get(peerId);
      if (!peer) continue;

      seenEdgeIds.add(edge.properties.uuid);
      items.push({
        edge,
        peer,
        formatted: formatRelationForDisplay(edge, anchorNode, peer),
      });
    }

    return items.sort((a, b) => {
      const catDiff =
        categoryPriority[b.formatted.category] - categoryPriority[a.formatted.category];
      if (catDiff !== 0) return catDiff;
      return (
        Math.abs(b.edge.properties.correlation_r ?? 0) -
        Math.abs(a.edge.properties.correlation_r ?? 0)
      );
    });
  }, [anchorNode, allEdges, nodeMap, enabledRelationCategories]);

  const filteredLinkedRelations = useMemo(() => {
    if (localRelationFilter === "all") return allLinkedRelations;
    return allLinkedRelations.filter(
      (item) => item.formatted.category === localRelationFilter
    );
  }, [allLinkedRelations, localRelationFilter]);

  const relationCategoryCounts = useMemo(() => {
    const counts: Record<RelationCategory, number> = {
      opposite: 0,
      causal: 0,
      coupled: 0,
      corroboration: 0,
    };
    for (const item of allLinkedRelations) {
      counts[item.formatted.category] += 1;
    }
    return counts;
  }, [allLinkedRelations]);

  // Corroboration & belief revision details for Stats & Sources drawer
  const supportingEdges = useMemo(() => {
    if (!selectedNode) return [];
    return allEdges.filter(
      (e) =>
        e.target_uuid === selectedNode.uuid &&
        (e.type === "supports" || e.type === "corroborates")
    );
  }, [selectedNode, allEdges]);

  const beliefChain = useMemo(() => {
    if (!selectedNode) return [];
    let head = selectedNode.uuid;
    const guard = new Set<string>();
    while (!guard.has(head)) {
      guard.add(head);
      const newer = allEdges.find((e) => e.type === "supersedes" && e.target_uuid === head);
      if (!newer) break;
      head = newer.source_uuid;
    }
    const chain: Array<{ node: ETGNode; rationale?: string }> = [];
    const seen = new Set<string>();
    let curr: string | undefined = head;
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const n = nodeMap.get(curr);
      const edge = allEdges.find((e) => e.type === "supersedes" && e.source_uuid === curr);
      if (n) chain.push({ node: n, rationale: edge?.properties.rationale });
      curr = edge?.target_uuid;
    }
    return chain;
  }, [selectedNode, allEdges, nodeMap]);

  // Header title & labels
  const activeGuidedCase = useMemo(
    () => (activeCaseStudyId ? guidedCases?.find((c) => c.id === activeCaseStudyId) ?? null : null),
    [activeCaseStudyId, guidedCases]
  );
  const isComparingTwoSpots = Boolean(comparison && primary && secondary);
  const isCompareHeader = isComparingTwoSpots || Boolean(comparePending && loading);
  const rawLabelA =
    activeGuidedCase?.spotAName ||
    (sourceNode?.properties.region && !sourceNode.properties.region.includes("°")
      ? sourceNode.properties.region
      : sourceNode
        ? humanizeNodeText(sourceNode.properties.name)
        : null) ||
    (primary
      ? describeGeographicZone(primary.lat, primary.lng, nearbyMatching[0]?.node)
      : coord
        ? describeGeographicZone(coord.lat, coord.lng, nearbyMatching[0]?.node)
        : "Spot A");
  const rawLabelB =
    activeGuidedCase?.spotBName ||
    (targetNode?.properties.region && !targetNode.properties.region.includes("°")
      ? targetNode.properties.region
      : targetNode
        ? humanizeNodeText(targetNode.properties.name)
        : null) ||
    (secondary ? describeGeographicZone(secondary.lat, secondary.lng, null) : "Spot B");

  const needZoneDisambiguation =
    isComparingTwoSpots && rawLabelA === rawLabelB && Boolean(primary && secondary);
  const labelA =
    needZoneDisambiguation && primary
      ? `${rawLabelA} (${formatCoordShort(primary.lat, primary.lng)})`
      : rawLabelA;
  const labelB =
    needZoneDisambiguation && secondary
      ? `${rawLabelB} (${formatCoordShort(secondary.lat, secondary.lng)})`
      : rawLabelB;

  const cardTitle = isCompareHeader
    ? `${labelA} ↔ ${labelB}`
    : selectedNode
      ? humanizeNodeText(selectedNode.properties.name)
      : coord
        ? describeGeographicZone(coord.lat, coord.lng, nearbyMatching[0]?.node)
        : "Selected Spot";

  const activeDigest = activeSummary ? describeTrendPlainly(activeSummary, tempUnit) : null;
  const comparisonDigest =
    comparison && primary && secondary
      ? describeComparisonPlainly(comparison, labelA, labelB)
      : null;

  const tempSummaryForNow = useMemo(() => {
    const direct = summaries.find(
      (s) => s.dataset === "nasa_power" && isTemperatureUnitString(s.unit)
    );
    if (direct) return direct;
    if (primary?.dataset === "nasa_power" && isTemperatureUnitString(primary.unit)) {
      return primary;
    }
    return null;
  }, [summaries, primary]);

  const onlyCommunityFilterAtEmptySpot =
    !selectedNode &&
    !isComparingTwoSpots &&
    activeTopics.length === 1 &&
    activeTopics[0] === "community" &&
    nearbyMatching.length === 0;

  const hasStoredNodeMetrics = Boolean(
    selectedNode &&
      (typeof selectedNode.properties.value === "number" ||
        typeof selectedNode.properties.latest_value === "number" ||
        typeof selectedNode.properties.p_value === "number" ||
        typeof selectedNode.properties.theil_sen_slope === "number" ||
        typeof selectedNode.properties.anomaly === "number")
  );

  const visibleDatasetSet = useMemo(
    () => new Set(visibleSummaries.map((s) => s.dataset)),
    [visibleSummaries]
  );

  const hasLocalCommunityMatch = useMemo(
    () => nearbyMatching.some((m) => m.node.properties.dataset === "community"),
    [nearbyMatching]
  );

  const relevantDatasetDiags = useMemo(() => {
    const raw = diagnostics?.datasets ?? [];
    return raw.filter((d) => {
      if (activeTopics.length > 0 && !activeTopics.includes(d.dataset)) return false;
      if (visibleDatasetSet.has(d.dataset)) return false;
      if (d.dataset === "community" && hasLocalCommunityMatch) return false;
      return true;
    });
  }, [diagnostics, activeTopics, visibleDatasetSet, hasLocalCommunityMatch]);

  const failedFeedLabels = useMemo(() => {
    const labels: string[] = [];
    if (diagnostics?.current?.weatherStatus === "failed_to_fetch") {
      labels.push("Live Weather");
    }
    if (diagnostics?.current?.airQualityStatus === "failed_to_fetch") {
      labels.push("Air Quality");
    }
    for (const d of relevantDatasetDiags) {
      if (d.status === "failed_to_fetch") {
        labels.push(DATASET_BY_ID[d.dataset]?.shortLabel ?? d.dataset);
      }
    }
    return labels;
  }, [diagnostics, relevantDatasetDiags]);

  const hasTopFetchFailure =
    Boolean(error) || failureKind === "failed_to_fetch" || failedFeedLabels.length > 0;

  const hasAnySpotData = Boolean(
    current ||
      visibleSummaries.length > 0 ||
      hasStoredNodeMetrics ||
      nearbyMatching.length > 0 ||
      isComparingTwoSpots
  );

  const handleSaveToGraph = async () => {
    setCommitting(true);
    setActionMsg(null);
    try {
      if (isComparingTwoSpots && primary && secondary && comparison) {
        await onCommitRelation({
          primary,
          secondary,
          comparison,
          sourceNodeUuid: sourceNode?.uuid,
          targetNodeUuid: targetNode?.uuid,
        });
        setActionMsg("Saved linked places to the Knowledge Graph.");
      } else if (activeSummary) {
        await onCommitToGraph(activeSummary);
        setActionMsg("Saved spot to the Knowledge Graph.");
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleVerifyGate = async () => {
    if (!selectedNode) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", nodeUuid: selectedNode.uuid }),
      });
      const data = await res.json();
      setActionMsg(
        data.audit?.corroborated
          ? "Confirmed by multiple independent sources."
          : `Needs ≥2 independent sources (${data.audit?.supportingSources?.length ?? 0} so far).`
      );
      await onGraphUpdated();
    } finally {
      setCommitting(false);
    }
  };

  const handleSimulateWebhook = async () => {
    if (!selectedNode || selectedNode.properties.lat === undefined || selectedNode.properties.lng === undefined) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch(
        `/api/graph/nodes/${encodeURIComponent(selectedNode.uuid)}/webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id: selectedNode.properties.device_id || `edge-sensor-${selectedNode.uuid.slice(0, 6)}`,
            producer_type: "iot_sensor",
            dataset: selectedNode.properties.dataset || "community",
            lat: selectedNode.properties.lat,
            lng: selectedNode.properties.lng,
            value: selectedNode.properties.value,
            unit: selectedNode.properties.unit || "units",
            confidence: 0.93,
            title: `Local sensor check-in near ${humanizeNodeText(selectedNode.properties.name).slice(0, 28)}`,
          }),
        }
      );
      if (res.ok) {
        setActionMsg("Recorded local sensor check-in.");
        await onGraphUpdated();
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleReviseBelief = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !revName.trim() || !revDesc.trim() || !revRationale.trim()) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorNodeUuid: selectedNode.uuid,
          newName: revName,
          newDescription: revDesc,
          rationale: revRationale,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setShowReviseForm(false);
        setRevName("");
        setRevDesc("");
        setRevRationale("");
        setActionMsg("Saved updated finding.");
        await onGraphUpdated();
        if (data.revisedNode) onSelectNode(data.revisedNode);
      }
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="relative flex max-sm:max-h-[54dvh] sm:max-h-[calc(100dvh-5rem)] w-full flex-col overflow-hidden rounded-md border border-border bg-surface shadow-2xl">
      {/* 1. Structured Header + Unit/Customize Controls + Quick View Strip */}
      <div className="shrink-0 space-y-2 border-b border-border px-3.5 pt-3 pb-2 sm:px-4 sm:pt-3.5 sm:pb-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold leading-snug text-text-primary">
              {cardTitle}
            </h2>
            {coord && !isComparingTwoSpots && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-subtle">
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3 shrink-0 text-accent-fg" aria-hidden="true" />
                  <span className="ws-numeric font-mono">{formatCoordShort(coord.lat, coord.lng)}</span>
                </span>
                {current?.elevationM !== null && current?.elevationM !== undefined && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="ws-numeric font-mono">{Math.round(current.elevationM)} m</span>
                  </>
                )}
                {selectedNode?.properties.dataset && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {DATASET_BY_ID[selectedNode.properties.dataset]?.shortLabel ?? "Observation"}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <VariableGuidePopoverButton compact label="Guide" />
            {onChangeTempUnit && (
              <div
                className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5"
                role="group"
                aria-label="Temperature unit"
              >
                {(["C", "F"] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    aria-pressed={tempUnit === u}
                    onClick={() => onChangeTempUnit(u)}
                    className="rounded-xs px-1.5 py-0.5 text-[10px] font-semibold text-text-muted transition-colors hover:text-text-primary aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                  >
                    °{u}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              popoverTarget="etg-spot-customize-popover"
              aria-label="Customize visible data and sections"
              title="Choose what stats, sections, and formats to display"
              className="inline-flex h-7 items-center gap-1 rounded-sm border border-border bg-surface-inset px-2 text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">View</span>
            </button>

            {onToggleMobileCollapse && (
              <button
                type="button"
                onClick={onToggleMobileCollapse}
                aria-expanded={!mobileCollapsed}
                aria-label={mobileCollapsed ? "Expand spot card" : "Collapse spot card"}
                title={mobileCollapsed ? "Expand spot card" : "Collapse spot card"}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-inset text-text-muted transition-colors hover:text-text-primary cursor-pointer sm:hidden"
              >
                {mobileCollapsed ? (
                  <ChevronUp className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close spot card"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Native Customize Spot View Popover */}
        <div
          id="etg-spot-customize-popover"
          popover="auto"
          className="etg-popover etg-popover-end w-72 space-y-3 p-3 text-xs"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Choose What You See
          </div>

          <div className="space-y-0.5">
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showCurrent}
                onChange={(e) => updatePref("showCurrent", e.target.checked)}
              />
              <span className="text-text-primary">Current weather &amp; air (Now)</span>
            </label>
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showTrends}
                onChange={(e) => updatePref("showTrends", e.target.checked)}
              />
              <span className="text-text-primary">Multi-year Earth trends</span>
            </label>
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showRelations}
                onChange={(e) => updatePref("showRelations", e.target.checked)}
              />
              <span className="text-text-primary">Relations &amp; connected places</span>
            </label>
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showChart}
                onChange={(e) => updatePref("showChart", e.target.checked)}
              />
              <span className="text-text-primary">Time-series chart</span>
            </label>
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showScience}
                onChange={(e) => updatePref("showScience", e.target.checked)}
              />
              <span className="text-text-primary">Stats, sources &amp; graph actions</span>
            </label>
          </div>

          <div className="border-t border-border pt-2.5">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              Current Conditions Tiles
            </div>
            <div className="space-y-0.5">
              <label className="etg-check-label">
                <input
                  type="checkbox"
                  className="checkbox-native"
                  checked={prefs.showWindHumidity}
                  onChange={(e) => updatePref("showWindHumidity", e.target.checked)}
                />
                <span className="text-text-primary">Wind, humidity &amp; precip</span>
              </label>
              <label className="etg-check-label">
                <input
                  type="checkbox"
                  className="checkbox-native"
                  checked={prefs.showAirUv}
                  onChange={(e) => updatePref("showAirUv", e.target.checked)}
                />
                <span className="text-text-primary">Air quality (US AQI / PM2.5) &amp; UV</span>
              </label>
              <label className="etg-check-label">
                <input
                  type="checkbox"
                  className="checkbox-native"
                  checked={prefs.showPressureSolar}
                  onChange={(e) => updatePref("showPressureSolar", e.target.checked)}
                />
                <span className="text-text-primary">Pressure, clouds &amp; solar flux</span>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              Trends Layout
            </span>
            <div className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5">
              {(["cards", "table"] as const).map((layout) => (
                <button
                  key={layout}
                  type="button"
                  aria-pressed={prefs.trendLayout === layout}
                  onClick={() => updatePref("trendLayout", layout)}
                  className="rounded-xs px-2 py-0.5 text-[11px] font-medium capitalize text-text-muted aria-pressed:bg-sky-950 aria-pressed:text-sky-200 cursor-pointer"
                >
                  {layout}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Section Quick-Toggle Bar ("Choose What You See" in 1 click) */}
        <div
          className={`flex flex-wrap items-center gap-1 ${mobileCollapsed ? "max-sm:hidden" : ""}`}
          role="group"
          aria-label="Toggle spot card sections"
        >
          {(isCompareHeader
            ? ([
                { key: "showChart", label: "Chart" },
                { key: "showScience", label: "Stats" },
              ] as const)
            : ([
                { key: "showCurrent", label: "Now" },
                {
                  key: "showTrends",
                  label:
                    visibleSummaries.length > 0
                      ? `Trends (${visibleSummaries.length})`
                      : "Trends",
                },
                {
                  key: "showRelations",
                  label:
                    allLinkedRelations.length > 0
                      ? `Relations (${allLinkedRelations.length})`
                      : "Relations",
                },
                { key: "showChart", label: "Chart" },
                { key: "showScience", label: "Stats" },
              ] as const)
          ).map((btn) => {
            const active = prefs[btn.key];
            return (
              <button
                key={btn.key}
                type="button"
                aria-pressed={active}
                onClick={() => updatePref(btn.key, !active)}
                className={`rounded-sm border px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                  active
                    ? "border-accent-fg bg-amber-950 text-amber-300"
                    : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                }`}
              >
                {btn.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Scrollable Structured Body */}
      <div
        className={`flex-1 space-y-3 overflow-y-auto overscroll-contain px-3.5 py-3 text-xs sm:px-4 ${
          mobileCollapsed ? "max-sm:hidden" : ""
        }`}
      >
        {loading && (
          <div
            role="progressbar"
            aria-label="Loading spot telemetry"
            className="space-y-2 py-1"
          >
            <div className="h-1 w-full overflow-hidden rounded-xs bg-surface-elevated">
              <div className="h-full w-1/2 animate-pulse rounded-xs bg-sky-400" />
            </div>
            {!hasAnySpotData && (
              <>
                <div className="h-14 w-full animate-pulse rounded-md bg-surface-elevated" />
                <div className="h-12 w-full animate-pulse rounded-md bg-surface-elevated" />
              </>
            )}
          </div>
        )}

        {!loading && hasTopFetchFailure && (
          <div
            role="alert"
            className="flex items-start justify-between gap-2.5 rounded-md border border-rose-400 bg-rose-950 p-3 text-rose-200"
          >
            <div className="flex min-w-0 items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center rounded-xs border border-rose-400 bg-rose-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-100">
                    Failed to fetch
                  </span>
                  {failedFeedLabels.length > 0 && (
                    <span className="text-[11px] font-medium text-rose-200">
                      {failedFeedLabels.join(" · ")}
                    </span>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-rose-200">
                  {error
                    ? `Live telemetry request failed (${error}).`
                    : "One or more upstream telemetry requests could not be reached."}
                  {hasAnySpotData ? " Showing available data for this spot below." : ""}
                </p>
              </div>
            </div>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                aria-label="Retry spot telemetry"
                className="shrink-0 cursor-pointer rounded-sm border border-rose-400 bg-rose-900 px-2.5 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-800"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {/* Compare Waiting Prompt */}
        {compareMode && !isComparingTwoSpots && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-cyan-400 bg-cyan-950 px-3 py-2 text-cyan-300">
            <span>Click a second spot on Earth to compare how they change together.</span>
            <button
              type="button"
              onClick={onToggleCompareMode}
              className="shrink-0 font-semibold text-cyan-300 hover:underline cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Mode A: Comparing Two Spots / Linked Trend ── */}
        {isComparingTwoSpots && comparisonDigest && primary && secondary && comparison && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span
                className={`rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${
                  comparisonDigest.badgeLabel === "Opposite trends"
                    ? "border-rose-400 bg-rose-950 text-rose-300"
                    : comparisonDigest.badgeLabel === "Moving together"
                      ? "border-sky-400 bg-sky-950 text-sky-300"
                      : "border-border bg-surface-inset text-text-muted"
                }`}
              >
                {comparisonDigest.badgeLabel} · {comparisonDigest.strengthLabel}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onSwapPins}
                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                  <span>Swap</span>
                </button>
                <button
                  type="button"
                  onClick={onClearComparison}
                  className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
                >
                  1 spot
                </button>
              </div>
            </div>

            <p className="text-[13px] font-medium leading-snug text-text-primary">
              {comparisonDigest.headline}
            </p>
            <p className="leading-relaxed text-text-muted">
              {comparisonDigest.explanation} {comparisonDigest.timingNote}
            </p>

            {/* Structured Coupling Metrics Strip */}
            <div className="grid grid-cols-4 gap-1.5">
              <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                <div className="text-[10px] text-text-subtle">Pearson r</div>
                <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
                  {comparison.pearsonR >= 0 ? "+" : ""}
                  {comparison.pearsonR.toFixed(2)}
                </div>
              </div>
              <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                <div className="text-[10px] text-text-subtle">Detrended r*</div>
                <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
                  {comparison.detrendedR >= 0 ? "+" : ""}
                  {comparison.detrendedR.toFixed(2)}
                </div>
              </div>
              <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                <div className="text-[10px] text-text-subtle">Lag</div>
                <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
                  {formatCompactLag(comparison.optimalLagSteps, comparison.lagUnit)}
                </div>
              </div>
              <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                <div className="text-[10px] text-text-subtle">Shift</div>
                <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
                  {comparison.sharedRegimeShiftYear ?? "—"}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {[
                {
                  id: "a",
                  label: labelA,
                  summary: primary,
                  live: current,
                  dot: "bg-amber-400",
                },
                {
                  id: "b",
                  label: labelB,
                  summary: secondary,
                  live: secondaryCurrent,
                  dot: "bg-sky-400",
                },
              ].map((side) => {
                const d = describeTrendPlainly(side.summary, tempUnit);
                return (
                  <div key={side.id} className="ws-inset space-y-1 rounded-md p-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-primary">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${side.dot}`} aria-hidden="true" />
                      <span className="truncate">{side.label}</span>
                    </div>
                    {side.live?.temperatureC !== null && side.live?.temperatureC !== undefined && (
                      <div className="ws-numeric flex items-center justify-between text-[11px] text-amber-300">
                        <span>Now</span>
                        <span className="font-mono font-semibold">
                          {formatTemperatureValue(side.live.temperatureC, tempUnit, 1)}
                        </span>
                      </div>
                    )}
                    <div className="text-[11px] font-medium text-text-secondary">
                      {d.headline}
                    </div>
                    <div className="ws-numeric font-mono text-[11px] text-text-subtle">
                      {d.ratePerDecade}
                    </div>
                  </div>
                );
              })}
            </div>

            {guidedCases && guidedCases.length > 0 && onSelectCaseStudy && (
              <div className="space-y-1.5 rounded-sm border border-border bg-surface-inset p-2">
                <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                  <span>Guided Opposite-Trend Case Studies</span>
                  <span className="font-mono text-[9px] text-accent-fg">
                    {guidedCases.length} NASA Cases
                  </span>
                </div>
                <div className="flex flex-wrap gap-1" role="group" aria-label="Switch guided Earth case study">
                  {guidedCases.map((c) => {
                    const isActive = activeCaseStudyId === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => onSelectCaseStudy(c.id)}
                        title={c.subtitle}
                        className={`rounded-xs border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                          isActive
                            ? "border-rose-400 bg-rose-950 text-rose-200 font-semibold"
                            : "border-border bg-surface text-text-muted hover:border-border-strong hover:text-text-primary"
                        }`}
                      >
                        {c.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Section 1: Current Earth Conditions ("Now") ── */}
        {(current || !loading) && !isComparingTwoSpots && prefs.showCurrent && coord && (
          <section aria-label="Current conditions" className="space-y-2">
            {current ? (
              <div className="rounded-md border border-border bg-surface-inset p-3 space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="ws-numeric text-2xl font-bold tracking-tight text-text-primary">
                        {current.temperatureC !== null
                          ? formatTemperatureValue(current.temperatureC, tempUnit, 1)
                          : current.usAqi !== null
                            ? `AQI ${Math.round(current.usAqi)}`
                            : current.uvIndex !== null
                              ? `UV ${current.uvIndex.toFixed(1)}`
                              : current.pm25 !== null
                                ? `${current.pm25.toFixed(1)} μg/m³`
                                : current.shortwaveRadiationWm2 !== null
                                  ? `${Math.round(current.shortwaveRadiationWm2)} W/m²`
                                  : "—"}
                      </span>
                      <span className="text-xs font-medium text-text-secondary">
                        {current.weatherLabel}
                      </span>
                      {current.temperatureC === null && diagnostics?.current && (
                        <span
                          className={`rounded-xs border px-1.5 py-0.5 text-[10px] font-medium ${
                            diagnostics.current.weatherStatus === "failed_to_fetch"
                              ? "border-rose-400 bg-rose-950 text-rose-200"
                              : "border-border-subtle bg-surface text-text-subtle"
                          }`}
                          title={diagnostics.current.weatherReason}
                        >
                          {diagnostics.current.weatherStatus === "failed_to_fetch"
                            ? "Weather: Failed to fetch"
                            : "Weather: Unavailable here"}
                        </span>
                      )}
                    </div>
                    <div className="ws-numeric mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-subtle">
                      {current.apparentTemperatureC !== null && (
                        <span>
                          Feels {formatTemperatureValue(current.apparentTemperatureC, tempUnit, 1)}
                        </span>
                      )}
                      {current.todayMaxC !== null && current.todayMinC !== null && (
                        <span>
                          · Today H {formatTemperatureValue(current.todayMaxC, tempUnit, 0)} / L{" "}
                          {formatTemperatureValue(current.todayMinC, tempUnit, 0)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right text-[10px] text-text-subtle">
                    <div className="ws-numeric font-mono">{formatObservedStamp(current.observedAt)}</div>
                    <div className="truncate max-w-[100px]">Live obs</div>
                  </div>
                </div>

                {/* Live Temp vs 30y Baseline Pill */}
                {current.temperatureC !== null && tempSummaryForNow && (
                  <div className="ws-numeric flex items-center justify-between gap-2 rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5 text-[11px]">
                    <span className="text-text-muted">
                      vs {tempSummaryForNow.points.length}y annual mean (
                      {formatTemperatureValue(tempSummaryForNow.mean, tempUnit, 1)})
                    </span>
                    <span
                      className={`font-mono font-semibold ${
                        current.temperatureC >= tempSummaryForNow.mean
                          ? "etg-tone-warm"
                          : "etg-tone-cool"
                      }`}
                    >
                      {formatTemperatureDelta(
                        current.temperatureC - tempSummaryForNow.mean,
                        tempUnit,
                        1
                      )}
                    </span>
                  </div>
                )}

                {/* Toggleable Current Stat Tiles */}
                {(prefs.showWindHumidity || prefs.showAirUv || prefs.showPressureSolar) && (
                  <div className="grid grid-cols-2 gap-1.5">
                    {prefs.showWindHumidity && current.windSpeedKmh !== null && (
                      <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                          <Wind className="h-3 w-3 text-sky-400" aria-hidden="true" />
                          <span>Wind</span>
                        </div>
                        <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                          {Math.round(current.windSpeedKmh)} km/h
                          {current.windCardinal ? ` ${current.windCardinal}` : ""}
                          {current.windGustsKmh !== null &&
                            current.windGustsKmh > current.windSpeedKmh + 6 && (
                              <span className="font-normal text-text-subtle">
                                {" "}
                                (gust {Math.round(current.windGustsKmh)})
                              </span>
                            )}
                        </div>
                      </div>
                    )}

                    {prefs.showWindHumidity && current.relativeHumidityPct !== null && (
                      <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                          <Droplets className="h-3 w-3 text-cyan-400" aria-hidden="true" />
                          <span>Humidity &amp; Precip</span>
                        </div>
                        <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                          {Math.round(current.relativeHumidityPct)}%
                          {current.precipitationMm !== null
                            ? ` · ${current.precipitationMm.toFixed(1)} mm`
                            : ""}
                        </div>
                      </div>
                    )}

                    {prefs.showAirUv && (current.usAqi !== null || current.pm25 !== null) && (
                      <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                          <Activity className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                          <span>Air Quality</span>
                        </div>
                        <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                          {current.usAqi !== null ? `AQI ${Math.round(current.usAqi)}` : "PM2.5"}
                          {current.aqiCategory ? ` (${current.aqiCategory})` : ""}
                          {current.pm25 !== null ? ` · ${current.pm25.toFixed(1)} μg/m³` : ""}
                        </div>
                      </div>
                    )}

                    {prefs.showAirUv &&
                      current.usAqi === null &&
                      current.pm25 === null &&
                      (() => {
                        const aqStatus = diagnostics?.current?.airQualityStatus;
                        const aqFailed = aqStatus === "failed_to_fetch";
                        return (
                          <div
                            className={`rounded-sm border px-2.5 py-1.5 ${
                              aqFailed
                                ? "border-rose-400 bg-rose-950"
                                : "border-border-subtle bg-surface"
                            }`}
                            title={diagnostics?.current?.airQualityReason}
                          >
                            <div
                              className={`flex items-center gap-1 text-[10px] ${
                                aqFailed ? "text-rose-300" : "text-text-subtle"
                              }`}
                            >
                              <Activity
                                className={`h-3 w-3 ${aqFailed ? "text-rose-400" : "text-text-subtle"}`}
                                aria-hidden="true"
                              />
                              <span>Air Quality</span>
                            </div>
                            <div
                              className={`mt-0.5 text-[11px] font-semibold ${
                                aqFailed ? "text-rose-200" : "text-text-muted"
                              }`}
                            >
                              {aqFailed ? "Failed to fetch" : "Unavailable here"}
                            </div>
                          </div>
                        );
                      })()}

                    {prefs.showAirUv && current.uvIndex !== null && (
                      <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                          <Sun className="h-3 w-3 text-amber-400" aria-hidden="true" />
                          <span>UV Index</span>
                        </div>
                        <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                          {current.uvIndex.toFixed(1)}
                          {current.shortwaveRadiationWm2 !== null && !prefs.showPressureSolar
                            ? ` · ${Math.round(current.shortwaveRadiationWm2)} W/m²`
                            : ""}
                        </div>
                      </div>
                    )}

                    {prefs.showPressureSolar && current.surfacePressureHpa !== null && (
                      <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                          <Gauge className="h-3 w-3 text-violet-400" aria-hidden="true" />
                          <span>Surface Pressure</span>
                        </div>
                        <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                          {Math.round(current.surfacePressureHpa)} hPa
                        </div>
                      </div>
                    )}

                    {prefs.showPressureSolar &&
                      (current.cloudCoverPct !== null || current.shortwaveRadiationWm2 !== null) && (
                        <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                          <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                            <Cloud className="h-3 w-3 text-slate-300" aria-hidden="true" />
                            <span>Clouds &amp; Solar</span>
                          </div>
                          <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                            {current.cloudCoverPct !== null
                              ? `${Math.round(current.cloudCoverPct)}% cloud`
                              : "—"}
                            {current.shortwaveRadiationWm2 !== null
                              ? ` · ${Math.round(current.shortwaveRadiationWm2)} W/m²`
                              : ""}
                          </div>
                        </div>
                      )}
                  </div>
                )}
              </div>
            ) : (
              (() => {
                const currentFetchFailed =
                  diagnostics?.current?.weatherStatus === "failed_to_fetch" ||
                  diagnostics?.current?.airQualityStatus === "failed_to_fetch" ||
                  failureKind === "failed_to_fetch" ||
                  (Boolean(error) && failureKind !== "unavailable");
                const reasonText =
                  diagnostics?.current?.weatherReason ||
                  diagnostics?.current?.airQualityReason ||
                  error ||
                  null;
                return currentFetchFailed ? (
                  <div className="rounded-sm border border-rose-400 bg-rose-950 px-2.5 py-2 text-[11px] text-rose-200">
                    <span className="font-semibold text-rose-100">
                      Failed to fetch live weather &amp; air quality
                    </span>
                    {reasonText ? ` — ${reasonText}` : " for this coordinate right now."}
                  </div>
                ) : (
                  <div className="rounded-sm border border-border-subtle bg-surface-inset px-2.5 py-2 text-[11px] text-text-subtle">
                    <span className="font-medium text-text-secondary">
                      Live weather &amp; air quality unavailable at this coordinate
                    </span>
                    {reasonText ? ` (${reasonText}).` : " right now."}
                  </div>
                );
              })()
            )}
          </section>
        )}

        {/* ── Section 2: Multi-Year Earth Trends (Cards or Compact Table) ── */}
        {(visibleSummaries.length > 0 ||
          hasStoredNodeMetrics ||
          nearbyMatching.length > 0 ||
          !loading) &&
          !isComparingTwoSpots &&
          prefs.showTrends && (
          <section aria-label="Earth trends summary" className="space-y-2 border-t border-border pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                Long-Term Trends
              </div>
              <div
                className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5"
                role="group"
                aria-label="Trend layout format"
              >
                <button
                  type="button"
                  aria-pressed={prefs.trendLayout === "cards"}
                  onClick={() => updatePref("trendLayout", "cards")}
                  className="inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-[10px] font-medium text-text-muted aria-pressed:bg-sky-950 aria-pressed:text-sky-200 cursor-pointer"
                >
                  <LayoutGrid className="h-3 w-3" aria-hidden="true" />
                  <span>Cards</span>
                </button>
                <button
                  type="button"
                  aria-pressed={prefs.trendLayout === "table"}
                  onClick={() => updatePref("trendLayout", "table")}
                  className="inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-[10px] font-medium text-text-muted aria-pressed:bg-sky-950 aria-pressed:text-sky-200 cursor-pointer"
                >
                  <List className="h-3 w-3" aria-hidden="true" />
                  <span>Table</span>
                </button>
              </div>
            </div>

            {/* Dataset Filter Chips */}
            <div
              className="flex flex-wrap items-center gap-1"
              role="region"
              aria-label="Filter datasets for this spot"
            >
              <button
                type="button"
                aria-pressed={activeTopics.length === 0}
                onClick={onResetTopics}
                className={`rounded-sm border px-2 py-0.5 text-[11px] transition-colors cursor-pointer ${
                  activeTopics.length === 0
                    ? "border-accent-fg bg-amber-950 font-semibold text-amber-300"
                    : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                }`}
              >
                All
              </button>
              {EARTH_TREND_DATASETS.map((ds) => {
                const active = activeTopics.includes(ds.id);
                return (
                  <button
                    key={ds.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onToggleTopic(ds.id)}
                    className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] transition-colors cursor-pointer ${
                      active
                        ? "border-accent-fg bg-amber-950 font-semibold text-amber-300"
                        : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                    }`}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: ds.color }}
                      aria-hidden="true"
                    />
                    <span>{ds.shortLabel}</span>
                  </button>
                );
              })}
            </div>

            {onlyCommunityFilterAtEmptySpot && (
              <div className="rounded-md border border-border bg-surface-inset p-3 text-text-muted">
                No local sensors recorded near this spot yet. Switch to{" "}
                <button
                  type="button"
                  onClick={onResetTopics}
                  className="font-semibold text-accent-fg hover:underline cursor-pointer"
                >
                  All topics
                </button>{" "}
                or pick another filter above.
              </div>
            )}

            {/* Table Layout View */}
            {!onlyCommunityFilterAtEmptySpot &&
              prefs.trendLayout === "table" &&
              visibleSummaries.length > 0 && (
                <div
                  className="etg-table-region rounded-md"
                  tabIndex={0}
                  role="region"
                  aria-label="Earth trend metrics table"
                  style={
                    {
                      "--col-2": '"Recent"',
                      "--col-3": '"Δ Avg"',
                      "--col-4": '"Rate/dec"',
                    } as React.CSSProperties
                  }
                >
                  <table className="w-full table-fixed text-[11px]">
                    <thead>
                      <tr>
                        <th scope="col" className="w-[30%] px-1.5 py-1.5 text-left">Metric</th>
                        <th scope="col" className="w-[23%] px-1.5 py-1.5 text-right">Recent</th>
                        <th scope="col" className="w-[22%] px-1.5 py-1.5 text-right">Δ Avg</th>
                        <th scope="col" className="w-[25%] px-1.5 py-1.5 text-right">Rate/dec</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSummaries.map((item) => {
                        const d = describeTrendPlainly(item, tempUnit);
                        const meta = DATASET_BY_ID[item.dataset];
                        const key = summaryKey(item);
                        const isFocused = activeSummary
                          ? summaryKey(activeSummary) === key
                          : false;
                        const dirSymbol = d.isSignificant
                          ? d.tone === "rising"
                            ? "↑"
                            : "↓"
                          : "—";
                        return (
                          <tr
                            key={key}
                            onClick={() => {
                              setFocusedSummaryKey(key);
                              onFocusSummaryDataset(item.dataset);
                            }}
                            className={`cursor-pointer transition-colors hover:bg-surface-band ${
                              isFocused ? "bg-surface-elevated" : ""
                            }`}
                          >
                            <th scope="row" className="px-1.5 py-1.5 text-left font-medium">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="h-2 w-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: meta?.color ?? "#e2a856" }}
                                  aria-hidden="true"
                                />
                                <span className="truncate">{d.parameterShort}</span>
                              </div>
                            </th>
                            <td className="px-1.5 py-1.5 text-right font-mono tabular-nums text-text-primary whitespace-nowrap">
                              {d.latestFormatted}
                            </td>
                            <td
                              className="px-1.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap"
                              title={`Baseline average ${d.meanFormatted} (${d.rangeFormatted})`}
                            >
                              <span
                                className={
                                  d.anomalyFormatted.startsWith("+")
                                    ? "etg-tone-warm"
                                    : d.anomalyFormatted.startsWith("-")
                                      ? "etg-tone-cool"
                                      : "text-text-subtle"
                                }
                              >
                                {d.anomalyFormatted}
                              </span>
                            </td>
                            <td className="px-1.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                              <span
                                className={
                                  d.isSignificant
                                    ? d.tone === "rising"
                                      ? "etg-tone-rise"
                                      : "etg-tone-cool"
                                    : "text-text-subtle"
                                }
                              >
                                {dirSymbol} {d.ratePerDecade.replace(" / decade", "/dec")}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

            {/* Cards Layout View (Multi-Topic) */}
            {!onlyCommunityFilterAtEmptySpot &&
              prefs.trendLayout === "cards" &&
              visibleSummaries.length > 1 && (
                <div className="space-y-1.5">
                  {visibleSummaries.map((item) => {
                    const d = describeTrendPlainly(item, tempUnit);
                    const meta = DATASET_BY_ID[item.dataset];
                    const key = summaryKey(item);
                    const isFocused = activeSummary
                      ? summaryKey(activeSummary) === key
                      : false;
                    const dirSymbol = d.isSignificant ? (d.tone === "rising" ? "↑" : "↓") : "—";
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setFocusedSummaryKey(key);
                          onFocusSummaryDataset(item.dataset);
                        }}
                        className={`w-full space-y-1.5 rounded-md border px-3 py-2 text-left transition-colors cursor-pointer ${
                          isFocused
                            ? "border-accent-fg bg-surface-elevated"
                            : "border-border bg-surface-inset hover:border-border-strong"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: meta?.color ?? "#e2a856" }}
                                aria-hidden="true"
                              />
                              <span className="font-medium text-text-primary">{d.topicLabel}</span>
                              <span className="rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-subtle">
                                {d.parameterShort}
                              </span>
                              <span
                                className={`rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold ${
                                  d.isSignificant
                                    ? d.tone === "rising"
                                      ? "border-rose-400 bg-rose-950 text-rose-300"
                                      : "border-sky-400 bg-sky-950 text-sky-300"
                                    : "border-border bg-surface-band text-text-subtle"
                                }`}
                              >
                                {dirSymbol} {d.certaintyLabel}
                              </span>
                              {d.isProxy && (
                                <span className="rounded-sm border border-amber-400 bg-amber-950 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                                  Proxy
                                </span>
                              )}
                            </div>
                            <div className="mt-1 font-semibold text-text-primary">{d.headline}</div>
                          </div>

                          <MiniSparkline points={item.points} color={meta?.color ?? "#e2a856"} />
                        </div>

                        <div className="ws-numeric grid grid-cols-3 gap-1.5 border-t border-border-subtle pt-1.5 font-mono text-[10px]">
                          <div>
                            <span className="block text-[9px] font-sans uppercase text-text-subtle">
                              Recent
                            </span>
                            <span className="font-semibold text-text-primary">
                              {d.latestFormatted}
                            </span>
                          </div>
                          <div>
                            <span className="block text-[9px] font-sans uppercase text-text-subtle">
                              Avg (Δ)
                            </span>
                            <span className="text-text-muted">
                              {d.meanFormatted.split(" ")[0]}{" "}
                              <span
                                className={
                                  d.anomalyFormatted.startsWith("+")
                                    ? "text-amber-300"
                                    : d.anomalyFormatted.startsWith("-")
                                      ? "text-sky-300"
                                      : ""
                                }
                              >
                                ({d.anomalyFormatted})
                              </span>
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="block text-[9px] font-sans uppercase text-text-subtle">
                              Rate/dec
                            </span>
                            <span className="font-medium text-text-secondary">
                              {d.ratePerDecade.replace(" / decade", "/dec")}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}

                  {activeDigest && (
                    <p className="px-0.5 pt-0.5 text-[11px] leading-relaxed text-text-muted">
                      <strong className="font-semibold text-text-primary">
                        {activeDigest.topicLabel} ({activeDigest.periodRange}):
                      </strong>{" "}
                      {activeDigest.summarySentence}
                    </p>
                  )}
                </div>
              )}

            {/* Single-Topic Highlight Card */}
            {!onlyCommunityFilterAtEmptySpot &&
              prefs.trendLayout === "cards" &&
              visibleSummaries.length <= 1 &&
              activeDigest &&
              activeSummary && (
                <div
                  className={`space-y-2.5 rounded-md border p-3 ${
                    activeDigest.isSignificant
                      ? activeDigest.tone === "rising"
                        ? "border-rose-400 bg-rose-950"
                        : "border-sky-400 bg-sky-950"
                      : "border-border bg-surface-inset"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {activeDigest.isSignificant ? (
                          activeDigest.tone === "rising" ? (
                            <TrendingUp className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                          ) : (
                            <TrendingDown className="h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
                          )
                        ) : (
                          <Activity className="h-4 w-4 shrink-0 text-text-subtle" aria-hidden="true" />
                        )}
                        <span className="text-[13px] font-semibold text-text-primary">
                          {activeDigest.headline}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-subtle">
                          {activeDigest.parameterShort}
                        </span>
                        <span className="ws-numeric font-mono font-medium text-text-secondary">
                          {activeDigest.ratePerDecade}
                        </span>
                        <span
                          className={`rounded-sm border px-2 py-0.5 text-[10px] font-semibold ${
                            activeDigest.isSignificant
                              ? "border-border-strong bg-surface-elevated text-text-primary"
                              : "border-border bg-surface-band text-text-subtle"
                          }`}
                        >
                          {activeDigest.isSignificant
                            ? activeDigest.tone === "rising"
                              ? "↑ "
                              : "↓ "
                            : "— "}
                          {activeDigest.certaintyLabel}
                        </span>
                        {activeDigest.isProxy && (
                          <span className="rounded-sm border border-amber-400 bg-amber-950 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                            Proxy
                          </span>
                        )}
                      </div>
                    </div>

                    <MiniSparkline
                      points={activeSummary.points}
                      color={DATASET_BY_ID[activeSummary.dataset]?.color ?? "#e2a856"}
                      width={68}
                      height={24}
                    />
                  </div>

                  <div className="ws-numeric grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                    <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                      <span className="block font-sans text-[10px] text-text-subtle">Recent</span>
                      <span className="font-semibold text-text-primary">
                        {activeDigest.latestFormatted}
                      </span>
                    </div>
                    <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                      <span className="block font-sans text-[10px] text-text-subtle">
                        {activeDigest.windowYears}y Avg (Δ)
                      </span>
                      <span className="text-text-primary">
                        {activeDigest.meanFormatted} ({activeDigest.anomalyFormatted})
                      </span>
                    </div>
                  </div>

                  <p className="leading-relaxed text-text-muted">{activeDigest.summarySentence}</p>
                  {activeDigest.isProxy && activeDigest.proxyNote && (
                    <p className="rounded-sm border border-amber-400 bg-surface-elevated px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300">
                      {activeDigest.proxyNote}
                    </p>
                  )}
                </div>
              )}

            {/* Fallback Stored Node Reading when remote time-series are missing */}
            {!onlyCommunityFilterAtEmptySpot &&
              visibleSummaries.length === 0 &&
              hasStoredNodeMetrics &&
              selectedNode && (
                <div className="space-y-2 rounded-md border border-border bg-surface-inset p-3">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="rounded-xs border border-amber-400 bg-amber-950 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                      Stored Node Reading
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-subtle">
                      {selectedNode.properties.dataset && (
                        <span className="rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-text-secondary">
                          {DATASET_BY_ID[selectedNode.properties.dataset]?.shortLabel ??
                            selectedNode.properties.dataset}
                        </span>
                      )}
                      {selectedNode.properties.region && (
                        <span>{selectedNode.properties.region}</span>
                      )}
                    </div>
                  </div>

                  <div className="ws-numeric grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                    {selectedNode.properties.value !== undefined &&
                      (() => {
                        const rawUnit = selectedNode.properties.unit ?? "";
                        const convVal = isTemperatureUnitString(rawUnit)
                          ? convertTemperatureDisplayValue(
                              selectedNode.properties.value,
                              rawUnit,
                              tempUnit
                            )
                          : selectedNode.properties.value;
                        const convUnit = isTemperatureUnitString(rawUnit)
                          ? convertTemperatureUnitLabel(rawUnit, tempUnit)
                          : rawUnit;
                        return (
                          <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                            <span className="block font-sans text-[10px] text-text-subtle">
                              Latest Value
                            </span>
                            <span className="font-semibold text-text-primary">
                              {convVal.toFixed(2)}
                              {convUnit ? ` ${convUnit}` : ""}
                            </span>
                          </div>
                        );
                      })()}
                    {selectedNode.properties.theil_sen_slope !== undefined &&
                      (() => {
                        const rawSlope = selectedNode.properties.theil_sen_slope;
                        const rawSlopeUnit = selectedNode.properties.slope_unit ?? "/ yr";
                        const isC = /(?:°\s*c|deg\s*c|celsius)/i.test(rawSlopeUnit);
                        const isF = /(?:°\s*f|deg\s*f|fahrenheit)/i.test(rawSlopeUnit);
                        const factor =
                          tempUnit === "F" && isC ? 1.8 : tempUnit === "C" && isF ? 1 / 1.8 : 1;
                        const convSlope = rawSlope * factor;
                        const convSlopeUnit =
                          isC || isF
                            ? convertSlopeUnitLabel(rawSlopeUnit, tempUnit)
                            : rawSlopeUnit;
                        return (
                          <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                            <span className="block font-sans text-[10px] text-text-subtle">
                              Theil-Sen Slope
                            </span>
                            <span className="font-semibold text-text-primary">
                              {convSlope >= 0 ? "+" : ""}
                              {convSlope.toFixed(3)} {convSlopeUnit}
                            </span>
                          </div>
                        );
                      })()}
                    {selectedNode.properties.p_value !== undefined && (
                      <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                        <span className="block font-sans text-[10px] text-text-subtle">
                          Mann-Kendall p
                        </span>
                        <span className="text-text-primary">
                          {selectedNode.properties.p_value < 0.0001
                            ? "< 0.0001"
                            : selectedNode.properties.p_value.toFixed(4)}
                        </span>
                      </div>
                    )}
                    {selectedNode.properties.confidence !== undefined && (
                      <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                        <span className="block font-sans text-[10px] text-text-subtle">
                          Confidence
                        </span>
                        <span className="text-text-primary">
                          {Math.round(selectedNode.properties.confidence * 100)}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

            {/* Per-Dataset Status Rows: distinguish Failed to fetch vs Unavailable */}
            {!onlyCommunityFilterAtEmptySpot && relevantDatasetDiags.length > 0 && (
              <div className="space-y-1.5">
                {relevantDatasetDiags.map((diag) => {
                  const dsMeta = DATASET_BY_ID[diag.dataset];
                  const isFetchFailed = diag.status === "failed_to_fetch";
                  return (
                    <div
                      key={`${diag.dataset}-${diag.status}`}
                      className={`flex items-start justify-between gap-2 rounded-sm border px-2.5 py-1.5 text-[11px] ${
                        isFetchFailed
                          ? "border-rose-400 bg-rose-950 text-rose-200"
                          : "border-border-subtle bg-surface-inset text-text-muted"
                      }`}
                    >
                      <div className="min-w-0">
                        <span className="font-semibold text-text-primary">
                          {dsMeta?.shortLabel ?? diag.dataset}
                        </span>
                        <span className="ml-1.5">{diag.reason}</span>
                      </div>
                      <span
                        className={`shrink-0 rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${
                          isFetchFailed
                            ? "border-rose-400 bg-rose-900 text-rose-100"
                            : "border-border bg-surface text-text-subtle"
                        }`}
                      >
                        {isFetchFailed ? "Failed to fetch" : "Unavailable"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {!onlyCommunityFilterAtEmptySpot &&
              !loading &&
              visibleSummaries.length === 0 &&
              !hasStoredNodeMetrics &&
              relevantDatasetDiags.length === 0 && (
                <div className="rounded-sm border border-border-subtle bg-surface-inset px-2.5 py-2 text-[11px] text-text-subtle">
                  No multi-year trend telemetry available for the active dataset filter at this coordinate.
                </div>
              )}

            {/* Node verification & Graph Workbench handoff when a graph node is selected */}
            {selectedNode && (() => {
              const cue = microscopeByNode?.[selectedNode.uuid];
              const badgeMeta: Record<
                TrendMicroscopeRadarBadge,
                { label: string; cls: string }
              > = {
                EARLY_ONSET: {
                  label: "Early Onset",
                  cls: "border-amber-400 bg-amber-950 text-amber-200",
                },
                SECULAR_ACCELERATION: {
                  label: "Secular Accel",
                  cls: "border-emerald-400 bg-emerald-950 text-emerald-200",
                },
                FALSE_TREND_CYCLE: {
                  label: "Cycle Alias",
                  cls: "border-violet-400 bg-purple-950 text-violet-200",
                },
                SENSOR_GLITCH_RISK: {
                  label: "Sensor Glitch Risk",
                  cls: "border-rose-400 bg-rose-950 text-rose-200",
                },
                NOMINAL: {
                  label: "Nominal",
                  cls: "border-border bg-surface text-text-muted",
                },
              };
              const topCoupling = microscopeScan?.verifiedCouplings.find(
                (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
              );
              const topIllusion = microscopeScan?.suppressedIllusions.find(
                (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
              );
              const secPct = cue ? Math.round(cue.dealiasing.secularShare * 100) : 0;
              const cycPct = cue ? Math.round(cue.dealiasing.oscillationShare * 100) : 0;
              const artPct = cue ? Math.max(0, 100 - secPct - cycPct) : 0;

              return (
                <div className="space-y-2 px-0.5 pt-0.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                    <span
                      className={`rounded-sm border px-2 py-0.5 font-medium ${
                        selectedNode.properties.status === "Superseded"
                          ? "border-amber-400 bg-amber-950 text-amber-300"
                          : selectedNode.is_provisional
                            ? "border-amber-400 bg-amber-950 text-amber-300"
                            : "border-emerald-400 bg-emerald-950 text-emerald-300"
                      }`}
                    >
                      {selectedNode.properties.status === "Superseded"
                        ? "Updated earlier finding"
                        : selectedNode.is_provisional
                          ? "Single-source reading"
                          : "Verified across sources"}
                    </span>
                    {onOpenInGraphWorkbench && (
                      <button
                        type="button"
                        onClick={() => onOpenInGraphWorkbench(selectedNode.uuid)}
                        className="inline-flex items-center gap-1 rounded-sm border border-accent-fg bg-amber-950 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 hover:border-amber-300 cursor-pointer"
                      >
                        <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Open in Graph &amp; Predict</span>
                      </button>
                    )}
                  </div>

                  {cue && (
                    <div className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2.5 text-[11px]">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="inline-flex items-center gap-1 font-semibold text-text-primary">
                          <Activity className="h-3 w-3 text-sky-400" aria-hidden="true" />
                          <span>AI Trend Microscope</span>
                        </span>
                        <div className="flex items-center gap-1">
                          {cue.preMannKendallAlert && (
                            <span className="rounded-xs border border-amber-400 bg-amber-950 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-200">
                              PRE-MK
                            </span>
                          )}
                          <span
                            className={`rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${badgeMeta[cue.radarBadge].cls}`}
                          >
                            {badgeMeta[cue.radarBadge].label}
                          </span>
                        </div>
                      </div>

                      <div className="ws-numeric flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-text-muted">
                        <span>Onset {Math.round(cue.onsetProb * 100)}%</span>
                        {cue.leadStepsAhead > 0 && (
                          <span>Lead ~{cue.leadStepsAhead.toFixed(1)} steps</span>
                        )}
                        <span>Trust Gate {Math.round(cue.trustGate * 100)}%</span>
                      </div>

                      <div className="space-y-1">
                        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface">
                          <div
                            className="bg-emerald-400"
                            style={{ width: `${secPct}%` }}
                            title={`Secular ${secPct}%`}
                          />
                          <div
                            className="bg-violet-400"
                            style={{ width: `${cycPct}%` }}
                            title={`Cycle ${cycPct}%`}
                          />
                          <div
                            className="bg-rose-400"
                            style={{ width: `${artPct}%` }}
                            title={`Noise/Drift ${artPct}%`}
                          />
                        </div>
                        <div className="ws-numeric flex items-center justify-between font-mono text-[9px] text-text-subtle">
                          <span>Secular {secPct}%</span>
                          <span>Cycle {cycPct}%</span>
                          <span>Noise/Drift {artPct}%</span>
                        </div>
                      </div>

                      {topCoupling && (
                        <div className="rounded-xs border border-emerald-400/50 bg-emerald-950/60 px-2 py-1 text-[10px] text-emerald-200">
                          {topCoupling.sourceName} → {topCoupling.targetName}:{" "}
                          {topCoupling.polarity} (lag={topCoupling.optimalLagSteps}, P=
                          {Math.round(topCoupling.trueCouplingProb * 100)}%)
                        </div>
                      )}

                      {topIllusion && (
                        <div className="rounded-xs border border-amber-400/50 bg-amber-950/60 px-2 py-1 text-[10px] text-amber-200">
                          Confounder Alert: {topIllusion.sourceName} ↔ {topIllusion.targetName}{" "}
                          (raw r={topIllusion.rawPeakR.toFixed(2)}, illusion{" "}
                          {Math.round(topIllusion.confounderProb * 100)}%)
                        </div>
                      )}
                    </div>
                  )}

                  {!activeDigest && (
                    <p className="leading-relaxed text-text-muted">
                      {humanizeNodeText(selectedNode.properties.description)}
                    </p>
                  )}
                </div>
              );
            })()}
          </section>
        )}

        {/* ── Section 3: Relations & Connected Places ── */}
        {(allLinkedRelations.length > 0 || !loading) &&
          !isComparingTwoSpots &&
          prefs.showRelations && (
          <section
            aria-label="Relations and connected places"
            className="space-y-2 border-t border-border pt-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                Relations &amp; Connected Places
              </div>
              {anchorNode && (
                <span className="max-w-[165px] truncate text-[10px] text-text-subtle">
                  via {humanizeNodeText(anchorNode.properties.name)}
                </span>
              )}
            </div>

            {allLinkedRelations.length > 0 && anchorNode ? (
              <>
                {/* Local category filter chips */}
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={localRelationFilter === "all"}
                    onClick={() => setLocalRelationFilter("all")}
                    className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                      localRelationFilter === "all"
                        ? "border-sky-400 bg-sky-950 text-sky-200"
                        : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                    }`}
                  >
                    All ({allLinkedRelations.length})
                  </button>
                  {ALL_RELATION_CATEGORIES.filter((c) => relationCategoryCounts[c] > 0).map(
                    (cat) => {
                      const styles = relationCategoryStyles(cat);
                      const active = localRelationFilter === cat;
                      return (
                        <button
                          key={cat}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setLocalRelationFilter(cat)}
                          className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                            active
                              ? styles.badge
                              : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                          }`}
                        >
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: styles.dot }}
                            aria-hidden="true"
                          />
                          <span>
                            {RELATION_CATEGORY_META[cat].shortLabel} ({relationCategoryCounts[cat]})
                          </span>
                        </button>
                      );
                    }
                  )}
                </div>

                <div className="space-y-1.5">
                  {filteredLinkedRelations.slice(0, 6).map(({ edge, peer, formatted }) => {
                    const styles = relationCategoryStyles(formatted.category);
                    const hasPeerCoords =
                      typeof peer.properties.lat === "number" &&
                      typeof peer.properties.lng === "number";
                    const hasAnchorCoords =
                      typeof anchorNode.properties.lat === "number" &&
                      typeof anchorNode.properties.lng === "number";
                    const arrow =
                      formatted.direction === "outgoing"
                        ? "→"
                        : formatted.direction === "incoming"
                          ? "←"
                          : "↔";
                    return (
                      <div
                        key={edge.properties.uuid}
                        className="rounded-md border border-border bg-surface-inset p-2.5 space-y-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${styles.badge}`}
                              >
                                {formatted.badgeText}
                              </span>
                              <span className="text-[11px] font-medium text-text-primary truncate">
                                {arrow} {formatted.peerName}
                              </span>
                            </div>
                            <div className="ws-numeric mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-text-subtle">
                              {formatted.peerRegion && <span>{formatted.peerRegion}</span>}
                              {formatted.correlationText && (
                                <span className="font-mono text-text-muted">
                                  {formatted.correlationText}
                                </span>
                              )}
                              {formatted.lagText && (
                                <span className="font-mono text-text-muted">
                                  {formatted.lagText}
                                </span>
                              )}
                              {formatted.liftText && (
                                <span className="font-mono text-emerald-300">
                                  {formatted.liftText}
                                </span>
                              )}
                              {formatted.distanceKm !== null && (
                                <span className="font-mono">{formatted.distanceKm} km</span>
                              )}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {onSelectEdge && (
                              <button
                                type="button"
                                onClick={() => onSelectEdge(edge)}
                                className="rounded-sm border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                              >
                                Focus
                              </button>
                            )}
                            {hasPeerCoords && hasAnchorCoords && (
                              <button
                                type="button"
                                onClick={() => onCompareOpposite(anchorNode, peer)}
                                className="rounded-sm border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-sky-300 hover:border-sky-400 cursor-pointer"
                              >
                                Compare
                              </button>
                            )}
                          </div>
                        </div>

                        <p className="line-clamp-2 text-[11px] leading-snug text-text-muted">
                          {formatted.summaryLine}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : allNodes.length === 0 && onDiscoverGlobalTrends ? (
              <div className="space-y-2 rounded-md border border-border bg-surface-inset p-3 text-text-muted">
                <p>
                  No global network nodes are loaded yet. Load live NASA, NOAA &amp; CSA observations
                  to uncover opposite teleconnections and causal chains.
                </p>
                <button
                  type="button"
                  disabled={discoverBusy}
                  onClick={onDiscoverGlobalTrends}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  <span>
                    {discoverBusy ? "Loading Live Data…" : "Load Live Global Trends & Relations"}
                  </span>
                </button>
              </div>
            ) : (
              <div className="rounded-sm border border-border-subtle bg-surface-inset px-2.5 py-2 text-[11px] text-text-subtle">
                No graph relations linked within 850 km yet. Select a nearby station or compare
                any two spots below.
              </div>
            )}

            {/* Nearby Matching Pins */}
            {nearbyMatching.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-text-subtle">
                  Nearby observations
                </div>
                {nearbyMatching.slice(0, 3).map(({ node, distanceKm }) => {
                  const dsColor = node.properties.dataset
                    ? DATASET_BY_ID[node.properties.dataset]?.color ?? "#e2a856"
                    : "#e2a856";
                  return (
                    <button
                      key={node.uuid}
                      type="button"
                      onClick={() => onSelectNode(node)}
                      className="flex w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface-elevated cursor-pointer"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: dsColor }}
                          aria-hidden="true"
                        />
                        <span className="truncate font-medium text-text-primary">
                          {humanizeNodeText(node.properties.name)}
                        </span>
                      </span>
                      <span className="ws-numeric shrink-0 font-mono text-[11px] text-text-subtle">
                        {distanceKm} km
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={onToggleCompareMode}
              className={`flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                compareMode
                  ? "border-cyan-400 bg-cyan-950 text-cyan-300"
                  : "border-border-strong bg-surface-elevated text-text-primary hover:border-accent-fg"
              }`}
            >
              <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {compareMode
                  ? "Click another spot on Earth…"
                  : "Compare this spot with another point on Earth"}
              </span>
            </button>
          </section>
        )}

        {/* ── Section 4: Time-Series Chart ── */}
        {prefs.showChart && (
          <div className="border-t border-border pt-2.5">
            <SpotTrendChart
              summary={activeSummary}
              secondarySummary={secondary}
              comparison={comparison}
              labelA={labelA}
              labelB={labelB}
              tempUnit={tempUnit}
            />
          </div>
        )}

        {/* ── Section 5: Data, Stats, Provenance & Graph Actions ── */}
        {prefs.showScience && (
          <div className="space-y-2.5 border-t border-border pt-2.5">
            {activeDigest && (
              <div className="ws-numeric grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
                  <span className="block font-sans text-[10px] text-text-subtle">Window</span>
                  <span className="text-text-primary">
                    {activeDigest.periodRange} ({activeDigest.windowYears} pts)
                  </span>
                </div>
                <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
                  <span className="block font-sans text-[10px] text-text-subtle">Range</span>
                  <span className="text-text-primary">{activeDigest.rangeFormatted}</span>
                </div>
                <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
                  <span className="block font-sans text-[10px] text-text-subtle">Mean / Δ</span>
                  <span className="text-text-primary">
                    {activeDigest.meanFormatted} ({activeDigest.anomalyFormatted})
                  </span>
                </div>
                <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
                  <span className="block font-sans text-[10px] text-text-subtle">Anomaly Z</span>
                  <span className="text-text-primary">
                    {activeDigest.anomalyZFormatted ?? "—"}
                  </span>
                </div>
              </div>
            )}

            {/* Data Provenance & Quick Links */}
            <div className="flex flex-wrap items-center gap-1.5">
              {(activeSummary?.provenance || selectedNode?.properties.source_system) && (
                <span className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-subtle">
                  {activeSummary?.provenance ?? selectedNode?.properties.source_system}
                </span>
              )}
              {current?.source && (
                <span className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-subtle">
                  {current.source}
                </span>
              )}
              {typeof selectedNode?.properties.source_url === "string" && (
                <a
                  href={selectedNode.properties.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-accent-fg hover:underline"
                >
                  Source Data ↗
                </a>
              )}
              {coord && (
                <a
                  href={
                    buildExternalExplorerLinks(
                      coord.lat,
                      coord.lng,
                      activeSummary?.dataset ?? selectedNode?.properties.dataset ?? "nasa_power"
                    ).giovanniUrl
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-sky-400 hover:underline"
                >
                  NASA Giovanni ↗
                </a>
              )}
            </div>

            {/* Save to Graph / Verify / Sensor Ping */}
            <div className="flex flex-wrap gap-1.5">
              {(activeSummary || isComparingTwoSpots) && (
                <button
                  type="button"
                  disabled={committing}
                  onClick={() => void handleSaveToGraph()}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                >
                  <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{committing ? "Saving…" : "Save to Graph"}</span>
                </button>
              )}

              {selectedNode && (
                <>
                  <button
                    type="button"
                    disabled={committing}
                    onClick={() => void handleVerifyGate()}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span>Verify sources ({supportingEdges.length})</span>
                  </button>

                  {selectedNode.properties.lat !== undefined && (
                    <button
                      type="button"
                      disabled={committing}
                      onClick={() => void handleSimulateWebhook()}
                      className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                    >
                      <Radio className="h-3.5 w-3.5 text-purple-400" aria-hidden="true" />
                      <span>Ping local sensor</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowReviseForm((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-amber-300 hover:border-amber-400 cursor-pointer"
                  >
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{showReviseForm ? "Cancel update" : "Update finding"}</span>
                  </button>
                </>
              )}
            </div>

            {showReviseForm && selectedNode && (
              <form onSubmit={handleReviseBelief} className="space-y-2 rounded-md border border-border bg-surface-inset p-3">
                <input
                  type="text"
                  required
                  placeholder="Updated conclusion title"
                  value={revName}
                  onChange={(e) => setRevName(e.target.value)}
                  className="form-input"
                />
                <input
                  type="text"
                  required
                  placeholder="Evidence summary"
                  value={revDesc}
                  onChange={(e) => setRevDesc(e.target.value)}
                  className="form-input"
                />
                <input
                  type="text"
                  required
                  placeholder="Why was the earlier finding revised?"
                  value={revRationale}
                  onChange={(e) => setRevRationale(e.target.value)}
                  className="form-input"
                />
                <button
                  type="submit"
                  disabled={committing}
                  className="w-full rounded-sm bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 cursor-pointer"
                >
                  Save revision
                </button>
              </form>
            )}

            {beliefChain.length > 1 && (
              <div className="space-y-1 rounded-md border border-border bg-surface-inset p-2.5">
                <div className="text-[11px] font-semibold text-amber-300">
                  Revision history ({beliefChain.length})
                </div>
                {beliefChain.map((step, idx) => (
                  <button
                    key={step.node.uuid}
                    type="button"
                    onClick={() => onSelectNode(step.node)}
                    className="block w-full truncate text-left text-[11px] text-text-muted hover:text-text-primary hover:underline cursor-pointer"
                  >
                    {idx === 0 ? "Current: " : "Prior: "}
                    {humanizeNodeText(step.node.properties.name)}
                  </button>
                ))}
              </div>
            )}

            {/* Regional Multi-Scale Graph Forecast */}
            {(coord || selectedNode) && (
              <div className="rounded-md border border-sky-400 bg-sky-950 p-2.5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-semibold text-sky-200">
                      Regional Multi-Scale Graph Forecast
                    </div>
                    <div className="text-[10px] text-text-muted">
                      Uses global teleconnections, nearby sensors &amp; multi-scale ETG weights
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={spotPredLoading}
                    onClick={() => void handleRunRegionalForecast()}
                    className="inline-flex items-center gap-1 rounded-sm border border-sky-400 bg-sky-900 px-2.5 py-1 text-[11px] font-medium text-sky-100 hover:border-sky-300 cursor-pointer disabled:opacity-60"
                  >
                    <TrendingUp className="h-3 w-3" aria-hidden="true" />
                    {spotPredLoading ? "Predicting…" : "Predict Region Trajectory"}
                  </button>
                </div>

                {spotPredError && (
                  <p className="text-[11px] text-rose-300">{spotPredError}</p>
                )}

                {spotPrediction &&
                  (() => {
                    const predIsTemp = isTemperatureUnitString(spotPrediction.unit);
                    const predUnit = predIsTemp
                      ? convertTemperatureUnitLabel(spotPrediction.unit, tempUnit)
                      : spotPrediction.unit;
                    const fmtPred = (v: number) =>
                      (predIsTemp
                        ? convertTemperatureDisplayValue(v, spotPrediction.unit, tempUnit)
                        : v
                      ).toFixed(2);
                    return (
                  <div className="space-y-1.5 border-t border-sky-800 pt-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-1.5">
                      <span className="font-mono text-sm font-bold text-text-primary">
                        {fmtPred(spotPrediction.recommendedForecastValue)} {predUnit}
                        <span className="ml-1.5 text-[10px] font-normal text-text-muted">
                          ({spotPrediction.nextForecast.nextPeriodLabel})
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-emerald-300">
                        Lift {spotPrediction.skillLiftVsSelfPct >= 0 ? "+" : ""}
                        {spotPrediction.skillLiftVsSelfPct.toFixed(1)}%
                      </span>
                    </div>

                    {spotPrediction.quantiles && (
                      <div className="font-mono text-[10px] text-sky-200">
                        P10 {fmtPred(spotPrediction.quantiles.p10)} · P50{" "}
                        {fmtPred(spotPrediction.quantiles.p50)} · P90{" "}
                        {fmtPred(spotPrediction.quantiles.p90)} {predUnit}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {spotPrediction.trendForecast && (
                        <span className="rounded-sm border border-sky-400 bg-sky-900 px-1.5 py-0.5 font-mono text-[9px] text-sky-100">
                          {spotPrediction.trendForecast.direction} · regime shift{" "}
                          {(spotPrediction.trendForecast.regimeShiftProb * 100).toFixed(0)}%
                        </span>
                      )}
                      {spotPrediction.scalesUsed?.map((sc) => (
                        <span
                          key={sc}
                          className="rounded-sm border border-border-strong bg-surface-inset px-1.5 py-0.5 font-mono text-[9px] text-text-muted"
                        >
                          {sc}
                        </span>
                      ))}
                      {spotPrediction.communityImpact &&
                        (spotPrediction.communityImpact.communityNodesActive > 0 ||
                          spotPrediction.communityImpact.trustGatedCount > 0) && (
                          <span className="rounded-sm border border-emerald-400 bg-emerald-950 px-1.5 py-0.5 font-mono text-[9px] text-emerald-200">
                            {spotPrediction.communityImpact.communityNodesActive} community active (
                            {spotPrediction.communityImpact.marginalCommunityLiftPct >= 0 ? "+" : ""}
                            {spotPrediction.communityImpact.marginalCommunityLiftPct.toFixed(1)}%)
                          </span>
                        )}
                    </div>
                  </div>
                    );
                  })()}
              </div>
            )}

            {/* Collapsible Raw Statistical Engine Metrics */}
            {(activeSummary ||
              selectedNode?.properties.p_value !== undefined ||
              comparison) && (
              <details className="etg-details">
                <summary>Statistical test details (Mann-Kendall &amp; Theil-Sen)</summary>
                <div className="space-y-2 p-3 font-mono text-[11px] text-text-muted">
                  {activeSummary &&
                    (() => {
                      const hasTemp =
                        isTemperatureUnitString(activeSummary.unit) ||
                        /(?:°\s*c|deg\s*c|celsius|°\s*f|deg\s*f|fahrenheit)/i.test(
                          activeSummary.slopeUnit
                        );
                      const srcIsF = /(?:°\s*f|deg\s*f|fahrenheit)/i.test(
                        activeSummary.slopeUnit
                      );
                      const slopeScale =
                        hasTemp && tempUnit === "F" && !srcIsF
                          ? 1.8
                          : hasTemp && tempUnit === "C" && srcIsF
                            ? 1 / 1.8
                            : 1;
                      const dispSlope = activeSummary.theilSen.slope * slopeScale;
                      const dispLow95 = activeSummary.theilSen.slopeLow95 * slopeScale;
                      const dispHigh95 = activeSummary.theilSen.slopeHigh95 * slopeScale;
                      const dispSlopeUnit = hasTemp
                        ? convertSlopeUnitLabel(activeSummary.slopeUnit, tempUnit)
                        : activeSummary.slopeUnit;
                      const dispSeasonalSlope = activeSummary.seasonalAnalysis
                        ? activeSummary.seasonalAnalysis.seasonalTheilSenSlope * slopeScale
                        : null;
                      return (
                        <>
                          <div className="flex justify-between gap-2">
                            <span>Mann-Kendall p-value</span>
                            <span className="ws-numeric text-text-primary">
                              {activeSummary.mannKendall.pValue < 0.0001
                                ? "< 0.0001"
                                : activeSummary.mannKendall.pValue.toFixed(4)}
                            </span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span>Hamed-Rao p* / τ / Z</span>
                            <span className="ws-numeric text-text-primary">
                              {activeSummary.mannKendall.pValueAdjusted.toFixed(4)} · τ=
                              {activeSummary.mannKendall.tau.toFixed(2)} · Z=
                              {activeSummary.mannKendall.zScore.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span>Theil-Sen slope (95% CI)</span>
                            <span className="ws-numeric text-text-primary">
                              {dispSlope >= 0 ? "+" : ""}
                              {dispSlope.toFixed(4)} {dispSlopeUnit} [{dispLow95.toFixed(3)},{" "}
                              {dispHigh95.toFixed(3)}]
                            </span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span>OLS R² / Pettitt shift</span>
                            <span className="ws-numeric text-text-primary">
                              {activeSummary.ols.rSquared.toFixed(2)}
                              {activeSummary.changePoint?.significant
                                ? ` · Shift ${activeSummary.changePoint.date}`
                                : " · No shift break"}
                            </span>
                          </div>
                          {activeSummary.seasonalAnalysis && dispSeasonalSlope !== null && (
                            <div className="flex justify-between gap-2 border-t border-border pt-1.5">
                              <span>Seasonal MK (Hirsch-Slack)</span>
                              <span className="ws-numeric text-text-primary">
                                p_s=
                                {activeSummary.seasonalAnalysis.pValue < 0.0001
                                  ? "< 0.0001"
                                  : activeSummary.seasonalAnalysis.pValue.toFixed(4)}
                                {" · "}
                                {dispSeasonalSlope >= 0 ? "+" : ""}
                                {dispSeasonalSlope.toFixed(4)} {dispSlopeUnit} (
                                {activeSummary.seasonalAnalysis.seasonsDetected} seasons)
                              </span>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  {!activeSummary &&
                    selectedNode?.properties.p_value !== undefined &&
                    (() => {
                      const rawSlope = selectedNode.properties.theil_sen_slope;
                      const rawSlopeUnit = selectedNode.properties.slope_unit ?? "";
                      const isC = /(?:°\s*c|deg\s*c|celsius)/i.test(rawSlopeUnit);
                      const isF = /(?:°\s*f|deg\s*f|fahrenheit)/i.test(rawSlopeUnit);
                      const factor =
                        tempUnit === "F" && isC ? 1.8 : tempUnit === "C" && isF ? 1 / 1.8 : 1;
                      const convSlope =
                        typeof rawSlope === "number" ? (rawSlope * factor).toFixed(4) : "—";
                      const convUnit =
                        isC || isF ? ` ${convertSlopeUnitLabel(rawSlopeUnit, tempUnit)}` : "";
                      return (
                        <div className="flex justify-between gap-2">
                          <span>Mann-Kendall p / Theil-Sen</span>
                          <span className="ws-numeric text-text-primary">
                            p={selectedNode.properties.p_value.toFixed(4)} ·{" "}
                            {typeof rawSlope === "number" && rawSlope * factor >= 0 ? "+" : ""}
                            {convSlope}
                            {convUnit}
                          </span>
                        </div>
                      );
                    })()}
                  {comparison && (
                    <div className="flex justify-between gap-2 border-t border-border pt-2">
                      <span>Pearson r / Detrended r*</span>
                      <span className="ws-numeric text-text-primary">
                        r={comparison.pearsonR.toFixed(2)} · r*={comparison.detrendedR.toFixed(2)} (Δt=
                        {comparison.optimalLagSteps} {comparison.lagUnit})
                      </span>
                    </div>
                  )}
                </div>
              </details>
            )}

            {actionMsg && (
              <div role="status" className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{actionMsg}</span>
              </div>
            )}
          </div>
        )}

        {(prefs.showChart || prefs.showTrends || prefs.showScience || isComparingTwoSpots) &&
          (activeSummary || comparison || selectedNode?.properties.p_value !== undefined) && (
            <div
              aria-label="Statistics key for students and judges"
              className="space-y-1 rounded-sm border border-border bg-surface-inset p-2.5 font-sans text-[11px] leading-relaxed text-text-muted"
            >
              <div>
                <strong className="text-text-primary">p-value &lt; 0.05:</strong> Less than a 5% chance the trend is random weather luck.
              </div>
              <div>
                <strong className="text-text-primary">Theil-Sen Slope:</strong> Median yearly rate of change (ignores one-off outlier storms).
              </div>
              <div>
                <strong className="text-text-primary">Seasonal MK (p_s):</strong> Compares matching calendar months year-to-year so winter/summer swings never bias the trend.
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
