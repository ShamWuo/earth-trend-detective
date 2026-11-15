"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import {
  ALL_ETG_RELATIONSHIP_TYPES,
  getRelationshipTypesForFilter,
} from "@/lib/plainLanguage";
import type {
  CandidateLinkSuggestion,
  CrossRegionComparison,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  RelationCategory,
  SubgraphTraversalResult,
  TrendAnalysisSummary,
  TrendMicroscopeScanResult,
} from "@/types/etg";
import type { TraversalFilterState } from "@/components/EarthTrendGraphView";
import {
  buildNodePayloadFromSummary,
  getNodeTimestampMs,
  hidePopoverById,
  resolveCommitRelationEdgeType,
  type WorkspaceViewMode,
} from "./workspaceDipolesAndUtils";

export interface UseWorkspaceGraphActionsArgs {
  snapshot: EtgGraphSnapshot;
  setSnapshot: React.Dispatch<React.SetStateAction<EtgGraphSnapshot>>;
  viewMode: WorkspaceViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<WorkspaceViewMode>>;
  selectedNodeUuid: string | null;
  setSelectedNodeUuid: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedEdgeUuid: React.Dispatch<React.SetStateAction<string | null>>;
  setInspectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setQuickAddNodeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingConnectPair: React.Dispatch<
    React.SetStateAction<{ sourceUuid: string; targetUuid: string } | null>
  >;
  setConnectMode: React.Dispatch<React.SetStateAction<boolean>>;
  setConnectSourceUuid: React.Dispatch<React.SetStateAction<string | null>>;
  setRelationNodePair: React.Dispatch<
    React.SetStateAction<{ sourceUuid?: string; targetUuid?: string } | null>
  >;
  setCutoffMs: React.Dispatch<React.SetStateAction<number>>;
  traversalFilter: TraversalFilterState;
  setTraversalFilter: React.Dispatch<React.SetStateAction<TraversalFilterState>>;
  showSuperseded: boolean;
  onlyOpposite: boolean;
  enabledRelationCategories: RelationCategory[];
  setStatusMessage: React.Dispatch<React.SetStateAction<string | null>>;
  onClearGraphTelemetry: () => void;
}

export function useWorkspaceGraphActions({
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
}: UseWorkspaceGraphActionsArgs) {
  const [candidateLinks, setCandidateLinks] = useState<CandidateLinkSuggestion[]>([]);
  const [discoveringLinks, setDiscoveringLinks] = useState(false);
  const [traversalSubgraph, setTraversalSubgraph] =
    useState<SubgraphTraversalResult | null>(null);
  const [traversalHistory, setTraversalHistory] = useState<
    Array<{ uuid: string; name: string }>
  >([]);
  const [eonetBusy, setEonetBusy] = useState(false);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [microscopeScan, setMicroscopeScan] =
    useState<TrendMicroscopeScanResult | null>(null);

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
    snapshot.nodes,
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
  }, [setCutoffMs, setSnapshot]);

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
    [selectedNodeUuid, setStatusMessage]
  );

  const handleAcceptCandidateLink = useCallback(
    async (suggestion: CandidateLinkSuggestion) => {
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
    },
    [setInspectorOpen, setSelectedEdgeUuid, setSelectedNodeUuid, setSnapshot, setStatusMessage]
  );

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
  }, [
    setCutoffMs,
    setInspectorOpen,
    setPendingConnectPair,
    setQuickAddNodeOpen,
    setSelectedEdgeUuid,
    setSelectedNodeUuid,
    setSnapshot,
    setStatusMessage,
    setTraversalFilter,
    setViewMode,
  ]);

  const handleSnapshotChange = useCallback(
    (nextSnapshot: EtgGraphSnapshot, toast?: string) => {
      setSnapshot(nextSnapshot);
      if (nextSnapshot.nodes.length > 0) {
        const nextMax = Math.max(...nextSnapshot.nodes.map(getNodeTimestampMs));
        setCutoffMs((prev) => Math.max(prev, nextMax));
      }
      if (toast) setStatusMessage(toast);
    },
    [setCutoffMs, setSnapshot, setStatusMessage]
  );

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
    [snapshot.nodes, setInspectorOpen, setSelectedNodeUuid, setSnapshot, setStatusMessage]
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
      const edgeType = resolveCommitRelationEdgeType(cmp);

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
    [setRelationNodePair, setSelectedEdgeUuid, setSnapshot, setStatusMessage]
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
  }, [setCutoffMs, setSnapshot, setStatusMessage]);

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
  }, [setSnapshot, setStatusMessage]);

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
      onClearGraphTelemetry();
      setStatusMessage("Cleared Earth Trend Graph (0 nodes, 0 hardcoded records).");
      hidePopoverById("etg-more-popover");
    }
  }, [
    onClearGraphTelemetry,
    setConnectMode,
    setConnectSourceUuid,
    setInspectorOpen,
    setPendingConnectPair,
    setQuickAddNodeOpen,
    setSelectedEdgeUuid,
    setSelectedNodeUuid,
    setSnapshot,
    setStatusMessage,
  ]);

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
  }, [setStatusMessage]);

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
    [setSnapshot, setStatusMessage]
  );

  return {
    candidateLinks,
    setCandidateLinks,
    discoveringLinks,
    traversalSubgraph,
    setTraversalSubgraph,
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
  };
}
