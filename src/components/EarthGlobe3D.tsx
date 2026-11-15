"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  DEFAULT_REGIONAL_FOCUS_RADIUS,
  GIBS_LAYERS,
  MIN_GLOBE_CAMERA_RADIUS,
  REGIONAL_ZOOM_ACTIVATE_RADIUS,
  REGIONAL_ZOOM_EXIT_RADIUS,
  resolveActiveGibsLayer,
  resolveGibsDateIso,
  resolveGlobalSyncSignature,
  type ActiveGibsLayerId,
  type RegionalSatelliteMode,
} from "@/lib/earth/nasaGibsRegional";
import {
  EARTH_RADIUS,
  GLOBE_PREFS_STORAGE_KEY,
  buildElevatedGreatCircleCurve,
  computeSunDirection,
  createDynamicTextureTracker,
  createRadialGlowTexture,
  createRingReticleTexture,
  createStarSpriteTexture,
  disposeGroupResources,
  formatGibsColorbarForUnit,
  latLngToVector3,
  resolveComparisonArcVisuals,
  selectVisibleGlobeArcs,
  vector3ToLatLng,
  type ComparisonArcVisualMeta,
  type DisposableTexture,
  type DynamicTextureTracker,
  type GlobalHudState,
  type GlobeArcMode,
  type GlobePersistedPrefs,
  type GlobeSceneRefs,
  type HoveredGlobeInfo,
  type ProjectedArcLabel,
  type ProjectedProbeLabel,
  type ProjectedRegionalNodeLabel,
  type PulseTraveler,
  type RegionalFocusRequest,
  type RegionalHudState,
  type ResolvedComparisonArcVisuals,
  type SunPreset,
} from "@/components/globe/globeGeometryAndArcs";
import {
  createCloudDeckMaterial,
  createEarthSurfaceMaterial,
  createInnerHazeMaterial,
  createOuterAtmosphereMaterial,
  createStarfieldLayer,
} from "@/components/globe/globeShaders";
import { createGlobeGibsTileController } from "@/components/globe/globeGibsTileController";
import {
  projectGlobeOverlayLabels,
  reconcileMarkersAndArcs,
  reconcileProbeReticlesAndComparisonArc,
  reconcileRegionalRings,
  resolveGlobePointerClick,
  resolveGlobePointerHover,
  type OverlayLabelProjectionState,
} from "@/components/globe/globeSceneReconcilers";
import { GlobeHudOverlays } from "@/components/globe/GlobeHudOverlays";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  RelationCategory,
  TemperatureUnit,
  TrendMicroscopeScanResult,
} from "@/types/etg";

export {
  buildElevatedGreatCircleCurve,
  createDynamicTextureTracker,
  disposeGroupResources,
  formatGibsColorbarForUnit,
  latLngToVector3,
  resolveComparisonArcVisuals,
  selectVisibleGlobeArcs,
  vector3ToLatLng,
  type ComparisonArcVisualMeta,
  type DisposableTexture,
  type DynamicTextureTracker,
  type GlobeArcMode,
  type RegionalFocusRequest,
  type ResolvedComparisonArcVisuals,
  type SunPreset,
};

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

