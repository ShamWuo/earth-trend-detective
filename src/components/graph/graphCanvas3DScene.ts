"use client";

import * as THREE from "three";
import { computeSurfaceConnectionPoints } from "@/lib/graph/graphCamera";
import {
  createEtgHaloCanvas,
  createEtgNodeCanvas,
  type RegionCluster3D,
  resolveEtgEdgeColor,
  resolveEtgNodeColor,
  type ScreenLabelCandidate,
  selectNonOverlappingLabels,
} from "@/lib/graph/graphVisuals";
import { humanizeNodeText } from "@/lib/plainLanguage";
import type {
  CandidateLinkSuggestion,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  SubgraphNodeRole,
} from "@/types/etg";
import {
  type RegionSpotlightState,
  resolveMicroscopeNodeBadge,
} from "@/components/graph/graphViewShared";

export const DEFAULT_ORBIT_3D = { pitch: 0.34, yaw: 0.52, radius: 225 };

export interface SceneNodeObject3D {
  node: ETGNode;
  sprite: THREE.Sprite;
  halo: THREE.Sprite;
  baseScale: number;
  worldPos: THREE.Vector3;
}

export interface SceneEdgeObject3D {
  edge: ETGEdge;
  line: THREE.Line;
  material: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
  baseColorHex: string;
  midPoint: THREE.Vector3;
}

export interface CameraGlideState {
  active: boolean;
  startTime: number;
  durationMs: number;
  startCentre: THREE.Vector3;
  targetCentre: THREE.Vector3;
  startLookAt: THREE.Vector3;
  startRadius: number;
  targetRadius: number;
}

export interface Graph3DFocusSnapshot {
  selectedNodeUuid: string | null;
  selectedEdgeUuid: string | null;
  cascadeEdgeSet: Set<string>;
  hoveredUuid: string | null;
  hoveredEdgeUuid: string | null;
  matchingUuids: Set<string>;
  neighborMap: Map<string, Set<string>>;
  nodeById: Map<string, ETGNode>;
  isLightTheme: boolean;
  connectMode: boolean;
  connectSourceUuid: string | null;
  roleByNode: Record<string, SubgraphNodeRole>;
  microscopeByNode: Record<string, NodeTrendMicroscopeCue>;
  dipoleNodeUuids: Set<string>;
}

interface LayoutCoord3D {
  x: number;
  y: number;
  z: number;
}

function isFiniteCoord3D(coord: LayoutCoord3D | undefined): coord is LayoutCoord3D {
  return (
    Boolean(coord) &&
    Number.isFinite(coord!.x) &&
    Number.isFinite(coord!.y) &&
    Number.isFinite(coord!.z)
  );
}

/** Compute surface-trimmed 3D line geometry and midpoint shared by committed edges and candidate links. */
function buildSurfaceEdgeGeometry3D(
  srcUuid: string,
  tgtUuid: string,
  layoutPositions: Map<string, LayoutCoord3D>,
  nodeScaleByUuid: Map<string, number>
): { geometry: THREE.BufferGeometry; midPoint: THREE.Vector3 } | null {
  const p1 = layoutPositions.get(srcUuid);
  const p2 = layoutPositions.get(tgtUuid);
  if (!isFiniteCoord3D(p1) || !isFiniteCoord3D(p2)) {
    return null;
  }

  const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
  const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);
  if (v1.distanceToSquared(v2) < 1e-4) {
    v2.x += 0.6;
  }
  const srcScale = nodeScaleByUuid.get(srcUuid) ?? 10;
  const tgtScale = nodeScaleByUuid.get(tgtUuid) ?? 10;
  const { start: pStart, end: pEnd } = computeSurfaceConnectionPoints(
    v1,
    srcScale,
    v2,
    tgtScale,
    0.36
  );
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(pStart[0], pStart[1], pStart[2]),
    new THREE.Vector3(pEnd[0], pEnd[1], pEnd[2]),
  ]);
  const midPoint = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
  return { geometry, midPoint };
}

/** Create subtle spatial depth dust particles for the 3D ETG backdrop. */
export function createDustLayer3D(isLightTheme: boolean): {
  starGeo: THREE.BufferGeometry;
  starMat: THREE.PointsMaterial;
  dustPoints: THREE.Points;
} {
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
    color: isLightTheme ? 0x64748b : 0x94a3b8,
    size: 1.4,
    transparent: true,
    opacity: isLightTheme ? 0.2 : 0.24,
    depthWrite: false,
  });
  const dustPoints = new THREE.Points(starGeo, starMat);
  return { starGeo, starMat, dustPoints };
}

