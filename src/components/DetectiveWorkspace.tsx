"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Download,
  GitCompare,
  Globe2,
  MoreVertical,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Upload,
  X,
} from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { findMultiHopCascades } from "@/lib/graph/cascadeTracer";
import { ETG_LABEL_PALETTE, filterEtgGraphData } from "@/lib/graph/graphVisuals";
import type {
  CandidateLinkSuggestion,
  CrossRegionComparison,
  CurrentEarthConditions,
  EarthCascadeChain,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGNodeLabel,
  ETGRelationshipType,
  NodeTrendMicroscopeCue,
  RelationCategory,
  SubgraphTraversalResult,
  TelemetryFailureKind,
  TelemetryQueryDiagnostics,
  TemperatureUnit,
  TrendAnalysisSummary,
  TrendMicroscopeScanResult,
} from "@/types/etg";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import { inferEmbeddedSeriesUnits } from "@/lib/earth/currentConditionsClient";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  ALL_ETG_RELATIONSHIP_TYPES,
  ALL_RELATION_CATEGORIES,
  RELATION_CATEGORY_META,
  classifyRelationCategory,
  findNearbyFilteredNodes,
  formatRelationForDisplay,
  getRelationshipTypesForFilter,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import { assignNodeRegions, extractRegionOptions } from "@/lib/graph/regionalSubgraph";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DatasetSelector } from "@/components/DatasetSelector";
import { TimelineScrubber } from "@/components/TimelineScrubber";
import {
  EarthGlobe3D,
  type ComparisonArcVisualMeta,
  type RegionalFocusRequest,
} from "@/components/EarthGlobe3D";
import {
  EarthTrendGraphView,
  type TraversalFilterState,
} from "@/components/EarthTrendGraphView";
import { GraphNodeWorkbenchPanel } from "@/components/GraphNodeWorkbenchPanel";
import { CompactSpotCard, type GuidedCaseStudyItem } from "@/components/CompactSpotCard";
import { IngestionModal, type IngestionTabId } from "@/components/IngestionModal";
import { SolarMicrogridPanel } from "@/components/SolarMicrogridPanel";
import { AiGraphChatPanel } from "@/components/AiGraphChatPanel";

type WorkspaceViewMode = "graph" | "globe";
type GraphRenderMode = "3d" | "2d";

const DEFAULT_MULTI_TOPICS: ETGDatasetId[] = [
  "nasa_power",
  "wildfire",
  "hydrology",
  "ocean_temp",
  "deforestation",
];

const GRIDDED_TOPIC_SET = new Set<ETGDatasetId>([
  "nasa_power",
  "wildfire",
  "hydrology",
  "ocean_temp",
  "deforestation",
  "air_quality",
]);

const EMPTY_ROLE_BY_NODE: SubgraphTraversalResult["roleByNode"] = {};
const EMPTY_HOP_BY_NODE: SubgraphTraversalResult["hopByNode"] = {};
const EMPTY_CASCADE_EDGE_UUIDS: string[] = [];

function getNodeTimestampMs(node: ETGNode): number {
  const raw = node.properties.observed_at || node.properties.created_at;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isSameSpotCoord(
  a: { lat: number; lng: number } | null | undefined,
  lat: number,
  lng: number
): boolean {
  return Boolean(
    a &&
      Number.isFinite(a.lat) &&
      Number.isFinite(a.lng) &&
      Math.hypot(a.lat - lat, a.lng - lng) <= 0.25
  );
}

function computeClientEmbeddedSummary(
  node: ETGNode | null | undefined
): TrendAnalysisSummary | null {
  if (!node) return null;
  if (
    typeof node.properties.lat !== "number" ||
    typeof node.properties.lng !== "number"
  ) {
    return null;
  }
  const rawSeries = node.properties.series;
  if (!Array.isArray(rawSeries) || rawSeries.length < 5) return null;

  const cleanSeries = rawSeries.filter(
    (pt) =>
      pt &&
      typeof pt.date === "string" &&
      typeof pt.t === "number" &&
      Number.isFinite(pt.t) &&
      typeof pt.value === "number" &&
      Number.isFinite(pt.value)
  );
  if (cleanSeries.length < 5) return null;

  const { unit, slopeUnit } = inferEmbeddedSeriesUnits(node.properties);
  return analyzeTimeSeries(cleanSeries, {
    lat: node.properties.lat,
    lng: node.properties.lng,
    dataset: node.properties.dataset || "nasa_power",
    parameter: node.properties.parameter || node.properties.name,
    unit,
    slopeUnit,
    provenance: node.properties.provenance_source || "Empirical Dataset (Imported)",
  });
}

function hidePopoverById(id: string) {
  const el = document.getElementById(id) as (HTMLElement & { hidePopover?: () => void }) | null;
  if (el && typeof el.hidePopover === "function") {
    try {
      el.hidePopover();
    } catch {
      // Safe no-op if popover is already closed
    }
  }
}

export interface GuidedDipoleCase {
  id: string;
  shortLabel: string;
  title: string;
  subtitle: string;
  spotA: { lat: number; lng: number; dataset: ETGDatasetId; name: string };
  spotB: { lat: number; lng: number; dataset: ETGDatasetId; name: string };
}

export const GUIDED_DIPOLE_CASES: readonly GuidedDipoleCase[] = [
  {
    id: "enso-pacific-dipole",
    shortLabel: "Indo-Pacific vs. Madagascar",
    title: "Walker / ENSO Warm Pool vs. Madagascar Drying",
    subtitle:
      "Western Pacific warm-pool ocean warming contrasted with SW Indian Ocean / Madagascar canopy & moisture decline",
    spotA: { lat: 2.0, lng: 145.0, dataset: "ocean_temp", name: "Indo-Pacific Warm Pool" },
    spotB: { lat: -20.513, lng: 45.91, dataset: "deforestation", name: "SW Indian Ocean / Madagascar" },
  },
  {
    id: "arctic-north-atlantic",
    shortLabel: "Arctic vs. Subpolar Gyre",
    title: "Arctic Amplification vs. Subpolar Gyre",
    subtitle:
      "Rapid high-Arctic surface warming contrasted against North Atlantic subpolar ocean temperature shifts",
    spotA: { lat: 78.22, lng: 15.63, dataset: "nasa_power", name: "Svalbard / Barents Sea" },
    spotB: { lat: 53.0, lng: -35.0, dataset: "ocean_temp", name: "Subpolar North Atlantic" },
  },
  {
    id: "western-us-aridity-east-hydro",
    shortLabel: "West VPD vs. Plains River",
    title: "Western Fire Aridity vs. Northern Plains Discharge",
    subtitle:
      "Rising Vapor Pressure Deficit fuel aridity in Northern California contrasted against Northern Plains river discharge shifts",
    spotA: { lat: 39.73, lng: -121.61, dataset: "wildfire", name: "Northern California Foothills" },
    spotB: { lat: 49.9, lng: -97.1, dataset: "hydrology", name: "Red River / Northern Plains" },
  },
  {
    id: "boulder-front-range-aridity",
    shortLabel: "Boulder VPD vs. Divide Moisture",
    title: "Boulder Front Range Aridity vs. Continental Divide Moisture",
    subtitle:
      "Boulder foothills warming & Vapor Pressure Deficit shifts contrasted with high-elevation Continental Divide snow/moisture",
    spotA: { lat: 40.015, lng: -105.2705, dataset: "wildfire", name: "Boulder, CO (Front Range)" },
    spotB: { lat: 40.055, lng: -105.588, dataset: "hydrology", name: "Niwot Ridge / Continental Divide" },
  },
];

const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

/**
 * Computes a framing center and camera radius that keeps both dipole endpoints
 * in view while avoiding polar pull on wide trans-oceanic pairs (e.g., Peru ↔ Australia).
 */
export function computeDipoleFramingTarget(
  spotA: { lat: number; lng: number },
  spotB: { lat: number; lng: number }
): { lat: number; lng: number; radius: number } {
  const phi1 = spotA.lat * TO_RAD;
  const lam1 = spotA.lng * TO_RAD;
  const phi2 = spotB.lat * TO_RAD;
  const lam2 = spotB.lng * TO_RAD;

  const u1x = Math.cos(phi1) * Math.cos(lam1);
  const u1y = Math.sin(phi1);
  const u1z = Math.cos(phi1) * Math.sin(lam1);

  const u2x = Math.cos(phi2) * Math.cos(lam2);
  const u2y = Math.sin(phi2);
  const u2z = Math.cos(phi2) * Math.sin(lam2);

  const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y + u1z * u2z));
  const omega = Math.acos(dot);

  let mx = u1x + u2x;
  let my = u1y + u2y;
  let mz = u1z + u2z;
  let mLenSq = mx * mx + my * my + mz * mz;

  if (mLenSq < 1e-6) {
    // Nearly antipodal: cross u1 with an orthogonal reference axis
    const ax = Math.abs(u1y) < 0.9 ? 0 : 1;
    const ay = Math.abs(u1y) < 0.9 ? 1 : 0;
    const az = 0;
    mx = u1y * az - u1z * ay;
    my = u1z * ax - u1x * az;
    mz = u1x * ay - u1y * ax;
    mLenSq = mx * mx + my * my + mz * mz || 1;
  }

  const mLen = Math.sqrt(mLenSq);
  mx /= mLen;
  my /= mLen;
  mz /= mLen;

  const midLat = Math.asin(Math.max(-1, Math.min(1, my))) * TO_DEG;
  const midLng = Math.atan2(mz, mx) * TO_DEG;
  const lat = omega > 1.8 ? (spotA.lat + spotB.lat) / 2 : midLat;
  const radius = Math.min(295, Math.max(248, Math.round(238 + omega * 22)));

  return { lat, lng: midLng, radius };
}

