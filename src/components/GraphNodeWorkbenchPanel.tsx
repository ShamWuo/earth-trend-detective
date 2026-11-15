"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { GitBranchPlus, Globe2, Sparkles, X } from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { ETG_LABEL_PALETTE, resolveEtgNodeColor } from "@/lib/graph/graphVisuals";
import { useIsLightTheme } from "@/components/graph/graphViewShared";
import type {
  CandidateLinkSuggestion,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  TrendMicroscopeScanResult,
} from "@/types/etg";
import type { WorkbenchTab } from "@/components/workbench/workbenchShared";
import { WorkbenchQuickAddNodeForm } from "@/components/workbench/WorkbenchQuickAddNodeForm";
import { WorkbenchEdgeComposerForm } from "@/components/workbench/WorkbenchEdgeComposerForm";
import { WorkbenchTraverseTab } from "@/components/workbench/WorkbenchTraverseTab";
import { WorkbenchPredictTab } from "@/components/workbench/WorkbenchPredictTab";
import { WorkbenchEvidenceTab } from "@/components/workbench/WorkbenchEvidenceTab";

interface GraphNodeWorkbenchPanelProps {
  allNodes: ETGNode[];
  allEdges: ETGEdge[];
  selectedNode: ETGNode | null;
  selectedEdge: ETGEdge | null;
  pendingConnectPair: { sourceUuid: string; targetUuid: string } | null;
  quickAddOpen: boolean;
  candidateLinks: CandidateLinkSuggestion[];
  microscopeScan?: TrendMicroscopeScanResult | null;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  traversalHistory: Array<{ uuid: string; name: string }>;
  maxHops: number;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge: (edge: ETGEdge) => void;
  onClearPendingConnect: () => void;
  onCloseQuickAdd: () => void;
  onStartQuickConnect: (sourceNode: ETGNode, targetNode?: ETGNode) => void;
  onDiscoverLinksForNode: (anchorUuid: string) => Promise<void>;
  onAcceptCandidateLink: (suggestion: CandidateLinkSuggestion) => Promise<void>;
  onMaterializeSolarGraph: () => Promise<void>;
  onLocateOnGlobe?: (node: ETGNode) => void;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
  onClose: () => void;
}

