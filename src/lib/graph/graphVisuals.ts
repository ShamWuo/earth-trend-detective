import type { ETGDatasetId, ETGEdge, ETGNode, ETGNodeLabel, ETGRelationshipType } from "@/types/etg";

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

export const CARD_WIDTH = 216;
export const CARD_HEIGHT = 44;
export const MIN_ZOOM = 0.28;
export const MAX_ZOOM = 2.6;

export const ETG_LABEL_PALETTE: Record<
  ETGNodeLabel,
  { color: string; pillBgDark: string; pillBgLight: string; label: string }
> = {
  Concept: {
    color: "#e2a856",
    pillBgDark: "rgba(226, 168, 86, 0.14)",
    pillBgLight: "rgba(180, 120, 32, 0.12)",
    label: "Concept",
  },
  Signal: {
    color: "#38bdf8",
    pillBgDark: "rgba(56, 189, 248, 0.14)",
    pillBgLight: "rgba(14, 116, 144, 0.12)",
    label: "Signal",
  },
  Insight: {
    color: "#a78bfa",
    pillBgDark: "rgba(167, 139, 250, 0.16)",
    pillBgLight: "rgba(109, 40, 217, 0.11)",
    label: "Insight",
  },
  Rule: {
    color: "#34d399",
    pillBgDark: "rgba(52, 211, 153, 0.14)",
    pillBgLight: "rgba(4, 120, 87, 0.11)",
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

export function formatEdgeRelationLabel(type: ETGRelationshipType): string {
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
 * Generates and caches a crisp glowing orb canvas for THREE.Sprite textures.
 */
export function createEtgNodeCanvas(hexColor: string, isLightTheme: boolean): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const cx = size / 2;
  const cy = size / 2;

  // Outer atmospheric halo
  const glow = ctx.createRadialGradient(cx, cy, size * 0.14, cx, cy, size * 0.48);
  glow.addColorStop(0, `${hexColor}${isLightTheme ? "55" : "77"}`);
  glow.addColorStop(0.5, `${hexColor}${isLightTheme ? "20" : "2b"}`);
  glow.addColorStop(1, `${hexColor}00`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2);
  ctx.fill();

  // Solid spherical body with specular highlight
  const sphereGrad = ctx.createRadialGradient(
    cx - size * 0.07,
    cy - size * 0.08,
    size * 0.03,
    cx,
    cy,
    size * 0.25
  );
  sphereGrad.addColorStop(0, "#ffffff");
  sphereGrad.addColorStop(0.35, hexColor);
  sphereGrad.addColorStop(1, shadeHex(hexColor, isLightTheme ? -0.24 : -0.34));

  ctx.fillStyle = sphereGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.24, 0, Math.PI * 2);
  ctx.fill();

  // Crisp subtle rim for separation against dark void or ivory canvas
  ctx.lineWidth = isLightTheme ? 4 : 3;
  ctx.strokeStyle = isLightTheme ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.42)";
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.24, 0, Math.PI * 2);
  ctx.stroke();

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

