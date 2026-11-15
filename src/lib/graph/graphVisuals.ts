import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGNodeLabel,
  ETGRelationshipType,
  RelationCategory,
  SubgraphNodeRole,
} from "@/types/etg";
import { classifyRelationCategory } from "@/lib/plainLanguage";
import {
  assignNodeRegions,
  computeCircularMeanLng,
  resolveSingleNodeRegion,
} from "./regionalSubgraph";

export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export type DetailTier = "dots" | "compact" | "full";
export type Layout2DMode = "force" | "causal_flow";

export const CARD_WIDTH = 248;
export const CARD_HEIGHT = 40;
export const MIN_ZOOM = 0.28;
export const MAX_ZOOM = 2.6;

export const ETG_LABEL_PALETTE: Record<
  ETGNodeLabel,
  { color: string; pillBgDark: string; pillBgLight: string; label: string }
> = {
  Concept: {
    color: "#e2a856",
    pillBgDark: "#382810",
    pillBgLight: "#fef3c7",
    label: "Concept",
  },
  Signal: {
    color: "#38bdf8",
    pillBgDark: "#082f49",
    pillBgLight: "#e0f2fe",
    label: "Signal",
  },
  Insight: {
    color: "#a78bfa",
    pillBgDark: "#2e1065",
    pillBgLight: "#f3e8ff",
    label: "Insight",
  },
  Rule: {
    color: "#34d399",
    pillBgDark: "#022c22",
    pillBgLight: "#d1fae5",
    label: "Rule",
  },
};

export const DATASET_BADGE_COLORS: Record<ETGDatasetId, string> = {
  nasa_power: "#f59e0b",
  wildfire: "#ef4444",
  ocean_temp: "#06b6d4",
  air_quality: "#ec4899",
  deforestation: "#22c55e",
  hydrology: "#3b82f6",
  community: "#a855f7",
};

const EDGE_RELATION_COLORS: Record<ETGRelationshipType, string> = {
  drives_opposite: "#f87171",
  corroborates: "#34d399",
  verified_by: "#34d399",
  teleconnects: "#a78bfa",
  correlates_with: "#818cf8",
  supersedes: "#fbbf24",
  supports: "#38bdf8",
  monitors: "#60a5fa",
  relates_to: "#94a3b8",
  leads: "#38bdf8",
  amplifies: "#fb923c",
  dampens: "#818cf8",
  advects_to: "#2dd4bf",
  triggers: "#f43f5e",
  impacts: "#facc15",
  hypothesized_link: "#c084fc",
};

export function resolveEtgNodeColor(node: ETGNode): string {
  if (node.properties.status === "Superseded") {
    return "#64748b";
  }
  return ETG_LABEL_PALETTE[node.label]?.color ?? "#94a3b8";
}

export function resolveEtgEdgeColor(type: ETGRelationshipType): string {
  return EDGE_RELATION_COLORS[type] ?? "#94a3b8";
}

export function formatEdgeRelationLabel(type: ETGRelationshipType, customLabel?: string): string {
  if (customLabel && customLabel.trim()) return customLabel.trim().toUpperCase();
  return type.replaceAll("_", " ").toUpperCase();
}

export function resolveDetailTier(zoom: number): DetailTier {
  if (zoom < 0.72) return "dots";
  if (zoom < 0.92) return "compact";
  return "full";
}

export function wheelZoomStep(currentZoom: number, deltaY: number): number {
  const clampedDelta = Math.max(-120, Math.min(120, deltaY));
  const factor = Math.exp(-clampedDelta * 0.0018);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom * factor));
}

