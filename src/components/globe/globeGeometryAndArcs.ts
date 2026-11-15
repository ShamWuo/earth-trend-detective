import * as THREE from "three";
import { computeSubsolarPoint } from "@/lib/earth/solarPosition";
import type {
  ActiveGibsLayerId,
  RegionalSatelliteMode,
  RegionalZoomTier,
} from "@/lib/earth/nasaGibsRegional";
import type { SatelliteDepthTier } from "@/lib/earth/satelliteZoomTiles";
import { classifyRelationCategory } from "@/lib/plainLanguage";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  RelationCategory,
  TemperatureUnit,
  TrendMicroscopeRadarBadge,
} from "@/types/etg";

export interface RegionalFocusRequest {
  lat: number;
  lng: number;
  radius?: number;
  seq: number;
}

export type GlobeArcMode =
  | "all"
  | "focus"
  | "dipoles"
  | "opposite"
  | "causal"
  | "off";

export type SunPreset = "live" | "daylight" | "americas" | "eurasia" | "night";

const EDGE_TYPE_PRIORITY: Record<ETGRelationshipType, number> = {
  drives_opposite: 6,
  leads: 6,
  advects_to: 6,
  teleconnects: 5,
  amplifies: 5,
  triggers: 5,
  impacts: 5,
  dampens: 4,
  correlates_with: 4,
  contradicts: 4,
  supersedes: 3,
  corroborates: 2,
  supports: 1,
  hypothesized_link: 1,
  verified_by: 0,
  monitors: 0,
  relates_to: 0,
};

export function lngSpanDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function isNodeNearRegionalCenter(
  node: ETGNode,
  center: { lat: number; lng: number }
): boolean {
  const { lat, lng } = node.properties;
  if (lat === undefined || lng === undefined) return false;
  return Math.abs(lat - center.lat) <= 12 && lngSpanDeg(lng, center.lng) <= 15;
}

/**
 * Formats a NASA GIBS colorbar's min/mid/max/unit labels for the user's selected
 * temperature unit (°C or °F), distinguishing absolute temperature vs. anomaly scales.
 */
export function formatGibsColorbarForUnit<
  T extends {
    minLabel: string;
    midLabel?: string;
    maxLabel: string;
    unitLabel: string;
  },
>(colorbar: T, unit: TemperatureUnit): T {
  const hasCelsius =
    /°\s*c\b/i.test(colorbar.unitLabel) ||
    /°\s*c\b/i.test(colorbar.minLabel) ||
    /°\s*c\b/i.test(colorbar.maxLabel);
  if (unit !== "F" || !hasCelsius) {
    return colorbar;
  }
  const isAnom = /anom/i.test(colorbar.unitLabel);
  const convertEndpoint = (raw: string): string =>
    raw.replace(
      /([+-]?\d+(?:\.\d+)?)(\+?)\s*°\s*C\b/gi,
      (_m, numStr: string, plusSuffix: string) => {
        const val = Number.parseFloat(numStr);
        if (!Number.isFinite(val)) return _m;
        if (isAnom) {
          const scaled = val * 1.8;
          const formatted = Number.isInteger(scaled) ? `${scaled}` : scaled.toFixed(1);
          const sign = numStr.startsWith("+") && scaled > 0 ? "+" : "";
          return `${sign}${formatted}${plusSuffix} °F`;
        }
        const fahr = Math.round(val * 1.8 + 32);
        return `${fahr}${plusSuffix} °F`;
      }
    );

  return {
    ...colorbar,
    minLabel: convertEndpoint(colorbar.minLabel),
    midLabel: colorbar.midLabel ? convertEndpoint(colorbar.midLabel) : colorbar.midLabel,
    maxLabel: convertEndpoint(colorbar.maxLabel),
    unitLabel: colorbar.unitLabel.replace(/°\s*c\b/gi, "°F"),
  };
}

