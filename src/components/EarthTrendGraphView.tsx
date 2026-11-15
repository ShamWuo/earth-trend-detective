"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, GitBranchPlus, Plus, Sparkles, Waypoints, X } from "lucide-react";
import * as THREE from "three";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import {
  computeCameraPanDelta,
  computeGlideEase,
  computeInitialContinuousLookAt,
  computeOrbitCameraPosition,
  computeOrbitSphericalCoordinates,
  computeSurfaceConnectionPoints,
  computeTargetOrbitDistance,
} from "@/lib/graph/graphCamera";
import {
  buildRegionAssignmentMap,
  CARD_HEIGHT,
  CARD_WIDTH,
  computeGraphBoundingSphere3D,
  computeLayout2D,
  computeLayout3D,
  computeRegionClusters2D,
  computeRegionClusters3D,
  createEtgHaloCanvas,
  createEtgNodeCanvas,
  filterEtgGraphData,
  formatEdgeRelationLabel,
  type Layout2DMode,
  MAX_ZOOM,
  MIN_ZOOM,
  type Point2D,
  type RegionCluster3D,
  resolveDetailTier,
  resolveEtgEdgeColor,
  resolveEtgNodeColor,
  type ScreenEdgePillCandidate,
  type ScreenLabelCandidate,
  selectNonOverlappingEdgePills,
  selectNonOverlappingLabels,
  wheelZoomStep,
} from "@/lib/graph/graphVisuals";
import { humanizeNodeText } from "@/lib/plainLanguage";
import type { RegionOption } from "@/lib/graph/regionalSubgraph";
import type {
  CandidateLinkSuggestion,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  RelationCategory,
  SubgraphNodeRole,
  TraversalDirection,
} from "@/types/etg";

export interface TraversalFilterState {
  maxHops: number | null;
  direction: TraversalDirection;
  layoutMode: Layout2DMode;
}

interface EarthTrendGraphViewProps {
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
  onOpenQuickAddNode?: () => void;
  onDiscoverLinks?: () => void;
  onAcceptCandidateLink?: (suggestion: CandidateLinkSuggestion) => void;
  onClearCandidateLinks?: () => void;
  onChangeTraversalFilter?: (next: TraversalFilterState) => void;
  onChangeRegionScope?: (regionId: string | null) => void;
  onResetOppositeFilter?: () => void;
}

interface RegionSpotlightState {
  localNodeSet: Set<string>;
  bridgeNodeSet: Set<string>;
  spotlightEdgeSet: Set<string>;
}

const DEFAULT_TRAVERSAL_FILTER: TraversalFilterState = {
  maxHops: null,
  direction: "both",
  layoutMode: "force",
};

function resolveMicroscopeNodeBadge(
  cue: NodeTrendMicroscopeCue | undefined,
  isLightTheme: boolean
): { text: string; title: string; pillClass: string; bg: string; fg: string } | null {
  if (!cue) return null;
  if (cue.dealiasing.falseTrendProb >= 0.55 || cue.radarBadge === "FALSE_TREND_CYCLE") {
    return {
      text: "CYCLE",
      title: `Possible seasonal/oscillatory cycle (${Math.round(cue.dealiasing.oscillationShare * 100)}% cycle share, P_false=${Math.round(cue.dealiasing.falseTrendProb * 100)}%)`,
      pillClass: isLightTheme ? "bg-amber-100 text-amber-900" : "bg-amber-950 text-amber-300",
      bg: isLightTheme ? "#fef3c7" : "#451a03",
      fg: isLightTheme ? "#92400e" : "#fcd34d",
    };
  }
  if (cue.radarBadge === "SENSOR_GLITCH_RISK") {
    return {
      text: "GLITCH",
      title: `Step-shift or sensor artifact risk (${Math.round(cue.dealiasing.artifactShare * 100)}% artifact share)`,
      pillClass: isLightTheme ? "bg-rose-100 text-rose-900" : "bg-rose-950 text-rose-300",
      bg: isLightTheme ? "#ffe4e6" : "#4c0519",
      fg: isLightTheme ? "#be123c" : "#fda4af",
    };
  }
  if (cue.preMannKendallAlert || cue.radarBadge === "EARLY_ONSET") {
    return {
      text: "PRE-MK",
      title: `Pre-Mann-Kendall early inflection (${Math.round(cue.onsetProb * 100)}% onset prob, +${cue.leadStepsAhead} step lead)`,
      pillClass: isLightTheme ? "bg-sky-100 text-sky-900" : "bg-sky-950 text-sky-300",
      bg: isLightTheme ? "#e0f2fe" : "#082f49",
      fg: isLightTheme ? "#075985" : "#38bdf8",
    };
  }
  return null;
}

function formatTrendStat(
  node: ETGNode,
  isLightTheme = false
): { label: string; color: string } {
  const slope = node.properties.theil_sen_slope;
  if (typeof slope === "number" && Number.isFinite(slope)) {
    const sign = slope >= 0 ? "+" : "";
    const arrow = slope > 0 ? "↑" : slope < 0 ? "↓" : "→";
    const unit = node.properties.slope_unit || "";
    const shortUnit = unit.length > 8 ? "" : ` ${unit}`;
    const color =
      typeof node.properties.p_value === "number" && node.properties.p_value < 0.05
        ? slope >= 0
          ? isLightTheme
            ? "#be123c"
            : "#fb7185"
          : isLightTheme
            ? "#0369a1"
            : "#38bdf8"
        : isLightTheme
          ? "#3f3f46"
          : "#94a3b8";
    return { label: `${sign}${slope.toFixed(2)}${shortUnit} ${arrow}`, color };
  }
  if (typeof node.properties.value === "number" && Number.isFinite(node.properties.value)) {
    return {
      label: `${node.properties.value.toFixed(1)} ${node.properties.unit ?? ""}`.trim(),
      color: isLightTheme ? "#3f3f46" : "#a1a1aa",
    };
  }
  const ptype = node.properties.phenomenon_type;
  return {
    label: ptype ? ptype.replaceAll("_", " ") : node.label,
    color: isLightTheme ? "#52525b" : "#94a3b8",
  };
}

function intersectBoxBorder(
  center: Point2D,
  toward: Point2D,
  halfW: number,
  halfH: number
): Point2D {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) return center;
  const scaleX = Math.abs(dx) > 1e-3 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = Math.abs(dy) > 1e-3 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(scaleX, scaleY, 1);
  return {
    x: center.x + dx * t,
    y: center.y + dy * t,
  };
}

