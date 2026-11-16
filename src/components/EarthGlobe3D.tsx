"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  DEFAULT_REGIONAL_FOCUS_RADIUS,
  DEFAULT_SATELLITE_CITY_RADIUS,
  DEFAULT_SATELLITE_METRO_RADIUS,
  DEFAULT_SATELLITE_STREET_RADIUS,
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
  latLngToNormalizedMercator,
  shouldUseCloudFreeAerialPrimary,
} from "@/lib/earth/satelliteZoomTiles";
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
  intersectTrueEarthSphere,
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
  inspectorWide?: boolean;
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

function computeTwoPointFramingTarget(
  latA: number,
  lngA: number,
  latB: number,
  lngB: number
): { theta: number; phi: number; radius: number } | null {
  if (Math.abs(latA - latB) < 0.8 && Math.abs(lngA - lngB) < 0.8) {
    return null;
  }
  const u1 = latLngToVector3(latA, lngA, 1).normalize();
  const u2 = latLngToVector3(latB, lngB, 1).normalize();
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
  return {
    theta: spherical.theta,
    phi: Math.max(0.28, Math.min(Math.PI - 0.28, spherical.phi)),
    radius: Math.min(308, Math.max(248, 236 + omega * 24)),
  };
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
  inspectorWide = false,
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
  const [sunPreset, setSunPreset] = useState<SunPreset>(initialSunPreset ?? "daylight");
  const [liveUtcTime, setLiveUtcTime] = useState<string>("");
  const [showClouds, setShowClouds] = useState(false);
  const [arcMode, setArcMode] = useState<GlobeArcMode>("focus");
  const [showArcLabels, setShowArcLabels] = useState(false);
  const [showPins, setShowPins] = useState(true);
  const [satelliteMode, setSatelliteMode] = useState<RegionalSatelliteMode>(
    initialSatelliteMode ?? "auto"
  );
  const [showPlaceLabels, setShowPlaceLabels] = useState(true);
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
    aerialActive: false,
    aerialZoom: 0,
    aerialResolutionLabel: "~3–5 km/px",
    altitudeKm: 10800,
    depthTier: "corridor",
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
        if (typeof parsed.showPlaceLabels === "boolean") {
          setShowPlaceLabels(parsed.showPlaceLabels);
        }
        if (
          initialSatelliteMode === undefined &&
          (parsed.satelliteMode === "auto" ||
            parsed.satelliteMode === "aerial" ||
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
        showPlaceLabels,
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
    showPlaceLabels,
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
  const inspectorWideRef = useRef(inspectorWide);
  inspectorWideRef.current = inspectorWide;
  const compareModeRef = useRef(compareMode);
  compareModeRef.current = compareMode;
  const activeGibsLayerRef = useRef<ActiveGibsLayerId | null>(resolvedGibsLayerId);
  activeGibsLayerRef.current = resolvedGibsLayerId;
  const satelliteModeRef = useRef<RegionalSatelliteMode>(satelliteMode);
  satelliteModeRef.current = satelliteMode;
  const showPlaceLabelsRef = useRef<boolean>(showPlaceLabels);
  showPlaceLabelsRef.current = showPlaceLabels;
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

  const lastCameraSelectionSigRef = useRef<string>("");

  // Sync camera target to frame a focused dipole arc midpoint, a 2-spot comparison pair, or a single selected node
  useEffect(() => {
    const selectionSig = selectedEdgeUuid
      ? `edge:${selectedEdgeUuid}`
      : probedCoord && comparePinB
        ? `pair:${probedCoord.lat.toFixed(4)},${probedCoord.lng.toFixed(4)}->${comparePinB.lat.toFixed(4)},${comparePinB.lng.toFixed(4)}`
        : selectedNodeUuid
          ? `node:${selectedNodeUuid}`
          : "";
    if (!selectionSig) {
      lastCameraSelectionSigRef.current = "";
      return;
    }
    if (selectionSig === lastCameraSelectionSigRef.current) return;

    if (selectedEdgeUuid) {
      const edge = edges.find((e) => e.properties.uuid === selectedEdgeUuid);
      if (edge) {
        const src = nodes.find((n) => n.uuid === edge.source_uuid);
        const tgt = nodes.find((n) => n.uuid === edge.target_uuid);
        if (
          src?.properties.lat !== undefined &&
          src.properties.lng !== undefined &&
          tgt?.properties.lat !== undefined &&
          tgt.properties.lng !== undefined
        ) {
          const framed = computeTwoPointFramingTarget(
            src.properties.lat,
            src.properties.lng,
            tgt.properties.lat,
            tgt.properties.lng
          );
          if (framed) {
            lastCameraSelectionSigRef.current = selectionSig;
            cameraTargetRef.current = framed;
            setAutoRotate(false);
            return;
          }
        }
      }
    }

    if (probedCoord && comparePinB) {
      const framed = computeTwoPointFramingTarget(
        probedCoord.lat,
        probedCoord.lng,
        comparePinB.lat,
        comparePinB.lng
      );
      if (framed) {
        lastCameraSelectionSigRef.current = selectionSig;
        cameraTargetRef.current = framed;
        setAutoRotate(false);
        return;
      }
    }

    if (!selectedNodeUuid) return;
    if (Date.now() - lastFocusSeqTimestampRef.current < 150) {
      lastCameraSelectionSigRef.current = selectionSig;
      return;
    }
    const node = nodes.find((n) => n.uuid === selectedNodeUuid);
    if (node?.properties.lat !== undefined && node.properties.lng !== undefined) {
      lastCameraSelectionSigRef.current = selectionSig;
      const vec = latLngToVector3(node.properties.lat, node.properties.lng, 1);
      const spherical = new THREE.Spherical().setFromVector3(vec);
      const currentRadius =
        cameraTargetRef.current?.radius ??
        sceneRefs.current?.spherical.radius ??
        232;
      const currentSph = sceneRefs.current?.spherical;
      let targetRadius = Math.max(MIN_GLOBE_CAMERA_RADIUS, Math.min(232, currentRadius));
      if (currentSph && currentRadius < 135) {
        const camDir = new THREE.Vector3().setFromSpherical(currentSph).normalize();
        const nodeDir = vec.clone().normalize();
        const omega = Math.acos(Math.max(-1, Math.min(1, camDir.dot(nodeDir))));
        // Keep zoomed-in camera steady when clicking a pin already in view
        if (omega < 0.22) {
          setAutoRotate(false);
          return;
        }
        if (omega > 0.28) {
          targetRadius = DEFAULT_REGIONAL_FOCUS_RADIUS;
        }
      }
      cameraTargetRef.current = {
        theta: spherical.theta,
        phi: Math.max(0.08, Math.min(Math.PI - 0.08, spherical.phi)),
        radius: targetRadius,
      };
      setAutoRotate(false);
    }
  }, [selectedEdgeUuid, selectedNodeUuid, probedCoord, comparePinB, nodes, edges]);

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

    const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 288, 216);
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

    // High-density 80x80 local spherical cap for chord-free curvature & 64-bit Mercator UV precision across 12x12 grids
    const DETAIL_CAP_SEGMENTS = 80;
    const DETAIL_CAP_STRIDE = DETAIL_CAP_SEGMENTS + 1;
    const DETAIL_CAP_VERT_COUNT = DETAIL_CAP_STRIDE * DETAIL_CAP_STRIDE;
    const detailCapPosArr = new Float32Array(DETAIL_CAP_VERT_COUNT * 3);
    const detailCapNormArr = new Float32Array(DETAIL_CAP_VERT_COUNT * 3);
    const detailCapUvArr = new Float32Array(DETAIL_CAP_VERT_COUNT * 2);
    const detailCapMercArr = new Float32Array(DETAIL_CAP_VERT_COUNT * 4);
    const detailCapIndices = new Uint16Array(DETAIL_CAP_SEGMENTS * DETAIL_CAP_SEGMENTS * 6);
    let idxPtr = 0;
    for (let iy = 0; iy < DETAIL_CAP_SEGMENTS; iy++) {
      for (let ix = 0; ix < DETAIL_CAP_SEGMENTS; ix++) {
        const i00 = iy * DETAIL_CAP_STRIDE + ix;
        const i10 = i00 + 1;
        const i01 = (iy + 1) * DETAIL_CAP_STRIDE + ix;
        const i11 = i01 + 1;
        detailCapIndices[idxPtr++] = i00;
        detailCapIndices[idxPtr++] = i10;
        detailCapIndices[idxPtr++] = i11;
        detailCapIndices[idxPtr++] = i00;
        detailCapIndices[idxPtr++] = i11;
        detailCapIndices[idxPtr++] = i01;
      }
    }
    const detailCapPosAttr = new THREE.BufferAttribute(detailCapPosArr, 3);
    const detailCapNormAttr = new THREE.BufferAttribute(detailCapNormArr, 3);
    const detailCapUvAttr = new THREE.BufferAttribute(detailCapUvArr, 2);
    const detailCapMercAttr = new THREE.BufferAttribute(detailCapMercArr, 4);
    const detailCapGeo = new THREE.BufferGeometry();
    detailCapGeo.setAttribute("position", detailCapPosAttr);
    detailCapGeo.setAttribute("normal", detailCapNormAttr);
    detailCapGeo.setAttribute("uv", detailCapUvAttr);
    detailCapGeo.setAttribute("aDetailMerc", detailCapMercAttr);
    detailCapGeo.setIndex(new THREE.BufferAttribute(detailCapIndices, 1));

    const detailCapMat = earthMat.clone();
    detailCapMat.uniforms = earthMat.uniforms;
    detailCapMat.transparent = true;
    detailCapMat.depthWrite = false;
    detailCapMat.depthTest = true;
    detailCapMat.polygonOffset = true;
    detailCapMat.polygonOffsetFactor = -2;
    detailCapMat.polygonOffsetUnits = -2;

    const detailCapMesh = new THREE.Mesh(detailCapGeo, detailCapMat);
    detailCapMesh.visible = false;
    detailCapMesh.frustumCulled = false;
    detailCapMesh.renderOrder = -1;
    scene.add(detailCapMesh);

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
      satelliteModeRef,
      activeTopicsRef,
      showPlaceLabelsRef,
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
      innerHazeMat,
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
    lastSyncedGlobalSigRef.current = resolveGlobalSyncSignature(
      satelliteModeRef.current,
      activeTopicsRef.current,
      cutoffMsRef.current
    );

    const capCenterUnit = new THREE.Vector3();
    const capEast = new THREE.Vector3();
    const capNorth = new THREE.Vector3();
    const capDir = new THREE.Vector3();
    let detailCapInitialized = false;
    let lastCapLat = 0;
    let lastCapLng = 0;
    let lastCapHalfDeg = 1;
    let lastCapAlt = 20;

    const rebuildDetailCap = (
      centerLat: number,
      centerLng: number,
      capHalfDeg: number
    ) => {
      const mercRef = latLngToNormalizedMercator(centerLat, centerLng);
      capCenterUnit.copy(latLngToVector3(centerLat, centerLng, 1)).normalize();
      const sinCenterXZ = Math.hypot(capCenterUnit.x, capCenterUnit.z);
      if (sinCenterXZ > 1e-5) {
        capEast
          .set(capCenterUnit.z / sinCenterXZ, 0, -capCenterUnit.x / sinCenterXZ)
          .normalize();
      } else {
        capEast.set(1, 0, 0);
      }
      capNorth.crossVectors(capCenterUnit, capEast).normalize();

      const tanHalf = Math.tan((capHalfDeg * Math.PI) / 180);
      const dRad = ((2 * capHalfDeg * Math.PI) / 180) / DETAIL_CAP_SEGMENTS;
      const sagitta = EARTH_RADIUS * 0.5 * (dRad * 0.5) ** 2;
      const capRadius = EARTH_RADIUS + Math.max(0.000008, sagitta * 2.2);
      const cx2d = -capCenterUnit.x;
      const cz2d = capCenterUnit.z;

      let vPtr = 0;
      for (let iy = 0; iy <= DETAIL_CAP_SEGMENTS; iy++) {
        const vNorm = (iy / DETAIL_CAP_SEGMENTS) * 2 - 1;
        for (let ix = 0; ix <= DETAIL_CAP_SEGMENTS; ix++) {
          const uNorm = (ix / DETAIL_CAP_SEGMENTS) * 2 - 1;
          capDir
            .copy(capCenterUnit)
            .addScaledVector(capEast, uNorm * tanHalf)
            .addScaledVector(capNorth, vNorm * tanHalf)
            .normalize();

          const p3 = vPtr * 3;
          detailCapNormArr[p3] = capDir.x;
          detailCapNormArr[p3 + 1] = capDir.y;
          detailCapNormArr[p3 + 2] = capDir.z;
          detailCapPosArr[p3] = capDir.x * capRadius;
          detailCapPosArr[p3 + 1] = capDir.y * capRadius;
          detailCapPosArr[p3 + 2] = capDir.z * capRadius;

          const vLatDeg =
            (Math.asin(Math.max(-1, Math.min(1, capDir.y))) * 180) / Math.PI;
          const clampedLatRad =
            (Math.max(-85.05, Math.min(85.05, vLatDeg)) * Math.PI) / 180;
          const vMercY =
            (1 - Math.log(Math.tan(Math.PI / 4 + clampedLatRad / 2)) / Math.PI) *
            0.5;

          const dx2d = -capDir.x;
          const dz2d = capDir.z;
          const vXZ = Math.hypot(dx2d, dz2d);
          const dLngDeg =
            sinCenterXZ > 1e-6 && vXZ > 1e-6
              ? (Math.atan2(cx2d * dz2d - cz2d * dx2d, cx2d * dx2d + cz2d * dz2d) *
                  180) /
                Math.PI
              : 0;

          const p2 = vPtr * 2;
          detailCapUvArr[p2] = (centerLng + dLngDeg + 180) / 360;
          detailCapUvArr[p2 + 1] = (vLatDeg + 90) / 180;

          const radial = Math.hypot(uNorm, vNorm);
          const tRim = Math.max(0, Math.min(1, (0.98 - radial) / 0.2));
          const rimAlpha = tRim * tRim * (3 - 2 * tRim);

          const p4 = vPtr * 4;
          detailCapMercArr[p4] = dLngDeg / 360;
          detailCapMercArr[p4 + 1] = vMercY - mercRef.mercY;
          detailCapMercArr[p4 + 2] = 1.0;
          detailCapMercArr[p4 + 3] = rimAlpha;
          vPtr += 1;
        }
      }

      detailCapPosAttr.needsUpdate = true;
      detailCapNormAttr.needsUpdate = true;
      detailCapUvAttr.needsUpdate = true;
      detailCapMercAttr.needsUpdate = true;
      gibsController.syncMercatorOrigin(mercRef);
    };

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 2.2 };
    const dblHitVec = new THREE.Vector3();
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
      if (e.pointerType === "mouse" && e.button !== 0) return;
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
        const alt = Math.max(0.008, spherical.radius - EARTH_RADIUS);
        const surfaceWorldPerPx =
          (2 * alt * Math.tan((20 * Math.PI) / 180)) / Math.max(420, currentH);
        const dragMultiplier = 1.1 + 1.4 * Math.min(1, alt / 100);
        const speed = Math.min(0.0055, (surfaceWorldPerPx / EARTH_RADIUS) * dragMultiplier);
        const sinPhi = Math.max(0.22, Math.sin(spherical.phi));
        spherical.theta -= (dx * speed) / sinPhi;
        spherical.phi = Math.max(
          0.08,
          Math.min(Math.PI - 0.08, spherical.phi - dy * speed)
        );
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
        compareMode: compareModeRef.current,
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
      const alt = Math.max(0.008, spherical.radius - EARTH_RADIUS);
      const rawDelta =
        e.deltaMode === 1
          ? e.deltaY * 36
          : e.deltaMode === 2
            ? e.deltaY * 320
            : e.deltaY;
      const clampedDelta = Math.max(-360, Math.min(360, rawDelta));
      const zoomFactor = Math.exp(clampedDelta * 0.0065);
      const nextAlt = Math.max(
        MIN_GLOBE_CAMERA_RADIUS - EARTH_RADIUS,
        Math.min(330, alt * zoomFactor)
      );
      const nextRadius = EARTH_RADIUS + nextAlt;

      spherical.radius = nextRadius;
      setAutoRotate(false);
    };

    const onDblClick = (e: MouseEvent) => {
      raycaster.setFromCamera(getNormalizedCoords(e.clientX, e.clientY), camera);
      if (!intersectTrueEarthSphere(raycaster.ray, dblHitVec)) return;
      const hitSph = new THREE.Spherical().setFromVector3(
        dblHitVec.clone().normalize()
      );
      const curAlt = Math.max(0.008, spherical.radius - EARTH_RADIUS);
      const targetRadius = Math.max(
        MIN_GLOBE_CAMERA_RADIUS,
        EARTH_RADIUS + curAlt * 0.24
      );
      cameraTargetRef.current = {
        theta: hitSph.theta,
        phi: Math.max(0.08, Math.min(Math.PI - 0.08, hitSph.phi)),
        radius: targetRadius,
      };
      setAutoRotate(false);
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.addEventListener("dblclick", onDblClick);

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
    let prevFrameMs = startTimeMs;
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
      const nowMs = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (nowMs - prevFrameMs) * 0.001));
      prevFrameMs = nowMs;
      const elapsed = (nowMs - startTimeMs) * 0.001;
      const reducedMotion =
        typeof window !== "undefined" &&
        Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

      if (cloudMesh.visible && !reducedMotion) {
        cloudMesh.rotation.y += 0.00018;
        earthMat.uniforms.uCloudDriftU.value = cloudMesh.rotation.y / (Math.PI * 2);
      }

      if (cameraTargetRef.current) {
        const t = cameraTargetRef.current;
        let dTheta = t.theta - spherical.theta;
        while (dTheta > Math.PI) dTheta -= Math.PI * 2;
        while (dTheta < -Math.PI) dTheta += Math.PI * 2;
        const flyStep = reducedMotion ? 1 : 1 - Math.exp(-13.5 * dt);
        spherical.theta += dTheta * flyStep;
        spherical.phi += (t.phi - spherical.phi) * flyStep;
        const curFlyAlt = Math.max(0.008, spherical.radius - EARTH_RADIUS);
        const tgtFlyAlt = Math.max(0.008, t.radius - EARTH_RADIUS);
        const nextLogAlt =
          Math.log(curFlyAlt) + (Math.log(tgtFlyAlt) - Math.log(curFlyAlt)) * flyStep;
        spherical.radius = reducedMotion ? t.radius : EARTH_RADIUS + Math.exp(nextLogAlt);
        const targetAlt = Math.max(0.008, t.radius - EARTH_RADIUS);
        const angEps = Math.min(0.005, Math.max(0.000012, 0.005 * (targetAlt / 100)));
        const radEps = Math.min(0.25, Math.max(0.0004, targetAlt * 0.025));
        if (
          reducedMotion ||
          (Math.abs(dTheta) < angEps &&
            Math.abs(t.phi - spherical.phi) < angEps &&
            Math.abs(t.radius - spherical.radius) < radEps)
        ) {
          spherical.theta = t.theta;
          spherical.phi = t.phi;
          spherical.radius = t.radius;
          cameraTargetRef.current = null;
        }
      } else if (
        autoRotateRef.current &&
        !reducedMotion &&
        !isDragging &&
        spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS
      ) {
        spherical.theta += 0.0012;
      }

      const curAlt = Math.max(0.008, spherical.radius - EARTH_RADIUS);
      const nextNear = curAlt < 18 ? Math.max(0.0015, curAlt * 0.08) : 1;
      const nextFar = curAlt < 1.5 ? 60 : curAlt < 18 ? 600 : 2000;
      if (
        Math.abs(camera.near - nextNear) > nextNear * 0.15 ||
        Math.abs(camera.far - nextFar) > nextFar * 0.15
      ) {
        camera.near = nextNear;
        camera.far = nextFar;
        camera.updateProjectionMatrix();
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
      } else if (isRegionalRef.current && elapsed - lastTileEvalMs >= 0.032) {
        lastTileEvalMs = elapsed;
        gibsController.syncRegionalTile(false);
      }

      if (curAlt < 16.0) {
        tmpSphVec.setFromSpherical(spherical);
        const subLatLng = vector3ToLatLng(tmpSphVec, 6);
        if (Math.abs(subLatLng.lat) <= 85.05) {
          detailCapMesh.visible = true;
          const capHalfDeg = Math.max(0.055, Math.min(8.5, curAlt * 1.95));
          const cosLat = Math.max(
            0.08,
            Math.cos((subLatLng.lat * Math.PI) / 180)
          );
          let dLng = Math.abs(subLatLng.lng - lastCapLng);
          if (dLng > 180) dLng = 360 - dLng;
          const driftDeg = Math.hypot(subLatLng.lat - lastCapLat, dLng * cosLat);
          const altRatio = lastCapAlt > 0 ? curAlt / lastCapAlt : 99;
          if (
            !detailCapInitialized ||
            driftDeg > 0.32 * lastCapHalfDeg ||
            altRatio > 1.75 ||
            altRatio < 0.57
          ) {
            detailCapInitialized = true;
            lastCapLat = subLatLng.lat;
            lastCapLng = subLatLng.lng;
            lastCapHalfDeg = capHalfDeg;
            lastCapAlt = curAlt;
            rebuildDetailCap(subLatLng.lat, subLatLng.lng, capHalfDeg);
          }
        } else {
          detailCapMesh.visible = false;
        }
      } else {
        detailCapMesh.visible = false;
      }

      const satCoarseTarget =
        isRegionalRef.current && gibsController.isAerialCoarseLoaded() ? 1.0 : 0.0;
      earthMat.uniforms.uSatCoarseBlend.value +=
        (satCoarseTarget - (earthMat.uniforms.uSatCoarseBlend.value as number)) * 0.32;

      const satMidTarget =
        isRegionalRef.current && gibsController.isAerialMidLoaded() ? 1.0 : 0.0;
      earthMat.uniforms.uSatMidBlend.value +=
        (satMidTarget - (earthMat.uniforms.uSatMidBlend.value as number)) * 0.34;

      const satPrevFineTarget =
        isRegionalRef.current && gibsController.isAerialPrevFineLoaded() ? 1.0 : 0.0;
      earthMat.uniforms.uSatPrevFineBlend.value +=
        (satPrevFineTarget - (earthMat.uniforms.uSatPrevFineBlend.value as number)) * 0.36;

      const satFineTarget =
        isRegionalRef.current && gibsController.isAerialFineLoaded() ? 1.0 : 0.0;
      earthMat.uniforms.uSatFineBlend.value +=
        (satFineTarget - (earthMat.uniforms.uSatFineBlend.value as number)) * 0.38;

      const useAerialPrimary = shouldUseCloudFreeAerialPrimary(
        satelliteModeRef.current,
        activeTopicsRef.current
      );

      const targetRegBlend =
        isRegionalRef.current &&
        !useAerialPrimary &&
        gibsController.isRegionalTexLoaded() &&
        activeGibsLayerRef.current !== null
          ? 1.0
          : 0.0;
      earthMat.uniforms.uRegionalBlend.value +=
        (targetRegBlend - (earthMat.uniforms.uRegionalBlend.value as number)) * 0.1;

      const activeMeta = activeGibsLayerRef.current
        ? GIBS_LAYERS[activeGibsLayerRef.current]
        : null;
      const aerialLoaded =
        gibsController.isAerialCoarseLoaded() ||
        gibsController.isAerialMidLoaded() ||
        gibsController.isAerialPrevFineLoaded() ||
        gibsController.isAerialFineLoaded();
      const targetRegOpacity =
        activeMeta?.isDataLayer && aerialLoaded && spherical.radius < 130
          ? 0.62
          : 1.0;
      earthMat.uniforms.uRegionalMaxOpacity.value +=
        (targetRegOpacity - (earthMat.uniforms.uRegionalMaxOpacity.value as number)) * 0.12;

      const targetGlobalBlend =
        gibsController.isGlobalTexLoaded() &&
        (earthMat.uniforms.uGlobalFilterMode.value as number) > 0.5
          ? 1.0
          : 0.0;
      earthMat.uniforms.uGlobalLayerBlend.value +=
        (targetGlobalBlend - (earthMat.uniforms.uGlobalLayerBlend.value as number)) * 0.1;

      const cloudZoomFrac = Math.max(
        0,
        Math.min(1, (spherical.radius - 112) / (186 - 112))
      );
      cloudMat.uniforms.uRegionalFade.value = cloudZoomFrac * cloudZoomFrac;
      const hazeZoomFrac = Math.max(
        0,
        Math.min(1, (spherical.radius - 102) / (112 - 102))
      );
      innerHazeMat.uniforms.uInnerHazeFade.value = 0.12 + hazeZoomFrac * 0.88;

      const targetOffsetX =
        inspectorOpenRef.current && currentW >= 720
          ? Math.round(
              Math.min(inspectorWideRef.current ? 556 : 468, currentW * 0.42) * 0.38
            )
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

      const markerZoomScale = Math.min(
        1.0,
        curAlt / (isRegionalRef.current ? 75 : 165)
      );
      const probeZoomScale = Math.min(1.0, curAlt / 185);
      const closeAerialGlowAtten = curAlt < 18 ? 0.55 + 0.45 * (curAlt / 18) : 1.0;
      const arcDeepFade = Math.max(0, Math.min(1, (curAlt - 2.2) / (14 - 2.2)));

      for (const child of markersGroup.children) {
        const u = child.userData.unitNormal as THREE.Vector3 | undefined;
        if (child.userData.isFilament && u) {
          const line = child as THREE.Line;
          const posAttr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
          const sOff = Math.max(
            0.00006,
            (child.userData.surfOffset as number) * markerZoomScale
          );
          const oOff = Math.max(
            0.00012,
            (child.userData.orbOffset as number) * markerZoomScale
          );
          posAttr.setXYZ(
            0,
            u.x * (EARTH_RADIUS + sOff),
            u.y * (EARTH_RADIUS + sOff),
            u.z * (EARTH_RADIUS + sOff)
          );
          posAttr.setXYZ(
            1,
            u.x * (EARTH_RADIUS + oOff),
            u.y * (EARTH_RADIUS + oOff),
            u.z * (EARTH_RADIUS + oOff)
          );
          posAttr.needsUpdate = true;
          continue;
        }
        if (u && typeof child.userData.baseAltOffset === "number") {
          child.position
            .copy(u)
            .multiplyScalar(
              EARTH_RADIUS + Math.max(0.00006, child.userData.baseAltOffset * markerZoomScale)
            );
        }
        if (child.userData.pulseRing) {
          const phase = ((elapsed * 0.52 + (child.userData.phaseOffset ?? 0)) % 1 + 1) % 1;
          const baseScale = child.userData.baseScale ?? 1;
          child.scale.setScalar(baseScale * markerZoomScale * (1.0 + phase * 1.35));
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity =
            (1 - phase) * (child.userData.maxOpacity ?? 0.62) * closeAerialGlowAtten;
        } else if (child.userData.haloSprite) {
          const baseScale = child.userData.baseScale ?? 6;
          const breath = 1 + Math.sin(elapsed * 2.6 + (child.userData.phaseOffset ?? 0)) * 0.09;
          child.scale.setScalar(baseScale * markerZoomScale * breath);
          const spriteMat = (child as THREE.Sprite).material as THREE.SpriteMaterial;
          spriteMat.opacity = (child.userData.baseOpacity ?? 0.75) * closeAerialGlowAtten;
        } else if (child.userData.isHitTarget) {
          child.scale.setScalar(markerZoomScale);
        } else if (u) {
          child.scale.setScalar(markerZoomScale);
        }
      }

      for (const child of probeGroup.children) {
        const u = child.userData.unitNormal as THREE.Vector3 | undefined;
        if (u && typeof child.userData.baseAltOffset === "number") {
          child.position
            .copy(u)
            .multiplyScalar(
              EARTH_RADIUS + Math.max(0.00006, child.userData.baseAltOffset * probeZoomScale)
            );
        }
        if (child.userData.probeRing) {
          const phase = (elapsed * 0.7) % 1;
          child.scale.setScalar((1 + phase * 1.15) * probeZoomScale);
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity =
            (1 - phase) * (child.userData.maxOpacity ?? 0.72) * closeAerialGlowAtten;
        } else if (typeof child.userData.baseSize === "number") {
          child.scale.setScalar((child.userData.baseSize as number) * probeZoomScale);
          const spriteMat = (child as THREE.Sprite).material as THREE.SpriteMaterial;
          spriteMat.opacity = (child.userData.baseOpacity ?? 0.62) * closeAerialGlowAtten;
        } else if (child.userData.isProbeCore) {
          child.scale.setScalar(probeZoomScale);
        } else if (child.userData.isComparisonTube) {
          child.visible = curAlt > 2.2;
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = (child.userData.baseOpacity ?? 0.9) * arcDeepFade;
        }
      }

      arcsGroup.visible = arcDeepFade > 0.01;
      if (arcsGroup.visible) {
        for (const child of arcsGroup.children) {
          if (child.userData.isArcHit) {
            child.visible = curAlt >= 35;
          } else if (typeof child.userData.baseOpacity === "number") {
            const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
            mat.opacity = (child.userData.baseOpacity as number) * arcDeepFade;
          }
        }
      }

      advanceTravelers(sceneRefs.current?.arcTravelers ?? [], elapsed);
      advanceTravelers(sceneRefs.current?.probeTravelers ?? [], elapsed);
      const travelerScale = Math.min(1.0, curAlt / 90);
      for (const traveler of sceneRefs.current?.arcTravelers ?? []) {
        if (typeof traveler.sprite.userData.baseScale === "number") {
          traveler.sprite.scale.setScalar(
            (traveler.sprite.userData.baseScale as number) * travelerScale
          );
        }
      }
      for (const traveler of sceneRefs.current?.probeTravelers ?? []) {
        traveler.sprite.visible = curAlt > 2.2;
        if (typeof traveler.sprite.userData.baseScale === "number") {
          traveler.sprite.scale.setScalar(
            (traveler.sprite.userData.baseScale as number) * travelerScale
          );
        }
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
        projectGlobeOverlayLabels({
          state: projectionState,
          camera,
          spherical,
          currentW,
          currentH,
          inspectorOpen: inspectorOpenRef.current,
          inspectorWide: inspectorWideRef.current,
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
      renderer.domElement.removeEventListener("dblclick", onDblClick);
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
      if (cutoffSyncTimerRef.current !== null) {
        window.clearTimeout(cutoffSyncTimerRef.current);
        cutoffSyncTimerRef.current = null;
      }
      gibsController.dispose();
      placeholderRegionalTex.dispose();
      detailCapGeo.dispose();
      detailCapMat.dispose();
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
  } | null>(null);
  const lastSyncedGlobalSigRef = useRef<string | null>(null);
  const cutoffSyncTimerRef = useRef<number | null>(null);

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

    prevGlobalSyncInputsRef.current = {
      satelliteMode,
      activeTopics,
      prefsHydrated,
    };

    if (lastSyncedGlobalSigRef.current !== nextGlobalSig) {
      lastSyncedGlobalSigRef.current = nextGlobalSig;
      refs.syncGlobalMode(satelliteMode, activeTopics, cutoffMs);
    }

    if (cutoffSyncTimerRef.current !== null) {
      window.clearTimeout(cutoffSyncTimerRef.current);
      cutoffSyncTimerRef.current = null;
    }

    if (isRegionalZoom) {
      if (isCutoffOnlyChange) {
        cutoffSyncTimerRef.current = window.setTimeout(() => {
          cutoffSyncTimerRef.current = null;
          refs.forceRegionalTileSync();
        }, 180);
      } else {
        refs.forceRegionalTileSync();
      }
    }
  }, [satelliteMode, activeTopics, cutoffMs, isRegionalZoom, prefsHydrated]);

  useEffect(() => {
    const refs = sceneRefs.current;
    if (refs) {
      refs.earthMat.uniforms.uFilterSmooth.value = filterSmooth ? 1.0 : 0.0;
    }
  }, [filterSmooth]);

  useEffect(() => {
    if (!isRegionalZoom) return;
    sceneRefs.current?.forceRegionalTileSync();
  }, [showPlaceLabels, isRegionalZoom]);

  // Render geodesic scale rings (2/10 km ground-city, 10/50 km metro, 50/150 km regional)
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    reconcileRegionalRings({
      refs,
      isRegionalZoom,
      regionalFocalCoord,
      hasSelectedOrProbedPin: Boolean(selectedGeoNode || probedCoord),
      depthTier: regionalHud.depthTier,
    });
  }, [
    isRegionalZoom,
    regionalFocalCoord.lat,
    regionalFocalCoord.lng,
    Boolean(selectedGeoNode),
    Boolean(probedCoord),
    regionalHud.depthTier,
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
      probedCoord,
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
    probedCoord,
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
    const curAlt = Math.max(0.008, base.radius - EARTH_RADIUS);
    const nextAlt =
      delta < 0
        ? Math.max(MIN_GLOBE_CAMERA_RADIUS - EARTH_RADIUS, curAlt * 0.34)
        : Math.min(330, Math.max(curAlt + 0.18, curAlt * 2.8));
    cameraTargetRef.current = {
      ...base,
      radius: EARTH_RADIUS + nextAlt,
    };
  };

  const resolveTargetSphericalCoord = () => {
    if (selectedGeoNode || probedCoord) {
      const vec = latLngToVector3(regionalFocalCoord.lat, regionalFocalCoord.lng, 1);
      return new THREE.Spherical().setFromVector3(vec);
    }
    const curSph = sceneRefs.current?.spherical;
    if (curSph) {
      return curSph.clone();
    }
    const vec = latLngToVector3(regionalFocalCoord.lat, regionalFocalCoord.lng, 1);
    return new THREE.Spherical().setFromVector3(vec);
  };

  const zoomToDepth = (targetRadius: number) => {
    const sph = resolveTargetSphericalCoord();
    cameraTargetRef.current = {
      theta: sph.theta,
      phi: Math.max(0.08, Math.min(Math.PI - 0.08, sph.phi)),
      radius: Math.max(MIN_GLOBE_CAMERA_RADIUS, Math.min(430, targetRadius)),
    };
    setAutoRotate(false);
  };

  const zoomToRegion = () => {
    zoomToDepth(DEFAULT_REGIONAL_FOCUS_RADIUS);
  };

  const cycleSatelliteZoom = () => {
    const r = sceneRefs.current?.spherical.radius ?? 270;
    if (r > 135) {
      zoomToDepth(DEFAULT_REGIONAL_FOCUS_RADIUS);
    } else if (r > 106) {
      zoomToDepth(DEFAULT_SATELLITE_METRO_RADIUS);
    } else if (r > 100.8) {
      zoomToDepth(DEFAULT_SATELLITE_CITY_RADIUS);
    } else if (r > 100.08) {
      zoomToDepth(DEFAULT_SATELLITE_STREET_RADIUS);
    } else {
      resetCamera();
    }
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

  const handleGlobeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const refs = sceneRefs.current;
    if (!refs) return;
    const stepTheta = 0.14;
    const stepPhi = 0.11;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      cameraTargetRef.current = null;
      refs.spherical.theta -= stepTheta;
      setAutoRotate(false);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      cameraTargetRef.current = null;
      refs.spherical.theta += stepTheta;
      setAutoRotate(false);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cameraTargetRef.current = null;
      refs.spherical.phi = Math.max(0.2, refs.spherical.phi - stepPhi);
      setAutoRotate(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      cameraTargetRef.current = null;
      refs.spherical.phi = Math.min(Math.PI - 0.2, refs.spherical.phi + stepPhi);
      setAutoRotate(false);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      adjustCameraRadius(-1);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      adjustCameraRadius(32);
    } else if (e.key === "0" || e.key === "Home") {
      e.preventDefault();
      resetCamera();
    }
  };

  return (
    <div className="etg-globe-void relative h-full w-full overflow-hidden select-none">
      <div
        ref={containerRef}
        tabIndex={0}
        role="region"
        onKeyDown={handleGlobeKeyDown}
        className="h-full w-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[var(--accent-fg)]"
        aria-label="Interactive 3D Earth Globe. Use Arrow keys to orbit, plus or minus to zoom, and Home to reset camera."
      />
      <GlobeHudOverlays
        nodes={nodes}
        microscopeScan={microscopeScan}
        microscopeByNode={microscopeByNode}
        probedCoord={probedCoord}
        compareMode={compareMode}
        inspectorOpen={inspectorOpen}
        inspectorWide={inspectorWide}
        mobileSheetExpanded={mobileSheetExpanded}
        enabledCategories={enabledCategories}
        onChangeEnabledCategories={onChangeEnabledCategories}
        tempUnit={tempUnit}
        onChangeTempUnit={onChangeTempUnit}
        activeTopics={activeTopics}
        timelineSlot={timelineSlot}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onProbeCoordinate={onProbeCoordinate}
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
        showPlaceLabels={showPlaceLabels}
        setShowPlaceLabels={setShowPlaceLabels}
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
        zoomOut={() => adjustCameraRadius(1)}
        zoomToRegion={zoomToRegion}
        zoomToDepth={zoomToDepth}
        cycleSatelliteZoom={cycleSatelliteZoom}
        onRetryRegionalTile={() => sceneRefs.current?.forceRegionalTileSync()}
        onFocusSunPresetCamera={onFocusSunPresetCamera}
      />
    </div>
  );
}