/** Deterministic string hash in [0, 1) */
function hash01(input: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Generates a crisp circular sprite canvas with a soft ambient aura and clean border ring,
 * matching the simple, high-contrast dot aesthetic of Blueprint Nexus.
 */
export function createEtgNodeCanvas(
  hexColor: string,
  isLightTheme: boolean,
  isAnchorHub = false
): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const s = size / 512;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 200 * s;

  ctx.clearRect(0, 0, size, size);

  if (isAnchorHub) {
    ctx.save();
    ctx.shadowBlur = Math.round((isLightTheme ? 36 : 54) * s);
    ctx.shadowColor = hexColor;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (isLightTheme ? 0.88 : 0.9), 0, Math.PI * 2);
    ctx.fillStyle = hexColor;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, radius * (isLightTheme ? 0.84 : 0.86), 0, Math.PI * 2);
    ctx.fillStyle = hexColor;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius * (isLightTheme ? 0.84 : 0.86), 0, Math.PI * 2);
    ctx.strokeStyle = isLightTheme ? "rgba(15, 23, 42, 0.82)" : "rgba(255, 255, 255, 0.75)";
    ctx.lineWidth = Math.max(1, Math.round((isLightTheme ? 14 : 12) * s));
    ctx.stroke();
  } else {
    ctx.save();
    ctx.shadowBlur = Math.round((isLightTheme ? 20 : 38) * s);
    ctx.shadowColor = hexColor;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (isLightTheme ? 0.92 : 1.0), 0, Math.PI * 2);
    ctx.fillStyle = hexColor;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, radius * (isLightTheme ? 0.92 : 1.0), 0, Math.PI * 2);
    ctx.strokeStyle = isLightTheme ? "rgba(15, 23, 42, 0.38)" : "rgba(255, 255, 255, 0.42)";
    ctx.lineWidth = Math.max(1, Math.round((isLightTheme ? 16 : 12) * s));
    ctx.stroke();
  }

  return canvas;
}

export function createEtgHaloCanvas(hexColor: string): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const cx = size / 2;
  const cy = size / 2;

  const grad = ctx.createRadialGradient(cx, cy, size * 0.18, cx, cy, size * 0.49);
  grad.addColorStop(0, `${hexColor}00`);
  grad.addColorStop(0.45, `${hexColor}66`);
  grad.addColorStop(0.62, "#ffffffaa");
  grad.addColorStop(0.75, `${hexColor}44`);
  grad.addColorStop(1, `${hexColor}00`);

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.49, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}


export interface RegionCluster3D {
  id: string;
  label: string;
  centroid: Point3D;
  radius: number;
  count: number;
  nodeUuids: string[];
}

export interface RegionCluster2D {
  id: string;
  label: string;
  centroid: Point2D;
  minY: number;
  count: number;
  nodeUuids: string[];
}

/**
 * Resolves a node's canonical spatial region/area bucket for regional graph clustering.
 */
export function resolveNodeRegionGroup(node: ETGNode): { id: string; label: string } {
  return resolveSingleNodeRegion(node);
}

/**
 * Resolves consistent region assignments across a whole node set, snapping
 * coordinate-pinned and unlabelled geo nodes to nearby named regions or macro
 * Earth geographic basins.
 */
export function buildRegionAssignmentMap(
  nodes: readonly ETGNode[],
  maxSnapKm = 1200
): Map<string, { id: string; label: string }> {
  return assignNodeRegions(nodes, maxSnapKm);
}

/**
 * Filters ETG nodes and edges consistently across graph toolbar counters, region dropdowns,
 * and 3D/2D canvases so UI region filters never diverge from rendered clusters.
 */
export function filterEtgGraphData(
  nodes: readonly ETGNode[],
  edges: readonly ETGEdge[],
  onlyOpposite: boolean,
  showSuperseded: boolean,
  enabledRelationCategories?: ReadonlyArray<RelationCategory>
): { visibleNodes: ETGNode[]; visibleEdges: ETGEdge[] } {
  const filteredNodes = showSuperseded
    ? [...nodes]
    : nodes.filter((n) => n.properties.status !== "Superseded");
  const nodeIds = new Set(filteredNodes.map((n) => n.uuid));
  const allowedCatSet = enabledRelationCategories
    ? new Set(enabledRelationCategories)
    : null;

  const validEdges = edges.filter((e) => {
    if (!nodeIds.has(e.source_uuid) || !nodeIds.has(e.target_uuid)) return false;
    if (onlyOpposite && e.type !== "drives_opposite") return false;
    if (!onlyOpposite && allowedCatSet && !allowedCatSet.has(classifyRelationCategory(e.type))) {
      return false;
    }
    return true;
  });

  if (!onlyOpposite) {
    return { visibleNodes: filteredNodes, visibleEdges: validEdges };
  }

  const connectedIds = new Set<string>();
  for (const e of validEdges) {
    connectedIds.add(e.source_uuid);
    connectedIds.add(e.target_uuid);
  }
  return {
    visibleNodes: filteredNodes.filter((n) => connectedIds.has(n.uuid)),
    visibleEdges: validEdges,
  };
}