function pickSpatiallyDistinctArcs(
  ranked: ETGEdge[],
  nodeById: Map<string, ETGNode>,
  maxCount: number,
  bucketDeg = 10
): ETGEdge[] {
  const seenBuckets = new Set<string>();
  const picked: ETGEdge[] = [];
  for (const edge of ranked) {
    const src = nodeById.get(edge.source_uuid);
    const tgt = nodeById.get(edge.target_uuid);
    if (!src || !tgt) continue;
    const bA = `${Math.round((src.properties.lat ?? 0) / bucketDeg)},${Math.round((src.properties.lng ?? 0) / bucketDeg)}`;
    const bB = `${Math.round((tgt.properties.lat ?? 0) / bucketDeg)},${Math.round((tgt.properties.lng ?? 0) / bucketDeg)}`;
    const pairKey = bA < bB ? `${bA}|${bB}` : `${bB}|${bA}`;
    if (seenBuckets.has(pairKey)) continue;
    seenBuckets.add(pairKey);
    picked.push(edge);
    if (picked.length >= maxCount) break;
  }
  return picked;
}

/**
 * Selects a clean, legible subset of great-circle arcs to render on the 3D globe
 * so unfocused views stay crisp and focused relations stand out without clutter.
 */
export function selectVisibleGlobeArcs(params: {
  nodes: ETGNode[];
  edges: ETGEdge[];
  mode: GlobeArcMode;
  selectedNodeUuid: string | null;
  probedAnchorUuid?: string | null;
  selectedEdgeUuid: string | null;
  cascadeEdgeUuids: string[];
  enabledCategories?: ReadonlyArray<RelationCategory>;
  isRegionalZoom?: boolean;
  regionalCenter?: { lat: number; lng: number } | null;
}): ETGEdge[] {
  const {
    nodes,
    edges,
    mode,
    selectedNodeUuid,
    probedAnchorUuid = null,
    selectedEdgeUuid,
    cascadeEdgeUuids,
    enabledCategories,
    isRegionalZoom = false,
    regionalCenter = null,
  } = params;
  const nodeById = new Map(nodes.map((n) => [n.uuid, n]));
  const enabledSet = enabledCategories ? new Set(enabledCategories) : null;
  const minDegSpan = isRegionalZoom ? 0.06 : 0.8;
  const incidentCap = isRegionalZoom ? 12 : 6;
  const spatialBucketDeg = isRegionalZoom ? 0.25 : 10;

  const geoEdges = edges.filter((e) => {
    const src = nodeById.get(e.source_uuid);
    const tgt = nodeById.get(e.target_uuid);
    if (
      !src ||
      !tgt ||
      src.properties.lat === undefined ||
      src.properties.lng === undefined ||
      tgt.properties.lat === undefined ||
      tgt.properties.lng === undefined
    ) {
      return false;
    }
    const dLat = Math.abs(src.properties.lat - tgt.properties.lat);
    const dLng = lngSpanDeg(src.properties.lng, tgt.properties.lng);
    return dLat >= minDegSpan || dLng >= minDegSpan;
  });

  if (mode === "off" && !selectedEdgeUuid && cascadeEdgeUuids.length === 0) {
    return [];
  }

  if (selectedEdgeUuid) {
    const found = geoEdges.find((e) => e.properties.uuid === selectedEdgeUuid);
    return found ? [found] : [];
  }

  if (cascadeEdgeUuids.length > 0) {
    const cascadeSet = new Set(cascadeEdgeUuids);
    return geoEdges.filter((e) => cascadeSet.has(e.properties.uuid));
  }

  const categoryFiltered = enabledSet
    ? geoEdges.filter((e) => enabledSet.has(classifyRelationCategory(e.type)))
    : geoEdges;

  const sortEdges = (list: ETGEdge[]) =>
    [...list].sort((a, b) => {
      const prioDiff =
        (EDGE_TYPE_PRIORITY[b.type] ?? 0) - (EDGE_TYPE_PRIORITY[a.type] ?? 0);
      if (prioDiff !== 0) return prioDiff;
      return (
        Math.abs(b.properties.correlation_r ?? 0) -
        Math.abs(a.properties.correlation_r ?? 0)
      );
    });

  const activeAnchorUuid = selectedNodeUuid ?? probedAnchorUuid;

  if (selectedNodeUuid && mode !== "all") {
    return sortEdges(
      categoryFiltered.filter(
        (e) =>
          e.source_uuid === selectedNodeUuid ||
          e.target_uuid === selectedNodeUuid
      )
    ).slice(0, incidentCap);
  }

  if (mode === "focus") {
    if (activeAnchorUuid) {
      return sortEdges(
        categoryFiltered.filter(
          (e) =>
            e.source_uuid === activeAnchorUuid ||
            e.target_uuid === activeAnchorUuid
        )
      ).slice(0, incidentCap);
    }
    if (isRegionalZoom && regionalCenter) {
      return sortEdges(
        categoryFiltered.filter((e) => {
          const src = nodeById.get(e.source_uuid);
          const tgt = nodeById.get(e.target_uuid);
          return Boolean(
            (src && isNodeNearRegionalCenter(src, regionalCenter)) ||
              (tgt && isNodeNearRegionalCenter(tgt, regionalCenter))
          );
        })
      ).slice(0, 10);
    }
    return [];
  }

  if (mode === "opposite") {
    const oppositeOnly = sortEdges(
      categoryFiltered.filter((e) => e.type === "drives_opposite")
    );
    return pickSpatiallyDistinctArcs(oppositeOnly, nodeById, 12, spatialBucketDeg);
  }

  if (mode === "causal") {
    const causalOnly = sortEdges(
      categoryFiltered.filter(
        (e) => classifyRelationCategory(e.type) === "causal"
      )
    );
    return pickSpatiallyDistinctArcs(causalOnly, nodeById, 12, spatialBucketDeg);
  }

  if (mode === "all") {
    const anchorHits = activeAnchorUuid
      ? sortEdges(
          categoryFiltered.filter(
            (e) =>
              e.source_uuid === activeAnchorUuid ||
              e.target_uuid === activeAnchorUuid
          )
        ).slice(0, isRegionalZoom ? 10 : 6)
      : [];
    const regionalHits =
      isRegionalZoom && regionalCenter
        ? sortEdges(
            categoryFiltered.filter((e) => {
              const src = nodeById.get(e.source_uuid);
              const tgt = nodeById.get(e.target_uuid);
              return Boolean(
                src &&
                  tgt &&
                  isNodeNearRegionalCenter(src, regionalCenter) &&
                  isNodeNearRegionalCenter(tgt, regionalCenter)
              );
            })
          ).slice(0, 10)
        : [];
    const seenIds = new Set<string>();
    const combinedSeeds: ETGEdge[] = [];
    for (const e of [...anchorHits, ...regionalHits]) {
      if (seenIds.has(e.properties.uuid)) continue;
      seenIds.add(e.properties.uuid);
      combinedSeeds.push(e);
    }
    const remaining = sortEdges(
      categoryFiltered.filter((e) => !seenIds.has(e.properties.uuid))
    );
    const overview = pickSpatiallyDistinctArcs(
      remaining,
      nodeById,
      12,
      spatialBucketDeg
    );
    return [...combinedSeeds, ...overview].slice(0, isRegionalZoom ? 18 : 14);
  }

  // Dipoles overview mode: at most 6 spatially distinct high-|r| dipoles/teleconnections
  const ranked = categoryFiltered
    .filter(
      (e) =>
        (e.type === "drives_opposite" || e.type === "teleconnects") &&
        Math.abs(e.properties.correlation_r ?? 0) >= 0.55
    )
    .sort(
      (a, b) => Math.abs(b.properties.correlation_r ?? 0) - Math.abs(a.properties.correlation_r ?? 0)
    );

  return pickSpatiallyDistinctArcs(ranked, nodeById, 6, spatialBucketDeg);
}

