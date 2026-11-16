"use client";

import type {
  CrossRegionComparison,
  CurrentEarthConditions,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  RelationCategory,
  TelemetryFailureKind,
  TelemetryQueryDiagnostics,
  TemperatureUnit,
  TrendAnalysisSummary,
  TrendMicroscopeScanResult,
} from "@/types/etg";
import { convertSlopeUnitLabel } from "@/lib/earth/currentConditionsClient";

export type SpotInspectorTab = "overview" | "trends" | "relations" | "science";

export interface SpotViewPrefs {
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

export const DEFAULT_SPOT_VIEW_PREFS: SpotViewPrefs = {
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

export const SPOT_VIEW_PREFS_KEY = "etg:spot-view-prefs:v3";

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

export interface CompactSpotCardProps {
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
  onOpenBriefing?: (nodeUuid: string) => void;
  onSatelliteZoomSpot?: (lat: number, lng: number) => void;
  onOpenSolarForSpot?: (lat: number, lng: number, label: string) => void;
  isWide?: boolean;
  onToggleWide?: () => void;
  onGraphUpdated: () => Promise<void>;
  onClose: () => void;
}

export function relationCategoryStyles(cat: RelationCategory): {
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

export function summaryKey(s: Pick<TrendAnalysisSummary, "dataset" | "parameter">): string {
  return `${s.dataset}:${s.parameter}`;
}

export function formatObservedStamp(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/);
  if (m) return `${m[1]} local`;
  return iso.slice(0, 10);
}

/** Compute unit-conversion scale factor & display unit label for temperature slopes. */
export function resolveTemperatureSlopeScale(
  rawSlopeUnit: string,
  tempUnit: TemperatureUnit,
  forceTemp = false
): { factor: number; unit: string; isTempSlope: boolean } {
  const isC = /(?:°\s*c|deg\s*c|celsius)/i.test(rawSlopeUnit);
  const isF = /(?:°\s*f|deg\s*f|fahrenheit)/i.test(rawSlopeUnit);
  const isTempSlope = forceTemp || isC || isF;
  const factor = isTempSlope && tempUnit === "F" && !isF ? 1.8 : isTempSlope && tempUnit === "C" && isF ? 1 / 1.8 : 1;
  const unit = isTempSlope ? convertSlopeUnitLabel(rawSlopeUnit, tempUnit) : rawSlopeUnit;
  return { factor, unit, isTempSlope };
}
