"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  GitCompare,
  Globe2,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { findMultiHopCascades } from "@/lib/graph/cascadeTracer";
import { ETG_LABEL_PALETTE } from "@/lib/graph/graphVisuals";
import type {
  CrossRegionComparison,
  EarthCascadeChain,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGNodeLabel,
  ETGRelationshipType,
  TrendAnalysisSummary,
} from "@/types/etg";
import { DATASET_BY_ID } from "@/lib/datasets";
import { humanizeNodeText } from "@/lib/plainLanguage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DatasetSelector } from "@/components/DatasetSelector";
import { TimelineScrubber } from "@/components/TimelineScrubber";
import { EarthGlobe3D } from "@/components/EarthGlobe3D";
import { EarthTrendGraphView } from "@/components/EarthTrendGraphView";
import { CompactSpotCard } from "@/components/CompactSpotCard";
import { IngestionModal, type IngestionTabId } from "@/components/IngestionModal";

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

interface DetectiveBriefing {
  engine: string;
  briefing: string;
  citedNodes: string[];
  telemetrySummary?: {
    verdict: string;
    pValue: number;
    slope: number;
    slopeUnit: string;
  };
}

function getNodeTimestampMs(node: ETGNode): number {
  const raw = node.properties.observed_at || node.properties.created_at;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
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

export function DetectiveWorkspace({
  initialSnapshot,
}: {
  initialSnapshot: EtgGraphSnapshot;
}) {
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
  const [telemetrySummaries, setTelemetrySummaries] = useState<TrendAnalysisSummary[]>([]);
  const [focusedSummaryDataset, setFocusedSummaryDataset] = useState<ETGDatasetId | null>(null);
  const [comparison, setComparison] = useState<CrossRegionComparison | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);

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

  // AI Detective synthesis
  const [question, setQuestion] = useState("");
  const [detectiveBusy, setDetectiveBusy] = useState(false);
  const [briefing, setBriefing] = useState<DetectiveBriefing | null>(null);

  // View-transition focus target & telemetry refs
  const viewHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const telemetrySummariesRef = useRef<TrendAnalysisSummary[]>([]);
  telemetrySummariesRef.current = telemetrySummaries;
  const telemetryLoadingRef = useRef(false);
  telemetryLoadingRef.current = telemetryLoading;

  // Close Right Inspector Sheet with Escape key
  useEffect(() => {
    if (!inspectorOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setInspectorOpen(false);
        setSelectedNodeUuid(null);
        setSelectedEdgeUuid(null);
        setCompareMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOpen]);

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
        });
        const data = await res.json();
        if (res.ok) {
          setTelemetryPrimary(data.primary ?? null);
          setTelemetrySecondary(data.secondary ?? null);
          setComparison(data.comparison ?? null);
          setTelemetrySummaries(
            Array.isArray(data.summaries)
              ? data.summaries
              : data.primary
                ? [data.primary]
                : []
          );
        } else {
          setTelemetryError(data.error || "Live Earth data temporarily unavailable.");
        }
      } catch (err) {
        setTelemetryError(
          err instanceof Error ? err.message : "Failed to fetch live Earth data."
        );
      } finally {
        setTelemetryLoading(false);
      }
    },
    []
  );

  const toggleTopic = useCallback((ds: ETGDatasetId) => {
    setActiveTopics((prev) =>
      prev.includes(ds) ? prev.filter((item) => item !== ds) : [...prev, ds]
    );
  }, []);

  const resetTopics = useCallback(() => {
    setActiveTopics([]);
  }, []);

  // Switch primary view with View Transitions API + focus management
  const handleSwitchView = useCallback(
    (nextMode: WorkspaceViewMode) => {
      if (nextMode === viewMode) return;

      const focusStageHeading = () => {
        viewHeadingRef.current?.focus({ preventScroll: true });
      };

      const docWithTransition = document as Document & {
        startViewTransition?: (cb: () => void) => { finished: Promise<void> };
      };

      if (typeof docWithTransition.startViewTransition === "function") {
        const transition = docWithTransition.startViewTransition(() => {
          flushSync(() => {
            setViewMode(nextMode);
          });
        });
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
      setRelationNodePair(null);
      setFocusedSummaryDataset(null);
      setInspectorOpen(true);
      if (
        typeof node.properties.lat === "number" &&
        typeof node.properties.lng === "number"
      ) {
        const lat = node.properties.lat;
        const lng = node.properties.lng;
        setProbedCoord({ lat, lng });
        const ds: ETGDatasetId =
          node.properties.dataset || activeTopics[0] || "nasa_power";
        void queryTimeSeries(lat, lng, ds, undefined, node.uuid);
      } else {
        setProbedCoord(null);
        setTelemetryPrimary(null);
        setTelemetrySecondary(null);
        setTelemetrySummaries([]);
        setComparison(null);
      }
    },
    [queryTimeSeries, activeTopics]
  );

  const handleClearSelection = useCallback(() => {
    setSelectedNodeUuid(null);
    setSelectedEdgeUuid(null);
    setActiveCascade(null);
    setCompareMode(false);
    setComparePinB(null);
    setRelationNodePair(null);
    setFocusedSummaryDataset(null);
    setInspectorOpen(false);
  }, []);

  const handleSelectEdge = useCallback(
    (edge: ETGEdge) => {
      setSelectedEdgeUuid(edge.properties.uuid);
      setSelectedNodeUuid(null);
      setCompareMode(false);
      setFocusedSummaryDataset(null);
      setInspectorOpen(true);
      setRelationNodePair({
        sourceUuid: edge.source_uuid,
        targetUuid: edge.target_uuid,
      });

      const src = snapshot.nodes.find((n) => n.uuid === edge.source_uuid);
      const tgt = snapshot.nodes.find((n) => n.uuid === edge.target_uuid);
      if (
        src?.properties.lat !== undefined &&
        src?.properties.lng !== undefined &&
        tgt?.properties.lat !== undefined &&
        tgt?.properties.lng !== undefined
      ) {
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
        setComparePinB(null);
        setComparison(null);
        setTelemetryPrimary(null);
        setTelemetrySecondary(null);
        setTelemetrySummaries([]);
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

      setSelectedNodeUuid(null);
      setSelectedEdgeUuid(null);
      setProbedCoord({ lat, lng });
      setComparePinB(null);
      setComparison(null);
      setTelemetrySecondary(null);
      setRelationNodePair(null);
      setFocusedSummaryDataset(null);

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
        setTelemetryPrimary(null);
        setTelemetrySummaries([]);
        setTelemetryError(null);
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
    const verdictShort =
      summary.verdict === "Normal Environmental Variability"
        ? "Baseline"
        : summary.verdict.replace("Statistically Significant ", "");
    const name = `${dsMeta.shortLabel} ${verdictShort} (${summary.lat.toFixed(1)}°, ${summary.lng.toFixed(1)}°)`;
    return {
      label: "Signal",
      is_provisional: !summary.mannKendall.significant,
      properties: {
        name,
        description: `${summary.parameter} time-series analyzed via Mann-Kendall (p=${summary.mannKendall.pValue.toFixed(4)}) and Theil-Sen slope (${summary.theilSen.slope >= 0 ? "+" : ""}${summary.theilSen.slope.toFixed(3)} ${summary.slopeUnit}). Provenance: ${summary.provenance}.`,
        status: summary.mannKendall.significant ? "Active" : "Provisional",
        importance: summary.mannKendall.significant ? 0.85 : 0.62,
        lat: summary.lat,
        lng: summary.lng,
        region: `${summary.lat.toFixed(2)}°, ${summary.lng.toFixed(2)}°`,
        dataset: summary.dataset,
        producer_type: "nasa_satellite",
        confidence: summary.mannKendall.significant ? 0.91 : 0.64,
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
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node: buildNodePayloadFromSummary(summary),
          edge: {
            source_uuid: "$NEW_NODE",
            target_uuid: "rule-corroboration",
            type: "verified_by",
            source_snippet: `Interactive globe probe committed with p=${summary.mannKendall.pValue.toFixed(4)}.`,
          },
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
        setStatusMessage("Saved spot observation to the Earth Trend Graph.");
      }
    },
    []
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
      setInspectorOpen(false);
      setTelemetryPrimary(null);
      setTelemetrySecondary(null);
      setComparison(null);
      setStatusMessage("Cleared Earth Trend Graph (0 nodes, 0 hardcoded records).");
      hidePopoverById("etg-more-popover");
    }
  }, []);

  const handleAskDetective = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setDetectiveBusy(true);
      try {
        const res = await fetch("/api/ai/detective", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectedNodeUuid: selectedNode?.uuid,
            lat: probedCoord?.lat,
            lng: probedCoord?.lng,
            dataset:
              selectedNode?.properties.dataset ||
              (activeTopics[0] || "ocean_temp"),
            question: question.trim() || undefined,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as DetectiveBriefing;
          setBriefing(data);
        }
      } finally {
        setDetectiveBusy(false);
      }
    },
    [selectedNode, probedCoord, activeTopics, question]
  );

  const stageTitle =
    viewMode === "graph"
      ? `Earth Trend Knowledge Graph (${graphRenderMode.toUpperCase()})`
      : "Interactive 3D Earth Globe";

  const activeFilterCount =
    (activeTopics.length > 0 ? 1 : 0) + (onlyOpposite ? 1 : 0) + (!showSuperseded ? 1 : 0);

  const topicButtonLabel =
    activeTopics.length === 0
      ? "Topics: All"
      : activeTopics.length === 1
        ? `Topics: ${DATASET_BY_ID[activeTopics[0]].shortLabel}`
        : `Topics (${activeTopics.length})`;

  return (
    <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-bg text-text-primary">
      {/* Top Floating HUD Bar — spacious single row on desktop */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-wrap lg:flex-nowrap items-center justify-between gap-2 px-4 py-3 sm:px-5 sm:py-4">
        {/* Left Pill: Brand + Topic Filter + Linked Trends */}
        <div className="etg-hud-pill pointer-events-auto flex items-center gap-2 rounded-full px-3.5 py-1.5">
          <div className="flex items-center gap-2 pr-0.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent-fg shadow-[0_0_8px_rgba(226,168,86,0.8)]" aria-hidden="true" />
            <h1 className="whitespace-nowrap font-outfit text-sm font-semibold tracking-tight text-text-primary">
              Earth Trend Detective
            </h1>
          </div>

          <div className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />

          <button
            type="button"
            popoverTarget="etg-filter-popover"
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs sm:text-[13px] font-medium transition-colors cursor-pointer ${
              activeFilterCount > 0
                ? "bg-accent/18 text-accent-fg"
                : "text-text-muted hover:bg-surface-band hover:text-text-primary"
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{topicButtonLabel}</span>
            {activeFilterCount > 0 && (
              <span className="ws-numeric rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>

          <button
            type="button"
            popoverTarget="etg-dipoles-popover"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs sm:text-[13px] font-medium text-rose-400 transition-colors hover:bg-rose-500/12 cursor-pointer"
          >
            <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden xl:inline">Linked Trends</span>
            <span className="ws-numeric font-mono text-[11px]">
              {snapshot.oppositeTrendPairs.length}
            </span>
          </button>
        </div>

        {/* Center Segmented Switcher: 3D Earth vs Knowledge Graph (3D/2D) */}
        <nav
          aria-label="Workspace View Switcher"
          className="etg-hud-pill pointer-events-auto flex items-center gap-1 rounded-full p-1"
        >
          <button
            type="button"
            onClick={() => handleSwitchView("globe")}
            aria-pressed={viewMode === "globe"}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs sm:text-[13px] font-medium transition-colors cursor-pointer ${
              viewMode === "globe"
                ? "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] font-semibold shadow-sm"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>3D Earth</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchView("graph")}
            aria-pressed={viewMode === "graph"}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs sm:text-[13px] font-medium transition-colors cursor-pointer ${
              viewMode === "graph"
                ? "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] font-semibold shadow-sm"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            <Network className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Knowledge Graph</span>
          </button>

          {viewMode === "graph" && (
            <>
              <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
              {(["3d", "2d"] as const).map((mode) => {
                const active = graphRenderMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setGraphRenderMode(mode)}
                    aria-pressed={active}
                    className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold uppercase transition-colors cursor-pointer ${
                      active
                        ? "bg-surface-band text-text-primary ring-1 ring-border-strong"
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

        {/* Right Pill: Search + Ask AI + Add Data + Utilities + Theme */}
        <div className="etg-hud-pill pointer-events-auto flex items-center gap-1.5 rounded-full px-2.5 py-1">
          <search className="relative hidden items-center lg:flex">
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
              placeholder="Search…"
              className="h-8 w-24 xl:w-36 rounded-full border border-border bg-surface-inset pr-2.5 pl-7 text-xs text-text-primary placeholder:text-text-subtle transition-all focus:w-40 xl:focus:w-48 focus:border-accent-fg focus:outline-none"
            />
          </search>

          <button
            type="button"
            popoverTarget="etg-ai-popover"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs sm:text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent/14 cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Ask AI</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setIngestTab("dataset");
              setIngestOpen(true);
            }}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-accent px-3 py-1.5 text-xs sm:text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Add Data</span>
          </button>

          <button
            type="button"
            popoverTarget="etg-more-popover"
            title="Live global discovery, NASA EONET sync & tools"
            aria-label="More observatory tools"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
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

        {/* Mobile/Tablet Search Input */}
        <div className="md:hidden">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search places or trends…"
            className="form-input"
          />
        </div>

        {/* Graph Toggles */}
        <div className="space-y-2 border-y border-border py-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={onlyOpposite}
              onChange={(e) => setOnlyOpposite(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span>Only opposite trends</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={showSuperseded}
              onChange={(e) => setShowSuperseded(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span>Show updated findings</span>
          </label>
        </div>

        {/* Graph Node Key */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-text-subtle">Map &amp; Graph Key</div>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface-inset p-2.5">
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

      {/* 2. Linked & Opposite Trends Popover */}
      <div id="etg-dipoles-popover" popover="auto" className="etg-popover space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-rose-400">
            Linked &amp; Opposite Trends
          </h3>
          <span className="ws-numeric font-mono text-[11px] text-text-subtle">
            {snapshot.oppositeTrendPairs.length} pairs
          </span>
        </div>

        <div className="space-y-2">
          {[...snapshot.oppositeTrendPairs]
            .sort((a, b) => {
              const interRegion = (p: typeof a) => {
                const latA = p.source.properties.lat;
                const lngA = p.source.properties.lng;
                const latB = p.target.properties.lat;
                const lngB = p.target.properties.lng;
                if (
                  latA === undefined ||
                  lngA === undefined ||
                  latB === undefined ||
                  lngB === undefined
                ) {
                  return 0;
                }
                return Math.abs(latA - latB) >= 1 || Math.abs(lngA - lngB) >= 1 ? 1 : 0;
              };
              const regionDiff = interRegion(b) - interRegion(a);
              if (regionDiff !== 0) return regionDiff;
              return Math.abs(b.correlationR ?? 0) - Math.abs(a.correlationR ?? 0);
            })
            .map((pair) => {
              const sameRegion =
                Boolean(pair.source.properties.region) &&
                pair.source.properties.region === pair.target.properties.region;
              const srcTitle = humanizeNodeText(
                sameRegion
                  ? pair.source.properties.name
                  : pair.source.properties.region || pair.source.properties.name
              );
              const tgtTitle = humanizeNodeText(
                sameRegion
                  ? pair.target.properties.name
                  : pair.target.properties.region || pair.target.properties.name
              );
              return (
                <button
                  key={pair.edgeUuid}
                  type="button"
                  onClick={() => handleCompareOpposite(pair.source, pair.target)}
                  className="w-full space-y-1 rounded-xl border border-rose-500/25 bg-rose-500/8 p-3 text-left transition-colors hover:border-rose-400/60 hover:bg-rose-500/14 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold text-text-primary">
                    <span className="truncate">{srcTitle}</span>
                    <span className="shrink-0 rounded-full border border-rose-500/35 bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-300">
                      Opposite
                    </span>
                  </div>
                  <div className="truncate text-xs text-text-muted">↔ {tgtTitle}</div>
                  {pair.mechanism && (
                    <div className="truncate pt-0.5 text-[10px] text-text-subtle">
                      {pair.mechanism}
                    </div>
                  )}
                </button>
              );
            })}
        </div>

        {cascades.length > 0 && (
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
              {cascades.slice(0, 3).map((chain) => (
                <button
                  key={chain.id}
                  type="button"
                  onClick={() => handleSelectCascade(chain)}
                  className="w-full space-y-1 rounded-xl border border-amber-400/25 bg-amber-400/8 p-2.5 text-left transition-colors hover:border-amber-400/60 hover:bg-amber-400/14 cursor-pointer"
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

      {/* 3. AI Trend Detective Popover */}
      <div id="etg-ai-popover" popover="auto" className="etg-popover etg-popover-end space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent-fg">
            <Sparkles className="h-3.5 w-3.5" />
            <span>AI Trend Detective</span>
          </div>
          <span className="font-mono text-[10px] text-text-faint">Live NASA + Trends</span>
        </div>

        <form onSubmit={(e) => void handleAskDetective(e)} className="space-y-2.5">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask why two regions show opposite trends…"
            className="form-input"
          />
          <button
            type="submit"
            disabled={detectiveBusy}
            className="w-full rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            {detectiveBusy ? "Summarizing Trends…" : "Explain Selected Area"}
          </button>
        </form>

        {briefing && (
          <div className="space-y-2.5 rounded-xl border border-border bg-surface-inset p-3 text-xs leading-relaxed text-text-secondary">
            <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-text-faint">
              <span className="truncate">{briefing.engine}</span>
              {briefing.telemetrySummary && (
                <span className="shrink-0">{briefing.telemetrySummary.verdict}</span>
              )}
            </div>
            <p className="whitespace-pre-wrap text-text-primary">{briefing.briefing}</p>
            {briefing.citedNodes.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {briefing.citedNodes.slice(0, 4).map((uuid) => {
                  const target = snapshot.nodes.find((n) => n.uuid === uuid);
                  if (!target) return null;
                  return (
                    <button
                      key={uuid}
                      type="button"
                      onClick={() => {
                        hidePopoverById("etg-ai-popover");
                        handleSelectNode(target);
                      }}
                      className="rounded-full border border-border bg-surface px-2.5 py-0.5 font-mono text-[10px] text-accent-fg hover:border-accent-fg cursor-pointer"
                    >
                      {humanizeNodeText(target.properties.name).slice(0, 24)}
                    </button>
                  );
                })}
              </div>
            )}
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
            onClick={() => void handleDiscoverGlobalTrends()}
            disabled={discoverBusy}
            className="flex w-full items-center justify-between rounded-xl border border-teal-500/35 bg-teal-500/10 px-3 py-2 text-xs font-semibold text-teal-400 hover:border-teal-400 disabled:opacity-50 cursor-pointer"
          >
            <span>{discoverBusy ? "Discovering Trends…" : "Re-run Live Global Discovery"}</span>
            <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={() => void handleSyncEonet()}
            disabled={eonetBusy}
            className="flex w-full items-center justify-between rounded-xl border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-border-strong disabled:opacity-50 cursor-pointer"
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
            className="flex w-full items-center justify-between rounded-xl border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            <span>Challenge Space-Agency Hub (12)</span>
            <Globe2 className="h-3.5 w-3.5 text-sky-400" />
          </button>

          <button
            type="button"
            onClick={() => void handleClearGraph()}
            className="flex w-full items-center justify-between rounded-xl border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-xs font-medium text-rose-400 hover:border-rose-400 cursor-pointer"
          >
            <span>Clear Graph (0 Nodes)</span>
            <RotateCcw className="h-3.5 w-3.5 text-rose-400" />
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

      {/* Transient Feedback Toast */}
      {statusMessage && (
        <div
          role="status"
          className={`etg-hud-pill pointer-events-auto absolute top-20 z-30 flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium text-text-primary shadow-lg ${
            inspectorOpen
              ? "left-6 max-w-[min(560px,calc(100dvw-410px))]"
              : "left-1/2 max-w-[min(680px,calc(100dvw-2rem))] -translate-x-1/2"
          }`}
        >
          <span className="truncate">{statusMessage}</span>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            aria-label="Dismiss notification"
            className="text-text-subtle hover:text-text-primary cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Full-Bleed Center Canvas */}
      <main
        className="relative flex-1 overflow-hidden"
        style={{ viewTransitionName: "etg-stage" }}
      >
        <h2 ref={viewHeadingRef} tabIndex={-1} className="sr-only">
          {stageTitle}
        </h2>

        {viewMode === "graph" ? (
          <EarthTrendGraphView
            nodes={visibleNodes}
            edges={visibleEdges}
            selectedNodeUuid={selectedNodeUuid}
            selectedEdgeUuid={selectedEdgeUuid}
            cascadeEdgeUuids={activeCascade?.edgeUuids ?? []}
            searchQuery={searchQuery}
            renderMode={graphRenderMode}
            onlyOpposite={onlyOpposite}
            showSuperseded={showSuperseded}
            inspectorOpen={inspectorOpen}
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            onClearSelection={handleClearSelection}
          />
        ) : (
          <>
            <EarthGlobe3D
              nodes={globeNodes}
              edges={globeEdges}
              selectedNodeUuid={selectedNodeUuid}
              selectedEdgeUuid={selectedEdgeUuid}
              cascadeEdgeUuids={activeCascade?.edgeUuids ?? []}
              probedCoord={probedCoord}
              comparePinB={comparePinB}
              compareMode={compareMode}
              inspectorOpen={inspectorOpen}
              onSelectNode={handleSelectNode}
              onSelectEdge={handleSelectEdge}
              onProbeCoordinate={handleProbeCoordinate}
              onToggleCompareMode={() => {
                setCompareMode((v) => !v);
                setInspectorOpen(true);
              }}
            />

            {/* Floating Bottom Timeline Scrubber on 3D Earth view */}
            <div className="pointer-events-auto z-20 absolute inset-x-4 bottom-20 md:inset-x-auto md:bottom-6 md:left-[29.5rem] md:w-[min(420px,calc(100dvw-31.5rem))] min-[1400px]:left-1/2 min-[1400px]:w-[440px] min-[1400px]:-translate-x-1/2">
              <TimelineScrubber
                nodes={snapshot.nodes}
                cutoffMs={cutoffMs}
                minMs={minMs}
                maxMs={maxMs}
                onChangeCutoff={(ms) => setCutoffMs(ms)}
                visibleCount={globeNodes.length}
              />
            </div>
          </>
        )}

        {snapshot.nodes.length === 0 && viewMode === "globe" && !inspectorOpen && (
          <div className="pointer-events-none absolute top-20 inset-x-0 z-20 flex justify-center px-4">
            <div className="etg-hud-pill pointer-events-auto flex flex-wrap items-center gap-3 rounded-full px-4 py-1.5 text-xs shadow-lg">
              <span className="text-text-muted">Click anywhere on Earth to see what&apos;s happening there, or</span>
              <button
                type="button"
                onClick={() => void handleDiscoverGlobalTrends()}
                disabled={discoverBusy}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`h-3 w-3 ${discoverBusy ? "animate-spin" : ""}`} aria-hidden="true" />
                <span>{discoverBusy ? "Loading Live Data…" : "Load Live Global Pins"}</span>
              </button>
            </div>
          </div>
        )}

        {snapshot.nodes.length === 0 && viewMode === "graph" && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
            <div className="etg-hud-pill pointer-events-auto max-w-md space-y-4 rounded-2xl p-6 text-center shadow-2xl">
              <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-teal-500/35 bg-teal-500/12 px-3 py-1 font-mono text-[11px] font-semibold text-teal-400">
                Zero Seeded Data · Live Scientific Observatory
              </div>
              <h3 className="font-outfit text-lg font-semibold text-text-primary">
                Build the Earth Trend Knowledge Graph from Live Data
              </h3>
              <p className="text-xs leading-relaxed text-text-muted">
                Ingest live NASA GISTEMP v4, NOAA GML/CDO stations, KNMI climate modes, CSA RCM /
                Geo.ca hydrology, SWOT passes, EONET events, and POWER MERRA-2 series to detect
                significant trends and wire linked opposite trends.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleDiscoverGlobalTrends()}
                  disabled={discoverBusy}
                  className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
                  {discoverBusy ? "Loading Live Data…" : "Load Live NASA / NOAA / CSA Trends"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIngestTab("agencies");
                    setIngestOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-elevated px-4 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                >
                  Space Agency Hub (12)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Compact Auto-Height Floating Spot Card (closed on initial load) */}
        {inspectorOpen && (
          <aside
            aria-label="Spot summary"
            className="absolute top-20 right-5 z-30 w-[min(368px,calc(100dvw-2rem))]"
          >
            <CompactSpotCard
              selectedNode={selectedNode}
              selectedEdge={selectedEdge}
              sourceNode={relationSourceNode}
              targetNode={relationTargetNode}
              allNodes={snapshot.nodes}
              allEdges={snapshot.edges}
              visibleNodes={globeNodes}
              probedCoord={probedCoord}
              primary={telemetryPrimary}
              secondary={telemetrySecondary}
              summaries={telemetrySummaries}
              focusedSummaryDataset={focusedSummaryDataset}
              comparison={comparison}
              compareMode={compareMode}
              activeTopics={activeTopics}
              loading={telemetryLoading}
              error={telemetryError}
              onToggleTopic={toggleTopic}
              onResetTopics={resetTopics}
              onFocusSummaryDataset={(ds) => setFocusedSummaryDataset(ds)}
              onSelectNode={handleSelectNode}
              onCompareOpposite={handleCompareOpposite}
              onToggleCompareMode={() => setCompareMode((v) => !v)}
              onSwapPins={handleSwapPins}
              onClearComparison={() => {
                setComparison(null);
                setTelemetrySecondary(null);
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
              onCommitToGraph={handleCommitTelemetryToGraph}
              onCommitRelation={handleCommitRelation}
              onGraphUpdated={refreshGraph}
              onClose={handleClearSelection}
            />
          </aside>
        )}
      </main>

      <IngestionModal
        open={ingestOpen}
        initialTab={ingestTab}
        onClose={() => setIngestOpen(false)}
        nodes={snapshot.nodes}
        onIngested={refreshGraph}
      />
    </div>
  );
}