export const EARTH_RADIUS = 100;
const TRUE_EARTH_SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0, 0), EARTH_RADIUS);

/**
 * Exact O(1) analytical ray-sphere intersection against the true Earth sphere (R = EARTH_RADIUS).
 * Eliminates triangle chord sagitta error and high-poly mesh traversal overhead at street zoom.
 */
export function intersectTrueEarthSphere(
  ray: THREE.Ray,
  target = new THREE.Vector3()
): THREE.Vector3 | null {
  return ray.intersectSphere(TRUE_EARTH_SPHERE, target);
}

export function latLngToVector3(lat: number, lng: number, radius = EARTH_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

export function vector3ToLatLng(
  v: THREE.Vector3,
  precision = 5
): { lat: number; lng: number } {
  const r = v.length();
  if (r === 0) return { lat: 0, lng: 0 };
  const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, v.y / r))) * 180) / Math.PI;
  const theta = Math.atan2(v.z, -v.x);
  let lng = (theta * 180) / Math.PI - 180;
  if (lng < -180) lng += 360;
  if (lng > 180) lng -= 360;
  return {
    lat: Number(lat.toFixed(precision)),
    lng: Number(lng.toFixed(precision)),
  };
}

export function createRadialGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const cx = size / 2;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    grad.addColorStop(0, "rgba(255, 255, 255, 1.0)");
    grad.addColorStop(0.22, "rgba(255, 255, 255, 0.92)");
    grad.addColorStop(0.45, "rgba(255, 255, 255, 0.36)");
    grad.addColorStop(0.75, "rgba(255, 255, 255, 0.08)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRingReticleTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const cx = size / 2;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    grad.addColorStop(0, "rgba(255, 255, 255, 0.14)");
    grad.addColorStop(0.56, "rgba(255, 255, 255, 0.03)");
    grad.addColorStop(0.7, "rgba(255, 255, 255, 0.88)");
    grad.addColorStop(0.79, "rgba(255, 255, 255, 0.95)");
    grad.addColorStop(0.9, "rgba(255, 255, 255, 0.15)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createStarSpriteTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const cx = size / 2;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    grad.addColorStop(0, "rgba(255, 255, 255, 1.0)");
    grad.addColorStop(0.32, "rgba(255, 255, 255, 0.65)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

/**
 * Computes antipodal-safe, low-profile spherical arc points hugging the Earth surface.
 */
export function buildElevatedGreatCircleCurve(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  segments = 64,
  options?: { lowAltitudeCorridor?: boolean }
): THREE.Vector3[] {
  const u1 = latLngToVector3(lat1, lng1, 1).normalize();
  let u2 = latLngToVector3(lat2, lng2, 1).normalize();

  let dot = Math.max(-1, Math.min(1, u1.dot(u2)));
  if (dot < -0.999) {
    // Handle exact antipodes without NaN slerp
    const ortho = Math.abs(u1.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3().crossVectors(u1, ortho).normalize();
    u2 = u2.clone().addScaledVector(tangent, 0.03).normalize();
    dot = Math.max(-1, Math.min(1, u1.dot(u2)));
  } else if (dot > 0.99995) {
    // Separate coincident or near-coincident endpoints so CatmullRomCurve3 + TubeGeometry never produce NaN frames
    const ortho = Math.abs(u1.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3().crossVectors(u1, ortho).normalize();
    u2 = u1.clone().addScaledVector(tangent, 0.016).normalize();
    dot = Math.max(-1, Math.min(1, u1.dot(u2)));
  }

  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const lowAltitude = Boolean(options?.lowAltitudeCorridor);
  const baseLift = lowAltitude ? 0.36 : 0.85;
  const maxLift = lowAltitude
    ? Math.min(2.2, 0.3 + omega * 2.4)
    : Math.min(13, 1.8 + omega * 3.8);
  const pts: THREE.Vector3[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let dir: THREE.Vector3;
    if (sinOmega < 1e-4) {
      dir = u1.clone().lerp(u2, t).normalize();
    } else {
      const w1 = Math.sin((1 - t) * omega) / sinOmega;
      const w2 = Math.sin(t * omega) / sinOmega;
      dir = u1.clone().multiplyScalar(w1).addScaledVector(u2, w2).normalize();
    }
    const r = EARTH_RADIUS + baseLift + Math.sin(t * Math.PI) * maxLift;
    pts.push(dir.multiplyScalar(r));
  }
  return pts;
}

export interface ComparisonArcVisualMeta {
  category: RelationCategory;
  badgeText: string;
  pairLabel: string;
  statText: string | null;
  isSignificant?: boolean;
}

export interface ResolvedComparisonArcVisuals {
  colorHex: number;
  colorCss: string;
  haloOpacity: number;
  coreRadius: number;
  haloRadius: number;
  pulseSpeed: number;
  pulseColorHex: number;
}

/**
 * Resolves 3D tube, additive halo, and traveling pulse styling for active 2-spot or case-study arcs.
 */
export function resolveComparisonArcVisuals(
  meta?: ComparisonArcVisualMeta | null
): ResolvedComparisonArcVisuals {
  if (!meta) {
    return {
      colorHex: 0x22d3ee,
      colorCss: "#22d3ee",
      haloOpacity: 0.16,
      coreRadius: 0.34,
      haloRadius: 0.64,
      pulseSpeed: 0.28,
      pulseColorHex: 0x67e8f9,
    };
  }
  if (meta.category === "opposite") {
    return {
      colorHex: 0xfb7185,
      colorCss: "#fb7185",
      haloOpacity: meta.isSignificant ? 0.26 : 0.18,
      coreRadius: meta.isSignificant ? 0.44 : 0.36,
      haloRadius: meta.isSignificant ? 0.86 : 0.68,
      pulseSpeed: 0.34,
      pulseColorHex: 0xfda4af,
    };
  }
  if (meta.category === "causal") {
    return {
      colorHex: 0x34d399,
      colorCss: "#34d399",
      haloOpacity: meta.isSignificant ? 0.24 : 0.16,
      coreRadius: meta.isSignificant ? 0.42 : 0.34,
      haloRadius: meta.isSignificant ? 0.82 : 0.64,
      pulseSpeed: 0.34,
      pulseColorHex: 0x6ee7b7,
    };
  }
  return {
    colorHex: 0x38bdf8,
    colorCss: "#38bdf8",
    haloOpacity: meta.isSignificant ? 0.22 : 0.14,
    coreRadius: meta.isSignificant ? 0.38 : 0.32,
    haloRadius: meta.isSignificant ? 0.72 : 0.6,
    pulseSpeed: 0.26,
    pulseColorHex: 0x7dd3fc,
  };
}

export interface DisposableTexture {
  dispose: () => void;
}

export interface DynamicTextureTracker<T extends DisposableTexture> {
  register: (tex: T | null | undefined) => void;
  evictFromCache: (tex: T | null | undefined) => boolean;
  releaseUnbound: () => number;
  disposeAll: () => number;
  pendingCount: () => number;
  activeCount: () => number;
}

/**
 * Tracks GPU textures so LRU evictions wait cleanly until unbound from active shader uniforms,
 * and ensures complete disposal on WebGL unmount without double-disposing bound textures prematurely.
 */
export function createDynamicTextureTracker<T extends DisposableTexture>(
  isBoundToScene: (tex: T) => boolean
): DynamicTextureTracker<T> {
  const tracked = new Set<T>();
  const pendingDisposal = new Set<T>();

  const tryDispose = (tex: T): boolean => {
    if (isBoundToScene(tex)) {
      pendingDisposal.add(tex);
      return false;
    }
    pendingDisposal.delete(tex);
    tracked.delete(tex);
    tex.dispose();
    return true;
  };

  return {
    register(tex) {
      if (!tex) return;
      tracked.add(tex);
      pendingDisposal.delete(tex);
    },
    evictFromCache(tex) {
      if (!tex) return false;
      return tryDispose(tex);
    },
    releaseUnbound() {
      let count = 0;
      for (const tex of Array.from(pendingDisposal)) {
        if (tryDispose(tex)) count += 1;
      }
      return count;
    },
    disposeAll() {
      const all = new Set<T>([...tracked, ...pendingDisposal]);
      tracked.clear();
      pendingDisposal.clear();
      for (const tex of all) {
        tex.dispose();
      }
      return all.size;
    },
    pendingCount: () => pendingDisposal.size,
    activeCount: () => tracked.size,
  };
}

export function disposeGroupResources(group: THREE.Group, skipTextures: Set<THREE.Texture>) {
  while (group.children.length > 0) {
    const obj = group.children[0];
    group.remove(obj);
    if (obj instanceof THREE.Group) {
      disposeGroupResources(obj, skipTextures);
      continue;
    }
    if (obj.children.length > 0) {
      for (const child of [...obj.children]) {
        obj.remove(child);
        if (child instanceof THREE.Group) {
          disposeGroupResources(child, skipTextures);
        }
      }
    }
    if (
      obj instanceof THREE.Mesh ||
      obj instanceof THREE.Line ||
      obj instanceof THREE.Points
    ) {
      obj.geometry?.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (!mat) continue;
        const map = (mat as THREE.MeshBasicMaterial).map;
        if (map && !skipTextures.has(map)) {
          map.dispose();
        }
        mat.dispose();
      }
    } else if (obj instanceof THREE.Sprite) {
      const mat = obj.material as THREE.SpriteMaterial;
      if (mat.map && !skipTextures.has(mat.map)) {
        mat.map.dispose();
      }
      mat.dispose();
    }
  }
}

export function computeSunDirection(preset: SunPreset, now: Date = new Date()): THREE.Vector3 {
  if (preset === "americas") {
    // Subsolar over Tropical Atlantic / Eastern Americas for Atlantic sun glint & terminator over Europe/Africa
    return latLngToVector3(14, -68, 1).normalize();
  }
  if (preset === "eurasia") {
    // Subsolar over Indian Ocean / Asia for Himalayas relief & Pacific twilight
    return latLngToVector3(18, 62, 1).normalize();
  }
  if (preset === "night") {
    // Subsolar behind the Americas camera so Americas & Atlantic reveal VIIRS city lights + twilight rim
    return latLngToVector3(-12, 118, 1).normalize();
  }
  // Accurate astronomical subsolar point (declination + Equation of Time / GMST)
  const subsolar = computeSubsolarPoint(now);
  return latLngToVector3(subsolar.lat, subsolar.lng, 1).normalize();
}

export interface GlobePersistedPrefs {
  arcMode: GlobeArcMode;
  showClouds: boolean;
  showArcLabels: boolean;
  showPins: boolean;
  autoRotate: boolean;
  satelliteMode?: RegionalSatelliteMode;
  sunPreset?: SunPreset;
  filterSmooth?: boolean;
  showPlaceLabels?: boolean;
}

export const GLOBE_PREFS_STORAGE_KEY = "etg:globe-prefs:v2";

export interface ProjectedArcLabel {
  uuid: string;
  x: number;
  y: number;
  badgeText: string;
  pairLabel: string;
  statText: string | null;
  colorCss: string;
  isSelected: boolean;
  edge: ETGEdge;
}

export interface ProjectedRegionalNodeLabel {
  uuid: string;
  x: number;
  y: number;
  name: string;
  metricText: string | null;
  colorCss: string;
  isSelected: boolean;
  node: ETGNode;
}

export interface ProjectedProbeLabel {
  x: number;
  y: number;
  badgeText: string;
  pairLabel: string;
  statText: string | null;
  colorCss: string;
}

export interface RegionalHudState {
  layerId: ActiveGibsLayerId | null;
  dateIso: string;
  swathKm: number;
  tier: RegionalZoomTier;
  aerialActive: boolean;
  aerialZoom: number;
  aerialResolutionLabel: string;
  altitudeKm: number;
  depthTier: SatelliteDepthTier;
  loading: boolean;
  error: boolean;
  centerLat: number;
  centerLng: number;
}

export interface GlobalHudState {
  loading: boolean;
  error: boolean;
  dateIso: string;
  resBadge: string;
}

export interface HoveredGlobeInfo {
  name: string;
  subtitle: string;
  radarBadge?: TrendMicroscopeRadarBadge;
  radarDetail?: string;
  x: number;
  y: number;
}

export interface PulseTraveler {
  sprite: THREE.Sprite;
  pts: THREE.Vector3[];
  speed: number;
  phase: number;
}

export interface ArcMidpointMeta {
  edge: ETGEdge;
  midpoint: THREE.Vector3;
  badgeText: string;
  pairLabel: string;
  statText: string | null;
  colorCss: string;
  isSelected: boolean;
}

export interface ComparisonArcMidpointMeta {
  midpoint: THREE.Vector3;
  badgeText: string;
  pairLabel: string;
  statText: string | null;
  colorCss: string;
}

export interface GlobeSceneRefs {
  scene: THREE.Scene;
  earthMesh: THREE.Mesh;
  earthMat: THREE.ShaderMaterial;
  cloudMesh: THREE.Mesh;
  cloudMat: THREE.ShaderMaterial;
  innerHazeMat: THREE.ShaderMaterial;
  atmoMat: THREE.ShaderMaterial;
  markersGroup: THREE.Group;
  arcsGroup: THREE.Group;
  probeGroup: THREE.Group;
  regionalGroup: THREE.Group;
  markerMap: Map<THREE.Object3D, ETGNode>;
  arcMap: Map<THREE.Object3D, ETGEdge>;
  spherical: THREE.Spherical;
  glowTex: THREE.CanvasTexture;
  ringTex: THREE.CanvasTexture;
  sharedTextures: Set<THREE.Texture>;
  arcTravelers: PulseTraveler[];
  arcMidpoints: ArcMidpointMeta[];
  probeTravelers: PulseTraveler[];
  probeMidpoint: ComparisonArcMidpointMeta | null;
  forceRegionalTileSync: () => void;
  syncGlobalMode: (
    mode: RegionalSatelliteMode,
    topics?: readonly ETGDatasetId[],
    cutoffMsVal?: number
  ) => void;
}
