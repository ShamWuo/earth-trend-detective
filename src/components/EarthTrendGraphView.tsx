"use client";

import { useMemo, useState } from "react";
import { buildRegionAssignmentMap, filterEtgGraphData } from "@/lib/graph/graphVisuals";
import type { RegionOption } from "@/lib/graph/regionalSubgraph";
import type {
  CandidateLinkSuggestion,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  RelationCategory,
  SubgraphNodeRole,
} from "@/types/etg";
import { GraphCanvas2D } from "@/components/graph/GraphCanvas2D";
import { GraphCanvas3D } from "@/components/graph/GraphCanvas3D";
import { GraphWorkbenchToolbar } from "@/components/graph/GraphWorkbenchToolbar";
import {
  DEFAULT_TRAVERSAL_FILTER,
  type RegionSpotlightState,
  type TraversalFilterState,
  useIsLightTheme,
} from "@/components/graph/graphViewShared";

export type { TraversalFilterState } from "@/components/graph/graphViewShared";

export interface EarthTrendGraphViewProps {
  nodes: ETGNode[];
  edges: ETGEdge[];
  selectedNodeUuid: string | null;
  selectedEdgeUuid?: string | null;
  cascadeEdgeUuids?: string[];
  searchQuery?: string;
  renderMode: "3d" | "2d";
  onlyOpposite?: boolean;
  showSuperseded?: boolean;
  enabledRelationCategories?: ReadonlyArray<RelationCategory>;
  inspectorOpen?: boolean;
  inspectorWide?: boolean;
  candidateLinks?: CandidateLinkSuggestion[];
  traversalFilter?: TraversalFilterState;
  roleByNode?: Record<string, SubgraphNodeRole>;
  hopByNode?: Record<string, number>;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  connectMode?: boolean;
  connectSourceUuid?: string | null;
  discoveringLinks?: boolean;
  regionOptions?: RegionOption[];
  selectedRegionScope?: string | null;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onClearSelection?: () => void;
  onToggleConnectMode?: () => void;
  onStartQuickConnect?: (sourceNode: ETGNode, targetNode?: ETGNode) => void;
  onDiscoverLinks?: () => void;
  onAcceptCandidateLink?: (suggestion: CandidateLinkSuggestion) => void;
  onClearCandidateLinks?: () => void;
  onChangeTraversalFilter?: (next: TraversalFilterState) => void;
  onChangeRegionScope?: (regionId: string | null) => void;
  onResetOppositeFilter?: () => void;
}

/**
 * Coalesced Earth Trend Graph (ETG) container orchestrating the floating workbench toolbar,
 * regional spotlight filtering, and the active 3D WebGL or 2D semantic-zoom graph canvas.
 */