function computeClusterGeoMean(
  members: readonly ETGNode[]
): { lat: number; lng: number } | null {
  let sumLat = 0;
  const lngs: number[] = [];
  for (const m of members) {
    const lat = m.properties.lat;
    const lng = m.properties.lng;
    if (
      typeof lat === "number" &&
      typeof lng === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
    ) {
      sumLat += lat;
      lngs.push(lng);
    }
  }
  return lngs.length > 0
    ? { lat: sumLat / lngs.length, lng: computeCircularMeanLng(lngs) }
    : null;
}

/**
 * Computes the bounding center and radius of a 3D node position map so the
 * initial camera and Recenter action always frame every regional cluster cleanly.
 */
export function computeGraphBoundingSphere3D(positions: Map<string, Point3D>): {
  center: Point3D;
  radius: number;
} {
  if (positions.size === 0) {
    return { center: { x: 0, y: 0, z: 0 }, radius: 120 };
  }
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const p of positions.values()) {
    sx += p.x;
    sy += p.y;
    sz += p.z;
  }
  const n = positions.size;
  const center = { x: sx / n, y: sy / n, z: sz / n };
  let maxDist = 48;
  for (const p of positions.values()) {
    const d = Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z);
    if (d > maxDist) maxDist = d;
  }
  return { center, radius: maxDist };
}

/**
 * Computes 3D region centroids and bounding radii for area labels & camera fly-to targets.
 */
export function computeRegionClusters3D(
  nodes: readonly ETGNode[],
  positions: Map<string, Point3D>
): RegionCluster3D[] {
  const assignments = buildRegionAssignmentMap(nodes);
  const groups = new Map<string, { label: string; pts: Point3D[]; uuids: string[] }>();

  for (const node of nodes) {
    const pos = positions.get(node.uuid);
    if (!pos) continue;
    const { id, label } = assignments.get(node.uuid) ?? resolveNodeRegionGroup(node);
    let entry = groups.get(id);
    if (!entry) {
      entry = { label, pts: [], uuids: [] };
      groups.set(id, entry);
    }
    entry.pts.push(pos);
    entry.uuids.push(node.uuid);
  }

  const clusters: RegionCluster3D[] = [];
  for (const [id, entry] of groups.entries()) {
    const n = entry.pts.length;
    if (n === 0) continue;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const p of entry.pts) {
      sx += p.x;
      sy += p.y;
      sz += p.z;
    }
    const centroid = { x: sx / n, y: sy / n, z: sz / n };
    let maxDist = 18;
    for (const p of entry.pts) {
      const d = Math.hypot(p.x - centroid.x, p.y - centroid.y, p.z - centroid.z);
      if (d > maxDist) maxDist = d;
    }
    clusters.push({
      id,
      label: entry.label,
      centroid,
      radius: maxDist,
      count: n,
      nodeUuids: entry.uuids,
    });
  }

  return clusters.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Computes 2D region centroids and top edge Y for area labels & 2D pan/zoom focus.
 */
