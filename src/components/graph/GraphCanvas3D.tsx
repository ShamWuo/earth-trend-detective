"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import {
  computeCameraPanDelta,
  computeGlideEase,
  computeInitialContinuousLookAt,
  computeOrbitCameraPosition,
  computeOrbitSphericalCoordinates,
  computeTargetOrbitDistance,
} from "@/lib/graph/graphCamera";
import {
  computeGraphBoundingSphere3D,
  computeLayout3D,
  computeRegionClusters3D,
  formatEdgeRelationLabel,
  type RegionCluster3D,
  resolveEtgNodeColor,
} from "@/lib/graph/graphVisuals";
import { humanizeNodeText } from "@/lib/plainLanguage";
import type { ETGEdge, ETGNode } from "@/types/etg";
import {
  type CameraGlideState,
  createDustLayer3D,
  DEFAULT_ORBIT_3D,
  type Graph3DFocusSnapshot,
  populateGraphGroup3D,
  type SceneEdgeObject3D,
  type SceneNodeObject3D,
  updateGraph3DFrameVisibilityAndLabels,
} from "@/components/graph/graphCanvas3DScene";
import {
  buildDipoleNodeSet,
  buildNeighborMap,
  buildSearchMatchSet,
  dispatchNodeSelectOrQuickConnect,
  formatTrendStat,
  type GraphCanvasProps,
  type RegionSpotlightState,
  resolveMicroscopeNodeBadge,
} from "@/components/graph/graphViewShared";

/**
 * 3D WebGL Sprite + Depth-Attenuated Earth Trend Knowledge Graph canvas with
 * continuous camera glide, pinch/WASD free-flight, and non-overlapping DOM pills.
 */