function shadeHex(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  const num = Number.parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  if (Number.isNaN(num)) return hex;
  const r = Math.min(255, Math.max(0, Math.round(((num >> 16) & 255) * (1 + amount))));
  const g = Math.min(255, Math.max(0, Math.round(((num >> 8) & 255) * (1 + amount))));
  const b = Math.min(255, Math.max(0, Math.round((num & 255) * (1 + amount))));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/**
 * Deterministic force-directed 3D layout seeded cleanly on a Golden Spiral sphere
 * with spring attraction along ETG edges so connected Earth concepts cluster coherently.
 */
export function computeLayout3D(nodes: ETGNode[], edges: ETGEdge[]): Map<string, Point3D> {
  const pos = new Map<string, Point3D>();
  if (nodes.length === 0) return pos;

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const total = nodes.length;

  nodes.forEach((node, idx) => {
    // Give higher importance/Insight/Concept nodes slightly more central orbits
    const ringBias =
      node.label === "Insight" ? 0.52 : node.label === "Concept" ? 0.72 : node.label === "Rule" ? 0.9 : 1.05;
    const baseRadius = (64 + hash01(node.uuid, 7) * 44) * ringBias;
    const yNorm = 1 - (idx / Math.max(1, total - 1)) * 2;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - yNorm * yNorm));
    const theta = goldenAngle * idx + hash01(node.uuid, 13) * 0.4;

    pos.set(node.uuid, {
      x: Math.cos(theta) * radiusAtY * baseRadius,
      y: yNorm * baseRadius * 0.78,
      z: Math.sin(theta) * radiusAtY * baseRadius,
    });
  });

  // Gentle force relaxation (45 iterations) so edges group without collapsing into a ball
  const iterations = 45;
  const repulseStrength = 2600;
  const springStrength = 0.036;
  const idealEdgeLen = 68;

  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map<string, Point3D>();
    for (const n of nodes) forces.set(n.uuid, { x: 0, y: 0, z: 0 });

    // Pairwise repulsion + gentle centering
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const pa = pos.get(a.uuid)!;
      const fa = forces.get(a.uuid)!;

      // Center gravity
      fa.x -= pa.x * 0.012;
      fa.y -= pa.y * 0.014;
      fa.z -= pa.z * 0.012;

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const pb = pos.get(b.uuid)!;
        const fb = forces.get(b.uuid)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const dz = pa.z - pb.z;
        const distSq = dx * dx + dy * dy + dz * dz + 120;
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

    // Spring attraction along edges
    for (const e of edges) {
      const pa = pos.get(e.source_uuid);
      const pb = pos.get(e.target_uuid);
      if (!pa || !pb) continue;
      const fa = forces.get(e.source_uuid)!;
      const fb = forces.get(e.target_uuid)!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dz = pb.z - pa.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const stretch = (dist - idealEdgeLen) * springStrength;
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

    const damping = 0.72 * (1 - iter / (iterations * 1.4));
    for (const n of nodes) {
      const p = pos.get(n.uuid)!;
      const f = forces.get(n.uuid)!;
      p.x += Math.max(-14, Math.min(14, f.x * damping));
      p.y += Math.max(-14, Math.min(14, f.y * damping));
      p.z += Math.max(-14, Math.min(14, f.z * damping));
    }
  }

  return pos;
}

/**
 * Computes a well-spaced 2D layout with explicit rectangular card collision resolution
 * so 196×42 node cards never overlap at default zoom.
 */
export function computeLayout2D(
  nodes: ETGNode[],
  edges: ETGEdge[]
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

  // Group ontology rings cleanly so Insights sit near hubs, Concepts/Signals surround them
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((node, idx) => {
    const r = 135 * Math.sqrt(idx + 1) + (node.label === "Rule" ? 65 : 0);
    const angle = idx * goldenAngle + hash01(node.uuid, 31) * 0.35;
    pos.set(node.uuid, {
      x: Math.cos(angle) * r * 1.28,
      y: Math.sin(angle) * r * 0.86,
    });
  });

  // Spring + repulsion pass in 2D space
  const iterations = 60;
  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map<string, Point2D>();
    for (const n of nodes) forces.set(n.uuid, { x: 0, y: 0 });

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const pa = pos.get(a.uuid)!;
      const fa = forces.get(a.uuid)!;

      fa.x -= pa.x * 0.008;
      fa.y -= pa.y * 0.011;

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const pb = pos.get(b.uuid)!;
        const fb = forces.get(b.uuid)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const distSq = dx * dx + dy * dy + 1600;
        const dist = Math.sqrt(distSq);
        const rep = 42000 / distSq;
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
      const fa = forces.get(e.source_uuid)!;
      const fb = forces.get(e.target_uuid)!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = e.type === "drives_opposite" ? 310 : 250;
      const pull = (dist - ideal) * 0.042;
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

  // Deterministic rectangular AABB de-overlap pass for 196×42 cards + padding
  const minDx = CARD_WIDTH + 28;
  const minDy = CARD_HEIGHT + 24;
  for (let pass = 0; pass < 36; pass++) {
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
          // Push apart along the axis needing the least travel
          if (overlapX * 0.55 < overlapY) {
            const sign = dx >= 0 ? 1 : -1;
            const push = (overlapX * 0.52) * sign;
            pa.x += push;
            pb.x -= push;
          } else {
            const sign = dy >= 0 ? 1 : -1;
            const push = (overlapY * 0.52) * sign;
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