export function computeRegionClusters2D(
  nodes: readonly ETGNode[],
  positions: Map<string, Point2D>
): RegionCluster2D[] {
  const assignments = buildRegionAssignmentMap(nodes);
  const groups = new Map<string, { label: string; pts: Point2D[]; uuids: string[] }>();

  for (const node of nodes) {
    const pos = positions.get(node.uuid);
    if (!pos) continue;
    const { id, label } = assignments.get(node.uuid) ?? resolveNodeRegionGroup(node);
    let entry = groups.get(id);
    if (!entry) {
      entry = { label, pts: [], uuids: [] };
      groups.set(id, entry);
    }
    entry.pts.push(pos);
    entry.uuids.push(node.uuid);
  }

  const clusters: RegionCluster2D[] = [];
  for (const [id, entry] of groups.entries()) {
    const n = entry.pts.length;
    if (n === 0) continue;
    let sx = 0;
    let sy = 0;
    let minY = Infinity;
    for (const p of entry.pts) {
      sx += p.x;
      sy += p.y;
      if (p.y < minY) minY = p.y;
    }
    clusters.push({
      id,
      label: entry.label,
      centroid: { x: sx / n, y: sy / n },
      minY,
      count: n,
      nodeUuids: entry.uuids,
    });
  }

  return clusters.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Regional 3D constellation layout:
 * Places each distinct region in its own area of 3D space with guaranteed anchor separation,
 * keeping intra-region nodes cohesive while cross-region edges remain visibly connected across space.
 */
export function computeLayout3D(nodes: ETGNode[], edges: ETGEdge[]): Map<string, Point3D> {
  const pos = new Map<string, Point3D>();
  if (nodes.length === 0) return pos;

  const assignments = buildRegionAssignmentMap(nodes);
  const clusters = new Map<string, ETGNode[]>();
  const nodeRegionId = new Map<string, string>();
  for (const node of nodes) {
    const { id } = assignments.get(node.uuid) ?? resolveNodeRegionGroup(node);
    nodeRegionId.set(node.uuid, id);
    const list = clusters.get(id);
    if (list) list.push(node);
    else clusters.set(id, [node]);
  }

  const clusterAnchors = new Map<string, Point3D>();
  const clusterKeys = Array.from(clusters.keys()).sort();
  const spread = Math.max(150, Math.sqrt(Math.max(1, clusterKeys.length)) * 96);
  const geoMeans3D = new Map<string, { lat: number; lng: number } | null>();
  let hasGeoClusters3D = false;
  for (const key of clusterKeys) {
    const geo = key.startsWith("__") ? null : computeClusterGeoMean(clusters.get(key) ?? []);
    geoMeans3D.set(key, geo);
    if (geo) hasGeoClusters3D = true;
  }

  for (const key of clusterKeys) {
    const geo = geoMeans3D.get(key) ?? null;
    if (geo) {
      const nx = Math.max(-1, Math.min(1, geo.lng / 165));
      const ny = Math.max(-1, Math.min(1, geo.lat / 78));
      const nz = Math.cos((geo.lng * Math.PI) / 180) * 0.52 + (hash01(key, 37) - 0.5) * 0.35;
      clusterAnchors.set(key, {
        x: nx * spread * 1.15,
        y: ny * spread * 0.82,
        z: nz * spread * 0.75,
      });
    } else if (hasGeoClusters3D) {
      clusterAnchors.set(key, {
        x: (hash01(key, 11) - 0.5) * 80,
        y: (hash01(key, 23) - 0.5) * 70,
        z: (hash01(key, 37) - 0.5) * 80,
      });
    } else {
      const rx = (hash01(key, 11) - 0.5) * 2;
      const ry = (hash01(key, 23) - 0.5) * 1.3;
      const rz = (hash01(key, 37) - 0.5) * 2;
      clusterAnchors.set(key, {
        x: rx * spread,
        y: ry * spread * 0.68,
        z: rz * spread,
      });
    }
  }

  // Enforce cluster-size-aware separation between regional anchors so areas never collapse into one blob
  for (let pass = 0; pass < 28; pass++) {
    for (let i = 0; i < clusterKeys.length; i++) {
      const aKey = clusterKeys[i];
      const a = clusterAnchors.get(aKey)!;
      const aMembers = clusters.get(aKey)?.length ?? 1;
      for (let j = i + 1; j < clusterKeys.length; j++) {
        const bKey = clusterKeys[j];
        const b = clusterAnchors.get(bKey)!;
        const bMembers = clusters.get(bKey)?.length ?? 1;
        const minDist = 115 + (Math.sqrt(aMembers) + Math.sqrt(bMembers)) * 22;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dy, dz) || 0.01;
        if (d < minDist) {
          const push = ((minDist - d) / d) * 0.5;
          a.x -= dx * push;
          a.y -= dy * push;
          a.z -= dz * push;
          b.x += dx * push;
          b.y += dy * push;
          b.z += dz * push;
        }
      }
    }
  }

  for (const node of nodes) {
    const regId = nodeRegionId.get(node.uuid)!;
    const anchor = clusterAnchors.get(regId) ?? { x: 0, y: 0, z: 0 };
    const memberCount = clusters.get(regId)?.length ?? 1;
    const jitterScale = 22 + Math.sqrt(memberCount) * 10 + hash01(node.uuid, 7) * 14;
    const jx = (hash01(node.uuid, 13) - 0.5) * 2 * jitterScale;
    const jy = (hash01(node.uuid, 19) - 0.5) * 2 * jitterScale * 0.78;
    const jz = (hash01(node.uuid, 29) - 0.5) * 2 * jitterScale;

    pos.set(node.uuid, {
      x: anchor.x + jx,
      y: anchor.y + jy,
      z: anchor.z + jz,
    });
  }

  // Force relaxation: tight intra-region topology + light cross-region bridges + anchor tether
  const iterations = 52;
  const repulseStrength = 2600;

  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map<string, Point3D>();
    for (const n of nodes) forces.set(n.uuid, { x: 0, y: 0, z: 0 });

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const pa = pos.get(a.uuid)!;
      const fa = forces.get(a.uuid)!;

      // Tether gently to this node's regional area anchor
      const anchor = clusterAnchors.get(nodeRegionId.get(a.uuid)!);
      if (anchor) {
        fa.x += (anchor.x - pa.x) * 0.024;
        fa.y += (anchor.y - pa.y) * 0.024;
        fa.z += (anchor.z - pa.z) * 0.024;
      }

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const pb = pos.get(b.uuid)!;
        const fb = forces.get(b.uuid)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const dz = pa.z - pb.z;
        const distSq = dx * dx + dy * dy + dz * dz + 140;
        const dist = Math.sqrt(distSq);
        const f = repulseStrength / distSq;
        const ux = (dx / dist) * f;
        const uy = (dy / dist) * f;
        const uz = (dz / dist) * f;
        fa.x += ux;
        fa.y += uy;
        fa.z += uz;
        fb.x -= ux;
        fb.y -= uy;
        fb.z -= uz;
      }
    }

    // Spring attraction: strong within region, gentle across regions so regions stay distinct
    for (const e of edges) {
      const pa = pos.get(e.source_uuid);
      const pb = pos.get(e.target_uuid);
      if (!pa || !pb) continue;
      const sameRegion = nodeRegionId.get(e.source_uuid) === nodeRegionId.get(e.target_uuid);
      const idealLen = sameRegion ? 46 : 155;
      const springStrength = sameRegion ? 0.048 : 0.005;

      const fa = forces.get(e.source_uuid)!;
      const fb = forces.get(e.target_uuid)!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dz = pb.z - pa.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const stretch = (dist - idealLen) * springStrength;
      const ux = (dx / dist) * stretch;
      const uy = (dy / dist) * stretch;
      const uz = (dz / dist) * stretch;
      fa.x += ux;
      fa.y += uy;
      fa.z += uz;
      fb.x -= ux;
      fb.y -= uy;
      fb.z -= uz;
    }

    const damping = 0.72 * (1 - iter / (iterations * 1.35));
    for (const n of nodes) {
      const p = pos.get(n.uuid)!;
      const f = forces.get(n.uuid)!;
      p.x += Math.max(-15, Math.min(15, f.x * damping));
      p.y += Math.max(-15, Math.min(15, f.y * damping));
      p.z += Math.max(-15, Math.min(15, f.z * damping));
    }
  }

  return pos;
}