/** Build sprites, halos, committed edge lines, and candidate preview lines inside graphGroup. */
export function populateGraphGroup3D(params: {
  graphGroup: THREE.Group;
  nodes: ETGNode[];
  edges: ETGEdge[];
  candidateLinks: CandidateLinkSuggestion[];
  layoutPositions: Map<string, LayoutCoord3D>;
  neighborMap: Map<string, Set<string>>;
  isLightTheme: boolean;
}): {
  nodeObjects: SceneNodeObject3D[];
  edgeObjects: SceneEdgeObject3D[];
  pickSprites: THREE.Sprite[];
  edgePickLines: THREE.Line[];
  cleanup: () => void;
} {
  const {
    graphGroup,
    nodes,
    edges,
    candidateLinks,
    layoutPositions,
    neighborMap,
    isLightTheme,
  } = params;

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
    const built = buildSurfaceEdgeGeometry3D(
      edge.source_uuid,
      edge.target_uuid,
      layoutPositions,
      nodeScaleByUuid
    );
    if (!built) continue;

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

    const line = new THREE.Line(built.geometry, material);
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
      midPoint: built.midPoint,
    });
  }

  const candGeos: THREE.BufferGeometry[] = [];
  const candMats: THREE.Material[] = [];
  for (const cand of candidateLinks) {
    const built = buildSurfaceEdgeGeometry3D(
      cand.sourceUuid,
      cand.targetUuid,
      layoutPositions,
      nodeScaleByUuid
    );
    if (!built) continue;
    const mat = new THREE.LineDashedMaterial({
      color: 0xa78bfa,
      dashSize: 3.5,
      gapSize: 2.5,
      transparent: true,
      opacity: 0.72,
    });
    const dashed = new THREE.Line(built.geometry, mat);
    dashed.computeLineDistances();
    graphGroup.add(dashed);
    addedChildren.push(dashed);
    candGeos.push(built.geometry);
    candMats.push(mat);
  }

  const cleanup = () => {
    for (const obj of addedChildren) {
      graphGroup.remove(obj);
    }
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

  return { nodeObjects, edgeObjects, pickSprites, edgePickLines, cleanup };
}

/** Update per-frame depth/focus opacities, 8-tier edge attenuation, and collision-free projected pill labels. */
export function updateGraph3DFrameVisibilityAndLabels(params: {
  camera: THREE.PerspectiveCamera;
  viewportWidth: number;
  viewportHeight: number;
  inspectorOpen: boolean;
  nodeObjects: SceneNodeObject3D[];
  edgeObjects: SceneEdgeObject3D[];
  regionClusters: RegionCluster3D[];
  selectedRegionScope: string | null;
  regionSpotlight: RegionSpotlightState | null;
  focusState: Graph3DFocusSnapshot;
  labelEls: Map<string, HTMLButtonElement>;
  regionLabelEls: Map<string, HTMLButtonElement>;
  projVec: THREE.Vector3;
}): void {
  const {
    camera,
    viewportWidth: w,
    viewportHeight: h,
    inspectorOpen,
    nodeObjects: currentNodes,
    edgeObjects: currentEdges,
    regionClusters,
    selectedRegionScope,
    regionSpotlight: spotlight,
    focusState,
    labelEls,
    regionLabelEls,
    projVec,
  } = params;

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
  } = focusState;

  const hasEdgeOrCascadeFocus = selEdgeUuid !== null || cascSet.size > 0;
  const activeFocusUuid = hovUuid ?? selUuid;
  const activeNeighbors = activeFocusUuid ? nbrMap.get(activeFocusUuid) ?? new Set<string>() : null;
  const hasSearchFilter = matchSet.size > 0;

  const labelCandidates: ScreenLabelCandidate[] = [];
  const leftLabelEdge = 82;
  const topLabelEdge = 92;
  const rightLabelEdge = inspectorOpen && w >= 1024 ? w - 400 : w - 60;

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
    haloMat.opacity = 0;

    const shouldShowLabel = isSelected || isHovered || (hasSearchFilter && isSearchHit);
    if (shouldShowLabel) {
      projVec.copy(item.worldPos).project(camera);
      if (projVec.z < 1 && opacity > 0.3) {
        const sx = (projVec.x * 0.5 + 0.5) * w;
        const sy = (-projVec.y * 0.5 + 0.5) * h - 18;
        if (sx > leftLabelEdge && sx < rightLabelEdge && sy > topLabelEdge && sy < h - 42) {
          const depthRatio = (camera.position.distanceTo(item.worldPos) - minCamDist) / distSpan;
          const cleanTitle = humanizeNodeText(item.node.properties.name);
          const displayTitle = cleanTitle.length > 32 ? `${cleanTitle.slice(0, 30)}…` : cleanTitle;
          const nodeRole = rolesMap[uuid];
          const microCue = microMap[uuid];
          const isSupersededNode =
            item.node.properties.status === "Superseded" || Boolean(item.node.properties.superseded_by);
          const microBadge = resolveMicroscopeNodeBadge(microCue, lightThemeNow);

          let extraWidthPx = 0;
          if (nodeRole === "upstream" || nodeRole === "downstream") extraWidthPx += 44;
          if (isSupersededNode) extraWidthPx += 62;
          if (microBadge) extraWidthPx += 50;
          if (item.node.properties.theil_sen_slope !== undefined) extraWidthPx += 14;

          let priority = (1 - depthRatio) * 120;
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
  }

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

  for (const cluster of regionClusters) {
    const el = regionLabelEls.get(cluster.id);
    if (!el) continue;
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
  }

  const placed = selectNonOverlappingLabels(labelCandidates, 14, 18, 12);
  const placedById = new Map(placed.map((p) => [p.uuid, p]));

  for (const [uuid, el] of labelEls.entries()) {
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
}