export function DetectiveWorkspace({
  initialSnapshot,
  initialDemoMode = null,
}: {
  initialSnapshot: EtgGraphSnapshot;
  initialDemoMode?: "spaceapps" | "veritas" | null;
}) {
  const bundleInputId = useId();
  const [snapshot, setSnapshot] = useState<EtgGraphSnapshot>(initialSnapshot);
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>("globe");
  const [graphRenderMode, setGraphRenderMode] = useState<GraphRenderMode>("3d");

  const [activeTopics, setActiveTopics] = useState<ETGDatasetId[]>([]);
  const [onlyOpposite, setOnlyOpposite] = useState(false);
  const [showSuperseded, setShowSuperseded] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  // Start clean: no pre-selected node and Right Inspector closed on initial load
  const [selectedNodeUuid, setSelectedNodeUuid] = useState<string | null>(null);
  const [selectedEdgeUuid, setSelectedEdgeUuid] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [probedCoord, setProbedCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [comparePinB, setComparePinB] = useState<{ lat: number; lng: number } | null>(null);
  const [relationNodePair, setRelationNodePair] = useState<{
    sourceUuid?: string;
    targetUuid?: string;
  } | null>(null);
  const [activeCascade, setActiveCascade] = useState<EarthCascadeChain | null>(null);
  const [activeCaseStudyId, setActiveCaseStudyId] = useState<string | null>(null);
  const [solarGraphOpen, setSolarGraphOpen] = useState(false);
  const [aiStudioOpen, setAiStudioOpen] = useState<boolean>(
    () => initialDemoMode !== "veritas" && initialDemoMode !== "spaceapps"
  );
  const [regionalFocusRequest, setRegionalFocusRequest] =
    useState<RegionalFocusRequest | null>(null);
  const regionalFocusSeqRef = useRef(0);

  const requestRegionalFocus = useCallback((lat: number, lng: number, radius = 132) => {
    regionalFocusSeqRef.current += 1;
    setRegionalFocusRequest({
      lat,
      lng,
      radius,
      seq: regionalFocusSeqRef.current,
    });
  }, []);

  // Flexible Knowledge Graph Workbench State
  const [connectMode, setConnectMode] = useState(false);
  const [connectSourceUuid, setConnectSourceUuid] = useState<string | null>(null);
  const [pendingConnectPair, setPendingConnectPair] = useState<{
    sourceUuid: string;
    targetUuid: string;
  } | null>(null);
  const [quickAddNodeOpen, setQuickAddNodeOpen] = useState(false);
  const [candidateLinks, setCandidateLinks] = useState<CandidateLinkSuggestion[]>([]);
  const [discoveringLinks, setDiscoveringLinks] = useState(false);
  const [traversalFilter, setTraversalFilter] = useState<TraversalFilterState>({
    maxHops: null,
    direction: "both",
    layoutMode: "force",
  });
  const [traversalSubgraph, setTraversalSubgraph] = useState<SubgraphTraversalResult | null>(null);
  const [traversalHistory, setTraversalHistory] = useState<Array<{ uuid: string; name: string }>>([]);
  const [selectedRegionScope, setSelectedRegionScope] = useState<string | null>(null);

  // Timeline state (used in 3D Earth view & observation filtering)
  const { minMs, maxMs } = useMemo(() => {
    const times = snapshot.nodes.map(getNodeTimestampMs);
    const min = Math.min(...times);
    const max = Math.max(...times);
    return {
      minMs: Number.isFinite(min) ? min : Date.UTC(2024, 0, 1),
      maxMs: Number.isFinite(max) ? max : Date.now(),
    };
  }, [snapshot.nodes]);

  const [cutoffMs, setCutoffMs] = useState<number>(maxMs);
  useEffect(() => {
    setCutoffMs((prev) => (prev >= maxMs - 60_000 ? maxMs : prev));
  }, [maxMs]);

  // Telemetry state
  const [telemetryPrimary, setTelemetryPrimary] = useState<TrendAnalysisSummary | null>(null);
  const [telemetrySecondary, setTelemetrySecondary] = useState<TrendAnalysisSummary | null>(null);
  const [telemetryCurrent, setTelemetryCurrent] = useState<CurrentEarthConditions | null>(null);
  const [telemetrySecondaryCurrent, setTelemetrySecondaryCurrent] =
    useState<CurrentEarthConditions | null>(null);
  const [telemetrySummaries, setTelemetrySummaries] = useState<TrendAnalysisSummary[]>([]);
  const [focusedSummaryDataset, setFocusedSummaryDataset] = useState<ETGDatasetId | null>(null);
  const [comparison, setComparison] = useState<CrossRegionComparison | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [telemetryDiagnostics, setTelemetryDiagnostics] =
    useState<TelemetryQueryDiagnostics | null>(null);
  const [telemetryFailureKind, setTelemetryFailureKind] =
    useState<TelemetryFailureKind | null>(null);

  // User display preferences (persisted in localStorage)
  const [tempUnit, setTempUnit] = useState<TemperatureUnit>("C");
  const [tempUnitHydrated, setTempUnitHydrated] = useState(false);
  const [mobileSheetCollapsed, setMobileSheetCollapsed] = useState(false);
  const [enabledRelationCategories, setEnabledRelationCategories] = useState<RelationCategory[]>([
    ...ALL_RELATION_CATEGORIES,
  ]);
  const [relationPopoverFilter, setRelationPopoverFilter] = useState<
    "all" | "opposite" | "causal" | "coupled" | "chains"
  >("all");

  useEffect(() => {
    try {
      const savedUnit = window.localStorage.getItem("etg:temp-unit:v1");
      if (savedUnit === "C" || savedUnit === "F") {
        setTempUnit(savedUnit);
      }
    } catch {
      // Ignore storage errors
    } finally {
      setTempUnitHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!tempUnitHydrated) return;
    try {
      window.localStorage.setItem("etg:temp-unit:v1", tempUnit);
    } catch {
      // Ignore storage errors
    }
  }, [tempUnitHydrated, tempUnit]);

  const toggleRelationCategoryFilter = useCallback((cat: RelationCategory) => {
    setEnabledRelationCategories((prev) =>
      prev.includes(cat) ? prev.filter((item) => item !== cat) : [...prev, cat]
    );
  }, []);

  // Modal state
  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestTab, setIngestTab] = useState<IngestionTabId>("dataset");

  // Transient status toast (auto-dismissed)
  const [eonetBusy, setEonetBusy] = useState(false);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!statusMessage) return;
    const t = window.setTimeout(() => setStatusMessage(null), 4500);
    return () => window.clearTimeout(t);
  }, [statusMessage]);

  const [microscopeScan, setMicroscopeScan] = useState<TrendMicroscopeScanResult | null>(null);

  // View-transition focus target & telemetry refs
  const viewHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const telemetrySummariesRef = useRef<TrendAnalysisSummary[]>([]);
  telemetrySummariesRef.current = telemetrySummaries;
  const telemetryPrimaryRef = useRef<TrendAnalysisSummary | null>(null);
  telemetryPrimaryRef.current = telemetryPrimary;
  const telemetryCurrentRef = useRef<CurrentEarthConditions | null>(null);
  telemetryCurrentRef.current = telemetryCurrent;
  const telemetryLoadingRef = useRef(false);
  telemetryLoadingRef.current = telemetryLoading;
  const telemetryReqSeqRef = useRef(0);
  const telemetryAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      telemetryAbortRef.current?.abort();
    };
  }, []);
  const lastTelemetryArgsRef = useRef<{
    lat: number;
    lng: number;
    dataset: ETGDatasetId;
    compareWith?: { lat: number; lng: number; dataset?: ETGDatasetId; nodeUuid?: string };
    nodeUuid?: string;
    datasetsList?: ETGDatasetId[];
  } | null>(null);

  // Auto-expand mobile Spot Summary sheet whenever user selects a new spot/node/relation
  useEffect(() => {
    setMobileSheetCollapsed(false);
  }, [selectedNodeUuid, selectedEdgeUuid, probedCoord]);

  // Close Right Inspector Sheet / Cancel Connect or Compare Mode with Escape key
  // (after any open native popover or modal dialog handles Escape first)
  useEffect(() => {
    if (!inspectorOpen && !connectMode && !quickAddNodeOpen && !compareMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[popover]:popover-open, dialog[open], [role="dialog"]')) {
        return;
      }
      setInspectorOpen(false);
      setSelectedNodeUuid(null);
      setSelectedEdgeUuid(null);
      setCompareMode(false);
      setConnectMode(false);
      setConnectSourceUuid(null);
      setPendingConnectPair(null);
      setQuickAddNodeOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [inspectorOpen, connectMode, quickAddNodeOpen, compareMode]);

  // Keep server-computed k-hop subgraph & causal roles synchronized when traversing
  useEffect(() => {
    if (viewMode !== "graph" || !selectedNodeUuid) {
      setTraversalSubgraph(null);
      return;
    }
    const needTraversal =
      traversalFilter.maxHops !== null ||
      traversalFilter.direction !== "both" ||
      traversalFilter.layoutMode === "causal_flow";
    if (!needTraversal) {
      setTraversalSubgraph(null);
      return;
    }

    const allowedEdgeTypes = getRelationshipTypesForFilter(
      onlyOpposite,
      enabledRelationCategories
    );
    if (allowedEdgeTypes.length === 0) {
      const rootNode = snapshot.nodes.find((n) => n.uuid === selectedNodeUuid);
      setTraversalSubgraph(
        rootNode
          ? {
              rootUuid: rootNode.uuid,
              maxHops: traversalFilter.maxHops ?? 3,
              direction: traversalFilter.direction,
              nodes: [rootNode],
              edges: [],
              hopByNode: { [rootNode.uuid]: 0 },
              roleByNode: { [rootNode.uuid]: "root" },
              causalPaths: [],
            }
          : null
      );
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const params = new URLSearchParams({
      mode: "subgraph",
      rootUuid: selectedNodeUuid,
      maxHops: String(traversalFilter.maxHops ?? 3),
      direction: traversalFilter.direction,
      includeSuperseded: String(showSuperseded),
    });
    if (allowedEdgeTypes.length < ALL_ETG_RELATIONSHIP_TYPES.length) {
      params.set("edgeTypes", allowedEdgeTypes.join(","));
    }

    fetch(`/api/graph/traverse?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && !controller.signal.aborted && data && Array.isArray(data.nodes)) {
          setTraversalSubgraph(data as SubgraphTraversalResult);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        if (!cancelled) setTraversalSubgraph(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    viewMode,
    selectedNodeUuid,
    traversalFilter.maxHops,
    traversalFilter.direction,
    traversalFilter.layoutMode,
    showSuperseded,
    onlyOpposite,
    enabledRelationCategories,
    snapshot.edges.length,
    snapshot.nodes.length,
  ]);

  // Keep ETG Trend Microscope radar cues synchronized with live graph & selection
  useEffect(() => {
    if (snapshot.nodes.length === 0) {
      setMicroscopeScan(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const focusParam = selectedNodeUuid
      ? `&focusUuid=${encodeURIComponent(selectedNodeUuid)}`
      : "";
    fetch(`/api/graph/microscope?topK=8${focusParam}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && !controller.signal.aborted && data && Array.isArray(data.nodes)) {
          setMicroscopeScan(data as TrendMicroscopeScanResult);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        if (!cancelled) setMicroscopeScan(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [snapshot.nodes.length, snapshot.edges.length, selectedNodeUuid]);

  const microscopeByNode = useMemo<Record<string, NodeTrendMicroscopeCue>>(() => {
    const out: Record<string, NodeTrendMicroscopeCue> = {};
    for (const cue of microscopeScan?.nodes ?? []) {
      out[cue.uuid] = cue;
    }
    return out;
  }, [microscopeScan]);

  const refreshGraph = useCallback(async () => {
    const res = await fetch("/api/graph", { cache: "no-store" });
    if (res.ok) {
      const next = (await res.json()) as EtgGraphSnapshot;
      setSnapshot(next);
      if (next.nodes.length > 0) {
        setCutoffMs((prev) => {
          const nextMax = Math.max(...next.nodes.map(getNodeTimestampMs));
          return Math.max(prev, nextMax);
        });
      }
    }
  }, []);

  // Subscribe to live server-side ETG updates (webhooks, EONET syncs, MCP agent edits)
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/graph/stream");
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handleGraphUpdated = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshGraph();
      }, 250);
    };

    es.addEventListener("graph_updated", handleGraphUpdated);
    return () => {
      if (timer) clearTimeout(timer);
      es.removeEventListener("graph_updated", handleGraphUpdated);
      es.close();
    };
  }, [refreshGraph]);

  const queryTimeSeries = useCallback(
    async (
      lat: number,
      lng: number,
      dataset: ETGDatasetId,
      compareWith?: { lat: number; lng: number; dataset?: ETGDatasetId; nodeUuid?: string },
      nodeUuid?: string,
      datasetsList?: ETGDatasetId[]
    ) => {
      const reqId = ++telemetryReqSeqRef.current;
      telemetryAbortRef.current?.abort();
      const controller = new AbortController();
      telemetryAbortRef.current = controller;
      lastTelemetryArgsRef.current = {
        lat,
        lng,
        dataset,
        compareWith,
        nodeUuid,
        datasetsList,
      };
      setTelemetryLoading(true);
      setTelemetryError(null);
      try {
        const params = new URLSearchParams({
          lat: String(lat),
          lng: String(lng),
          dataset,
        });
        if (datasetsList && datasetsList.length > 0) {
          params.set("datasets", datasetsList.join(","));
        }
        if (nodeUuid) {
          params.set("node_uuid", nodeUuid);
        }
        if (compareWith) {
          params.set("compare_lat", String(compareWith.lat));
          params.set("compare_lng", String(compareWith.lng));
          params.set("compare_dataset", compareWith.dataset || dataset);
          if (compareWith.nodeUuid) {
            params.set("compare_node_uuid", compareWith.nodeUuid);
          }
        }
        const res = await fetch(`/api/earth/timeseries?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (controller.signal.aborted || reqId !== telemetryReqSeqRef.current) return;

        if (res.ok && data) {
          const incomingPrimary: TrendAnalysisSummary | null = data.primary ?? null;
          const incomingSummaries: TrendAnalysisSummary[] = Array.isArray(data.summaries)
            ? data.summaries
            : incomingPrimary
              ? [incomingPrimary]
              : [];
          const incomingDiagnostics: TelemetryQueryDiagnostics | null =
            data.diagnostics ?? null;
          const incomingCurrent: CurrentEarthConditions | null = data.current ?? null;

          const sameSpotPrevSummaries = telemetrySummariesRef.current.filter((s) =>
            isSameSpotCoord(s, lat, lng)
          );
          const sameSpotPrevCurrent =
            telemetryCurrentRef.current &&
            isSameSpotCoord(telemetryCurrentRef.current, lat, lng)
              ? telemetryCurrentRef.current
              : null;

          // If a transient partial retry failed for a topic we already loaded at this spot, preserve it
          let mergedSummaries = incomingSummaries;
          if (!compareWith && sameSpotPrevSummaries.length > 0) {
            const incomingKeys = new Set(
              incomingSummaries.map((s) => `${s.dataset}:${s.parameter}`)
            );
            const failedDatasets = new Set(
              (incomingDiagnostics?.datasets ?? [])
                .filter((d) => d.status === "failed_to_fetch")
                .map((d) => d.dataset)
            );
            const preserved = sameSpotPrevSummaries.filter(
              (s) =>
                !incomingKeys.has(`${s.dataset}:${s.parameter}`) &&
                failedDatasets.has(s.dataset)
            );
            if (preserved.length > 0) {
              mergedSummaries = [...incomingSummaries, ...preserved];
            }
          }

          const preservedCurrent =
            incomingCurrent ??
            (incomingDiagnostics?.current?.weatherStatus === "failed_to_fetch"
              ? sameSpotPrevCurrent
              : null);

          setTelemetryPrimary(
            incomingPrimary ?? mergedSummaries[0] ?? (sameSpotPrevSummaries[0] ?? null)
          );
          setTelemetrySecondary(data.secondary ?? null);
          setTelemetryCurrent(preservedCurrent);
          setTelemetrySecondaryCurrent(data.secondaryCurrent ?? null);
          setComparison(data.comparison ?? null);
          setTelemetrySummaries(mergedSummaries);
          setTelemetryDiagnostics(incomingDiagnostics);
          setTelemetryFailureKind(data.failureKind ?? null);
        } else {
          setTelemetryDiagnostics(data?.diagnostics ?? null);
          setTelemetryFailureKind(data?.failureKind ?? "failed_to_fetch");
          setTelemetryError(
            data?.error ||
              `Failed to fetch telemetry from /api/earth/timeseries (HTTP ${res.status}).`
          );
        }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        if (reqId !== telemetryReqSeqRef.current) return;
        const rawMsg =
          err instanceof Error ? err.message : "Failed to fetch live Earth data.";
        const friendlyMsg = /failed to fetch|networkerror|load failed|fetch failed/i.test(
          rawMsg
        )
          ? "Failed to fetch telemetry from /api/earth/timeseries (local server or network unreachable)."
          : rawMsg;
        setTelemetryFailureKind("failed_to_fetch");
        setTelemetryError(friendlyMsg);
      } finally {
        if (telemetryAbortRef.current === controller) {
          telemetryAbortRef.current = null;
        }
        if (!controller.signal.aborted && reqId === telemetryReqSeqRef.current) {
          setTelemetryLoading(false);
        }
      }
    },
    []
  );

  const retryTelemetry = useCallback(() => {
    const last = lastTelemetryArgsRef.current;
    if (!last) return;
    void queryTimeSeries(
      last.lat,
      last.lng,
      last.dataset,
      last.compareWith,
      last.nodeUuid,
      last.datasetsList
    );
  }, [queryTimeSeries]);

  const toggleTopic = useCallback((ds: ETGDatasetId) => {
    setActiveTopics((prev) =>
      prev.includes(ds) ? prev.filter((item) => item !== ds) : [...prev, ds]
    );
  }, []);

  const resetTopics = useCallback(() => {
    setActiveTopics([]);
  }, []);

  // Switch primary view with typed View Transitions API (coalesce-to-graph / expand-to-globe) + focus management
  const handleSwitchView = useCallback(
    (nextMode: WorkspaceViewMode) => {
      if (nextMode === viewMode) return;

      const focusStageHeading = () => {
        viewHeadingRef.current?.focus({ preventScroll: true });
      };

      const docWithTransition = document as Document & {
        startViewTransition?: (
          arg:
            | (() => void)
            | {
                update: () => void;
                types?: string[];
              }
        ) => { finished: Promise<void> };
      };

      const transitionType =
        nextMode === "graph" ? "coalesce-to-graph" : "expand-to-globe";

      if (typeof docWithTransition.startViewTransition === "function") {
        let updated = false;
        const applyUpdate = () => {
          updated = true;
          flushSync(() => {
            setViewMode(nextMode);
          });
        };
        let transition: { finished: Promise<void> };
        try {
          transition = docWithTransition.startViewTransition({
            update: applyUpdate,
            types: [transitionType],
          });
        } catch {
          transition = updated
            ? { finished: Promise.resolve() }
            : docWithTransition.startViewTransition(applyUpdate);
        }
        void transition.finished.finally(() => {
          focusStageHeading();
        });
      } else {
        setViewMode(nextMode);
        requestAnimationFrame(() => {
          focusStageHeading();
        });
      }
    },
    [viewMode]
  );

  // Filtered nodes & edges based on active topic filters + timeline cutoff
  const { visibleNodes, visibleEdges, globeNodes, globeEdges } = useMemo(() => {
    const timeFiltered = snapshot.nodes.filter((n) => {
      const ts = getNodeTimestampMs(n);
      if (n.label === "Rule") return true;
      return ts <= cutoffMs;
    });

    if (activeTopics.length === 0) {
      const idSet = new Set(timeFiltered.map((n) => n.uuid));
      const edges = snapshot.edges.filter(
        (e) => idSet.has(e.source_uuid) && idSet.has(e.target_uuid)
      );
      return {
        visibleNodes: timeFiltered,
        visibleEdges: edges,
        globeNodes: timeFiltered,
        globeEdges: edges,
      };
    }

    const topicSet = new Set(activeTopics);
    const strictIds = new Set(
      timeFiltered
        .filter((n) => n.properties.dataset && topicSet.has(n.properties.dataset))
        .map((n) => n.uuid)
    );

    const strictGlobeNodes = timeFiltered.filter((n) => strictIds.has(n.uuid));
    const strictGlobeEdges = snapshot.edges.filter(
      (e) => strictIds.has(e.source_uuid) && strictIds.has(e.target_uuid)
    );

    const graphIds = new Set(strictIds);
    for (const e of snapshot.edges) {
      if (strictIds.has(e.source_uuid) || strictIds.has(e.target_uuid)) {
        const srcNode = timeFiltered.find((n) => n.uuid === e.source_uuid);
        const tgtNode = timeFiltered.find((n) => n.uuid === e.target_uuid);
        if (srcNode && (srcNode.label === "Rule" || srcNode.label === "Concept")) {
          graphIds.add(srcNode.uuid);
        }
        if (tgtNode && (tgtNode.label === "Rule" || tgtNode.label === "Concept")) {
          graphIds.add(tgtNode.uuid);
        }
      }
    }

    const filteredGraphNodes = timeFiltered.filter((n) => graphIds.has(n.uuid));
    const filteredGraphSet = new Set(filteredGraphNodes.map((n) => n.uuid));
    const filteredGraphEdges = snapshot.edges.filter(
      (e) => filteredGraphSet.has(e.source_uuid) && filteredGraphSet.has(e.target_uuid)
    );

    return {
      visibleNodes: filteredGraphNodes,
      visibleEdges: filteredGraphEdges,
      globeNodes: strictGlobeNodes,
      globeEdges: strictGlobeEdges,
    };
  }, [snapshot.nodes, snapshot.edges, activeTopics, cutoffMs]);

  const activeTraversal = useMemo(
    () =>
      traversalSubgraph && traversalSubgraph.rootUuid === selectedNodeUuid
        ? traversalSubgraph
        : null,
    [traversalSubgraph, selectedNodeUuid]
  );

  const { graphNodes, graphEdges } = useMemo(() => {
    const useSubgraphSubset =
      traversalFilter.maxHops !== null && activeTraversal !== null;
    if (!useSubgraphSubset || !activeTraversal) {
      return { graphNodes: visibleNodes, graphEdges: visibleEdges };
    }
    const visibleIdSet = new Set(visibleNodes.map((n) => n.uuid));
    const scopedNodes = activeTraversal.nodes.filter((n) => visibleIdSet.has(n.uuid));
    const scopedSet = new Set(scopedNodes.map((n) => n.uuid));
    const scopedEdges = activeTraversal.edges.filter(
      (e) => scopedSet.has(e.source_uuid) && scopedSet.has(e.target_uuid)
    );
    return { graphNodes: scopedNodes, graphEdges: scopedEdges };
  }, [visibleNodes, visibleEdges, traversalFilter.maxHops, activeTraversal]);

  const filteredGraphSubset = useMemo(
    () =>
      filterEtgGraphData(
        graphNodes,
        graphEdges,
        onlyOpposite,
        showSuperseded,
        enabledRelationCategories
      ),
    [graphNodes, graphEdges, onlyOpposite, showSuperseded, enabledRelationCategories]
  );

  const nodeRegionMap = useMemo(
    () => assignNodeRegions(filteredGraphSubset.visibleNodes),
    [filteredGraphSubset.visibleNodes]
  );
  const regionOptions = useMemo(
    () => extractRegionOptions(filteredGraphSubset.visibleNodes),
    [filteredGraphSubset.visibleNodes]
  );

  useEffect(() => {
    if (
      selectedRegionScope !== null &&
      !regionOptions.some((o) => o.id === selectedRegionScope)
    ) {
      setSelectedRegionScope(null);
    }
  }, [selectedRegionScope, regionOptions]);

  const prevSelectedNodeForRegionRef = useRef<string | null>(selectedNodeUuid);
  useEffect(() => {
    if (selectedNodeUuid === prevSelectedNodeForRegionRef.current) return;
    prevSelectedNodeForRegionRef.current = selectedNodeUuid;
    if (selectedNodeUuid && selectedRegionScope !== null) {
      const nextReg = nodeRegionMap.get(selectedNodeUuid)?.id;
      if (
        nextReg &&
        nextReg !== selectedRegionScope &&
        regionOptions.some((o) => o.id === nextReg)
      ) {
        setSelectedRegionScope(nextReg);
      }
    }
  }, [selectedNodeUuid, selectedRegionScope, nodeRegionMap, regionOptions]);

  const selectedNode = useMemo(
    () => snapshot.nodes.find((n) => n.uuid === selectedNodeUuid) || null,
    [snapshot.nodes, selectedNodeUuid]
  );

  const selectedEdge = useMemo(
    () => snapshot.edges.find((e) => e.properties.uuid === selectedEdgeUuid) || null,
    [snapshot.edges, selectedEdgeUuid]
  );

  const relationSourceNode = useMemo(() => {
    const id = selectedEdge?.source_uuid ?? relationNodePair?.sourceUuid;
    return id ? snapshot.nodes.find((n) => n.uuid === id) || null : null;
  }, [snapshot.nodes, selectedEdge, relationNodePair]);

  const relationTargetNode = useMemo(() => {
    const id = selectedEdge?.target_uuid ?? relationNodePair?.targetUuid;
    return id ? snapshot.nodes.find((n) => n.uuid === id) || null : null;
  }, [snapshot.nodes, selectedEdge, relationNodePair]);

  const probedAnchorUuid = useMemo(() => {
    if (selectedNodeUuid) return selectedNodeUuid;
    if (!probedCoord) return null;
    const hit = findNearbyFilteredNodes(
      probedCoord.lat,
      probedCoord.lng,
      globeNodes,
      850,
      1
    )[0];
    return hit?.node.uuid ?? null;
  }, [selectedNodeUuid, probedCoord, globeNodes]);

  const cascades = useMemo(
    () =>
      findMultiHopCascades(
        visibleNodes,
        visibleEdges,
        selectedNodeUuid ?? undefined,
        6
      ),
    [visibleNodes, visibleEdges, selectedNodeUuid]
  );

  // Keep open coordinate digest synchronized when user toggles topic filters
  const activeTopicsKey = activeTopics.join(",");
  useEffect(() => {
    if (!inspectorOpen || !probedCoord || selectedNodeUuid || comparePinB || selectedEdgeUuid) {
      return;
    }
    if (telemetryLoadingRef.current) return;

    const requested = activeTopics.length > 0 ? activeTopics : DEFAULT_MULTI_TOPICS;
    const griddedNeeded = requested.filter((ds) => GRIDDED_TOPIC_SET.has(ds));
    if (griddedNeeded.length === 0) return;

    const current = telemetrySummariesRef.current;
    const sameSpot =
      current.length > 0 &&
      Math.abs(current[0].lat - probedCoord.lat) < 0.6 &&
      Math.abs(current[0].lng - probedCoord.lng) < 0.6;
    const loadedSet = new Set(sameSpot ? current.map((s) => s.dataset) : []);
    const missing = griddedNeeded.filter((ds) => !loadedSet.has(ds));

    if (missing.length > 0) {
      const targetTopics = Array.from(new Set([...Array.from(loadedSet), ...missing]));
      void queryTimeSeries(
        probedCoord.lat,
        probedCoord.lng,
        targetTopics[0],
        undefined,
        undefined,
        targetTopics
      );
    }
  }, [
    activeTopicsKey,
    activeTopics,
    inspectorOpen,
    probedCoord,
    selectedNodeUuid,
    comparePinB,
    selectedEdgeUuid,
    queryTimeSeries,
  ]);

  const handleSelectNode = useCallback(
    (node: ETGNode) => {
      setSelectedNodeUuid(node.uuid);
      setSelectedEdgeUuid(null);
      setComparePinB(null);
      setCompareMode(false);
      setActiveCaseStudyId(null);
      setRelationNodePair(null);
      setFocusedSummaryDataset(null);
      setQuickAddNodeOpen(false);
      setPendingConnectPair(null);
      setConnectSourceUuid(null);
      setConnectMode(false);
      setTraversalHistory((prev) => {
        if (prev[prev.length - 1]?.uuid === node.uuid) return prev;
        return [...prev.slice(-11), { uuid: node.uuid, name: node.properties.name }];
      });
      setInspectorOpen(true);
      const embedded = computeClientEmbeddedSummary(node);
      if (
        typeof node.properties.lat === "number" &&
        typeof node.properties.lng === "number"
      ) {
        const lat = node.properties.lat;
        const lng = node.properties.lng;
        const prevAnchor =
          telemetryPrimaryRef.current ??
          telemetrySummariesRef.current[0] ??
          telemetryCurrentRef.current;
        const sameSpot = isSameSpotCoord(prevAnchor, lat, lng);

        setProbedCoord({ lat, lng });
        setTelemetrySecondary(null);
        setTelemetrySecondaryCurrent(null);
        setComparison(null);
        setTelemetryError(null);
        setTelemetryFailureKind(null);
        if (!sameSpot) {
          setTelemetryCurrent(null);
          setTelemetryDiagnostics(null);
        }
        const nextSeed = embedded
          ? [embedded]
          : sameSpot
            ? telemetrySummariesRef.current.filter((s) => isSameSpotCoord(s, lat, lng))
            : [];
        setTelemetryPrimary(
          embedded ?? (sameSpot ? telemetryPrimaryRef.current : null)
        );
        setTelemetrySummaries(nextSeed);

        const ds: ETGDatasetId =
          node.properties.dataset || activeTopics[0] || "nasa_power";
        const multi = (
          activeTopics.length > 0 ? activeTopics : DEFAULT_MULTI_TOPICS
        ).filter((item) => GRIDDED_TOPIC_SET.has(item));
        void queryTimeSeries(
          lat,
          lng,
          ds,
          undefined,
          node.uuid,
          multi.length >= 2 ? multi : undefined
        );
      } else {
        telemetryReqSeqRef.current += 1;
        telemetryAbortRef.current?.abort();
        telemetryAbortRef.current = null;
        setProbedCoord(null);
        setTelemetryPrimary(embedded);
        setTelemetrySecondary(null);
        setTelemetryCurrent(null);
        setTelemetrySecondaryCurrent(null);
        setTelemetrySummaries(embedded ? [embedded] : []);
        setComparison(null);
        setTelemetryDiagnostics(null);
        setTelemetryFailureKind(null);
        setTelemetryError(null);
        setTelemetryLoading(false);
      }
    },
    [queryTimeSeries, activeTopics]
  );

  const handleLocateOnGlobe = useCallback(
    (node: ETGNode) => {
      handleSelectNode(node);
      handleSwitchView("globe");
      if (
        typeof node.properties.lat === "number" &&
        typeof node.properties.lng === "number"
      ) {
        requestRegionalFocus(node.properties.lat, node.properties.lng, 140);
      }
    },
    [handleSelectNode, handleSwitchView, requestRegionalFocus]
  );

  const handleOpenInGraphWorkbench = useCallback(
    (nodeUuid: string) => {
      const node = snapshot.nodes.find((n) => n.uuid === nodeUuid);
      if (!node) return;
      handleSelectNode(node);
      handleSwitchView("graph");
    },
    [snapshot.nodes, handleSelectNode, handleSwitchView]
  );

  const handleClearSelection = useCallback(() => {
    telemetryReqSeqRef.current += 1;
    telemetryAbortRef.current?.abort();
    telemetryAbortRef.current = null;
    setSelectedNodeUuid(null);
    setSelectedEdgeUuid(null);
    setActiveCascade(null);
    setActiveCaseStudyId(null);
    setCompareMode(false);
    setComparePinB(null);
    setRelationNodePair(null);
    setFocusedSummaryDataset(null);
    setConnectMode(false);
    setConnectSourceUuid(null);
    setPendingConnectPair(null);
    setQuickAddNodeOpen(false);
    setTelemetryCurrent(null);
    setTelemetrySecondaryCurrent(null);
    setTelemetryDiagnostics(null);
    setTelemetryFailureKind(null);
    setTelemetryError(null);
    setTelemetryLoading(false);
    setInspectorOpen(false);
  }, []);

  const handleToggleConnectMode = useCallback(() => {
    setConnectMode((prev) => {
      const next = !prev;
      if (!next) {
        setConnectSourceUuid(null);
      } else {
        setStatusMessage("Connect Mode active: click any Source node, then a Target node.");
      }
      return next;
    });
  }, []);

  const handleStartQuickConnect = useCallback(
    (sourceNode: ETGNode, targetNode?: ETGNode) => {
      if (targetNode && targetNode.uuid !== sourceNode.uuid) {
        setPendingConnectPair({ sourceUuid: sourceNode.uuid, targetUuid: targetNode.uuid });
        setSelectedEdgeUuid(null);
        setQuickAddNodeOpen(false);
        setConnectSourceUuid(null);
        setConnectMode(false);
        setInspectorOpen(true);
        setStatusMessage(`Composing link: ${sourceNode.properties.name} → ${targetNode.properties.name}`);
      } else {
        setConnectMode(true);
        setConnectSourceUuid(sourceNode.uuid);
        setStatusMessage(`Selected source "${sourceNode.properties.name}" — now click a target node.`);
      }
    },
    []
  );

  const handleDiscoverCandidateLinks = useCallback(
    async (anchorUuid?: string) => {
      setDiscoveringLinks(true);
      try {
        const params = new URLSearchParams({
          mode: "discover_links",
          minAbsR: "0.42",
          limit: "10",
        });
        const effectiveAnchor = anchorUuid ?? selectedNodeUuid ?? undefined;
        if (effectiveAnchor) {
          params.set("anchorUuid", effectiveAnchor);
        }
        const res = await fetch(`/api/graph/traverse?${params.toString()}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok && Array.isArray(data.suggestions)) {
          setCandidateLinks(data.suggestions as CandidateLinkSuggestion[]);
          setStatusMessage(
            data.suggestions.length > 0
              ? `Discovered ${data.suggestions.length} latent connection(s) — click any dashed violet edge to wire.`
              : "No new latent connections found above significance threshold."
          );
        }
      } finally {
        setDiscoveringLinks(false);
      }
    },
    [selectedNodeUuid]
  );

  const handleAcceptCandidateLink = useCallback(async (suggestion: CandidateLinkSuggestion) => {
    const res = await fetch("/api/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "connect",
        source_uuid: suggestion.sourceUuid,
        target_uuid: suggestion.targetUuid,
        type: suggestion.suggestedType,
        mechanism: suggestion.mechanism,
        rationale: suggestion.rationale,
        optimal_lag_steps: suggestion.optimalLagSteps ?? 0,
        lag_unit: suggestion.lagUnit ?? "days",
        authored_by: "ai",
      }),
    });
    const data = await res.json();
    if (res.ok && data.snapshot) {
      setSnapshot(data.snapshot as EtgGraphSnapshot);
      setCandidateLinks((prev) => prev.filter((c) => c.id !== suggestion.id));
      if (data.edge) {
        setSelectedEdgeUuid((data.edge as ETGEdge).properties.uuid);
        setSelectedNodeUuid(null);
        setInspectorOpen(true);
      }
      setStatusMessage(`Wired "${suggestion.sourceName}" → "${suggestion.targetName}".`);
    }
  }, []);

  const handleMaterializeSolarGraph = useCallback(async () => {
    setDiscoverBusy(true);
    setStatusMessage("Materializing 7-node Front Range Solar Predictive Graph from NASA POWER…");
    try {
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "materialize_solar_graph" }),
      });
      const data = await res.json();
      if (res.ok && data.snapshot) {
        const snap = data.snapshot as EtgGraphSnapshot;
        setSnapshot(snap);
        if (snap.nodes.length > 0) {
          const nextMax = Math.max(...snap.nodes.map(getNodeTimestampMs));
          setCutoffMs(nextMax);
        }
        setViewMode("graph");
        setQuickAddNodeOpen(false);
        setPendingConnectPair(null);
        if (typeof data.hubUuid === "string") {
          setSelectedNodeUuid(data.hubUuid);
          setSelectedEdgeUuid(null);
          setTraversalFilter({
            maxHops: 2,
            direction: "both",
            layoutMode: "causal_flow",
          });
          setInspectorOpen(true);
        }
        setStatusMessage(
          `Loaded 7-node Solar Microgrid predictive graph (${data.createdNodesCount ?? 7} nodes, ${data.createdEdgesCount ?? 6} upwind edges).`
        );
      } else {
        setStatusMessage(data.error || "Failed to load 7-node solar graph.");
      }
    } finally {
      setDiscoverBusy(false);
    }
  }, []);

  const handleSnapshotChange = useCallback(
    (nextSnapshot: EtgGraphSnapshot, toast?: string) => {
      setSnapshot(nextSnapshot);
      if (nextSnapshot.nodes.length > 0) {
        const nextMax = Math.max(...nextSnapshot.nodes.map(getNodeTimestampMs));
        setCutoffMs((prev) => Math.max(prev, nextMax));
      }
      if (toast) setStatusMessage(toast);
    },
    []
  );

  const handleSelectEdge = useCallback(
    (edge: ETGEdge) => {
      setSelectedEdgeUuid(edge.properties.uuid);
      setSelectedNodeUuid(null);
      setCompareMode(false);
      setActiveCaseStudyId(null);
      setFocusedSummaryDataset(null);
      setInspectorOpen(true);
      setRelationNodePair({
        sourceUuid: edge.source_uuid,
        targetUuid: edge.target_uuid,
      });

      const src = snapshot.nodes.find((n) => n.uuid === edge.source_uuid);
      const tgt = snapshot.nodes.find((n) => n.uuid === edge.target_uuid);
      setTelemetryDiagnostics(null);
      setTelemetryFailureKind(null);
      setTelemetryError(null);
      if (
        src?.properties.lat !== undefined &&
        src?.properties.lng !== undefined &&
        tgt?.properties.lat !== undefined &&
        tgt?.properties.lng !== undefined
      ) {
        const srcEmbedded = computeClientEmbeddedSummary(src);
        const tgtEmbedded = computeClientEmbeddedSummary(tgt);
        setTelemetryPrimary(srcEmbedded);
        setTelemetrySecondary(tgtEmbedded);
        setTelemetryCurrent(null);
        setTelemetrySecondaryCurrent(null);
        setTelemetrySummaries(srcEmbedded ? [srcEmbedded] : []);
        setProbedCoord({ lat: src.properties.lat, lng: src.properties.lng });
        setComparePinB({ lat: tgt.properties.lat, lng: tgt.properties.lng });
        void queryTimeSeries(
          src.properties.lat,
          src.properties.lng,
          src.properties.dataset || "nasa_power",
          {
            lat: tgt.properties.lat,
            lng: tgt.properties.lng,
            dataset: tgt.properties.dataset || "nasa_power",
            nodeUuid: tgt.uuid,
          },
          src.uuid
        );
      } else {
        telemetryReqSeqRef.current += 1;
        telemetryAbortRef.current?.abort();
        telemetryAbortRef.current = null;
        setComparePinB(null);
        setComparison(null);
        setTelemetryPrimary(null);
        setTelemetrySecondary(null);
        setTelemetryCurrent(null);
        setTelemetrySecondaryCurrent(null);
        setTelemetrySummaries([]);
        setTelemetryLoading(false);
      }
    },
    [snapshot.nodes, queryTimeSeries]
  );

  const handleProbeCoordinate = useCallback(
    (lat: number, lng: number) => {
      if (compareMode && (probedCoord || telemetryPrimary)) {
        const pinA = probedCoord ?? {
          lat: telemetryPrimary!.lat,
          lng: telemetryPrimary!.lng,
        };
        const dsA: ETGDatasetId =
          telemetryPrimary?.dataset || activeTopics[0] || "nasa_power";
        const dsB: ETGDatasetId = activeTopics[0] || dsA;
        setComparePinB({ lat, lng });
        setSelectedNodeUuid(null);
        setSelectedEdgeUuid(null);
        setActiveCaseStudyId(null);
        setRelationNodePair(null);
        setCompareMode(false);
        setFocusedSummaryDataset(null);
        setInspectorOpen(true);
        void queryTimeSeries(pinA.lat, pinA.lng, dsA, {
          lat,
          lng,
          dataset: dsB,
        });
        setStatusMessage(
          `Comparing two spots (${pinA.lat.toFixed(1)}°, ${pinA.lng.toFixed(1)}° ↔ ${lat.toFixed(1)}°, ${lng.toFixed(1)}°)`
        );
        return;
      }

      const prevAnchor =
        telemetryPrimaryRef.current ??
        telemetrySummariesRef.current[0] ??
        telemetryCurrentRef.current;
      const sameSpot = isSameSpotCoord(prevAnchor, lat, lng);

      setSelectedNodeUuid(null);
      setSelectedEdgeUuid(null);
      setActiveCaseStudyId(null);
      setProbedCoord({ lat, lng });
      setComparePinB(null);
      setComparison(null);
      setTelemetrySecondary(null);
      setTelemetrySecondaryCurrent(null);
      setRelationNodePair(null);
      setFocusedSummaryDataset(null);

      if (!sameSpot) {
        setTelemetryPrimary(null);
        setTelemetrySummaries([]);
        setTelemetryCurrent(null);
        setTelemetryDiagnostics(null);
        setTelemetryFailureKind(null);
        setTelemetryError(null);
      }

      const requested = activeTopics.length > 0 ? activeTopics : DEFAULT_MULTI_TOPICS;
      const gridded = requested.filter((ds) => GRIDDED_TOPIC_SET.has(ds));
      if (gridded.length > 0) {
        void queryTimeSeries(
          lat,
          lng,
          gridded[0],
          undefined,
          undefined,
          gridded
        );
      } else {
        telemetryReqSeqRef.current += 1;
        telemetryAbortRef.current?.abort();
        telemetryAbortRef.current = null;
        setTelemetryPrimary(null);
        setTelemetryCurrent(null);
        setTelemetrySummaries([]);
        setTelemetryDiagnostics(null);
        setTelemetryFailureKind(null);
        setTelemetryError(null);
        setTelemetryLoading(false);
      }
      setInspectorOpen(true);
      if (compareMode) {
        setStatusMessage(
          `First spot locked (${lat.toFixed(1)}°, ${lng.toFixed(1)}°). Click Earth again to compare.`
        );
      }
    },
    [compareMode, probedCoord, telemetryPrimary, queryTimeSeries, activeTopics]
  );

  const handleCompareOpposite = useCallback(
    (nodeA: ETGNode, nodeB: ETGNode) => {
      hidePopoverById("etg-dipoles-popover");
      const matchingEdge = snapshot.edges.find(
        (e) =>
          (e.source_uuid === nodeA.uuid && e.target_uuid === nodeB.uuid) ||
          (e.source_uuid === nodeB.uuid && e.target_uuid === nodeA.uuid)
      );
      setSelectedEdgeUuid(matchingEdge?.properties.uuid ?? null);
      setSelectedNodeUuid(nodeA.uuid);
      setActiveCaseStudyId(null);
      setRelationNodePair({ sourceUuid: nodeA.uuid, targetUuid: nodeB.uuid });
      setCompareMode(false);
      setFocusedSummaryDataset(null);
      setInspectorOpen(true);
      if (
        nodeA.properties.lat === undefined ||
        nodeA.properties.lng === undefined ||
        nodeB.properties.lat === undefined ||
        nodeB.properties.lng === undefined
      ) {
        setTelemetryError("One of the selected places does not have coordinates.");
        return;
      }
      const latA = nodeA.properties.lat;
      const lngA = nodeA.properties.lng;
      const latB = nodeB.properties.lat;
      const lngB = nodeB.properties.lng;
      const dsA: ETGDatasetId = nodeA.properties.dataset || "ocean_temp";
      const dsB: ETGDatasetId = nodeB.properties.dataset || "nasa_power";

      setProbedCoord({ lat: latA, lng: lngA });
      setComparePinB({ lat: latB, lng: lngB });
      void queryTimeSeries(
        latA,
        lngA,
        dsA,
        {
          lat: latB,
          lng: lngB,
          dataset: dsB,
          nodeUuid: nodeB.uuid,
        },
        nodeA.uuid
      );
    },
    [snapshot.edges, queryTimeSeries]
  );

  const handleSwapPins = useCallback(() => {
    if (!telemetryPrimary || !telemetrySecondary) return;
    const prevA = telemetryPrimary;
    const prevB = telemetrySecondary;
    const prevSrcUuid = relationNodePair?.sourceUuid;
    const prevTgtUuid = relationNodePair?.targetUuid;

    setProbedCoord({ lat: prevB.lat, lng: prevB.lng });
    setComparePinB({ lat: prevA.lat, lng: prevA.lng });
    setRelationNodePair(
      prevSrcUuid || prevTgtUuid
        ? { sourceUuid: prevTgtUuid, targetUuid: prevSrcUuid }
        : null
    );
    void queryTimeSeries(
      prevB.lat,
      prevB.lng,
      prevB.dataset,
      {
        lat: prevA.lat,
        lng: prevA.lng,
        dataset: prevA.dataset,
        nodeUuid: prevSrcUuid,
      },
      prevTgtUuid
    );
  }, [telemetryPrimary, telemetrySecondary, relationNodePair, queryTimeSeries]);

  const handleSelectCascade = useCallback(
    (chain: EarthCascadeChain | null) => {
      setActiveCascade(chain);
      if (chain) {
        hidePopoverById("etg-dipoles-popover");
        setInspectorOpen(true);
        setStatusMessage(`Highlighted ${chain.steps.length}-stage Earth chain: ${chain.title}`);
      }
    },
    []
  );

  const buildNodePayloadFromSummary = (summary: TrendAnalysisSummary) => {
    const dsMeta = DATASET_BY_ID[summary.dataset];
    const statisticallyAdjusted =
      summary.mannKendall.significant && summary.mannKendall.significantAdjusted;
    const verdictShort =
      summary.verdict === "Normal Environmental Variability"
        ? "Baseline"
        : summary.verdict.replace("Statistically Significant ", "");
    const name = `${dsMeta.shortLabel} ${verdictShort} (${summary.lat.toFixed(1)}°, ${summary.lng.toFixed(1)}°)`;
    return {
      label: "Signal",
      // Single-source interactive globe queries remain provisional until corroborated by a second independent observation.
      is_provisional: true,
      properties: {
        name,
        description: `${summary.parameter} time-series analyzed via Mann-Kendall (raw p=${summary.mannKendall.pValue.toFixed(4)}, Hamed-Rao adj p=${summary.mannKendall.pValueAdjusted.toFixed(4)}) and Theil-Sen slope (${summary.theilSen.slope >= 0 ? "+" : ""}${summary.theilSen.slope.toFixed(3)} ${summary.slopeUnit}). Provenance: ${summary.provenance}.`,
        status: "Provisional",
        importance: statisticallyAdjusted ? 0.82 : 0.62,
        lat: summary.lat,
        lng: summary.lng,
        region: `${summary.lat.toFixed(2)}°, ${summary.lng.toFixed(2)}°`,
        dataset: summary.dataset,
        producer_type: "nasa_satellite",
        confidence: statisticallyAdjusted ? 0.78 : 0.62,
        value: Number(summary.latestValue.toFixed(2)),
        unit: summary.unit,
        p_value: Number(summary.mannKendall.pValue.toFixed(5)),
        p_value_adjusted: Number(summary.mannKendall.pValueAdjusted.toFixed(5)),
        ols_r2: summary.ols.rSquared,
        regime_shift_year: summary.changePoint?.significant ? summary.changePoint.date : undefined,
        theil_sen_slope: Number(summary.theilSen.slope.toFixed(4)),
        slope_unit: summary.slopeUnit,
        series: summary.points.map((p) => ({ date: p.date, t: p.t, value: p.value })),
        observed_at: new Date().toISOString(),
      },
    };
  };

  const handleCommitTelemetryToGraph = useCallback(
    async (summary: TrendAnalysisSummary) => {
      const hasMannKendallRule = snapshot.nodes.some((n) => n.uuid === "rule-mann-kendall");
      const passesAdjustedTest =
        summary.mannKendall.significant && summary.mannKendall.significantAdjusted;
      const edge =
        hasMannKendallRule && passesAdjustedTest
          ? {
              source_uuid: "$NEW_NODE",
              target_uuid: "rule-mann-kendall",
              type: "verified_by",
              source_snippet: `Interactive globe probe passed Hamed-Rao Mann-Kendall (adj p=${summary.mannKendall.pValueAdjusted.toFixed(4)}).`,
            }
          : undefined;

      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node: buildNodePayloadFromSummary(summary),
          edge,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          node?: ETGNode;
          createdNode?: ETGNode;
          snapshot: EtgGraphSnapshot;
        };
        setSnapshot(data.snapshot);
        const created = data.node ?? data.createdNode;
        if (created) {
          setSelectedNodeUuid(created.uuid);
          setInspectorOpen(true);
        }
        setStatusMessage("Saved provisional spot observation to the Earth Trend Graph.");
      }
    },
    [snapshot.nodes]
  );

  const handleCommitRelation = useCallback(
    async (payload: {
      primary: TrendAnalysisSummary;
      secondary: TrendAnalysisSummary;
      comparison: CrossRegionComparison;
      sourceNodeUuid?: string;
      targetNodeUuid?: string;
    }) => {
      const { primary: pA, secondary: pB, comparison: cmp } = payload;
      const flipByLag = cmp.optimalLagSteps < 0;
      const rawSrcId = payload.sourceNodeUuid ?? "$NEW_NODE";
      const rawTgtId = payload.targetNodeUuid ?? "$NEW_SECONDARY_NODE";
      const edgeType: ETGRelationshipType =
        cmp.classification === "opposite_teleconnection"
          ? "drives_opposite"
          : cmp.classification === "co_trending"
            ? "correlates_with"
            : "relates_to";

      const ampRatio = flipByLag
        ? Math.abs(cmp.slopeRatio) > 1e-9
          ? 1 / cmp.slopeRatio
          : 0
        : cmp.slopeRatio;

      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node: payload.sourceNodeUuid ? undefined : buildNodePayloadFromSummary(pA),
          secondaryNode: payload.targetNodeUuid ? undefined : buildNodePayloadFromSummary(pB),
          edge: {
            source_uuid: flipByLag ? rawTgtId : rawSrcId,
            target_uuid: flipByLag ? rawSrcId : rawTgtId,
            type: edgeType,
            correlation_r: cmp.pearsonR,
            detrended_r: cmp.detrendedR,
            optimal_lag_steps: Math.abs(cmp.optimalLagSteps),
            lag_unit: cmp.lagUnit,
            mechanism: cmp.mechanism,
            amplification_ratio: ampRatio,
            shared_shift_year: cmp.sharedRegimeShiftYear ?? undefined,
            source_snippet: `${cmp.mechanism} · r=${cmp.pearsonR.toFixed(2)} (r*=${cmp.detrendedR.toFixed(2)})`,
            rationale: `2-Pin Earth telemetry coupling (${pA.lat.toFixed(1)}°, ${pA.lng.toFixed(1)}° ↔ ${pB.lat.toFixed(1)}°, ${pB.lng.toFixed(1)}°): ${cmp.mechanism}, Δt=${cmp.optimalLagSteps} ${cmp.lagUnit}, regime="${cmp.couplingRegime}".`,
          },
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          node?: ETGNode | null;
          secondaryNode?: ETGNode | null;
          edge?: ETGEdge | null;
          snapshot: EtgGraphSnapshot;
        };
        setSnapshot(data.snapshot);
        if (data.edge) {
          setSelectedEdgeUuid(data.edge.properties.uuid);
          setRelationNodePair({
            sourceUuid: data.edge.source_uuid,
            targetUuid: data.edge.target_uuid,
          });
        }
        setStatusMessage("Saved linked trend to the Knowledge Graph.");
      }
    },
    []
  );

  const handleDiscoverGlobalTrends = useCallback(async () => {
    setDiscoverBusy(true);
    setStatusMessage("Loading live NASA, NOAA & CSA Earth trend observations…");
    try {
      const res = await fetch("/api/earth/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxEonetSites: 7 }),
      });
      const data = await res.json();
      if (res.ok && data.snapshot) {
        setSnapshot(data.snapshot);
        if (data.snapshot.nodes.length > 0) {
          const nextMax = Math.max(...data.snapshot.nodes.map(getNodeTimestampMs));
          setCutoffMs(nextMax);
        }
        setStatusMessage(
          `Found ${data.summary?.corroboratedInsights ?? 0} verified trends & ${data.summary?.oppositeDipolesWired ?? 0} linked opposite trends across NASA, NOAA & CSA.`
        );
        hidePopoverById("etg-more-popover");
      } else {
        setStatusMessage(data.error || "Live trend discovery failed.");
      }
    } finally {
      setDiscoverBusy(false);
    }
  }, []);

  const handleRunCaseStudy = useCallback(
    (preset: GuidedDipoleCase) => {
      hidePopoverById("etg-dipoles-popover");
      setViewMode("globe");
      setActiveCaseStudyId(preset.id);
      setTelemetryPrimary(null);
      setTelemetrySecondary(null);
      setTelemetryCurrent(null);
      setTelemetrySecondaryCurrent(null);
      setTelemetrySummaries([]);
      setComparison(null);
      setTelemetryDiagnostics(null);
      setTelemetryFailureKind(null);
      setTelemetryError(null);
      setProbedCoord({ lat: preset.spotA.lat, lng: preset.spotA.lng });
      setComparePinB({ lat: preset.spotB.lat, lng: preset.spotB.lng });
      setSelectedNodeUuid(null);
      setSelectedEdgeUuid(null);
      setRelationNodePair(null);
      setCompareMode(false);
      setFocusedSummaryDataset(null);
      setInspectorOpen(true);
      const frame = computeDipoleFramingTarget(preset.spotA, preset.spotB);
      requestRegionalFocus(frame.lat, frame.lng, frame.radius);
      void queryTimeSeries(preset.spotA.lat, preset.spotA.lng, preset.spotA.dataset, {
        lat: preset.spotB.lat,
        lng: preset.spotB.lng,
        dataset: preset.spotB.dataset,
      });
      setStatusMessage(`Guided Case Study: ${preset.title}`);
    },
    [queryTimeSeries, requestRegionalFocus]
  );

  const guidedCaseItems = useMemo<GuidedCaseStudyItem[]>(
    () =>
      GUIDED_DIPOLE_CASES.map((c) => ({
        id: c.id,
        badge: c.shortLabel,
        title: c.title,
        subtitle: c.subtitle,
        dataset: c.spotA.dataset,
        spotAName: c.spotA.name,
        spotBName: c.spotB.name,
        spotACoord: { lat: c.spotA.lat, lng: c.spotA.lng },
        spotBCoord: { lat: c.spotB.lat, lng: c.spotB.lng },
      })),
    []
  );

  const handleSelectCaseStudyById = useCallback(
    (caseId: string) => {
      const preset = GUIDED_DIPOLE_CASES.find((c) => c.id === caseId);
      if (preset) {
        handleRunCaseStudy(preset);
      }
    },
    [handleRunCaseStudy]
  );

  const comparisonArcMeta = useMemo<ComparisonArcVisualMeta | null>(() => {
    if (viewMode !== "globe" || !probedCoord || !comparePinB) return null;
    const activeCase = activeCaseStudyId
      ? (GUIDED_DIPOLE_CASES.find((c) => c.id === activeCaseStudyId) ?? null)
      : null;

    const pairLabel =
      relationSourceNode && relationTargetNode
        ? `${humanizeNodeText(relationSourceNode.properties.name)} ↔ ${humanizeNodeText(relationTargetNode.properties.name)}`
        : activeCase
          ? `${activeCase.spotA.name} ↔ ${activeCase.spotB.name}`
          : `${probedCoord.lat.toFixed(1)}°, ${probedCoord.lng.toFixed(1)}° ↔ ${comparePinB.lat.toFixed(1)}°, ${comparePinB.lng.toFixed(1)}°`;

    const statText = comparison
      ? `r = ${comparison.pearsonR >= 0 ? "+" : ""}${comparison.pearsonR.toFixed(2)} · p = ${
          comparison.pValue < 0.001 ? "<0.001" : comparison.pValue.toFixed(3)
        }`
      : activeCase
        ? telemetryLoading
          ? "Querying live NASA / NOAA series…"
          : activeCase.title
        : telemetryLoading
          ? "Querying live NASA / NOAA series…"
          : null;

    const isSignificant = comparison
      ? comparison.pValue < 0.05 || comparison.detrendedPValue < 0.05
      : Boolean(activeCase);

    if (selectedEdge) {
      const category = classifyRelationCategory(selectedEdge.type);
      const badgeText = relationTargetNode
        ? formatRelationForDisplay(selectedEdge, relationSourceNode, relationTargetNode)
            .badgeText
        : RELATION_CATEGORY_META[category].shortLabel;
      return {
        category,
        badgeText,
        pairLabel,
        statText,
        isSignificant,
      };
    }

    if (comparison) {
      if (comparison.classification === "opposite_teleconnection") {
        return {
          category: "opposite",
          badgeText: "Drives Opposite",
          pairLabel,
          statText,
          isSignificant,
        };
      }
      if (comparison.classification === "co_trending") {
        return {
          category: "coupled",
          badgeText: "Co-Trending",
          pairLabel,
          statText,
          isSignificant,
        };
      }
      return {
        category: activeCase ? "opposite" : "corroboration",
        badgeText: activeCase ? activeCase.shortLabel : "Cross-Region Check",
        pairLabel,
        statText,
        isSignificant,
      };
    }

    if (activeCase) {
      return {
        category: "opposite",
        badgeText: activeCase.shortLabel,
        pairLabel,
        statText,
        isSignificant: true,
      };
    }

    return {
      category: "coupled",
      badgeText: "2-Pin Comparison",
      pairLabel,
      statText,
      isSignificant: false,
    };
  }, [
    viewMode,
    probedCoord,
    comparePinB,
    activeCaseStudyId,
    relationSourceNode,
    relationTargetNode,
    comparison,
    telemetryLoading,
    selectedEdge,
  ]);

  const demoBootedRef = useRef(false);
  useEffect(() => {
    if (demoBootedRef.current || !initialDemoMode) return;
    demoBootedRef.current = true;
    if (initialDemoMode === "veritas") {
      setSolarGraphOpen(true);
    } else if (initialDemoMode === "spaceapps") {
      if (snapshot.nodes.length === 0) {
        void handleDiscoverGlobalTrends();
      }
      handleRunCaseStudy(GUIDED_DIPOLE_CASES[0]);
    }
  }, [
    initialDemoMode,
    snapshot.nodes.length,
    handleDiscoverGlobalTrends,
    handleRunCaseStudy,
  ]);

  const handleSyncEonet = useCallback(async () => {
    setEonetBusy(true);
    try {
      const res = await fetch("/api/earth/eonet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      });
      const data = await res.json();
      if (res.ok && data.snapshot) {
        setSnapshot(data.snapshot);
        setStatusMessage(
          `Synced ${data.ingestedCount} Earth event(s) from ${data.source}.`
        );
        hidePopoverById("etg-more-popover");
      } else {
        setStatusMessage(data.error || "NASA EONET sync failed.");
      }
    } finally {
      setEonetBusy(false);
    }
  }, []);

  const handleClearGraph = useCallback(async () => {
    const res = await fetch("/api/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    });
    if (res.ok) {
      const emptySnapshot = (await res.json()) as EtgGraphSnapshot;
      setSnapshot(emptySnapshot);
      setSelectedNodeUuid(null);
      setSelectedEdgeUuid(null);
      setInspectorOpen(false);
      setCandidateLinks([]);
      setTraversalSubgraph(null);
      setTraversalHistory([]);
      setPendingConnectPair(null);
      setQuickAddNodeOpen(false);
      setConnectMode(false);
      setConnectSourceUuid(null);
      setTelemetryPrimary(null);
      setTelemetrySecondary(null);
      setComparison(null);
      setStatusMessage("Cleared Earth Trend Graph (0 nodes, 0 hardcoded records).");
      hidePopoverById("etg-more-popover");
    }
  }, []);

  const handleExportWorkspaceBundle = useCallback(async () => {
    try {
      const res = await fetch("/api/graph?format=bundle", { cache: "no-store" });
      if (!res.ok) {
        setStatusMessage("Failed to export ETG workspace bundle.");
        return;
      }
      const bundle = await res.json();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etg-workspace-bundle-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      hidePopoverById("etg-more-popover");
      setStatusMessage("Exported ETG workspace bundle (.json).");
    } catch {
      setStatusMessage("Failed to export ETG workspace bundle.");
    }
  }, []);

  const handleImportWorkspaceBundle = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const bundle = JSON.parse(text);
        const res = await fetch("/api/graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import_bundle", bundle, merge: true }),
        });
        const data = await res.json();
        if (!res.ok) {
          setStatusMessage(data.error || "Failed to import ETG workspace bundle.");
          return;
        }
        if (data.snapshot) {
          setSnapshot(data.snapshot as EtgGraphSnapshot);
        }
        hidePopoverById("etg-more-popover");
        setStatusMessage(
          `Imported workspace bundle (${data.importedNodes ?? 0} nodes, ${data.importedEdges ?? 0} edges).`
        );
      } catch {
        setStatusMessage("Invalid ETG workspace bundle JSON file.");
      }
    },
    []
  );

  const stageTitle =
    viewMode === "graph"
      ? `Earth Trend Knowledge Graph (${graphRenderMode.toUpperCase()})`
      : "Interactive 3D Earth Globe";

  const activeFilterCount =
    (activeTopics.length > 0 ? 1 : 0) +
    (onlyOpposite ? 1 : 0) +
    (!showSuperseded ? 1 : 0) +
    (ALL_RELATION_CATEGORIES.length - enabledRelationCategories.length);

  const topicButtonLabel =
    activeTopics.length === 0
      ? "Datasets: All"
      : activeTopics.length === 1
        ? `Datasets: ${DATASET_BY_ID[activeTopics[0]].shortLabel}`
        : `Datasets (${activeTopics.length})`;

  const formattedAllRelations = useMemo(() => {
    const nodeById = new Map(snapshot.nodes.map((n) => [n.uuid, n]));
    const allowedSet = new Set(enabledRelationCategories);
    const items: Array<{
      edge: ETGEdge;
      src: ETGNode;
      tgt: ETGNode;
      formatted: ReturnType<typeof formatRelationForDisplay>;
      isGeoPair: boolean;
    }> = [];

    for (const edge of snapshot.edges) {
      const cat = classifyRelationCategory(edge.type);
      if (!allowedSet.has(cat)) continue;
      const src = nodeById.get(edge.source_uuid);
      const tgt = nodeById.get(edge.target_uuid);
      if (!src || !tgt) continue;
      const isGeoPair =
        src.properties.lat !== undefined &&
        src.properties.lng !== undefined &&
        tgt.properties.lat !== undefined &&
        tgt.properties.lng !== undefined;
      items.push({
        edge,
        src,
        tgt,
        formatted: formatRelationForDisplay(edge, src, tgt),
        isGeoPair,
      });
    }

    const catPrio: Record<RelationCategory, number> = {
      opposite: 4,
      causal: 3,
      coupled: 2,
      corroboration: 1,
    };

    return items.sort((a, b) => {
      if (a.isGeoPair !== b.isGeoPair) return a.isGeoPair ? -1 : 1;
      const cDiff = catPrio[b.formatted.category] - catPrio[a.formatted.category];
      if (cDiff !== 0) return cDiff;
      return (
        Math.abs(b.edge.properties.correlation_r ?? 0) -
        Math.abs(a.edge.properties.correlation_r ?? 0)
      );
    });
  }, [snapshot.nodes, snapshot.edges, enabledRelationCategories]);

  return (
    <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-bg text-text-primary">
      {/* Top Structural Navigation Bar — strict single row (48px) */}
      <header className="z-30 flex h-12 shrink-0 flex-nowrap items-center justify-between gap-1.5 border-b border-border bg-header px-2.5 sm:gap-2 sm:px-4">
        {/* Left Group: Brand + Dataset Filter + Relations */}
        <div className="flex min-w-0 shrink items-center gap-1 sm:gap-1.5">
          <div className="flex items-center gap-2 pr-0.5 sm:pr-1" title="Earth Trend Detective">
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent-fg" aria-hidden="true" />
            <h1 className="whitespace-nowrap font-outfit text-sm font-semibold tracking-tight text-text-primary">
              <span className="sr-only sm:not-sr-only">Earth Trend Detective</span>
            </h1>
          </div>

          <div role="separator" aria-orientation="vertical" className="mx-1 hidden h-4 border-l border-border sm:block" />

          <button
            type="button"
            popoverTarget="etg-filter-popover"
            title={topicButtonLabel}
            aria-label={topicButtonLabel}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-1 text-xs font-medium transition-colors cursor-pointer sm:px-2.5 ${
              activeFilterCount > 0
                ? "border-accent-fg bg-amber-950 text-amber-300"
                : "border-border bg-surface-elevated text-text-muted hover:border-border-strong hover:text-text-primary"
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline">{topicButtonLabel}</span>
            {activeFilterCount > 0 && (
              <span className="ws-numeric rounded-xs bg-accent px-1.5 text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>

          <button
            type="button"
            popoverTarget="etg-dipoles-popover"
            title="View opposite trends, causal chains, teleconnections, and corroboration relations"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-border bg-rose-950 px-2 py-1 text-xs font-medium text-rose-300 transition-colors hover:border-rose-400 cursor-pointer sm:gap-1.5 sm:px-2.5"
          >
            <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Relations</span>
            <span className="ws-numeric font-mono text-[11px] font-semibold">
              {formattedAllRelations.length}
            </span>
          </button>
        </div>

        {/* Center Segmented Switcher: 3D Earth vs Knowledge Graph (3D/2D) */}
        <nav
          aria-label="Workspace View Switcher"
          className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface-inset p-0.5 sm:gap-1"
        >
          <button
            type="button"
            onClick={() => handleSwitchView("globe")}
            aria-pressed={viewMode === "globe"}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium transition-colors cursor-pointer sm:gap-1.5 sm:px-3 ${
              viewMode === "globe"
                ? "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] font-semibold"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sm:hidden">Earth</span>
            <span className="hidden sm:inline">3D Earth</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchView("graph")}
            aria-pressed={viewMode === "graph"}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium transition-colors cursor-pointer sm:gap-1.5 sm:px-3 ${
              viewMode === "graph"
                ? "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] font-semibold"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            <Network className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sm:hidden">Graph</span>
            <span className="hidden sm:inline">Knowledge Graph</span>
          </button>

          {viewMode === "graph" && (
            <>
              <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 border-l border-border" />
              {(["3d", "2d"] as const).map((mode) => {
                const active = graphRenderMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setGraphRenderMode(mode)}
                    aria-pressed={active}
                    className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase transition-colors cursor-pointer sm:px-2 ${
                      active
                        ? "border border-border-strong bg-surface-elevated text-text-primary"
                        : "text-text-subtle hover:text-text-primary"
                    }`}
                  >
                    {mode}
                  </button>
                );
              })}
            </>
          )}
        </nav>

        {/* Right Group: Search + Solar Graph + Ask AI + Add Data + Tools + Theme */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          <search className="relative hidden items-center xl:flex">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-text-subtle" aria-hidden="true" />
            <label htmlFor="etg-search" className="sr-only">
              Search places or trends
            </label>
            <input
              id="etg-search"
              name="q"
              type="search"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search pins or trends…"
              className="h-7 w-36 rounded-sm border border-border bg-surface-inset pr-2.5 pl-7 text-xs text-text-primary placeholder:text-text-subtle transition-all focus:w-48 focus:border-accent-fg focus:outline-none"
            />
          </search>

          <button
            type="button"
            onClick={() => setSolarGraphOpen(true)}
            title="Denver Solar Microgrid — 7-Node Local Climate Graph & 3-Way Forecast"
            aria-label="Denver Solar Graph"
            className="hidden items-center gap-1.5 whitespace-nowrap rounded-sm border border-amber-400 bg-amber-950 px-2 py-1 text-xs font-medium text-amber-300 transition-colors hover:border-accent-fg cursor-pointer md:inline-flex xl:px-2.5"
          >
            <Sun className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden xl:inline">Solar Graph</span>
          </button>

          <button
            type="button"
            onClick={() => setAiStudioOpen((v) => !v)}
            aria-expanded={aiStudioOpen}
            title="Toggle AI Graph Chat Studio"
            aria-label="Toggle AI Graph Chat Studio"
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-1 text-xs font-medium transition-colors cursor-pointer xl:px-2.5 ${
              aiStudioOpen
                ? "border-accent-fg bg-accent/15 text-accent-fg"
                : "border-border bg-surface-elevated text-accent-fg hover:border-accent-fg"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden xl:inline">AI Studio</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setIngestTab("dataset");
              setIngestOpen(true);
            }}
            title="Add Data"
            aria-label="Add Data"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-accent px-2 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent-hover cursor-pointer sm:px-2.5"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Add Data</span>
          </button>

          <button
            type="button"
            popoverTarget="etg-more-popover"
            title="Live global discovery, NASA EONET sync & export tools"
            aria-label="Observatory tools"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-border bg-surface-elevated px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
          >
            <MoreVertical className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden xl:inline">Tools</span>
          </button>

          <ThemeToggle />
        </div>
      </header>

      {/* ─── Native Viewport-Aware Popovers ─── */}

      {/* 1. Topic Filters & View Options Popover */}
      <div id="etg-filter-popover" popover="auto" className="etg-popover space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
            Choose What You See
          </h3>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => {
                resetTopics();
                setOnlyOpposite(false);
                setShowSuperseded(true);
                setEnabledRelationCategories([...ALL_RELATION_CATEGORIES]);
              }}
              className="text-xs font-medium text-accent-fg hover:underline cursor-pointer"
            >
              Reset filters
            </button>
          )}
        </div>

        {/* Multi-Select Topic Filters */}
        <div>
          <DatasetSelector
            activeTopics={activeTopics}
            onToggleTopic={toggleTopic}
            onResetTopics={resetTopics}
            nodes={snapshot.nodes}
          />
        </div>

        {/* Tablet/Mobile Search Input (shown whenever header search is collapsed < xl) */}
        <div className="xl:hidden">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search places or trends…"
            className="form-input"
          />
        </div>

        {/* Relation Categories Checkboxes */}
        <div className="space-y-1 border-t border-border pt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Relation Categories
          </div>
          {ALL_RELATION_CATEGORIES.map((cat) => {
            const dotColor =
              cat === "opposite"
                ? "#fb7185"
                : cat === "causal"
                  ? "#34d399"
                  : cat === "coupled"
                    ? "#38bdf8"
                    : "#a78bfa";
            return (
              <label key={cat} className="etg-check-label text-xs text-text-primary">
                <input
                  type="checkbox"
                  checked={enabledRelationCategories.includes(cat)}
                  onChange={() => toggleRelationCategoryFilter(cat)}
                  className="checkbox-native"
                />
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                  aria-hidden="true"
                />
                <span>{RELATION_CATEGORY_META[cat].label}</span>
              </label>
            );
          })}
        </div>

        {/* Graph Toggles + Temperature Unit */}
        <div className="space-y-2 border-y border-border py-3">
          <label className="etg-check-label text-xs text-text-primary">
            <input
              type="checkbox"
              checked={onlyOpposite}
              onChange={(e) => setOnlyOpposite(e.target.checked)}
              className="checkbox-native"
            />
            <span>Only opposite trends</span>
          </label>
          <label className="etg-check-label text-xs text-text-primary">
            <input
              type="checkbox"
              checked={showSuperseded}
              onChange={(e) => setShowSuperseded(e.target.checked)}
              className="checkbox-native"
            />
            <span>Show updated findings</span>
          </label>
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-medium text-text-muted">Temperature unit</span>
            <div className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5">
              {(["C", "F"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={tempUnit === u}
                  onClick={() => setTempUnit(u)}
                  className="rounded-xs px-2 py-0.5 text-[11px] font-semibold text-text-muted aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                >
                  °{u}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Graph Node Key */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-text-subtle">Map &amp; Graph Key</div>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-surface-inset p-2.5">
            {(["Concept", "Signal", "Insight", "Rule"] as ETGNodeLabel[]).map((label) => {
              const palette = ETG_LABEL_PALETTE[label];
              return (
                <div key={label} className="flex items-center gap-2 text-xs text-text-primary">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: palette.color }}
                  />
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 2. Earth Trend Relations & Causal Chains Popover */}
      <div id="etg-dipoles-popover" popover="auto" className="etg-popover space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-primary">
            Earth Relations &amp; Chains
          </h3>
          <span className="ws-numeric font-mono text-[11px] text-text-subtle">
            {formattedAllRelations.length} links · {cascades.length} chains
          </span>
        </div>

        {/* Guided Opposite-Trend Case Studies */}
        <div className="space-y-1.5 rounded-sm border border-border bg-surface-inset p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
            Guided Opposite-Trend Case Studies (Live NASA/NOAA)
          </div>
          <div className="grid gap-1">
            {GUIDED_DIPOLE_CASES.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleRunCaseStudy(preset)}
                className="flex flex-col items-start rounded-sm border border-border bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-rose-400 cursor-pointer"
              >
                <span className="text-[11px] font-semibold text-text-primary">
                  {preset.title}
                </span>
                <span className="text-[10px] text-text-muted leading-snug">
                  {preset.spotA.name} vs. {preset.spotB.name} — {preset.subtitle}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              { id: "all", label: `All (${formattedAllRelations.length})` },
              {
                id: "opposite",
                label: `Opposite (${formattedAllRelations.filter((i) => i.formatted.category === "opposite").length})`,
              },
              {
                id: "causal",
                label: `Causal → (${formattedAllRelations.filter((i) => i.formatted.category === "causal").length})`,
              },
              {
                id: "coupled",
                label: `Coupled (${formattedAllRelations.filter((i) => i.formatted.category === "coupled").length})`,
              },
              { id: "chains", label: `Chains (${cascades.length})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={relationPopoverFilter === tab.id}
              onClick={() => setRelationPopoverFilter(tab.id)}
              className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-200 cursor-pointer"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {relationPopoverFilter !== "chains" && (
          <div className="space-y-2">
            {formattedAllRelations
              .filter(
                (item) =>
                  relationPopoverFilter === "all" ||
                  item.formatted.category === relationPopoverFilter
              )
              .slice(0, 14)
              .map(({ edge, src, tgt, formatted }) => {
                const srcLabel = humanizeNodeText(src.properties.region || src.properties.name);
                const tgtLabel = humanizeNodeText(tgt.properties.region || tgt.properties.name);
                const badgeClass =
                  formatted.category === "opposite"
                    ? "border-rose-400 bg-rose-950 text-rose-300"
                    : formatted.category === "causal"
                      ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                      : formatted.category === "coupled"
                        ? "border-sky-400 bg-sky-950 text-sky-300"
                        : "border-violet-400 bg-violet-950 text-violet-300";
                const sep = formatted.direction === "undirected" ? "↔" : "→";
                return (
                  <button
                    key={edge.properties.uuid}
                    type="button"
                    onClick={() => {
                      handleSelectEdge(edge);
                      hidePopoverById("etg-dipoles-popover");
                    }}
                    className="w-full space-y-1 rounded-md border border-border bg-surface-inset p-2.5 text-left transition-colors hover:border-accent-fg cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-text-primary">
                      <span className="truncate">
                        {srcLabel} {sep} {tgtLabel}
                      </span>
                      <span
                        className={`shrink-0 rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${badgeClass}`}
                      >
                        {formatted.badgeText}
                      </span>
                    </div>
                    <div className="ws-numeric flex flex-wrap items-center gap-x-2 text-[10px] text-text-subtle">
                      {formatted.correlationText && (
                        <span className="font-mono text-text-muted">
                          {formatted.correlationText}
                        </span>
                      )}
                      {formatted.lagText && (
                        <span className="font-mono text-text-muted">{formatted.lagText}</span>
                      )}
                      {formatted.distanceKm !== null && (
                        <span className="font-mono">{formatted.distanceKm} km</span>
                      )}
                    </div>
                    <div className="line-clamp-2 text-[11px] text-text-muted">
                      {formatted.summaryLine}
                    </div>
                  </button>
                );
              })}
            {formattedAllRelations.filter(
              (item) =>
                relationPopoverFilter === "all" ||
                item.formatted.category === relationPopoverFilter
            ).length === 0 && (
              <div className="rounded-sm border border-border-subtle bg-surface-inset p-3 text-xs text-text-subtle">
                No relations match this category yet.
              </div>
            )}
          </div>
        )}

        {(relationPopoverFilter === "all" || relationPopoverFilter === "chains") &&
          cascades.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                  Connected Earth Chains
                </h3>
                <span className="ws-numeric font-mono text-[11px] text-text-subtle">
                  {cascades.length} chains
                </span>
              </div>

              <div className="space-y-1.5">
                {cascades.slice(0, 5).map((chain) => (
                  <button
                    key={chain.id}
                    type="button"
                    onClick={() => handleSelectCascade(chain)}
                    className="w-full space-y-1 rounded-md border border-border bg-amber-950 p-2.5 text-left transition-colors hover:border-amber-400 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-text-primary">
                      <span className="truncate">{chain.title}</span>
                      <span className="ws-numeric shrink-0 font-mono text-amber-300">
                        {chain.spheres.length} steps
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-text-muted">{chain.summary}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
      </div>

      {/* 4. More Observatory Tools Popover */}
      <div id="etg-more-popover" popover="auto" className="etg-popover etg-popover-end space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Observatory Tools
        </h3>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              hidePopoverById("etg-more-popover");
              setSolarGraphOpen(true);
            }}
            className="flex w-full items-center justify-between rounded-sm border border-amber-400 bg-amber-950 px-3 py-2 text-xs font-semibold text-amber-300 hover:border-amber-300 cursor-pointer md:hidden"
          >
            <span>Denver Solar Microgrid Graph</span>
            <Sun className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => void handleDiscoverGlobalTrends()}
            disabled={discoverBusy}
            className="flex w-full items-center justify-between rounded-sm border border-teal-400 bg-teal-950 px-3 py-2 text-xs font-semibold text-teal-300 hover:border-teal-300 disabled:opacity-50 cursor-pointer"
          >
            <span>{discoverBusy ? "Discovering Trends…" : "Re-run Live Global Discovery"}</span>
            <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={() => void handleSyncEonet()}
            disabled={eonetBusy}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-border-strong disabled:opacity-50 cursor-pointer"
          >
            <span>{eonetBusy ? "Syncing NASA EONET…" : "Sync NASA EONET Live Events"}</span>
            <RefreshCw className={`h-3.5 w-3.5 ${eonetBusy ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={() => {
              hidePopoverById("etg-more-popover");
              setIngestTab("agencies");
              setIngestOpen(true);
            }}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            <span>Challenge Space-Agency Hub (12)</span>
            <Globe2 className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => void handleExportWorkspaceBundle()}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            <span>Export Workspace Bundle (.json)</span>
            <Download className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
          </button>

          <div className="relative">
            <input
              id={`${bundleInputId}-import`}
              name="etg_workspace_bundle"
              type="file"
              accept=".json,application/json"
              onChange={(e) => void handleImportWorkspaceBundle(e)}
              className="visually-hidden"
            />
            <label
              htmlFor={`${bundleInputId}-import`}
              className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
            >
              <span>Import / Merge Bundle (.json)</span>
              <Upload className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            </label>
          </div>

          <button
            type="button"
            onClick={() => void handleClearGraph()}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-rose-950 px-3 py-2 text-xs font-medium text-rose-300 hover:border-rose-400 cursor-pointer"
          >
            <span>Clear Graph (0 Nodes)</span>
            <RotateCcw className="h-3.5 w-3.5 text-rose-300" />
          </button>
        </div>

        <div className="border-t border-border pt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Recent Provenance Activity
          </div>
          <div className="max-h-40 space-y-1.5 overflow-y-auto text-xs text-text-muted">
            {snapshot.activity.slice(0, 6).map((act) => (
              <div key={act.id} className="truncate font-mono text-[11px]">
                <span className="text-text-faint">{act.kind}:</span> {act.summary}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Full-Bleed Center Canvas + Docked AI Graph Studio */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <AiGraphChatPanel
          open={aiStudioOpen}
          onClose={() => setAiStudioOpen(false)}
          snapshot={snapshot}
          selectedNode={selectedNode}
          probedCoord={probedCoord}
          activeTopics={activeTopics}
          onSelectNode={handleSelectNode}
          onSnapshotChange={handleSnapshotChange}
          onBlockedNotice={(msg) => setStatusMessage(msg)}
        />

        <main
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ viewTransitionName: "etg-stage" }}
        >
        <h2 ref={viewHeadingRef} tabIndex={-1} className="sr-only">
          {stageTitle}
        </h2>

        {/* Transient Feedback Toast & Compare Banner (non-overlapping across 1280x800 and 390x844) */}
        {(statusMessage || (compareMode && viewMode === "globe")) && (
          <div
            className={`pointer-events-none absolute z-30 flex justify-center max-sm:inset-x-2.5 max-sm:top-16 ${
              viewMode === "globe"
                ? aiStudioOpen
                  ? "sm:bottom-20 sm:left-4 sm:right-auto sm:top-auto sm:justify-start"
                  : inspectorOpen
                    ? "sm:top-16 sm:inset-x-4 min-[1160px]:top-3 min-[1160px]:left-[428px] min-[1160px]:right-[418px]"
                    : "sm:top-3 sm:left-[428px] sm:right-4"
                : inspectorOpen
                  ? "sm:top-3 sm:left-4 sm:right-[426px]"
                  : "sm:top-3 sm:inset-x-4"
            }`}
          >
            {statusMessage ? (
              <div
                role="status"
                className="etg-hud-pill pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-2 rounded-md bg-surface px-3.5 py-1.5 text-xs font-medium text-text-primary shadow-lg"
              >
                <span className="truncate">{statusMessage}</span>
                <button
                  type="button"
                  onClick={() => setStatusMessage(null)}
                  aria-label="Dismiss notification"
                  className="shrink-0 text-text-subtle hover:text-text-primary cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div
                role="status"
                className="etg-hud-pill pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-2 rounded-md border border-amber-400 bg-surface px-3.5 py-1.5 text-xs font-medium text-text-primary shadow-lg"
              >
                <GitCompare className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                <span className="truncate">
                  Compare mode active — click a second point or pin on the 3D Earth
                </span>
                <button
                  type="button"
                  onClick={() => setCompareMode(false)}
                  className="shrink-0 rounded-xs border border-border bg-surface-elevated px-1.5 py-0.5 text-[11px] font-semibold text-text-muted hover:text-text-primary cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {viewMode === "graph" ? (
          <EarthTrendGraphView
            nodes={graphNodes}
            edges={graphEdges}
            selectedNodeUuid={selectedNodeUuid}
            selectedEdgeUuid={selectedEdgeUuid}
            cascadeEdgeUuids={activeCascade?.edgeUuids ?? EMPTY_CASCADE_EDGE_UUIDS}
            searchQuery={searchQuery}
            renderMode={graphRenderMode}
            onlyOpposite={onlyOpposite}
            showSuperseded={showSuperseded}
            enabledRelationCategories={enabledRelationCategories}
            inspectorOpen={inspectorOpen}
            candidateLinks={candidateLinks}
            traversalFilter={traversalFilter}
            roleByNode={activeTraversal?.roleByNode ?? EMPTY_ROLE_BY_NODE}
            hopByNode={activeTraversal?.hopByNode ?? EMPTY_HOP_BY_NODE}
            microscopeByNode={microscopeByNode}
            connectMode={connectMode}
            connectSourceUuid={connectSourceUuid}
            discoveringLinks={discoveringLinks}
            regionOptions={regionOptions}
            selectedRegionScope={selectedRegionScope}
            onSelectNode={handleSelectNode}
            onSelectEdge={(edge) => {
              setPendingConnectPair(null);
              setQuickAddNodeOpen(false);
              handleSelectEdge(edge);
            }}
            onClearSelection={handleClearSelection}
            onToggleConnectMode={handleToggleConnectMode}
            onStartQuickConnect={handleStartQuickConnect}
            onOpenQuickAddNode={() => {
              setQuickAddNodeOpen(true);
              setPendingConnectPair(null);
              setSelectedEdgeUuid(null);
              setInspectorOpen(true);
            }}
            onDiscoverLinks={() => void handleDiscoverCandidateLinks()}
            onAcceptCandidateLink={(s) => void handleAcceptCandidateLink(s)}
            onClearCandidateLinks={() => setCandidateLinks([])}
            onChangeTraversalFilter={(next) => setTraversalFilter(next)}
            onChangeRegionScope={(nextRegion) => setSelectedRegionScope(nextRegion)}
            onResetOppositeFilter={() => setOnlyOpposite(false)}
          />
        ) : (
          <EarthGlobe3D
            nodes={globeNodes}
            edges={globeEdges}
            selectedNodeUuid={selectedNodeUuid}
            probedAnchorUuid={probedAnchorUuid}
            selectedEdgeUuid={selectedEdgeUuid}
            cascadeEdgeUuids={activeCascade?.edgeUuids ?? []}
            microscopeScan={microscopeScan}
            microscopeByNode={microscopeByNode}
            probedCoord={probedCoord}
            comparePinB={comparePinB}
            comparisonArcMeta={comparisonArcMeta}
            compareMode={compareMode}
            inspectorOpen={inspectorOpen}
            mobileSheetExpanded={inspectorOpen && !mobileSheetCollapsed}
            enabledCategories={enabledRelationCategories}
            onChangeEnabledCategories={setEnabledRelationCategories}
            tempUnit={tempUnit}
            onChangeTempUnit={setTempUnit}
            activeTopics={activeTopics}
            cutoffMs={cutoffMs}
            regionalFocusRequest={regionalFocusRequest}
            initialSatelliteMode={
              initialDemoMode === "spaceapps" ? "sst_anomaly" : undefined
            }
            initialSunPreset={
              initialDemoMode === "spaceapps" ? "daylight" : undefined
            }
            timelineSlot={
              <TimelineScrubber
                nodes={snapshot.nodes}
                cutoffMs={cutoffMs}
                minMs={minMs}
                maxMs={maxMs}
                onChangeCutoff={(ms) => setCutoffMs(ms)}
                visibleCount={globeNodes.length}
              />
            }
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            onProbeCoordinate={handleProbeCoordinate}
            onToggleCompareMode={() => {
              setCompareMode((v) => !v);
              setInspectorOpen(true);
            }}
          />
        )}

        {snapshot.nodes.length === 0 && viewMode === "globe" && !inspectorOpen && (
          <div className="pointer-events-none absolute top-3 inset-x-0 z-20 flex justify-center px-4">
            <div className="etg-hud-pill pointer-events-auto flex max-w-4xl flex-wrap items-center justify-center gap-2 rounded-md bg-surface px-4 py-1.5 text-xs shadow-lg">
              <span className="text-text-muted">Click Earth to probe, or try:</span>
              <button
                type="button"
                onClick={() => void handleDiscoverGlobalTrends()}
                disabled={discoverBusy}
                className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1 font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`h-3 w-3 ${discoverBusy ? "animate-spin" : ""}`} aria-hidden="true" />
                <span>{discoverBusy ? "Loading Live Data…" : "Load Live Global Pins"}</span>
              </button>
              {GUIDED_DIPOLE_CASES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.subtitle}
                  onClick={() => handleRunCaseStudy(preset)}
                  className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-rose-400 cursor-pointer"
                >
                  {preset.shortLabel}
                </button>
              ))}
            </div>
          </div>
        )}

        {snapshot.nodes.length === 0 && viewMode === "graph" && !quickAddNodeOpen && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
            <div className="etg-hud-pill pointer-events-auto max-w-lg space-y-4 rounded-md bg-surface p-6 text-center shadow-2xl">
              <div className="mx-auto inline-flex items-center gap-2 rounded-sm border border-teal-400 bg-teal-950 px-3 py-1 font-mono text-[11px] font-semibold text-teal-300">
                Zero Seeded Data · Live Scientific Observatory
              </div>
              <h3 className="font-outfit text-lg font-semibold text-text-primary">
                Build &amp; Connect the Earth Trend Knowledge Graph
              </h3>
              <p className="text-xs leading-relaxed text-text-muted">
                Ingest live NASA/NOAA/CSA streams, load the 7-node Front Range solar microgrid graph
                to benchmark graph-aware prediction, or create your own phenomenon nodes and link
                causes across the world.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleDiscoverGlobalTrends()}
                  disabled={discoverBusy}
                  className="inline-flex items-center gap-2 rounded-sm bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
                  {discoverBusy ? "Loading Live Data…" : "Load Live NASA / NOAA / CSA Trends"}
                </button>
                <button
                  type="button"
                  disabled={discoverBusy}
                  onClick={() => void handleMaterializeSolarGraph()}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-amber-400 bg-amber-950 px-4 py-2 text-xs font-semibold text-amber-300 hover:border-accent-fg disabled:opacity-50 cursor-pointer"
                >
                  <Sun className="h-3.5 w-3.5" />
                  Load 7-Node Solar Predictive Graph
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQuickAddNodeOpen(true);
                    setInspectorOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-4 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create Phenomenon Node
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIngestTab("agencies");
                    setIngestOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-4 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                >
                  Space Agency Hub (12)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Compact Auto-Height Floating Spot Card or Flexible Graph Workbench */}
        {inspectorOpen &&
          (viewMode === "graph" &&
          (selectedNode || selectedEdge || pendingConnectPair || quickAddNodeOpen) ? (
            <aside
              aria-label="Graph workbench"
              className="pointer-events-auto absolute z-30 max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:max-h-[54dvh] max-sm:overflow-y-auto sm:top-3 sm:right-4 sm:w-[min(410px,calc(100dvw-2rem))]"
            >
              <GraphNodeWorkbenchPanel
                allNodes={snapshot.nodes}
                allEdges={snapshot.edges}
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                pendingConnectPair={pendingConnectPair}
                quickAddOpen={quickAddNodeOpen}
                candidateLinks={candidateLinks}
                microscopeScan={microscopeScan}
                microscopeByNode={microscopeByNode}
                traversalHistory={traversalHistory}
                maxHops={traversalFilter.maxHops ?? 2}
                onSelectNode={handleSelectNode}
                onSelectEdge={(edge) => {
                  setPendingConnectPair(null);
                  setQuickAddNodeOpen(false);
                  handleSelectEdge(edge);
                }}
                onClearPendingConnect={() => setPendingConnectPair(null)}
                onCloseQuickAdd={() => setQuickAddNodeOpen(false)}
                onStartQuickConnect={handleStartQuickConnect}
                onDiscoverLinksForNode={(anchor) => handleDiscoverCandidateLinks(anchor)}
                onAcceptCandidateLink={handleAcceptCandidateLink}
                onMaterializeSolarGraph={handleMaterializeSolarGraph}
                onLocateOnGlobe={handleLocateOnGlobe}
                onSnapshotChange={handleSnapshotChange}
                onClose={handleClearSelection}
              />
            </aside>
          ) : viewMode === "globe" ? (
            <aside
              aria-label="Spot summary"
              className="pointer-events-auto absolute z-30 max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto sm:top-3 sm:right-4 sm:w-[min(396px,calc(100dvw-2rem))]"
            >
              <CompactSpotCard
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                sourceNode={relationSourceNode}
                targetNode={relationTargetNode}
                allNodes={snapshot.nodes}
                allEdges={snapshot.edges}
                visibleNodes={globeNodes}
                microscopeScan={microscopeScan}
                microscopeByNode={microscopeByNode}
                probedCoord={probedCoord}
                primary={telemetryPrimary}
                secondary={telemetrySecondary}
                summaries={telemetrySummaries}
                focusedSummaryDataset={focusedSummaryDataset}
                comparison={comparison}
                current={telemetryCurrent}
                secondaryCurrent={telemetrySecondaryCurrent}
                tempUnit={tempUnit}
                onChangeTempUnit={setTempUnit}
                mobileCollapsed={mobileSheetCollapsed}
                onToggleMobileCollapse={() => setMobileSheetCollapsed((v) => !v)}
                enabledRelationCategories={enabledRelationCategories}
                compareMode={compareMode}
                comparePending={Boolean(probedCoord && comparePinB)}
                guidedCases={guidedCaseItems}
                activeCaseStudyId={activeCaseStudyId}
                onSelectCaseStudy={handleSelectCaseStudyById}
                activeTopics={activeTopics}
                loading={telemetryLoading}
                error={telemetryError}
                diagnostics={telemetryDiagnostics}
                failureKind={telemetryFailureKind}
                onRetry={retryTelemetry}
                discoverBusy={discoverBusy}
                onToggleTopic={toggleTopic}
                onResetTopics={resetTopics}
                onFocusSummaryDataset={(ds) => setFocusedSummaryDataset(ds)}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onCompareOpposite={handleCompareOpposite}
                onToggleCompareMode={() => setCompareMode((v) => !v)}
                onSwapPins={handleSwapPins}
                onClearComparison={() => {
                  setActiveCaseStudyId(null);
                  setComparison(null);
                  setTelemetrySecondary(null);
                  setTelemetrySecondaryCurrent(null);
                  setComparePinB(null);
                  setSelectedEdgeUuid(null);
                  setRelationNodePair(null);
                  if (probedCoord && !selectedNodeUuid) {
                    const requested = activeTopics.length > 0 ? activeTopics : DEFAULT_MULTI_TOPICS;
                    const gridded = requested.filter((ds) => GRIDDED_TOPIC_SET.has(ds));
                    if (gridded.length > 0) {
                      void queryTimeSeries(
                        probedCoord.lat,
                        probedCoord.lng,
                        gridded[0],
                        undefined,
                        undefined,
                        gridded
                      );
                    }
                  }
                }}
                onDiscoverGlobalTrends={() => void handleDiscoverGlobalTrends()}
                onCommitToGraph={handleCommitTelemetryToGraph}
                onCommitRelation={handleCommitRelation}
                onOpenInGraphWorkbench={handleOpenInGraphWorkbench}
                onGraphUpdated={refreshGraph}
              onClose={handleClearSelection}
              />
            </aside>
          ) : null)}
        </main>
      </div>

      <IngestionModal
        open={ingestOpen}
        initialTab={ingestTab}
        onClose={() => setIngestOpen(false)}
        nodes={snapshot.nodes}
        onIngested={refreshGraph}
      />

      <SolarMicrogridPanel
        open={solarGraphOpen}
        onClose={() => setSolarGraphOpen(false)}
        onFocusDenver={() => {
          setSolarGraphOpen(false);
          setViewMode("globe");
          void handleProbeCoordinate(39.74, -104.99);
          requestRegionalFocus(39.74, -104.99, 128);
        }}
        onMaterializeInGraph={handleMaterializeSolarGraph}
      />
    </div>
  );
}