export interface ComputeLayout2DOptions {
  mode?: Layout2DMode;
  rootUuid?: string | null;
  roleByNode?: Record<string, SubgraphNodeRole>;
  hopByNode?: Record<string, number>;
}

/**
 * Computes a well-spaced 2D layout (`force` or `causal_flow`) with explicit rectangular
 * card collision resolution so node cards never overlap at default zoom.
 */
export function computeLayout2D(
  nodes: ETGNode[],
  edges: ETGEdge[],
  options: ComputeLayout2DOptions = {}
): {
  positions: Map<string, Point2D>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
} {
  const pos = new Map<string, Point2D>();
  if (nodes.length === 0) {
    return {
      positions: pos,
      bounds: { minX: -200, maxX: 200, minY: -200, maxY: 200 },
    };
  }

  const mode: Layout2DMode = options.mode ?? "force";

  if (mode === "causal_flow") {
    // Assign horizontal causal layer: upstream drivers (< 0), root/hub (0), downstream impacts (> 0)
    const layerByUuid = new Map<string, number>();
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const n of nodes) {
      inDeg.set(n.uuid, 0);
      outDeg.set(n.uuid, 0);
    }
    for (const e of edges) {
      if (e.source_uuid === e.target_uuid) continue;
      outDeg.set(e.source_uuid, (outDeg.get(e.source_uuid) ?? 0) + 1);
      inDeg.set(e.target_uuid, (inDeg.get(e.target_uuid) ?? 0) + 1);
    }

    for (const n of nodes) {
      const role = options.roleByNode?.[n.uuid];
      const hop = options.hopByNode?.[n.uuid] ?? 1;
      if (options.rootUuid && n.uuid === options.rootUuid) {
        layerByUuid.set(n.uuid, 0);
      } else if (role === "upstream") {
        layerByUuid.set(n.uuid, -Math.max(1, hop));
      } else if (role === "downstream") {
        layerByUuid.set(n.uuid, Math.max(1, hop));
      } else if (role === "bidirectional") {
        layerByUuid.set(n.uuid, hop === 0 ? 0 : 1);
      } else {
        const i = inDeg.get(n.uuid) ?? 0;
        const o = outDeg.get(n.uuid) ?? 0;
        if (o > 0 && i === 0) layerByUuid.set(n.uuid, -1);
        else if (i > 0 && o === 0) layerByUuid.set(n.uuid, 1);
        else if (i + o === 0) layerByUuid.set(n.uuid, 2);
        else layerByUuid.set(n.uuid, o > i ? -1 : i > o ? 1 : 0);
      }
    }

    const columns = new Map<number, ETGNode[]>();
    for (const n of nodes) {
      const col = layerByUuid.get(n.uuid) ?? 0;
      const bucket = columns.get(col) ?? [];
      bucket.push(n);
      columns.set(col, bucket);
    }

    const colSpacing = CARD_WIDTH + 96;
    const rowSpacing = CARD_HEIGHT + 34;
    for (const [col, colNodes] of columns.entries()) {
      colNodes.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
      const count = colNodes.length;
      colNodes.forEach((n, idx) => {
        pos.set(n.uuid, {
          x: col * colSpacing,
          y: (idx - (count - 1) / 2) * rowSpacing,
        });
      });
    }
  } else {
    // Seed each region in its own distinct 2D area so regions form labeled neighborhoods
    const assignments2D = buildRegionAssignmentMap(nodes);
    const regionBuckets = new Map<string, ETGNode[]>();
    const nodeRegionId = new Map<string, string>();
    for (const node of nodes) {
      const { id } = assignments2D.get(node.uuid) ?? resolveNodeRegionGroup(node);
      nodeRegionId.set(node.uuid, id);
      const list = regionBuckets.get(id);
      if (list) list.push(node);
      else regionBuckets.set(id, [node]);
    }

    const regionKeys = Array.from(regionBuckets.keys()).sort();
    const regionAnchors = new Map<string, Point2D>();
    const spread2D = Math.max(460, Math.sqrt(Math.max(1, regionKeys.length)) * 380);
    const geoMeans2D = new Map<string, { lat: number; lng: number } | null>();
    let hasGeoClusters2D = false;
    for (const key of regionKeys) {
      const geo = key.startsWith("__") ? null : computeClusterGeoMean(regionBuckets.get(key) ?? []);
      geoMeans2D.set(key, geo);
      if (geo) hasGeoClusters2D = true;
    }

    for (const key of regionKeys) {
      const geo = geoMeans2D.get(key) ?? null;
      if (geo) {
        const nx = Math.max(-1, Math.min(1, geo.lng / 165));
        const ny = Math.max(-1, Math.min(1, -geo.lat / 78));
        regionAnchors.set(key, {
          x: nx * spread2D * 1.18,
          y: ny * spread2D * 0.85,
        });
      } else if (hasGeoClusters2D) {
        regionAnchors.set(key, {
          x: (hash01(key, 17) - 0.5) * 260,
          y: (hash01(key, 41) - 0.5) * 200,
        });
      } else {
        regionAnchors.set(key, {
          x: (hash01(key, 17) - 0.5) * 2 * spread2D,
          y: (hash01(key, 41) - 0.5) * 2 * spread2D * 0.72,
        });
      }
    }

    // Separate 2D region anchors proportional to cluster size so regional cards never interleave
    for (let pass = 0; pass < 28; pass++) {
      for (let i = 0; i < regionKeys.length; i++) {
        const aKey = regionKeys[i];
        const a = regionAnchors.get(aKey)!;
        const radA = 185 + Math.sqrt(regionBuckets.get(aKey)?.length ?? 1) * 145;
        for (let j = i + 1; j < regionKeys.length; j++) {
          const bKey = regionKeys[j];
          const b = regionAnchors.get(bKey)!;
          const radB = 185 + Math.sqrt(regionBuckets.get(bKey)?.length ?? 1) * 145;
          const minDist = radA + radB + 140;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d < minDist) {
            const push = ((minDist - d) / d) * 0.5;
            a.x -= dx * push;
            a.y -= dy * push;
            b.x += dx * push;
            b.y += dy * push;
          }
        }
      }
    }

    nodes.forEach((node) => {
      const anchor = regionAnchors.get(nodeRegionId.get(node.uuid)!) ?? { x: 0, y: 0 };
      const jx = (hash01(node.uuid, 31) - 0.5) * 260;
      const jy = (hash01(node.uuid, 53) - 0.5) * 180;
      pos.set(node.uuid, {
        x: anchor.x + jx,
        y: anchor.y + jy,
      });
    });

    // Spring + repulsion pass in 2D space (tight intra-region, gentle cross-region)
    const iterations = 60;
    for (let iter = 0; iter < iterations; iter++) {
      const forces = new Map<string, Point2D>();
      for (const n of nodes) forces.set(n.uuid, { x: 0, y: 0 });

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const pa = pos.get(a.uuid)!;
        const fa = forces.get(a.uuid)!;

        const anchor = regionAnchors.get(nodeRegionId.get(a.uuid)!);
        if (anchor) {
          fa.x += (anchor.x - pa.x) * 0.018;
          fa.y += (anchor.y - pa.y) * 0.018;
        }

        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const pb = pos.get(b.uuid)!;
          const fb = forces.get(b.uuid)!;
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const distSq = dx * dx + dy * dy + 1600;
          const dist = Math.sqrt(distSq);
          const rep = 48000 / distSq;
          const ux = (dx / dist) * rep;
          const uy = (dy / dist) * rep;
          fa.x += ux;
          fa.y += uy;
          fb.x -= ux;
          fb.y -= uy;
        }
      }

      for (const e of edges) {
        const pa = pos.get(e.source_uuid);
        const pb = pos.get(e.target_uuid);
        if (!pa || !pb) continue;
        const sameRegion = nodeRegionId.get(e.source_uuid) === nodeRegionId.get(e.target_uuid);
        const ideal = sameRegion ? 235 : 460;
        const strength = sameRegion ? 0.048 : 0.01;
        const fa = forces.get(e.source_uuid)!;
        const fb = forces.get(e.target_uuid)!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const pull = (dist - ideal) * strength;
        const ux = (dx / dist) * pull;
        const uy = (dy / dist) * pull;
        fa.x += ux;
        fa.y += uy;
        fb.x -= ux;
        fb.y -= uy;
      }

      const damp = 0.65 * (1 - iter / (iterations * 1.3));
      for (const n of nodes) {
        const p = pos.get(n.uuid)!;
        const f = forces.get(n.uuid)!;
        p.x += Math.max(-28, Math.min(28, f.x * damp));
        p.y += Math.max(-28, Math.min(28, f.y * damp));
      }
    }
  }

  // Deterministic rectangular AABB de-overlap pass for CARD_WIDTH × CARD_HEIGHT cards + padding
  const minDx = CARD_WIDTH + 30;
  const minDy = CARD_HEIGHT + 26;
  for (let pass = 0; pass < 64; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const pa = pos.get(nodes[i].uuid)!;
      for (let j = i + 1; j < nodes.length; j++) {
        const pb = pos.get(nodes[j].uuid)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const overlapX = minDx - Math.abs(dx);
        const overlapY = minDy - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          moved = true;
          if (mode === "causal_flow") {
            // Preserve column horizontal ordering when separating vertical collisions
            const signY = dy === 0 ? (i < j ? -1 : 1) : dy > 0 ? 1 : -1;
            const push = overlapY * 0.54 * signY;
            pa.y += push;
            pb.y -= push;
          } else if (overlapX * 0.55 < overlapY) {
            const sign = dx === 0 ? (i < j ? -1 : 1) : dx > 0 ? 1 : -1;
            const push = overlapX * 0.52 * sign;
            pa.x += push;
            pb.x -= push;
          } else {
            const sign = dy === 0 ? (i < j ? -1 : 1) : dy > 0 ? 1 : -1;
            const push = overlapY * 0.52 * sign;
            pa.y += push;
            pb.y -= push;
          }
        }
      }
    }
    if (!moved) break;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x - CARD_WIDTH / 2);
    maxX = Math.max(maxX, p.x + CARD_WIDTH / 2);
    minY = Math.min(minY, p.y - CARD_HEIGHT / 2);
    maxY = Math.max(maxY, p.y + CARD_HEIGHT / 2);
  }

  return {
    positions: pos,
    bounds: {
      minX: minX - 80,
      maxX: maxX + 80,
      minY: minY - 80,
      maxY: maxY + 80,
    },
  };
}