export function GraphCanvas3D({
  nodes,
  edges,
  selectedNodeUuid,
  selectedEdgeUuid,
  cascadeEdgeUuids,
  searchQuery,
  isLightTheme,
  inspectorOpen = false,
  inspectorWide = false,
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
  const [isOrbiting, setIsOrbiting] = useState(false);
  const isOrbitingRef = useRef(false);
  isOrbitingRef.current = isOrbiting;
  const inspectorOpenRef = useRef(inspectorOpen);
  inspectorOpenRef.current = inspectorOpen;
  const inspectorWideRef = useRef(inspectorWide);
  inspectorWideRef.current = inspectorWide;

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
  const freeFlightRef = useRef(true);
  const cameraGlideRef = useRef<CameraGlideState>({
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
    const radiusScale = nodes.length <= 36 ? 1.95 : 2.35;
    return {
      target: sphere.center,
      radius: Math.max(150, Math.min(760, sphere.radius * radiusScale)),
    };
  }, [layoutPositions, nodes.length]);
  const overviewFramingRef = useRef(overviewFraming);
  overviewFramingRef.current = overviewFraming;

  const hasFramedInitial3DRef = useRef(false);
  const lastFramedNodeCountRef = useRef(0);
  useEffect(() => {
    if (layoutPositions.size === 0) return;
    const countShiftedSignificantly =
      Math.abs(layoutPositions.size - lastFramedNodeCountRef.current) >= 4;
    if (hasFramedInitial3DRef.current && (selectedNodeUuid || !countShiftedSignificantly)) {
      return;
    }
    hasFramedInitial3DRef.current = true;
    lastFramedNodeCountRef.current = layoutPositions.size;
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
    const initCamPos = computeOrbitCameraPosition(
      target,
      radius,
      rotationRef.current.pitch,
      rotationRef.current.yaw
    );
    cameraPositionRef.current.set(initCamPos.x, initCamPos.y, initCamPos.z);
  }, [layoutPositions, overviewFraming, selectedNodeUuid]);

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

  // Smoothly glide camera to focus on selected node with zero-snap LookAt transition
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

  const neighborMap = useMemo(() => buildNeighborMap(nodes, edges), [nodes, edges]);
  const matchingUuids = useMemo(() => buildSearchMatchSet(nodes, searchQuery), [nodes, searchQuery]);
  const cascadeEdgeSet = useMemo(() => new Set(cascadeEdgeUuids), [cascadeEdgeUuids]);
  const dipoleNodeUuids = useMemo(() => buildDipoleNodeSet(edges), [edges]);

  // Refreshed state refs so Three.js RAF never uses stale closures
  const focusStateRef = useRef<Graph3DFocusSnapshot>({
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
    const camera = new THREE.PerspectiveCamera(44, width / height, 1, 100000);
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

    const { starGeo, starMat, dustPoints } = createDustLayer3D(focusStateRef.current.isLightTheme);
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
    raycaster.params.Line = { threshold: 1.4 };
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
          if (freeFlightRef.current) {
            const forward = new THREE.Vector3();
            camera.getWorldDirection(forward);
            cameraPositionRef.current.addScaledVector(forward, -zoomDelta);
          } else {
            orbitRadiusRef.current.target = Math.max(
              42,
              orbitRadiusRef.current.target + zoomDelta
            );
            if (cameraGlideRef.current.active) {
              cameraGlideRef.current.targetRadius = orbitRadiusRef.current.target;
            }
          }
        }
        if (prevPinchMid) {
          cameraGlideRef.current.active = false;
          const delta = computeCameraPanDelta(
            mid.x - prevPinchMid.x,
            mid.y - prevPinchMid.y,
            rotationRef.current.targetPitch,
            rotationRef.current.targetYaw,
            orbitRadiusRef.current.val
          );
          if (freeFlightRef.current) {
            cameraPositionRef.current.x += delta.x;
            cameraPositionRef.current.y += delta.y;
            cameraPositionRef.current.z += delta.z;
          } else {
            panTargetRef.current.targetX += delta.x;
            panTargetRef.current.targetY += delta.y;
            panTargetRef.current.targetZ += delta.z;
          }
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
          const delta = computeCameraPanDelta(
            dx,
            dy,
            rotationRef.current.targetPitch,
            rotationRef.current.targetYaw,
            orbitRadiusRef.current.val
          );
          if (freeFlightRef.current) {
            cameraPositionRef.current.x += delta.x;
            cameraPositionRef.current.y += delta.y;
            cameraPositionRef.current.z += delta.z;
          } else {
            panTargetRef.current.targetX += delta.x;
            panTargetRef.current.targetY += delta.y;
            panTargetRef.current.targetZ += delta.z;
          }
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
      if (draggedDistance < 10 && totalMove < 10 && e.button === 0) {
        const { nodeUuid: hitUuid, edge: hitEdge } = pickTargetAt(e.clientX, e.clientY);
        if (hitUuid) {
          const found = focusStateRef.current.nodeById.get(hitUuid);
          if (found) {
            dispatchNodeSelectOrQuickConnect({
              clickedNode: found,
              connectMode: focusStateRef.current.connectMode,
              shiftKey: e.shiftKey,
              connectSourceUuid: focusStateRef.current.connectSourceUuid,
              selectedNodeUuid: focusStateRef.current.selectedNodeUuid,
              lookupNode: (uuid) => focusStateRef.current.nodeById.get(uuid),
              onStartQuickConnect: onStartQuickConnectRef.current,
              onSelectNode: onSelectNodeRef.current,
            });
          }
        } else if (hitEdge && onSelectEdgeRef.current) {
          onSelectEdgeRef.current(hitEdge);
        } else {
          hoveredUuidRef.current = null;
          hoveredEdgeUuidRef.current = null;
          setHoveredUuid(null);
          setHoveredEdgeUuid(null);
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
        orbitRadiusRef.current.target + e.deltaY * 0.24
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

    // Delta-time normalized animation loop
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

      dustPoints.rotation.y += delta * 0.012;
      dustPoints.rotation.x += delta * 0.006;

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

      if (isOrbitingRef.current && !isDragging) {
        rotationRef.current.targetYaw += delta * 0.065;
      }

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
          ? Math.round(
              Math.min(inspectorWideRef.current ? 556 : 468, w * 0.4) * 0.36
            )
          : 0;
      currentViewOffsetX += (targetOffsetX - currentViewOffsetX) * 0.12;
      if (Math.abs(currentViewOffsetX) > 0.5) {
        camera.setViewOffset(w, h, Math.round(currentViewOffsetX), 0, w, h);
      } else if (camera.view) {
        camera.clearViewOffset();
      }

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

      updateGraph3DFrameVisibilityAndLabels({
        camera,
        viewportWidth: w,
        viewportHeight: h,
        inspectorOpen: inspectorOpenRef.current,
        inspectorWide: inspectorWideRef.current,
        nodeObjects: nodeObjectsRef.current,
        edgeObjects: edgeObjectsRef.current,
        regionClusters: regionClustersRef.current,
        selectedRegionScope: selectedRegionScopeRef.current,
        regionSpotlight: regionSpotlightRef.current,
        focusState: focusStateRef.current,
        labelEls: labelElsRef.current,
        regionLabelEls: regionLabelElsRef.current,
        projVec,
      });

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

    const populated = populateGraphGroup3D({
      graphGroup,
      nodes,
      edges,
      candidateLinks,
      layoutPositions,
      neighborMap,
      isLightTheme,
    });

    nodeObjectsRef.current = populated.nodeObjects;
    edgeObjectsRef.current = populated.edgeObjects;
    pickSpritesRef.current = populated.pickSprites;
    edgePickLinesRef.current = populated.edgePickLines;

    return () => {
      nodeObjectsRef.current = [];
      edgeObjectsRef.current = [];
      pickSpritesRef.current = [];
      edgePickLinesRef.current = [];
      populated.cleanup();
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
    rotationRef.current.targetYaw += (35 * Math.PI) / 180;
  }, []);

  const handleZoomIn = useCallback(() => {
    if (freeFlightRef.current && cameraRef.current) {
      const forward = new THREE.Vector3();
      cameraRef.current.getWorldDirection(forward);
      cameraPositionRef.current.addScaledVector(forward, 36);
      return;
    }
    orbitRadiusRef.current.target = Math.max(42, orbitRadiusRef.current.target - 36);
    if (cameraGlideRef.current.active) {
      cameraGlideRef.current.targetRadius = orbitRadiusRef.current.target;
    }
  }, []);

  const handleZoomOut = useCallback(() => {
    if (freeFlightRef.current && cameraRef.current) {
      const forward = new THREE.Vector3();
      cameraRef.current.getWorldDirection(forward);
      cameraPositionRef.current.addScaledVector(forward, -36);
      return;
    }
    orbitRadiusRef.current.target = Math.max(
      orbitRadiusRef.current.target + 36,
      orbitRadiusRef.current.target * 1.18
    );
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
                  ? "border-amber-400 bg-amber-950 text-amber-200"
                  : "border-border bg-surface-elevated text-text-muted hover:border-amber-400 hover:text-text-primary"
              }`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
              <span className="max-w-[165px] truncate">{cluster.label}</span>
              <span className="shrink-0 ws-numeric opacity-75">· {cluster.count}</span>
            </button>
          );
        })}
        {nodes.map((node) => {
          const isSelected = node.uuid === selectedNodeUuid || node.uuid === connectSourceUuid;
          const isFocusedPreview = isSelected || node.uuid === hoveredUuid;
          const color = resolveEtgNodeColor(node);
          const role = roleByNode[node.uuid];
          const slopeInfo = formatTrendStat(node, isLightTheme);
          const cleanName = humanizeNodeText(node.properties.name);
          const displayName =
            cleanName.length > 64 ? `${cleanName.slice(0, 62)}…` : cleanName;
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
              onClick={(e) =>
                dispatchNodeSelectOrQuickConnect({
                  clickedNode: node,
                  connectMode,
                  shiftKey: e.shiftKey,
                  connectSourceUuid,
                  selectedNodeUuid,
                  lookupNode: (uuid) => nodeById.get(uuid),
                  onStartQuickConnect,
                  onSelectNode,
                })
              }
              style={{
                opacity: 0,
                pointerEvents: "none",
                top: 0,
                left: 0,
                borderColor: isSelected ? color : undefined,
              }}
              className={`ws-numeric absolute rounded-md border transition-opacity duration-150 cursor-pointer ${
                isFocusedPreview
                  ? "z-10 flex max-w-[min(356px,80vw)] flex-col items-start gap-1 px-3.5 py-2 text-left shadow-xl backdrop-blur-md"
                  : "inline-flex max-w-[280px] items-center gap-2 px-3 py-1 text-xs font-medium whitespace-nowrap shadow-md"
              } ${isSuperseded ? "border-dashed opacity-85" : ""} ${
                isFocusedPreview
                  ? "border-accent-fg bg-surface/95 text-text-primary"
                  : "border-border bg-surface-elevated text-text-primary hover:border-border-strong"
              }`}
            >
              {isFocusedPreview ? (
                <>
                  <span className="flex w-full items-start gap-2">
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    <span
                      className={`text-[12.5px] font-semibold leading-snug text-text-primary whitespace-normal line-clamp-2 ${
                        isSuperseded ? "line-through decoration-1 opacity-80" : ""
                      }`}
                    >
                      {displayName}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 pl-4 text-[11px] text-text-muted">
                    <span className="font-medium text-text-subtle">{node.label}</span>
                    {node.properties.region && (
                      <span className="max-w-[140px] truncate text-text-subtle">
                        · {node.properties.region}
                      </span>
                    )}
                    {node.properties.theil_sen_slope !== undefined && (
                      <span
                        className="font-mono ws-numeric font-semibold"
                        style={{ color: slopeInfo.color }}
                      >
                        {slopeInfo.label}
                      </span>
                    )}
                    {role === "upstream" && (
                      <span className="rounded-xs bg-teal-950 px-1.5 py-0.5 font-mono text-[10px] text-teal-300">
                        driver
                      </span>
                    )}
                    {role === "downstream" && (
                      <span className="rounded-xs bg-amber-950 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                        impact
                      </span>
                    )}
                    {isSuperseded && (
                      <span className="rounded-xs bg-surface-band px-1.5 py-0.5 font-mono text-[10px] uppercase text-text-muted">
                        superseded
                      </span>
                    )}
                    {microBadge && (
                      <span
                        className={`rounded-xs px-1.5 py-0.5 font-mono text-[10px] font-semibold ${microBadge.pillClass}`}
                      >
                        {microBadge.text}
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                  <span
                    className={`truncate ${
                      isSuperseded ? "line-through decoration-1 opacity-80" : ""
                    }`}
                  >
                    {displayName}
                  </span>
                  {role === "upstream" && (
                    <span className="rounded-xs bg-teal-950 px-1.5 py-0.5 font-mono text-[10px] text-teal-300">
                      driver
                    </span>
                  )}
                  {role === "downstream" && (
                    <span className="rounded-xs bg-amber-950 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                      impact
                    </span>
                  )}
                  {isSuperseded && (
                    <span className="rounded-xs bg-surface-band px-1.5 py-0.5 font-mono text-[10px] uppercase text-text-muted">
                      superseded
                    </span>
                  )}
                  {microBadge && (
                    <span
                      className={`rounded-xs px-1.5 py-0.5 font-mono text-[10px] font-semibold ${microBadge.pillClass}`}
                    >
                      {microBadge.text}
                    </span>
                  )}
                  {node.properties.theil_sen_slope !== undefined && (
                    <span className="font-mono text-[10.5px]" style={{ color: slopeInfo.color }}>
                      {node.properties.theil_sen_slope >= 0 ? "↑" : "↓"}
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}

        {/* Floating clickable + Wire pill suggestions for discovered candidate links in 3D */}
        {candidateLinks.length > 0 && onAcceptCandidateLink && (
          <div
            className={`pointer-events-auto absolute bottom-3 z-20 flex max-w-md flex-col gap-1.5 ${
              inspectorOpen
                ? inspectorWide
                  ? "right-3 sm:right-[26rem] lg:right-[33.5rem] xl:right-[36rem]"
                  : "right-3 sm:right-[26rem] lg:right-[28.5rem] xl:right-[30.5rem]"
                : "right-3"
            }`}
          >
            {candidateLinks.slice(0, 3).map((cand) => (
              <button
                key={cand.id}
                type="button"
                onClick={() => onAcceptCandidateLink(cand)}
                title={`+ Wire: ${humanizeNodeText(cand.sourceName)} → ${humanizeNodeText(cand.targetName)}`}
                className="etg-hud-pill flex items-center justify-between gap-2 rounded-md border border-violet-400 bg-surface px-3 py-1.5 text-left text-[11.5px] hover:border-violet-300 cursor-pointer"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-text-primary">
                  <span className="shrink-0 font-semibold text-violet-300">+ Wire:</span>
                  <span className="min-w-0 max-w-[9rem] truncate">
                    {humanizeNodeText(cand.sourceName)}
                  </span>
                  <span className="shrink-0 text-text-muted" aria-hidden="true">
                    →
                  </span>
                  <span className="min-w-0 max-w-[9rem] truncate">
                    {humanizeNodeText(cand.targetName)}
                  </span>
                </span>
                <span className="shrink-0 font-mono ws-numeric text-[11px] text-violet-300">
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
          <div className="etg-hud-pill pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 space-y-1 rounded-lg bg-surface px-3.5 py-2 text-xs shadow-lg">
            <div
              className={`flex items-center gap-2 font-semibold ${
                activeEdge.type === "drives_opposite"
                  ? "text-rose-300"
                  : activeEdge.type === "supersedes"
                    ? "text-purple-300"
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
            <div className="text-xs text-text-muted">
              {src?.properties.name ?? activeEdge.source_uuid} ↔{" "}
              {tgt?.properties.name ?? activeEdge.target_uuid}
            </div>
          </div>
        );
      })()}

      {/* Left-Edge Vertical Camera Dock */}
      <div className="absolute left-2.5 top-1/2 z-10 -translate-y-1/2">
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
