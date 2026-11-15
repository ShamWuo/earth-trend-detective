"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  ChevronDown,
  ChevronUp,
  Cloud,
  GitBranch,
  GitCompare,
  Layers,
  Loader2,
  RotateCcw,
  Satellite,
  ScanSearch,
  Sun,
  X,
} from "lucide-react";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  DEFAULT_REGIONAL_FOCUS_RADIUS,
  GIBS_LAYERS,
  MIN_GLOBE_CAMERA_RADIUS,
  REGIONAL_ZOOM_ACTIVATE_RADIUS,
  REGIONAL_ZOOM_EXIT_RADIUS,
  buildGeodesicCircleLatLng,
  buildWmtsTileUrl,
  computeGlobalBordersProxyUrl,
  computeGlobalBordersQuadrantSpecs,
  computeGlobalLayerSpec,
  computeGlobalWmtsMosaicSpec,
  computeRegionalTileSpec,
  estimateRegionalSwathKm,
  getGibsLayerColorbar,
  resolveActiveGibsLayer,
  resolveGibsDateIso,
  resolveGlobalFilterLayer,
  resolveGlobalSyncSignature,
  type ActiveGibsLayerId,
  type GlobalLayerSpec,
  type GlobalWmtsMosaicSpec,
  type RegionalSatelliteMode,
  type RegionalTileSpec,
  type RegionalZoomTier,
} from "@/lib/earth/nasaGibsRegional";
import {
  convertSlopeUnitLabel,
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  isTemperatureUnitString,
} from "@/lib/earth/currentConditionsClient";
import { ETG_LABEL_PALETTE } from "@/lib/graph/graphVisuals";
import { computeSubsolarPoint } from "@/lib/earth/solarPosition";
import {
  ALL_RELATION_CATEGORIES,
  RELATION_CATEGORY_META,
  classifyRelationCategory,
  formatRelationForDisplay,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  NodeTrendMicroscopeCue,
  RelationCategory,
  TemperatureUnit,
  TrendMicroscopeRadarBadge,
  TrendMicroscopeScanResult,
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

interface EarthGlobe3DProps {
  nodes: ETGNode[];
  edges: ETGEdge[];
  selectedNodeUuid: string | null;
  probedAnchorUuid?: string | null;
  selectedEdgeUuid?: string | null;
  cascadeEdgeUuids?: string[];
  microscopeScan?: TrendMicroscopeScanResult | null;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  probedCoord: { lat: number; lng: number } | null;
  comparePinB?: { lat: number; lng: number } | null;
  compareMode?: boolean;
  comparisonArcMeta?: ComparisonArcVisualMeta | null;
  inspectorOpen?: boolean;
  mobileSheetExpanded?: boolean;
  enabledCategories?: ReadonlyArray<RelationCategory>;
  onChangeEnabledCategories?: (cats: RelationCategory[]) => void;
  tempUnit?: TemperatureUnit;
  onChangeTempUnit?: (unit: TemperatureUnit) => void;
  activeTopics?: ReadonlyArray<ETGDatasetId>;
  cutoffMs?: number;
  regionalFocusRequest?: RegionalFocusRequest | null;
  initialSatelliteMode?: RegionalSatelliteMode;
  initialSunPreset?: SunPreset;
  timelineSlot?: React.ReactNode;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onProbeCoordinate: (lat: number, lng: number) => void;
  onToggleCompareMode?: () => void;
}

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
  supersedes: 3,
  corroborates: 2,
  supports: 1,
  hypothesized_link: 1,
  verified_by: 0,
  monitors: 0,
  relates_to: 0,
};

function lngSpanDeg(a: number, b: number): number {
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

const EARTH_RADIUS = 100;

export function latLngToVector3(lat: number, lng: number, radius = EARTH_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

export function vector3ToLatLng(v: THREE.Vector3): { lat: number; lng: number } {
  const r = v.length();
  if (r === 0) return { lat: 0, lng: 0 };
  const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, v.y / r))) * 180) / Math.PI;
  const theta = Math.atan2(v.z, -v.x);
  let lng = (theta * 180) / Math.PI - 180;
  if (lng < -180) lng += 360;
  if (lng > 180) lng -= 360;
  return {
    lat: Number(lat.toFixed(2)),
    lng: Number(lng.toFixed(2)),
  };
}

