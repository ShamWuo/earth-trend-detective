"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  computeLayout2D,
  computeLayout3D,
  createEtgHaloCanvas,
  createEtgNodeCanvas,
  ETG_LABEL_PALETTE,
  formatEdgeRelationLabel,
  MAX_ZOOM,
  MIN_ZOOM,
  type Point2D,
  resolveDetailTier,
  resolveEtgEdgeColor,
  resolveEtgNodeColor,
  type ScreenLabelCandidate,
  selectNonOverlappingLabels,
  wheelZoomStep,
} from "@/lib/graph/graphVisuals";
import type { ETGEdge, ETGNode } from "@/types/etg";

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
  inspectorOpen?: boolean;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onClearSelection?: () => void;
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

function filterGraphData(
  nodes: ETGNode[],
  edges: ETGEdge[],
  onlyOpposite: boolean,
  showSuperseded: boolean
): { visibleNodes: ETGNode[]; visibleEdges: ETGEdge[] } {
  const filteredNodes = showSuperseded
    ? nodes
    : nodes.filter((n) => n.properties.status !== "Superseded");
  const nodeIds = new Set(filteredNodes.map((n) => n.uuid));

  const validEdges = edges.filter((e) => {
    if (!nodeIds.has(e.source_uuid) || !nodeIds.has(e.target_uuid)) return false;
    if (onlyOpposite && e.type !== "drives_opposite") return false;
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
  const oppositeNodes = filteredNodes.filter((n) => connectedIds.has(n.uuid));
  return {
    visibleNodes: oppositeNodes.length > 0 ? oppositeNodes : filteredNodes,
    visibleEdges: validEdges,
  };
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
  inspectorOpen = false,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: EarthTrendGraphViewProps) {
  const isLightTheme = useIsLightTheme();
  const { visibleNodes, visibleEdges } = useMemo(
    () => filterGraphData(nodes, edges, onlyOpposite, showSuperseded),
    [nodes, edges, onlyOpposite, showSuperseded]
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();

  if (visibleNodes.length === 0) {
    return (
      <div className="etg-graph-void flex h-full w-full items-center justify-center">
        <div className="etg-hud-pill max-w-sm rounded-2xl px-6 py-5 text-center">
          <p className="text-sm font-medium text-text-primary">No Earth signals match this filter</p>
          <p className="mt-1 text-xs text-text-muted">
            Widen the timeline scrubber, switch datasets, or clear the search query.
          </p>
        </div>
      </div>
    );
  }

  if (renderMode === "2d") {
    return (
      <GraphCanvas2D
        nodes={visibleNodes}
        edges={visibleEdges}
        selectedNodeUuid={selectedNodeUuid}
        selectedEdgeUuid={selectedEdgeUuid}
        cascadeEdgeUuids={cascadeEdgeUuids}
        searchQuery={normalizedQuery}
        isLightTheme={isLightTheme}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onClearSelection={onClearSelection}
      />
    );
  }

  return (
    <GraphCanvas3D
      nodes={visibleNodes}
      edges={visibleEdges}
      selectedNodeUuid={selectedNodeUuid}
      selectedEdgeUuid={selectedEdgeUuid}
      cascadeEdgeUuids={cascadeEdgeUuids}
      searchQuery={normalizedQuery}
      isLightTheme={isLightTheme}
      inspectorOpen={inspectorOpen}
      onSelectNode={onSelectNode}
      onSelectEdge={onSelectEdge}
      onClearSelection={onClearSelection}
    />
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
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onClearSelection?: () => void;
}

const DEFAULT_SPHERICAL_3D = { theta: 0.52, phi: 1.24, radius: 225 };

function GraphCanvas3D({
  nodes,
  edges,
  selectedNodeUuid,
  selectedEdgeUuid,
  cascadeEdgeUuids,
  searchQuery,
  isLightTheme,
  inspectorOpen = false,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: GraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const labelElsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const hoveredUuidRef = useRef<string | null>(null);
  const hoveredEdgeUuidRef = useRef<string | null>(null);
  const [hoveredUuid, setHoveredUuid] = useState<string | null>(null);
  const [hoveredEdgeUuid, setHoveredEdgeUuid] = useState<string | null>(null);
  const [isOrbiting, setIsOrbiting] = useState(true);
  const isOrbitingRef = useRef(true);
  isOrbitingRef.current = isOrbiting;
  const inspectorOpenRef = useRef(inspectorOpen);
  inspectorOpenRef.current = inspectorOpen;

  const targetCameraRef = useRef({ ...DEFAULT_SPHERICAL_3D });
  const currentCameraRef = useRef({ ...DEFAULT_SPHERICAL_3D });

  const layoutPositions = useMemo(() => computeLayout3D(nodes, edges), [nodes, edges]);

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
      const text = `${n.properties.name} ${n.label} ${n.properties.region ?? ""} ${n.properties.dataset ?? ""}`.toLowerCase();
      if (text.includes(searchQuery)) hits.add(n.uuid);
    }
    return hits;
  }, [nodes, searchQuery]);

  const cascadeEdgeSet = useMemo(() => new Set(cascadeEdgeUuids), [cascadeEdgeUuids]);

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
  };

  const onSelectEdgeRef = useRef(onSelectEdge);
  onSelectEdgeRef.current = onSelectEdge;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const width = host.clientWidth || 960;
    const height = host.clientHeight || 640;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(44, width / height, 1, 2000);

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
      color: isLightTheme ? 0x64748b : 0x94a3b8,
      size: 1.4,
      transparent: true,
      opacity: isLightTheme ? 0.2 : 0.24,
      depthWrite: false,
    });
    const dustPoints = new THREE.Points(starGeo, starMat);
    scene.add(dustPoints);

    // Cached canvas textures per color & halo
    const nodeTextureCache = new Map<string, THREE.CanvasTexture>();
    const haloTextureCache = new Map<string, THREE.CanvasTexture>();

    const getNodeTexture = (hex: string) => {
      const key = `${hex}_${isLightTheme ? "L" : "D"}`;
      let tex = nodeTextureCache.get(key);
      if (!tex) {
        tex = new THREE.CanvasTexture(createEtgNodeCanvas(hex, isLightTheme));
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

    const graphGroup = new THREE.Group();
    scene.add(graphGroup);

    // Build edge line segments with per-edge material for clean highlight/depth attenuation
    const edgeObjects: Array<{
      edge: ETGEdge;
      line: THREE.Line;
      material: THREE.LineBasicMaterial;
      baseColorHex: string;
      midPoint: THREE.Vector3;
    }> = [];
    const edgePickLines: THREE.Line[] = [];

    for (const edge of edges) {
      const p1 = layoutPositions.get(edge.source_uuid);
      const p2 = layoutPositions.get(edge.target_uuid);
      if (!p1 || !p2) continue;

      const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
      const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);
      const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
      // Slight gentle arc outwards for multi-edge separation without visual clutter
      const arcBias = edge.type === "drives_opposite" ? 1.12 : 1.04;
      mid.multiplyScalar(arcBias);

      const curve = new THREE.QuadraticBezierCurve3(v1, mid, v2);
      const pts = curve.getPoints(16);
      const geometry = new THREE.BufferGeometry().setFromPoints(pts);

      const baseColor = resolveEtgEdgeColor(edge.type);
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(baseColor),
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      });

      const line = new THREE.Line(geometry, material);
      line.userData = { edge };
      graphGroup.add(line);
      edgePickLines.push(line);
      edgeObjects.push({ edge, line, material, baseColorHex: baseColor, midPoint: mid });
    }

    // Build sprite + halo pairs for each node
    const nodeObjects: Array<{
      node: ETGNode;
      sprite: THREE.Sprite;
      halo: THREE.Sprite;
      baseScale: number;
      worldPos: THREE.Vector3;
    }> = [];

    const pickSprites: THREE.Sprite[] = [];

    for (const node of nodes) {
      const pos = layoutPositions.get(node.uuid);
      if (!pos) continue;
      const color = resolveEtgNodeColor(node);
      const baseScale =
        node.label === "Insight" ? 15 : node.label === "Concept" ? 13 : node.label === "Rule" ? 11.5 : 10;

      const mat = new THREE.SpriteMaterial({
        map: getNodeTexture(color),
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(pos.x, pos.y, pos.z);
      sprite.scale.set(baseScale, baseScale, 1);
      sprite.userData = { uuid: node.uuid };
      graphGroup.add(sprite);
      pickSprites.push(sprite);

      const haloMat = new THREE.SpriteMaterial({
        map: getHaloTexture(color),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const halo = new THREE.Sprite(haloMat);
      halo.position.set(pos.x, pos.y, pos.z);
      halo.scale.set(baseScale * 2.15, baseScale * 2.15, 1);
      graphGroup.add(halo);

      nodeObjects.push({
        node,
        sprite,
        halo,
        baseScale,
        worldPos: new THREE.Vector3(pos.x, pos.y, pos.z),
      });
    }

    // Interaction: pointer orbit, click node or edge pick, hover cursor
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 3.6 };
    const pointerNdc = new THREE.Vector2();
    let isDragging = false;
    let pointerDownPos = { x: 0, y: 0 };
    let prevPointerPos = { x: 0, y: 0 };
    let draggedDistance = 0;

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
      const nodeHits = raycaster.intersectObjects(pickSprites, false);
      if (nodeHits.length > 0) {
        return {
          nodeUuid: (nodeHits[0].object.userData?.uuid as string | undefined) ?? null,
          edge: null,
        };
      }
      const edgeHits = raycaster.intersectObjects(edgePickLines, false);
      if (edgeHits.length > 0) {
        return {
          nodeUuid: null,
          edge: (edgeHits[0].object.userData?.edge as ETGEdge | undefined) ?? null,
        };
      }
      return { nodeUuid: null, edge: null };
    };

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      draggedDistance = 0;
      pointerDownPos = { x: e.clientX, y: e.clientY };
      prevPointerPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isDragging) {
        const dx = e.clientX - prevPointerPos.x;
        const dy = e.clientY - prevPointerPos.y;
        draggedDistance += Math.hypot(dx, dy);
        prevPointerPos = { x: e.clientX, y: e.clientY };

        targetCameraRef.current.theta -= dx * 0.006;
        targetCameraRef.current.phi = Math.max(
          0.22,
          Math.min(Math.PI - 0.22, targetCameraRef.current.phi - dy * 0.006)
        );
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
      if (!isDragging) return;
      isDragging = false;
      const totalMove = Math.hypot(
        e.clientX - pointerDownPos.x,
        e.clientY - pointerDownPos.y
      );
      if (draggedDistance < 6 && totalMove < 6) {
        const { nodeUuid: hitUuid, edge: hitEdge } = pickTargetAt(e.clientX, e.clientY);
        if (hitUuid) {
          const found = focusStateRef.current.nodeById.get(hitUuid);
          if (found) onSelectNode(found);
        } else if (hitEdge && onSelectEdgeRef.current) {
          onSelectEdgeRef.current(hitEdge);
        } else {
          onClearSelection?.();
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      targetCameraRef.current.radius = Math.max(
        90,
        Math.min(500, targetCameraRef.current.radius + e.deltaY * 0.24)
      );
    };

    renderer.domElement.style.cursor = "grab";
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const resizeObserver = new ResizeObserver(() => {
      const w = host.clientWidth || 960;
      const h = host.clientHeight || 640;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(host);

    // Animation loop
    let rafId = 0;
    let currentViewOffsetX = 0;
    const projVec = new THREE.Vector3();

    const animate = () => {
      rafId = requestAnimationFrame(animate);

      if (isOrbitingRef.current && !isDragging) {
        targetCameraRef.current.theta += 0.00095;
      }

      const cur = currentCameraRef.current;
      const tgt = targetCameraRef.current;
      cur.theta += (tgt.theta - cur.theta) * 0.09;
      cur.phi += (tgt.phi - cur.phi) * 0.09;
      cur.radius += (tgt.radius - cur.radius) * 0.09;

      const w = renderer.domElement.clientWidth || 960;
      const h = renderer.domElement.clientHeight || 640;

      const targetOffsetX =
        inspectorOpenRef.current && w >= 1024
          ? Math.round(Math.min(368, w * 0.30) * 0.34)
          : 0;
      currentViewOffsetX += (targetOffsetX - currentViewOffsetX) * 0.1;
      if (Math.abs(currentViewOffsetX) > 0.5) {
        camera.setViewOffset(w, h, Math.round(currentViewOffsetX), 0, w, h);
      } else if (camera.view) {
        camera.clearViewOffset();
      }

      camera.position.set(
        cur.radius * Math.sin(cur.phi) * Math.cos(cur.theta),
        cur.radius * Math.cos(cur.phi),
        cur.radius * Math.sin(cur.phi) * Math.sin(cur.theta)
      );
      camera.lookAt(0, 0, 0);

      const {
        selectedNodeUuid: selUuid,
        selectedEdgeUuid: selEdgeUuid,
        cascadeEdgeSet: cascSet,
        hoveredUuid: hovUuid,
        hoveredEdgeUuid: hovEdgeUuid,
        matchingUuids: matchSet,
        neighborMap: nbrMap,
      } = focusStateRef.current;

      const hasEdgeOrCascadeFocus = selEdgeUuid !== null || cascSet.size > 0;

      const activeFocusUuid = hovUuid ?? selUuid;
      const activeNeighbors = activeFocusUuid ? nbrMap.get(activeFocusUuid) ?? new Set<string>() : null;
      const hasSearchFilter = matchSet.size > 0;

      // Update nodes + gather screen-space label candidates
      const labelCandidates: ScreenLabelCandidate[] = [];
      const rightLabelEdge =
        inspectorOpenRef.current && w >= 1024 ? w - 400 : w - 60;

      let minCamDist = Infinity;
      let maxCamDist = 1;
      for (const item of nodeObjects) {
        const d = camera.position.distanceTo(item.worldPos);
        if (d < minCamDist) minCamDist = d;
        if (d > maxCamDist) maxCamDist = d;
      }
      const distSpan = Math.max(1, maxCamDist - minCamDist);

      for (const item of nodeObjects) {
        const uuid = item.node.uuid;
        const isSelected = uuid === selUuid;
        const isHovered = uuid === hovUuid;
        const isNeighbor = activeNeighbors ? activeNeighbors.has(uuid) : false;
        const isSearchHit = matchSet.has(uuid);

        let opacity = 1;
        if (hasSearchFilter) {
          opacity = isSearchHit ? 1 : 0.18;
        } else if (activeFocusUuid) {
          opacity = isSelected || isHovered || isNeighbor ? 1 : 0.24;
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
        haloMat.opacity = isSelected || isHovered ? 0.92 : isSearchHit ? 0.65 : isNeighbor ? 0.35 : 0;

        // Project 3D position + sprite radius upward into screen space
        projVec.copy(item.worldPos).project(camera);
        if (projVec.z < 1 && opacity > 0.3) {
          const sx = (projVec.x * 0.5 + 0.5) * w;
          const sy = (-projVec.y * 0.5 + 0.5) * h - 18;
          if (sx > 60 && sx < rightLabelEdge && sy > 76 && sy < h - 42) {
            const depthRatio = (camera.position.distanceTo(item.worldPos) - minCamDist) / distSpan;
            let priority = (1 - depthRatio) * 120;
            if (item.node.label === "Insight") priority += 120;
            else if (item.node.label === "Concept") priority += 80;
            else if (item.node.label === "Rule") priority += 40;
            if (isNeighbor) priority += 260;
            if (isSearchHit) priority += 450;
            if (isHovered) priority += 800;
            if (isSelected) priority += 1000;

            labelCandidates.push({
              uuid,
              title: item.node.properties.name,
              label: item.node.label,
              color: resolveEtgNodeColor(item.node),
              x: sx,
              y: sy,
              priority,
            });
          }
        }
      }

      // 8-tier depth attenuation & neighborhood/edge/cascade emphasis for edges
      for (const eo of edgeObjects) {
        const edgeUuid = eo.edge.properties.uuid;
        const isEdgeSelected = edgeUuid === selEdgeUuid || edgeUuid === hovEdgeUuid;
        const isCascade = cascSet.has(edgeUuid);
        const isConnected =
          activeFocusUuid !== null &&
          (eo.edge.source_uuid === activeFocusUuid || eo.edge.target_uuid === activeFocusUuid);
        const edgeMatchesSearch =
          hasSearchFilter &&
          (matchSet.has(eo.edge.source_uuid) || matchSet.has(eo.edge.target_uuid));

        eo.material.color.set(
          isEdgeSelected ? "#fef08a" : isCascade ? "#fbbf24" : eo.baseColorHex
        );

        if (isEdgeSelected || isCascade) {
          eo.material.opacity = 0.96;
        } else if (activeFocusUuid) {
          eo.material.opacity = isConnected ? 0.88 : 0.07;
        } else if (hasEdgeOrCascadeFocus) {
          eo.material.opacity = 0.08;
        } else if (hasSearchFilter) {
          eo.material.opacity = edgeMatchesSearch ? 0.72 : 0.06;
        } else {
          const d = (camera.position.distanceTo(eo.midPoint) - minCamDist) / distSpan;
          const tier = Math.min(7, Math.max(0, Math.floor(d * 8)));
          const baseOpacity = 0.28 - tier * 0.028;
          const typeBoost =
            eo.edge.type === "drives_opposite" || eo.edge.type === "teleconnects" ? 0.14 : 0;
          eo.material.opacity = Math.min(0.48, Math.max(0.06, baseOpacity + typeBoost));
        }
      }

      // Collision-free screen pill update (no React setState per frame)
      const placed = selectNonOverlappingLabels(labelCandidates, 12, 20, 14);
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
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
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
      starGeo.dispose();
      starMat.dispose();
      renderer.dispose();
    };
  }, [nodes, edges, layoutPositions, isLightTheme, onSelectNode, onClearSelection]);

  const handleRecenter = useCallback(() => {
    targetCameraRef.current = { ...DEFAULT_SPHERICAL_3D };
  }, []);

  const handleZoomIn = useCallback(() => {
    targetCameraRef.current.radius = Math.max(90, targetCameraRef.current.radius - 36);
  }, []);

  const handleZoomOut = useCallback(() => {
    targetCameraRef.current.radius = Math.min(500, targetCameraRef.current.radius + 36);
  }, []);

  return (
    <div className="etg-graph-void relative h-full w-full overflow-hidden select-none">
      <div ref={hostRef} className="h-full w-full" aria-label="3D Earth Trend Knowledge Graph" />

      {/* Projected non-overlapping pill badges */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {nodes.map((node) => {
          const isSelected = node.uuid === selectedNodeUuid;
          const color = resolveEtgNodeColor(node);
          const displayName =
            node.properties.name.length > 26
              ? `${node.properties.name.slice(0, 24)}…`
              : node.properties.name;

          return (
            <button
              key={node.uuid}
              type="button"
              ref={(el) => {
                if (el) labelElsRef.current.set(node.uuid, el);
                else labelElsRef.current.delete(node.uuid);
              }}
              onClick={() => onSelectNode(node)}
              style={{
                opacity: 0,
                pointerEvents: "none",
                top: 0,
                left: 0,
                borderColor: isSelected ? color : undefined,
              }}
              className={`absolute inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap shadow-md transition-opacity duration-150 cursor-pointer ${
                isSelected
                  ? "bg-surface text-text-primary ring-1 ring-accent/40"
                  : isLightTheme
                    ? "border-border bg-white/92 text-zinc-900 hover:border-zinc-400"
                    : "border-white/12 bg-[#12151e]/92 text-zinc-100 hover:border-white/30"
              }`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span>{displayName}</span>
            </button>
          );
        })}
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
          <div className="etg-hud-pill pointer-events-none absolute top-20 left-1/2 z-20 -translate-x-1/2 rounded-xl px-3.5 py-2 text-xs shadow-lg">
            <div className="flex items-center gap-2 font-semibold text-amber-300">
              <span>{formatEdgeRelationLabel(activeEdge.type)}</span>
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
      <div className="absolute left-6 top-1/2 z-10 -translate-y-1/2">
        <GraphCameraDock
          orientation="vertical"
          showOrbitControls
          isOrbiting={isOrbiting}
          onToggleOrbit={() => setIsOrbiting((prev) => !prev)}
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
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: GraphCanvasProps) {
  const cascadeEdgeSet = useMemo(() => new Set(cascadeEdgeUuids), [cascadeEdgeUuids]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1200, height: 800 });

  const { positions: basePositions, bounds } = useMemo(
    () => computeLayout2D(nodes, edges),
    [nodes, edges]
  );

  // User-dragged node overrides (cleared cleanly when node set changes)
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

  // Camera state (panX/panY in world units centered at 0, zoom multiplier)
  const [camera, setCamera] = useState({ panX: 0, panY: 0, zoom: 0.94 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const [hoveredNodeUuid, setHoveredNodeUuid] = useState<string | null>(null);
  const [hoveredEdgeUuid, setHoveredEdgeUuid] = useState<string | null>(null);

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
      const text = `${n.properties.name} ${n.label} ${n.properties.region ?? ""} ${n.properties.dataset ?? ""}`.toLowerCase();
      if (text.includes(searchQuery)) hits.add(n.uuid);
    }
    return hits;
  }, [nodes, searchQuery]);

  // Fit graph nicely into container on mount/bounds change
  const recenterToFit = useCallback(() => {
    const { width, height } = viewportSize;
    const graphW = Math.max(320, bounds.maxX - bounds.minX);
    const graphH = Math.max(240, bounds.maxY - bounds.minY);
    const fitZoom = Math.max(
      MIN_ZOOM,
      Math.min(1.08, Math.min((width * 0.82) / graphW, (height * 0.78) / graphH))
    );
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    setCamera({ panX: -cx * fitZoom, panY: -cy * fitZoom, zoom: fitZoom });
  }, [bounds, viewportSize]);

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

  // Recenter once initial viewport size & layout are known
  const hasAutoFittedRef = useRef(false);
  useEffect(() => {
    if (!hasAutoFittedRef.current && viewportSize.width > 100) {
      hasAutoFittedRef.current = true;
      recenterToFit();
    }
  }, [viewportSize.width, recenterToFit]);

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

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
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

  const zoomAtCenter = useCallback((factor: number) => {
    setCamera((prev) => {
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor));
      const scale = nextZoom / prev.zoom;
      return {
        zoom: nextZoom,
        panX: prev.panX * scale,
        panY: prev.panY * scale,
      };
    });
  }, []);

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
  const cardSubtle = isLightTheme ? "#52525b" : "#a1a1aa";

  return (
    <div className="etg-graph-void relative h-full w-full overflow-hidden select-none">
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={handleSvgPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
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
        </defs>

        {/* Dot-matrix canvas background */}
        <rect width="100%" height="100%" fill="url(#etg-dot-grid)" pointerEvents="none" />

        {/* World transform group */}
        <g
          transform={`translate(${viewportSize.width / 2 + camera.panX}, ${
            viewportSize.height / 2 + camera.panY
          }) scale(${camera.zoom})`}
        >
          {/* Curved Bezier edges */}
          {edges.map((edge, idx) => {
            const p1 = positions.get(edge.source_uuid);
            const p2 = positions.get(edge.target_uuid);
            if (!p1 || !p2) return null;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy) || 1;
            const nx = -dy / dist;
            const ny = dx / dist;
            const bend = ((idx % 2 === 0 ? 1 : -1) * Math.min(42, dist * 0.14));
            const cx = (p1.x + p2.x) / 2 + nx * bend;
            const cy = (p1.y + p2.y) / 2 + ny * bend;

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

            let opacity = 0.42;
            let strokeWidth = edge.type === "drives_opposite" ? 1.8 : 1.25;
            if (isEdgeHovered || isEdgeSelected || isCascadeEdge || isConnectedToFocus) {
              opacity = 0.96;
              strokeWidth = isEdgeSelected ? 2.8 : isCascadeEdge ? 2.4 : 2.2;
            } else if (activeFocusUuid || hasSearch) {
              opacity = matchesSearch ? 0.65 : 0.1;
            } else if (hasEdgeOrCascadeFocus) {
              opacity = 0.12;
            }

            const baseStrokeColor = resolveEtgEdgeColor(edge.type);
            const strokeColor = isEdgeSelected
              ? "#fef08a"
              : isCascadeEdge
                ? "#fbbf24"
                : baseStrokeColor;
            const midLabelX = 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x;
            const midLabelY = 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y;
            const showEdgePill =
              isEdgeHovered || isEdgeSelected || isCascadeEdge || isConnectedToFocus;
            const relationLabel = formatEdgeRelationLabel(edge.type);
            const pillLabel =
              edge.properties.correlation_r !== undefined
                ? `${relationLabel} · r=${edge.properties.correlation_r.toFixed(2)}`
                : relationLabel;

            return (
              <g
                key={edge.properties.uuid}
                className="cursor-pointer"
                onPointerEnter={() => setHoveredEdgeUuid(edge.properties.uuid)}
                onPointerLeave={() => setHoveredEdgeUuid(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEdge?.(edge);
                }}
              >
                {/* Invisible wider hit corridor for easy edge hovering and clicking */}
                <path
                  d={`M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={`M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  strokeDasharray={edge.type === "supersedes" ? "5 4" : undefined}
                  strokeOpacity={opacity}
                  vectorEffect="non-scaling-stroke"
                />

                {showEdgePill && (
                  <g transform={`translate(${midLabelX}, ${midLabelY})`} pointerEvents="none">
                    <rect
                      x={-(pillLabel.length * 3.2 + 8)}
                      y={-10}
                      width={pillLabel.length * 6.4 + 16}
                      height={20}
                      rx={10}
                      fill={isLightTheme ? "#ffffff" : "#11141d"}
                      stroke={strokeColor}
                      strokeWidth={1}
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={9}
                      fontWeight={600}
                      letterSpacing="0.06em"
                      fill={strokeColor}
                    >
                      {pillLabel}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Nodes (Dots vs 196×42 Single-Row Cards) */}
          {nodes.map((node) => {
            const p = positions.get(node.uuid);
            if (!p) return null;

            const color = resolveEtgNodeColor(node);
            const isSelected = node.uuid === selectedNodeUuid;
            const isHovered = node.uuid === hoveredNodeUuid;
            const isNeighbor = activeNeighbors ? activeNeighbors.has(node.uuid) : false;
            const isSearchHit = matchingUuids.has(node.uuid);

            let nodeOpacity = 1;
            if (hasSearch) {
              nodeOpacity = isSearchHit ? 1 : 0.22;
            } else if (activeFocusUuid) {
              nodeOpacity = isSelected || isHovered || isNeighbor ? 1 : 0.28;
            }

            if (detailTier === "dots") {
              const r =
                node.label === "Insight" ? 15 : node.label === "Concept" ? 13 : node.label === "Rule" ? 11.5 : 10;
              return (
                <g
                  key={node.uuid}
                  transform={`translate(${p.x}, ${p.y})`}
                  opacity={nodeOpacity}
                  className="cursor-pointer"
                  onPointerDown={(e) => handleNodePointerDown(e, node)}
                  onPointerEnter={() => setHoveredNodeUuid(node.uuid)}
                  onPointerLeave={() => setHoveredNodeUuid(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!interactionRef.current.moved) onSelectNode(node);
                  }}
                >
                  {(isSelected || isHovered) && (
                    <circle r={r + 6} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.65} />
                  )}
                  <circle r={r} fill={color} stroke={isLightTheme ? "#ffffff" : "#0b0c10"} strokeWidth={2} />
                  <text
                    y={r + 16}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={500}
                    fill={cardTitle}
                  >
                    {node.properties.name.length > 22
                      ? `${node.properties.name.slice(0, 20)}…`
                      : node.properties.name}
                  </text>
                </g>
              );
            }

            const titleText =
              node.properties.name.length > 17
                ? `${node.properties.name.slice(0, 15)}…`
                : node.properties.name;
            const isStatSignificant =
              typeof node.properties.p_value === "number" && node.properties.p_value < 0.05;
            const clipId = `etg-card-clip-${node.uuid}`;
            const titleClipWidth =
              detailTier === "full" ? CARD_WIDTH - 96 : CARD_WIDTH - 86;

            return (
              <g
                key={node.uuid}
                transform={`translate(${p.x}, ${p.y})`}
                opacity={nodeOpacity}
                className="cursor-pointer"
                onPointerDown={(e) => handleNodePointerDown(e, node)}
                onPointerEnter={() => setHoveredNodeUuid(node.uuid)}
                onPointerLeave={() => setHoveredNodeUuid(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!interactionRef.current.moved) onSelectNode(node);
                }}
              >
                <defs>
                  <clipPath id={clipId}>
                    <rect
                      x={-CARD_WIDTH / 2 + 24}
                      y={-CARD_HEIGHT / 2}
                      width={titleClipWidth}
                      height={CARD_HEIGHT}
                    />
                  </clipPath>
                </defs>

                {/* Glow ring for active selection/hover */}
                {(isSelected || isHovered) && (
                  <rect
                    x={-CARD_WIDTH / 2 - 4}
                    y={-CARD_HEIGHT / 2 - 4}
                    width={CARD_WIDTH + 8}
                    height={CARD_HEIGHT + 8}
                    rx={13}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.5}
                    strokeWidth={2}
                  />
                )}

                {/* Single-row rounded card */}
                <rect
                  x={-CARD_WIDTH / 2}
                  y={-CARD_HEIGHT / 2}
                  width={CARD_WIDTH}
                  height={CARD_HEIGHT}
                  rx={10}
                  fill={cardBg}
                  stroke={isSelected || isHovered ? color : cardBorder}
                  strokeWidth={isSelected ? 1.75 : 1}
                />

                {/* Accent dot */}
                <circle cx={-CARD_WIDTH / 2 + 15} cy={0} r={4.5} fill={color} />

                {/* Single-line node title clipped cleanly before the right badge */}
                <text
                  x={-CARD_WIDTH / 2 + 27}
                  y={0}
                  dominantBaseline="central"
                  fontSize={11.5}
                  fontWeight={500}
                  fill={cardTitle}
                  clipPath={`url(#${clipId})`}
                >
                  {titleText}
                </text>

                {/* Right-side compact ontology badge (only in full tier) */}
                {detailTier === "full" && (
                  <g transform={`translate(${CARD_WIDTH / 2 - 12}, 0)`}>
                    {isStatSignificant && (
                      <circle cx={-50} cy={0} r={2.8} fill="#34d399" />
                    )}
                    <rect
                      x={-42}
                      y={-9}
                      width={42}
                      height={18}
                      rx={9}
                      fill={
                        isLightTheme
                          ? ETG_LABEL_PALETTE[node.label].pillBgLight
                          : ETG_LABEL_PALETTE[node.label].pillBgDark
                      }
                    />
                    <text
                      x={-21}
                      y={0}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={9}
                      fontWeight={600}
                      fill={color}
                    >
                      {node.label}
                    </text>
                  </g>
                )}

                {detailTier === "compact" && (
                  <text
                    x={CARD_WIDTH / 2 - 12}
                    y={0}
                    textAnchor="end"
                    dominantBaseline="central"
                    fontSize={9.5}
                    fill={cardSubtle}
                  >
                    {node.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Bottom-left Minimap + Camera Dock */}
      <div className="absolute bottom-4 left-16 z-10 flex flex-col items-start gap-2.5">
        <div
          className="etg-hud-pill overflow-hidden rounded-xl p-1"
          aria-label="2D graph overview minimap"
        >
          <svg
            width={mapW}
            height={mapH}
            className="block cursor-crosshair rounded-lg"
            onClick={(e) => {
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
          onRecenter={recenterToFit}
          onZoomIn={() => zoomAtCenter(1.25)}
          onZoomOut={() => zoomAtCenter(0.8)}
        />
      </div>
    </div>
  );
}
