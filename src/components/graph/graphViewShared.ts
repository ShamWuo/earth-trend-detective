"use client";

import { useEffect, useState } from "react";
import type { Layout2DMode, Point2D } from "@/lib/graph/graphVisuals";
import type {
  CandidateLinkSuggestion,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  SubgraphNodeRole,
  TraversalDirection,
} from "@/types/etg";

export interface TraversalFilterState {
  maxHops: number | null;
  direction: TraversalDirection;
  layoutMode: Layout2DMode;
}

export const DEFAULT_TRAVERSAL_FILTER: TraversalFilterState = {
  maxHops: null,
  direction: "both",
  layoutMode: "force",
};

export interface RegionSpotlightState {
  localNodeSet: Set<string>;
  bridgeNodeSet: Set<string>;
  spotlightEdgeSet: Set<string>;
}

export interface GraphCanvasProps {
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

export function resolveMicroscopeNodeBadge(
  cue: NodeTrendMicroscopeCue | undefined,
  isLightTheme: boolean
): { text: string; title: string; pillClass: string; bg: string; fg: string } | null {
  if (!cue) return null;
  if (cue.dealiasing.falseTrendProb >= 0.55 || cue.radarBadge === "FALSE_TREND_CYCLE") {
    return {
      text: "CYCLE",
      title: `Possible seasonal/oscillatory cycle (${Math.round(cue.dealiasing.oscillationShare * 100)}% cycle share, P_false=${Math.round(cue.dealiasing.falseTrendProb * 100)}%)`,
      pillClass: "bg-amber-950 text-amber-300",
      bg: isLightTheme ? "#fef3c7" : "#451a03",
      fg: isLightTheme ? "#92400e" : "#fcd34d",
    };
  }
  if (cue.radarBadge === "SENSOR_GLITCH_RISK") {
    return {
      text: "GLITCH",
      title: `Step-shift or sensor artifact risk (${Math.round(cue.dealiasing.artifactShare * 100)}% artifact share)`,
      pillClass: "bg-rose-950 text-rose-300",
      bg: isLightTheme ? "#ffe4e6" : "#4c0519",
      fg: isLightTheme ? "#be123c" : "#fda4af",
    };
  }
  if (cue.preMannKendallAlert || cue.radarBadge === "EARLY_ONSET") {
    return {
      text: "PRE-MK",
      title: `Pre-Mann-Kendall early inflection (${Math.round(cue.onsetProb * 100)}% onset prob, +${cue.leadStepsAhead} step lead)`,
      pillClass: "bg-sky-950 text-sky-300",
      bg: isLightTheme ? "#e0f2fe" : "#082f49",
      fg: isLightTheme ? "#075985" : "#38bdf8",
    };
  }
  return null;
}

export function formatTrendStat(
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

export function intersectBoxBorder(
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

export function useIsLightTheme(): boolean {
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

export function buildNeighborMap(nodes: ETGNode[], edges: ETGEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const n of nodes) map.set(n.uuid, new Set());
  for (const e of edges) {
    map.get(e.source_uuid)?.add(e.target_uuid);
    map.get(e.target_uuid)?.add(e.source_uuid);
  }
  return map;
}

export function buildSearchMatchSet(nodes: ETGNode[], searchQuery: string): Set<string> {
  if (!searchQuery) return new Set<string>();
  const hits = new Set<string>();
  for (const n of nodes) {
    const text = `${n.properties.name} ${n.label} ${n.properties.region ?? ""} ${n.properties.dataset ?? ""} ${(n.properties.domain_tags ?? []).join(" ")}`.toLowerCase();
    if (text.includes(searchQuery)) hits.add(n.uuid);
  }
  return hits;
}

export function buildDipoleNodeSet(edges: ETGEdge[]): Set<string> {
  const set = new Set<string>();
  for (const e of edges) {
    if (e.type === "drives_opposite") {
      set.add(e.source_uuid);
      set.add(e.target_uuid);
    }
  }
  return set;
}

export function dispatchNodeSelectOrQuickConnect(params: {
  clickedNode: ETGNode;
  connectMode: boolean;
  shiftKey: boolean;
  connectSourceUuid: string | null;
  selectedNodeUuid: string | null;
  lookupNode: (uuid: string) => ETGNode | undefined;
  onStartQuickConnect?: (sourceNode: ETGNode, targetNode?: ETGNode) => void;
  onSelectNode: (node: ETGNode) => void;
}): void {
  const {
    clickedNode,
    connectMode,
    shiftKey,
    connectSourceUuid,
    selectedNodeUuid,
    lookupNode,
    onStartQuickConnect,
    onSelectNode,
  } = params;
  if ((connectMode || shiftKey) && onStartQuickConnect) {
    if (connectSourceUuid && connectSourceUuid !== clickedNode.uuid) {
      const srcNode = lookupNode(connectSourceUuid);
      if (srcNode) {
        onStartQuickConnect(srcNode, clickedNode);
        return;
      }
    } else if (shiftKey && selectedNodeUuid && selectedNodeUuid !== clickedNode.uuid) {
      const srcNode = lookupNode(selectedNodeUuid);
      if (srcNode) {
        onStartQuickConnect(srcNode, clickedNode);
        return;
      }
    }
    onStartQuickConnect(clickedNode);
    return;
  }
  onSelectNode(clickedNode);
}