function createRadialGlowTexture(): THREE.CanvasTexture {
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

function createRingReticleTexture(): THREE.CanvasTexture {
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

function createStarSpriteTexture(): THREE.CanvasTexture {
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

export type SunPreset = "live" | "daylight" | "americas" | "eurasia" | "night";

function computeSunDirection(preset: SunPreset, now: Date = new Date()): THREE.Vector3 {
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

interface GlobePersistedPrefs {
  arcMode: GlobeArcMode;
  showClouds: boolean;
  showArcLabels: boolean;
  showPins: boolean;
  autoRotate: boolean;
  satelliteMode?: RegionalSatelliteMode;
  sunPreset?: SunPreset;
  filterSmooth?: boolean;
}

const GLOBE_PREFS_STORAGE_KEY = "etg:globe-prefs:v1";

interface ProjectedArcLabel {
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

interface ProjectedRegionalNodeLabel {
  uuid: string;
  x: number;
  y: number;
  name: string;
  metricText: string | null;
  colorCss: string;
  isSelected: boolean;
  node: ETGNode;
}

interface RegionalHudState {
  layerId: ActiveGibsLayerId | null;
  dateIso: string;
  swathKm: number;
  tier: RegionalZoomTier;
  loading: boolean;
  error: boolean;
  centerLat: number;
  centerLng: number;
}

export function EarthGlobe3D({
  nodes,
  edges,
  selectedNodeUuid,
  probedAnchorUuid = null,
  selectedEdgeUuid = null,
  cascadeEdgeUuids = [],
  microscopeScan = null,
  microscopeByNode,
  probedCoord,
  comparePinB = null,
  compareMode = false,
  comparisonArcMeta = null,
  inspectorOpen = false,
  mobileSheetExpanded = false,
  enabledCategories,
  onChangeEnabledCategories,
  tempUnit = "C",
  onChangeTempUnit,
  activeTopics,
  cutoffMs,
  regionalFocusRequest = null,
  initialSatelliteMode,
  initialSunPreset,
  timelineSlot,
  onSelectNode,
  onSelectEdge,
  onProbeCoordinate,
  onToggleCompareMode,
}: EarthGlobe3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [sunPreset, setSunPreset] = useState<SunPreset>(initialSunPreset ?? "live");
  const [liveUtcTime, setLiveUtcTime] = useState<string>(() =>
    new Date().toISOString().slice(11, 16) + " UTC"
  );
  const [showClouds, setShowClouds] = useState(false);
  const [arcMode, setArcMode] = useState<GlobeArcMode>("all");
  const [showArcLabels, setShowArcLabels] = useState(true);
  const [showPins, setShowPins] = useState(true);
  const [satelliteMode, setSatelliteMode] = useState<RegionalSatelliteMode>(
    initialSatelliteMode ?? "auto"
  );
  const [filterSmooth, setFilterSmooth] = useState(true);
  const [isRegionalZoom, setIsRegionalZoom] = useState(false);
  const [globalHud, setGlobalHud] = useState<{
    loading: boolean;
    error: boolean;
    dateIso: string;
    resBadge: string;
  }>({
    loading: false,
    error: false,
    dateIso: "",
    resBadge: "",
  });
  const [regionalHud, setRegionalHud] = useState<RegionalHudState>(() => ({
    layerId: resolveActiveGibsLayer("auto", activeTopics),
    dateIso: resolveGibsDateIso("true_color", cutoffMs),
    swathKm: 680,
    tier: "corridor",
    loading: false,
    error: false,
    centerLat: 39.74,
    centerLng: -104.99,
  }));
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [mobileHudExpanded, setMobileHudExpanded] = useState(false);
  const [projectedArcLabels, setProjectedArcLabels] = useState<ProjectedArcLabel[]>([]);
  const [projectedProbeLabel, setProjectedProbeLabel] = useState<{
    x: number;
    y: number;
    badgeText: string;
    pairLabel: string;
    statText: string | null;
    colorCss: string;
  } | null>(null);
  const [projectedNodeLabels, setProjectedNodeLabels] = useState<ProjectedRegionalNodeLabel[]>([]);
  const [hoveredInfo, setHoveredInfo] = useState<{
    name: string;
    subtitle: string;
    radarBadge?: TrendMicroscopeRadarBadge;
    radarDetail?: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(GLOBE_PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<GlobePersistedPrefs>;
        if (
          parsed.arcMode === "all" ||
          parsed.arcMode === "focus" ||
          parsed.arcMode === "dipoles" ||
          parsed.arcMode === "opposite" ||
          parsed.arcMode === "causal" ||
          parsed.arcMode === "off"
        ) {
          setArcMode(parsed.arcMode);
        }
        if (typeof parsed.showClouds === "boolean") setShowClouds(parsed.showClouds);
        if (typeof parsed.showArcLabels === "boolean") setShowArcLabels(parsed.showArcLabels);
        if (typeof parsed.showPins === "boolean") setShowPins(parsed.showPins);
        if (typeof parsed.autoRotate === "boolean") setAutoRotate(parsed.autoRotate);
        if (typeof parsed.filterSmooth === "boolean") setFilterSmooth(parsed.filterSmooth);
        if (
          initialSatelliteMode === undefined &&
          (parsed.satelliteMode === "auto" ||
            parsed.satelliteMode === "multi_slice" ||
            parsed.satelliteMode === "true_color" ||
            parsed.satelliteMode === "thermal" ||
            parsed.satelliteMode === "sst_anomaly" ||
            parsed.satelliteMode === "air_temp" ||
            parsed.satelliteMode === "precip" ||
            parsed.satelliteMode === "winds" ||
            parsed.satelliteMode === "aerosols" ||
            parsed.satelliteMode === "ndvi" ||
            parsed.satelliteMode === "night_viirs" ||
            parsed.satelliteMode === "off")
        ) {
          setSatelliteMode(parsed.satelliteMode);
        }
        if (
          initialSunPreset === undefined &&
          (parsed.sunPreset === "live" ||
            parsed.sunPreset === "daylight" ||
            parsed.sunPreset === "americas" ||
            parsed.sunPreset === "eurasia" ||
            parsed.sunPreset === "night")
        ) {
          setSunPreset(parsed.sunPreset);
        }
      }
    } catch {
      // Ignore storage errors
    } finally {
      setPrefsHydrated(true);
    }
  }, [initialSatelliteMode, initialSunPreset]);

  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      const payload: GlobePersistedPrefs = {
        arcMode,
        showClouds,
        showArcLabels,
        showPins,
        autoRotate,
        satelliteMode,
        sunPreset,
        filterSmooth,
      };
      window.localStorage.setItem(GLOBE_PREFS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage errors
    }
  }, [prefsHydrated, arcMode, showClouds, showArcLabels, showPins, autoRotate, satelliteMode, sunPreset, filterSmooth]);

  const resolvedGibsLayerId = resolveActiveGibsLayer(satelliteMode, activeTopics);

  const sunPresetRef = useRef(sunPreset);
  sunPresetRef.current = sunPreset;

  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const showCloudsRef = useRef(showClouds);
  showCloudsRef.current = showClouds;
  const showArcLabelsRef = useRef(showArcLabels);
  showArcLabelsRef.current = showArcLabels;
  const showPinsRef = useRef(showPins);
  showPinsRef.current = showPins;
  const inspectorOpenRef = useRef(inspectorOpen);
  inspectorOpenRef.current = inspectorOpen;
  const activeGibsLayerRef = useRef<ActiveGibsLayerId | null>(resolvedGibsLayerId);
  activeGibsLayerRef.current = resolvedGibsLayerId;
  const satelliteModeRef = useRef<RegionalSatelliteMode>(satelliteMode);
  satelliteModeRef.current = satelliteMode;
  const filterSmoothRef = useRef(filterSmooth);
  filterSmoothRef.current = filterSmooth;
  const activeTopicsRef = useRef<readonly ETGDatasetId[] | undefined>(activeTopics);
  activeTopicsRef.current = activeTopics;
  const cutoffMsRef = useRef<number | undefined>(cutoffMs);
  cutoffMsRef.current = cutoffMs;
  const selectedNodeUuidRef = useRef<string | null>(selectedNodeUuid);
  selectedNodeUuidRef.current = selectedNodeUuid;
  const microscopeByNodeRef = useRef<Record<string, NodeTrendMicroscopeCue> | undefined>(
    microscopeByNode
  );
  microscopeByNodeRef.current = microscopeByNode;
  const tempUnitRef = useRef<TemperatureUnit>(tempUnit);
  tempUnitRef.current = tempUnit;
  const isRegionalRef = useRef(isRegionalZoom);
  isRegionalRef.current = isRegionalZoom;

  const callbacksRef = useRef({ onSelectNode, onSelectEdge, onProbeCoordinate });
  callbacksRef.current = { onSelectNode, onSelectEdge, onProbeCoordinate };
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const cameraTargetRef = useRef<{ theta: number; phi: number; radius: number } | null>(null);
  const lastFocusSeqTimestampRef = useRef(0);

  // Explicit camera fly-to for regional drill-down requests ("Focus Denver on Globe" / "Locate on 3D Earth")
  useEffect(() => {
    if (!regionalFocusRequest) return;
    const vec = latLngToVector3(
      regionalFocusRequest.lat,
      regionalFocusRequest.lng,
      1
    );
    const sph = new THREE.Spherical().setFromVector3(vec);
    const targetRadius = Math.max(
      MIN_GLOBE_CAMERA_RADIUS,
      Math.min(
        430,
        regionalFocusRequest.radius ?? DEFAULT_REGIONAL_FOCUS_RADIUS
      )
    );
    cameraTargetRef.current = {
      theta: sph.theta,
      phi: Math.max(0.2, Math.min(Math.PI - 0.2, sph.phi)),
      radius: targetRadius,
    };
    lastFocusSeqTimestampRef.current = Date.now();
    setAutoRotate(false);
  }, [regionalFocusRequest]);

  // Sync camera target to frame a focused dipole arc midpoint or a single selected node
  useEffect(() => {
    if (selectedEdgeUuid) {
      const edge = edges.find((e) => e.properties.uuid === selectedEdgeUuid);
      if (edge) {
        const src = nodes.find((n) => n.uuid === edge.source_uuid);
        const tgt = nodes.find((n) => n.uuid === edge.target_uuid);
        if (
          src?.properties.lat !== undefined &&
          src.properties.lng !== undefined &&
          tgt?.properties.lat !== undefined &&
          tgt.properties.lng !== undefined &&
          (Math.abs(src.properties.lat - tgt.properties.lat) >= 0.8 ||
            Math.abs(src.properties.lng - tgt.properties.lng) >= 0.8)
        ) {
          const u1 = latLngToVector3(src.properties.lat, src.properties.lng, 1).normalize();
          const u2 = latLngToVector3(tgt.properties.lat, tgt.properties.lng, 1).normalize();
          const dot = Math.max(-1, Math.min(1, u1.dot(u2)));
          const omega = Math.acos(dot);
          let mid = u1.clone().add(u2);
          if (mid.lengthSq() < 1e-4) {
            const ortho =
              Math.abs(u1.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
            mid = new THREE.Vector3().crossVectors(u1, ortho);
          }
          mid.normalize();
          const spherical = new THREE.Spherical().setFromVector3(mid);
          cameraTargetRef.current = {
            theta: spherical.theta,
            phi: Math.max(0.28, Math.min(Math.PI - 0.28, spherical.phi)),
            radius: Math.min(305, Math.max(258, 244 + omega * 22)),
          };
          setAutoRotate(false);
          return;
        }
      }
    }

    if (!selectedNodeUuid) return;
    if (Date.now() - lastFocusSeqTimestampRef.current < 150) return;
    const node = nodes.find((n) => n.uuid === selectedNodeUuid);
    if (node?.properties.lat !== undefined && node.properties.lng !== undefined) {
      const vec = latLngToVector3(node.properties.lat, node.properties.lng, 1);
      const spherical = new THREE.Spherical().setFromVector3(vec);
      const currentRadius =
        cameraTargetRef.current?.radius ??
        sceneRefs.current?.spherical.radius ??
        232;
      cameraTargetRef.current = {
        theta: spherical.theta,
        phi: Math.max(0.2, Math.min(Math.PI - 0.2, spherical.phi)),
        radius: Math.max(MIN_GLOBE_CAMERA_RADIUS, Math.min(232, currentRadius)),
      };
      setAutoRotate(false);
    }
  }, [selectedEdgeUuid, selectedNodeUuid, nodes, edges]);

  interface PulseTraveler {
    sprite: THREE.Sprite;
    pts: THREE.Vector3[];
    speed: number;
    phase: number;
  }

  interface ArcMidpointMeta {
    edge: ETGEdge;
    midpoint: THREE.Vector3;
    badgeText: string;
    pairLabel: string;
    statText: string | null;
    colorCss: string;
    isSelected: boolean;
  }

  interface ComparisonArcMidpointMeta {
    midpoint: THREE.Vector3;
    badgeText: string;
    pairLabel: string;
    statText: string | null;
    colorCss: string;
  }

  const sceneRefs = useRef<{
    scene: THREE.Scene;
    earthMesh: THREE.Mesh;
    earthMat: THREE.ShaderMaterial;
    cloudMesh: THREE.Mesh;
    cloudMat: THREE.ShaderMaterial;
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
  } | null>(null);

  // Sync pin visibility without recreating geometry
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    refs.markersGroup.visible = showPins;
  }, [showPins]);

  // Toggle 3D cloud deck & surface cloud-shadow uniform live without recreating scene
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    refs.cloudMesh.visible = showClouds;
    refs.earthMat.uniforms.uCloudsEnabled.value = showClouds ? 1.0 : 0.0;
  }, [showClouds]);

  // Update sun vector & day/night mode live across surface, clouds, and Rayleigh limb
  useEffect(() => {
    const applySun = () => {
      const now = new Date();
      setLiveUtcTime(now.toISOString().slice(11, 16) + " UTC");
      const refs = sceneRefs.current;
      if (!refs) return;
      const dayNightEnabled = sunPreset === "daylight" ? 0.0 : 1.0;
      refs.earthMat.uniforms.uDayNightEnabled.value = dayNightEnabled;
      const dir = computeSunDirection(sunPreset, now);
      (refs.earthMat.uniforms.uSunDir.value as THREE.Vector3).copy(dir);
      (refs.cloudMat.uniforms.uSunDir.value as THREE.Vector3).copy(dir);
      (refs.atmoMat.uniforms.uSunDir.value as THREE.Vector3).copy(dir);
    };

    applySun();
    if (sunPreset !== "live") return;
    const timer = window.setInterval(applySun, 15_000);
    return () => window.clearInterval(timer);
  }, [sunPreset]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let currentW = container.clientWidth || 800;
    let currentH = container.clientHeight || 520;
    let currentViewOffsetX = 0;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, currentW / currentH, 1, 2000);
    const spherical = new THREE.Spherical(270, Math.PI * 0.41, 0.9);
    camera.position.setFromSpherical(spherical);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(currentW, currentH);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    container.appendChild(renderer.domElement);

    const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const loader = new THREE.TextureLoader();

    const configureEquirect = (tex: THREE.Texture, isSrgb: boolean) => {
      if (isSrgb) tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = maxAnisotropy;
      return tex;
    };

    const blueMarbleTex = configureEquirect(loader.load("/textures/earth/earth-blue-marble.jpg"), true);
    const normalTex = configureEquirect(loader.load("/textures/earth/earth-normal-2k.jpg"), false);
    const waterTex = configureEquirect(loader.load("/textures/earth/earth-specular-2k.jpg"), false);
    const lightsTex = configureEquirect(loader.load("/textures/earth/earth-lights-2k.png"), true);
    const nightTex = configureEquirect(loader.load("/textures/earth/earth-night.jpg"), true);
    const cloudsTex = configureEquirect(loader.load("/textures/earth/earth-clouds.png"), true);

    const glowTex = createRadialGlowTexture();
    const ringTex = createRingReticleTexture();
    const starTex = createStarSpriteTexture();
    const placeholderRegionalTex = new THREE.DataTexture(
      new Uint8Array([12, 24, 42, 255]),
      1,
      1
    );
    placeholderRegionalTex.colorSpace = THREE.SRGBColorSpace;
    placeholderRegionalTex.needsUpdate = true;
    const sharedTextures = new Set<THREE.Texture>([
      glowTex,
      ringTex,
      starTex,
      placeholderRegionalTex,
    ]);

    const sunDirection = computeSunDirection(sunPresetRef.current);

    // Crisp multi-spectral background starfield
    const starCount = 1500;
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    const palette = [
      new THREE.Color(0xe2e8f0),
      new THREE.Color(0xbae6fd),
      new THREE.Color(0xfef3c7),
      new THREE.Color(0xcbd5e1),
    ];
    for (let i = 0; i < starCount; i++) {
      const r = 560 + Math.random() * 380;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.cos(phi);
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      const c = palette[i % palette.length];
      const brightness = 0.42 + Math.random() * 0.58;
      starColors[i * 3] = c.r * brightness;
      starColors[i * 3 + 1] = c.g * brightness;
      starColors[i * 3 + 2] = c.b * brightness;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute("color", new THREE.BufferAttribute(starColors, 3));
    const starMat = new THREE.PointsMaterial({
      size: 2.6,
      map: starTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // 1. Cinema-Grade PBR-Inspired Orbital Earth Shader
    // - 2K tangent-space mountain normals (land-masked, pole-faded) + subtle ocean micro-waves
    // - Real-time 3D cloud shadows projected onto oceans and continents along -sunDir
    // - Dual-lobe solar ocean glint occluded by clouds (no flat gray blob)
    // - Sunlit Rayleigh aerial perspective + Mie sunset terminator + VIIRS city lights
    const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 160, 120);
    const earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uDayMap: { value: blueMarbleTex },
        uNormalMap: { value: normalTex },
        uWaterMap: { value: waterTex },
        uLightsMap: { value: lightsTex },
        uNightMap: { value: nightTex },
        uCloudMap: { value: cloudsTex },
        uSunDir: { value: sunDirection.clone() },
        uDayNightEnabled: { value: sunPresetRef.current === "daylight" ? 0.0 : 1.0 },
        uCloudDriftU: { value: 0.0 },
        uCloudsEnabled: { value: showCloudsRef.current ? 1.0 : 0.0 },
        uRegionalMap: { value: placeholderRegionalTex },
        uRegionalBounds: { value: new THREE.Vector4(-113, 33, -97, 45) },
        uRegionalBlend: { value: 0.0 },
        uRegionalDataMode: { value: 0.0 },
        uGlobalLayerMap: { value: placeholderRegionalTex },
        uGlobalLayerBlend: { value: 0.0 },
        uGlobalDataMode: { value: 0.0 },
        uGlobalFilterMode: { value: 0.0 },
        uGlobalTexSize: { value: new THREE.Vector2(2048, 1024) },
        uFilterSmooth: { value: filterSmoothRef.current ? 1.0 : 0.0 },
        uBordersMap: { value: placeholderRegionalTex },
        uBordersLoaded: { value: 0.0 },
        uSliceWindsMap: { value: placeholderRegionalTex },
        uSlicePrecipMap: { value: placeholderRegionalTex },
        uSliceCloudsMap: { value: placeholderRegionalTex },
        uCameraRight: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uDayMap;
        uniform sampler2D uNormalMap;
        uniform sampler2D uWaterMap;
        uniform sampler2D uLightsMap;
        uniform sampler2D uNightMap;
        uniform sampler2D uCloudMap;
        uniform vec3 uSunDir;
        uniform float uDayNightEnabled;
        uniform float uCloudDriftU;
        uniform float uCloudsEnabled;
        uniform sampler2D uRegionalMap;
        uniform vec4 uRegionalBounds;
        uniform float uRegionalBlend;
        uniform float uRegionalDataMode;
        uniform sampler2D uGlobalLayerMap;
        uniform float uGlobalLayerBlend;
        uniform float uGlobalDataMode;
        uniform float uGlobalFilterMode;
        uniform vec2 uGlobalTexSize;
        uniform float uFilterSmooth;
        uniform sampler2D uBordersMap;
        uniform float uBordersLoaded;
        uniform sampler2D uSliceWindsMap;
        uniform sampler2D uSlicePrecipMap;
        uniform sampler2D uSliceCloudsMap;
        uniform vec3 uCameraRight;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPos;

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        float noise3(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
              mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x),
              f.y
            ),
            mix(
              mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
              mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x),
              f.y
            ),
            f.z
          );
        }

        float filterSmoothRadius(float mode) {
          if (mode < 1.5) return 1.15; // winds (2.5K MERRA-2 50km contour smoothing)
          if (mode < 2.5) return 0.90; // precip (5K IMERG 10km + vapor)
          if (mode < 3.5) return 0.70; // thermal (5K 1km MUR SST + MODIS LST)
          if (mode < 4.5) return 0.75; // sst_anomaly (5K 1km MUR SST — sharp eddies, smooth steps)
          if (mode < 5.5) return 1.15; // air_temp (2.5K MERRA-2 50km)
          if (mode < 6.5) return 1.15; // aerosols (2.5K MERRA-2 50km)
          if (mode < 7.5) return 0.35; // ndvi (5K 250m MODIS river basins)
          return 0.0;                  // true_color & night_viirs razor-sharp
        }

        vec4 sampleGlobalField(sampler2D tex, vec2 uv, vec2 texSize, float sinPhi, float radius) {
          if (radius <= 0.01) {
            return texture2D(tex, uv);
          }
          float lonScale = clamp(1.0 / max(0.26, sinPhi), 1.0, 3.0);
          vec2 px = vec2(radius * lonScale / max(512.0, texSize.x), radius / max(256.0, texSize.y));

          vec4 c0 = texture2D(tex, uv);
          vec4 i1 = texture2D(tex, vec2(fract(uv.x + 1.20 * px.x), clamp(uv.y + 0.40 * px.y, 0.0005, 0.9995)));
          vec4 i2 = texture2D(tex, vec2(fract(uv.x - 0.40 * px.x), clamp(uv.y + 1.20 * px.y, 0.0005, 0.9995)));
          vec4 i3 = texture2D(tex, vec2(fract(uv.x - 1.20 * px.x), clamp(uv.y - 0.40 * px.y, 0.0005, 0.9995)));
          vec4 i4 = texture2D(tex, vec2(fract(uv.x + 0.40 * px.x), clamp(uv.y - 1.20 * px.y, 0.0005, 0.9995)));
          vec4 o1 = texture2D(tex, vec2(fract(uv.x + 2.50 * px.x), clamp(uv.y - 0.80 * px.y, 0.0005, 0.9995)));
          vec4 o2 = texture2D(tex, vec2(fract(uv.x + 0.80 * px.x), clamp(uv.y + 2.50 * px.y, 0.0005, 0.9995)));
          vec4 o3 = texture2D(tex, vec2(fract(uv.x - 2.50 * px.x), clamp(uv.y + 0.80 * px.y, 0.0005, 0.9995)));
          vec4 o4 = texture2D(tex, vec2(fract(uv.x - 0.80 * px.x), clamp(uv.y - 2.50 * px.y, 0.0005, 0.9995)));

          float w0 = 0.22 * max(c0.a, 0.002);
          float wi1 = 0.12 * max(i1.a, 0.002);
          float wi2 = 0.12 * max(i2.a, 0.002);
          float wi3 = 0.12 * max(i3.a, 0.002);
          float wi4 = 0.12 * max(i4.a, 0.002);
          float wo1 = 0.075 * max(o1.a, 0.002);
          float wo2 = 0.075 * max(o2.a, 0.002);
          float wo3 = 0.075 * max(o3.a, 0.002);
          float wo4 = 0.075 * max(o4.a, 0.002);

          float wSum = w0 + wi1 + wi2 + wi3 + wi4 + wo1 + wo2 + wo3 + wo4;
          vec3 rgb = (
            c0.rgb * w0 +
            i1.rgb * wi1 + i2.rgb * wi2 + i3.rgb * wi3 + i4.rgb * wi4 +
            o1.rgb * wo1 + o2.rgb * wo2 + o3.rgb * wo3 + o4.rgb * wo4
          ) / max(0.0001, wSum);

          float alpha = 0.22 * c0.a +
            0.12 * (i1.a + i2.a + i3.a + i4.a) +
            0.075 * (o1.a + o2.a + o3.a + o4.a);

          return vec4(rgb, alpha);
        }

        vec3 evalScientificFilter(
          float mode,
          vec4 s,
          float cloudRaw,
          vec3 crispLand,
          vec3 slateLand,
          vec3 deepOcean,
          float landMask,
          float waterMask,
          float reliefMod,
          float filterSunFloor,
          vec3 albedo,
          vec3 cityLights
        ) {
          float sa = clamp(s.a, 0.0, 1.0);
          if (mode < 1.5) {
            // 1.0: GEOS / MERRA-2 Surface Winds (natural continents + deep sapphire calm seas + glowing wind belts)
            vec3 windRgb = (s.rgb / (1.0 + s.rgb * 0.12)) * 1.14;
            vec3 landWinds = mix(crispLand, windRgb * reliefMod, 0.20 * sa);
            float windEnergy = max(s.r - s.g * 0.92, (0.82 - s.g) * 1.3) + max(0.0, s.b - s.g) * 0.8;
            float windSignal = smoothstep(0.03, 0.34, windEnergy);
            vec3 calmSea = mix(deepOcean, vec3(0.06, 0.24, 0.56) * reliefMod, 0.42);
            vec3 oceanWinds = mix(calmSea, windRgb, windSignal * sa);
            oceanWinds = mix(oceanWinds, vec3(0.92, 0.96, 1.0), smoothstep(0.62, 0.94, cloudRaw) * 0.32 * waterMask);
            return mix(oceanWinds, landWinds, landMask) * filterSunFloor;
          }
          if (mode < 2.5) {
            // 2.0: GEOS / IMERG Precipitable Water & Rain (key dry cream air over slate land & sapphire ocean + storm tops)
            float isDryCream = smoothstep(0.30, 0.04, abs(s.r - s.g) + max(0.0, 0.78 - s.g));
            vec3 dryBase = mix(deepOcean, slateLand, landMask);
            vec3 moistBand = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.10 * reliefMod;
            vec3 precipCol = mix(dryBase, mix(moistBand, dryBase, isDryCream), 0.92 * sa);
            float cloudTops = smoothstep(0.48, 0.88, cloudRaw) * (1.0 - isDryCream * 0.65);
            precipCol = mix(precipCol, vec3(0.96, 0.98, 1.0) * reliefMod, cloudTops * 0.82);
            return precipCol * filterSunFloor;
          }
          if (mode < 3.5) {
            // 3.0: Thermal Skin Temp (MUR SST + MODIS LST with subtle bathymetry & mountain relief)
            vec3 thermalRgb = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.06 * reliefMod;
            return mix(mix(deepOcean, crispLand, landMask), thermalRgb, sa * 0.90) * filterSunFloor;
          }
          if (mode < 4.5) {
            // 4.0: Ocean Temp Anomaly (key neutral ~0°C white into deep sapphire ocean + smooth thermal roll-off)
            float cMax = max(s.r, max(s.g, s.b));
            float cMin = min(s.r, min(s.g, s.b));
            float chroma = cMax - cMin;
            float anomalyStrength = chroma + max(0.0, 0.82 - cMin) * 0.90;
            float anomalyMask = smoothstep(0.10, 0.42, anomalyStrength);
            float warmCore = smoothstep(0.25, 0.65, s.r - s.g) * smoothstep(0.35, 0.05, s.g);
            vec3 sstRgb = s.rgb;
            sstRgb.b = mix(sstRgb.b, sstRgb.b * 0.55, warmCore * 0.65);
            sstRgb.g = mix(sstRgb.g, max(sstRgb.g, sstRgb.r * 0.14), warmCore * 0.55);
            sstRgb = (sstRgb / (1.0 + sstRgb * 0.14)) * 1.10;
            vec3 sstSea = mix(deepOcean, sstRgb * reliefMod, sa * anomalyMask * 0.88);
            return mix(sstSea, crispLand, landMask) * filterSunFloor;
          }
          if (mode < 5.5) {
            // 5.0: 2m Air Temperature (MERRA-2 with subtle bathymetry & mountain relief)
            vec3 airRgb = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.06 * reliefMod;
            return mix(mix(deepOcean, crispLand, landMask), airRgb, sa * 0.88) * filterSunFloor;
          }
          if (mode < 6.5) {
            // 6.0: Aerosols, Smoke & Dust (key out low-AOD background so plumes pop cleanly)
            float plumeMask = smoothstep(0.01, 0.30, s.r - s.b * 0.85) * 0.90 * sa;
            vec3 cleanBase = mix(deepOcean, crispLand, landMask);
            vec3 plumeRgb = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.10 * reliefMod;
            return mix(cleanBase, plumeRgb, plumeMask) * filterSunFloor;
          }
          if (mode < 7.5) {
            // 7.0: Vegetation Canopy (MODIS 250m NDVI over continents + deep sapphire ocean)
            vec3 ndviLand = mix(crispLand, s.rgb * reliefMod * 1.04, sa * 0.90);
            return mix(deepOcean, ndviLand, landMask) * filterSunFloor;
          }
          if (mode < 8.5) {
            // 8.0: Satellite True Color + Clouds (MODIS — fill narrow equatorial swath gaps with 4K Blue Marble)
            float swathValid = smoothstep(0.008, 0.045, max(s.r, max(s.g, s.b))) * sa;
            return mix(mix(deepOcean, crispLand, landMask), s.rgb * reliefMod, swathValid) * filterSunFloor;
          }
          // 9.0: Night Radiance (VIIRS Black Marble)
          return albedo * 0.035 + s.rgb * 1.35 + cityLights * 0.65;
        }

        void main() {
          vec3 N0 = normalize(vWorldNormal);
          float specSample = texture2D(uWaterMap, vUv).r;
          float waterMask = smoothstep(0.24, 0.72, specSample);
          float landMask = 1.0 - waterMask;

          // Right-handed spherical tangent frame: +u = east, +v = north, +z = N0
          float sinPhi = clamp(length(vec2(N0.x, N0.z)), 0.0, 1.0);
          float poleFade = smoothstep(0.05, 0.24, sinPhi);
          vec3 east = sinPhi > 0.001 ? normalize(vec3(N0.z, 0.0, -N0.x)) : vec3(1.0, 0.0, 0.0);
          vec3 north = normalize(cross(N0, east));

          // Combine 2K normal map with subtle ocean capillary ripple micro-normals
          vec3 nMap = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
          float w1 = noise3(N0 * 78.0);
          float w2 = noise3(N0 * 78.0 + vec3(0.08, 0.0, 0.08));
          vec3 waterRipple = (east * (w2 - w1) + north * (w1 - 0.5)) * (0.045 * waterMask * poleFade);
          float landReliefScale = 1.35 * landMask * poleFade;
          vec3 N = normalize(
            N0 +
            east * (nMap.x * landReliefScale) +
            north * (nMap.y * landReliefScale) +
            waterRipple
          );

          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L_daylight = normalize(V + vec3(0.22, 0.36, 0.14));
          vec3 L = normalize(mix(L_daylight, normalize(uSunDir), uDayNightEnabled));
          float NdotV = max(dot(N0, V), 0.0);
          float sphereSunDot = dot(N0, L);
          float normalSunDot = max(dot(N, L), 0.0);
          float wrappedSun = max((dot(N, L) + 0.06) / 1.06, 0.0);

          // Sample drifting 3D cloud deck overhead + solar shadow projection onto planet surface
          float sunEast = dot(east, L);
          float sunNorth = dot(north, L);
          vec2 cloudUvAbove = vec2(fract(vUv.x - uCloudDriftU), clamp(vUv.y, 0.002, 0.998));
          float cloudAbove = smoothstep(0.14, 0.90, texture2D(uCloudMap, cloudUvAbove).a) * smoothstep(0.03, 0.16, sinPhi) * uCloudsEnabled;

          // Project cloud shadow opposite the solar tangent (stronger at oblique grazing sun angles)
          float obliquity = mix(0.0024, 0.0068, 1.0 - clamp(sphereSunDot, 0.0, 1.0));
          vec2 cloudShadowUv = vec2(
            fract(vUv.x - uCloudDriftU + sunEast * obliquity),
            clamp(vUv.y + sunNorth * obliquity, 0.002, 0.998)
          );
          float cloudShadowSample = texture2D(uCloudMap, cloudShadowUv).a;
          float cloudShadow = smoothstep(0.18, 0.92, cloudShadowSample) * smoothstep(0.03, 0.16, sinPhi) * smoothstep(-0.02, 0.35, sphereSunDot) * uCloudsEnabled;

          // Atmospheric Mie extinction along the terminator turns low sun rays golden-copper
          float daylightTerm = mix(1.0, smoothstep(-0.06, 0.42, sphereSunDot), uDayNightEnabled);
          float twilightBell = exp(-pow((sphereSunDot + 0.015) * 6.8, 2.0)) * uDayNightEnabled;
          vec3 directSolarTint = mix(
            vec3(1.02, 1.00, 0.98),
            mix(vec3(1.0, 0.56, 0.28), vec3(1.04, 1.01, 0.97), smoothstep(0.0, 0.36, sphereSunDot)),
            uDayNightEnabled
          );

          vec3 albedo = texture2D(uDayMap, vUv).rgb;
          // Deepen pelagic ocean sapphire while keeping continental shelves & turquoise atolls luminous
          albedo = mix(albedo, albedo * vec3(0.76, 0.88, 1.08), waterMask * 0.36);

          // Diffuse reflectance (shadowed beneath 3D clouds)
          float directAtten = wrappedSun * (1.0 - cloudShadow * 0.40) * daylightTerm;
          vec3 ambientSky = albedo * mix(
            vec3(0.24, 0.26, 0.31),
            mix(vec3(0.009, 0.014, 0.028), vec3(0.035, 0.055, 0.095), smoothstep(-0.18, 0.45, sphereSunDot)),
            uDayNightEnabled
          );
          float diffuseScale = mix(0.86, 1.16, uDayNightEnabled);
          vec3 diffuse = albedo * directSolarTint * directAtten * diffuseScale + ambientSky;

          // Dual-lobe solar ocean sunglint + ocean Fresnel sky reflection (occluded by clouds!)
          vec3 H = normalize(L + V);
          float NdotH = max(dot(normalize(mix(N0, N, 0.35)), H), 0.0);
          float sunVisibility = mix(0.32, smoothstep(-0.02, 0.26, sphereSunDot), uDayNightEnabled) * (1.0 - cloudShadow * 0.72);
          float tightGlint = pow(NdotH, 340.0) * 1.05;
          float waveScatter = pow(NdotH, 26.0) * 0.085;
          vec3 solarGlint = vec3(1.0, 0.95, 0.86) * (tightGlint + waveScatter) * waterMask * sunVisibility;

          float fresnel = pow(1.0 - NdotV, 4.4);
          vec3 oceanSkyRefl = vec3(0.14, 0.38, 0.72) * fresnel * waterMask * mix(1.0, smoothstep(-0.18, 0.55, sphereSunDot), uDayNightEnabled) * 0.28;

          // Rayleigh sunlit horizon scatter & warm Mie sunset glow right across the terminator
          float horizonRim = pow(1.0 - NdotV, 3.2);
          vec3 rayleighVeil = vec3(0.24, 0.54, 0.96) * horizonRim * mix(0.85, smoothstep(-0.08, 0.58, sphereSunDot), uDayNightEnabled) * 0.34;
          vec3 mieTerminator = vec3(0.98, 0.44, 0.14) * twilightBell * (0.09 + 0.16 * landMask + 0.22 * horizonRim);

          // Crisp VIIRS Night City Lights on dark hemisphere (occluded gently under dense clouds)
          float nightMask = smoothstep(0.08, -0.22, sphereSunDot) * uDayNightEnabled;
          vec3 lights2k = texture2D(uLightsMap, vUv).rgb;
          vec3 nightBg = texture2D(uNightMap, vUv).rgb;
          float warmLegacy = max(0.0, nightBg.r - nightBg.b * 0.65);
          vec3 citySignal = max(lights2k * 1.15, vec3(warmLegacy) * 0.7);
          float cityLuma = dot(citySignal, vec3(0.35, 0.45, 0.2));
          vec3 cityLights =
            vec3(1.0, 0.76, 0.42) *
            smoothstep(0.06, 0.68, cityLuma) *
            1.65 *
            nightMask *
            (1.0 - waterMask * 0.88) *
            (1.0 - cloudAbove * 0.62);

          vec3 finalColor = diffuse + solarGlint + oceanSkyRefl + rayleighVeil + mieTerminator + cityLights;

          // Blend full-sphere NASA SVS / GEOS-5 style scientific filter or 4-slice composite
          if (uGlobalLayerBlend > 0.001 && uGlobalFilterMode > 0.5) {
            float filterSunFloor = mix(1.0, mix(0.84, 1.05, smoothstep(-0.25, 0.45, sphereSunDot)), uDayNightEnabled);
            float reliefMod = mix(0.90, 1.12, clamp(dot(N, L_daylight) * 0.65 + 0.35, 0.0, 1.0));
            float filterWaterMask = smoothstep(0.36, 0.56, specSample);
            float filterLandMask = 1.0 - filterWaterMask;
            vec3 deepOcean = mix(albedo * vec3(0.45, 0.68, 1.05), vec3(0.035, 0.115, 0.34), 0.72) * reliefMod;
            vec3 crispLand = albedo * reliefMod * 1.04;
            vec3 slateLand = mix(vec3(dot(albedo, vec3(0.3, 0.59, 0.11)) * 0.92), albedo, 0.22) * reliefMod;
            float cloudRaw = texture2D(uCloudMap, cloudUvAbove).a;

            vec3 globalColor;
            if (uGlobalFilterMode > 9.5) {
              // 10.0: 4-Slice NASA SVS Showcase (Canopy | Winds | Precipitable Water | Satellite Clouds)
              float viewX = dot(N0, normalize(uCameraRight));
              if (viewX < -0.34) {
                globalColor = mix(deepOcean, crispLand * vec3(0.92, 1.12, 0.88), filterLandMask) * filterSunFloor;
              } else if (viewX < 0.0) {
                vec4 sw = sampleGlobalField(uSliceWindsMap, vUv, vec2(2560.0, 1280.0), sinPhi, 1.15 * uFilterSmooth);
                globalColor = evalScientificFilter(1.0, sw, cloudRaw, crispLand, slateLand, deepOcean, filterLandMask, filterWaterMask, reliefMod, filterSunFloor, albedo, cityLights);
              } else if (viewX < 0.34) {
                vec4 sp = sampleGlobalField(uSlicePrecipMap, vUv, vec2(2560.0, 1280.0), sinPhi, 0.90 * uFilterSmooth);
                globalColor = evalScientificFilter(2.0, sp, cloudRaw, crispLand, slateLand, deepOcean, filterLandMask, filterWaterMask, reliefMod, filterSunFloor, albedo, cityLights);
              } else {
                vec4 sc = texture2D(uSliceCloudsMap, vUv);
                globalColor = evalScientificFilter(8.0, sc, cloudRaw, crispLand, slateLand, deepOcean, filterLandMask, filterWaterMask, reliefMod, filterSunFloor, albedo, cityLights);
              }
              float d1 = abs(viewX + 0.34);
              float d2 = abs(viewX);
              float d3 = abs(viewX - 0.34);
              float seam = smoothstep(0.009, 0.002, min(d1, min(d2, d3)));
              globalColor = mix(globalColor, vec3(0.86, 0.92, 0.98), seam * 0.72);
            } else {
              vec4 globalSample = sampleGlobalField(
                uGlobalLayerMap,
                vUv,
                uGlobalTexSize,
                sinPhi,
                filterSmoothRadius(uGlobalFilterMode) * uFilterSmooth
              );
              globalColor = evalScientificFilter(
                uGlobalFilterMode,
                globalSample,
                cloudRaw,
                crispLand,
                slateLand,
                deepOcean,
                filterLandMask,
                filterWaterMask,
                reliefMod,
                filterSunFloor,
                albedo,
                cityLights
              );
            }

            if (uBordersLoaded > 0.5) {
              vec4 bdr = texture2D(uBordersMap, vUv);
              vec3 borderTint = (uGlobalFilterMode > 8.5 && uGlobalFilterMode < 9.5)
                ? vec3(0.48, 0.56, 0.68)
                : vec3(0.07, 0.10, 0.15);
              globalColor = mix(globalColor, borderTint, bdr.a * 0.78);
            }

            finalColor = mix(finalColor, globalColor + rayleighVeil * 0.28, uGlobalLayerBlend);
          }

          // Blend live NASA GIBS regional satellite / thermal / NDVI / night swath seamlessly
          if (uRegionalBlend > 0.001) {
            float fragLng = vUv.x * 360.0 - 180.0;
            float fragLat = vUv.y * 180.0 - 90.0;
            vec2 regUv = vec2(
              (fragLng - uRegionalBounds.x) / max(0.001, uRegionalBounds.z - uRegionalBounds.x),
              (fragLat - uRegionalBounds.y) / max(0.001, uRegionalBounds.w - uRegionalBounds.y)
            );
            if (regUv.x > 0.0 && regUv.x < 1.0 && regUv.y > 0.0 && regUv.y < 1.0) {
              float edgeDist = min(min(regUv.x, 1.0 - regUv.x), min(regUv.y, 1.0 - regUv.y));
              float feather = smoothstep(0.0, 0.085, edgeDist) * uRegionalBlend;
              vec3 gibsSample = texture2D(uRegionalMap, regUv).rgb;
              float inspectIllum = mix(0.82, 1.06, smoothstep(-0.15, 0.45, sphereSunDot));
              float reliefMod = mix(0.94, 1.08, clamp(normalSunDot * 0.65 + 0.35, 0.0, 1.0));
              vec3 naturalRegional = gibsSample * inspectIllum * reliefMod + rayleighVeil * 0.35;
              vec3 dataRegional = gibsSample * 1.02 + rayleighVeil * 0.18;
              vec3 regionalColor = mix(naturalRegional, dataRegional, uRegionalDataMode);
              finalColor = mix(finalColor, regionalColor, feather);
            }
          }

          gl_FragColor = vec4(finalColor, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    scene.add(earthMesh);

    // 2. Crisp Fibrous 3D Cloud Deck (indexed PNG .a enhanced with seamless 3D FBM detail)
    const cloudGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.0105, 128, 96);
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uCloudMap: { value: cloudsTex },
        uSunDir: { value: sunDirection.clone() },
        uDayNightEnabled: earthMat.uniforms.uDayNightEnabled,
        uRegionalFade: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uCloudMap;
        uniform vec3 uSunDir;
        uniform float uDayNightEnabled;
        uniform float uRegionalFade;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPos;

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        float noise3(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
              mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x),
              f.y
            ),
            mix(
              mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
              mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x),
              f.y
            ),
            f.z
          );
        }

        float fbm(vec3 p) {
          return 0.65 * noise3(p) + 0.35 * noise3(p * 2.15 + 4.3);
        }

        void main() {
          vec3 wn = normalize(vWorldNormal);
          float sinPhiC = clamp(length(vec2(wn.x, wn.z)), 0.0, 1.0);
          float rawCloud = texture2D(uCloudMap, vUv).a;
          float fineWisp = fbm(wn * 22.0);
          float sculpted = clamp(rawCloud * (0.78 + 0.42 * fineWisp), 0.0, 1.0);
          float cloudDensity = smoothstep(0.12, 0.90, sculpted) * smoothstep(0.03, 0.16, sinPhiC);

          vec3 L = normalize(uSunDir);
          float sunTerm = dot(wn, L);
          float dayFade = mix(1.0, smoothstep(-0.14, 0.48, sunTerm), uDayNightEnabled);
          float sunsetBand = exp(-pow((sunTerm + 0.01) * 7.2, 2.0)) * uDayNightEnabled;

          vec3 cloudRgb = mix(vec3(0.06, 0.09, 0.16), vec3(0.97, 0.985, 1.0), dayFade);
          cloudRgb = mix(cloudRgb, vec3(1.0, 0.62, 0.34), sunsetBand * 0.55);

          float alpha = cloudDensity * mix(0.14, 0.44, dayFade) * uRegionalFade;
          gl_FragColor = vec4(cloudRgb, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    cloudMesh.visible = showCloudsRef.current;
    scene.add(cloudMesh);

    // 4a. Subtle Inner Atmospheric Limb Sheen (day-weighted)
    const innerHazeGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.0035, 96, 64);
    const innerHazeMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: earthMat.uniforms.uSunDir,
        uDayNightEnabled: earthMat.uniforms.uDayNightEnabled,
      },
      vertexShader: `
        varying vec3 vWorldNormal;
        varying vec3 vViewPos;
        void main() {
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewPos = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDir;
        uniform float uDayNightEnabled;
        varying vec3 vWorldNormal;
        varying vec3 vViewPos;
        void main() {
          vec3 N = normalize(vWorldNormal);
          vec3 V = normalize(cameraPosition - N * ${EARTH_RADIUS.toFixed(1)});
          float rim = 1.0 - max(dot(N, V), 0.0);
          float sunSide = mix(1.0, smoothstep(-0.28, 0.62, dot(N, normalize(uSunDir))), uDayNightEnabled);
          float alpha = pow(rim, 4.0) * (0.04 + 0.28 * sunSide);
          gl_FragColor = vec4(0.32, 0.70, 1.0, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const innerHazeMesh = new THREE.Mesh(innerHazeGeo, innerHazeMat);
    scene.add(innerHazeMesh);

    // 4b. Outer Rayleigh & Sunset Atmospheric Crescent Limb (sunlit-modulated!)
    const atmoGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.058, 96, 64);
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: sunDirection.clone() },
        uDayNightEnabled: earthMat.uniforms.uDayNightEnabled,
      },
      vertexShader: `
        varying vec3 vViewNormal;
        varying vec3 vWorldNormal;
        void main() {
          vViewNormal = normalize(normalMatrix * normal);
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDir;
        uniform float uDayNightEnabled;
        varying vec3 vViewNormal;
        varying vec3 vWorldNormal;
        void main() {
          float rim = pow(clamp(0.64 - dot(normalize(vViewNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.4);
          float sunDot = dot(normalize(vWorldNormal), normalize(uSunDir));
          float sunlit = mix(1.0, smoothstep(-0.36, 0.62, sunDot), uDayNightEnabled);
          float sunsetEdge = exp(-pow(sunDot * 5.2, 2.0)) * uDayNightEnabled;
          vec3 limbColor = mix(vec3(0.24, 0.62, 1.0), vec3(0.98, 0.48, 0.20), sunsetEdge * 0.58);
          float intensity = rim * (0.07 + 0.92 * sunlit);
          gl_FragColor = vec4(limbColor, 1.0) * intensity * 0.92;
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
    scene.add(atmoMesh);

    const markersGroup = new THREE.Group();
    markersGroup.visible = showPinsRef.current;
    const arcsGroup = new THREE.Group();
    const probeGroup = new THREE.Group();
    const regionalGroup = new THREE.Group();
    scene.add(regionalGroup);
    scene.add(arcsGroup);
    scene.add(markersGroup);
    scene.add(probeGroup);

    const gibsLoader = new THREE.TextureLoader();
    gibsLoader.setCrossOrigin("anonymous");
    const gibsCache = new Map<string, THREE.Texture>();
    const globalGibsCache = new Map<string, THREE.Texture>();
    const globalWmtsCache = new Map<string, THREE.CanvasTexture>();
    const failedTileUntil = new Map<string, number>();
    const failedGlobalUntil = new Map<string, number>();
    const isTextureBoundToUniform = (tex: THREE.Texture) =>
      tex === earthMat.uniforms.uRegionalMap.value ||
      tex === earthMat.uniforms.uGlobalLayerMap.value ||
      tex === earthMat.uniforms.uSliceWindsMap.value ||
      tex === earthMat.uniforms.uSlicePrecipMap.value ||
      tex === earthMat.uniforms.uSliceCloudsMap.value ||
      tex === earthMat.uniforms.uBordersMap.value;
    const textureTracker = createDynamicTextureTracker<THREE.Texture>(
      isTextureBoundToUniform
    );
    const inFlightTileImages = new Set<HTMLImageElement>();
    const abortInFlightTileImages = () => {
      for (const img of inFlightTileImages) {
        img.onload = null;
        img.onerror = null;
        img.src = "";
      }
      inFlightTileImages.clear();
    };
    let disposed = false;
    let gibsReqSeq = 0;
    let globalReqSeq = 0;
    let regionalTexLoaded = false;
    let globalTexLoaded = false;
    let activeGlobalKey = "";
    let lastCheckedTileKey = "";
    let lastRequestedTileKey = "";
    let lastHudCenterSig = "";
    let lastTileEvalMs = 0;
    let gibsDebounceTimer: number | null = null;
    let bordersTex: THREE.Texture | null = null;
    let bordersLoading = false;
    let borders4kLoaded = false;
    let borders4kLoading = false;

    const ensureBordersLoaded = () => {
      if (!bordersTex && !bordersLoading && !disposed) {
        bordersLoading = true;
        gibsLoader.load(
          computeGlobalBordersProxyUrl(),
          (tex) => {
            bordersLoading = false;
            if (disposed || borders4kLoaded) {
              tex.dispose();
              return;
            }
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            tex.anisotropy = maxAnisotropy;
            textureTracker.register(tex);
            bordersTex = tex;
            earthMat.uniforms.uBordersMap.value = tex;
            earthMat.uniforms.uBordersLoaded.value = 1.0;
            textureTracker.releaseUnbound();
          },
          undefined,
          () => {
            bordersLoading = false;
          }
        );
      }

      if (!borders4kLoaded && !borders4kLoading && !disposed) {
        borders4kLoading = true;
        const quadrants = computeGlobalBordersQuadrantSpecs();
        Promise.all(
          quadrants.map(
            (q) =>
              new Promise<{ img: HTMLImageElement; dx: number; dy: number }>((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                inFlightTileImages.add(img);
                img.onload = () => {
                  inFlightTileImages.delete(img);
                  resolve({ img, dx: q.dx, dy: q.dy });
                };
                img.onerror = () => {
                  inFlightTileImages.delete(img);
                  reject(new Error(`Border quadrant failed: ${q.bbox}`));
                };
                img.src = q.proxyUrl;
              })
          )
        )
          .then((loadedQuads) => {
            borders4kLoading = false;
            if (disposed) return;
            const maxGpu = renderer.capabilities.maxTextureSize || 4096;
            const targetW = maxGpu >= 4096 ? 4096 : 2048;
            const targetH = Math.round(targetW / 2);
            const scale = targetW / 4096;
            const canvas = document.createElement("canvas");
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            for (const item of loadedQuads) {
              ctx.drawImage(
                item.img,
                item.dx * scale,
                item.dy * scale,
                2048 * scale,
                1024 * scale
              );
            }
            const tex4k = new THREE.CanvasTexture(canvas);
            tex4k.colorSpace = THREE.SRGBColorSpace;
            tex4k.wrapS = THREE.RepeatWrapping;
            tex4k.wrapT = THREE.ClampToEdgeWrapping;
            tex4k.minFilter = THREE.LinearMipmapLinearFilter;
            tex4k.magFilter = THREE.LinearFilter;
            tex4k.generateMipmaps = true;
            tex4k.anisotropy = maxAnisotropy;
            textureTracker.register(tex4k);
            const oldBorders = bordersTex;
            bordersTex = tex4k;
            borders4kLoaded = true;
            earthMat.uniforms.uBordersMap.value = tex4k;
            earthMat.uniforms.uBordersLoaded.value = 1.0;
            if (oldBorders && oldBorders !== tex4k) {
              textureTracker.evictFromCache(oldBorders);
            }
            textureTracker.releaseUnbound();
          })
          .catch(() => {
            borders4kLoading = false;
          });
      }
    };

    const loadTileImage = (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        inFlightTileImages.add(img);
        img.onload = () => {
          inFlightTileImages.delete(img);
          resolve(img);
        };
        img.onerror = () => {
          inFlightTileImages.delete(img);
          reject(new Error(`WMTS tile failed: ${url}`));
        };
        img.src = url;
      });

    const loadWmtsMosaic = async (
      spec: GlobalWmtsMosaicSpec,
      isCancelled: () => boolean
    ): Promise<THREE.CanvasTexture> => {
      const cached = globalWmtsCache.get(spec.key);
      if (cached) {
        globalWmtsCache.delete(spec.key);
        globalWmtsCache.set(spec.key, cached);
        return cached;
      }

      const maxGpuTex = renderer.capabilities.maxTextureSize || 4096;
      const canNative5k = renderer.capabilities.isWebGL2 && maxGpuTex >= 5120;
      const targetW =
        spec.zoom === 3
          ? canNative5k
            ? 5120
            : Math.min(4096, maxGpuTex)
          : renderer.capabilities.isWebGL2
            ? 2560
            : 2048;
      const targetH = Math.round(targetW / 2);
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("2D canvas unavailable for WMTS mosaic");
      }

      const scaleX = targetW / spec.width;
      const scaleY = targetH / spec.height;
      const concurrency = 12;

      for (const sub of spec.subLayers) {
        if (disposed || isCancelled()) {
          throw new Error("Cancelled");
        }
        const tasks: Array<{ row: number; col: number }> = [];
        for (let row = 0; row < spec.rows; row++) {
          for (let col = 0; col < spec.cols; col++) {
            tasks.push({ row, col });
          }
        }
        let cursor = 0;
        let okCount = 0;
        let useFallback = false;

        const runWorker = async () => {
          while (cursor < tasks.length) {
            if (disposed || isCancelled()) {
              throw new Error("Cancelled");
            }
            const idx = cursor++;
            const { row, col } = tasks[idx]!;
            let img: HTMLImageElement | null = null;
            try {
              img = await loadTileImage(
                buildWmtsTileUrl(sub, spec.zoom, row, col, useFallback)
              );
            } catch {
              if (
                !useFallback &&
                !sub.timeless &&
                sub.dateIso !== sub.fallbackDateIso
              ) {
                useFallback = true;
                try {
                  img = await loadTileImage(
                    buildWmtsTileUrl(sub, spec.zoom, row, col, true)
                  );
                } catch {
                  img = null;
                }
              }
            }
            if (disposed || isCancelled()) {
              throw new Error("Cancelled");
            }
            if (img) {
              ctx.drawImage(
                img,
                col * spec.tileSize * scaleX,
                row * spec.tileSize * scaleY,
                spec.tileSize * scaleX,
                spec.tileSize * scaleY
              );
              okCount += 1;
            }
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(concurrency, tasks.length) }, () => runWorker())
        );
        if (okCount / tasks.length < 0.8) {
          throw new Error(`Incomplete WMTS mosaic for ${spec.key}`);
        }
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = maxAnisotropy;

      textureTracker.register(tex);
      globalWmtsCache.set(spec.key, tex);
      while (globalWmtsCache.size > 6) {
        const oldestKey = globalWmtsCache.keys().next().value;
        if (!oldestKey) break;
        const oldTex = globalWmtsCache.get(oldestKey);
        globalWmtsCache.delete(oldestKey);
        if (oldTex) {
          textureTracker.evictFromCache(oldTex);
        }
      }
      return tex;
    };

    const loadGlobalTexPromise = (spec: GlobalLayerSpec): Promise<THREE.Texture> => {
      const cached = globalGibsCache.get(spec.key);
      if (cached) {
        globalGibsCache.delete(spec.key);
        globalGibsCache.set(spec.key, cached);
        return Promise.resolve(cached);
      }
      if ((failedGlobalUntil.get(spec.key) ?? 0) > Date.now()) {
        return Promise.reject(new Error("Global layer cooldown"));
      }
      return new Promise((resolve, reject) => {
        gibsLoader.load(
          spec.proxyUrl,
          (tex) => {
            if (disposed) {
              tex.dispose();
              reject(new Error("Disposed"));
              return;
            }
            failedGlobalUntil.delete(spec.key);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            tex.anisotropy = maxAnisotropy;

            textureTracker.register(tex);
            globalGibsCache.set(spec.key, tex);
            while (globalGibsCache.size > 12) {
              const oldestKey = globalGibsCache.keys().next().value;
              if (!oldestKey) break;
              const oldTex = globalGibsCache.get(oldestKey);
              globalGibsCache.delete(oldestKey);
              if (oldTex) {
                textureTracker.evictFromCache(oldTex);
              }
            }
            resolve(tex);
          },
          undefined,
          () => {
            failedGlobalUntil.set(spec.key, Date.now() + 15_000);
            reject(new Error(`Failed to load ${spec.key}`));
          }
        );
      });
    };

    const syncGlobalMode = (
      mode: RegionalSatelliteMode,
      topics?: readonly ETGDatasetId[],
      cutoffMsVal?: number
    ) => {
      if (mode === "multi_slice") {
        const windsSpec = computeGlobalLayerSpec({ layerId: "winds", cutoffMs: cutoffMsVal });
        const precipSpec = computeGlobalLayerSpec({ layerId: "precip", cutoffMs: cutoffMsVal });
        const cloudsSpec = computeGlobalLayerSpec({ layerId: "true_color", cutoffMs: cutoffMsVal });
        const windsWmts = computeGlobalWmtsMosaicSpec({
          layerId: "winds",
          cutoffMs: cutoffMsVal,
          zoomOverride: 2,
        });
        const precipWmts = computeGlobalWmtsMosaicSpec({
          layerId: "precip",
          cutoffMs: cutoffMsVal,
          zoomOverride: 2,
        });
        const cloudsWmts = computeGlobalWmtsMosaicSpec({
          layerId: "true_color",
          cutoffMs: cutoffMsVal,
          zoomOverride: 3,
        });
        const reqKey = `multi_slice:${windsWmts.key}:${precipWmts.key}:${cloudsWmts.key}`;
        if (activeGlobalKey === reqKey && globalTexLoaded) {
          return;
        }
        activeGlobalKey = reqKey;
        const mySeq = ++globalReqSeq;
        ensureBordersLoaded();

        const cachedWmW = globalWmtsCache.get(windsWmts.key);
        const cachedWmP = globalWmtsCache.get(precipWmts.key);
        const cachedWmC = globalWmtsCache.get(cloudsWmts.key);
        if (cachedWmW && cachedWmP && cachedWmC) {
          earthMat.uniforms.uSliceWindsMap.value = cachedWmW;
          earthMat.uniforms.uSlicePrecipMap.value = cachedWmP;
          earthMat.uniforms.uSliceCloudsMap.value = cachedWmC;
          earthMat.uniforms.uGlobalFilterMode.value = 10.0;
          earthMat.uniforms.uGlobalDataMode.value = 1.0;
          globalTexLoaded = true;
          textureTracker.releaseUnbound();
          setGlobalHud({
            loading: false,
            error: false,
            dateIso: cloudsWmts.primaryDateIso,
            resBadge: "5K HD",
          });
          return;
        }

        const isCancelled = () =>
          disposed || mySeq !== globalReqSeq || activeGlobalKey !== reqKey;
        let multiWmtsApplied = false;
        let multiStage1Ready = false;
        let multiStage1Failed = false;
        let multiStage2Failed = false;

        const cachedW = globalGibsCache.get(windsSpec.key);
        const cachedP = globalGibsCache.get(precipSpec.key);
        const cachedC = globalGibsCache.get(cloudsSpec.key);
        if (cachedW && cachedP && cachedC) {
          earthMat.uniforms.uSliceWindsMap.value = cachedW;
          earthMat.uniforms.uSlicePrecipMap.value = cachedP;
          earthMat.uniforms.uSliceCloudsMap.value = cachedC;
          earthMat.uniforms.uGlobalFilterMode.value = 10.0;
          earthMat.uniforms.uGlobalDataMode.value = 1.0;
          globalTexLoaded = true;
          textureTracker.releaseUnbound();
          multiStage1Ready = true;
          setGlobalHud({
            loading: true,
            error: false,
            dateIso: cloudsSpec.dateIso,
            resBadge: "2K…",
          });
        } else {
          setGlobalHud({
            loading: true,
            error: false,
            dateIso: cloudsSpec.dateIso,
            resBadge: "Loading",
          });
          Promise.all([
            loadGlobalTexPromise(windsSpec),
            loadGlobalTexPromise(precipSpec),
            loadGlobalTexPromise(cloudsSpec),
          ])
            .then(([texW, texP, texC]) => {
              if (isCancelled() || multiWmtsApplied) return;
              earthMat.uniforms.uSliceWindsMap.value = texW;
              earthMat.uniforms.uSlicePrecipMap.value = texP;
              earthMat.uniforms.uSliceCloudsMap.value = texC;
              earthMat.uniforms.uGlobalFilterMode.value = 10.0;
              earthMat.uniforms.uGlobalDataMode.value = 1.0;
              globalTexLoaded = true;
              textureTracker.releaseUnbound();
              multiStage1Ready = true;
              setGlobalHud({
                loading: !multiStage2Failed,
                error: false,
                dateIso: cloudsSpec.dateIso,
                resBadge: multiStage2Failed ? "2K" : "2K…",
              });
            })
            .catch(() => {
              multiStage1Failed = true;
              if (isCancelled() || multiWmtsApplied) return;
              if (multiStage2Failed) {
                activeGlobalKey = "";
                setGlobalHud((prev) => ({
                  ...prev,
                  loading: false,
                  error: true,
                  resBadge: "",
                }));
              }
            });
        }

        Promise.all([
          loadWmtsMosaic(windsWmts, isCancelled),
          loadWmtsMosaic(precipWmts, isCancelled),
          loadWmtsMosaic(cloudsWmts, isCancelled),
        ])
          .then(([wmW, wmP, wmC]) => {
            if (isCancelled()) return;
            multiWmtsApplied = true;
            earthMat.uniforms.uSliceWindsMap.value = wmW;
            earthMat.uniforms.uSlicePrecipMap.value = wmP;
            earthMat.uniforms.uSliceCloudsMap.value = wmC;
            earthMat.uniforms.uGlobalFilterMode.value = 10.0;
            earthMat.uniforms.uGlobalDataMode.value = 1.0;
            globalTexLoaded = true;
            textureTracker.releaseUnbound();
            setGlobalHud({
              loading: false,
              error: false,
              dateIso: cloudsWmts.primaryDateIso,
              resBadge: "5K HD",
            });
          })
          .catch(() => {
            multiStage2Failed = true;
            if (isCancelled()) return;
            if (multiStage1Ready) {
              setGlobalHud((prev) => ({
                ...prev,
                loading: false,
                error: false,
                resBadge: "2K",
              }));
            } else if (multiStage1Failed) {
              activeGlobalKey = "";
              setGlobalHud((prev) => ({
                ...prev,
                loading: false,
                error: true,
                resBadge: "",
              }));
            }
          });
        return;
      }

      const layerId = resolveGlobalFilterLayer(mode, topics);
      if (!layerId) {
        activeGlobalKey = "";
        globalTexLoaded = false;
        earthMat.uniforms.uGlobalFilterMode.value = 0.0;
        setGlobalHud({ loading: false, error: false, dateIso: "", resBadge: "" });
        return;
      }

      const spec = computeGlobalLayerSpec({ layerId, cutoffMs: cutoffMsVal });
      const wmtsSpec = computeGlobalWmtsMosaicSpec({ layerId, cutoffMs: cutoffMsVal });
      if (activeGlobalKey === wmtsSpec.key && globalTexLoaded) {
        return;
      }
      activeGlobalKey = wmtsSpec.key;
      const mySeq = ++globalReqSeq;
      ensureBordersLoaded();

      const cachedWmts = globalWmtsCache.get(wmtsSpec.key);
      if (cachedWmts) {
        globalWmtsCache.delete(wmtsSpec.key);
        globalWmtsCache.set(wmtsSpec.key, cachedWmts);
        const wmtsImg = cachedWmts.image as HTMLCanvasElement | undefined;
        (earthMat.uniforms.uGlobalTexSize.value as THREE.Vector2).set(
          wmtsImg?.width ?? wmtsSpec.width,
          wmtsImg?.height ?? wmtsSpec.height
        );
        earthMat.uniforms.uGlobalLayerMap.value = cachedWmts;
        earthMat.uniforms.uGlobalFilterMode.value = GIBS_LAYERS[layerId].shaderMode;
        earthMat.uniforms.uGlobalDataMode.value = GIBS_LAYERS[layerId].isDataLayer ? 1.0 : 0.0;
        globalTexLoaded = true;
        textureTracker.releaseUnbound();
        setGlobalHud({
          loading: false,
          error: false,
          dateIso: wmtsSpec.primaryDateIso,
          resBadge: wmtsSpec.badgeLabel,
        });
        return;
      }

      const isCancelled = () =>
        disposed || mySeq !== globalReqSeq || activeGlobalKey !== wmtsSpec.key;
      let wmtsApplied = false;
      let stage1Ready = false;
      let stage1Failed = false;
      let stage2Failed = false;

      const cached = globalGibsCache.get(spec.key);
      if (cached) {
        globalGibsCache.delete(spec.key);
        globalGibsCache.set(spec.key, cached);
        (earthMat.uniforms.uGlobalTexSize.value as THREE.Vector2).set(2048, 1024);
        earthMat.uniforms.uGlobalLayerMap.value = cached;
        earthMat.uniforms.uGlobalFilterMode.value = GIBS_LAYERS[layerId].shaderMode;
        earthMat.uniforms.uGlobalDataMode.value = GIBS_LAYERS[layerId].isDataLayer ? 1.0 : 0.0;
        globalTexLoaded = true;
        textureTracker.releaseUnbound();
        stage1Ready = true;
        setGlobalHud({
          loading: true,
          error: false,
          dateIso: spec.dateIso,
          resBadge: "2K…",
        });
      } else {
        setGlobalHud({
          loading: true,
          error: false,
          dateIso: spec.dateIso,
          resBadge: "Loading",
        });
        loadGlobalTexPromise(spec)
          .then((tex) => {
            if (isCancelled() || wmtsApplied) return;
            (earthMat.uniforms.uGlobalTexSize.value as THREE.Vector2).set(2048, 1024);
            earthMat.uniforms.uGlobalLayerMap.value = tex;
            earthMat.uniforms.uGlobalFilterMode.value = GIBS_LAYERS[layerId].shaderMode;
            earthMat.uniforms.uGlobalDataMode.value = GIBS_LAYERS[layerId].isDataLayer ? 1.0 : 0.0;
            globalTexLoaded = true;
            textureTracker.releaseUnbound();
            stage1Ready = true;
            setGlobalHud({
              loading: !stage2Failed,
              error: false,
              dateIso: spec.dateIso,
              resBadge: stage2Failed ? "2K" : "2K…",
            });
          })
          .catch(() => {
            stage1Failed = true;
            if (isCancelled() || wmtsApplied) return;
            if (stage2Failed) {
              activeGlobalKey = "";
              setGlobalHud((prev) => ({
                ...prev,
                loading: false,
                error: true,
                resBadge: "",
              }));
            }
          });
      }

      loadWmtsMosaic(wmtsSpec, isCancelled)
        .then((wmtsTex) => {
          if (isCancelled()) return;
          wmtsApplied = true;
          const wmtsImg = wmtsTex.image as HTMLCanvasElement | undefined;
          (earthMat.uniforms.uGlobalTexSize.value as THREE.Vector2).set(
            wmtsImg?.width ?? wmtsSpec.width,
            wmtsImg?.height ?? wmtsSpec.height
          );
          earthMat.uniforms.uGlobalLayerMap.value = wmtsTex;
          earthMat.uniforms.uGlobalFilterMode.value = GIBS_LAYERS[layerId].shaderMode;
          earthMat.uniforms.uGlobalDataMode.value = GIBS_LAYERS[layerId].isDataLayer ? 1.0 : 0.0;
          globalTexLoaded = true;
          textureTracker.releaseUnbound();
          setGlobalHud({
            loading: false,
            error: false,
            dateIso: wmtsSpec.primaryDateIso,
            resBadge: wmtsSpec.badgeLabel,
          });
        })
        .catch(() => {
          stage2Failed = true;
          if (isCancelled()) return;
          if (stage1Ready) {
            setGlobalHud((prev) => ({
              ...prev,
              loading: false,
              error: false,
              resBadge: "2K",
            }));
          } else if (stage1Failed) {
            activeGlobalKey = "";
            setGlobalHud((prev) => ({
              ...prev,
              loading: false,
              error: true,
              resBadge: "",
            }));
          }
        });
    };

    const applyRegionalTexture = (
      tex: THREE.Texture,
      spec: RegionalTileSpec
    ) => {
      earthMat.uniforms.uRegionalMap.value = tex;
      (earthMat.uniforms.uRegionalBounds.value as THREE.Vector4).set(
        spec.bounds[0],
        spec.bounds[1],
        spec.bounds[2],
        spec.bounds[3]
      );
      earthMat.uniforms.uRegionalDataMode.value = GIBS_LAYERS[spec.layerId]
        .isDataLayer
        ? 1.0
        : 0.0;
      regionalTexLoaded = true;
      textureTracker.releaseUnbound();
    };

    const loadRegionalSpec = (spec: RegionalTileSpec, swathKm: number, centerLat: number, centerLng: number) => {
      const cached = gibsCache.get(spec.key);
      if (cached) {
        gibsCache.delete(spec.key);
        gibsCache.set(spec.key, cached);
        applyRegionalTexture(cached, spec);
        setRegionalHud({
          layerId: spec.layerId,
          dateIso: spec.dateIso,
          swathKm,
          tier: spec.tier,
          loading: false,
          error: false,
          centerLat,
          centerLng,
        });
        return;
      }

      if ((failedTileUntil.get(spec.key) ?? 0) > Date.now()) {
        setRegionalHud({
          layerId: spec.layerId,
          dateIso: spec.dateIso,
          swathKm,
          tier: spec.tier,
          loading: false,
          error: true,
          centerLat,
          centerLng,
        });
        return;
      }

      if (lastRequestedTileKey === spec.key) {
        return;
      }
      lastRequestedTileKey = spec.key;
      const mySeq = ++gibsReqSeq;
      setRegionalHud({
        layerId: spec.layerId,
        dateIso: spec.dateIso,
        swathKm,
        tier: spec.tier,
        loading: true,
        error: false,
        centerLat,
        centerLng,
      });

      gibsLoader.load(
        spec.proxyUrl,
        (tex) => {
          if (disposed) {
            tex.dispose();
            return;
          }
          failedTileUntil.delete(spec.key);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          tex.anisotropy = maxAnisotropy;

          textureTracker.register(tex);
          gibsCache.set(spec.key, tex);
          while (gibsCache.size > 14) {
            const oldestKey = gibsCache.keys().next().value;
            if (!oldestKey) break;
            const oldTex = gibsCache.get(oldestKey);
            gibsCache.delete(oldestKey);
            if (oldTex) {
              textureTracker.evictFromCache(oldTex);
            }
          }

          if (mySeq !== gibsReqSeq || activeGibsLayerRef.current !== spec.layerId) {
            return;
          }
          applyRegionalTexture(tex, spec);
          setRegionalHud((prev) => ({
            ...prev,
            layerId: spec.layerId,
            dateIso: spec.dateIso,
            loading: false,
            error: false,
          }));
        },
        undefined,
        () => {
          if (disposed || mySeq !== gibsReqSeq) return;
          failedTileUntil.set(spec.key, Date.now() + 15_000);
          if (lastRequestedTileKey === spec.key) {
            lastRequestedTileKey = "";
          }
          setRegionalHud((prev) => ({
            ...prev,
            loading: false,
            error: true,
          }));
        }
      );
    };

    const syncRegionalTile = (force = false) => {
      if (disposed) return;
      if (spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS) return;
      const subVec = new THREE.Vector3().setFromSpherical(spherical);
      const subPt = vector3ToLatLng(subVec);
      const swathKm = estimateRegionalSwathKm(spherical.radius);
      const activeLayerId = activeGibsLayerRef.current;

      if (!activeLayerId) {
        regionalTexLoaded = false;
        lastCheckedTileKey = "";
        setRegionalHud((prev) => ({
          ...prev,
          layerId: null,
          swathKm,
          loading: false,
          error: false,
          centerLat: Number(subPt.lat.toFixed(2)),
          centerLng: Number(subPt.lng.toFixed(2)),
        }));
        return;
      }

      const spec = computeRegionalTileSpec({
        lat: subPt.lat,
        lng: subPt.lng,
        cameraRadius: spherical.radius,
        layerId: activeLayerId,
        cutoffMs: cutoffMsRef.current,
      });
      if (!spec) {
        setRegionalHud((prev) => ({
          ...(prev ?? {
            dateIso: new Date(cutoffMsRef.current ?? Date.now())
              .toISOString()
              .slice(0, 10),
            swathKm: 600,
          }),
          layerId: null,
          loading: false,
          error: false,
          centerLat: subPt.lat,
          centerLng: subPt.lng,
        }));
        return;
      }

      const centerSig = `${Math.round(subPt.lat * 2)},${Math.round(subPt.lng * 2)},${Math.round(swathKm / 40)}`;
      if (force || spec.key !== lastCheckedTileKey) {
        lastCheckedTileKey = spec.key;
        lastHudCenterSig = centerSig;
        if (gibsDebounceTimer !== null) {
          window.clearTimeout(gibsDebounceTimer);
          gibsDebounceTimer = null;
        }
        if (force || gibsCache.has(spec.key)) {
          loadRegionalSpec(spec, swathKm, subPt.lat, subPt.lng);
        } else {
          gibsDebounceTimer = window.setTimeout(() => {
            gibsDebounceTimer = null;
            if (!disposed) {
              loadRegionalSpec(spec, swathKm, subPt.lat, subPt.lng);
            }
          }, 180);
        }
      } else if (centerSig !== lastHudCenterSig) {
        lastHudCenterSig = centerSig;
        setRegionalHud((prev) => ({
          ...prev,
          layerId: activeLayerId,
          swathKm,
          tier: spec.tier,
          centerLat: subPt.lat,
          centerLng: subPt.lng,
        }));
      }
    };

    const markerMap = new Map<THREE.Object3D, ETGNode>();
    const arcMap = new Map<THREE.Object3D, ETGEdge>();
    sceneRefs.current = {
      scene,
      earthMesh,
      earthMat,
      cloudMesh,
      cloudMat,
      atmoMat,
      markersGroup,
      arcsGroup,
      probeGroup,
      regionalGroup,
      markerMap,
      arcMap,
      spherical,
      glowTex,
      ringTex,
      sharedTextures,
      arcTravelers: [],
      arcMidpoints: [],
      probeTravelers: [],
      probeMidpoint: null,
      forceRegionalTileSync: () => syncRegionalTile(true),
      syncGlobalMode,
    };

    syncGlobalMode(satelliteModeRef.current, activeTopicsRef.current, cutoffMsRef.current);

    // Pointer Interaction (Orbit + Click-to-Probe / Select Node / Select Arc)
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 2.2 };
    let isDragging = false;
    let downX = 0;
    let downY = 0;
    let prevX = 0;
    let prevY = 0;

    const getNormalizedCoords = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
    };

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      prevX = e.clientX;
      prevY = e.clientY;
      cameraTargetRef.current = null;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isDragging) {
        const dx = e.clientX - prevX;
        const dy = e.clientY - prevY;
        prevX = e.clientX;
        prevY = e.clientY;
        const dragScale = Math.max(
          0.26,
          Math.min(1, (spherical.radius - 92) / 178)
        );
        const speed = 0.0055 * dragScale;
        spherical.theta -= dx * speed;
        spherical.phi = Math.max(0.18, Math.min(Math.PI - 0.18, spherical.phi - dy * speed));
        setHoveredInfo(null);
        return;
      }

      const ndc = getNormalizedCoords(e.clientX, e.clientY);
      raycaster.setFromCamera(ndc, camera);
      if (showPinsRef.current) {
        const hits = raycaster.intersectObjects(markersGroup.children, false);
        const markerHit = hits.find((h) => markerMap.has(h.object));
        if (markerHit) {
          const node = markerMap.get(markerHit.object);
          if (node) {
            const rect = container.getBoundingClientRect();
            const topicName = node.properties.dataset
              ? DATASET_BY_ID[node.properties.dataset]?.shortLabel
              : undefined;
            const regionLabel =
              node.properties.region && !node.properties.region.includes("°")
                ? node.properties.region
                : undefined;
            const cue = microscopeByNodeRef.current?.[node.uuid];
            const radarBadge =
              cue && cue.radarBadge !== "NOMINAL" ? cue.radarBadge : undefined;
            const radarDetail =
              cue && cue.radarBadge !== "NOMINAL"
                ? cue.radarBadge === "EARLY_ONSET"
                  ? `Early Onset ${Math.round(cue.onsetProb * 100)}%${cue.preMannKendallAlert ? " (Pre-MK)" : ""}`
                  : cue.radarBadge === "FALSE_TREND_CYCLE"
                    ? `Cycle Alias ${Math.round(cue.dealiasing.oscillationShare * 100)}%`
                    : cue.radarBadge === "SENSOR_GLITCH_RISK"
                      ? `Sensor Glitch Risk ${Math.round(cue.dealiasing.falseTrendProb * 100)}%`
                      : `Secular Accel ${Math.round(cue.dealiasing.secularShare * 100)}%`
                : undefined;
            setHoveredInfo({
              name: humanizeNodeText(node.properties.name),
              subtitle: [topicName, regionLabel].filter(Boolean).join(" · ") || "Earth observation",
              radarBadge,
              radarDetail,
              x: e.clientX - rect.left,
              y: e.clientY - rect.top,
            });
            renderer.domElement.style.cursor = "pointer";
            return;
          }
        }
      }

      // Check front-hemisphere teleconnection arcs (guard against picking far-side arcs through globe)
      const earthHitsHover = raycaster.intersectObject(earthMesh, false);
      const earthDistHover = earthHitsHover.length > 0 ? earthHitsHover[0].distance : Infinity;
      const arcHitsHover = raycaster.intersectObjects(arcsGroup.children, false);
      const arcHitHover = arcHitsHover.find(
        (h) => arcMap.has(h.object) && h.distance <= earthDistHover + 2.5
      );
      if (arcHitHover) {
        const edge = arcMap.get(arcHitHover.object);
        if (edge) {
          const rect = container.getBoundingClientRect();
          const srcNode = nodesRef.current.find((n) => n.uuid === edge.source_uuid);
          const tgtNode = nodesRef.current.find((n) => n.uuid === edge.target_uuid);
          const srcName = srcNode?.properties.region || srcNode?.properties.name || "Spot A";
          const tgtName = tgtNode?.properties.region || tgtNode?.properties.name || "Spot B";
          const formatted =
            srcNode && tgtNode
              ? formatRelationForDisplay(edge, srcNode, tgtNode)
              : null;
          const metaParts = [
            `${humanizeNodeText(srcName)} ↔ ${humanizeNodeText(tgtName)}`,
            formatted?.correlationText,
            formatted?.lagText,
          ].filter(Boolean);
          setHoveredInfo({
            name: formatted
              ? `${formatted.badgeText}${edge.properties.mechanism ? ` · ${edge.properties.mechanism}` : ""}`
              : edge.properties.mechanism || "Linked Earth trends",
            subtitle: metaParts.join(" · "),
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
          renderer.domElement.style.cursor = "pointer";
          return;
        }
      }

      setHoveredInfo(null);
      renderer.domElement.style.cursor = "grab";
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      const distMoved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (distMoved > 5) return;

      const ndc = getNormalizedCoords(e.clientX, e.clientY);
      raycaster.setFromCamera(ndc, camera);

      if (showPinsRef.current) {
        const markerHits = raycaster.intersectObjects(markersGroup.children, false);
        const markerHit = markerHits.find((h) => markerMap.has(h.object));
        if (markerHit) {
          const node = markerMap.get(markerHit.object);
          if (node) {
            callbacksRef.current.onSelectNode(node);
            return;
          }
        }
      }

      const earthHits = raycaster.intersectObject(earthMesh, false);
      const earthDist = earthHits.length > 0 ? earthHits[0].distance : Infinity;
      const arcHits = raycaster.intersectObjects(arcsGroup.children, false);
      const arcHit = arcHits.find(
        (h) => arcMap.has(h.object) && h.distance <= earthDist + 2.5
      );
      if (arcHit && callbacksRef.current.onSelectEdge) {
        const edge = arcMap.get(arcHit.object);
        if (edge) {
          callbacksRef.current.onSelectEdge(edge);
          return;
        }
      }

      if (earthHits.length > 0) {
        const { lat, lng } = vector3ToLatLng(earthHits[0].point);
        callbacksRef.current.onProbeCoordinate(lat, lng);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraTargetRef.current = null;
      const wheelStep = spherical.radius < 180 ? 0.1 : 0.16;
      spherical.radius = Math.max(
        MIN_GLOBE_CAMERA_RADIUS,
        Math.min(430, spherical.radius + e.deltaY * wheelStep)
      );
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          currentW = w;
          currentH = h;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    resizeObs.observe(container);

    let animId = 0;
    const startTimeMs = performance.now();
    let lastLabelSync = -1;
    let lastLabelSignature = "";
    let lastProbeLabelSignature = "";
    let lastNodeLabelSignature = "";
    const camUnitVec = new THREE.Vector3();
    const midUnitVec = new THREE.Vector3();
    const projVec = new THREE.Vector3();
    const tmpSphVec = new THREE.Vector3();
    const nodePosVec = new THREE.Vector3();
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const elapsed = (performance.now() - startTimeMs) * 0.001;

      if (cloudMesh.visible) {
        cloudMesh.rotation.y += 0.00018;
        earthMat.uniforms.uCloudDriftU.value = cloudMesh.rotation.y / (Math.PI * 2);
      }

      if (cameraTargetRef.current) {
        const t = cameraTargetRef.current;
        let dTheta = t.theta - spherical.theta;
        while (dTheta > Math.PI) dTheta -= Math.PI * 2;
        while (dTheta < -Math.PI) dTheta += Math.PI * 2;
        spherical.theta += dTheta * 0.08;
        spherical.phi += (t.phi - spherical.phi) * 0.08;
        spherical.radius += (t.radius - spherical.radius) * 0.08;
        if (
          Math.abs(dTheta) < 0.005 &&
          Math.abs(t.phi - spherical.phi) < 0.005 &&
          Math.abs(t.radius - spherical.radius) < 0.25
        ) {
          cameraTargetRef.current = null;
        }
      } else if (
        autoRotateRef.current &&
        !isDragging &&
        spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS
      ) {
        spherical.theta += 0.0012;
      }

      // Hysteresis-guarded Regional Zoom State + Smooth Satellite & Cloud Blend
      if (!isRegionalRef.current && spherical.radius <= REGIONAL_ZOOM_ACTIVATE_RADIUS) {
        isRegionalRef.current = true;
        setIsRegionalZoom(true);
        syncRegionalTile(true);
      } else if (isRegionalRef.current && spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS) {
        isRegionalRef.current = false;
        setIsRegionalZoom(false);
        setProjectedNodeLabels([]);
        lastNodeLabelSignature = "";
      } else if (isRegionalRef.current && elapsed - lastTileEvalMs >= 0.14) {
        lastTileEvalMs = elapsed;
        syncRegionalTile(false);
      }

      const targetRegBlend =
        isRegionalRef.current &&
        regionalTexLoaded &&
        activeGibsLayerRef.current !== null
          ? 1.0
          : 0.0;
      earthMat.uniforms.uRegionalBlend.value +=
        (targetRegBlend - (earthMat.uniforms.uRegionalBlend.value as number)) * 0.1;

      const targetGlobalBlend =
        globalTexLoaded && (earthMat.uniforms.uGlobalFilterMode.value as number) > 0.5 ? 1.0 : 0.0;
      earthMat.uniforms.uGlobalLayerBlend.value +=
        (targetGlobalBlend - (earthMat.uniforms.uGlobalLayerBlend.value as number)) * 0.1;

      const cloudZoomFrac = Math.max(
        0,
        Math.min(1, (spherical.radius - 135) / (196 - 135))
      );
      cloudMat.uniforms.uRegionalFade.value = 0.18 + cloudZoomFrac * 0.82;

      const targetOffsetX =
        inspectorOpenRef.current && currentW >= 1024
          ? Math.round(Math.min(396, currentW * 0.30) * 0.34)
          : 0;
      currentViewOffsetX += (targetOffsetX - currentViewOffsetX) * 0.1;
      if (Math.abs(currentViewOffsetX) > 0.5) {
        camera.setViewOffset(
          currentW,
          currentH,
          Math.round(currentViewOffsetX),
          0,
          currentW,
          currentH
        );
      } else if (camera.view) {
        camera.clearViewOffset();
      }

      // Animate orbital beacon pulse rings
      for (const child of markersGroup.children) {
        if (child.userData.pulseRing) {
          const phase = ((elapsed * 0.52 + (child.userData.phaseOffset ?? 0)) % 1 + 1) % 1;
          const baseScale = child.userData.baseScale ?? 1;
          const ringScale = baseScale * (1.0 + phase * 1.35);
          child.scale.setScalar(ringScale);
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = (1 - phase) * (child.userData.maxOpacity ?? 0.62);
        } else if (child.userData.haloSprite) {
          const baseScale = child.userData.baseScale ?? 6;
          const breath = 1 + Math.sin(elapsed * 2.6 + (child.userData.phaseOffset ?? 0)) * 0.09;
          child.scale.setScalar(baseScale * breath);
        }
      }

      // Animate probe reticle
      for (const child of probeGroup.children) {
        if (child.userData.probeRing) {
          const phase = (elapsed * 0.7) % 1;
          child.scale.setScalar(1 + phase * 1.25);
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = (1 - phase) * 0.82;
        }
      }

      // Animate traveling light pulses along teleconnection splines & active 2-spot comparison arc
      const travelers = sceneRefs.current?.arcTravelers ?? [];
      for (const tr of travelers) {
        const u = (elapsed * tr.speed + tr.phase) % 1;
        const fIdx = u * (tr.pts.length - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(tr.pts.length - 1, i0 + 1);
        const frac = fIdx - i0;
        tr.sprite.position.lerpVectors(tr.pts[i0], tr.pts[i1], frac);
      }
      const probeTravelers = sceneRefs.current?.probeTravelers ?? [];
      for (const tr of probeTravelers) {
        const u = (elapsed * tr.speed + tr.phase) % 1;
        const fIdx = u * (tr.pts.length - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(tr.pts.length - 1, i0 + 1);
        const frac = fIdx - i0;
        tr.sprite.position.lerpVectors(tr.pts[i0], tr.pts[i1], frac);
      }

      camera.position.setFromSpherical(spherical);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      (earthMat.uniforms.uCameraRight.value as THREE.Vector3)
        .setFromMatrixColumn(camera.matrixWorld, 0)
        .normalize();
      renderer.render(scene, camera);

      if (elapsed - lastLabelSync >= 0.09) {
        lastLabelSync = elapsed;
        camera.updateMatrixWorld();
        camUnitVec.copy(camera.position).normalize();
        const rightCutoff = inspectorOpenRef.current && currentW >= 1024 ? currentW - 430 : currentW - 60;
        const occupiedBoxes: Array<{ x: number; y: number }> = [];

        // 1. Project nearby station badges when zoomed into a regional swath
        if (isRegionalRef.current && showPinsRef.current) {
          tmpSphVec.setFromSpherical(spherical);
          const subCenter = vector3ToLatLng(tmpSphVec);
          const nearby = nodesRef.current
            .filter((n) => {
              const nLat = n.properties.lat;
              const nLng = n.properties.lng;
              if (nLat === undefined || nLng === undefined) return false;
              return (
                Math.abs(nLat - subCenter.lat) <= 10.5 &&
                lngSpanDeg(nLng, subCenter.lng) <= 14
              );
            })
            .sort((a, b) => {
              const aSel = a.uuid === selectedNodeUuidRef.current ? 1 : 0;
              const bSel = b.uuid === selectedNodeUuidRef.current ? 1 : 0;
              if (aSel !== bSel) return bSel - aSel;
              return (b.properties.importance ?? 0) - (a.properties.importance ?? 0);
            });

          const nextNodeLabels: ProjectedRegionalNodeLabel[] = [];
          for (const node of nearby) {
            const nLat = node.properties.lat!;
            const nLng = node.properties.lng!;
            nodePosVec.copy(latLngToVector3(nLat, nLng, EARTH_RADIUS + 1.2));
            midUnitVec.copy(nodePosVec).normalize();
            if (camUnitVec.dot(midUnitVec) < 0.25) continue;
            projVec.copy(nodePosVec).project(camera);
            if (projVec.z > 1) continue;
            const x = Math.round((projVec.x * 0.5 + 0.5) * currentW);
            const y = Math.round((-projVec.y * 0.5 + 0.5) * currentH);
            if (x < 72 || x > rightCutoff || y < 56 || y > currentH - 88) continue;
            // Keep clear of top-left Regional Satellite HUD card
            if (x < 405 && y < 148) continue;
            if (occupiedBoxes.some((b) => Math.abs(b.x - x) < 126 && Math.abs(b.y - y) < 28)) {
              continue;
            }
            occupiedBoxes.push({ x, y });

            const dsColor = node.properties.dataset
              ? DATASET_BY_ID[node.properties.dataset]?.color ?? ETG_LABEL_PALETTE[node.label].color
              : ETG_LABEL_PALETTE[node.label].color;

            let metricText: string | null = null;
            if (
              typeof node.properties.theil_sen_slope === "number" &&
              Number.isFinite(node.properties.theil_sen_slope)
            ) {
              const rawUnit = node.properties.slope_unit ?? "";
              const isC = /(?:°\s*c|deg\s*c|celsius)/i.test(rawUnit);
              const isF = /(?:°\s*f|deg\s*f|fahrenheit)/i.test(rawUnit);
              const factor =
                tempUnitRef.current === "F" && isC
                  ? 1.8
                  : tempUnitRef.current === "C" && isF
                    ? 1 / 1.8
                    : 1;
              const slopeVal = node.properties.theil_sen_slope * factor;
              const displayUnit =
                isC || isF ? convertSlopeUnitLabel(rawUnit, tempUnitRef.current) : rawUnit;
              metricText = `${slopeVal >= 0 ? "+" : ""}${slopeVal.toFixed(2)}${displayUnit ? ` ${displayUnit}` : ""}`;
            } else if (
              typeof node.properties.value === "number" &&
              Number.isFinite(node.properties.value)
            ) {
              const rawVal = node.properties.value;
              const rawUnit = node.properties.unit ?? "";
              const val = isTemperatureUnitString(rawUnit)
                ? convertTemperatureDisplayValue(rawVal, rawUnit, tempUnitRef.current)
                : rawVal;
              const displayUnit = isTemperatureUnitString(rawUnit)
                ? convertTemperatureUnitLabel(rawUnit, tempUnitRef.current)
                : rawUnit;
              metricText = `${val.toFixed(1)}${displayUnit ? ` ${displayUnit}` : ""}`;
            }

            nextNodeLabels.push({
              uuid: node.uuid,
              x,
              y,
              name: humanizeNodeText(node.properties.name),
              metricText,
              colorCss: dsColor,
              isSelected: node.uuid === selectedNodeUuidRef.current,
              node,
            });
            if (nextNodeLabels.length >= 8) break;
          }

          const nodeSig = nextNodeLabels
            .map((l) => `${l.uuid}:${Math.round(l.x / 3)}:${Math.round(l.y / 3)}:${l.isSelected ? 1 : 0}`)
            .join("|");
          if (nodeSig !== lastNodeLabelSignature) {
            lastNodeLabelSignature = nodeSig;
            setProjectedNodeLabels(nextNodeLabels);
          }
        } else if (lastNodeLabelSignature !== "") {
          lastNodeLabelSignature = "";
          setProjectedNodeLabels([]);
        }

        // 2. Project active 2-spot / case-study comparison arc callout & graph arc midpoints
        const activeProbeMid = sceneRefs.current?.probeMidpoint ?? null;
        let nextProbeSig = "";
        if (activeProbeMid) {
          midUnitVec.copy(activeProbeMid.midpoint).normalize();
          if (camUnitVec.dot(midUnitVec) >= 0.1) {
            projVec.copy(activeProbeMid.midpoint).project(camera);
            if (projVec.z <= 1) {
              const px = Math.round((projVec.x * 0.5 + 0.5) * currentW);
              const py = Math.round((-projVec.y * 0.5 + 0.5) * currentH);
              const inHudBox =
                (px < 405 && py < 168) ||
                px < 64 ||
                px > rightCutoff ||
                py < 52 ||
                py > currentH - 86;
              if (!inHudBox) {
                occupiedBoxes.push({ x: px, y: py });
                nextProbeSig = `${px}:${py}:${activeProbeMid.badgeText}:${activeProbeMid.statText ?? ""}`;
                if (nextProbeSig !== lastProbeLabelSignature) {
                  lastProbeLabelSignature = nextProbeSig;
                  setProjectedProbeLabel({
                    x: px,
                    y: py,
                    badgeText: activeProbeMid.badgeText,
                    pairLabel: activeProbeMid.pairLabel,
                    statText: activeProbeMid.statText,
                    colorCss: activeProbeMid.colorCss,
                  });
                }
              }
            }
          }
        }
        if (nextProbeSig === "" && lastProbeLabelSignature !== "") {
          lastProbeLabelSignature = "";
          setProjectedProbeLabel(null);
        }

        if (!showArcLabelsRef.current) {
          if (lastLabelSignature !== "off") {
            lastLabelSignature = "off";
            setProjectedArcLabels([]);
          }
        } else {
          const midpoints = sceneRefs.current?.arcMidpoints ?? [];
          if (midpoints.length === 0) {
            if (lastLabelSignature !== "empty") {
              lastLabelSignature = "empty";
              setProjectedArcLabels([]);
            }
          } else {
            const nextLabels: ProjectedArcLabel[] = [];
            for (const item of midpoints) {
              midUnitVec.copy(item.midpoint).normalize();
              if (camUnitVec.dot(midUnitVec) < 0.12) continue;
              projVec.copy(item.midpoint).project(camera);
              if (projVec.z > 1) continue;
              const x = Math.round((projVec.x * 0.5 + 0.5) * currentW);
              const y = Math.round((-projVec.y * 0.5 + 0.5) * currentH);
              if (x < 64 || x > rightCutoff || y < 56 || y > currentH - 86) {
                continue;
              }
              if (isRegionalRef.current && x < 405 && y < 148) {
                continue;
              }
              if (occupiedBoxes.some((b) => Math.abs(b.x - x) < 126 && Math.abs(b.y - y) < 28)) {
                continue;
              }
              occupiedBoxes.push({ x, y });
              nextLabels.push({
                uuid: item.edge.properties.uuid,
                x,
                y,
                badgeText: item.badgeText,
                pairLabel: item.pairLabel,
                statText: item.statText,
                colorCss: item.colorCss,
                isSelected: item.isSelected,
                edge: item.edge,
              });
              if (nextLabels.length >= 6) break;
            }
            const sig = nextLabels
              .map((l) => `${l.uuid}:${Math.round(l.x / 3)}:${Math.round(l.y / 3)}:${l.isSelected ? 1 : 0}`)
              .join("|");
            if (sig !== lastLabelSignature) {
              lastLabelSignature = sig;
              setProjectedArcLabels(nextLabels);
            }
          }
        }
      }
    };
    animate();

    return () => {
      disposed = true;
      abortInFlightTileImages();
      if (gibsDebounceTimer !== null) {
        window.clearTimeout(gibsDebounceTimer);
      }
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      if (sceneRefs.current) {
        sceneRefs.current.arcTravelers = [];
        sceneRefs.current.arcMidpoints = [];
        sceneRefs.current.probeTravelers = [];
        sceneRefs.current.probeMidpoint = null;
        disposeGroupResources(markersGroup, sharedTextures);
        disposeGroupResources(arcsGroup, sharedTextures);
        disposeGroupResources(probeGroup, sharedTextures);
        disposeGroupResources(regionalGroup, sharedTextures);
      }
      gibsCache.clear();
      globalGibsCache.clear();
      globalWmtsCache.clear();
      bordersTex = null;
      textureTracker.disposeAll();
      placeholderRegionalTex.dispose();
      earthGeo.dispose();
      earthMat.dispose();
      cloudGeo.dispose();
      cloudMat.dispose();
      innerHazeGeo.dispose();
      innerHazeMat.dispose();
      atmoGeo.dispose();
      atmoMat.dispose();
      starGeo.dispose();
      starMat.dispose();
      blueMarbleTex.dispose();
      normalTex.dispose();
      waterTex.dispose();
      lightsTex.dispose();
      nightTex.dispose();
      cloudsTex.dispose();
      glowTex.dispose();
      ringTex.dispose();
      starTex.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRefs.current = null;
    };
  }, []);

  const selectedGeoNode =
    nodes.find(
      (n) =>
        n.uuid === selectedNodeUuid &&
        typeof n.properties.lat === "number" &&
        typeof n.properties.lng === "number"
    ) ?? null;

  const regionalFocalCoord = selectedGeoNode
    ? {
        lat: selectedGeoNode.properties.lat as number,
        lng: selectedGeoNode.properties.lng as number,
      }
    : probedCoord
      ? { lat: probedCoord.lat, lng: probedCoord.lng }
      : { lat: regionalHud.centerLat, lng: regionalHud.centerLng };

  const prevGlobalSyncInputsRef = useRef<{
    satelliteMode: RegionalSatelliteMode;
    activeTopics: ReadonlyArray<ETGDatasetId> | undefined;
    prefsHydrated: boolean;
    globalSig: string;
  } | null>(null);

  // Sync GIBS global filter & regional spectral layer + timeline date to the globe shader
  useEffect(() => {
    const nextLayerId = resolveActiveGibsLayer(satelliteMode, activeTopics);
    activeGibsLayerRef.current = nextLayerId;
    cutoffMsRef.current = cutoffMs;

    setRegionalHud((prev) => ({
      ...prev,
      layerId: nextLayerId,
      dateIso: resolveGibsDateIso(nextLayerId ?? "true_color", cutoffMs),
    }));

    const refs = sceneRefs.current;
    if (!refs) return;

    refs.earthMat.uniforms.uRegionalDataMode.value =
      nextLayerId && GIBS_LAYERS[nextLayerId].isDataLayer ? 1.0 : 0.0;

    const nextGlobalSig = resolveGlobalSyncSignature(satelliteMode, activeTopics, cutoffMs);
    const prevInputs = prevGlobalSyncInputsRef.current;
    const isCutoffOnlyChange =
      prevInputs !== null &&
      prevInputs.satelliteMode === satelliteMode &&
      prevInputs.activeTopics === activeTopics &&
      prevInputs.prefsHydrated === prefsHydrated;
    const globalSigUnchanged =
      prevInputs !== null && prevInputs.globalSig === nextGlobalSig;

    prevGlobalSyncInputsRef.current = {
      satelliteMode,
      activeTopics,
      prefsHydrated,
      globalSig: nextGlobalSig,
    };

    if (isCutoffOnlyChange) {
      const timer = window.setTimeout(() => {
        if (!globalSigUnchanged) {
          refs.syncGlobalMode(satelliteMode, activeTopics, cutoffMs);
        }
        if (isRegionalZoom) {
          refs.forceRegionalTileSync();
        }
      }, 200);
      return () => window.clearTimeout(timer);
    }

    refs.syncGlobalMode(satelliteMode, activeTopics, cutoffMs);
    if (isRegionalZoom) {
      refs.forceRegionalTileSync();
    }
  }, [satelliteMode, activeTopics, cutoffMs, isRegionalZoom, prefsHydrated]);

  useEffect(() => {
    const refs = sceneRefs.current;
    if (refs) {
      refs.earthMat.uniforms.uFilterSmooth.value = filterSmooth ? 1.0 : 0.0;
    }
  }, [filterSmooth]);

  // Render 50 km MERRA-2 grid-scale & 150 km mesoscale surface geodesic rings in regional zoom
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;

    disposeGroupResources(refs.regionalGroup, refs.sharedTextures);
    refs.regionalGroup.visible = isRegionalZoom;
    if (!isRegionalZoom) return;

    const addGeodesicRing = (
      radiusKm: number,
      altitudeOffset: number,
      colorHex: number,
      opacity: number,
      segments: number
    ) => {
      const ringLatLngs = buildGeodesicCircleLatLng(
        regionalFocalCoord.lat,
        regionalFocalCoord.lng,
        radiusKm,
        segments
      );
      if (ringLatLngs.length < 3) return;
      const pts = ringLatLngs.map((pt) =>
        latLngToVector3(pt.lat, pt.lng, EARTH_RADIUS + altitudeOffset)
      );
      pts.push(pts[0].clone());
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      refs.regionalGroup.add(new THREE.Line(geo, mat));
    };

    addGeodesicRing(50, 0.28, 0xfbbf24, 0.72, 72);
    addGeodesicRing(150, 0.26, 0x38bdf8, 0.52, 88);

    if (!selectedGeoNode && !probedCoord) {
      const unitNormal = latLngToVector3(
        regionalFocalCoord.lat,
        regionalFocalCoord.lng,
        1
      ).normalize();
      const centerGeo = new THREE.PlaneGeometry(1.5, 1.5);
      const centerMat = new THREE.MeshBasicMaterial({
        map: refs.ringTex,
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const centerMesh = new THREE.Mesh(centerGeo, centerMat);
      centerMesh.position.copy(unitNormal.clone().multiplyScalar(EARTH_RADIUS + 0.3));
      centerMesh.lookAt(unitNormal.clone().multiplyScalar(EARTH_RADIUS * 2));
      refs.regionalGroup.add(centerMesh);
    }
  }, [
    isRegionalZoom,
    regionalFocalCoord.lat,
    regionalFocalCoord.lng,
    Boolean(selectedGeoNode),
    Boolean(probedCoord),
  ]);

  const regBucketLat = Math.round(regionalFocalCoord.lat * 2) / 2;
  const regBucketLng = Math.round(regionalFocalCoord.lng * 2) / 2;

  // Reconcile Orbital Beacons & Clean Teleconnection Splines when nodes/edges/selection change
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;

    disposeGroupResources(refs.markersGroup, refs.sharedTextures);
    disposeGroupResources(refs.arcsGroup, refs.sharedTextures);
    refs.markersGroup.visible = showPinsRef.current;
    refs.markerMap.clear();
    refs.arcMap.clear();
    refs.arcTravelers = [];
    refs.arcMidpoints = [];

    const visibleArcs = selectVisibleGlobeArcs({
      nodes,
      edges,
      mode: arcMode,
      selectedNodeUuid,
      probedAnchorUuid,
      selectedEdgeUuid,
      cascadeEdgeUuids,
      enabledCategories,
      isRegionalZoom,
      regionalCenter: isRegionalZoom ? { lat: regBucketLat, lng: regBucketLng } : null,
    });

    const hasEdgeOrCascadeFocus =
      selectedEdgeUuid !== null || cascadeEdgeUuids.length > 0;
    const hasActiveFocus = hasEdgeOrCascadeFocus || selectedNodeUuid !== null;

    const focusedEndpointUuids = new Set<string>();
    if (selectedNodeUuid) {
      focusedEndpointUuids.add(selectedNodeUuid);
    }
    if (hasEdgeOrCascadeFocus) {
      for (const e of visibleArcs) {
        focusedEndpointUuids.add(e.source_uuid);
        focusedEndpointUuids.add(e.target_uuid);
      }
    }

    const nodeById = new Map(nodes.map((n) => [n.uuid, n]));
    const ringGeo = new THREE.PlaneGeometry(4.4, 4.4);
    const coreGeo = new THREE.SphereGeometry(0.62, 16, 16);
    const hitGeo = new THREE.SphereGeometry(3.1, 10, 10);

    // Note: Keep shared primitives minimal by cloning/scaling individually for disposal safety
    ringGeo.dispose();
    coreGeo.dispose();
    hitGeo.dispose();

    // Render sleek, calm orbital beacons for geo-pinned nodes
    nodes.forEach((node, idx) => {
      const { lat, lng } = node.properties;
      if (lat === undefined || lng === undefined) return;

      const dsColor = node.properties.dataset
        ? DATASET_BY_ID[node.properties.dataset]?.color ?? ETG_LABEL_PALETTE[node.label].color
        : ETG_LABEL_PALETTE[node.label].color;

      const isSelected = node.uuid === selectedNodeUuid;
      const isEndpointFocused = isSelected || focusedEndpointUuids.has(node.uuid);
      const isSuperseded = node.properties.status === "Superseded";
      const dimFactor = hasEdgeOrCascadeFocus && !isEndpointFocused ? 0.32 : 1;

      const colorHex = isSelected
        ? "#fbbf24"
        : isEndpointFocused && hasEdgeOrCascadeFocus
          ? "#fde68a"
          : isSuperseded
            ? "#f59e0b"
            : dsColor;

      const regPinScale = isRegionalZoom ? 0.56 : 1;
      const unitNormal = latLngToVector3(lat, lng, 1).normalize();
      const surfacePos = unitNormal
        .clone()
        .multiplyScalar(EARTH_RADIUS + (isRegionalZoom ? 0.28 : 0.5));
      const beaconAltitude = isRegionalZoom
        ? isEndpointFocused || node.label === "Insight"
          ? EARTH_RADIUS + 1.45
          : node.label === "Concept"
            ? EARTH_RADIUS + 1.05
            : EARTH_RADIUS + 0.75
        : isEndpointFocused || node.label === "Insight"
          ? EARTH_RADIUS + 3.4
          : node.label === "Concept"
            ? EARTH_RADIUS + 2.3
            : EARTH_RADIUS + 1.6;
      const orbPos = unitNormal.clone().multiplyScalar(beaconAltitude);
      const phaseOffset = (idx * 0.27) % 1;

      // 1. Tangent Surface Footprint Reticle (compact precision scale)
      const footprintSize = (isEndpointFocused ? 3.2 : 2.0) * regPinScale;
      const footprintGeo = new THREE.PlaneGeometry(footprintSize, footprintSize);
      const footprintMat = new THREE.MeshBasicMaterial({
        map: refs.ringTex,
        color: colorHex,
        transparent: true,
        opacity: (isSuperseded ? 0.32 : 0.62) * dimFactor,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const footprintMesh = new THREE.Mesh(footprintGeo, footprintMat);
      footprintMesh.position.copy(surfacePos);
      footprintMesh.lookAt(unitNormal.clone().multiplyScalar(EARTH_RADIUS * 2));
      refs.markersGroup.add(footprintMesh);

      // 2. Pulse Wave only on active/focused endpoints so resting globe stays peaceful
      if (isEndpointFocused) {
        const pulseGeo = new THREE.PlaneGeometry(3.2 * regPinScale, 3.2 * regPinScale);
        const pulseMat = new THREE.MeshBasicMaterial({
          map: refs.ringTex,
          color: isSelected ? "#facc15" : colorHex,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const pulseMesh = new THREE.Mesh(pulseGeo, pulseMat);
        pulseMesh.position.copy(surfacePos.clone().addScaledVector(unitNormal, 0.12));
        pulseMesh.lookAt(unitNormal.clone().multiplyScalar(EARTH_RADIUS * 2));
        pulseMesh.userData.pulseRing = true;
        pulseMesh.userData.phaseOffset = phaseOffset;
        pulseMesh.userData.baseScale = isSelected ? 1.25 : 1.05;
        pulseMesh.userData.maxOpacity = isSelected ? 0.8 : 0.62;
        refs.markersGroup.add(pulseMesh);

        // 3. Hairline Light Filament connecting Surface Anchor to Elevated Focused Orb
        const filamentGeo = new THREE.BufferGeometry().setFromPoints([surfacePos, orbPos]);
        const filamentMat = new THREE.LineBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0.78,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        refs.markersGroup.add(new THREE.Line(filamentGeo, filamentMat));
      }

      // 4. Radial Corona Billboard Sprite at Beacon Altitude
      const spriteMat = new THREE.SpriteMaterial({
        map: refs.glowTex,
        color: colorHex,
        transparent: true,
        opacity: (isSuperseded ? 0.4 : 0.8) * dimFactor,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const haloSprite = new THREE.Sprite(spriteMat);
      const baseScale =
        (isEndpointFocused
          ? 3.8
          : node.label === "Insight"
            ? 2.3
            : 1.7) * regPinScale;
      haloSprite.position.copy(orbPos);
      haloSprite.scale.setScalar(baseScale);
      haloSprite.userData.haloSprite = true;
      haloSprite.userData.baseScale = baseScale;
      haloSprite.userData.phaseOffset = phaseOffset * Math.PI * 2;
      refs.markersGroup.add(haloSprite);

      // 5. Crisp Inner Diamond-White Pin Core
      const innerGeo = new THREE.SphereGeometry(
        (isEndpointFocused ? 0.56 : node.label === "Insight" ? 0.42 : 0.32) *
          (isRegionalZoom ? 0.68 : 1),
        14,
        14
      );
      const innerMat = new THREE.MeshBasicMaterial({
        color: isEndpointFocused ? 0xfef08a : 0xffffff,
        transparent: isSuperseded || dimFactor < 1,
        opacity: (isSuperseded ? 0.55 : 0.96) * dimFactor,
      });
      const innerCore = new THREE.Mesh(innerGeo, innerMat);
      innerCore.position.copy(orbPos);
      refs.markersGroup.add(innerCore);

      // 6. Generous Invisible Raycast Hit Target for Easy Selection
      const targetGeo = new THREE.SphereGeometry(
        isRegionalZoom
          ? isEndpointFocused
            ? 1.85
            : 1.55
          : isEndpointFocused
            ? 3.8
            : 3.1,
        10,
        10
      );
      const targetMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.001,
        depthWrite: false,
      });
      const hitTarget = new THREE.Mesh(targetGeo, targetMat);
      hitTarget.position.copy(orbPos);
      refs.markersGroup.add(hitTarget);
      refs.markerMap.set(hitTarget, node);
    });

    // Render 3D Great-Circle Teleconnection Splines (strictly filtered by selectVisibleGlobeArcs)
    visibleArcs.forEach((edge, eIdx) => {
      const src = nodeById.get(edge.source_uuid);
      const tgt = nodeById.get(edge.target_uuid);
      if (
        !src ||
        !tgt ||
        src.properties.lat === undefined ||
        src.properties.lng === undefined ||
        tgt.properties.lat === undefined ||
        tgt.properties.lng === undefined
      ) {
        return;
      }

      const rawDLng = Math.abs(src.properties.lng - tgt.properties.lng);
      const wrappedDLng = Math.min(rawDLng, 360 - rawDLng);
      const dLat = Math.abs(src.properties.lat - tgt.properties.lat);
      const degSpan = Math.hypot(dLat, wrappedDLng);
      const isLocalCorridor = isRegionalZoom && degSpan < 18;

      const pts = buildElevatedGreatCircleCurve(
        src.properties.lat,
        src.properties.lng,
        tgt.properties.lat,
        tgt.properties.lng,
        64,
        { lowAltitudeCorridor: isLocalCorridor }
      );
      const curve = new THREE.CatmullRomCurve3(pts);

      const category = classifyRelationCategory(edge.type);
      const isSupersedes = edge.type === "supersedes";
      const isEdgeSelected = selectedEdgeUuid === edge.properties.uuid;
      const isInCascade = cascadeEdgeUuids.includes(edge.properties.uuid);
      const isFocusedArc = isEdgeSelected || isInCascade;

      const arcColor = isEdgeSelected
        ? 0xfef08a
        : isInCascade
          ? 0xfbbf24
          : isSupersedes
            ? 0xf59e0b
            : category === "opposite"
              ? 0xfb7185
              : category === "causal"
                ? 0x34d399
                : category === "coupled"
                  ? 0x38bdf8
                  : 0xa78bfa;

      const colorCss = isEdgeSelected
        ? "#fef08a"
        : isInCascade
          ? "#fbbf24"
          : isSupersedes
            ? "#f59e0b"
            : category === "opposite"
              ? "#fb7185"
              : category === "causal"
                ? "#34d399"
                : category === "coupled"
                  ? "#38bdf8"
                  : "#a78bfa";

      // 1. Volumetric core tube (crisp & visible across all WebGL backends)
      const tubeGeo = new THREE.TubeGeometry(
        curve,
        56,
        isLocalCorridor ? (isFocusedArc ? 0.22 : 0.14) : isFocusedArc ? 0.44 : 0.28,
        6,
        false
      );
      const tubeMat = new THREE.MeshBasicMaterial({
        color: arcColor,
        transparent: true,
        opacity: isFocusedArc ? 0.96 : hasActiveFocus ? 0.86 : 0.78,
        depthWrite: false,
      });
      const arcCoreMesh = new THREE.Mesh(tubeGeo, tubeMat);
      refs.arcsGroup.add(arcCoreMesh);
      refs.arcMap.set(arcCoreMesh, edge);

      // 2. Soft halo sleeve when edge or cascade is focused
      if (isFocusedArc || category === "opposite") {
        const haloGeo = new THREE.TubeGeometry(
          curve,
          48,
          isLocalCorridor ? (isFocusedArc ? 0.42 : 0.26) : isFocusedArc ? 0.85 : 0.52,
          6,
          false
        );
        const haloMat = new THREE.MeshBasicMaterial({
          color: arcColor,
          transparent: true,
          opacity: isFocusedArc ? 0.24 : 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        refs.arcsGroup.add(new THREE.Mesh(haloGeo, haloMat));
      }

      // 3. Generous invisible hit tube for effortless arc clicking & hovering
      const hitGeo = new THREE.TubeGeometry(
        curve,
        32,
        isLocalCorridor ? 0.85 : 1.75,
        6,
        false
      );
      const hitMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.001,
        depthWrite: false,
      });
      const arcHitMesh = new THREE.Mesh(hitGeo, hitMat);
      refs.arcsGroup.add(arcHitMesh);
      refs.arcMap.set(arcHitMesh, edge);

      // 4. Midpoint callout label metadata for front-hemisphere screen projection
      const midpoint = curve.getPoint(0.5);
      const formatted = formatRelationForDisplay(edge, src, tgt);
      const srcShort =
        src.properties.region && !src.properties.region.includes("°")
          ? src.properties.region.split(",")[0]
          : humanizeNodeText(src.properties.name).slice(0, 14);
      const tgtShort =
        tgt.properties.region && !tgt.properties.region.includes("°")
          ? tgt.properties.region.split(",")[0]
          : humanizeNodeText(tgt.properties.name).slice(0, 14);
      const sep = category === "causal" ? "→" : "↔";
      const pairLabel = `${srcShort} ${sep} ${tgtShort}`;
      refs.arcMidpoints.push({
        edge,
        midpoint,
        badgeText: formatted.badgeText,
        pairLabel,
        statText: formatted.correlationText ?? formatted.lagText,
        colorCss,
        isSelected: isEdgeSelected,
      });

      // 5. Directional traveling pulse sprite on up to 8 visible arcs
      if (hasActiveFocus || eIdx < 8) {
        const pulseSpriteMat = new THREE.SpriteMaterial({
          map: refs.glowTex,
          color: arcColor,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const pulseSprite = new THREE.Sprite(pulseSpriteMat);
        pulseSprite.scale.setScalar(
          isLocalCorridor ? (isFocusedArc ? 1.45 : 1.1) : isFocusedArc ? 2.8 : 2.1
        );
        pulseSprite.position.copy(pts[0]);
        refs.arcsGroup.add(pulseSprite);
        refs.arcTravelers.push({
          sprite: pulseSprite,
          pts,
          speed: category === "causal" ? 0.34 : 0.24,
          phase: (eIdx * 0.29) % 1,
        });
      }
    });
  }, [
    nodes,
    edges,
    arcMode,
    selectedNodeUuid,
    probedAnchorUuid,
    selectedEdgeUuid,
    cascadeEdgeUuids,
    enabledCategories,
    isRegionalZoom,
    regBucketLat,
    regBucketLng,
  ]);

  // Render Sleek Surface Probe Reticle(s) + Volumetric Comparison Arc for 1-Pin / 2-Pin / Case-Study Earth Probe
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;

    disposeGroupResources(refs.probeGroup, refs.sharedTextures);
    refs.probeTravelers = [];
    refs.probeMidpoint = null;

    const addProbeReticle = (coord: { lat: number; lng: number }, hexColor: number) => {
      const unitNormal = latLngToVector3(coord.lat, coord.lng, 1).normalize();
      const pos = unitNormal.clone().multiplyScalar(EARTH_RADIUS + 0.65);

      const spriteMat = new THREE.SpriteMaterial({
        map: refs.glowTex,
        color: hexColor,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const probeOrb = new THREE.Sprite(spriteMat);
      probeOrb.position.copy(unitNormal.clone().multiplyScalar(EARTH_RADIUS + 2.8));
      probeOrb.scale.setScalar(6.5);
      refs.probeGroup.add(probeOrb);

      const ringGeo = new THREE.PlaneGeometry(6.2, 6.2);
      const ringMat = new THREE.MeshBasicMaterial({
        map: refs.ringTex,
        color: hexColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      ring.lookAt(unitNormal.clone().multiplyScalar(EARTH_RADIUS * 2));
      ring.userData.probeRing = true;
      refs.probeGroup.add(ring);
    };

    const visuals = resolveComparisonArcVisuals(comparisonArcMeta);
    if (probedCoord) addProbeReticle(probedCoord, 0xfacc15);
    if (comparePinB) {
      addProbeReticle(comparePinB, comparisonArcMeta ? visuals.colorHex : 0x22d3ee);
    }

    if (probedCoord && comparePinB && !selectedEdgeUuid) {
      const curvePts = buildElevatedGreatCircleCurve(
        probedCoord.lat,
        probedCoord.lng,
        comparePinB.lat,
        comparePinB.lng,
        72
      );
      if (
        curvePts.length >= 2 &&
        curvePts.every(
          (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
        )
      ) {
        const curve = new THREE.CatmullRomCurve3(curvePts);
        const tubeGeo = new THREE.TubeGeometry(curve, 64, visuals.coreRadius, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({
          color: visuals.colorHex,
          transparent: true,
          opacity: 0.96,
          depthWrite: false,
        });
        refs.probeGroup.add(new THREE.Mesh(tubeGeo, tubeMat));

        const haloGeo = new THREE.TubeGeometry(curve, 52, visuals.haloRadius, 8, false);
        const haloMat = new THREE.MeshBasicMaterial({
          color: visuals.colorHex,
          transparent: true,
          opacity: visuals.haloOpacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        refs.probeGroup.add(new THREE.Mesh(haloGeo, haloMat));

        const pulseSpriteMat = new THREE.SpriteMaterial({
          map: refs.glowTex,
          color: visuals.pulseColorHex,
          transparent: true,
          opacity: 0.94,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const pulseSprite = new THREE.Sprite(pulseSpriteMat);
        pulseSprite.scale.setScalar(2.6);
        pulseSprite.position.copy(curvePts[0]);
        refs.probeGroup.add(pulseSprite);
        refs.probeTravelers.push({
          sprite: pulseSprite,
          pts: curvePts,
          speed: visuals.pulseSpeed,
          phase: 0,
        });

        if (comparisonArcMeta) {
          refs.probeMidpoint = {
            midpoint: curve.getPoint(0.5),
            badgeText: comparisonArcMeta.badgeText,
            pairLabel: comparisonArcMeta.pairLabel,
            statText: comparisonArcMeta.statText,
            colorCss: visuals.colorCss,
          };
        }
      }
    }
  }, [probedCoord, comparePinB, selectedEdgeUuid, comparisonArcMeta]);

  const resetCamera = () => {
    cameraTargetRef.current = { theta: 0.9, phi: Math.PI * 0.41, radius: 270 };
  };

  const zoomIn = () => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const base = cameraTargetRef.current ?? {
      theta: refs.spherical.theta,
      phi: refs.spherical.phi,
      radius: refs.spherical.radius,
    };
    const step = base.radius < 185 ? 24 : 32;
    cameraTargetRef.current = {
      ...base,
      radius: Math.max(MIN_GLOBE_CAMERA_RADIUS, base.radius - step),
    };
  };

  const zoomOut = () => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const base = cameraTargetRef.current ?? {
      theta: refs.spherical.theta,
      phi: refs.spherical.phi,
      radius: refs.spherical.radius,
    };
    cameraTargetRef.current = { ...base, radius: Math.min(430, base.radius + 32) };
  };

  const zoomToRegion = () => {
    const vec = latLngToVector3(regionalFocalCoord.lat, regionalFocalCoord.lng, 1);
    const sph = new THREE.Spherical().setFromVector3(vec);
    cameraTargetRef.current = {
      theta: sph.theta,
      phi: Math.max(0.2, Math.min(Math.PI - 0.2, sph.phi)),
      radius: DEFAULT_REGIONAL_FOCUS_RADIUS,
    };
    setAutoRotate(false);
  };

  const hideGibsPopover = () => {
    const pop = document.getElementById("etg-gibs-popover") as
      | (HTMLElement & { hidePopover?: () => void })
      | null;
    pop?.hidePopover?.();
  };

  const regionalSatelliteOptions: Array<{
    id: RegionalSatelliteMode;
    label: string;
    detail: string;
  }> = [
    { id: "auto", label: "Auto", detail: "Matches topic" },
    { id: "multi_slice", label: "4-Slice Split", detail: "NASA SVS Showcase" },
    { id: "winds", label: "Winds", detail: "MERRA-2 Winds" },
    { id: "precip", label: "Water / Rain", detail: "Water Vapor + Rain" },
    { id: "sst_anomaly", label: "Ocean Anomaly", detail: "1 km MUR SST" },
    { id: "thermal", label: "Thermal", detail: "SST & Land Temp" },
    { id: "air_temp", label: "Air Temp", detail: "MERRA-2 2m T" },
    { id: "aerosols", label: "Aerosols", detail: "MERRA-2 Smoke/Dust" },
    { id: "ndvi", label: "NDVI", detail: "250 m Canopy" },
    { id: "true_color", label: "True Color", detail: "MODIS + Borders" },
    { id: "night_viirs", label: "Night", detail: "500 m VIIRS" },
    { id: "off", label: "Off", detail: "Blue Marble" },
  ];

  const activeGlobalFilter = resolveGlobalFilterLayer(satelliteMode, activeTopics);

  const sunLabels: Record<SunPreset, string> = {
    live: "Sun: Live",
    daylight: "Full Daylight",
    americas: "Sun: Americas",
    eurasia: "Sun: Eurasia",
    night: "Sun: Night",
  };

  const arcLabels: Record<GlobeArcMode, string> = {
    all: "Links: All",
    focus: "Links: Selected",
    opposite: "Links: Opposite",
    causal: "Links: Causal →",
    dipoles: "Links: Top 6",
    off: "Links: Hidden",
  };

  const ARC_MODE_CYCLE: GlobeArcMode[] = [
    "all",
    "focus",
    "opposite",
    "causal",
    "dipoles",
    "off",
  ];

  const globeToolbarRef = useRef<HTMLDivElement | null>(null);
  const [globeToolbarIdx, setGlobeToolbarIdx] = useState(0);

  const cycleArcMode = () => {
    setArcMode((prev) => {
      const idx = ARC_MODE_CYCLE.indexOf(prev);
      return ARC_MODE_CYCLE[(idx + 1) % ARC_MODE_CYCLE.length] ?? "all";
    });
  };

  const activeCategorySet = new Set<RelationCategory>(
    enabledCategories ?? ALL_RELATION_CATEGORIES
  );

  const toggleRelationCategory = (cat: RelationCategory) => {
    if (!onChangeEnabledCategories) return;
    const next = activeCategorySet.has(cat)
      ? Array.from(activeCategorySet).filter((c) => c !== cat)
      : [...Array.from(activeCategorySet), cat];
    onChangeEnabledCategories(next);
  };

  const handleGlobeToolbarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = Array.from(
      globeToolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    if (buttons.length === 0) return;
    const current = buttons.findIndex((b) => b === document.activeElement);
    const idx = current >= 0 ? current : globeToolbarIdx;
    let next = idx;
    if (e.key === "ArrowLeft") next = (idx - 1 + buttons.length) % buttons.length;
    if (e.key === "ArrowRight") next = (idx + 1) % buttons.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = buttons.length - 1;
    e.preventDefault();
    setGlobeToolbarIdx(next);
    buttons[next]?.focus();
  };

  const handleGlobeToolbarFocusCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    const targetBtn =
      e.target instanceof Element ? e.target.closest("button") : null;
    if (!targetBtn) return;
    const buttons = Array.from(
      globeToolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    const idx = buttons.findIndex((b) => b === targetBtn);
    if (idx >= 0) {
      setGlobeToolbarIdx(idx);
    }
  };

  const activeGibsMeta = regionalHud.layerId ? GIBS_LAYERS[regionalHud.layerId] : null;
  const activeRegionalColorbar = getGibsLayerColorbar(regionalHud.layerId);
  const isMultiSliceFilter = satelliteMode === "multi_slice";
  const activeGlobalMeta = activeGlobalFilter ? GIBS_LAYERS[activeGlobalFilter] : null;
  const earthFilterButtonLabel = isMultiSliceFilter
    ? "Filter: 4-Slice Split"
    : activeGlobalMeta
      ? `Filter: ${activeGlobalMeta.shortLabel}`
      : "Earth Filter";
  const quickGlobalFilterPills: Array<{ id: RegionalSatelliteMode; label: string }> = [
    { id: "multi_slice", label: "4-Slice" },
    { id: "winds", label: "Winds" },
    { id: "precip", label: "Water / Rain" },
    { id: "sst_anomaly", label: "Ocean Anomaly" },
    { id: "thermal", label: "Thermal" },
    { id: "air_temp", label: "Air Temp" },
    { id: "aerosols", label: "Aerosols" },
    { id: "ndvi", label: "NDVI" },
    { id: "true_color", label: "True Color" },
    { id: "night_viirs", label: "Night" },
  ];

  return (
    <div className="etg-globe-void relative h-full w-full overflow-hidden select-none">
      <div ref={containerRef} className="h-full w-full" aria-label="Interactive 3D Earth Globe" />

      {/* Front-Hemisphere Interactive Arc Relation & Active Comparison Labels */}
      {((showArcLabels && projectedArcLabels.length > 0) || projectedProbeLabel !== null) && (
        <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
          {projectedProbeLabel && (
            <div
              style={{ left: `${projectedProbeLabel.x}px`, top: `${projectedProbeLabel.y}px` }}
              className="pointer-events-none -translate-x-1/2 -translate-y-1/2 absolute inline-flex items-center gap-1.5 rounded-sm border border-rose-400 bg-rose-950/95 px-2.5 py-1 text-[11px] font-medium text-rose-100 shadow-lg backdrop-blur-sm"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: projectedProbeLabel.colorCss }}
                aria-hidden="true"
              />
              <span className="font-semibold whitespace-nowrap">{projectedProbeLabel.badgeText}</span>
              <span className="max-w-[160px] truncate text-rose-200 hidden sm:inline">
                {projectedProbeLabel.pairLabel}
              </span>
              {projectedProbeLabel.statText && (
                <span className="font-mono text-[10px] font-semibold ws-numeric whitespace-nowrap text-amber-300">
                  {projectedProbeLabel.statText}
                </span>
              )}
            </div>
          )}
          {showArcLabels &&
            projectedArcLabels.map((lbl) => (
              <button
                key={lbl.uuid}
                type="button"
                onClick={() => onSelectEdge?.(lbl.edge)}
                style={{ left: `${lbl.x}px`, top: `${lbl.y}px` }}
                className={`pointer-events-auto -translate-x-1/2 -translate-y-1/2 absolute inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-medium shadow-md transition-colors cursor-pointer ${
                  lbl.isSelected
                    ? "border-amber-300 bg-amber-950 text-amber-300 ring-1 ring-amber-400"
                    : "border-border bg-surface text-text-primary hover:border-text-muted hover:bg-surface-elevated"
                }`}
                title={`${lbl.badgeText}: ${lbl.pairLabel}${lbl.statText ? ` (${lbl.statText})` : ""}`}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: lbl.colorCss }}
                  aria-hidden="true"
                />
                <span className="font-semibold whitespace-nowrap">{lbl.badgeText}</span>
                <span className="max-w-[130px] truncate text-text-muted hidden sm:inline">
                  {lbl.pairLabel}
                </span>
                {lbl.statText && (
                  <span
                    className={`font-mono text-[9px] ws-numeric whitespace-nowrap ${
                      lbl.isSelected ? "text-amber-300" : "etg-tone-warm"
                    }`}
                  >
                    {lbl.statText}
                  </span>
                )}
              </button>
            ))}
        </div>
      )}

      {/* Regional Zoom Station & Node Badges */}
      {showPins && isRegionalZoom && projectedNodeLabels.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-[6] overflow-hidden">
          {projectedNodeLabels.map((lbl) => (
            <button
              key={lbl.uuid}
              type="button"
              onClick={() => onSelectNode?.(lbl.node)}
              style={{ left: `${lbl.x}px`, top: `${lbl.y}px` }}
              className={`pointer-events-auto -translate-x-1/2 -translate-y-1/2 absolute inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-medium shadow-md transition-colors cursor-pointer ${
                lbl.isSelected
                  ? "border-amber-300 bg-amber-950 text-amber-300 ring-1 ring-amber-400"
                  : "border-border-strong bg-surface text-text-primary hover:border-accent-fg hover:bg-surface-elevated"
              }`}
              title={lbl.name}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: lbl.colorCss }}
                aria-hidden="true"
              />
              <span className="max-w-[140px] truncate font-semibold whitespace-nowrap">
                {lbl.name}
              </span>
              {lbl.metricText && (
                <span
                  className={`font-mono text-[9px] ws-numeric whitespace-nowrap ${
                    lbl.isSelected ? "text-amber-300" : "etg-tone-warm"
                  }`}
                >
                  {lbl.metricText}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Top-Left Global Earth Filter Legend HUD Card */}
      {!isRegionalZoom && (isMultiSliceFilter || activeGlobalMeta !== null) && (
        <section
          aria-label="Global NASA GIBS scientific Earth filter"
          className="etg-hud-pill pointer-events-auto absolute top-3 left-14 z-10 max-sm:left-[4.75rem] max-sm:w-[calc(100dvw-5.5rem)] sm:top-3 sm:w-[min(368px,calc(100dvw-5rem))] space-y-2 rounded-md border border-border bg-surface/95 p-2.5 text-xs shadow-lg backdrop-blur-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  globalHud.error ? "bg-rose-400" : "bg-sky-400"
                }`}
                aria-hidden="true"
              />
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="truncate font-semibold text-text-primary">
                {isMultiSliceFilter
                  ? "NASA SVS 4-Slice Earth Composite"
                  : activeGlobalMeta?.label}
              </span>
              {globalHud.loading && (
                <Loader2
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400"
                  aria-label="Loading NASA GIBS Earth filter"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-pressed={filterSmooth}
                onClick={() => setFilterSmooth((v) => !v)}
                title="Smooth quantized satellite contours and 1 km speckles"
                className="hidden sm:inline-flex items-center rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[10px] font-semibold text-text-muted transition-colors hover:border-text-muted hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                Smooth
              </button>
              <button
                type="button"
                onClick={() => setSatelliteMode("off")}
                aria-label="Clear global Earth filter"
                className="inline-flex items-center gap-1 rounded-sm border border-border-strong bg-surface-elevated px-2 py-0.5 text-[10px] font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
              >
                <X className="h-3 w-3" aria-hidden="true" />
                <span>Clear</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileHudExpanded((v) => !v)}
                aria-expanded={mobileHudExpanded}
                aria-label={mobileHudExpanded ? "Collapse Earth filter legend" : "Expand Earth filter legend"}
                className="inline-flex sm:hidden items-center justify-center rounded-sm border border-border bg-surface-inset p-1 text-text-muted hover:text-text-primary cursor-pointer"
              >
                {mobileHudExpanded ? (
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div className="ws-numeric flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-text-muted">
            <span className="truncate">
              {isMultiSliceFilter
                ? "MERRA-2 · IMERG · MODIS (Global + Borders)"
                : activeGlobalMeta?.resolutionLabel}
            </span>
            {globalHud.dateIso && (
              <>
                <span aria-hidden="true">·</span>
                <span>{globalHud.dateIso}</span>
              </>
            )}
            {globalHud.resBadge && (
              <>
                <span aria-hidden="true">·</span>
                <span className="rounded-xs border border-sky-400/50 bg-sky-950/80 px-1 py-px text-[9px] font-semibold text-sky-300">
                  {globalHud.resBadge}
                </span>
              </>
            )}
            {globalHud.error && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-rose-300">Archive fallback active</span>
              </>
            )}
          </div>

          {isMultiSliceFilter ? (
            <div className={`grid grid-cols-4 gap-1 rounded-xs border border-border bg-surface-inset p-1.5 text-[10px] ${mobileHudExpanded ? "" : "max-sm:hidden"}`}>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-emerald-800 to-lime-500" />
                <div className="truncate font-medium text-text-primary">1. Canopy</div>
              </div>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-blue-900 via-cyan-400 to-amber-300" />
                <div className="truncate font-medium text-text-primary">2. Winds</div>
              </div>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-lime-400 via-amber-400 to-red-600" />
                <div className="truncate font-medium text-text-primary">3. Precip. Water</div>
              </div>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-slate-600 to-slate-100" />
                <div className="truncate font-medium text-text-primary">4. Clouds</div>
              </div>
            </div>
          ) : (
            activeGlobalMeta?.colorbar &&
            (() => {
              const cb = formatGibsColorbarForUnit(activeGlobalMeta.colorbar, tempUnit);
              return (
                <div className="space-y-1 rounded-xs border border-border bg-surface-inset px-2 py-1.5">
                  <div
                    className="etg-colorbar-track h-2 w-full rounded-xs"
                    style={{ background: cb.gradientCss }}
                  />
                  <div className="ws-numeric flex items-center justify-between gap-2 font-mono text-[10px] text-text-muted">
                    <span>{cb.minLabel}</span>
                    {cb.midLabel && (
                      <span className="text-text-subtle">{cb.midLabel}</span>
                    )}
                    <span>
                      {cb.maxLabel}{" "}
                      <span className="text-text-subtle">({cb.unitLabel})</span>
                    </span>
                  </div>
                </div>
              );
            })()
          )}

          <div className={`flex flex-wrap gap-1 border-t border-border pt-1.5 ${mobileHudExpanded ? "" : "max-sm:hidden"}`}>
            {quickGlobalFilterPills.map((pill) => {
              const pressed =
                pill.id === "multi_slice"
                  ? isMultiSliceFilter
                  : !isMultiSliceFilter && activeGlobalFilter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setSatelliteMode(pill.id)}
                  className="rounded-xs border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-text-muted hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                >
                  {pill.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Top-Left Regional Satellite HUD Card */}
      {isRegionalZoom && (
        <section
          aria-label="Regional NASA GIBS satellite overlay"
          className="etg-hud-pill pointer-events-auto absolute top-3 left-14 z-10 max-sm:left-[4.75rem] max-sm:w-[calc(100dvw-5.5rem)] sm:top-3 sm:w-[min(368px,calc(100dvw-5rem))] space-y-2 rounded-md border border-border bg-surface/95 p-2.5 text-xs shadow-lg backdrop-blur-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  regionalHud.error
                    ? "bg-rose-400"
                    : regionalHud.layerId
                      ? "bg-sky-400"
                      : "bg-slate-400"
                }`}
                aria-hidden="true"
              />
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="truncate font-semibold text-text-primary">
                {activeGibsMeta
                  ? activeGibsMeta.label
                  : "Regional Vector View (Basemap Only)"}
              </span>
              {regionalHud.loading && (
                <Loader2
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400"
                  aria-label="Loading NASA GIBS satellite swath"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={resetCamera}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-strong bg-surface-elevated px-2 py-0.5 text-[10px] font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                <span>Global View</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileHudExpanded((v) => !v)}
                aria-expanded={mobileHudExpanded}
                aria-label={mobileHudExpanded ? "Collapse regional satellite legend" : "Expand regional satellite legend"}
                className="inline-flex sm:hidden items-center justify-center rounded-sm border border-border bg-surface-inset p-1 text-text-muted hover:text-text-primary cursor-pointer"
              >
                {mobileHudExpanded ? (
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div className="ws-numeric flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-text-muted">
            <span className="truncate">
              {activeGibsMeta ? activeGibsMeta.resolutionLabel : "50 / 150 km vector grid"}
            </span>
            <span aria-hidden="true">·</span>
            <span>~{regionalHud.swathKm} km swath</span>
            <span aria-hidden="true">·</span>
            <span>{regionalHud.dateIso}</span>
          </div>

          {activeRegionalColorbar &&
            (() => {
              const cb = formatGibsColorbarForUnit(activeRegionalColorbar, tempUnit);
              return (
                <div className="space-y-1 rounded-xs border border-border bg-surface-inset px-2 py-1.5">
                  <div
                    className="etg-colorbar-track h-2 w-full rounded-xs"
                    style={{ background: cb.gradientCss }}
                  />
                  <div className="ws-numeric flex items-center justify-between gap-2 font-mono text-[10px] text-text-muted">
                    <span>{cb.minLabel}</span>
                    {cb.midLabel && (
                      <span className="text-text-subtle">{cb.midLabel}</span>
                    )}
                    <span>
                      {cb.maxLabel}{" "}
                      <span className="text-text-subtle">({cb.unitLabel})</span>
                    </span>
                  </div>
                </div>
              );
            })()}

          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-subtle ${mobileHudExpanded ? "" : "max-sm:hidden"}`}>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
              <span>50 km MERRA-2</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
              <span>150 km mesoscale</span>
            </span>
          </div>

          {regionalHud.error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 rounded-xs border border-rose-400 bg-rose-950 px-2 py-1.5 text-[11px] text-rose-300"
            >
              <span>
                Failed to fetch NASA GIBS satellite tile — showing Blue Marble + geodesic rings.
              </span>
              <button
                type="button"
                onClick={() => sceneRefs.current?.forceRegionalTileSync()}
                aria-label="Retry satellite tile"
                className="shrink-0 cursor-pointer rounded-xs border border-rose-400 bg-rose-900 px-2 py-0.5 text-[10px] font-semibold text-rose-100 hover:bg-rose-800"
              >
                Retry
              </button>
            </div>
          )}

          {!regionalHud.error &&
            satelliteMode !== "off" &&
            !regionalHud.layerId &&
            Math.abs(regionalHud.centerLat) > 85 && (
              <div className="rounded-xs border border-border-subtle bg-surface-inset px-2 py-1 text-[11px] text-text-muted">
                NASA GIBS tile unavailable poleward of 85° (Web Mercator limit).
              </div>
            )}

          <div
            className={`grid grid-cols-3 gap-1 ${mobileHudExpanded ? "" : "max-sm:hidden"}`}
            role="group"
            aria-label="Satellite spectral band"
          >
            {regionalSatelliteOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={satelliteMode === opt.id}
                onClick={() => setSatelliteMode(opt.id)}
                className="rounded-sm border border-border bg-surface-inset px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Left-Edge Vertical Camera Dock */}
      <div className="absolute left-2.5 top-3 z-10 sm:left-3.5 sm:top-1/2 sm:-translate-y-1/2">
        <GraphCameraDock
          orientation="vertical"
          showOrbitControls
          isOrbiting={autoRotate}
          onToggleOrbit={() => setAutoRotate((v) => !v)}
          onRecenter={resetCamera}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
        />
      </div>

      {/* Coordinated Bottom HUD Bar: Globe Display Controls (Left) + Timeline Scrubber (Right) */}
      <div
        className={`pointer-events-none absolute bottom-2 left-2 right-2 z-10 flex flex-wrap items-end justify-between gap-2 sm:bottom-3 sm:left-14 sm:right-4 ${
          inspectorOpen ? "sm:right-[25.75rem] lg:right-[26.25rem]" : ""
        } ${
          mobileSheetExpanded
            ? "max-sm:hidden"
            : inspectorOpen
              ? "max-sm:bottom-[7.75rem]"
              : ""
        }`}
      >
        <div className="pointer-events-auto relative flex flex-col items-start gap-1.5">
          {(() => {
            const flagged = nodes
              .map((node) => ({
                node,
                cue: microscopeByNode?.[node.uuid],
              }))
              .filter(
                (
                  item
                ): item is { node: ETGNode; cue: NodeTrendMicroscopeCue } =>
                  Boolean(
                    item.cue &&
                      (item.cue.radarBadge === "EARLY_ONSET" ||
                        item.cue.radarBadge === "FALSE_TREND_CYCLE" ||
                        item.cue.radarBadge === "SENSOR_GLITCH_RISK")
                  )
              )
              .sort(
                (a, b) =>
                  Math.max(b.cue.onsetProb, b.cue.dealiasing.falseTrendProb) -
                  Math.max(a.cue.onsetProb, a.cue.dealiasing.falseTrendProb)
              );
            if (flagged.length === 0) return null;
            const top = flagged[0];
            const isGlitch = top.cue.radarBadge === "SENSOR_GLITCH_RISK";
            const isCycle = top.cue.radarBadge === "FALSE_TREND_CYCLE";
            return (
              <button
                type="button"
                onClick={() => onSelectNode(top.node)}
                title={microscopeScan?.aiPerceptionBrief || top.cue.aiCue}
                className={`etg-hud-pill ws-numeric inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                  isGlitch
                    ? "border-rose-400 bg-rose-950 text-rose-300 hover:border-rose-300"
                    : isCycle
                      ? "border-violet-400 bg-purple-950 text-violet-300 hover:border-violet-300"
                      : "border-amber-400 bg-amber-950 text-amber-300 hover:border-amber-300"
                }`}
              >
                <ScanSearch className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  Microscope ({flagged.length}): {humanizeNodeText(top.node.properties.name)} ·{" "}
                  {isGlitch
                    ? "Sensor Glitch Risk"
                    : isCycle
                      ? `Cycle Alias ${Math.round(top.cue.dealiasing.oscillationShare * 100)}%`
                      : `Early Onset ${Math.round(top.cue.onsetProb * 100)}%${top.cue.preMannKendallAlert ? " (Pre-MK)" : ""}`}
                </span>
              </button>
            );
          })()}

          {probedCoord && !inspectorOpen && (
            <div className="etg-hud-pill ws-numeric inline-flex items-center gap-2 rounded-sm border-amber-400 bg-amber-950 px-2.5 py-1 font-mono text-[11px] text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
              <span>
                Probe{" "}
                {probedCoord.lat >= 0
                  ? `${probedCoord.lat.toFixed(2)}°N`
                  : `${Math.abs(probedCoord.lat).toFixed(2)}°S`}
                ,{" "}
                {probedCoord.lng >= 0
                  ? `${probedCoord.lng.toFixed(2)}°E`
                  : `${Math.abs(probedCoord.lng).toFixed(2)}°W`}
              </span>
            </div>
          )}

          <div
            ref={globeToolbarRef}
            {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
            onKeyDown={handleGlobeToolbarKeyDown}
            onFocusCapture={handleGlobeToolbarFocusCapture}
            role="toolbar"
            aria-orientation="horizontal"
            aria-label="Globe display controls"
            className="etg-hud-pill inline-flex flex-wrap items-center gap-1 rounded-md bg-surface p-1 text-[11px]"
          >
            <button
              type="button"
              tabIndex={globeToolbarIdx === 0 ? 0 : -1}
              popoverTarget="etg-globe-layers-popover"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
              title="Customize visible globe arcs, pins, labels, clouds, and relation types"
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span>Layers</span>
            </button>

            <button
              type="button"
              tabIndex={globeToolbarIdx === 1 ? 0 : -1}
              onClick={cycleArcMode}
              aria-label={arcLabels[arcMode]}
              title="Cycle globe relation arcs: All, Selected spot, Opposite, Causal, Top 6, or Hidden"
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                arcMode === "opposite"
                  ? "border-rose-400 bg-rose-950 text-rose-300"
                  : arcMode === "causal"
                    ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                    : arcMode === "dipoles" || arcMode === "all"
                      ? "border-sky-400 bg-sky-950 text-sky-300"
                      : arcMode === "off"
                        ? "border-transparent text-text-subtle hover:bg-surface-band hover:text-text-primary"
                        : "border-transparent text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{arcLabels[arcMode]}</span>
            </button>

            <button
              type="button"
              tabIndex={globeToolbarIdx === 2 ? 0 : -1}
              aria-pressed={showClouds}
              aria-label="Toggle 3D clouds"
              onClick={() => setShowClouds((v) => !v)}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-accent-fg aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
            >
              <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Clouds</span>
            </button>

            {onToggleCompareMode && (
              <button
                type="button"
                tabIndex={globeToolbarIdx === 3 ? 0 : -1}
                aria-pressed={Boolean(compareMode)}
                aria-label="Compare 2 spots on Earth"
                onClick={onToggleCompareMode}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-cyan-400 aria-pressed:bg-cyan-950 aria-pressed:text-cyan-300 cursor-pointer"
              >
                <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">Compare 2 Spots</span>
              </button>
            )}

            <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 border-l border-border" />

            <button
              type="button"
              tabIndex={globeToolbarIdx === (onToggleCompareMode ? 4 : 3) ? 0 : -1}
              popoverTarget="etg-sun-popover"
              aria-label={sunLabels[sunPreset]}
              title="Solar illumination preset"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
            >
              <Sun className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
              <span className="hidden md:inline">{sunLabels[sunPreset]}</span>
            </button>

            <button
              type="button"
              tabIndex={globeToolbarIdx === (onToggleCompareMode ? 5 : 4) ? 0 : -1}
              popoverTarget="etg-gibs-popover"
              aria-label={earthFilterButtonLabel}
              title="Global & regional NASA GIBS scientific Earth filters"
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                isRegionalZoom || isMultiSliceFilter || activeGlobalFilter !== null
                  ? "border-sky-400 bg-sky-950 text-sky-300"
                  : "border-transparent text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="hidden sm:inline">{earthFilterButtonLabel}</span>
            </button>
          </div>

          {/* Upward Layers & Relations Customization Popover */}
          <div
            id="etg-globe-layers-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-72 space-y-3 p-3 text-xs"
          >
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                Globe Arc Links
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: "all", label: "All Links" },
                    { id: "focus", label: "Selected" },
                    { id: "opposite", label: "Opposite" },
                    { id: "causal", label: "Causal →" },
                    { id: "dipoles", label: "Top 6" },
                    { id: "off", label: "Hidden" },
                  ] as Array<{ id: GlobeArcMode; label: string }>
                ).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={arcMode === mode.id}
                    onClick={() => setArcMode(mode.id)}
                    className="rounded-sm border border-border bg-surface-inset px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            {onChangeEnabledCategories && (
              <div className="border-t border-border pt-2.5">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                  Relation Categories
                </div>
                <div className="space-y-0.5">
                  {ALL_RELATION_CATEGORIES.map((cat) => {
                    const checked = activeCategorySet.has(cat);
                    const dotColor =
                      cat === "opposite"
                        ? "#fb7185"
                        : cat === "causal"
                          ? "#34d399"
                          : cat === "coupled"
                            ? "#38bdf8"
                            : "#a78bfa";
                    return (
                      <label key={cat} className="etg-check-label">
                        <input
                          type="checkbox"
                          className="checkbox-native"
                          checked={checked}
                          onChange={() => toggleRelationCategory(cat)}
                        />
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: dotColor }}
                          aria-hidden="true"
                        />
                        <span className="text-xs text-text-primary">
                          {RELATION_CATEGORY_META[cat].label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t border-border pt-2.5">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                Globe Overlays
              </div>
              <div className="space-y-0.5">
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={showArcLabels}
                    onChange={(e) => setShowArcLabels(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">Arc callout labels</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={showPins}
                    onChange={(e) => setShowPins(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">Station & trend pins</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={showClouds}
                    onChange={(e) => setShowClouds(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">3D cloud deck</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={autoRotate}
                    onChange={(e) => setAutoRotate(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">Auto-orbit globe</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={sunPreset !== "daylight"}
                    onChange={(e) => setSunPreset(e.target.checked ? "live" : "daylight")}
                  />
                  <span className="text-xs text-text-primary">Day / night terminator</span>
                </label>
              </div>
            </div>

            {onChangeTempUnit && (
              <div className="flex items-center justify-between border-t border-border pt-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                  Temperature Unit
                </span>
                <div className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5">
                  {(["C", "F"] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      aria-pressed={tempUnit === u}
                      onClick={() => onChangeTempUnit(u)}
                      className="rounded-sm px-2 py-0.5 text-[11px] font-semibold text-text-muted aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                    >
                      °{u}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Upward Lighting Popover */}
          <div
            id="etg-sun-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-56 space-y-1.5 p-2.5"
          >
            <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              <span>Solar Lighting</span>
              {sunPreset === "live" && (
                <span className="font-mono text-[10px] text-amber-400">{liveUtcTime}</span>
              )}
            </div>
            {(
              [
                { id: "live", label: "Live Time (Dynamic)" },
                { id: "daylight", label: "Full Daylight (Off)" },
                { id: "americas", label: "Americas" },
                { id: "eurasia", label: "Eurasia" },
                { id: "night", label: "Night Lights" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={sunPreset === opt.id}
                onClick={() => {
                  setSunPreset(opt.id);
                  if (opt.id === "americas") {
                    cameraTargetRef.current = { theta: 0.9, phi: Math.PI * 0.41, radius: 260 };
                    setAutoRotate(false);
                  } else if (opt.id === "eurasia") {
                    cameraTargetRef.current = { theta: -1.1, phi: Math.PI * 0.36, radius: 260 };
                    setAutoRotate(false);
                  } else if (opt.id === "night") {
                    cameraTargetRef.current = { theta: 0.85, phi: Math.PI * 0.4, radius: 260 };
                    setAutoRotate(false);
                  }
                  const pop = document.getElementById("etg-sun-popover") as
                    | (HTMLElement & { hidePopover?: () => void })
                    | null;
                  pop?.hidePopover?.();
                }}
                className="flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-accent-fg aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
              >
                <span>{opt.label}</span>
                {sunPreset === opt.id && (
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-fg" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>

          {/* Upward Regional NASA GIBS Satellite Popover */}
          <div
            id="etg-gibs-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-64 space-y-2.5 p-2.5 text-xs"
          >
            <div className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              <span>NASA GIBS Earth Filters</span>
              <span className="font-mono text-[10px] text-sky-400">
                {isMultiSliceFilter
                  ? "4-slice"
                  : isRegionalZoom
                    ? regionalHud.tier
                    : activeGlobalFilter
                      ? "global"
                      : "base"}
              </span>
            </div>

            {isRegionalZoom ? (
              <button
                type="button"
                onClick={() => {
                  resetCamera();
                  hideGibsPopover();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reset to Global View</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  zoomToRegion();
                  hideGibsPopover();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-2.5 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-900 cursor-pointer"
              >
                <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Zoom into Region</span>
              </button>
            )}

            <div className="space-y-1 border-t border-border pt-2">
              {regionalSatelliteOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={satelliteMode === opt.id}
                  onClick={() => setSatelliteMode(opt.id)}
                  className="flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-1 text-left text-xs font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                >
                  <span>{opt.label}</span>
                  <span className="font-mono text-[10px] text-text-faint">{opt.detail}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {timelineSlot && (
          <div className="pointer-events-auto min-w-0 w-full flex-1 basis-[220px] sm:min-w-[260px] sm:basis-[340px] sm:max-w-[460px]">
            {timelineSlot}
          </div>
        )}
      </div>

      {/* Hover Tooltip */}
      {hoveredInfo && (
        <div
          className="etg-hud-pill pointer-events-none absolute z-20 max-w-xs rounded-md bg-surface px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(hoveredInfo.x + 14, (containerRef.current?.clientWidth ?? 600) - 240),
            top: Math.max(12, hoveredInfo.y - 46),
          }}
        >
          <div className="font-medium text-text-primary">{hoveredInfo.name}</div>
          <div className="mt-0.5 text-[11px] text-text-muted">{hoveredInfo.subtitle}</div>
          {hoveredInfo.radarDetail && hoveredInfo.radarBadge && (
            <div
              className={`mt-1 inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${
                hoveredInfo.radarBadge === "SENSOR_GLITCH_RISK"
                  ? "border-rose-400 bg-rose-950 text-rose-300"
                  : hoveredInfo.radarBadge === "FALSE_TREND_CYCLE"
                    ? "border-violet-400 bg-purple-950 text-violet-300"
                    : hoveredInfo.radarBadge === "EARLY_ONSET"
                      ? "border-amber-400 bg-amber-950 text-amber-300"
                      : "border-emerald-400 bg-emerald-950 text-emerald-300"
              }`}
            >
              <span>Microscope: {hoveredInfo.radarDetail}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
