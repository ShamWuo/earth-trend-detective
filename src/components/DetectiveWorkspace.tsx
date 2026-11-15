"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { findMultiHopCascades } from "@/lib/graph/cascadeTracer";
import { filterEtgGraphData } from "@/lib/graph/graphVisuals";
import type {
  EarthCascadeChain,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  RelationCategory,
} from "@/types/etg";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  ALL_RELATION_CATEGORIES,
  findNearbyFilteredNodes,
} from "@/lib/plainLanguage";
import { assignNodeRegions, extractRegionOptions } from "@/lib/graph/regionalSubgraph";
import { TimelineScrubber } from "@/components/TimelineScrubber";
import {
  EarthGlobe3D,
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
import {
  DEFAULT_MULTI_TOPICS,
  EMPTY_CASCADE_EDGE_UUIDS,
  EMPTY_HOP_BY_NODE,
  EMPTY_ROLE_BY_NODE,
  GRIDDED_TOPIC_SET,
  GUIDED_DIPOLE_CASES,
  buildComparisonArcVisualMeta,
  buildFormattedAllRelations,
  buildGuidedCaseItems,
  computeClientEmbeddedSummary,
  computeDipoleFramingTarget,
  getNodeTimestampMs,
  hidePopoverById,
  isSameSpotCoord,
  type GraphRenderMode,
  type GuidedDipoleCase,
  type RelationPopoverFilter,
  type WorkspaceViewMode,
} from "@/components/workspace/workspaceDipolesAndUtils";
import { useWorkspaceTelemetry } from "@/components/workspace/useWorkspaceTelemetry";
import { useWorkspaceGraphActions } from "@/components/workspace/useWorkspaceGraphActions";
import {
  WorkspaceHeader,
  WorkspacePopovers,
} from "@/components/workspace/WorkspaceHeaderAndPopovers";
import {
  WorkspaceGlobeEmptyPrompt,
  WorkspaceGraphEmptyPrompt,
  WorkspaceStageBanner,
} from "@/components/workspace/WorkspaceStageOverlays";

export {
  GUIDED_DIPOLE_CASES,
  computeDipoleFramingTarget,
  type GuidedDipoleCase,
};

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
  const [traversalFilter, setTraversalFilter] = useState<TraversalFilterState>({
    maxHops: null,
    direction: "both",
    layoutMode: "force",
  });
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

  const telemetry = useWorkspaceTelemetry({
    inspectorOpen,
    probedCoord,
    selectedNodeUuid,
    comparePinB,
    selectedEdgeUuid,
    activeTopics,
  });

  const {
    telemetryPrimary,
    setTelemetryPrimary,
    telemetrySecondary,
    setTelemetrySecondary,
    telemetryCurrent,
    setTelemetryCurrent,
    telemetrySecondaryCurrent,
    setTelemetrySecondaryCurrent,
    telemetrySummaries,
    setTelemetrySummaries,
    focusedSummaryDataset,
    setFocusedSummaryDataset,
    comparison,
    setComparison,
    telemetryLoading,
    setTelemetryLoading,
    telemetryError,
    setTelemetryError,
    telemetryDiagnostics,
    setTelemetryDiagnostics,
    telemetryFailureKind,
    setTelemetryFailureKind,
    tempUnit,
    setTempUnit,
    telemetryPrimaryRef,
    telemetrySummariesRef,
    telemetryCurrentRef,
    cancelTelemetryRequests,
    queryTimeSeries,
    retryTelemetry,
  } = telemetry;

  // User display preferences & modal state
  const [mobileSheetCollapsed, setMobileSheetCollapsed] = useState(false);
  const [enabledRelationCategories, setEnabledRelationCategories] = useState<RelationCategory[]>([
    ...ALL_RELATION_CATEGORIES,
  ]);
  const [relationPopoverFilter, setRelationPopoverFilter] =
    useState<RelationPopoverFilter>("all");

  const toggleRelationCategoryFilter = useCallback((cat: RelationCategory) => {
    setEnabledRelationCategories((prev) =>
      prev.includes(cat) ? prev.filter((item) => item !== cat) : [...prev, cat]
    );
  }, []);

  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestTab, setIngestTab] = useState<IngestionTabId>("dataset");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!statusMessage) return;
    const t = window.setTimeout(() => setStatusMessage(null), 4500);
    return () => window.clearTimeout(t);
  }, [statusMessage]);

  const viewHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const onClearGraphTelemetry = useCallback(() => {
    setTelemetryPrimary(null);
    setTelemetrySecondary(null);
    setComparison(null);
  }, [setComparison, setTelemetryPrimary, setTelemetrySecondary]);

  const graphActions = useWorkspaceGraphActions({
    snapshot,
    setSnapshot,
    viewMode,
    setViewMode,
    selectedNodeUuid,
    setSelectedNodeUuid,
    setSelectedEdgeUuid,
    setInspectorOpen,
    setQuickAddNodeOpen,
    setPendingConnectPair,
    setConnectMode,
    setConnectSourceUuid,
    setRelationNodePair,
    setCutoffMs,
    traversalFilter,
    setTraversalFilter,
    showSuperseded,
    onlyOpposite,
    enabledRelationCategories,
    setStatusMessage,
    onClearGraphTelemetry,
  });

  const {
    candidateLinks,
    setCandidateLinks,
    discoveringLinks,
    traversalSubgraph,
    traversalHistory,
    setTraversalHistory,
    eonetBusy,
    discoverBusy,
    microscopeScan,
    microscopeByNode,
    refreshGraph,
    handleDiscoverCandidateLinks,
    handleAcceptCandidateLink,
    handleMaterializeSolarGraph,
    handleSnapshotChange,
    handleCommitTelemetryToGraph,
    handleCommitRelation,
    handleDiscoverGlobalTrends,
    handleSyncEonet,
    handleClearGraph,
    handleExportWorkspaceBundle,
    handleImportWorkspaceBundle,
  } = graphActions;

  // Auto-expand mobile Spot Summary sheet whenever user selects a new spot/node/relation
  useEffect(() => {
    setMobileSheetCollapsed(false);
  }, [selectedNodeUuid, selectedEdgeUuid, probedCoord]);

  // Close Right Inspector Sheet / Cancel Connect or Compare Mode with Escape key
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

  const toggleTopic = useCallback((ds: ETGDatasetId) => {
    setActiveTopics((prev) =>
      prev.includes(ds) ? prev.filter((item) => item !== ds) : [...prev, ds]
    );
  }, []);

  const resetTopics = useCallback(() => {
    setActiveTopics([]);
  }, []);

  // Switch primary view with typed View Transitions API + focus management
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
        ) => {
          finished: Promise<void>;
          ready?: Promise<void>;
          updateCallbackDone?: Promise<void>;
        };
      };

      const prefersReducedMotion =
        typeof window !== "undefined" &&
        Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

      const transitionType =
        nextMode === "graph" ? "coalesce-to-graph" : "expand-to-globe";

      if (
        !prefersReducedMotion &&
        document.visibilityState === "visible" &&
        typeof docWithTransition.startViewTransition === "function"
      ) {
        let updated = false;
        const applyUpdate = () => {
          updated = true;
          flushSync(() => {
            setViewMode(nextMode);
          });
        };
        let transition: {
          finished: Promise<void>;
          ready?: Promise<void>;
          updateCallbackDone?: Promise<void>;
        };
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
        void transition.ready?.catch(() => {});
        void transition.updateCallbackDone?.catch(() => {});
        void transition.finished
          .finally(() => {
            focusStageHeading();
          })
          .catch(() => {});
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
        cancelTelemetryRequests();
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
    [
      activeTopics,
      cancelTelemetryRequests,
      queryTimeSeries,
      setComparison,
      setFocusedSummaryDataset,
      setTelemetryCurrent,
      setTelemetryDiagnostics,
      setTelemetryError,
      setTelemetryFailureKind,
      setTelemetryLoading,
      setTelemetryPrimary,
      setTelemetrySecondary,
      setTelemetrySecondaryCurrent,
      setTelemetrySummaries,
      setTraversalHistory,
      telemetryCurrentRef,
      telemetryPrimaryRef,
      telemetrySummariesRef,
    ]
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
    cancelTelemetryRequests();
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
  }, [
    cancelTelemetryRequests,
    setFocusedSummaryDataset,
    setTelemetryCurrent,
    setTelemetryDiagnostics,
    setTelemetryError,
    setTelemetryFailureKind,
    setTelemetryLoading,
    setTelemetrySecondaryCurrent,
  ]);

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
        setStatusMessage(
          `Composing link: ${sourceNode.properties.name} → ${targetNode.properties.name}`
        );
      } else {
        setConnectMode(true);
        setConnectSourceUuid(sourceNode.uuid);
        setStatusMessage(
          `Selected source "${sourceNode.properties.name}" — now click a target node.`
        );
      }
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
        cancelTelemetryRequests();
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
    [
      snapshot.nodes,
      cancelTelemetryRequests,
      queryTimeSeries,
      setComparison,
      setFocusedSummaryDataset,
      setTelemetryCurrent,
      setTelemetryDiagnostics,
      setTelemetryError,
      setTelemetryFailureKind,
      setTelemetryLoading,
      setTelemetryPrimary,
      setTelemetrySecondary,
      setTelemetrySecondaryCurrent,
      setTelemetrySummaries,
    ]
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
        void queryTimeSeries(lat, lng, gridded[0], undefined, undefined, gridded);
      } else {
        cancelTelemetryRequests();
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
    [
      compareMode,
      probedCoord,
      telemetryPrimary,
      activeTopics,
      queryTimeSeries,
      cancelTelemetryRequests,
      telemetryPrimaryRef,
      telemetrySummariesRef,
      telemetryCurrentRef,
      setComparison,
      setTelemetrySecondary,
      setTelemetrySecondaryCurrent,
      setFocusedSummaryDataset,
      setTelemetryPrimary,
      setTelemetrySummaries,
      setTelemetryCurrent,
      setTelemetryDiagnostics,
      setTelemetryFailureKind,
      setTelemetryError,
      setTelemetryLoading,
    ]
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
    [snapshot.edges, queryTimeSeries, setFocusedSummaryDataset, setTelemetryError]
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

  const handleSelectCascade = useCallback((chain: EarthCascadeChain | null) => {
    setActiveCascade(chain);
    if (chain) {
      hidePopoverById("etg-dipoles-popover");
      setInspectorOpen(true);
      setStatusMessage(`Highlighted ${chain.steps.length}-stage Earth chain: ${chain.title}`);
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
    [
      queryTimeSeries,
      requestRegionalFocus,
      setComparison,
      setFocusedSummaryDataset,
      setTelemetryCurrent,
      setTelemetryDiagnostics,
      setTelemetryError,
      setTelemetryFailureKind,
      setTelemetryPrimary,
      setTelemetrySecondary,
      setTelemetrySecondaryCurrent,
      setTelemetrySummaries,
    ]
  );

  const guidedCaseItems = useMemo<GuidedCaseStudyItem[]>(() => buildGuidedCaseItems(), []);

  const handleSelectCaseStudyById = useCallback(
    (caseId: string) => {
      const preset = GUIDED_DIPOLE_CASES.find((c) => c.id === caseId);
      if (preset) {
        handleRunCaseStudy(preset);
      }
    },
    [handleRunCaseStudy]
  );

  const comparisonArcMeta = useMemo(
    () =>
      buildComparisonArcVisualMeta({
        viewMode,
        probedCoord,
        comparePinB,
        activeCaseStudyId,
        relationSourceNode,
        relationTargetNode,
        comparison,
        telemetryLoading,
        selectedEdge,
      }),
    [
      viewMode,
      probedCoord,
      comparePinB,
      activeCaseStudyId,
      relationSourceNode,
      relationTargetNode,
      comparison,
      telemetryLoading,
      selectedEdge,
    ]
  );

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

  const formattedAllRelations = useMemo(
    () =>
      buildFormattedAllRelations(
        snapshot.nodes,
        snapshot.edges,
        enabledRelationCategories
      ),
    [snapshot.nodes, snapshot.edges, enabledRelationCategories]
  );

  return (
    <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-bg text-text-primary">
      <a href="#etg-main-stage" className="etg-skip-link">
        Skip to interactive Earth stage
      </a>
      <WorkspaceHeader
        topicButtonLabel={topicButtonLabel}
        activeFilterCount={activeFilterCount}
        relationsCount={formattedAllRelations.length}
        viewMode={viewMode}
        graphRenderMode={graphRenderMode}
        searchQuery={searchQuery}
        aiStudioOpen={aiStudioOpen}
        onSwitchView={handleSwitchView}
        onChangeGraphRenderMode={setGraphRenderMode}
        onChangeSearchQuery={setSearchQuery}
        onOpenSolarGraph={() => setSolarGraphOpen(true)}
        onToggleAiStudio={() => setAiStudioOpen((v) => !v)}
        onOpenAddData={() => {
          setIngestTab("dataset");
          setIngestOpen(true);
        }}
      />

      <WorkspacePopovers
        bundleInputId={bundleInputId}
        activeFilterCount={activeFilterCount}
        activeTopics={activeTopics}
        nodes={snapshot.nodes}
        searchQuery={searchQuery}
        enabledRelationCategories={enabledRelationCategories}
        onlyOpposite={onlyOpposite}
        showSuperseded={showSuperseded}
        tempUnit={tempUnit}
        relationPopoverFilter={relationPopoverFilter}
        formattedAllRelations={formattedAllRelations}
        cascades={cascades}
        discoverBusy={discoverBusy}
        eonetBusy={eonetBusy}
        activity={snapshot.activity}
        onResetAllFilters={() => {
          resetTopics();
          setOnlyOpposite(false);
          setShowSuperseded(true);
          setEnabledRelationCategories([...ALL_RELATION_CATEGORIES]);
        }}
        onToggleTopic={toggleTopic}
        onResetTopics={resetTopics}
        onChangeSearchQuery={setSearchQuery}
        onToggleRelationCategoryFilter={toggleRelationCategoryFilter}
        onChangeOnlyOpposite={setOnlyOpposite}
        onChangeShowSuperseded={setShowSuperseded}
        onChangeTempUnit={setTempUnit}
        onChangeRelationPopoverFilter={setRelationPopoverFilter}
        onRunCaseStudy={handleRunCaseStudy}
        onSelectEdge={handleSelectEdge}
        onSelectCascade={(chain) => handleSelectCascade(chain)}
        onOpenSolarGraph={() => setSolarGraphOpen(true)}
        onDiscoverGlobalTrends={() => void handleDiscoverGlobalTrends()}
        onSyncEonet={() => void handleSyncEonet()}
        onOpenIngestModal={(tab) => {
          setIngestTab(tab);
          setIngestOpen(true);
        }}
        onExportWorkspaceBundle={() => void handleExportWorkspaceBundle()}
        onImportWorkspaceBundle={(e) => void handleImportWorkspaceBundle(e)}
        onClearGraph={() => void handleClearGraph()}
      />

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
          id="etg-main-stage"
          tabIndex={-1}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-fg)]"
          style={{ viewTransitionName: "etg-stage" }}
        >
          <h2 ref={viewHeadingRef} tabIndex={-1} className="sr-only">
            {stageTitle}
          </h2>

          <WorkspaceStageBanner
            statusMessage={statusMessage}
            compareMode={compareMode}
            viewMode={viewMode}
            aiStudioOpen={aiStudioOpen}
            inspectorOpen={inspectorOpen}
            onDismissStatus={() => setStatusMessage(null)}
            onCancelCompare={() => setCompareMode(false)}
          />

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
            <WorkspaceGlobeEmptyPrompt
              discoverBusy={discoverBusy}
              onDiscoverGlobalTrends={() => void handleDiscoverGlobalTrends()}
              onRunCaseStudy={handleRunCaseStudy}
            />
          )}

          {snapshot.nodes.length === 0 && viewMode === "graph" && !quickAddNodeOpen && (
            <WorkspaceGraphEmptyPrompt
              discoverBusy={discoverBusy}
              onDiscoverGlobalTrends={() => void handleDiscoverGlobalTrends()}
              onMaterializeSolarGraph={() => void handleMaterializeSolarGraph()}
              onOpenQuickAddNode={() => {
                setQuickAddNodeOpen(true);
                setInspectorOpen(true);
              }}
              onOpenAgencyHub={() => {
                setIngestTab("agencies");
                setIngestOpen(true);
              }}
            />
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
                      const requested =
                        activeTopics.length > 0 ? activeTopics : DEFAULT_MULTI_TOPICS;
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