export function EarthTrendGraphView({
  nodes,
  edges,
  selectedNodeUuid,
  selectedEdgeUuid = null,
  cascadeEdgeUuids = [],
  searchQuery = "",
  renderMode,
  onlyOpposite = false,
  showSuperseded = true,
  enabledRelationCategories,
  inspectorOpen = false,
  inspectorWide = false,
  candidateLinks = [],
  traversalFilter = DEFAULT_TRAVERSAL_FILTER,
  roleByNode = {},
  hopByNode = {},
  microscopeByNode = {},
  connectMode = false,
  connectSourceUuid = null,
  discoveringLinks = false,
  regionOptions = [],
  selectedRegionScope = null,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onToggleConnectMode,
  onStartQuickConnect,
  onDiscoverLinks,
  onAcceptCandidateLink,
  onClearCandidateLinks,
  onChangeTraversalFilter,
  onChangeRegionScope,
  onResetOppositeFilter,
}: EarthTrendGraphViewProps) {
  const isLightTheme = useIsLightTheme();
  const [regionFocusNonce, setRegionFocusNonce] = useState(0);
  const alwaysIncludeNodeUuids = useMemo(() => {
    const keep = new Set<string>();
    if (selectedNodeUuid) keep.add(selectedNodeUuid);
    if (selectedEdgeUuid) {
      const edge = edges.find((e) => e.properties.uuid === selectedEdgeUuid);
      if (edge) {
        keep.add(edge.source_uuid);
        keep.add(edge.target_uuid);
      }
    }
    return keep;
  }, [selectedNodeUuid, selectedEdgeUuid, edges]);

  const { visibleNodes, visibleEdges } = useMemo(
    () =>
      filterEtgGraphData(
        nodes,
        edges,
        onlyOpposite,
        showSuperseded,
        enabledRelationCategories,
        {
          showProvenanceHubs: Boolean(traversalFilter.showProvenanceHubs),
          alwaysIncludeNodeUuids,
        }
      ),
    [
      nodes,
      edges,
      onlyOpposite,
      showSuperseded,
      enabledRelationCategories,
      traversalFilter.showProvenanceHubs,
      alwaysIncludeNodeUuids,
    ]
  );

  const regionSpotlight = useMemo<RegionSpotlightState | null>(() => {
    if (!selectedRegionScope) return null;
    const assignments = buildRegionAssignmentMap(visibleNodes);
    const localNodeSet = new Set<string>();
    for (const node of visibleNodes) {
      if (assignments.get(node.uuid)?.id === selectedRegionScope) {
        localNodeSet.add(node.uuid);
      }
    }
    if (localNodeSet.size === 0) return null;

    const bridgeNodeSet = new Set<string>();
    const spotlightEdgeSet = new Set<string>();
    for (const edge of visibleEdges) {
      const srcLocal = localNodeSet.has(edge.source_uuid);
      const tgtLocal = localNodeSet.has(edge.target_uuid);
      if (srcLocal && tgtLocal) {
        spotlightEdgeSet.add(edge.properties.uuid);
      } else if (srcLocal) {
        spotlightEdgeSet.add(edge.properties.uuid);
        bridgeNodeSet.add(edge.target_uuid);
      } else if (tgtLocal) {
        spotlightEdgeSet.add(edge.properties.uuid);
        bridgeNodeSet.add(edge.source_uuid);
      }
    }
    return { localNodeSet, bridgeNodeSet, spotlightEdgeSet };
  }, [selectedRegionScope, visibleNodes, visibleEdges]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const selectedNodeName = useMemo(
    () => visibleNodes.find((n) => n.uuid === selectedNodeUuid)?.properties.name ?? null,
    [visibleNodes, selectedNodeUuid]
  );
  const connectSourceName = useMemo(
    () => visibleNodes.find((n) => n.uuid === connectSourceUuid)?.properties.name ?? null,
    [visibleNodes, connectSourceUuid]
  );

  if (nodes.length === 0) {
    return <div className="etg-graph-void h-full w-full" />;
  }

  if (visibleNodes.length === 0) {
    const isEmptyOpposite = onlyOpposite && nodes.length > 0;
    return (
      <div className="etg-graph-void flex h-full w-full items-center justify-center">
        <div className="etg-hud-pill max-w-sm rounded-md bg-surface px-6 py-5 text-center">
          <p className="text-sm font-medium text-text-primary">
            {isEmptyOpposite
              ? "No cross-region opposite-trend pairs match the current filter"
              : "No Earth signals match this filter"}
          </p>
            <p className="mt-1 text-xs text-text-muted">
              {isEmptyOpposite
                ? "Disable the Opposite Trends filter, widen the timeline scrubber, or discover candidate teleconnections."
                : "Widen the timeline scrubber or switch datasets to reveal local graph nodes."}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {isEmptyOpposite && onResetOppositeFilter && (
                <button
                  type="button"
                  onClick={onResetOppositeFilter}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-inset px-3.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-surface-hover cursor-pointer"
                >
                  <span>Show All Relationships</span>
                </button>
              )}
            </div>
        </div>
      </div>
    );
  }

  const sharedCanvasProps = {
    nodes: visibleNodes,
    edges: visibleEdges,
    selectedNodeUuid,
    selectedEdgeUuid,
    cascadeEdgeUuids,
    searchQuery: normalizedQuery,
    isLightTheme,
    candidateLinks,
    traversalFilter,
    roleByNode,
    hopByNode,
    microscopeByNode,
    connectMode,
    connectSourceUuid,
    selectedRegionScope,
    regionSpotlight,
    regionFocusNonce,
    onChangeRegionScope,
    onSelectNode,
    onSelectEdge,
    onClearSelection,
    onStartQuickConnect,
    onAcceptCandidateLink,
  };

  return (
    <div className="relative h-full w-full">
      <GraphWorkbenchToolbar
        renderMode={renderMode}
        isLightTheme={isLightTheme}
        selectedNodeName={selectedNodeName}
        hasSelection={Boolean(selectedNodeUuid)}
        connectMode={connectMode}
        connectSourceName={connectSourceName}
        discoveringLinks={discoveringLinks}
        candidateCount={candidateLinks.length}
        traversalFilter={traversalFilter}
        inspectorOpen={inspectorOpen}
        inspectorWide={inspectorWide}
        regionOptions={regionOptions}
        selectedRegionScope={selectedRegionScope}
        onToggleConnectMode={onToggleConnectMode}
        onDiscoverLinks={onDiscoverLinks}
        onClearCandidateLinks={onClearCandidateLinks}
        onChangeTraversalFilter={onChangeTraversalFilter}
        onChangeRegionScope={onChangeRegionScope}
        onRefocusActiveRegion={() => setRegionFocusNonce((n) => n + 1)}
      />

      {renderMode === "2d" ? (
        <GraphCanvas2D {...sharedCanvasProps} />
      ) : (
        <GraphCanvas3D
          {...sharedCanvasProps}
          inspectorOpen={inspectorOpen}
          inspectorWide={inspectorWide}
        />
      )}
    </div>
  );
}
