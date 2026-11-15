import type React from "react";
import * as THREE from "three";
import { DATASET_BY_ID } from "@/lib/datasets";
import { buildGeodesicCircleLatLng } from "@/lib/earth/nasaGibsRegional";
import type { SatelliteDepthTier } from "@/lib/earth/satelliteZoomTiles";
import {
  convertSlopeUnitLabel,
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  isTemperatureUnitString,
} from "@/lib/earth/currentConditionsClient";
import { ETG_LABEL_PALETTE } from "@/lib/graph/graphVisuals";
import {
  classifyRelationCategory,
  formatRelationForDisplay,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import {
  EARTH_RADIUS,
  buildElevatedGreatCircleCurve,
  disposeGroupResources,
  intersectTrueEarthSphere,
  latLngToVector3,
  lngSpanDeg,
  resolveComparisonArcVisuals,
  selectVisibleGlobeArcs,
  vector3ToLatLng,
  type ComparisonArcVisualMeta,
  type GlobeArcMode,
  type GlobeSceneRefs,
  type HoveredGlobeInfo,
  type ProjectedArcLabel,
  type ProjectedProbeLabel,
  type ProjectedRegionalNodeLabel,
} from "@/components/globe/globeGeometryAndArcs";
import type {
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  RelationCategory,
  TemperatureUnit,
} from "@/types/etg";

/**
 * Reconciles 50 km MERRA-2 grid-scale & 150 km mesoscale surface geodesic rings
 * when the camera enters regional zoom.
 */
export function reconcileRegionalRings(params: {
  refs: GlobeSceneRefs;
  isRegionalZoom: boolean;
  regionalFocalCoord: { lat: number; lng: number };
  hasSelectedOrProbedPin: boolean;
  depthTier?: SatelliteDepthTier;
}): void {
  const {
    refs,
    isRegionalZoom,
    regionalFocalCoord,
    hasSelectedOrProbedPin,
    depthTier = "corridor",
  } = params;
  disposeGroupResources(refs.regionalGroup, refs.sharedTextures);
  refs.regionalGroup.visible = isRegionalZoom;
  if (!isRegionalZoom) return;

  const isGround = depthTier === "ground";
  const isCity = depthTier === "city";
  const isMetro = depthTier === "metro";
  const innerKm = isGround ? 0.25 : isCity ? 2 : isMetro ? 10 : 50;
  const outerKm = isGround ? 1 : isCity ? 10 : isMetro ? 50 : 150;
  const ringAltitude = isGround ? 0.00018 : isCity ? 0.007 : isMetro ? 0.045 : 0.26;
  const innerExtra = isGround ? 0.00005 : isCity ? 0.0015 : isMetro ? 0.006 : 0.015;
  const centerPlaneSize = isGround ? 0.0006 : isCity ? 0.022 : isMetro ? 0.11 : 1.5;

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

  addGeodesicRing(innerKm, ringAltitude + innerExtra, 0xfbbf24, 0.72, 72);
  addGeodesicRing(outerKm, ringAltitude, 0x38bdf8, 0.52, 88);

  if (!hasSelectedOrProbedPin) {
    const unitNormal = latLngToVector3(
      regionalFocalCoord.lat,
      regionalFocalCoord.lng,
      1
    ).normalize();
    const centerGeo = new THREE.PlaneGeometry(centerPlaneSize, centerPlaneSize);
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
    centerMesh.position.copy(
      unitNormal.clone().multiplyScalar(EARTH_RADIUS + ringAltitude + innerExtra * 1.2)
    );
    centerMesh.lookAt(unitNormal.clone().multiplyScalar(EARTH_RADIUS * 2));
    refs.regionalGroup.add(centerMesh);
  }
}

/**
 * Reconciles orbital beacons & 3D great-circle teleconnection splines inside the scene groups.
 */
export function reconcileMarkersAndArcs(params: {
  refs: GlobeSceneRefs;
  nodes: ETGNode[];
  edges: ETGEdge[];
  showPins: boolean;
  arcMode: GlobeArcMode;
  selectedNodeUuid: string | null;
  probedAnchorUuid: string | null;
  selectedEdgeUuid: string | null;
  cascadeEdgeUuids: string[];
  enabledCategories?: ReadonlyArray<RelationCategory>;
  isRegionalZoom: boolean;
  regBucketLat: number;
  regBucketLng: number;
}): void {
  const {
    refs,
    nodes,
    edges,
    showPins,
    arcMode,
    selectedNodeUuid,
    probedAnchorUuid,
    selectedEdgeUuid,
    cascadeEdgeUuids,
    enabledCategories,
    isRegionalZoom,
    regBucketLat,
    regBucketLng,
  } = params;

  disposeGroupResources(refs.markersGroup, refs.sharedTextures);
  disposeGroupResources(refs.arcsGroup, refs.sharedTextures);
  refs.markersGroup.visible = showPins;
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
    const surfAltOffset = isRegionalZoom ? 0.28 : 0.5;
    const beaconAltOffset = isRegionalZoom
      ? isEndpointFocused || node.label === "Insight"
        ? 1.45
        : node.label === "Concept"
          ? 1.05
          : 0.75
      : isEndpointFocused || node.label === "Insight"
        ? 3.4
        : node.label === "Concept"
          ? 2.3
          : 1.6;
    const surfacePos = unitNormal.clone().multiplyScalar(EARTH_RADIUS + surfAltOffset);
    const orbPos = unitNormal.clone().multiplyScalar(EARTH_RADIUS + beaconAltOffset);
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
    footprintMesh.userData.unitNormal = unitNormal.clone();
    footprintMesh.userData.baseAltOffset = surfAltOffset;
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
      pulseMesh.userData.unitNormal = unitNormal.clone();
      pulseMesh.userData.baseAltOffset = surfAltOffset + 0.12;
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
      const filamentLine = new THREE.Line(filamentGeo, filamentMat);
      filamentLine.userData.isFilament = true;
      filamentLine.userData.unitNormal = unitNormal.clone();
      filamentLine.userData.surfOffset = surfAltOffset;
      filamentLine.userData.orbOffset = beaconAltOffset;
      refs.markersGroup.add(filamentLine);
    }

    // 4. Radial Corona Billboard Sprite at Beacon Altitude
    const haloOpacity = (isSuperseded ? 0.4 : 0.8) * dimFactor;
    const spriteMat = new THREE.SpriteMaterial({
      map: refs.glowTex,
      color: colorHex,
      transparent: true,
      opacity: haloOpacity,
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
    haloSprite.userData.baseOpacity = haloOpacity;
    haloSprite.userData.phaseOffset = phaseOffset * Math.PI * 2;
    haloSprite.userData.unitNormal = unitNormal.clone();
    haloSprite.userData.baseAltOffset = beaconAltOffset;
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
    innerCore.userData.unitNormal = unitNormal.clone();
    innerCore.userData.baseAltOffset = beaconAltOffset;
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
    hitTarget.userData.isHitTarget = true;
    hitTarget.userData.unitNormal = unitNormal.clone();
    hitTarget.userData.baseAltOffset = beaconAltOffset;
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
    const coreOpacity = isFocusedArc ? 0.96 : hasActiveFocus ? 0.86 : 0.78;
    const tubeMat = new THREE.MeshBasicMaterial({
      color: arcColor,
      transparent: true,
      opacity: coreOpacity,
      depthWrite: false,
    });
    const arcCoreMesh = new THREE.Mesh(tubeGeo, tubeMat);
    arcCoreMesh.userData.baseOpacity = coreOpacity;
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
      const sleeveOpacity = isFocusedArc ? 0.24 : 0.12;
      const haloMat = new THREE.MeshBasicMaterial({
        color: arcColor,
        transparent: true,
        opacity: sleeveOpacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const haloMesh = new THREE.Mesh(haloGeo, haloMat);
      haloMesh.userData.baseOpacity = sleeveOpacity;
      refs.arcsGroup.add(haloMesh);
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
    arcHitMesh.userData.isArcHit = true;
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
      const travelerScale = isLocalCorridor
        ? isFocusedArc
          ? 1.45
          : 1.1
        : isFocusedArc
          ? 2.8
          : 2.1;
      const pulseSprite = new THREE.Sprite(pulseSpriteMat);
      pulseSprite.scale.setScalar(travelerScale);
      pulseSprite.userData.baseScale = travelerScale;
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
}

/**
 * Reconciles probe reticle(s) and volumetric comparison arc for 1-Pin / 2-Pin / Case-Study probes.
 */
export function reconcileProbeReticlesAndComparisonArc(params: {
  refs: GlobeSceneRefs;
  probedCoord: { lat: number; lng: number } | null;
  comparePinB: { lat: number; lng: number } | null;
  selectedEdgeUuid: string | null;
  comparisonArcMeta: ComparisonArcVisualMeta | null;
}): void {
  const { refs, probedCoord, comparePinB, selectedEdgeUuid, comparisonArcMeta } = params;

  disposeGroupResources(refs.probeGroup, refs.sharedTextures);
  refs.probeTravelers = [];
  refs.probeMidpoint = null;

  const initAlt = Math.max(0.008, refs.spherical.radius - EARTH_RADIUS);
  const initProbeScale = Math.min(1.0, initAlt / 185);
  const initGlowAtten = initAlt < 18 ? 0.55 + 0.45 * (initAlt / 18) : 1.0;

  const addProbeReticle = (coord: { lat: number; lng: number }, hexColor: number) => {
    const unitNormal = latLngToVector3(coord.lat, coord.lng, 1).normalize();
    const orbAlt = Math.max(0.00009, 1.15 * initProbeScale);
    const ringAlt = Math.max(0.00006, 0.55 * initProbeScale);

    const spriteMat = new THREE.SpriteMaterial({
      map: refs.glowTex,
      color: hexColor,
      transparent: true,
      opacity: 0.62 * initGlowAtten,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const probeOrb = new THREE.Sprite(spriteMat);
    probeOrb.position.copy(unitNormal.clone().multiplyScalar(EARTH_RADIUS + orbAlt));
    probeOrb.scale.setScalar(4.8 * initProbeScale);
    probeOrb.userData.unitNormal = unitNormal.clone();
    probeOrb.userData.baseAltOffset = 1.15;
    probeOrb.userData.baseSize = 4.8;
    probeOrb.userData.baseOpacity = 0.62;
    refs.probeGroup.add(probeOrb);

    const coreGeo = new THREE.SphereGeometry(0.34, 12, 12);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    const probeCore = new THREE.Mesh(coreGeo, coreMat);
    probeCore.position.copy(unitNormal.clone().multiplyScalar(EARTH_RADIUS + orbAlt));
    probeCore.scale.setScalar(initProbeScale);
    probeCore.userData.unitNormal = unitNormal.clone();
    probeCore.userData.baseAltOffset = 1.15;
    probeCore.userData.isProbeCore = true;
    refs.probeGroup.add(probeCore);

    const ringGeo = new THREE.PlaneGeometry(5.4, 5.4);
    const ringMat = new THREE.MeshBasicMaterial({
      map: refs.ringTex,
      color: hexColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72 * initGlowAtten,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(unitNormal.clone().multiplyScalar(EARTH_RADIUS + ringAlt));
    ring.lookAt(unitNormal.clone().multiplyScalar(EARTH_RADIUS * 2));
    ring.scale.setScalar(initProbeScale);
    ring.userData.probeRing = true;
    ring.userData.maxOpacity = 0.72;
    ring.userData.unitNormal = unitNormal.clone();
    ring.userData.baseAltOffset = 0.55;
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
      const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
      tubeMesh.userData.isComparisonTube = true;
      tubeMesh.userData.baseOpacity = 0.96;
      refs.probeGroup.add(tubeMesh);

      const haloGeo = new THREE.TubeGeometry(curve, 52, visuals.haloRadius, 8, false);
      const haloMat = new THREE.MeshBasicMaterial({
        color: visuals.colorHex,
        transparent: true,
        opacity: visuals.haloOpacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const compHaloMesh = new THREE.Mesh(haloGeo, haloMat);
      compHaloMesh.userData.isComparisonTube = true;
      compHaloMesh.userData.baseOpacity = visuals.haloOpacity;
      refs.probeGroup.add(compHaloMesh);

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
      pulseSprite.userData.baseScale = 2.6;
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
}

interface RaycastPickContext {
  raycaster: THREE.Raycaster;
  ndc: THREE.Vector2;
  camera: THREE.PerspectiveCamera;
  showPins: boolean;
  markersGroup: THREE.Group;
  arcsGroup: THREE.Group;
  earthMesh: THREE.Mesh;
  markerMap: Map<THREE.Object3D, ETGNode>;
  arcMap: Map<THREE.Object3D, ETGEdge>;
}

function pickGlobeSceneHit(ctx: RaycastPickContext):
  | { kind: "node"; node: ETGNode }
  | { kind: "edge"; edge: ETGEdge }
  | { kind: "earth"; point: THREE.Vector3 }
  | null {
  ctx.raycaster.setFromCamera(ctx.ndc, ctx.camera);

  if (ctx.showPins) {
    const markerHits = ctx.raycaster.intersectObjects(ctx.markersGroup.children, false);
    const markerHit = markerHits.find((h) => ctx.markerMap.has(h.object));
    if (markerHit) {
      const node = ctx.markerMap.get(markerHit.object);
      if (node) return { kind: "node", node };
    }
  }

  // Check front-hemisphere teleconnection arcs against true Earth sphere (avoids 124k-tri traversal & sagitta offset)
  const earthHitPoint = intersectTrueEarthSphere(ctx.raycaster.ray);
  const earthDist = earthHitPoint
    ? ctx.camera.position.distanceTo(earthHitPoint)
    : Infinity;
  const arcHits = ctx.raycaster.intersectObjects(ctx.arcsGroup.children, false);
  const arcHit = arcHits.find(
    (h) => ctx.arcMap.has(h.object) && h.distance <= earthDist + 2.5
  );
  if (arcHit) {
    const edge = ctx.arcMap.get(arcHit.object);
    if (edge) return { kind: "edge", edge };
  }

  if (earthHitPoint) {
    return { kind: "earth", point: earthHitPoint };
  }
  return null;
}

/**
 * Resolves hover tooltip metadata and cursor styling for markers and front-hemisphere arcs.
 */
export function resolveGlobePointerHover(
  ctx: RaycastPickContext & {
    clientX: number;
    clientY: number;
    containerRect: DOMRect;
    nodes: ETGNode[];
    microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  }
): { hovered: HoveredGlobeInfo | null; cursor: "pointer" | "grab" } {
  const hit = pickGlobeSceneHit(ctx);
  if (hit?.kind === "node") {
    const node = hit.node;
    const topicName = node.properties.dataset
      ? DATASET_BY_ID[node.properties.dataset]?.shortLabel
      : undefined;
    const regionLabel =
      node.properties.region && !node.properties.region.includes("°")
        ? node.properties.region
        : undefined;
    const cue = ctx.microscopeByNode?.[node.uuid];
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
    return {
      cursor: "pointer",
      hovered: {
        name: humanizeNodeText(node.properties.name),
        subtitle: [topicName, regionLabel].filter(Boolean).join(" · ") || "Earth observation",
        radarBadge,
        radarDetail,
        x: ctx.clientX - ctx.containerRect.left,
        y: ctx.clientY - ctx.containerRect.top,
      },
    };
  }

  if (hit?.kind === "edge") {
    const edge = hit.edge;
    const srcNode = ctx.nodes.find((n) => n.uuid === edge.source_uuid);
    const tgtNode = ctx.nodes.find((n) => n.uuid === edge.target_uuid);
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
    return {
      cursor: "pointer",
      hovered: {
        name: formatted
          ? `${formatted.badgeText}${edge.properties.mechanism ? ` · ${edge.properties.mechanism}` : ""}`
          : edge.properties.mechanism || "Linked Earth trends",
        subtitle: metaParts.join(" · "),
        x: ctx.clientX - ctx.containerRect.left,
        y: ctx.clientY - ctx.containerRect.top,
      },
    };
  }

  return { hovered: null, cursor: "grab" };
}

/**
 * Resolves click selection (node, front-hemisphere arc, or Earth surface coordinate probe).
 */
export function resolveGlobePointerClick(
  ctx: RaycastPickContext & {
    compareMode?: boolean;
    onSelectNode: (node: ETGNode) => void;
    onSelectEdge?: (edge: ETGEdge) => void;
    onProbeCoordinate: (lat: number, lng: number) => void;
  }
): void {
  const hit = pickGlobeSceneHit(ctx);
  if (ctx.compareMode) {
    if (
      hit?.kind === "node" &&
      typeof hit.node.properties.lat === "number" &&
      typeof hit.node.properties.lng === "number"
    ) {
      ctx.onProbeCoordinate(hit.node.properties.lat, hit.node.properties.lng);
      return;
    }
    if (hit?.kind === "earth") {
      const { lat, lng } = vector3ToLatLng(hit.point);
      ctx.onProbeCoordinate(lat, lng);
      return;
    }
    ctx.raycaster.setFromCamera(ctx.ndc, ctx.camera);
    const earthHit = intersectTrueEarthSphere(ctx.raycaster.ray);
    if (earthHit) {
      const { lat, lng } = vector3ToLatLng(earthHit);
      ctx.onProbeCoordinate(lat, lng);
    }
    return;
  }
  if (hit?.kind === "node") {
    ctx.onSelectNode(hit.node);
    return;
  }
  if (hit?.kind === "edge" && ctx.onSelectEdge) {
    ctx.onSelectEdge(hit.edge);
    return;
  }
  if (hit?.kind === "earth") {
    const { lat, lng } = vector3ToLatLng(hit.point);
    ctx.onProbeCoordinate(lat, lng);
  }
}

export interface OverlayLabelProjectionState {
  lastLabelSignature: string;
  lastProbeLabelSignature: string;
  lastNodeLabelSignature: string;
}

/**
 * Projects visible regional station pins, comparison probe callouts, and front-hemisphere
 * arc midpoint badges into screen coordinates with collision suppression.
 */
export function projectGlobeOverlayLabels(params: {
  state: OverlayLabelProjectionState;
  camera: THREE.PerspectiveCamera;
  spherical: THREE.Spherical;
  currentW: number;
  currentH: number;
  inspectorOpen: boolean;
  isRegionalZoom: boolean;
  showPins: boolean;
  showArcLabels: boolean;
  nodes: ETGNode[];
  selectedNodeUuid: string | null;
  tempUnit: TemperatureUnit;
  refs: GlobeSceneRefs | null;
  camUnitVec: THREE.Vector3;
  midUnitVec: THREE.Vector3;
  projVec: THREE.Vector3;
  tmpSphVec: THREE.Vector3;
  nodePosVec: THREE.Vector3;
  setProjectedNodeLabels: React.Dispatch<React.SetStateAction<ProjectedRegionalNodeLabel[]>>;
  setProjectedProbeLabel: React.Dispatch<React.SetStateAction<ProjectedProbeLabel | null>>;
  setProjectedArcLabels: React.Dispatch<React.SetStateAction<ProjectedArcLabel[]>>;
}): void {
  const {
    state,
    camera,
    spherical,
    currentW,
    currentH,
    inspectorOpen,
    isRegionalZoom,
    showPins,
    showArcLabels,
    nodes,
    selectedNodeUuid,
    tempUnit,
    refs,
    camUnitVec,
    midUnitVec,
    projVec,
    tmpSphVec,
    nodePosVec,
    setProjectedNodeLabels,
    setProjectedProbeLabel,
    setProjectedArcLabels,
  } = params;

  camera.updateMatrixWorld();
  camUnitVec.copy(camera.position).normalize();
  const rightCutoff = inspectorOpen && currentW >= 1024 ? currentW - 430 : currentW - 60;
  const occupiedBoxes: Array<{ x: number; y: number }> = [];

  // 1. Project nearby station badges when zoomed into a regional swath
  if (isRegionalZoom && showPins) {
    tmpSphVec.setFromSpherical(spherical);
    const subCenter = vector3ToLatLng(tmpSphVec);
    const nearby = nodes
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
        const aSel = a.uuid === selectedNodeUuid ? 1 : 0;
        const bSel = b.uuid === selectedNodeUuid ? 1 : 0;
        if (aSel !== bSel) return bSel - aSel;
        return (b.properties.importance ?? 0) - (a.properties.importance ?? 0);
      });

    const nextNodeLabels: ProjectedRegionalNodeLabel[] = [];
    const labelAltOffset = Math.min(
      1.2,
      Math.max(0.001, (spherical.radius - EARTH_RADIUS) * 0.05)
    );
    for (const node of nearby) {
      const nLat = node.properties.lat!;
      const nLng = node.properties.lng!;
      nodePosVec.copy(latLngToVector3(nLat, nLng, EARTH_RADIUS + labelAltOffset));
      midUnitVec.copy(nodePosVec).normalize();
      if (camUnitVec.dot(midUnitVec) < 0.25) continue;
      projVec.copy(nodePosVec).project(camera);
      if (projVec.z > 1) continue;
      const x = Math.round((projVec.x * 0.5 + 0.5) * currentW);
      const y = Math.round((-projVec.y * 0.5 + 0.5) * currentH);
      if (x < 72 || x > rightCutoff || y < 56 || y > currentH - 88) continue;
      // Keep clear of top-left Regional Satellite HUD card
      if (x < 405 && y < 210) continue;
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
          tempUnit === "F" && isC
            ? 1.8
            : tempUnit === "C" && isF
              ? 1 / 1.8
              : 1;
        const slopeVal = node.properties.theil_sen_slope * factor;
        const displayUnit =
          isC || isF ? convertSlopeUnitLabel(rawUnit, tempUnit) : rawUnit;
        metricText = `${slopeVal >= 0 ? "+" : ""}${slopeVal.toFixed(2)}${displayUnit ? ` ${displayUnit}` : ""}`;
      } else if (
        typeof node.properties.value === "number" &&
        Number.isFinite(node.properties.value)
      ) {
        const rawVal = node.properties.value;
        const rawUnit = node.properties.unit ?? "";
        const val = isTemperatureUnitString(rawUnit)
          ? convertTemperatureDisplayValue(rawVal, rawUnit, tempUnit)
          : rawVal;
        const displayUnit = isTemperatureUnitString(rawUnit)
          ? convertTemperatureUnitLabel(rawUnit, tempUnit)
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
        isSelected: node.uuid === selectedNodeUuid,
        node,
      });
      if (nextNodeLabels.length >= 8) break;
    }

    const nodeSig = nextNodeLabels
      .map((l) => `${l.uuid}:${Math.round(l.x / 3)}:${Math.round(l.y / 3)}:${l.isSelected ? 1 : 0}`)
      .join("|");
    if (nodeSig !== state.lastNodeLabelSignature) {
      state.lastNodeLabelSignature = nodeSig;
      setProjectedNodeLabels(nextNodeLabels);
    }
  } else if (state.lastNodeLabelSignature !== "") {
    state.lastNodeLabelSignature = "";
    setProjectedNodeLabels([]);
  }

  // 2. Project active 2-spot / case-study comparison arc callout & graph arc midpoints
  const activeProbeMid = refs?.probeMidpoint ?? null;
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
          if (nextProbeSig !== state.lastProbeLabelSignature) {
            state.lastProbeLabelSignature = nextProbeSig;
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
  if (nextProbeSig === "" && state.lastProbeLabelSignature !== "") {
    state.lastProbeLabelSignature = "";
    setProjectedProbeLabel(null);
  }

  if (!showArcLabels) {
    if (state.lastLabelSignature !== "off") {
      state.lastLabelSignature = "off";
      setProjectedArcLabels([]);
    }
  } else {
    const midpoints = refs?.arcMidpoints ?? [];
    if (midpoints.length === 0) {
      if (state.lastLabelSignature !== "empty") {
        state.lastLabelSignature = "empty";
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
        if (isRegionalZoom && x < 405 && y < 210) {
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
      if (sig !== state.lastLabelSignature) {
        state.lastLabelSignature = sig;
        setProjectedArcLabels(nextLabels);
      }
    }
  }
}