function useIsLightTheme(): boolean {
  const [isLight, setIsLight] = useState(false);

  useEffect(() => {
    const sync = () => {
      setIsLight(document.documentElement.classList.contains("light"));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return isLight;
}

function GraphWorkbenchToolbar({
  renderMode,
  isLightTheme,
  selectedNodeName,
  hasSelection,
  connectMode,
  connectSourceName,
  discoveringLinks,
  candidateCount,
  traversalFilter,
  inspectorOpen,
  regionOptions = [],
  selectedRegionScope = null,
  onToggleConnectMode,
  onOpenQuickAddNode,
  onDiscoverLinks,
  onClearCandidateLinks,
  onChangeTraversalFilter,
  onChangeRegionScope,
  onRefocusActiveRegion,
}: {
  renderMode: "3d" | "2d";
  isLightTheme: boolean;
  selectedNodeName?: string | null;
  hasSelection: boolean;
  connectMode: boolean;
  connectSourceName?: string | null;
  discoveringLinks: boolean;
  candidateCount: number;
  traversalFilter: TraversalFilterState;
  inspectorOpen: boolean;
  regionOptions?: RegionOption[];
  selectedRegionScope?: string | null;
  onToggleConnectMode?: () => void;
  onOpenQuickAddNode?: () => void;
  onDiscoverLinks?: () => void;
  onClearCandidateLinks?: () => void;
  onChangeTraversalFilter?: (next: TraversalFilterState) => void;
  onChangeRegionScope?: (regionId: string | null) => void;
  onRefocusActiveRegion?: () => void;
}) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // Roving tabindex fallback when native focusgroup="toolbar wrap" is unsupported
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    if (typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype) {
      return;
    }
    const selector = "button:not(:disabled), select:not(:disabled)";
    const items = Array.from(toolbar.querySelectorAll<HTMLElement>(selector));
    if (items.length === 0) return;

    items.forEach((btn, idx) => {
      if (btn.tabIndex !== 0 && idx > 0) btn.tabIndex = -1;
    });
    if (!items.some((b) => b.tabIndex === 0)) {
      items[0].tabIndex = 0;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const currentButtons = Array.from(toolbar.querySelectorAll<HTMLElement>(selector));
      const idx = currentButtons.indexOf(target);
      if (idx === -1) return;

      let nextIdx = -1;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % currentButtons.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + currentButtons.length) % currentButtons.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = currentButtons.length - 1;
      else return;

      e.preventDefault();
      currentButtons.forEach((b, i) => {
        b.tabIndex = i === nextIdx ? 0 : -1;
      });
      currentButtons[nextIdx].focus();
    };

    toolbar.addEventListener("keydown", onKeyDown);
    return () => toolbar.removeEventListener("keydown", onKeyDown);
  }, [hasSelection, renderMode, candidateCount, selectedRegionScope, regionOptions.length]);

  return (
    <div
      className={`pointer-events-none absolute top-3 z-20 flex flex-col items-center gap-2 transition-[left] duration-200 ${
        inspectorOpen
          ? "left-1/2 -translate-x-1/2 lg:left-[calc(50%-200px)]"
          : "left-1/2 -translate-x-1/2"
      }`}
    >
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Knowledge Graph Workbench"
        {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
        className="etg-hud-pill pointer-events-auto flex max-w-[calc(100dvw-2rem)] flex-wrap items-center gap-1 rounded-md bg-surface px-2 py-1 text-[11px] shadow-lg"
      >
        <div role="group" aria-label="Graph authoring actions" className="flex items-center gap-1">
          {onOpenQuickAddNode && (
            <button
              type="button"
              onClick={onOpenQuickAddNode}
              className="inline-flex items-center gap-1 rounded-sm border border-transparent px-2.5 py-1 font-medium text-text-primary hover:bg-surface-hover cursor-pointer"
            >
              <Plus
                className={`h-3.5 w-3.5 ${isLightTheme ? "text-amber-700" : "text-amber-400"}`}
                aria-hidden="true"
              />
              <span>Add Node</span>
            </button>
          )}

          {onToggleConnectMode && (
            <button
              type="button"
              aria-pressed={connectMode}
              onClick={onToggleConnectMode}
              className={`inline-flex items-center gap-1 rounded-sm border border-transparent px-2.5 py-1 font-medium text-text-primary transition-colors hover:bg-surface-hover cursor-pointer ${
                isLightTheme
                  ? "aria-pressed:border-amber-600 aria-pressed:bg-amber-100 aria-pressed:text-amber-900"
                  : "aria-pressed:border-accent-fg aria-pressed:bg-amber-950 aria-pressed:text-amber-300"
              }`}
            >
              <GitBranchPlus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{connectMode ? "Connecting…" : "Connect"}</span>
            </button>
          )}

          {onDiscoverLinks && (
            <button
              type="button"
              onClick={onDiscoverLinks}
              disabled={discoveringLinks}
              className="inline-flex items-center gap-1 rounded-sm border border-transparent px-2.5 py-1 font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50 cursor-pointer"
            >
              <Sparkles
                className={`h-3.5 w-3.5 ${
                  isLightTheme ? "text-violet-700" : "text-violet-400"
                } ${discoveringLinks ? "animate-pulse" : ""}`}
                aria-hidden="true"
              />
              <span>{discoveringLinks ? "Scanning…" : "Find Links"}</span>
            </button>
          )}
        </div>

        {onChangeTraversalFilter && (
          <>
            <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 border-l border-border" />
            <div role="group" aria-label="Hop depth traversal" className="flex items-center gap-0.5">
              {([null, 1, 2, 3] as const).map((h) => (
                <button
                  key={h === null ? "all" : `hop-${h}`}
                  type="button"
                  disabled={h !== null && !hasSelection}
                  title={
                    h !== null && !hasSelection
                      ? "Select a node first to isolate its k-hop neighborhood"
                      : undefined
                  }
                  aria-pressed={traversalFilter.maxHops === h}
                  onClick={() => onChangeTraversalFilter({ ...traversalFilter, maxHops: h })}
                  className={`rounded-sm border border-transparent px-2 py-1 font-mono text-[10px] font-medium text-text-muted hover:text-text-primary disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed ${
                    isLightTheme
                      ? "aria-pressed:border-sky-600 aria-pressed:bg-sky-100 aria-pressed:text-sky-900"
                      : "aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300"
                  }`}
                >
                  {h === null ? "All" : `${h}-Hop`}
                </button>
              ))}
            </div>

            {hasSelection && (
              <>
                <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 border-l border-border" />
                <div role="group" aria-label="Causal traversal direction" className="flex items-center gap-0.5">
                  {(
                    [
                      { id: "both", label: "Both" },
                      { id: "upstream", label: "← Drivers" },
                      { id: "downstream", label: "→ Impacts" },
                    ] as const
                  ).map((dir) => (
                    <button
                      key={dir.id}
                      type="button"
                      aria-pressed={traversalFilter.direction === dir.id}
                      onClick={() =>
                        onChangeTraversalFilter({
                          ...traversalFilter,
                          direction: dir.id,
                          maxHops: traversalFilter.maxHops ?? 2,
                        })
                      }
                      className={`rounded-sm border border-transparent px-2 py-1 text-[10px] font-medium text-text-muted hover:text-text-primary cursor-pointer ${
                        isLightTheme
                          ? "aria-pressed:border-teal-600 aria-pressed:bg-teal-100 aria-pressed:text-teal-900"
                          : "aria-pressed:border-teal-400 aria-pressed:bg-teal-950 aria-pressed:text-teal-300"
                      }`}
                    >
                      {dir.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            {renderMode === "2d" && (
              <>
                <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 border-l border-border" />
                <div role="group" aria-label="Graph layout mode" className="flex items-center">
                  <button
                    type="button"
                    aria-pressed={traversalFilter.layoutMode === "causal_flow"}
                    onClick={() =>
                      onChangeTraversalFilter({
                        ...traversalFilter,
                        layoutMode:
                          traversalFilter.layoutMode === "causal_flow" ? "force" : "causal_flow",
                      })
                    }
                    className={`inline-flex items-center gap-1 rounded-sm border border-transparent px-2.5 py-1 text-[10px] font-medium text-text-muted hover:text-text-primary cursor-pointer ${
                      isLightTheme
                        ? "aria-pressed:border-amber-600 aria-pressed:bg-amber-100 aria-pressed:text-amber-900"
                        : "aria-pressed:border-amber-400 aria-pressed:bg-amber-950 aria-pressed:text-amber-300"
                    }`}
                  >
                    <Waypoints className="h-3 w-3" aria-hidden="true" />
                    <span>Causal Flow</span>
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {onChangeRegionScope && regionOptions.length > 0 && (
          <>
            <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 border-l border-border" />
            <div role="group" aria-label="Move to region" className="flex items-center gap-1">
              <select
                aria-label="Move to region"
                value={selectedRegionScope ?? ""}
                onChange={(e) => onChangeRegionScope(e.target.value ? e.target.value : null)}
                className="max-w-[180px] rounded-sm border border-border bg-surface-band px-2 py-1 text-[10px] font-medium text-text-primary focus:border-accent-fg focus:outline-none cursor-pointer"
              >
                <option value="">All Regions (Overview)</option>
                {regionOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label} ({opt.count})
                  </option>
                ))}
              </select>
              {selectedRegionScope && (
                <>
                  {onRefocusActiveRegion && (
                    <button
                      type="button"
                      onClick={onRefocusActiveRegion}
                      title="Fly camera back to selected region"
                      className="rounded-sm border border-border bg-surface-band px-1.5 py-1 text-[10px] font-medium text-text-primary hover:bg-surface-hover cursor-pointer"
                    >
                      Fly
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onChangeRegionScope(null)}
                    aria-label="Clear region focus"
                    title="Return to global overview"
                    className="rounded-sm border border-transparent p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary cursor-pointer"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Contextual sub-banner for Connect Mode or Candidate Ghost Links */}
      {connectMode && (
        <div
          className={`etg-hud-pill pointer-events-auto flex items-center gap-2 rounded-md border bg-surface px-3 py-1 text-[11px] shadow ${
            isLightTheme ? "border-amber-600/70 text-amber-900" : "border-amber-400 text-amber-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full animate-pulse ${
              isLightTheme ? "bg-amber-600" : "bg-amber-400"
            }`}
            aria-hidden="true"
          />
          {connectSourceName ? (
            <span>
              From <strong>{connectSourceName}</strong> <ArrowRight className="inline h-3 w-3" /> click any target node
            </span>
          ) : (
            <span>Connect Mode: click any Source node (or Shift+Click two nodes)</span>
          )}
          {onToggleConnectMode && (
            <button
              type="button"
              onClick={onToggleConnectMode}
              aria-label="Exit connect mode"
              className="ml-1 rounded-sm p-0.5 text-text-muted hover:text-text-primary cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {!connectMode && candidateCount > 0 && (
        <div
          className={`etg-hud-pill pointer-events-auto flex items-center gap-2 rounded-md border bg-surface px-3 py-1 text-[11px] shadow ${
            isLightTheme ? "border-violet-600/70 text-violet-900" : "border-violet-400 text-violet-300"
          }`}
        >
          <Sparkles
            className={`h-3 w-3 ${isLightTheme ? "text-violet-700" : "text-violet-400"}`}
            aria-hidden="true"
          />
          <span>
            {candidateCount} latent connection{candidateCount === 1 ? "" : "s"} found
            {selectedNodeName ? ` around ${selectedNodeName}` : ""} — click a dashed violet edge to wire
          </span>
          {onClearCandidateLinks && (
            <button
              type="button"
              onClick={onClearCandidateLinks}
              aria-label="Hide discovered link suggestions"
              className="ml-1 rounded-sm p-0.5 text-text-muted hover:text-text-primary cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
  onOpenQuickAddNode,
  onDiscoverLinks,
  onAcceptCandidateLink,
  onClearCandidateLinks,
  onChangeTraversalFilter,
  onChangeRegionScope,
  onResetOppositeFilter,
}: EarthTrendGraphViewProps) {
  const isLightTheme = useIsLightTheme();
  const [regionFocusNonce, setRegionFocusNonce] = useState(0);
  const { visibleNodes, visibleEdges } = useMemo(
    () =>
      filterEtgGraphData(
        nodes,
        edges,
        onlyOpposite,
        showSuperseded,
        enabledRelationCategories
      ),
    [nodes, edges, onlyOpposite, showSuperseded, enabledRelationCategories]
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
              : "Widen the timeline scrubber, switch datasets, or add a new phenomenon directly."}
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
            {onOpenQuickAddNode && (
              <button
                type="button"
                onClick={onOpenQuickAddNode}
                className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Create Phenomenon Node</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

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
        regionOptions={regionOptions}
        selectedRegionScope={selectedRegionScope}
        onToggleConnectMode={onToggleConnectMode}
        onOpenQuickAddNode={onOpenQuickAddNode}
        onDiscoverLinks={onDiscoverLinks}
        onClearCandidateLinks={onClearCandidateLinks}
        onChangeTraversalFilter={onChangeTraversalFilter}
        onChangeRegionScope={onChangeRegionScope}
        onRefocusActiveRegion={() => setRegionFocusNonce((n) => n + 1)}
      />

      {renderMode === "2d" ? (
        <GraphCanvas2D
          nodes={visibleNodes}
          edges={visibleEdges}
          selectedNodeUuid={selectedNodeUuid}
          selectedEdgeUuid={selectedEdgeUuid}
          cascadeEdgeUuids={cascadeEdgeUuids}
          searchQuery={normalizedQuery}
          isLightTheme={isLightTheme}
          candidateLinks={candidateLinks}
          traversalFilter={traversalFilter}
          roleByNode={roleByNode}
          hopByNode={hopByNode}
          microscopeByNode={microscopeByNode}
          connectMode={connectMode}
          connectSourceUuid={connectSourceUuid}
          selectedRegionScope={selectedRegionScope}
          regionSpotlight={regionSpotlight}
          regionFocusNonce={regionFocusNonce}
          onChangeRegionScope={onChangeRegionScope}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
          onClearSelection={onClearSelection}
          onStartQuickConnect={onStartQuickConnect}
          onAcceptCandidateLink={onAcceptCandidateLink}
        />
      ) : (
        <GraphCanvas3D
          nodes={visibleNodes}
          edges={visibleEdges}
          selectedNodeUuid={selectedNodeUuid}
          selectedEdgeUuid={selectedEdgeUuid}
          cascadeEdgeUuids={cascadeEdgeUuids}
          searchQuery={normalizedQuery}
          isLightTheme={isLightTheme}
          inspectorOpen={inspectorOpen}
          candidateLinks={candidateLinks}
          traversalFilter={traversalFilter}
          roleByNode={roleByNode}
          hopByNode={hopByNode}
          microscopeByNode={microscopeByNode}
          connectMode={connectMode}
          connectSourceUuid={connectSourceUuid}
          selectedRegionScope={selectedRegionScope}
          regionSpotlight={regionSpotlight}
          regionFocusNonce={regionFocusNonce}
          onChangeRegionScope={onChangeRegionScope}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
          onClearSelection={onClearSelection}
          onStartQuickConnect={onStartQuickConnect}
          onAcceptCandidateLink={onAcceptCandidateLink}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* 3D WebGL Sprite + Depth-Attenuated Knowledge Graph                          */
/* ─────────────────────────────────────────────────────────────────────────── */

interface GraphCanvasProps {
  nodes: ETGNode[];
  edges: ETGEdge[];
  selectedNodeUuid: string | null;
  selectedEdgeUuid: string | null;
  cascadeEdgeUuids: string[];
  searchQuery: string;
  isLightTheme: boolean;
  inspectorOpen?: boolean;
  candidateLinks?: CandidateLinkSuggestion[];
  traversalFilter?: TraversalFilterState;
  roleByNode?: Record<string, SubgraphNodeRole>;
  hopByNode?: Record<string, number>;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  connectMode?: boolean;
  connectSourceUuid?: string | null;
  selectedRegionScope?: string | null;
  regionSpotlight?: RegionSpotlightState | null;
  regionFocusNonce?: number;
  onChangeRegionScope?: (regionId: string | null) => void;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onClearSelection?: () => void;
  onStartQuickConnect?: (sourceNode: ETGNode, targetNode?: ETGNode) => void;
  onAcceptCandidateLink?: (suggestion: CandidateLinkSuggestion) => void;
}

const DEFAULT_ORBIT_3D = { pitch: 0.34, yaw: 0.52, radius: 225 };

function GraphCanvas3D({
  nodes,
  edges,
  selectedNodeUuid,
  selectedEdgeUuid,
  cascadeEdgeUuids,
  searchQuery,
  isLightTheme,
  inspectorOpen = false,
  candidateLinks = [],
  roleByNode = {},
  microscopeByNode = {},
  connectMode = false,
  connectSourceUuid = null,
  selectedRegionScope = null,
  regionSpotlight = null,
  regionFocusNonce = 0,
  onChangeRegionScope,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onStartQuickConnect,
  onAcceptCandidateLink,
}: GraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const labelElsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const regionLabelElsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const hoveredUuidRef = useRef<string | null>(null);
  const hoveredEdgeUuidRef = useRef<string | null>(null);
  const [hoveredUuid, setHoveredUuid] = useState<string | null>(null);
  const [hoveredEdgeUuid, setHoveredEdgeUuid] = useState<string | null>(null);
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [isOrbiting, setIsOrbiting] = useState(!prefersReducedMotion);
  const isOrbitingRef = useRef(!prefersReducedMotion);
  isOrbitingRef.current = isOrbiting;
  const inspectorOpenRef = useRef(inspectorOpen);
  inspectorOpenRef.current = inspectorOpen;

  const rotationRef = useRef({
    pitch: DEFAULT_ORBIT_3D.pitch,
    yaw: DEFAULT_ORBIT_3D.yaw,
    targetPitch: DEFAULT_ORBIT_3D.pitch,
    targetYaw: DEFAULT_ORBIT_3D.yaw,
  });
  const rotVelocityRef = useRef({ pitch: 0, yaw: 0 });
  const orbitRadiusRef = useRef({ val: DEFAULT_ORBIT_3D.radius, target: DEFAULT_ORBIT_3D.radius });
  const panTargetRef = useRef({ x: 0, y: 0, z: 0, targetX: 0, targetY: 0, targetZ: 0 });
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cameraPositionRef = useRef(new THREE.Vector3(0, 0, DEFAULT_ORBIT_3D.radius));
  const currentLookAtRef = useRef(new THREE.Vector3(0, 0, 0));
  const freeFlightRef = useRef(false);
  const cameraGlideRef = useRef<{
    active: boolean;
    startTime: number;
    durationMs: number;
    startCentre: THREE.Vector3;
    targetCentre: THREE.Vector3;
    startLookAt: THREE.Vector3;
    startRadius: number;
    targetRadius: number;
  }>({
    active: false,
    startTime: 0,
    durationMs: 520,
    startCentre: new THREE.Vector3(),
    targetCentre: new THREE.Vector3(),
    startLookAt: new THREE.Vector3(),
    startRadius: DEFAULT_ORBIT_3D.radius,
    targetRadius: DEFAULT_ORBIT_3D.radius,
  });
  const startCameraGlideRef = useRef<
    ((targetCentre: THREE.Vector3, options?: { durationMs?: number; targetRadius?: number }) => void) | null
  >(null);

  const layoutPositions = useMemo(() => computeLayout3D(nodes, edges), [nodes, edges]);
  const overviewFraming = useMemo(() => {
    const sphere = computeGraphBoundingSphere3D(layoutPositions);
    return {
      target: sphere.center,
      radius: Math.max(195, Math.min(820, sphere.radius * 2.35)),
    };
  }, [layoutPositions]);
  const overviewFramingRef = useRef(overviewFraming);
  overviewFramingRef.current = overviewFraming;

  const hasFramedInitial3DRef = useRef(false);
  useEffect(() => {
    if (hasFramedInitial3DRef.current || layoutPositions.size === 0) return;
    hasFramedInitial3DRef.current = true;
    const { target, radius } = overviewFraming;
    panTargetRef.current = {
      x: target.x,
      y: target.y,
      z: target.z,
      targetX: target.x,
      targetY: target.y,
      targetZ: target.z,
    };
    orbitRadiusRef.current = { val: radius, target: radius };
  }, [layoutPositions, overviewFraming]);

  const regionClusters = useMemo(
    () => computeRegionClusters3D(nodes, layoutPositions),
    [nodes, layoutPositions]
  );
  const regionClustersRef = useRef<RegionCluster3D[]>(regionClusters);
  regionClustersRef.current = regionClusters;
  const selectedRegionScopeRef = useRef<string | null>(selectedRegionScope);
  selectedRegionScopeRef.current = selectedRegionScope;
  const regionSpotlightRef = useRef<RegionSpotlightState | null>(regionSpotlight);
  regionSpotlightRef.current = regionSpotlight;

  const flyToRegionCluster = useCallback(
    (cluster: RegionCluster3D) => {
      if (!startCameraGlideRef.current) return;
      freeFlightRef.current = false;
      const targetRadius = Math.max(95, Math.min(240, cluster.radius * 2.25 + 68));
      startCameraGlideRef.current(
        new THREE.Vector3(cluster.centroid.x, cluster.centroid.y, cluster.centroid.z),
        { durationMs: prefersReducedMotion ? 0 : 620, targetRadius }
      );
    },
    [prefersReducedMotion]
  );

  // Fly camera to selected region when region dropdown changes or user clicks "Fly"
  const prevRegionScopeRef = useRef<string | null>(null);
  const prevRegionFocusNonceRef = useRef<number>(regionFocusNonce);
  useEffect(() => {
    if (
      selectedRegionScope === prevRegionScopeRef.current &&
      regionFocusNonce === prevRegionFocusNonceRef.current
    ) {
      return;
    }
    prevRegionScopeRef.current = selectedRegionScope;
    prevRegionFocusNonceRef.current = regionFocusNonce;
    if (!selectedRegionScope) {
      if (startCameraGlideRef.current) {
        freeFlightRef.current = false;
        const { target, radius } = overviewFramingRef.current;
        startCameraGlideRef.current(new THREE.Vector3(target.x, target.y, target.z), {
          durationMs: prefersReducedMotion ? 0 : 600,
          targetRadius: radius,
        });
      }
      return;
    }
    const targetCluster = regionClusters.find((c) => c.id === selectedRegionScope);
    if (targetCluster) {
      flyToRegionCluster(targetCluster);
    }
  }, [selectedRegionScope, regionFocusNonce, regionClusters, flyToRegionCluster, prefersReducedMotion]);

  // Smoothly glide camera to focus on selected node (Blueprint-style zero-snap LookAt transition)
  const prevSelectedForGlideRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedNodeUuid && selectedNodeUuid !== prevSelectedForGlideRef.current) {
      const pos = layoutPositions.get(selectedNodeUuid);
      if (pos && startCameraGlideRef.current) {
        freeFlightRef.current = false;
        const targetDist = computeTargetOrbitDistance(orbitRadiusRef.current.val, 85, 165);
        startCameraGlideRef.current(new THREE.Vector3(pos.x, pos.y, pos.z), {
          durationMs: prefersReducedMotion ? 0 : 520,
          targetRadius: targetDist,
        });
      }
    }
    prevSelectedForGlideRef.current = selectedNodeUuid;
  }, [selectedNodeUuid, layoutPositions, prefersReducedMotion]);

  const nodeById = useMemo(() => {
    const map = new Map<string, ETGNode>();
    for (const n of nodes) map.set(n.uuid, n);
    return map;
  }, [nodes]);

  const neighborMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const n of nodes) map.set(n.uuid, new Set());
    for (const e of edges) {
      map.get(e.source_uuid)?.add(e.target_uuid);
      map.get(e.target_uuid)?.add(e.source_uuid);
    }
    return map;
  }, [nodes, edges]);

  const matchingUuids = useMemo(() => {
    if (!searchQuery) return new Set<string>();
    const hits = new Set<string>();
    for (const n of nodes) {
      const text = `${n.properties.name} ${n.label} ${n.properties.region ?? ""} ${n.properties.dataset ?? ""} ${(n.properties.domain_tags ?? []).join(" ")}`.toLowerCase();
      if (text.includes(searchQuery)) hits.add(n.uuid);
    }
    return hits;
  }, [nodes, searchQuery]);

  const cascadeEdgeSet = useMemo(() => new Set(cascadeEdgeUuids), [cascadeEdgeUuids]);
  const dipoleNodeUuids = useMemo(() => {
    const set = new Set<string>();
    for (const e of edges) {
      if (e.type === "drives_opposite") {
        set.add(e.source_uuid);
        set.add(e.target_uuid);
      }
    }
    return set;
  }, [edges]);

  // Refreshed state refs so Three.js RAF never uses stale closures
  const focusStateRef = useRef({
    selectedNodeUuid,
    selectedEdgeUuid,
    cascadeEdgeSet,
    hoveredUuid,
    hoveredEdgeUuid,
    matchingUuids,
    neighborMap,
    nodeById,
    isLightTheme,
    connectMode,
    connectSourceUuid,
    roleByNode,
    microscopeByNode,
    dipoleNodeUuids,
  });
  focusStateRef.current = {
    selectedNodeUuid,
    selectedEdgeUuid,
    cascadeEdgeSet,
    hoveredUuid,
    hoveredEdgeUuid,
    matchingUuids,
    neighborMap,
    nodeById,
    isLightTheme,
    connectMode,
    connectSourceUuid,
    roleByNode,
    microscopeByNode,
    dipoleNodeUuids,
  };

  const prefersReducedMotionRef = useRef(prefersReducedMotion);
  prefersReducedMotionRef.current = prefersReducedMotion;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const onClearSelectionRef = useRef(onClearSelection);
  onClearSelectionRef.current = onClearSelection;
  const onChangeRegionScopeRef = useRef(onChangeRegionScope);
  onChangeRegionScopeRef.current = onChangeRegionScope;
  const onSelectEdgeRef = useRef(onSelectEdge);
  onSelectEdgeRef.current = onSelectEdge;
  const onStartQuickConnectRef = useRef(onStartQuickConnect);
  onStartQuickConnectRef.current = onStartQuickConnect;

  interface SceneNodeObject3D {
    node: ETGNode;
    sprite: THREE.Sprite;
    halo: THREE.Sprite;
    baseScale: number;
    worldPos: THREE.Vector3;
  }
  interface SceneEdgeObject3D {
    edge: ETGEdge;
    line: THREE.Line;
    material: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
    baseColorHex: string;
    midPoint: THREE.Vector3;
  }

  const graphGroupRef = useRef<THREE.Group | null>(null);
  const starMatRef = useRef<THREE.PointsMaterial | null>(null);
  const dustPointsRef = useRef<THREE.Points | null>(null);
  const nodeObjectsRef = useRef<SceneNodeObject3D[]>([]);
  const edgeObjectsRef = useRef<SceneEdgeObject3D[]>([]);
  const pickSpritesRef = useRef<THREE.Sprite[]>([]);
  const edgePickLinesRef = useRef<THREE.Line[]>([]);

  // Effect A: Persistent WebGLRenderer, scene, camera controls & RAF loop
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const width = host.clientWidth || 960;
    const height = host.clientHeight || 640;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(44, width / height, 1, 4500);
    cameraRef.current = camera;

    const initCamPos = computeOrbitCameraPosition(
      new THREE.Vector3(panTargetRef.current.x, panTargetRef.current.y, panTargetRef.current.z),
      orbitRadiusRef.current.val,
      rotationRef.current.pitch,
      rotationRef.current.yaw
    );
    camera.position.set(initCamPos.x, initCamPos.y, initCamPos.z);
    cameraPositionRef.current.copy(camera.position);
    camera.lookAt(panTargetRef.current.x, panTargetRef.current.y, panTargetRef.current.z);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    // Subtle spatial depth dust particles (low opacity so sprites stand out)
    const starCount = 140;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 180 + ((i * 73) % 190);
      const a = i * 2.39996;
      const b = ((i % 29) / 29 - 0.5) * Math.PI;
      starPositions[i * 3] = Math.cos(a) * Math.cos(b) * r;
      starPositions[i * 3 + 1] = Math.sin(b) * r * 0.8;
      starPositions[i * 3 + 2] = Math.sin(a) * Math.cos(b) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: focusStateRef.current.isLightTheme ? 0x64748b : 0x94a3b8,
      size: 1.4,
      transparent: true,
      opacity: focusStateRef.current.isLightTheme ? 0.2 : 0.24,
      depthWrite: false,
    });
    const dustPoints = new THREE.Points(starGeo, starMat);
    scene.add(dustPoints);
    starMatRef.current = starMat;
    dustPointsRef.current = dustPoints;

    const graphGroup = new THREE.Group();
    scene.add(graphGroup);
    graphGroupRef.current = graphGroup;

    // Zero-snap continuous camera glide initializer
    startCameraGlideRef.current = (
      targetCentre: THREE.Vector3,
      options?: { durationMs?: number; targetRadius?: number }
    ) => {
      const forward = new THREE.Vector3(0, 0, -1);
      if (cameraRef.current) {
        cameraRef.current.getWorldDirection(forward);
      }
      const camPos = cameraPositionRef.current;
      const startLookAt = computeInitialContinuousLookAt(camPos, forward, targetCentre);
      const spherical = computeOrbitSphericalCoordinates(camPos, targetCentre);

      rotationRef.current.pitch = spherical.pitch;
      rotationRef.current.targetPitch = spherical.pitch;
      rotationRef.current.yaw = spherical.yaw;
      rotationRef.current.targetYaw = spherical.yaw;
      rotVelocityRef.current = { pitch: 0, yaw: 0 };

      const targetRadius = options?.targetRadius ?? spherical.dist;
      orbitRadiusRef.current.val = spherical.dist;
      orbitRadiusRef.current.target = targetRadius;

      const startCentre = new THREE.Vector3(
        panTargetRef.current.x,
        panTargetRef.current.y,
        panTargetRef.current.z
      );

      cameraGlideRef.current = {
        active: true,
        startTime: performance.now(),
        durationMs: options?.durationMs ?? 520,
        startCentre,
        targetCentre: targetCentre.clone(),
        startLookAt: new THREE.Vector3(startLookAt.x, startLookAt.y, startLookAt.z),
        startRadius: spherical.dist,
        targetRadius,
      };
    };

    // Interaction: pointer orbit, right/middle/shift pan, WASD free-flight, click pick
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 3.6 };
    const pointerNdc = new THREE.Vector2();
    let isDragging = false;
    let isPanning = false;
    let pointerDownPos = { x: 0, y: 0 };
    let prevPointerPos = { x: 0, y: 0 };
    let draggedDistance = 0;
    const keysPressed = { w: false, a: false, s: false, d: false, shift: false };

    const updateNdc = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    };

    const pickTargetAt = (
      clientX: number,
      clientY: number
    ): { nodeUuid: string | null; edge: ETGEdge | null } => {
      updateNdc(clientX, clientY);
      raycaster.setFromCamera(pointerNdc, camera);
      const nodeHits = raycaster.intersectObjects(pickSpritesRef.current, false);
      if (nodeHits.length > 0) {
        return {
          nodeUuid: (nodeHits[0].object.userData?.uuid as string | undefined) ?? null,
          edge: null,
        };
      }
      const edgeHits = raycaster.intersectObjects(edgePickLinesRef.current, false);
      if (edgeHits.length > 0) {
        return {
          nodeUuid: null,
          edge: (edgeHits[0].object.userData?.edge as ETGEdge | undefined) ?? null,
        };
      }
      return { nodeUuid: null, edge: null };
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const activePointers = new Map<number, { x: number; y: number }>();
    let prevPinchDist: number | null = null;
    let prevPinchMid: { x: number; y: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        prevPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        prevPinchMid = { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 };
        isDragging = false;
        isPanning = false;
        return;
      }
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      isDragging = true;
      isPanning = e.button === 2 || e.button === 1 || e.shiftKey;
      draggedDistance = 0;
      pointerDownPos = { x: e.clientX, y: e.clientY };
      prevPointerPos = { x: e.clientX, y: e.clientY };
      rotVelocityRef.current = { pitch: 0, yaw: 0 };
      renderer.domElement.style.cursor = "grabbing";
    };

    const onPointerMove = (e: PointerEvent) => {
      if (activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const mid = { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 };
        if (prevPinchDist !== null && prevPinchDist > 4) {
          const zoomDelta = (prevPinchDist - dist) * 0.75;
          orbitRadiusRef.current.target = Math.max(
            42,
            Math.min(1100, orbitRadiusRef.current.target + zoomDelta)
          );
          if (cameraGlideRef.current.active) {
            cameraGlideRef.current.targetRadius = orbitRadiusRef.current.target;
          }
        }
        if (prevPinchMid) {
          cameraGlideRef.current.active = false;
          freeFlightRef.current = false;
          const delta = computeCameraPanDelta(
            mid.x - prevPinchMid.x,
            mid.y - prevPinchMid.y,
            rotationRef.current.targetPitch,
            rotationRef.current.targetYaw,
            orbitRadiusRef.current.val
          );
          panTargetRef.current.targetX += delta.x;
          panTargetRef.current.targetY += delta.y;
          panTargetRef.current.targetZ += delta.z;
        }
        prevPinchDist = dist;
        prevPinchMid = mid;
        return;
      }
      if (isDragging) {
        const dx = e.clientX - prevPointerPos.x;
        const dy = e.clientY - prevPointerPos.y;
        draggedDistance += Math.hypot(dx, dy);
        prevPointerPos = { x: e.clientX, y: e.clientY };

        if (isPanning) {
          cameraGlideRef.current.active = false;
          freeFlightRef.current = false;
          const delta = computeCameraPanDelta(
            dx,
            dy,
            rotationRef.current.targetPitch,
            rotationRef.current.targetYaw,
            orbitRadiusRef.current.val
          );
          panTargetRef.current.targetX += delta.x;
          panTargetRef.current.targetY += delta.y;
          panTargetRef.current.targetZ += delta.z;
        } else {
          const targetYawDelta = -dx * 0.0052;
          const targetPitchDelta = dy * 0.0052;
          rotVelocityRef.current.pitch = rotVelocityRef.current.pitch * 0.35 + targetPitchDelta * 0.65;
          rotVelocityRef.current.yaw = rotVelocityRef.current.yaw * 0.35 + targetYawDelta * 0.65;
          rotationRef.current.targetPitch = Math.max(
            -Math.PI / 2.1,
            Math.min(Math.PI / 2.1, rotationRef.current.targetPitch + rotVelocityRef.current.pitch)
          );
          rotationRef.current.targetYaw += rotVelocityRef.current.yaw;
        }
        return;
      }

      const { nodeUuid: hitUuid, edge: hitEdge } = pickTargetAt(e.clientX, e.clientY);
      const nextEdgeUuid = hitEdge ? hitEdge.properties.uuid : null;
      if (hitUuid !== hoveredUuidRef.current || nextEdgeUuid !== hoveredEdgeUuidRef.current) {
        hoveredUuidRef.current = hitUuid;
        hoveredEdgeUuidRef.current = nextEdgeUuid;
        setHoveredUuid(hitUuid);
        setHoveredEdgeUuid(nextEdgeUuid);
        renderer.domElement.style.cursor = hitUuid || nextEdgeUuid ? "pointer" : "grab";
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        prevPinchDist = null;
        prevPinchMid = null;
      }
      if (e.type === "pointercancel") {
        isDragging = false;
        isPanning = false;
        renderer.domElement.style.cursor =
          hoveredUuidRef.current || hoveredEdgeUuidRef.current ? "pointer" : "grab";
        return;
      }
      if (!isDragging) return;
      isDragging = false;
      isPanning = false;
      renderer.domElement.style.cursor =
        hoveredUuidRef.current || hoveredEdgeUuidRef.current ? "pointer" : "grab";
      const totalMove = Math.hypot(
        e.clientX - pointerDownPos.x,
        e.clientY - pointerDownPos.y
      );
      if (draggedDistance < 6 && totalMove < 6 && e.button === 0) {
        const { nodeUuid: hitUuid, edge: hitEdge } = pickTargetAt(e.clientX, e.clientY);
        if (hitUuid) {
          const found = focusStateRef.current.nodeById.get(hitUuid);
          if (found) {
            const {
              connectMode: isConnecting,
              connectSourceUuid: srcId,
              selectedNodeUuid: selId,
            } = focusStateRef.current;
            if ((isConnecting || e.shiftKey) && onStartQuickConnectRef.current) {
              if (srcId && srcId !== found.uuid) {
                const srcNode = focusStateRef.current.nodeById.get(srcId);
                if (srcNode) onStartQuickConnectRef.current(srcNode, found);
              } else if (e.shiftKey && selId && selId !== found.uuid) {
                const srcNode = focusStateRef.current.nodeById.get(selId);
                if (srcNode) onStartQuickConnectRef.current(srcNode, found);
              } else {
                onStartQuickConnectRef.current(found);
              }
            } else {
              onSelectNodeRef.current(found);
            }
          }
        } else if (hitEdge && onSelectEdgeRef.current) {
          onSelectEdgeRef.current(hitEdge);
        } else {
          onClearSelectionRef.current?.();
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (freeFlightRef.current) {
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        cameraPositionRef.current.addScaledVector(forward, -e.deltaY * 0.28);
        return;
      }
      orbitRadiusRef.current.target = Math.max(
        42,
        Math.min(1100, orbitRadiusRef.current.target + e.deltaY * 0.24)
      );
      if (cameraGlideRef.current.active) {
        cameraGlideRef.current.targetRadius = orbitRadiusRef.current.target;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        onClearSelectionRef.current?.();
        onChangeRegionScopeRef.current?.(null);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "r" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        freeFlightRef.current = false;
        rotationRef.current.targetPitch = DEFAULT_ORBIT_3D.pitch;
        rotationRef.current.targetYaw = DEFAULT_ORBIT_3D.yaw;
        rotVelocityRef.current = { pitch: 0, yaw: 0 };
        const { target: c, radius } = overviewFramingRef.current;
        if (startCameraGlideRef.current) {
          startCameraGlideRef.current(new THREE.Vector3(c.x, c.y, c.z), {
            durationMs: prefersReducedMotionRef.current ? 0 : 560,
            targetRadius: radius,
          });
        }
        return;
      }
      if (k === "w") keysPressed.w = true;
      if (k === "a") keysPressed.a = true;
      if (k === "s") keysPressed.s = true;
      if (k === "d") keysPressed.d = true;
      if (e.key === "Shift") keysPressed.shift = true;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w") keysPressed.w = false;
      if (k === "a") keysPressed.a = false;
      if (k === "s") keysPressed.s = false;
      if (k === "d") keysPressed.d = false;
      if (e.key === "Shift") keysPressed.shift = false;
    };

    renderer.domElement.style.cursor = "grab";
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const resizeObserver = new ResizeObserver(() => {
      const w = host.clientWidth || 960;
      const h = host.clientHeight || 640;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(host);

    // Animation loop (delta-time normalized Blueprint-style camera choreography)
    let rafId = 0;
    let currentViewOffsetX = 0;
    let lastFrameTime = performance.now();
    const projVec = new THREE.Vector3();
    const glideCentreScratch = new THREE.Vector3();

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const now = performance.now();
      const delta = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) * 0.001));
      lastFrameTime = now;

      // Subtle volumetric drift of background cosmic star dust
      dustPoints.rotation.y += delta * 0.012;
      dustPoints.rotation.x += delta * 0.006;

      // Rotational inertia decay when drag is released
      if (!isDragging) {
        const vel = rotVelocityRef.current;
        if (Math.abs(vel.pitch) > 0.00001 || Math.abs(vel.yaw) > 0.00001) {
          vel.pitch *= 0.88;
          vel.yaw *= 0.88;
          rotationRef.current.targetPitch = Math.max(
            -Math.PI / 2.1,
            Math.min(Math.PI / 2.1, rotationRef.current.targetPitch + vel.pitch)
          );
          rotationRef.current.targetYaw += vel.yaw;
        }
      }

      // Gentle auto-orbit when active and not dragging/gliding/free-flying
      if (isOrbitingRef.current && !isDragging && !freeFlightRef.current) {
        rotationRef.current.targetYaw += delta * 0.065;
      }

      // Delta-time smooth rotation dampening
      const rot = rotationRef.current;
      const rotRate = isDragging ? 16.0 : 8.5;
      const rotLerp = Math.min(0.5, 1.0 - Math.exp(-rotRate * delta));
      rot.pitch += (rot.targetPitch - rot.pitch) * rotLerp;
      rot.yaw += (rot.targetYaw - rot.yaw) * rotLerp;

      const lerpFactor = isDragging ? 0.55 : Math.min(0.35, 1.0 - Math.exp(-9.0 * delta));
      const rad = orbitRadiusRef.current;
      rad.val += (rad.target - rad.val) * lerpFactor;

      const pan = panTargetRef.current;
      pan.x += (pan.targetX - pan.x) * lerpFactor;
      pan.y += (pan.targetY - pan.y) * lerpFactor;
      pan.z += (pan.targetZ - pan.z) * lerpFactor;

      const w = renderer.domElement.clientWidth || 960;
      const h = renderer.domElement.clientHeight || 640;

      const targetOffsetX =
        inspectorOpenRef.current && w >= 1024
          ? Math.round(Math.min(368, w * 0.30) * 0.34)
          : 0;
      currentViewOffsetX += (targetOffsetX - currentViewOffsetX) * 0.12;
      if (Math.abs(currentViewOffsetX) > 0.5) {
        camera.setViewOffset(w, h, Math.round(currentViewOffsetX), 0, w, h);
      } else if (camera.view) {
        camera.clearViewOffset();
      }

      // WASD free-flight traversal
      if (keysPressed.w || keysPressed.s || keysPressed.a || keysPressed.d) {
        cameraGlideRef.current.active = false;
        freeFlightRef.current = true;
        const moveSpeed = (keysPressed.shift ? 210 : 105) * delta;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
        if (keysPressed.w) cameraPositionRef.current.addScaledVector(forward, moveSpeed);
        if (keysPressed.s) cameraPositionRef.current.addScaledVector(forward, -moveSpeed);
        if (keysPressed.d) cameraPositionRef.current.addScaledVector(right, moveSpeed);
        if (keysPressed.a) cameraPositionRef.current.addScaledVector(right, -moveSpeed);
      }

      const glide = cameraGlideRef.current;
      if (glide.active) {
        const glideProgressRaw =
          glide.durationMs <= 0 ? 1 : (now - glide.startTime) / glide.durationMs;
        const progress = Math.max(0, Math.min(1, glideProgressRaw));
        const ease = computeGlideEase(progress);

        const activeRadius = THREE.MathUtils.lerp(glide.startRadius, glide.targetRadius, ease);
        rad.val = activeRadius;

        const shotCentre = glideCentreScratch.lerpVectors(glide.startCentre, glide.targetCentre, ease);
        pan.x = shotCentre.x;
        pan.y = shotCentre.y;
        pan.z = shotCentre.z;
        pan.targetX = glide.targetCentre.x;
        pan.targetY = glide.targetCentre.y;
        pan.targetZ = glide.targetCentre.z;

        const orbitPos = computeOrbitCameraPosition(shotCentre, activeRadius, rot.pitch, rot.yaw);
        cameraPositionRef.current.set(orbitPos.x, orbitPos.y, orbitPos.z);
        currentLookAtRef.current.lerpVectors(glide.startLookAt, shotCentre, ease);

        camera.position.copy(cameraPositionRef.current);
        camera.lookAt(currentLookAtRef.current);

        if (progress >= 1) {
          glide.active = false;
        }
      } else if (freeFlightRef.current) {
        const cosPitch = Math.cos(rot.pitch);
        const fx = -Math.sin(rot.yaw) * cosPitch;
        const fy = -Math.sin(rot.pitch);
        const fz = -Math.cos(rot.yaw) * cosPitch;
        camera.position.copy(cameraPositionRef.current);
        currentLookAtRef.current.set(
          cameraPositionRef.current.x + fx * 100,
          cameraPositionRef.current.y + fy * 100,
          cameraPositionRef.current.z + fz * 100
        );
        camera.lookAt(currentLookAtRef.current);
      } else {
        const orbitPos = computeOrbitCameraPosition(
          { x: pan.x, y: pan.y, z: pan.z },
          rad.val,
          rot.pitch,
          rot.yaw
        );
        cameraPositionRef.current.set(orbitPos.x, orbitPos.y, orbitPos.z);
        currentLookAtRef.current.set(pan.x, pan.y, pan.z);
        camera.position.copy(cameraPositionRef.current);
        camera.lookAt(currentLookAtRef.current);
      }

      const {
        selectedNodeUuid: selUuid,
        selectedEdgeUuid: selEdgeUuid,
        cascadeEdgeSet: cascSet,
        hoveredUuid: hovUuid,
        hoveredEdgeUuid: hovEdgeUuid,
        matchingUuids: matchSet,
        neighborMap: nbrMap,
        isLightTheme: lightThemeNow,
        roleByNode: rolesMap,
        microscopeByNode: microMap,
        dipoleNodeUuids: dipoleSet,
      } = focusStateRef.current;

      const hasEdgeOrCascadeFocus = selEdgeUuid !== null || cascSet.size > 0;

      const activeFocusUuid = hovUuid ?? selUuid;
      const activeNeighbors = activeFocusUuid ? nbrMap.get(activeFocusUuid) ?? new Set<string>() : null;
      const hasSearchFilter = matchSet.size > 0;

      // Update nodes + gather screen-space label candidates
      const currentNodes = nodeObjectsRef.current;
      const currentEdges = edgeObjectsRef.current;
      const labelCandidates: ScreenLabelCandidate[] = [];
      const leftLabelEdge = 82;
      const topLabelEdge = 92;
      const rightLabelEdge =
        inspectorOpenRef.current && w >= 1024 ? w - 400 : w - 60;

      let minCamDist = Infinity;
      let maxCamDist = 1;
      for (const item of currentNodes) {
        const d = camera.position.distanceTo(item.worldPos);
        if (d < minCamDist) minCamDist = d;
        if (d > maxCamDist) maxCamDist = d;
      }
      if (minCamDist === Infinity) {
        minCamDist = 0;
        maxCamDist = 1;
      }
      const distSpan = Math.max(1, maxCamDist - minCamDist);

      const spotlight = regionSpotlightRef.current;

      for (const item of currentNodes) {
        const uuid = item.node.uuid;
        const isSelected = uuid === selUuid;
        const isHovered = uuid === hovUuid;
        const isNeighbor = activeNeighbors ? activeNeighbors.has(uuid) : false;
        const isSearchHit = matchSet.has(uuid);
        const isRegionLocal = spotlight ? spotlight.localNodeSet.has(uuid) : false;
        const isRegionBridge = spotlight ? spotlight.bridgeNodeSet.has(uuid) : false;

        let opacity = 1;
        if (hasSearchFilter) {
          opacity = isSearchHit ? 1 : 0.18;
        } else if (activeFocusUuid) {
          opacity = isSelected || isHovered || isNeighbor ? 1 : 0.24;
        } else if (spotlight) {
          opacity = isRegionLocal ? 1 : isRegionBridge ? 0.86 : 0.16;
        } else {
          const depthRatio = (camera.position.distanceTo(item.worldPos) - minCamDist) / distSpan;
          opacity = 1 - depthRatio * 0.38;
        }

        const spriteMat = item.sprite.material as THREE.SpriteMaterial;
        spriteMat.opacity = opacity;

        const scaleBoost = isSelected || isHovered ? 1.28 : isSearchHit ? 1.2 : 1;
        const s = item.baseScale * scaleBoost;
        item.sprite.scale.set(s, s, 1);

        const haloMat = item.halo.material as THREE.SpriteMaterial;
        haloMat.opacity =
          isSelected || isHovered
            ? 0.92
            : isSearchHit
              ? 0.65
              : isNeighbor
                ? 0.35
                : spotlight && isRegionLocal
                  ? 0.22
                  : spotlight && isRegionBridge
                    ? 0.14
                    : 0;

        // Project 3D position + sprite radius upward into screen space
        projVec.copy(item.worldPos).project(camera);
        if (projVec.z < 1 && opacity > 0.3) {
          const sx = (projVec.x * 0.5 + 0.5) * w;
          const sy = (-projVec.y * 0.5 + 0.5) * h - 18;
          if (sx > leftLabelEdge && sx < rightLabelEdge && sy > topLabelEdge && sy < h - 42) {
            const depthRatio = (camera.position.distanceTo(item.worldPos) - minCamDist) / distSpan;
            const cleanTitle = humanizeNodeText(item.node.properties.name);
            const displayTitle =
              cleanTitle.length > 32 ? `${cleanTitle.slice(0, 30)}…` : cleanTitle;
            const nodeRole = rolesMap[uuid];
            const microCue = microMap[uuid];
            const isSupersededNode =
              item.node.properties.status === "Superseded" ||
              Boolean(item.node.properties.superseded_by);
            const microBadge = resolveMicroscopeNodeBadge(microCue, lightThemeNow);

            let extraWidthPx = 0;
            if (nodeRole === "upstream" || nodeRole === "downstream") extraWidthPx += 44;
            if (isSupersededNode) extraWidthPx += 62;
            if (microBadge) extraWidthPx += 50;
            if (item.node.properties.theil_sen_slope !== undefined) extraWidthPx += 14;

            let priority = (1 - depthRatio) * 120;
            if (item.node.label === "Insight") priority += 120;
            else if (item.node.label === "Concept") priority += 80;
            else if (item.node.label === "Rule") priority += 40;
            if (dipoleSet.has(uuid)) priority += 55;
            if (microBadge) priority += 65;
            if (isSupersededNode) priority -= 35;
            if (isRegionLocal) priority += 180;
            else if (isRegionBridge) priority += 95;
            if (isNeighbor) priority += 260;
            if (isSearchHit) priority += 450;
            if (isHovered) priority += 800;
            if (isSelected) priority += 1000;

            labelCandidates.push({
              uuid,
              title: displayTitle,
              label: item.node.label,
              color: resolveEtgNodeColor(item.node),
              x: sx,
              y: sy,
              priority,
              extraWidthPx,
            });
          }
        }
      }

      // 8-tier depth attenuation & neighborhood/edge/cascade emphasis for edges
      for (const eo of currentEdges) {
        const edgeUuid = eo.edge.properties.uuid;
        const isEdgeSelected = edgeUuid === selEdgeUuid || edgeUuid === hovEdgeUuid;
        const isCascade = cascSet.has(edgeUuid);
        const isConnected =
          activeFocusUuid !== null &&
          (eo.edge.source_uuid === activeFocusUuid || eo.edge.target_uuid === activeFocusUuid);
        const edgeMatchesSearch =
          hasSearchFilter &&
          (matchSet.has(eo.edge.source_uuid) || matchSet.has(eo.edge.target_uuid));
        const isOpposite = eo.edge.type === "drives_opposite";
        const isSupersedes = eo.edge.type === "supersedes";

        eo.material.color.set(
          isEdgeSelected ? "#fef08a" : isCascade ? "#fbbf24" : eo.baseColorHex
        );

        if (isEdgeSelected || isCascade) {
          eo.material.opacity = 0.98;
        } else if (activeFocusUuid) {
          eo.material.opacity = isConnected ? (isOpposite ? 0.95 : 0.88) : 0.07;
        } else if (hasEdgeOrCascadeFocus) {
          eo.material.opacity = 0.08;
        } else if (hasSearchFilter) {
          eo.material.opacity = edgeMatchesSearch ? 0.78 : 0.06;
        } else if (spotlight) {
          eo.material.opacity = spotlight.spotlightEdgeSet.has(edgeUuid)
            ? isOpposite || eo.edge.type === "teleconnects"
              ? 0.9
              : 0.7
            : 0.05;
        } else {
          const d = (camera.position.distanceTo(eo.midPoint) - minCamDist) / distSpan;
          const tier = Math.min(7, Math.max(0, Math.floor(d * 8)));
          const baseOpacity = 0.28 - tier * 0.028;
          const typeBoost = isOpposite
            ? 0.26
            : eo.edge.type === "teleconnects"
              ? 0.16
              : isSupersedes
                ? 0.1
                : 0;
          eo.material.opacity = Math.min(0.62, Math.max(0.06, baseOpacity + typeBoost));
        }
      }

      // Project regional area labels first with collision avoidance so pills never overlap each other or node labels
      const activeRegionId = selectedRegionScopeRef.current;
      const orderedRegions = [...regionClustersRef.current].sort((a, b) => {
        const aSel = a.id === activeRegionId ? 1 : 0;
        const bSel = b.id === activeRegionId ? 1 : 0;
        if (aSel !== bSel) return bSel - aSel;
        return b.count - a.count;
      });
      const regionBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      const visibleRegionIds = new Set<string>();
      for (const cluster of orderedRegions) {
        const el = regionLabelElsRef.current.get(cluster.id);
        if (!el) continue;
        projVec
          .set(
            cluster.centroid.x,
            cluster.centroid.y + Math.max(18, cluster.radius * 0.52),
            cluster.centroid.z
          )
          .project(camera);
        if (projVec.z >= 1) continue;
        const sx = (projVec.x * 0.5 + 0.5) * w;
        const sy = (-projVec.y * 0.5 + 0.5) * h;
        if (sx < leftLabelEdge + 12 || sx > rightLabelEdge - 40 || sy < topLabelEdge - 10 || sy > h - 40) {
          continue;
        }

        const estW = Math.min(200, Math.max(108, cluster.label.length * 6.8 + 44));
        const box = {
          left: sx - estW * 0.5 - 8,
          right: sx + estW * 0.5 + 8,
          top: sy - 26 - 6,
          bottom: sy + 6,
        };
        const overlapsRegion = regionBoxes.some(
          (b) => !(box.right < b.left || box.left > b.right || box.bottom < b.top || box.top > b.bottom)
        );
        if (overlapsRegion && cluster.id !== activeRegionId) continue;

        regionBoxes.push(box);
        visibleRegionIds.add(cluster.id);
        el.style.transform = `translate3d(${Math.round(sx)}px, ${Math.round(sy)}px, 0) translate(-50%, -100%)`;
        el.style.opacity = "1";
        el.style.pointerEvents = "auto";
      }
      for (const cluster of regionClustersRef.current) {
        if (visibleRegionIds.has(cluster.id)) continue;
        const el = regionLabelElsRef.current.get(cluster.id);
        if (!el) continue;
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
      }

      // Filter node label candidates against placed region pills, then run collision-free placement
      const freeLabelCandidates = labelCandidates.filter((cand) => {
        if (cand.uuid === focusStateRef.current.selectedNodeUuid || cand.uuid === focusStateRef.current.hoveredUuid) {
          return true;
        }
        const halfW = Math.min(
          132,
          Math.max(52, cand.title.length * 3.3 + (cand.extraWidthPx ?? 0) * 0.5)
        );
        const cLeft = cand.x - halfW;
        const cRight = cand.x + halfW;
        const cTop = cand.y - 24;
        const cBottom = cand.y;
        return !regionBoxes.some(
          (b) => !(cRight < b.left || cLeft > b.right || cBottom < b.top || cTop > b.bottom)
        );
      });
      const placed = selectNonOverlappingLabels(freeLabelCandidates, 14, 18, 12);
      const placedById = new Map(placed.map((p) => [p.uuid, p]));

      for (const [uuid, el] of labelElsRef.current.entries()) {
        const match = placedById.get(uuid);
        if (!match) {
          el.style.opacity = "0";
          el.style.pointerEvents = "none";
          continue;
        }
        el.style.transform = `translate3d(${Math.round(match.x)}px, ${Math.round(match.y)}px, 0) translate(-50%, -100%)`;
        el.style.opacity = "1";
        el.style.pointerEvents = "auto";
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      cameraRef.current = null;
      startCameraGlideRef.current = null;
      graphGroupRef.current = null;
      dustPointsRef.current = null;
      starMatRef.current = null;
      starGeo.dispose();
      starMat.dispose();
      renderer.dispose();
    };
  }, []);

  // Effect B: Synchronize nodes, edges, candidate previews & theme without recreating WebGL context
  useEffect(() => {
    const graphGroup = graphGroupRef.current;
    if (!graphGroup) return;

    if (starMatRef.current) {
      starMatRef.current.color.setHex(isLightTheme ? 0x64748b : 0x94a3b8);
      starMatRef.current.opacity = isLightTheme ? 0.2 : 0.24;
    }
    if (dustPointsRef.current) {
      dustPointsRef.current.position.set(
        overviewFraming.target.x,
        overviewFraming.target.y,
        overviewFraming.target.z
      );
      const dustScale = Math.max(1, overviewFraming.radius / 225);
      dustPointsRef.current.scale.set(dustScale, dustScale, dustScale);
    }

    const nodeTextureCache = new Map<string, THREE.CanvasTexture>();
    const haloTextureCache = new Map<string, THREE.CanvasTexture>();
    const getNodeTexture = (hex: string, isAnchorHub: boolean) => {
      const key = `${hex}_${isAnchorHub ? "H" : "N"}_${isLightTheme ? "L" : "D"}`;
      let tex = nodeTextureCache.get(key);
      if (!tex) {
        tex = new THREE.CanvasTexture(createEtgNodeCanvas(hex, isLightTheme, isAnchorHub));
        tex.colorSpace = THREE.SRGBColorSpace;
        nodeTextureCache.set(key, tex);
      }
      return tex;
    };
    const getHaloTexture = (hex: string) => {
      let tex = haloTextureCache.get(hex);
      if (!tex) {
        tex = new THREE.CanvasTexture(createEtgHaloCanvas(hex));
        tex.colorSpace = THREE.SRGBColorSpace;
        haloTextureCache.set(hex, tex);
      }
      return tex;
    };

    const nodeScaleFor = (node: ETGNode): number =>
      node.label === "Insight" ? 13.5 : node.label === "Concept" ? 11.5 : node.label === "Rule" ? 10 : 9;

    const addedChildren: THREE.Object3D[] = [];
    const nodeObjects: SceneNodeObject3D[] = [];
    const nodeScaleByUuid = new Map<string, number>();
    const pickSprites: THREE.Sprite[] = [];

    for (const node of nodes) {
      const pos = layoutPositions.get(node.uuid);
      if (!pos) continue;
      const color = resolveEtgNodeColor(node);
      const baseScale = nodeScaleFor(node);
      const degree = neighborMap.get(node.uuid)?.size ?? 0;
      const isAnchorHub = node.label === "Insight" || degree >= 4;
      nodeScaleByUuid.set(node.uuid, baseScale);

      const mat = new THREE.SpriteMaterial({
        map: getNodeTexture(color, isAnchorHub),
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(pos.x, pos.y, pos.z);
      sprite.scale.set(baseScale, baseScale, 1);
      sprite.userData = { uuid: node.uuid };
      graphGroup.add(sprite);
      addedChildren.push(sprite);
      pickSprites.push(sprite);

      const haloMat = new THREE.SpriteMaterial({
        map: getHaloTexture(color),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const halo = new THREE.Sprite(haloMat);
      halo.position.set(pos.x, pos.y, pos.z);
      halo.scale.set(baseScale * 2.1, baseScale * 2.1, 1);
      graphGroup.add(halo);
      addedChildren.push(halo);

      nodeObjects.push({
        node,
        sprite,
        halo,
        baseScale,
        worldPos: new THREE.Vector3(pos.x, pos.y, pos.z),
      });
    }

    const edgeObjects: SceneEdgeObject3D[] = [];
    const edgePickLines: THREE.Line[] = [];

    for (const edge of edges) {
      const p1 = layoutPositions.get(edge.source_uuid);
      const p2 = layoutPositions.get(edge.target_uuid);
      if (
        !p1 ||
        !p2 ||
        !Number.isFinite(p1.x) ||
        !Number.isFinite(p1.y) ||
        !Number.isFinite(p1.z) ||
        !Number.isFinite(p2.x) ||
        !Number.isFinite(p2.y) ||
        !Number.isFinite(p2.z)
      ) {
        continue;
      }

      const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
      const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);
      if (v1.distanceToSquared(v2) < 1e-4) {
        v2.x += 0.6;
      }
      const srcScale = nodeScaleByUuid.get(edge.source_uuid) ?? 10;
      const tgtScale = nodeScaleByUuid.get(edge.target_uuid) ?? 10;
      const { start: pStart, end: pEnd } = computeSurfaceConnectionPoints(
        v1,
        srcScale,
        v2,
        tgtScale,
        0.36
      );
      const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);

      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pStart[0], pStart[1], pStart[2]),
        new THREE.Vector3(pEnd[0], pEnd[1], pEnd[2]),
      ]);

      const baseColor = resolveEtgEdgeColor(edge.type);
      const isSupersedesOrHypothesis =
        edge.type === "supersedes" || edge.type === "hypothesized_link";
      const material = isSupersedesOrHypothesis
        ? new THREE.LineDashedMaterial({
            color: new THREE.Color(baseColor),
            transparent: true,
            opacity: 0.36,
            dashSize: 3.4,
            gapSize: 2.2,
            depthWrite: false,
          })
        : new THREE.LineBasicMaterial({
            color: new THREE.Color(baseColor),
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
          });

      const line = new THREE.Line(geometry, material);
      if (isSupersedesOrHypothesis) {
        line.computeLineDistances();
      }
      line.userData = { edge };
      graphGroup.add(line);
      addedChildren.push(line);
      edgePickLines.push(line);
      edgeObjects.push({
        edge,
        line,
        material,
        baseColorHex: baseColor,
        midPoint: mid,
      });
    }

    const candGeos: THREE.BufferGeometry[] = [];
    const candMats: THREE.Material[] = [];
    for (const cand of candidateLinks) {
      const p1 = layoutPositions.get(cand.sourceUuid);
      const p2 = layoutPositions.get(cand.targetUuid);
      if (
        !p1 ||
        !p2 ||
        !Number.isFinite(p1.x) ||
        !Number.isFinite(p1.y) ||
        !Number.isFinite(p1.z) ||
        !Number.isFinite(p2.x) ||
        !Number.isFinite(p2.y) ||
        !Number.isFinite(p2.z)
      ) {
        continue;
      }
      const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
      const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);
      if (v1.distanceToSquared(v2) < 1e-4) {
        v2.x += 0.6;
      }
      const srcScale = nodeScaleByUuid.get(cand.sourceUuid) ?? 10;
      const tgtScale = nodeScaleByUuid.get(cand.targetUuid) ?? 10;
      const { start: pStart, end: pEnd } = computeSurfaceConnectionPoints(v1, srcScale, v2, tgtScale, 0.36);
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pStart[0], pStart[1], pStart[2]),
        new THREE.Vector3(pEnd[0], pEnd[1], pEnd[2]),
      ]);
      const mat = new THREE.LineDashedMaterial({
        color: 0xa78bfa,
        dashSize: 3.5,
        gapSize: 2.5,
        transparent: true,
        opacity: 0.72,
      });
      const dashed = new THREE.Line(geo, mat);
      dashed.computeLineDistances();
      graphGroup.add(dashed);
      addedChildren.push(dashed);
      candGeos.push(geo);
      candMats.push(mat);
    }

    nodeObjectsRef.current = nodeObjects;
    edgeObjectsRef.current = edgeObjects;
    pickSpritesRef.current = pickSprites;
    edgePickLinesRef.current = edgePickLines;

    return () => {
      for (const obj of addedChildren) {
        graphGroup.remove(obj);
      }
      nodeObjectsRef.current = [];
      edgeObjectsRef.current = [];
      pickSpritesRef.current = [];
      edgePickLinesRef.current = [];
      for (const eo of edgeObjects) {
        eo.line.geometry.dispose();
        eo.material.dispose();
      }
      for (const no of nodeObjects) {
        no.sprite.material.dispose();
        no.halo.material.dispose();
      }
      for (const tex of nodeTextureCache.values()) tex.dispose();
      for (const tex of haloTextureCache.values()) tex.dispose();
      for (const g of candGeos) g.dispose();
      for (const m of candMats) m.dispose();
    };
  }, [nodes, edges, candidateLinks, layoutPositions, neighborMap, isLightTheme, overviewFraming]);

  const handleRecenter = useCallback(() => {
    freeFlightRef.current = false;
    rotationRef.current.targetPitch = DEFAULT_ORBIT_3D.pitch;
    rotationRef.current.targetYaw = DEFAULT_ORBIT_3D.yaw;
    rotVelocityRef.current = { pitch: 0, yaw: 0 };
    const { target, radius } = overviewFramingRef.current;
    if (startCameraGlideRef.current) {
      startCameraGlideRef.current(new THREE.Vector3(target.x, target.y, target.z), {
        durationMs: prefersReducedMotion ? 0 : 560,
        targetRadius: radius,
      });
    } else {
      panTargetRef.current = {
        x: target.x,
        y: target.y,
        z: target.z,
        targetX: target.x,
        targetY: target.y,
        targetZ: target.z,
      };
      orbitRadiusRef.current.target = radius;
    }
  }, [prefersReducedMotion]);

  const handleStepRotate = useCallback(() => {
    freeFlightRef.current = false;
    rotationRef.current.targetYaw += (35 * Math.PI) / 180;
  }, []);

  const handleZoomIn = useCallback(() => {
    orbitRadiusRef.current.target = Math.max(42, orbitRadiusRef.current.target - 36);
    if (cameraGlideRef.current.active) {
      cameraGlideRef.current.targetRadius = orbitRadiusRef.current.target;
    }
  }, []);

  const handleZoomOut = useCallback(() => {
    orbitRadiusRef.current.target = Math.min(1100, orbitRadiusRef.current.target + 36);
    if (cameraGlideRef.current.active) {
      cameraGlideRef.current.targetRadius = orbitRadiusRef.current.target;
    }
  }, []);

  return (
    <div className="etg-graph-void relative h-full w-full overflow-hidden select-none">
      <div ref={hostRef} className="h-full w-full" aria-label="3D Earth Trend Knowledge Graph" />

      {/* Projected non-overlapping pill badges & clickable regional area headers */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {regionClusters.map((cluster) => {
          const isFocusedRegion = selectedRegionScope === cluster.id;
          return (
            <button
              key={`region-${cluster.id}`}
              type="button"
              ref={(el) => {
                if (el) regionLabelElsRef.current.set(cluster.id, el);
                else regionLabelElsRef.current.delete(cluster.id);
              }}
              onClick={() => {
                flyToRegionCluster(cluster);
                onChangeRegionScope?.(cluster.id);
              }}
              title={`Move camera to ${cluster.label}`}
              style={{ opacity: 0, pointerEvents: "none", top: 0, left: 0 }}
              className={`absolute inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider uppercase whitespace-nowrap shadow-sm transition-opacity duration-150 cursor-pointer ${
                isFocusedRegion
                  ? isLightTheme
                    ? "border-amber-600 bg-amber-100/95 text-amber-950"
                    : "border-amber-400 bg-amber-950/90 text-amber-200"
                  : isLightTheme
                    ? "border-zinc-300 bg-white/85 text-zinc-700 hover:border-amber-500 hover:text-zinc-950"
                    : "border-white/15 bg-[#0f131d]/85 text-zinc-300 hover:border-amber-400/70 hover:text-white"
              }`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
              <span className="max-w-[165px] truncate">{cluster.label}</span>
              <span className="shrink-0 opacity-65">· {cluster.count}</span>
            </button>
          );
        })}
        {nodes.map((node) => {
          const isSelected = node.uuid === selectedNodeUuid || node.uuid === connectSourceUuid;
          const color = resolveEtgNodeColor(node);
          const role = roleByNode[node.uuid];
          const slopeInfo = formatTrendStat(node, isLightTheme);
          const cleanName = humanizeNodeText(node.properties.name);
          const displayName =
            cleanName.length > 32 ? `${cleanName.slice(0, 30)}…` : cleanName;
          const isSuperseded =
            node.properties.status === "Superseded" || Boolean(node.properties.superseded_by);
          const microBadge = resolveMicroscopeNodeBadge(microscopeByNode[node.uuid], isLightTheme);

          return (
            <button
              key={node.uuid}
              type="button"
              title={
                microBadge
                  ? `${cleanName} · ${microBadge.title}`
                  : isSuperseded
                    ? `${cleanName} (Superseded assessment)`
                    : cleanName
              }
              ref={(el) => {
                if (el) labelElsRef.current.set(node.uuid, el);
                else labelElsRef.current.delete(node.uuid);
              }}
              onClick={(e) => {
                if ((connectMode || e.shiftKey) && onStartQuickConnect) {
                  if (connectSourceUuid && connectSourceUuid !== node.uuid) {
                    const srcNode = nodeById.get(connectSourceUuid);
                    if (srcNode) onStartQuickConnect(srcNode, node);
                  } else if (e.shiftKey && selectedNodeUuid && selectedNodeUuid !== node.uuid) {
                    const srcNode = nodeById.get(selectedNodeUuid);
                    if (srcNode) onStartQuickConnect(srcNode, node);
                  } else {
                    onStartQuickConnect(node);
                  }
                  return;
                }
                onSelectNode(node);
              }}
              style={{
                opacity: 0,
                pointerEvents: "none",
                top: 0,
                left: 0,
                borderColor: isSelected ? color : undefined,
              }}
              className={`absolute inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap shadow-md transition-opacity duration-150 cursor-pointer ${
                isSuperseded ? "border-dashed opacity-85" : ""
              } ${
                isSelected
                  ? "border-accent-fg bg-surface text-text-primary"
                  : isLightTheme
                    ? "border-border bg-white text-zinc-900 hover:border-zinc-400"
                    : "border-border bg-[#12151e] text-zinc-100 hover:border-zinc-500"
              }`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className={isSuperseded ? "line-through decoration-1 opacity-80" : undefined}>
                {displayName}
              </span>
              {role === "upstream" && (
                <span
                  className={`rounded-xs px-1 font-mono text-[9px] ${
                    isLightTheme ? "bg-teal-100 text-teal-900" : "bg-teal-950 text-teal-300"
                  }`}
                >
                  driver
                </span>
              )}
              {role === "downstream" && (
                <span
                  className={`rounded-xs px-1 font-mono text-[9px] ${
                    isLightTheme ? "bg-amber-100 text-amber-900" : "bg-amber-950 text-amber-300"
                  }`}
                >
                  impact
                </span>
              )}
              {isSuperseded && (
                <span
                  className={`rounded-xs px-1 font-mono text-[8.5px] uppercase ${
                    isLightTheme ? "bg-zinc-100 text-zinc-700" : "bg-zinc-800 text-zinc-300"
                  }`}
                >
                  superseded
                </span>
              )}
              {microBadge && (
                <span
                  className={`rounded-xs px-1 font-mono text-[8.5px] font-semibold ${microBadge.pillClass}`}
                >
                  {microBadge.text}
                </span>
              )}
              {node.properties.theil_sen_slope !== undefined && (
                <span className="font-mono text-[9px]" style={{ color: slopeInfo.color }}>
                  {node.properties.theil_sen_slope >= 0 ? "↑" : "↓"}
                </span>
              )}
            </button>
          );
        })}

        {/* Floating clickable + Wire pill suggestions for discovered candidate links in 3D */}
        {candidateLinks.length > 0 && onAcceptCandidateLink && (
          <div
            className={`pointer-events-auto absolute bottom-4 z-20 flex max-w-xs flex-col gap-1.5 ${
              inspectorOpen ? "right-4 lg:right-[27rem]" : "right-4"
            }`}
          >
            {candidateLinks.slice(0, 3).map((cand) => (
              <button
                key={cand.id}
                type="button"
                onClick={() => onAcceptCandidateLink(cand)}
                className="etg-hud-pill flex items-center justify-between gap-2 rounded-md border border-violet-400 bg-surface px-3 py-1.5 text-left text-[11px] hover:border-violet-300 cursor-pointer"
              >
                <span className="truncate text-text-primary">
                  + Wire: {cand.sourceName.slice(0, 14)} → {cand.targetName.slice(0, 14)}
                </span>
                <span
                  className={`shrink-0 font-mono text-[10px] ${
                    isLightTheme ? "text-violet-700" : "text-violet-300"
                  }`}
                >
                  {cand.pearsonR !== undefined ? `r=${cand.pearsonR.toFixed(2)}` : `${Math.round(cand.score * 100)}%`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hovered edge tooltip badge */}
      {(() => {
        const activeEdge = hoveredEdgeUuid
          ? edges.find((e) => e.properties.uuid === hoveredEdgeUuid)
          : undefined;
        if (!activeEdge) return null;
        const src = nodeById.get(activeEdge.source_uuid);
        const tgt = nodeById.get(activeEdge.target_uuid);
        return (
          <div className="etg-hud-pill pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md bg-surface px-3.5 py-2 text-xs shadow-lg">
            <div
              className={`flex items-center gap-2 font-semibold ${
                activeEdge.type === "drives_opposite"
                  ? isLightTheme
                    ? "text-rose-700"
                    : "text-rose-300"
                  : activeEdge.type === "supersedes"
                    ? isLightTheme
                      ? "text-purple-700"
                      : "text-purple-300"
                    : isLightTheme
                      ? "text-amber-800"
                      : "text-amber-300"
              }`}
            >
              <span>
                {activeEdge.type === "drives_opposite"
                  ? `⇄ ${formatEdgeRelationLabel(activeEdge.type)}`
                  : activeEdge.type === "supersedes"
                    ? `↻ Epistemic Revision (${formatEdgeRelationLabel(activeEdge.type)})`
                    : formatEdgeRelationLabel(activeEdge.type)}
              </span>
              {typeof activeEdge.properties.optimal_lag_steps === "number" &&
                activeEdge.properties.optimal_lag_steps > 0 && (
                  <span className="ws-numeric font-mono">
                    Δt={activeEdge.properties.optimal_lag_steps}
                    {activeEdge.properties.lag_unit?.[0] ?? ""}
                  </span>
                )}
              {activeEdge.properties.correlation_r !== undefined && (
                <span className="ws-numeric font-mono">
                  r={activeEdge.properties.correlation_r.toFixed(2)}
                </span>
              )}
              {activeEdge.properties.mechanism && (
                <span className="text-text-muted">· {activeEdge.properties.mechanism}</span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-text-muted">
              {src?.properties.name ?? activeEdge.source_uuid} ↔{" "}
              {tgt?.properties.name ?? activeEdge.target_uuid}
            </div>
          </div>
        );
      })()}

      {/* Left-Edge Vertical Camera Dock */}
      <div className="absolute left-3.5 top-1/2 z-10 -translate-y-1/2">
        <GraphCameraDock
          orientation="vertical"
          showOrbitControls
          isOrbiting={isOrbiting}
          onToggleOrbit={() => setIsOrbiting((prev) => !prev)}
          onStepRotate={handleStepRotate}
          onRecenter={handleRecenter}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* 2D Interactive Card & Semantic Zoom Knowledge Graph                         */
/* ─────────────────────────────────────────────────────────────────────────── */

function GraphCanvas2D({
  nodes,
  edges,
  selectedNodeUuid,
  selectedEdgeUuid,
  cascadeEdgeUuids,
  searchQuery,
  isLightTheme,
  candidateLinks = [],
  traversalFilter,
  roleByNode = {},
  hopByNode = {},
  microscopeByNode = {},
  connectMode = false,
  connectSourceUuid = null,
  selectedRegionScope = null,
  regionSpotlight = null,
  regionFocusNonce = 0,
  onChangeRegionScope,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onStartQuickConnect,
  onAcceptCandidateLink,
}: GraphCanvasProps) {
  const cascadeEdgeSet = useMemo(() => new Set(cascadeEdgeUuids), [cascadeEdgeUuids]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1200, height: 800 });
  const layoutMode = traversalFilter?.layoutMode ?? "force";

  const { positions: basePositions, bounds } = useMemo(
    () =>
      computeLayout2D(nodes, edges, {
        mode: layoutMode,
        rootUuid: selectedNodeUuid,
        roleByNode,
        hopByNode,
      }),
    [nodes, edges, layoutMode, selectedNodeUuid, roleByNode, hopByNode]
  );

  // User-dragged node overrides (cleared cleanly when node set or layout mode changes)
  const [dragOverrides, setDragOverrides] = useState<Map<string, Point2D>>(() => new Map());
  useEffect(() => {
    setDragOverrides(new Map());
  }, [basePositions]);

  const positions = useMemo(() => {
    if (dragOverrides.size === 0) return basePositions;
    const merged = new Map(basePositions);
    for (const [id, pt] of dragOverrides.entries()) {
      merged.set(id, pt);
    }
    return merged;
  }, [basePositions, dragOverrides]);

  const regionClusters2D = useMemo(
    () => computeRegionClusters2D(nodes, positions),
    [nodes, positions]
  );

  // Camera state (panX/panY in world units centered at 0, zoom multiplier)
  const [camera, setCamera] = useState({ panX: 0, panY: 0, zoom: 0.94 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const cameraAnimRef = useRef<number | null>(null);
  const hasRightPanel = Boolean(selectedNodeUuid || selectedEdgeUuid || connectSourceUuid);

  const cancelCameraAnim2D = useCallback(() => {
    if (cameraAnimRef.current !== null) {
      cancelAnimationFrame(cameraAnimRef.current);
      cameraAnimRef.current = null;
    }
  }, []);

  const animateCamera2D = useCallback(
    (target: { panX: number; panY: number; zoom: number }, durationMs = 300) => {
      cancelCameraAnim2D();
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduced || durationMs <= 0) {
        setCamera(target);
        return;
      }
      const start = { ...cameraRef.current };
      const t0 = performance.now();
      const step = (now: number) => {
        const raw = Math.min(1, (now - t0) / durationMs);
        const ease = 1 - Math.pow(1 - raw, 3);
        setCamera({
          panX: start.panX + (target.panX - start.panX) * ease,
          panY: start.panY + (target.panY - start.panY) * ease,
          zoom: start.zoom + (target.zoom - start.zoom) * ease,
        });
        if (raw < 1) {
          cameraAnimRef.current = requestAnimationFrame(step);
        } else {
          cameraAnimRef.current = null;
        }
      };
      cameraAnimRef.current = requestAnimationFrame(step);
    },
    [cancelCameraAnim2D]
  );

  useEffect(() => cancelCameraAnim2D, [cancelCameraAnim2D]);

  // Fit graph nicely into container on mount/bounds change, reserving space for open right workbench
  const recenterToFit = useCallback(
    (animate = false) => {
      const { width, height } = viewportSize;
      const rightInset = hasRightPanel && width >= 900 ? 440 : 0;
      const usableWidth = Math.max(320, width - rightInset);
      const graphW = Math.max(320, bounds.maxX - bounds.minX + CARD_WIDTH + 32);
      const graphH = Math.max(240, bounds.maxY - bounds.minY + CARD_HEIGHT + 48);
      const fitZoom = Math.max(
        MIN_ZOOM,
        Math.min(1.08, Math.min((usableWidth * 0.86) / graphW, (height * 0.78) / graphH))
      );
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const nextCam = {
        panX: -cx * fitZoom - rightInset / 2,
        panY: -cy * fitZoom,
        zoom: fitZoom,
      };
      if (animate) {
        animateCamera2D(nextCam, 360);
      } else {
        cancelCameraAnim2D();
        setCamera(nextCam);
      }
    },
    [bounds, viewportSize, hasRightPanel, animateCamera2D, cancelCameraAnim2D]
  );

  const panToRegion2D = useCallback(
    (clusterId: string) => {
      const target = regionClusters2D.find((c) => c.id === clusterId);
      if (!target) return;
      const rightInset = hasRightPanel && viewportSize.width >= 900 ? 440 : 0;
      const focusZoom = Math.max(
        0.86,
        Math.min(1.18, cameraRef.current.zoom < 0.8 ? 0.96 : cameraRef.current.zoom)
      );
      animateCamera2D({
        panX: -target.centroid.x * focusZoom - rightInset / 2,
        panY: -target.centroid.y * focusZoom,
        zoom: focusZoom,
      });
    },
    [regionClusters2D, hasRightPanel, viewportSize.width, animateCamera2D]
  );

  const prevRegion2DRef = useRef<string | null>(null);
  const prevRegionFocusNonce2DRef = useRef<number>(regionFocusNonce);
  useEffect(() => {
    if (
      selectedRegionScope === prevRegion2DRef.current &&
      regionFocusNonce === prevRegionFocusNonce2DRef.current
    ) {
      return;
    }
    const hadPrevRegion = prevRegion2DRef.current !== null;
    prevRegion2DRef.current = selectedRegionScope;
    prevRegionFocusNonce2DRef.current = regionFocusNonce;
    if (selectedRegionScope) {
      panToRegion2D(selectedRegionScope);
    } else if (hadPrevRegion) {
      recenterToFit(true);
    }
  }, [selectedRegionScope, regionFocusNonce, panToRegion2D, recenterToFit]);

  const [hoveredNodeUuid, setHoveredNodeUuid] = useState<string | null>(null);
  const [hoveredEdgeUuid, setHoveredEdgeUuid] = useState<string | null>(null);
  const [pointerWorldPos, setPointerWorldPos] = useState<Point2D | null>(null);

  useEffect(() => {
    if (!connectSourceUuid) {
      setPointerWorldPos(null);
    }
  }, [connectSourceUuid]);

  const nodeById2D = useMemo(() => {
    const map = new Map<string, ETGNode>();
    for (const n of nodes) map.set(n.uuid, n);
    return map;
  }, [nodes]);

  const neighborMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const n of nodes) map.set(n.uuid, new Set());
    for (const e of edges) {
      map.get(e.source_uuid)?.add(e.target_uuid);
      map.get(e.target_uuid)?.add(e.source_uuid);
    }
    return map;
  }, [nodes, edges]);

  const matchingUuids = useMemo(() => {
    if (!searchQuery) return new Set<string>();
    const hits = new Set<string>();
    for (const n of nodes) {
      const text = `${n.properties.name} ${n.label} ${n.properties.region ?? ""} ${n.properties.dataset ?? ""} ${(n.properties.domain_tags ?? []).join(" ")}`.toLowerCase();
      if (text.includes(searchQuery)) hits.add(n.uuid);
    }
    return hits;
  }, [nodes, searchQuery]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportSize({
        width: el.clientWidth || 1200,
        height: el.clientHeight || 800,
      });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Recenter once initial viewport size & layout are known, and when layoutMode, node count, or workbench visibility changes
  const hasAutoFittedRef = useRef(false);
  const prevLayoutModeRef = useRef(layoutMode);
  const prevNodeCountRef = useRef(nodes.length);
  const prevRightPanelRef = useRef(hasRightPanel);
  useEffect(() => {
    if (!hasAutoFittedRef.current && viewportSize.width > 100) {
      hasAutoFittedRef.current = true;
      prevNodeCountRef.current = nodes.length;
      prevRightPanelRef.current = hasRightPanel;
      recenterToFit(false);
      return;
    }
    if (
      prevLayoutModeRef.current !== layoutMode ||
      prevNodeCountRef.current !== nodes.length ||
      prevRightPanelRef.current !== hasRightPanel
    ) {
      prevLayoutModeRef.current = layoutMode;
      prevNodeCountRef.current = nodes.length;
      prevRightPanelRef.current = hasRightPanel;
      recenterToFit(false);
    }
  }, [viewportSize.width, layoutMode, nodes.length, hasRightPanel, recenterToFit]);

  // Pan & node drag state
  const interactionRef = useRef<{
    mode: "idle" | "pan" | "node";
    nodeUuid?: string;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    startNodePos?: Point2D;
    moved: boolean;
  }>({
    mode: "idle",
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false,
  });

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelCameraAnim2D();
    interactionRef.current = {
      mode: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: cameraRef.current.panX,
      startPanY: cameraRef.current.panY,
      moved: false,
    };
  };

  const handleNodePointerDown = (e: React.PointerEvent<SVGGElement>, node: ETGNode) => {
    e.stopPropagation();
    const pos = positions.get(node.uuid) ?? { x: 0, y: 0 };
    interactionRef.current = {
      mode: "node",
      nodeUuid: node.uuid,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: cameraRef.current.panX,
      startPanY: cameraRef.current.panY,
      startNodePos: { ...pos },
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (connectSourceUuid && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const cam = cameraRef.current;
      const worldX = (e.clientX - rect.left - rect.width / 2 - cam.panX) / cam.zoom;
      const worldY = (e.clientY - rect.top - rect.height / 2 - cam.panY) / cam.zoom;
      setPointerWorldPos({ x: worldX, y: worldY });
    }

    const st = interactionRef.current;
    if (st.mode === "idle") return;

    const dx = e.clientX - st.startClientX;
    const dy = e.clientY - st.startClientY;
    if (Math.hypot(dx, dy) > 4) st.moved = true;

    if (st.mode === "pan") {
      setCamera((prev) => ({
        ...prev,
        panX: st.startPanX + dx,
        panY: st.startPanY + dy,
      }));
    } else if (st.mode === "node" && st.nodeUuid && st.startNodePos) {
      const z = cameraRef.current.zoom;
      setDragOverrides((prev) => {
        const next = new Map(prev);
        next.set(st.nodeUuid!, {
          x: st.startNodePos!.x + dx / z,
          y: st.startNodePos!.y + dy / z,
        });
        return next;
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const st = interactionRef.current;
    if (st.mode === "pan" && !st.moved && e.target === svgRef.current) {
      onClearSelection?.();
    }
    interactionRef.current.mode = "idle";
  };

  const handleSvgPointerLeave = (e: React.PointerEvent<SVGSVGElement>) => {
    setPointerWorldPos(null);
    handlePointerUp(e);
  };

  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    cancelCameraAnim2D();
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cursorX = e.clientX - rect.left - rect.width / 2;
    const cursorY = e.clientY - rect.top - rect.height / 2;

    setCamera((prev) => {
      const nextZoom = wheelZoomStep(prev.zoom, e.deltaY);
      const scale = nextZoom / prev.zoom;
      return {
        zoom: nextZoom,
        panX: cursorX - (cursorX - prev.panX) * scale,
        panY: cursorY - (cursorY - prev.panY) * scale,
      };
    });
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onSvgWheel = (e: WheelEvent) => handleWheelRef.current(e);
    el.addEventListener("wheel", onSvgWheel, { passive: false });
    return () => el.removeEventListener("wheel", onSvgWheel);
  }, []);

  const zoomAtCenter = useCallback(
    (factor: number) => {
      cancelCameraAnim2D();
      setCamera((prev) => {
        const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor));
        const scale = nextZoom / prev.zoom;
        return {
          zoom: nextZoom,
          panX: prev.panX * scale,
          panY: prev.panY * scale,
        };
      });
    },
    [cancelCameraAnim2D]
  );

  const handleNodeInteractionClick = (e: React.MouseEvent<SVGGElement>, node: ETGNode) => {
    e.stopPropagation();
    if (interactionRef.current.moved) return;
    if ((connectMode || e.shiftKey) && onStartQuickConnect) {
      if (connectSourceUuid && connectSourceUuid !== node.uuid) {
        const srcNode = nodes.find((n) => n.uuid === connectSourceUuid);
        if (srcNode) {
          onStartQuickConnect(srcNode, node);
          return;
        }
      } else if (e.shiftKey && selectedNodeUuid && selectedNodeUuid !== node.uuid) {
        const srcNode = nodes.find((n) => n.uuid === selectedNodeUuid);
        if (srcNode) {
          onStartQuickConnect(srcNode, node);
          return;
        }
      }
      onStartQuickConnect(node);
      return;
    }
    onSelectNode(node);
  };

  const detailTier = resolveDetailTier(camera.zoom);
  const activeFocusUuid = hoveredNodeUuid ?? selectedNodeUuid;
  const activeNeighbors = activeFocusUuid ? neighborMap.get(activeFocusUuid) ?? null : null;
  const hasSearch = matchingUuids.size > 0;

  // Dot-matrix background pitch in screen space
  const dotSpacing = Math.max(16, Math.min(44, 28 * camera.zoom));
  const dotOffsetX = ((viewportSize.width / 2 + camera.panX) % dotSpacing + dotSpacing) % dotSpacing;
  const dotOffsetY = ((viewportSize.height / 2 + camera.panY) % dotSpacing + dotSpacing) % dotSpacing;

  // Minimap coordinate transform
  const mapW = 164;
  const mapH = 104;
  const worldW = Math.max(400, bounds.maxX - bounds.minX);
  const worldH = Math.max(300, bounds.maxY - bounds.minY);
  const mapScale = Math.min((mapW - 16) / worldW, (mapH - 16) / worldH);
  const mapCenterX = (bounds.minX + bounds.maxX) / 2;
  const mapCenterY = (bounds.minY + bounds.maxY) / 2;

  const viewWorldX = -camera.panX / camera.zoom;
  const viewWorldY = -camera.panY / camera.zoom;
  const viewWorldW = viewportSize.width / camera.zoom;
  const viewWorldH = viewportSize.height / camera.zoom;

  const cardBg = isLightTheme ? "#ffffff" : "#12151f";
  const cardBorder = isLightTheme ? "#d4d4d8" : "rgba(255,255,255,0.12)";
  const cardTitle = isLightTheme ? "#18181b" : "#f4f4f5";
  const connectSourcePos = connectSourceUuid ? positions.get(connectSourceUuid) ?? null : null;

  const dotScale2D = 1 / Math.max(0.4, Math.min(1, camera.zoom));
  const dotRadiusFor2D = (node?: ETGNode): number => {
    const baseR =
      node?.label === "Insight"
        ? 13
        : node?.label === "Concept"
          ? 11
          : node?.label === "Rule"
            ? 10
            : 8.5;
    return baseR * Math.min(2.1, dotScale2D);
  };
  const computeEdgeEndpoints2D = (
    p1: Point2D,
    p2: Point2D,
    ctrl: Point2D,
    sourceUuid: string,
    targetUuid: string
  ): { startPt: Point2D; endPt: Point2D } => {
    if (detailTier === "dots") {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.hypot(dx, dy) || 1;
      const rSrc = dotRadiusFor2D(nodeById2D.get(sourceUuid)) + 2;
      const rTgt = dotRadiusFor2D(nodeById2D.get(targetUuid)) + 2;
      const trimRadial = (p: Point2D, dirX: number, dirY: number, r: number): Point2D =>
        dist > r * 1.4 ? { x: p.x + dirX * r, y: p.y + dirY * r } : p;
      return {
        startPt: trimRadial(p1, dx / dist, dy / dist, rSrc),
        endPt: trimRadial(p2, -dx / dist, -dy / dist, rTgt),
      };
    }
    const halfW = CARD_WIDTH / 2 + 2;
    const halfH = 22;
    return {
      startPt: intersectBoxBorder(p1, ctrl, halfW, halfH),
      endPt: intersectBoxBorder(p2, ctrl, halfW, halfH),
    };
  };

  const dipoleNodeUuids2D = new Set<string>();
  for (const e of edges) {
    if (e.type === "drives_opposite") {
      dipoleNodeUuids2D.add(e.source_uuid);
      dipoleNodeUuids2D.add(e.target_uuid);
    }
  }

  // De-overlap 2D regional headers and ensure generous clearance above top node cards
  const headerBaseOffset = detailTier === "dots" ? 30 * Math.min(1.8, dotScale2D) : CARD_HEIGHT / 2 + 28;
  const headerPillScale = 1 / Math.max(0.28, Math.min(1, camera.zoom));
  const placedHeaderRects: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const placedRegionHeaders2D =
    layoutMode === "force"
      ? [...regionClusters2D]
          .sort((a, b) => {
            const aSel = selectedRegionScope === a.id ? 1 : 0;
            const bSel = selectedRegionScope === b.id ? 1 : 0;
            if (aSel !== bSel) return bSel - aSel;
            return b.count - a.count;
          })
          .map((cluster) => {
            const shortLabel =
              cluster.label.length > 26 ? `${cluster.label.slice(0, 24)}…` : cluster.label;
            const labelText = `${shortLabel.toUpperCase()} · ${cluster.count}`;
            const pillW = Math.max(110, labelText.length * 6.8 + 26);
            const worldWHeader = pillW * headerPillScale;
            const worldHHeader = 26 * headerPillScale;
            const x = cluster.centroid.x;
            let y = cluster.minY - headerBaseOffset;
            for (let step = 0; step < 4; step++) {
              const box = {
                left: x - worldWHeader / 2 - 8,
                right: x + worldWHeader / 2 + 8,
                top: y - worldHHeader / 2 - 4,
                bottom: y + worldHHeader / 2 + 4,
              };
              const overlaps = placedHeaderRects.some(
                (b) => !(box.right < b.left || box.left > b.right || box.bottom < b.top || box.top > b.bottom)
              );
              if (!overlaps) {
                placedHeaderRects.push(box);
                break;
              }
              y -= worldHHeader + 6;
            }
            return { cluster, labelText, pillW, x, y, pillScale: headerPillScale };
          })
      : [];

  // Precompute visible zoomed-out ("dots") labels using collision avoidance in screen coordinates
  const placedDotLabelUuids2D = new Set<string>();
  if (detailTier === "dots") {
    const dotCandidates: ScreenLabelCandidate[] = [];
    for (const node of nodes) {
      const p = positions.get(node.uuid);
      if (!p) continue;
      const isSelected = node.uuid === selectedNodeUuid;
      const isHovered = node.uuid === hoveredNodeUuid;
      const isSearchHit = matchingUuids.has(node.uuid);
      const isNeighbor = activeNeighbors ? activeNeighbors.has(node.uuid) : false;
      const isSuperseded =
        node.properties.status === "Superseded" || Boolean(node.properties.superseded_by);
      const microBadge = resolveMicroscopeNodeBadge(microscopeByNode[node.uuid], isLightTheme);

      let priority = 20;
      if (node.label === "Insight") priority += 120;
      else if (node.label === "Concept") priority += 80;
      else if (node.label === "Rule") priority += 30;
      if (dipoleNodeUuids2D.has(node.uuid)) priority += 70;
      if (microBadge) priority += 65;
      if (isSuperseded) priority -= 30;
      if (regionSpotlight?.localNodeSet.has(node.uuid)) priority += 140;
      if (isNeighbor) priority += 240;
      if (isSearchHit) priority += 420;
      if (isHovered) priority += 750;
      if (isSelected) priority += 1000;

      const clean = humanizeNodeText(node.properties.name);
      const trunc = clean.length > 28 ? `${clean.slice(0, 26)}…` : clean;
      const r = dotRadiusFor2D(node);
      dotCandidates.push({
        uuid: node.uuid,
        title: trunc,
        label: node.label,
        color: resolveEtgNodeColor(node),
        x: p.x * camera.zoom,
        y: (p.y + r + 14 * Math.min(2, dotScale2D)) * camera.zoom,
        priority,
      });
    }
    for (const item of selectNonOverlappingLabels(dotCandidates, 28, 12, 8)) {
      placedDotLabelUuids2D.add(item.uuid);
    }
  }

  // Precompute 2D Bezier edges & de-overlap midpoint pills
  const nodeAvoidBoxes2D = nodes
    .map((node) => {
      const p = positions.get(node.uuid);
      if (!p) return null;
      const r = dotRadiusFor2D(node);
      return {
        x: p.x,
        y: p.y,
        halfW: detailTier === "dots" ? r + 6 : CARD_WIDTH / 2,
        halfH: detailTier === "dots" ? r + 6 : CARD_HEIGHT / 2,
      };
    })
    .filter((b): b is { x: number; y: number; halfW: number; halfH: number } => b !== null);

  interface PreparedEdge2D {
    edge: ETGEdge;
    edgePath: string;
    strokeColor: string;
    strokeWidth: number;
    opacity: number;
    isOpposite: boolean;
    isSupersedes: boolean;
    markerEndId: string;
    markerStartId?: string;
    pillX: number;
    pillY: number;
    pillLabel: string;
    showPillCandidate: boolean;
    pillPriority: number;
  }

  const preparedEdges2D: PreparedEdge2D[] = [];
  const edgePillCandidates2D: ScreenEdgePillCandidate[] = [];

  edges.forEach((edge, idx) => {
    const p1 = positions.get(edge.source_uuid);
    const p2 = positions.get(edge.target_uuid);
    if (!p1 || !p2) return;

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist;
    const ny = dx / dist;
    const bend = (idx % 2 === 0 ? 1 : -1) * Math.min(42, dist * 0.14);
    const cx = (p1.x + p2.x) / 2 + nx * bend;
    const cy = (p1.y + p2.y) / 2 + ny * bend;

    const { startPt, endPt } = computeEdgeEndpoints2D(
      p1,
      p2,
      { x: cx, y: cy },
      edge.source_uuid,
      edge.target_uuid
    );

    const isEdgeHovered = hoveredEdgeUuid === edge.properties.uuid;
    const isEdgeSelected = selectedEdgeUuid === edge.properties.uuid;
    const isCascadeEdge = cascadeEdgeSet.has(edge.properties.uuid);
    const isConnectedToFocus =
      activeFocusUuid !== null &&
      (edge.source_uuid === activeFocusUuid || edge.target_uuid === activeFocusUuid);
    const matchesSearch =
      hasSearch &&
      (matchingUuids.has(edge.source_uuid) || matchingUuids.has(edge.target_uuid));
    const hasEdgeOrCascadeFocus = selectedEdgeUuid !== null || cascadeEdgeSet.size > 0;
    const isOpposite = edge.type === "drives_opposite";
    const isSupersedes = edge.type === "supersedes";

    let opacity = isLightTheme ? 0.74 : 0.5;
    let strokeWidth = isOpposite ? 2.0 : isSupersedes ? 1.55 : 1.35;
    if (isEdgeHovered || isEdgeSelected || isCascadeEdge || isConnectedToFocus) {
      opacity = 0.96;
      strokeWidth = isEdgeSelected ? 2.8 : isCascadeEdge ? 2.4 : isOpposite ? 2.35 : 2.15;
    } else if (activeFocusUuid || hasSearch) {
      opacity = matchesSearch ? 0.78 : isLightTheme ? 0.22 : 0.12;
    } else if (hasEdgeOrCascadeFocus) {
      opacity = isLightTheme ? 0.24 : 0.14;
    } else if (regionSpotlight) {
      if (regionSpotlight.spotlightEdgeSet.has(edge.properties.uuid)) {
        opacity = isLightTheme ? 0.88 : 0.82;
        strokeWidth += 0.35;
      } else {
        opacity = isLightTheme ? 0.12 : 0.07;
      }
    }

    const rawStrokeColor = resolveEtgEdgeColor(edge.type);
    const baseStrokeColor =
      isLightTheme && rawStrokeColor.toLowerCase() === "#94a3b8"
        ? "#52525b"
        : isLightTheme && isOpposite
          ? "#e11d48"
          : isLightTheme && isSupersedes
            ? "#9333ea"
            : rawStrokeColor;
    const strokeColor = isEdgeSelected
      ? isLightTheme
        ? "#b45309"
        : "#fef08a"
      : isCascadeEdge
        ? isLightTheme
          ? "#d97706"
          : "#fbbf24"
        : baseStrokeColor;

    const midLabelX = 0.25 * startPt.x + 0.5 * cx + 0.25 * endPt.x;
    const midLabelY = 0.25 * startPt.y + 0.5 * cy + 0.25 * endPt.y;
    const relationPrefix = isOpposite ? "⇄ " : isSupersedes ? "↻ " : "";
    const relationLabel = `${relationPrefix}${formatEdgeRelationLabel(edge.type, edge.properties.custom_label)}`;
    const lagSuffix =
      typeof edge.properties.optimal_lag_steps === "number" &&
      edge.properties.optimal_lag_steps > 0
        ? ` · Δt=${edge.properties.optimal_lag_steps}${edge.properties.lag_unit?.[0] ?? ""}`
        : "";
    const corrSuffix =
      edge.properties.correlation_r !== undefined
        ? ` · r=${edge.properties.correlation_r.toFixed(2)}`
        : "";
    const pillLabel = `${relationLabel}${lagSuffix}${corrSuffix}`;
    const showPillCandidate =
      isEdgeHovered || isEdgeSelected || isCascadeEdge || isConnectedToFocus;
    const pillPriority = isEdgeSelected
      ? 1000
      : isEdgeHovered
        ? 900
        : isCascadeEdge
          ? 700
          : isOpposite
            ? 450
            : isSupersedes
              ? 380
              : 240;

    const markerEndId = isEdgeSelected || isCascadeEdge
      ? "url(#etg-arrow-selected)"
      : isOpposite
        ? "url(#etg-arrow-opposite)"
        : isSupersedes
          ? "url(#etg-arrow-supersedes)"
          : "url(#etg-arrow-causal)";
    const markerStartId = isOpposite ? "url(#etg-dot-opposite)" : undefined;

    preparedEdges2D.push({
      edge,
      edgePath: `M ${startPt.x} ${startPt.y} Q ${cx} ${cy} ${endPt.x} ${endPt.y}`,
      strokeColor,
      strokeWidth,
      opacity,
      isOpposite,
      isSupersedes,
      markerEndId,
      markerStartId,
      pillX: midLabelX,
      pillY: midLabelY,
      pillLabel,
      showPillCandidate,
      pillPriority,
    });

    if (showPillCandidate) {
      edgePillCandidates2D.push({
        uuid: edge.properties.uuid,
        x: midLabelX,
        y: midLabelY,
        label: pillLabel,
        priority: pillPriority,
      });
    }
  });

  const placedEdgePillIds2D = new Set(
    selectNonOverlappingEdgePills(edgePillCandidates2D, nodeAvoidBoxes2D, 14, 10, 6).map(
      (p) => p.uuid
    )
  );

  return (
    <div className="etg-graph-void relative h-full w-full overflow-hidden select-none">
      <svg
        ref={svgRef}
        className={`h-full w-full ${connectMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={handleSvgPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handleSvgPointerLeave}
        aria-label="2D Earth Trend Knowledge Graph"
      >
        <defs>
          <pattern
            id="etg-dot-grid"
            x={dotOffsetX}
            y={dotOffsetY}
            width={dotSpacing}
            height={dotSpacing}
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx={1}
              cy={1}
              r={1}
              fill={isLightTheme ? "rgba(24, 24, 27, 0.14)" : "rgba(255, 255, 255, 0.12)"}
            />
          </pattern>
          <clipPath id="etg-card-clip-full">
            <rect
              x={-CARD_WIDTH / 2 + 24}
              y={-CARD_HEIGHT / 2}
              width={CARD_WIDTH - 36}
              height={CARD_HEIGHT}
            />
          </clipPath>
          <clipPath id="etg-card-clip-badged">
            <rect
              x={-CARD_WIDTH / 2 + 24}
              y={-CARD_HEIGHT / 2}
              width={CARD_WIDTH - 80}
              height={CARD_HEIGHT}
            />
          </clipPath>
          <clipPath id="etg-card-clip-double">
            <rect
              x={-CARD_WIDTH / 2 + 24}
              y={-CARD_HEIGHT / 2}
              width={CARD_WIDTH - 128}
              height={CARD_HEIGHT}
            />
          </clipPath>
          <marker
            id="etg-arrow-causal"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto"
          >
            <path
              d="M 1.5 1.8 L 8.5 5 L 1.5 8.2 z"
              fill={isLightTheme ? "#52525b" : "#94a3b8"}
              opacity="0.85"
            />
          </marker>
          <marker
            id="etg-arrow-opposite"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path
              d="M 1.2 1.5 L 8.8 5 L 1.2 8.5 z"
              fill={isLightTheme ? "#e11d48" : "#fb7185"}
            />
          </marker>
          <marker
            id="etg-dot-opposite"
            viewBox="0 0 10 10"
            refX="5"
            refY="5"
            markerWidth="5.5"
            markerHeight="5.5"
          >
            <circle
              cx="5"
              cy="5"
              r="3"
              fill={isLightTheme ? "#ffffff" : "#0b0c10"}
              stroke={isLightTheme ? "#e11d48" : "#fb7185"}
              strokeWidth="2"
            />
          </marker>
          <marker
            id="etg-arrow-supersedes"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6.8"
            markerHeight="6.8"
            orient="auto"
          >
            <path
              d="M 1.2 1.8 L 8.5 5 L 1.2 8.2 z"
              fill={isLightTheme ? "#9333ea" : "#c084fc"}
            />
          </marker>
          <marker
            id="etg-arrow-selected"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7.5"
            markerHeight="7.5"
            orient="auto"
          >
            <path
              d="M 1.2 1.5 L 8.8 5 L 1.2 8.5 z"
              fill={isLightTheme ? "#b45309" : "#fbbf24"}
            />
          </marker>
        </defs>

        {/* Dot-matrix canvas background */}
        <rect width="100%" height="100%" fill="url(#etg-dot-grid)" pointerEvents="none" />

        {/* World transform group */}
        <g
          transform={`translate(${viewportSize.width / 2 + camera.panX}, ${
            viewportSize.height / 2 + camera.panY
          }) scale(${camera.zoom})`}
        >
          {/* Regional area headers (de-overlapped & clickable to pan/zoom to region) */}
          {placedRegionHeaders2D.map(({ cluster, labelText, pillW, x, y, pillScale }) => {
            const isFocused = selectedRegionScope === cluster.id;
            return (
              <g
                key={`reg2d-${cluster.id}`}
                transform={`translate(${x}, ${y}) scale(${pillScale})`}
                className="cursor-pointer"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  panToRegion2D(cluster.id);
                  onChangeRegionScope?.(cluster.id);
                }}
              >
                <title>{cluster.label}</title>
                <rect
                  x={-pillW / 2}
                  y={-12}
                  width={pillW}
                  height={24}
                  rx={12}
                  fill={
                    isFocused
                      ? isLightTheme
                        ? "#fef3c7"
                        : "#451a03"
                      : isLightTheme
                        ? "rgba(255,255,255,0.92)"
                        : "rgba(15,19,29,0.9)"
                  }
                  stroke={
                    isFocused
                      ? isLightTheme
                        ? "#d97706"
                        : "#fbbf24"
                      : isLightTheme
                        ? "#d4d4d8"
                        : "rgba(255,255,255,0.16)"
                  }
                  strokeWidth={1}
                />
                <circle
                  cx={-pillW / 2 + 12}
                  cy={0}
                  r={3}
                  fill={isLightTheme ? "#d97706" : "#fbbf24"}
                />
                <text
                  x={5}
                  y={0}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9.5}
                  fontWeight={700}
                  letterSpacing="0.06em"
                  fill={
                    isFocused
                      ? isLightTheme
                        ? "#92400e"
                        : "#fde68a"
                      : isLightTheme
                        ? "#27272a"
                        : "#e4e4e7"
                  }
                >
                  {labelText}
                </text>
              </g>
            );
          })}

          {/* Curved Bezier edges with directional arrows & dipole emphasis */}
          {preparedEdges2D.map((item) => (
            <g
              key={item.edge.properties.uuid}
              className="cursor-pointer"
              onPointerEnter={() => setHoveredEdgeUuid(item.edge.properties.uuid)}
              onPointerLeave={() => setHoveredEdgeUuid(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEdge?.(item.edge);
              }}
            >
              {/* Invisible wider hit corridor for easy edge hovering and clicking */}
              <path
                d={item.edgePath}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                vectorEffect="non-scaling-stroke"
              />
              {item.isOpposite && (
                <path
                  d={item.edgePath}
                  fill="none"
                  stroke={isLightTheme ? "#fda4af" : "#fb7185"}
                  strokeWidth={item.strokeWidth + 4}
                  strokeOpacity={Math.min(0.28, item.opacity * 0.25)}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
              <path
                d={item.edgePath}
                fill="none"
                stroke={item.strokeColor}
                strokeWidth={item.strokeWidth}
                strokeDasharray={
                  item.isSupersedes || item.edge.type === "hypothesized_link"
                    ? "5 4"
                    : undefined
                }
                strokeOpacity={item.opacity}
                markerStart={item.markerStartId}
                markerEnd={item.markerEndId}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}

          {/* De-overlapped edge midpoint relationship pills rendered cleanly above edges */}
          {preparedEdges2D.map((item) => {
            if (!placedEdgePillIds2D.has(item.edge.properties.uuid)) return null;
            return (
              <g
                key={`pill-${item.edge.properties.uuid}`}
                transform={`translate(${item.pillX}, ${item.pillY})`}
                pointerEvents="none"
              >
                <rect
                  x={-(item.pillLabel.length * 3.1 + 10)}
                  y={-10}
                  width={item.pillLabel.length * 6.2 + 20}
                  height={20}
                  rx={3}
                  fill={isLightTheme ? "#ffffff" : "#11141d"}
                  stroke={item.strokeColor}
                  strokeWidth={1}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9}
                  fontWeight={600}
                  letterSpacing="0.05em"
                  fill={item.strokeColor}
                >
                  {item.pillLabel}
                </text>
              </g>
            );
          })}

          {/* Candidate latent links (dashed violet click-to-wire suggestions) */}
          {candidateLinks.map((suggestion, idx) => {
            const p1 = positions.get(suggestion.sourceUuid);
            const p2 = positions.get(suggestion.targetUuid);
            if (!p1 || !p2) return null;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy) || 1;
            const nx = -dy / dist;
            const ny = dx / dist;
            const bend = (idx % 2 === 0 ? -1 : 1) * Math.min(48, dist * 0.16);
            const cx = (p1.x + p2.x) / 2 + nx * bend;
            const cy = (p1.y + p2.y) / 2 + ny * bend;

            const { startPt, endPt } = computeEdgeEndpoints2D(
              p1,
              p2,
              { x: cx, y: cy },
              suggestion.sourceUuid,
              suggestion.targetUuid
            );
            const midX = 0.25 * startPt.x + 0.5 * cx + 0.25 * endPt.x;
            const midY = 0.25 * startPt.y + 0.5 * cy + 0.25 * endPt.y;
            const lagVal = suggestion.optimalLagSteps ?? 0;
            const statPart =
              suggestion.pearsonR !== undefined
                ? `r=${suggestion.pearsonR.toFixed(2)}`
                : `${Math.round(suggestion.score * 100)}%`;
            const ghostLabel =
              lagVal > 0
                ? `+ Wire · Δt=${lagVal}${suggestion.lagUnit?.[0] ?? ""} · ${statPart}`
                : `+ Wire · ${statPart}`;
            const ghostPath = `M ${startPt.x} ${startPt.y} Q ${cx} ${cy} ${endPt.x} ${endPt.y}`;

            return (
              <g
                key={`cand-${suggestion.sourceUuid}-${suggestion.targetUuid}`}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onAcceptCandidateLink?.(suggestion);
                }}
              >
                <path
                  d={ghostPath}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={ghostPath}
                  fill="none"
                  stroke="#a78bfa"
                  strokeWidth={1.8}
                  strokeDasharray="6 5"
                  strokeOpacity={0.82}
                  vectorEffect="non-scaling-stroke"
                />
                <g transform={`translate(${midX}, ${midY})`}>
                  <rect
                    x={-(ghostLabel.length * 3.1 + 10)}
                    y={-10}
                    width={ghostLabel.length * 6.2 + 20}
                    height={20}
                    rx={3}
                    fill={isLightTheme ? "#f5f3ff" : "#1b1630"}
                    stroke="#a78bfa"
                    strokeWidth={1.1}
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={9}
                    fontWeight={600}
                    fill={isLightTheme ? "#5b21b6" : "#ddd6fe"}
                  >
                    {ghostLabel}
                  </text>
                </g>
              </g>
            );
          })}

          {/* Active rubber-band link preview during Connect Mode */}
          {connectSourcePos && pointerWorldPos && (
            <line
              x1={connectSourcePos.x}
              y1={connectSourcePos.y}
              x2={pointerWorldPos.x}
              y2={pointerWorldPos.y}
              stroke="#fbbf24"
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeOpacity={0.88}
              pointerEvents="none"
            />
          )}

          {/* Nodes (Dots vs 248×64 Rich Scientific Cards) */}
          {nodes.map((node) => {
            const p = positions.get(node.uuid);
            if (!p) return null;

            const color = resolveEtgNodeColor(node);
            const isSelected = node.uuid === selectedNodeUuid;
            const isHovered = node.uuid === hoveredNodeUuid;
            const isConnectSource = connectSourceUuid === node.uuid;
            const isNeighbor = activeNeighbors ? activeNeighbors.has(node.uuid) : false;
            const isSearchHit = matchingUuids.has(node.uuid);

            let nodeOpacity = 1;
            if (hasSearch) {
              nodeOpacity = isSearchHit ? 1 : 0.22;
            } else if (activeFocusUuid) {
              nodeOpacity = isSelected || isHovered || isNeighbor || isConnectSource ? 1 : 0.28;
            } else if (regionSpotlight) {
              nodeOpacity = regionSpotlight.localNodeSet.has(node.uuid)
                ? 1
                : regionSpotlight.bridgeNodeSet.has(node.uuid)
                  ? 0.88
                  : 0.2;
            }

            if (detailTier === "dots") {
              const r = dotRadiusFor2D(node);
              const isSupersededDot =
                node.properties.status === "Superseded" ||
                Boolean(node.properties.superseded_by);
              const showDotLabel =
                isSelected ||
                isHovered ||
                isSearchHit ||
                placedDotLabelUuids2D.has(node.uuid);
              return (
                <g
                  key={node.uuid}
                  transform={`translate(${p.x}, ${p.y})`}
                  opacity={isSupersededDot && !isSelected && !isHovered ? nodeOpacity * 0.68 : nodeOpacity}
                  className="cursor-pointer"
                  onPointerDown={(e) => handleNodePointerDown(e, node)}
                  onPointerEnter={() => setHoveredNodeUuid(node.uuid)}
                  onPointerLeave={() => setHoveredNodeUuid(null)}
                  onClick={(e) => handleNodeInteractionClick(e, node)}
                >
                  {(isSelected || isHovered || isConnectSource) && (
                    <circle
                      r={r + 5 * Math.min(2, dotScale2D)}
                      fill="none"
                      stroke={isConnectSource ? "#fbbf24" : color}
                      strokeWidth={2 * Math.min(2, dotScale2D)}
                      strokeDasharray={isConnectSource ? "4 3" : undefined}
                      strokeOpacity={0.75}
                    />
                  )}
                  <circle
                    r={r}
                    fill={color}
                    stroke={isLightTheme ? "#ffffff" : "#0b0c10"}
                    strokeDasharray={isSupersededDot ? "3 2" : undefined}
                    strokeWidth={1.8 * Math.min(2, dotScale2D)}
                  />
                  {showDotLabel && (
                    <text
                      y={r + 14 * Math.min(2, dotScale2D)}
                      textAnchor="middle"
                      fontSize={10.5 * Math.min(2, dotScale2D)}
                      fontWeight={500}
                      fill={cardTitle}
                    >
                      {(() => {
                        const clean = humanizeNodeText(node.properties.name);
                        return clean.length > 28 ? `${clean.slice(0, 26)}…` : clean;
                      })()}
                    </text>
                  )}
                </g>
              );
            }

            const role = roleByNode[node.uuid];
            const hop = hopByNode[node.uuid];
            const isSuperseded =
              node.properties.status === "Superseded" || Boolean(node.properties.superseded_by);
            const microBadge = resolveMicroscopeNodeBadge(
              microscopeByNode[node.uuid],
              isLightTheme
            );
            const roleBadge =
              role === "root"
                ? {
                    text: "ROOT",
                    bg: isLightTheme ? "#fef3c7" : "#382810",
                    fg: isLightTheme ? "#92400e" : "#e2a856",
                  }
                : role === "upstream"
                  ? {
                      text: `DRV ${hop ?? 1}h`,
                      bg: isLightTheme ? "#e0f2fe" : "#082f49",
                      fg: isLightTheme ? "#075985" : "#38bdf8",
                    }
                  : role === "downstream"
                    ? {
                        text: `IMP ${hop ?? 1}h`,
                        bg: isLightTheme ? "#ffedd5" : "#451a03",
                        fg: isLightTheme ? "#9a3412" : "#fb923c",
                      }
                    : null;

            const statusOrMicroBadge = isSuperseded
              ? {
                  text: "OLD",
                  bg: isLightTheme ? "#f4f4f5" : "#27272a",
                  fg: isLightTheme ? "#52525b" : "#a1a1aa",
                }
              : microBadge
                ? {
                    text: microBadge.text,
                    bg: microBadge.bg,
                    fg: microBadge.fg,
                  }
                : null;

            const badgeCount = (roleBadge ? 1 : 0) + (statusOrMicroBadge ? 1 : 0);
            const cleanName = humanizeNodeText(node.properties.name);
            const maxChars = badgeCount === 2 ? 14 : badgeCount === 1 ? 20 : 28;
            const titleText =
              cleanName.length > maxChars ? `${cleanName.slice(0, maxChars - 2)}…` : cleanName;

            return (
              <g
                key={node.uuid}
                transform={`translate(${p.x}, ${p.y})`}
                opacity={isSuperseded && !isSelected && !isHovered ? nodeOpacity * 0.72 : nodeOpacity}
                className="cursor-pointer"
                onPointerDown={(e) => handleNodePointerDown(e, node)}
                onPointerEnter={() => setHoveredNodeUuid(node.uuid)}
                onPointerLeave={() => setHoveredNodeUuid(null)}
                onClick={(e) => handleNodeInteractionClick(e, node)}
              >
                {/* Glow ring for active selection, hover, or Connect source */}
                {(isSelected || isHovered || isConnectSource) && (
                  <rect
                    x={-CARD_WIDTH / 2 - 3.5}
                    y={-CARD_HEIGHT / 2 - 3.5}
                    width={CARD_WIDTH + 7}
                    height={CARD_HEIGHT + 7}
                    rx={10}
                    fill="none"
                    stroke={isConnectSource ? "#fbbf24" : color}
                    strokeDasharray={isConnectSource ? "5 3" : undefined}
                    strokeOpacity={isConnectSource ? 0.85 : 0.6}
                    strokeWidth={1.75}
                  />
                )}

                {/* Single-row card: ontology dot + node name */}
                <rect
                  x={-CARD_WIDTH / 2}
                  y={-CARD_HEIGHT / 2}
                  width={CARD_WIDTH}
                  height={CARD_HEIGHT}
                  rx={8}
                  fill={cardBg}
                  stroke={isConnectSource ? "#fbbf24" : isSelected || isHovered ? color : cardBorder}
                  strokeDasharray={isSuperseded ? "5 3" : undefined}
                  strokeWidth={isSelected || isConnectSource ? 1.6 : 1}
                />

                <circle cx={-CARD_WIDTH / 2 + 15} cy={0} r={4.5} fill={color} />

                <text
                  x={-CARD_WIDTH / 2 + 27}
                  y={0}
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={600}
                  fill={cardTitle}
                  textDecoration={isSuperseded ? "line-through" : undefined}
                  clipPath={
                    badgeCount === 2
                      ? "url(#etg-card-clip-double)"
                      : badgeCount === 1
                        ? "url(#etg-card-clip-badged)"
                        : "url(#etg-card-clip-full)"
                  }
                >
                  {titleText}
                </text>

                {statusOrMicroBadge && (
                  <g
                    transform={`translate(${
                      roleBadge ? CARD_WIDTH / 2 - 98 : CARD_WIDTH / 2 - 52
                    }, 0)`}
                  >
                    <rect
                      x={0}
                      y={-8}
                      width={42}
                      height={16}
                      rx={4}
                      fill={statusOrMicroBadge.bg}
                    />
                    <text
                      x={21}
                      y={0}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={7.5}
                      fontWeight={700}
                      fill={statusOrMicroBadge.fg}
                    >
                      {statusOrMicroBadge.text}
                    </text>
                  </g>
                )}

                {roleBadge && (
                  <g transform={`translate(${CARD_WIDTH / 2 - 52}, 0)`}>
                    <rect
                      x={0}
                      y={-8}
                      width={42}
                      height={16}
                      rx={4}
                      fill={roleBadge.bg}
                    />
                    <text
                      x={21}
                      y={0}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={8}
                      fontWeight={700}
                      fill={roleBadge.fg}
                    >
                      {roleBadge.text}
                    </text>
                  </g>
                )}

                {/* Clickable '+' output link port on right card edge */}
                {(onStartQuickConnect && (isHovered || isSelected || connectMode || isConnectSource)) && (
                  <g
                    transform={`translate(${CARD_WIDTH / 2}, 0)`}
                    className="cursor-crosshair"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (connectSourceUuid && connectSourceUuid !== node.uuid) {
                        const srcNode = nodes.find((n) => n.uuid === connectSourceUuid);
                        if (srcNode) {
                          onStartQuickConnect(srcNode, node);
                          return;
                        }
                      }
                      onStartQuickConnect(node);
                    }}
                  >
                    <title>Start causal link from {node.properties.name}</title>
                    <circle
                      cx={0}
                      cy={0}
                      r={8.5}
                      fill={isConnectSource ? "#fbbf24" : "#e2a856"}
                      stroke={isLightTheme ? "#ffffff" : "#0b0c10"}
                      strokeWidth={1.5}
                    />
                    <text
                      x={0}
                      y={0.5}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={11}
                      fontWeight={700}
                      fill="#12141a"
                    >
                      +
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Bottom-left Minimap + Camera Dock */}
      <div className="absolute bottom-3 left-3.5 z-10 flex flex-col items-start gap-2.5">
        <div
          className="etg-hud-pill overflow-hidden rounded-md bg-surface p-1"
          aria-label="2D graph overview minimap"
        >
          <svg
            width={mapW}
            height={mapH}
            className="block cursor-crosshair rounded-sm"
            onClick={(e) => {
              cancelCameraAnim2D();
              const rect = e.currentTarget.getBoundingClientRect();
              const clickX = e.clientX - rect.left - mapW / 2;
              const clickY = e.clientY - rect.top - mapH / 2;
              const worldX = mapCenterX + clickX / mapScale;
              const worldY = mapCenterY + clickY / mapScale;
              setCamera((prev) => ({
                ...prev,
                panX: -worldX * prev.zoom,
                panY: -worldY * prev.zoom,
              }));
            }}
          >
            {nodes.map((n) => {
              const p = positions.get(n.uuid);
              if (!p) return null;
              const mx = mapW / 2 + (p.x - mapCenterX) * mapScale;
              const my = mapH / 2 + (p.y - mapCenterY) * mapScale;
              return (
                <circle
                  key={n.uuid}
                  cx={mx}
                  cy={my}
                  r={n.uuid === selectedNodeUuid ? 3 : 2}
                  fill={resolveEtgNodeColor(n)}
                  opacity={n.uuid === selectedNodeUuid ? 1 : 0.72}
                />
              );
            })}

            {/* Current viewport box */}
            <rect
              x={mapW / 2 + (viewWorldX - viewWorldW / 2 - mapCenterX) * mapScale}
              y={mapH / 2 + (viewWorldY - viewWorldH / 2 - mapCenterY) * mapScale}
              width={Math.max(12, viewWorldW * mapScale)}
              height={Math.max(10, viewWorldH * mapScale)}
              fill="rgba(226, 168, 86, 0.08)"
              stroke="#e2a856"
              strokeWidth={1}
              rx={2}
            />
          </svg>
        </div>

        <GraphCameraDock
          showOrbitControls={false}
          onRecenter={() => recenterToFit(true)}
          onZoomIn={() => zoomAtCenter(1.25)}
          onZoomOut={() => zoomAtCenter(0.8)}
        />
      </div>
    </div>
  );
}