export function GraphNodeWorkbenchPanel({
  allNodes,
  allEdges,
  selectedNode,
  selectedEdge,
  pendingConnectPair,
  quickAddOpen,
  candidateLinks,
  microscopeScan = null,
  microscopeByNode,
  traversalHistory,
  maxHops,
  onSelectNode,
  onSelectEdge,
  onClearPendingConnect,
  onCloseQuickAdd,
  onStartQuickConnect,
  onDiscoverLinksForNode,
  onAcceptCandidateLink,
  onMaterializeSolarGraph,
  onLocateOnGlobe,
  onSnapshotChange,
  onClose,
}: GraphNodeWorkbenchPanelProps) {
  const baseId = useId();
  const isLightTheme = useIsLightTheme();
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("traverse");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  useEffect(() => {
    setLocalError(null);
    setLocalStatus(null);
  }, [selectedNode, selectedEdge, pendingConnectPair]);

  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.uuid, n])), [allNodes]);

  const incomingLinks = useMemo(() => {
    if (!selectedNode) return [];
    return allEdges
      .filter((e) => e.target_uuid === selectedNode.uuid)
      .map((edge) => ({ edge, node: nodeById.get(edge.source_uuid) }))
      .filter((item): item is { edge: ETGEdge; node: ETGNode } => Boolean(item.node));
  }, [allEdges, selectedNode, nodeById]);

  const outgoingLinks = useMemo(() => {
    if (!selectedNode) return [];
    return allEdges
      .filter((e) => e.source_uuid === selectedNode.uuid)
      .map((edge) => ({ edge, node: nodeById.get(edge.target_uuid) }))
      .filter((item): item is { edge: ETGEdge; node: ETGNode } => Boolean(item.node));
  }, [allEdges, selectedNode, nodeById]);

  const { supersededByItems, supersedesPriorItems } = useMemo(() => {
    if (!selectedNode) {
      return {
        supersededByItems: [] as Array<{ node: ETGNode; rationale?: string }>,
        supersedesPriorItems: [] as Array<{ node: ETGNode; rationale?: string }>,
      };
    }
    const supersededBy: Array<{ node: ETGNode; rationale?: string }> = [];
    const seenBy = new Set<string>();
    const supersedesPrior: Array<{ node: ETGNode; rationale?: string }> = [];
    const seenPrior = new Set<string>();

    for (const edge of allEdges) {
      if (edge.type !== "supersedes") continue;
      if (edge.target_uuid === selectedNode.uuid) {
        const newer = nodeById.get(edge.source_uuid);
        if (newer && !seenBy.has(newer.uuid)) {
          seenBy.add(newer.uuid);
          supersededBy.push({ node: newer, rationale: edge.properties.rationale });
        }
      }
      if (edge.source_uuid === selectedNode.uuid) {
        const prior = nodeById.get(edge.target_uuid);
        if (prior && !seenPrior.has(prior.uuid)) {
          seenPrior.add(prior.uuid);
          supersedesPrior.push({ node: prior, rationale: edge.properties.rationale });
        }
      }
    }

    if (selectedNode.properties.superseded_by && !seenBy.has(selectedNode.properties.superseded_by)) {
      const replacement = nodeById.get(selectedNode.properties.superseded_by);
      if (replacement) {
        supersededBy.push({ node: replacement });
      }
    }

    return { supersededByItems: supersededBy, supersedesPriorItems: supersedesPrior };
  }, [allEdges, selectedNode, nodeById]);

  const nodeCandidates = useMemo(() => {
    if (!selectedNode) return candidateLinks;
    const anchored = candidateLinks.filter(
      (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
    );
    return anchored.length > 0 ? anchored : candidateLinks;
  }, [candidateLinks, selectedNode]);

  const unlinkedSeriesPeers = useMemo(() => {
    if (!selectedNode) return [];
    const connected = new Set<string>([selectedNode.uuid]);
    for (const e of allEdges) {
      if (e.source_uuid === selectedNode.uuid) connected.add(e.target_uuid);
      if (e.target_uuid === selectedNode.uuid) connected.add(e.source_uuid);
    }
    return allNodes.filter(
      (n) =>
        !connected.has(n.uuid) &&
        ((n.properties.series_count ?? 0) >= 6 ||
          (n.properties.sparkline_preview?.length ?? 0) >= 3)
    );
  }, [allNodes, allEdges, selectedNode]);

  const handleDeleteEdge = async (edgeUuid: string) => {
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch(`/api/graph?edgeUuid=${encodeURIComponent(edgeUuid)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to unlink edge");
      onSnapshotChange(data.snapshot, "Unlinked connection from Knowledge Graph.");
      if (selectedEdge?.properties.uuid === edgeUuid) {
        onClose();
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Unlink failed");
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: WorkbenchTab; label: string }> = [
    { id: "traverse", label: "Traverse & Links" },
    { id: "predict", label: "Predict & ML" },
    { id: "evidence", label: "Evidence & Edit" },
  ];

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      setActiveTab(tabs[nextIdx].id);
      tabRefs.current[nextIdx]?.focus();
    }
  };

  /* ── Mode A: Quick Phenomenon Node Creator ─────────────────────────────── */
  if (quickAddOpen) {
    return (
      <WorkbenchQuickAddNodeForm
        baseId={baseId}
        allNodes={allNodes}
        onCloseQuickAdd={onCloseQuickAdd}
        onSelectNode={onSelectNode}
        onSnapshotChange={onSnapshotChange}
      />
    );
  }

  /* ── Mode B: Edge Connection Composer / Editor ─────────────────────────── */
  if (pendingConnectPair || selectedEdge) {
    return (
      <WorkbenchEdgeComposerForm
        baseId={baseId}
        allNodes={allNodes}
        nodeById={nodeById}
        selectedEdge={selectedEdge}
        pendingConnectPair={pendingConnectPair}
        busy={busy}
        onSetBusy={setBusy}
        onClearPendingConnect={onClearPendingConnect}
        onSelectEdge={onSelectEdge}
        onDeleteEdge={handleDeleteEdge}
        onSnapshotChange={onSnapshotChange}
        onClose={onClose}
      />
    );
  }

  if (!selectedNode) return null;

  /* ── Mode C: Selected Node 3-Tab Workbench ─────────────────────────────── */
  const nodeColor = resolveEtgNodeColor(selectedNode);
  const labelStyle = ETG_LABEL_PALETTE[selectedNode.label];
  const isHuman = selectedNode.properties.authored_by === "human";
  const lightPillColors: Record<ETGNode["label"], string> = {
    Concept: "#0369a1",
    Signal: "#b45309",
    Insight: "#6b21a8",
    Rule: "#047857",
  };
  const pillColor =
    selectedNode.properties.status === "Superseded"
      ? isLightTheme
        ? "#475569"
        : "#94a3b8"
      : isLightTheme
        ? lightPillColors[selectedNode.label]
        : nodeColor;

  return (
    <div className="etg-hud-pill flex max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-md bg-surface shadow-2xl">
      {/* Workbench Header */}
      <div className="border-b border-border px-4 py-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10px] font-semibold"
                style={{
                  backgroundColor: isLightTheme ? labelStyle.pillBgLight : labelStyle.pillBgDark,
                  color: pillColor,
                }}
              >
                {selectedNode.label}
              </span>
              <span className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 font-mono text-[10px] text-text-muted">
                {isHuman
                  ? "Human"
                  : selectedNode.properties.authored_by === "ai"
                    ? "AI Synthesis"
                    : "NASA / Sensor"}
              </span>
              {selectedNode.properties.phenomenon_type && (
                <span className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[10px] text-text-subtle">
                  {selectedNode.properties.phenomenon_type.replaceAll("_", " ")}
                </span>
              )}
              {(selectedNode.properties.status === "Superseded" ||
                Boolean(selectedNode.properties.superseded_by)) && (
                <span className="rounded-sm border border-purple-400 bg-purple-950 px-2 py-0.5 font-mono text-[10px] font-semibold text-purple-300">
                  Superseded Assessment
                </span>
              )}
            </div>
            <h2 className="truncate text-sm font-semibold text-text-primary">
              {selectedNode.properties.name}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close node workbench"
            className="rounded-sm p-1 text-text-muted hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onStartQuickConnect(selectedNode)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-amber-400 bg-amber-950 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:border-amber-300 cursor-pointer"
          >
            <GitBranchPlus className="h-3 w-3" aria-hidden="true" />
            <span>Connect From Here</span>
          </button>
          <button
            type="button"
            onClick={() => void onDiscoverLinksForNode(selectedNode.uuid)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-purple-400 bg-purple-950 px-2.5 py-1 text-[11px] font-semibold text-purple-300 hover:border-purple-300 cursor-pointer"
          >
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            <span>Discover Links</span>
          </button>
          {typeof selectedNode.properties.lat === "number" &&
            typeof selectedNode.properties.lng === "number" &&
            onLocateOnGlobe && (
              <button
                type="button"
                onClick={() => onLocateOnGlobe(selectedNode)}
                className="inline-flex items-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-2.5 py-1 text-[11px] font-semibold text-sky-300 hover:border-sky-300 cursor-pointer"
              >
                <Globe2 className="h-3 w-3" aria-hidden="true" />
                <span>Locate on 3D Earth</span>
              </button>
            )}
        </div>
      </div>

      {/* Single-Row Accessible Tablist (.etg-tablist / .etg-tab) */}
      <div role="tablist" aria-label="Node workbench sections" className="etg-tablist px-2">
        {tabs.map((tab, idx) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            id={`${baseId}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
            className="etg-tab"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scrollable Body — Zero padding/margins/borders on [role="tabpanel"] itself */}
      <div className="flex-1 overflow-y-auto text-xs">
        {/* TAB 1: TRAVERSE & LINKS */}
        <div
          id={`${baseId}-panel-traverse`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-traverse`}
          hidden={activeTab !== "traverse"}
        >
          <WorkbenchTraverseTab
            baseId={baseId}
            selectedNode={selectedNode}
            allNodes={allNodes}
            allEdges={allEdges}
            nodeById={nodeById}
            microscopeCue={microscopeByNode?.[selectedNode.uuid]}
            microscopeScan={microscopeScan}
            supersededByItems={supersededByItems}
            supersedesPriorItems={supersedesPriorItems}
            traversalHistory={traversalHistory}
            incomingLinks={incomingLinks}
            outgoingLinks={outgoingLinks}
            nodeCandidates={nodeCandidates}
            onSelectNode={onSelectNode}
            onSelectEdge={onSelectEdge}
            onDeleteEdge={handleDeleteEdge}
            onStartQuickConnect={onStartQuickConnect}
            onAcceptCandidateLink={onAcceptCandidateLink}
            onSnapshotChange={onSnapshotChange}
            onSetLocalError={setLocalError}
            onSetLocalStatus={setLocalStatus}
          />
        </div>

        {/* TAB 2: PREDICT & ML */}
        <div
          id={`${baseId}-panel-predict`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-predict`}
          hidden={activeTab !== "predict"}
        >
          <WorkbenchPredictTab
            baseId={baseId}
            active={
              activeTab === "predict" &&
              !quickAddOpen &&
              !pendingConnectPair &&
              !selectedEdge
            }
            isLightTheme={isLightTheme}
            selectedNode={selectedNode}
            nodeById={nodeById}
            unlinkedSeriesPeers={unlinkedSeriesPeers}
            maxHops={maxHops}
            localError={localError}
            localStatus={localStatus}
            onSetLocalError={setLocalError}
            onSetLocalStatus={setLocalStatus}
            onSelectNode={onSelectNode}
            onStartQuickConnect={onStartQuickConnect}
            onMaterializeSolarGraph={onMaterializeSolarGraph}
          />
        </div>

        {/* TAB 3: EVIDENCE & EDIT */}
        <div
          id={`${baseId}-panel-evidence`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-evidence`}
          hidden={activeTab !== "evidence"}
        >
          <WorkbenchEvidenceTab
            selectedNode={selectedNode}
            busy={busy}
            localError={localError}
            localStatus={localStatus}
            onSetBusy={setBusy}
            onSetLocalError={setLocalError}
            onSetLocalStatus={setLocalStatus}
            onSelectNode={onSelectNode}
            onSnapshotChange={onSnapshotChange}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}