export interface ScreenLabelCandidate {
  uuid: string;
  title: string;
  label: ETGNodeLabel;
  color: string;
  x: number;
  y: number;
  priority: number;
}

export interface PlacedScreenLabel extends ScreenLabelCandidate {
  width: number;
  height: number;
}

/**
 * Selects a collision-free subset of screen-space pill labels in priority order
 * so 3D node pills never pile on top of each other.
 */
export function selectNonOverlappingLabels(
  candidates: ScreenLabelCandidate[],
  maxLabels = 18,
  padX = 10,
  padY = 8
): PlacedScreenLabel[] {
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority);
  const placed: PlacedScreenLabel[] = [];

  for (const cand of sorted) {
    if (placed.length >= maxLabels) break;
    const textWidth = Math.min(188, Math.max(76, cand.title.length * 6.4 + 24));
    const boxHeight = 22;

    const left = cand.x - textWidth / 2;
    const right = cand.x + textWidth / 2;
    const top = cand.y - boxHeight;
    const bottom = cand.y;

    let collides = false;
    for (const existing of placed) {
      const exLeft = existing.x - existing.width / 2 - padX;
      const exRight = existing.x + existing.width / 2 + padX;
      const exTop = existing.y - existing.height - padY;
      const exBottom = existing.y + padY;

      if (left < exRight && right > exLeft && top < exBottom && bottom > exTop) {
        collides = true;
        break;
      }
    }

    if (!collides) {
      placed.push({
        ...cand,
        width: textWidth,
        height: boxHeight,
      });
    }
  }

  return placed;
}