function advanceTravelers(travelers: PulseTraveler[], elapsed: number): void {
  for (const tr of travelers) {
    const u = (elapsed * tr.speed + tr.phase) % 1;
    const fIdx = u * (tr.pts.length - 1);
    const i0 = Math.floor(fIdx);
    const i1 = Math.min(tr.pts.length - 1, i0 + 1);
    const frac = fIdx - i0;
    tr.sprite.position.lerpVectors(tr.pts[i0], tr.pts[i1], frac);
  }
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
  const [containerWidth, setContainerWidth] = useState(600);
  const [autoRotate, setAutoRotate] = useState(true);
  const [sunPreset, setSunPreset] = useState<SunPreset>(initialSunPreset ?? "live");
  const [liveUtcTime, setLiveUtcTime] = useState<string>(
    () => new Date().toISOString().slice(11, 16) + " UTC"
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
  const [globalHud, setGlobalHud] = useState<GlobalHudState>({
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
  const [projectedProbeLabel, setProjectedProbeLabel] = useState<ProjectedProbeLabel | null>(
    null
  );
  const [projectedNodeLabels, setProjectedNodeLabels] = useState<ProjectedRegionalNodeLabel[]>(
    []
  );
  const [hoveredInfo, setHoveredInfo] = useState<HoveredGlobeInfo | null>(null);

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
  }, [
    prefsHydrated,
    arcMode,
    showClouds,
    showArcLabels,
    showPins,
    autoRotate,
    satelliteMode,
    sunPreset,
    filterSmooth,
  ]);

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

  const cameraTargetRef = useRef<{ theta: number; phi: number; radius: number } | null>(null);
  const lastFocusSeqTimestampRef = useRef(0);
  const sceneRefs = useRef<GlobeSceneRefs | null>(null);

  // Explicit camera fly-to for regional drill-down requests
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

  // Mount Three.js WebGL scene, GIBS controller, pointer controls, and animation loop
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

    const { stars, starGeo, starMat } = createStarfieldLayer(starTex);
    scene.add(stars);

    const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 160, 120);
    const earthMat = createEarthSurfaceMaterial({
      blueMarbleTex,
      normalTex,
      waterTex,
      lightsTex,
      nightTex,
      cloudsTex,
      placeholderRegionalTex,
      sunDirection,
      dayNightEnabled: sunPresetRef.current !== "daylight",
      cloudsEnabled: showCloudsRef.current,
      filterSmooth: filterSmoothRef.current,
    });
    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    scene.add(earthMesh);

    const cloudGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.0105, 128, 96);
    const cloudMat = createCloudDeckMaterial({
      cloudsTex,
      sunDirection,
      dayNightEnabledUniform: earthMat.uniforms.uDayNightEnabled,
    });
    const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    cloudMesh.visible = showCloudsRef.current;
    scene.add(cloudMesh);

    const innerHazeGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.0035, 96, 64);
    const innerHazeMat = createInnerHazeMaterial({
      sunDirUniform: earthMat.uniforms.uSunDir,
      dayNightEnabledUniform: earthMat.uniforms.uDayNightEnabled,
    });
    scene.add(new THREE.Mesh(innerHazeGeo, innerHazeMat));

    const atmoGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.058, 96, 64);
    const atmoMat = createOuterAtmosphereMaterial({
      sunDirection,
      dayNightEnabledUniform: earthMat.uniforms.uDayNightEnabled,
    });
    scene.add(new THREE.Mesh(atmoGeo, atmoMat));

    const markersGroup = new THREE.Group();
    markersGroup.visible = showPinsRef.current;
    const arcsGroup = new THREE.Group();
    const probeGroup = new THREE.Group();
    const regionalGroup = new THREE.Group();
    scene.add(regionalGroup);
    scene.add(arcsGroup);
    scene.add(markersGroup);
    scene.add(probeGroup);

    const gibsController = createGlobeGibsTileController({
      earthMat,
      renderer,
      maxAnisotropy,
      spherical,
      activeGibsLayerRef,
      cutoffMsRef,
      setGlobalHud,
      setRegionalHud,
    });

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
      forceRegionalTileSync: () => gibsController.syncRegionalTile(true),
      syncGlobalMode: gibsController.syncGlobalMode,
    };

    gibsController.syncGlobalMode(
      satelliteModeRef.current,
      activeTopicsRef.current,
      cutoffMsRef.current
    );

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

      const { hovered, cursor } = resolveGlobePointerHover({
        raycaster,
        ndc: getNormalizedCoords(e.clientX, e.clientY),
        camera,
        showPins: showPinsRef.current,
        markersGroup,
        arcsGroup,
        earthMesh,
        markerMap,
        arcMap,
        clientX: e.clientX,
        clientY: e.clientY,
        containerRect: container.getBoundingClientRect(),
        nodes: nodesRef.current,
        microscopeByNode: microscopeByNodeRef.current,
      });
      setHoveredInfo(hovered);
      renderer.domElement.style.cursor = cursor;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      const distMoved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (distMoved > 5) return;

      resolveGlobePointerClick({
        raycaster,
        ndc: getNormalizedCoords(e.clientX, e.clientY),
        camera,
        showPins: showPinsRef.current,
        markersGroup,
        arcsGroup,
        earthMesh,
        markerMap,
        arcMap,
        onSelectNode: callbacksRef.current.onSelectNode,
        onSelectEdge: callbacksRef.current.onSelectEdge,
        onProbeCoordinate: callbacksRef.current.onProbeCoordinate,
      });
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
          setContainerWidth(Math.round(w));
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    if (container.clientWidth > 0) {
      setContainerWidth(Math.round(container.clientWidth));
    }
    resizeObs.observe(container);

    let animId = 0;
    const startTimeMs = performance.now();
    let lastTileEvalMs = 0;
    let lastLabelSync = -1;
    const projectionState: OverlayLabelProjectionState = {
      lastLabelSignature: "",
      lastProbeLabelSignature: "",
      lastNodeLabelSignature: "",
    };
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

      if (!isRegionalRef.current && spherical.radius <= REGIONAL_ZOOM_ACTIVATE_RADIUS) {
        isRegionalRef.current = true;
        setIsRegionalZoom(true);
        gibsController.syncRegionalTile(true);
      } else if (isRegionalRef.current && spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS) {
        isRegionalRef.current = false;
        setIsRegionalZoom(false);
        setProjectedNodeLabels([]);
        projectionState.lastNodeLabelSignature = "";
      } else if (isRegionalRef.current && elapsed - lastTileEvalMs >= 0.14) {
        lastTileEvalMs = elapsed;
        gibsController.syncRegionalTile(false);
      }

      const targetRegBlend =
        isRegionalRef.current &&
        gibsController.isRegionalTexLoaded() &&
        activeGibsLayerRef.current !== null
          ? 1.0
          : 0.0;
      earthMat.uniforms.uRegionalBlend.value +=
        (targetRegBlend - (earthMat.uniforms.uRegionalBlend.value as number)) * 0.1;

      const targetGlobalBlend =
        gibsController.isGlobalTexLoaded() &&
        (earthMat.uniforms.uGlobalFilterMode.value as number) > 0.5
          ? 1.0
          : 0.0;
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

      for (const child of markersGroup.children) {
        if (child.userData.pulseRing) {
          const phase = ((elapsed * 0.52 + (child.userData.phaseOffset ?? 0)) % 1 + 1) % 1;
          const baseScale = child.userData.baseScale ?? 1;
          child.scale.setScalar(baseScale * (1.0 + phase * 1.35));
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = (1 - phase) * (child.userData.maxOpacity ?? 0.62);
        } else if (child.userData.haloSprite) {
          const baseScale = child.userData.baseScale ?? 6;
          const breath = 1 + Math.sin(elapsed * 2.6 + (child.userData.phaseOffset ?? 0)) * 0.09;
          child.scale.setScalar(baseScale * breath);
        }
      }

      for (const child of probeGroup.children) {
        if (child.userData.probeRing) {
          const phase = (elapsed * 0.7) % 1;
          child.scale.setScalar(1 + phase * 1.25);
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = (1 - phase) * 0.82;
        }
      }

      advanceTravelers(sceneRefs.current?.arcTravelers ?? [], elapsed);
      advanceTravelers(sceneRefs.current?.probeTravelers ?? [], elapsed);

      camera.position.setFromSpherical(spherical);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      (earthMat.uniforms.uCameraRight.value as THREE.Vector3)
        .setFromMatrixColumn(camera.matrixWorld, 0)
        .normalize();
      renderer.render(scene, camera);

      if (elapsed - lastLabelSync >= 0.09) {
        lastLabelSync = elapsed;
        projectGlobeOverlayLabels({
          state: projectionState,
          camera,
          spherical,
          currentW,
          currentH,
          inspectorOpen: inspectorOpenRef.current,
          isRegionalZoom: isRegionalRef.current,
          showPins: showPinsRef.current,
          showArcLabels: showArcLabelsRef.current,
          nodes: nodesRef.current,
          selectedNodeUuid: selectedNodeUuidRef.current,
          tempUnit: tempUnitRef.current,
          refs: sceneRefs.current,
          camUnitVec,
          midUnitVec,
          projVec,
          tmpSphVec,
          nodePosVec,
          setProjectedNodeLabels,
          setProjectedProbeLabel,
          setProjectedArcLabels,
        });
      }
    };
    animate();

    return () => {
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
      gibsController.dispose();
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
    reconcileRegionalRings({
      refs,
      isRegionalZoom,
      regionalFocalCoord,
      hasSelectedOrProbedPin: Boolean(selectedGeoNode || probedCoord),
    });
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
    reconcileMarkersAndArcs({
      refs,
      nodes,
      edges,
      showPins: showPinsRef.current,
      arcMode,
      selectedNodeUuid,
      probedAnchorUuid,
      selectedEdgeUuid,
      cascadeEdgeUuids,
      enabledCategories,
      isRegionalZoom,
      regBucketLat,
      regBucketLng,
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

  // Render Probe Reticle(s) + Volumetric Comparison Arc
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    reconcileProbeReticlesAndComparisonArc({
      refs,
      probedCoord,
      comparePinB,
      selectedEdgeUuid,
      comparisonArcMeta,
    });
  }, [probedCoord, comparePinB, selectedEdgeUuid, comparisonArcMeta]);

  const resetCamera = () => {
    cameraTargetRef.current = { theta: 0.9, phi: Math.PI * 0.41, radius: 270 };
  };

  const adjustCameraRadius = (delta: number) => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const base = cameraTargetRef.current ?? {
      theta: refs.spherical.theta,
      phi: refs.spherical.phi,
      radius: refs.spherical.radius,
    };
    const step = delta < 0 ? (base.radius < 185 ? -24 : -32) : delta;
    cameraTargetRef.current = {
      ...base,
      radius: Math.max(MIN_GLOBE_CAMERA_RADIUS, Math.min(430, base.radius + step)),
    };
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

  const onFocusSunPresetCamera = (preset: SunPreset) => {
    if (preset === "americas") {
      cameraTargetRef.current = { theta: 0.9, phi: Math.PI * 0.41, radius: 260 };
      setAutoRotate(false);
    } else if (preset === "eurasia") {
      cameraTargetRef.current = { theta: -1.1, phi: Math.PI * 0.36, radius: 260 };
      setAutoRotate(false);
    } else if (preset === "night") {
      cameraTargetRef.current = { theta: 0.85, phi: Math.PI * 0.4, radius: 260 };
      setAutoRotate(false);
    }
  };

  return (
    <div className="etg-globe-void relative h-full w-full overflow-hidden select-none">
      <div ref={containerRef} className="h-full w-full" aria-label="Interactive 3D Earth Globe" />
      <GlobeHudOverlays
        nodes={nodes}
        microscopeScan={microscopeScan}
        microscopeByNode={microscopeByNode}
        probedCoord={probedCoord}
        compareMode={compareMode}
        inspectorOpen={inspectorOpen}
        mobileSheetExpanded={mobileSheetExpanded}
        enabledCategories={enabledCategories}
        onChangeEnabledCategories={onChangeEnabledCategories}
        tempUnit={tempUnit}
        onChangeTempUnit={onChangeTempUnit}
        activeTopics={activeTopics}
        timelineSlot={timelineSlot}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onToggleCompareMode={onToggleCompareMode}
        autoRotate={autoRotate}
        setAutoRotate={setAutoRotate}
        sunPreset={sunPreset}
        setSunPreset={setSunPreset}
        liveUtcTime={liveUtcTime}
        showClouds={showClouds}
        setShowClouds={setShowClouds}
        arcMode={arcMode}
        setArcMode={setArcMode}
        showArcLabels={showArcLabels}
        setShowArcLabels={setShowArcLabels}
        showPins={showPins}
        setShowPins={setShowPins}
        satelliteMode={satelliteMode}
        setSatelliteMode={setSatelliteMode}
        filterSmooth={filterSmooth}
        setFilterSmooth={setFilterSmooth}
        isRegionalZoom={isRegionalZoom}
        globalHud={globalHud}
        regionalHud={regionalHud}
        mobileHudExpanded={mobileHudExpanded}
        setMobileHudExpanded={setMobileHudExpanded}
        projectedArcLabels={projectedArcLabels}
        projectedProbeLabel={projectedProbeLabel}
        projectedNodeLabels={projectedNodeLabels}
        hoveredInfo={hoveredInfo}
        containerWidth={containerWidth}
        resetCamera={resetCamera}
        zoomIn={() => adjustCameraRadius(-1)}
        zoomOut={() => adjustCameraRadius(32)}
        zoomToRegion={zoomToRegion}
        onRetryRegionalTile={() => sceneRefs.current?.forceRegionalTileSync()}
        onFocusSunPresetCamera={onFocusSunPresetCamera}
      />
    </div>
  );
}
