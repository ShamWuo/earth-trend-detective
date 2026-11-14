"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Cloud, GitBranch, GitCompare, Sun } from "lucide-react";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import { DATASET_BY_ID } from "@/lib/datasets";
import { ETG_LABEL_PALETTE } from "@/lib/graph/graphVisuals";
import { humanizeNodeText } from "@/lib/plainLanguage";
import type { ETGEdge, ETGNode, ETGRelationshipType } from "@/types/etg";

export type GlobeArcMode = "focus" | "dipoles" | "off";

interface EarthGlobe3DProps {
  nodes: ETGNode[];
  edges: ETGEdge[];
  selectedNodeUuid: string | null;
  selectedEdgeUuid?: string | null;
  cascadeEdgeUuids?: string[];
  probedCoord: { lat: number; lng: number } | null;
  comparePinB?: { lat: number; lng: number } | null;
  compareMode?: boolean;
  inspectorOpen?: boolean;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onProbeCoordinate: (lat: number, lng: number) => void;
  onToggleCompareMode?: () => void;
}

const EDGE_TYPE_PRIORITY: Record<ETGRelationshipType, number> = {
  drives_opposite: 6,
  teleconnects: 5,
  correlates_with: 4,
  supersedes: 3,
  corroborates: 2,
  supports: 1,
  verified_by: 0,
  monitors: 0,
  relates_to: 0,
};

/**
 * Selects a clean, legible subset of great-circle arcs to render on the 3D globe
 * so unfocused views stay crisp and focused relations stand out without clutter.
 */
export function selectVisibleGlobeArcs(params: {
  nodes: ETGNode[];
  edges: ETGEdge[];
  mode: GlobeArcMode;
  selectedNodeUuid: string | null;
  selectedEdgeUuid: string | null;
  cascadeEdgeUuids: string[];
}): ETGEdge[] {
  const { nodes, edges, mode, selectedNodeUuid, selectedEdgeUuid, cascadeEdgeUuids } = params;
  const nodeById = new Map(nodes.map((n) => [n.uuid, n]));

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
    const dLng = Math.abs(src.properties.lng - tgt.properties.lng);
    return dLat >= 0.8 || dLng >= 0.8;
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

  if (selectedNodeUuid) {
    return geoEdges
      .filter((e) => e.source_uuid === selectedNodeUuid || e.target_uuid === selectedNodeUuid)
      .sort((a, b) => {
        const prioDiff = (EDGE_TYPE_PRIORITY[b.type] ?? 0) - (EDGE_TYPE_PRIORITY[a.type] ?? 0);
        if (prioDiff !== 0) return prioDiff;
        return Math.abs(b.properties.correlation_r ?? 0) - Math.abs(a.properties.correlation_r ?? 0);
      })
      .slice(0, 6);
  }

  if (mode === "focus") {
    return [];
  }

  // Dipoles overview mode: at most 6 spatially distinct high-|r| dipoles/teleconnections
  const ranked = geoEdges
    .filter(
      (e) =>
        (e.type === "drives_opposite" || e.type === "teleconnects") &&
        Math.abs(e.properties.correlation_r ?? 0) >= 0.55
    )
    .sort(
      (a, b) => Math.abs(b.properties.correlation_r ?? 0) - Math.abs(a.properties.correlation_r ?? 0)
    );

  const seenBuckets = new Set<string>();
  const picked: ETGEdge[] = [];
  for (const edge of ranked) {
    const src = nodeById.get(edge.source_uuid)!;
    const tgt = nodeById.get(edge.target_uuid)!;
    const bA = `${Math.round((src.properties.lat ?? 0) / 10)},${Math.round((src.properties.lng ?? 0) / 10)}`;
    const bB = `${Math.round((tgt.properties.lat ?? 0) / 10)},${Math.round((tgt.properties.lng ?? 0) / 10)}`;
    const pairKey = bA < bB ? `${bA}|${bB}` : `${bB}|${bA}`;
    if (seenBuckets.has(pairKey)) continue;
    seenBuckets.add(pairKey);
    picked.push(edge);
    if (picked.length >= 6) break;
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
  segments = 64
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
  }

  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const maxLift = Math.min(13, 1.8 + omega * 3.8);
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
    const r = EARTH_RADIUS + 0.85 + Math.sin(t * Math.PI) * maxLift;
    pts.push(dir.multiplyScalar(r));
  }
  return pts;
}

function disposeGroupResources(group: THREE.Group, skipTextures: Set<THREE.Texture>) {
  while (group.children.length > 0) {
    const obj = group.children[0];
    group.remove(obj);
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose());
      } else {
        obj.material?.dispose();
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

type SunPreset = "live" | "americas" | "eurasia" | "night";

function computeSunDirection(preset: SunPreset): THREE.Vector3 {
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
  // Live UTC approximate solar subpoint (declination + hour angle)
  const now = new Date();
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - startOfYear) / 86_400_000);
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const subsolarLng = (12 - utcHours) * 15;
  return latLngToVector3(decl, subsolarLng, 1).normalize();
}

export function EarthGlobe3D({
  nodes,
  edges,
  selectedNodeUuid,
  selectedEdgeUuid = null,
  cascadeEdgeUuids = [],
  probedCoord,
  comparePinB = null,
  compareMode = false,
  inspectorOpen = false,
  onSelectNode,
  onSelectEdge,
  onProbeCoordinate,
  onToggleCompareMode,
}: EarthGlobe3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [sunPreset, setSunPreset] = useState<SunPreset>("americas");
  const [showClouds, setShowClouds] = useState(false);
  const [arcMode, setArcMode] = useState<GlobeArcMode>("focus");
  const [hoveredInfo, setHoveredInfo] = useState<{
    name: string;
    subtitle: string;
    x: number;
    y: number;
  } | null>(null);

  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const showCloudsRef = useRef(showClouds);
  showCloudsRef.current = showClouds;
  const inspectorOpenRef = useRef(inspectorOpen);
  inspectorOpenRef.current = inspectorOpen;

  const callbacksRef = useRef({ onSelectNode, onSelectEdge, onProbeCoordinate });
  callbacksRef.current = { onSelectNode, onSelectEdge, onProbeCoordinate };
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const cameraTargetRef = useRef<{ theta: number; phi: number; radius: number } | null>(null);

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
    const node = nodes.find((n) => n.uuid === selectedNodeUuid);
    if (node?.properties.lat !== undefined && node.properties.lng !== undefined) {
      const vec = latLngToVector3(node.properties.lat, node.properties.lng, 1);
      const spherical = new THREE.Spherical().setFromVector3(vec);
      cameraTargetRef.current = {
        theta: spherical.theta,
        phi: Math.max(0.28, Math.min(Math.PI - 0.28, spherical.phi)),
        radius: 232,
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
    markerMap: Map<THREE.Object3D, ETGNode>;
    arcMap: Map<THREE.Object3D, ETGEdge>;
    spherical: THREE.Spherical;
    glowTex: THREE.CanvasTexture;
    ringTex: THREE.CanvasTexture;
    sharedTextures: Set<THREE.Texture>;
    arcTravelers: PulseTraveler[];
  } | null>(null);

  // Toggle 3D cloud deck & surface cloud-shadow uniform live without recreating scene
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    refs.cloudMesh.visible = showClouds;
    refs.earthMat.uniforms.uCloudsEnabled.value = showClouds ? 1.0 : 0.0;
  }, [showClouds]);

  // Update sun vector live across surface, clouds, and Rayleigh limb when preset changes
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const dir = computeSunDirection(sunPreset);
    (refs.earthMat.uniforms.uSunDir.value as THREE.Vector3).copy(dir);
    (refs.cloudMat.uniforms.uSunDir.value as THREE.Vector3).copy(dir);
    (refs.atmoMat.uniforms.uSunDir.value as THREE.Vector3).copy(dir);
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
    const topologyTex = configureEquirect(loader.load("/textures/earth/earth-topology.png"), false);
    const lightsTex = configureEquirect(loader.load("/textures/earth/earth-lights-2k.png"), true);
    const nightTex = configureEquirect(loader.load("/textures/earth/earth-night.jpg"), true);
    const cloudsTex = configureEquirect(loader.load("/textures/earth/earth-clouds.png"), true);

    const glowTex = createRadialGlowTexture();
    const ringTex = createRingReticleTexture();
    const starTex = createStarSpriteTexture();
    const sharedTextures = new Set<THREE.Texture>([glowTex, ringTex, starTex]);

    const sunDirection = computeSunDirection("americas");

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
        uTopoMap: { value: topologyTex },
        uLightsMap: { value: lightsTex },
        uNightMap: { value: nightTex },
        uCloudMap: { value: cloudsTex },
        uSunDir: { value: sunDirection.clone() },
        uCloudDriftU: { value: 0.0 },
        uCloudsEnabled: { value: showCloudsRef.current ? 1.0 : 0.0 },
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
        uniform sampler2D uTopoMap;
        uniform sampler2D uLightsMap;
        uniform sampler2D uNightMap;
        uniform sampler2D uCloudMap;
        uniform vec3 uSunDir;
        uniform float uCloudDriftU;
        uniform float uCloudsEnabled;
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

          vec3 L = normalize(uSunDir);
          vec3 V = normalize(cameraPosition - vWorldPos);
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
          float daylightTerm = smoothstep(-0.06, 0.42, sphereSunDot);
          float twilightBell = exp(-pow((sphereSunDot + 0.015) * 6.8, 2.0));
          vec3 directSolarTint = mix(vec3(1.0, 0.56, 0.28), vec3(1.04, 1.01, 0.97), smoothstep(0.0, 0.36, sphereSunDot));

          vec3 albedo = texture2D(uDayMap, vUv).rgb;
          // Deepen pelagic ocean sapphire while keeping continental shelves & turquoise atolls luminous
          albedo = mix(albedo, albedo * vec3(0.76, 0.88, 1.08), waterMask * 0.36);

          // Diffuse reflectance (shadowed beneath 3D clouds)
          float directAtten = wrappedSun * (1.0 - cloudShadow * 0.40) * daylightTerm;
          vec3 ambientSky = albedo * mix(vec3(0.009, 0.014, 0.028), vec3(0.035, 0.055, 0.095), smoothstep(-0.18, 0.45, sphereSunDot));
          vec3 diffuse = albedo * directSolarTint * directAtten * 1.16 + ambientSky;

          // Dual-lobe solar ocean sunglint + ocean Fresnel sky reflection (occluded by clouds!)
          vec3 H = normalize(L + V);
          float NdotH = max(dot(normalize(mix(N0, N, 0.35)), H), 0.0);
          float sunVisibility = smoothstep(-0.02, 0.26, sphereSunDot) * (1.0 - cloudShadow * 0.72);
          float tightGlint = pow(NdotH, 340.0) * 1.05;
          float waveScatter = pow(NdotH, 26.0) * 0.085;
          vec3 solarGlint = vec3(1.0, 0.95, 0.86) * (tightGlint + waveScatter) * waterMask * sunVisibility;

          float fresnel = pow(1.0 - NdotV, 4.4);
          vec3 oceanSkyRefl = vec3(0.14, 0.38, 0.72) * fresnel * waterMask * smoothstep(-0.18, 0.55, sphereSunDot) * 0.28;

          // Rayleigh sunlit horizon scatter & warm Mie sunset glow right across the terminator
          float horizonRim = pow(1.0 - NdotV, 3.2);
          vec3 rayleighVeil = vec3(0.24, 0.54, 0.96) * horizonRim * smoothstep(-0.08, 0.58, sphereSunDot) * 0.34;
          vec3 mieTerminator = vec3(0.98, 0.44, 0.14) * twilightBell * (0.09 + 0.16 * landMask + 0.22 * horizonRim);

          // Crisp VIIRS Night City Lights on dark hemisphere (occluded gently under dense clouds)
          float nightMask = smoothstep(0.08, -0.22, sphereSunDot);
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
          float dayFade = smoothstep(-0.14, 0.48, sunTerm);
          float sunsetBand = exp(-pow((sunTerm + 0.01) * 7.2, 2.0));

          vec3 cloudRgb = mix(vec3(0.06, 0.09, 0.16), vec3(0.97, 0.985, 1.0), dayFade);
          cloudRgb = mix(cloudRgb, vec3(1.0, 0.62, 0.34), sunsetBand * 0.55);

          float alpha = cloudDensity * mix(0.14, 0.44, dayFade);
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
        varying vec3 vWorldNormal;
        varying vec3 vViewPos;
        void main() {
          vec3 N = normalize(vWorldNormal);
          vec3 V = normalize(cameraPosition - N * ${EARTH_RADIUS.toFixed(1)});
          float rim = 1.0 - max(dot(N, V), 0.0);
          float sunSide = smoothstep(-0.28, 0.62, dot(N, normalize(uSunDir)));
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
        varying vec3 vViewNormal;
        varying vec3 vWorldNormal;
        void main() {
          float rim = pow(clamp(0.64 - dot(normalize(vViewNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.4);
          float sunDot = dot(normalize(vWorldNormal), normalize(uSunDir));
          float sunlit = smoothstep(-0.36, 0.62, sunDot);
          float sunsetEdge = exp(-pow(sunDot * 5.2, 2.0));
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
    const arcsGroup = new THREE.Group();
    const probeGroup = new THREE.Group();
    scene.add(arcsGroup);
    scene.add(markersGroup);
    scene.add(probeGroup);

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
      markerMap,
      arcMap,
      spherical,
      glowTex,
      ringTex,
      sharedTextures,
      arcTravelers: [],
    };

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
        spherical.theta -= dx * 0.0055;
        spherical.phi = Math.max(0.18, Math.min(Math.PI - 0.18, spherical.phi - dy * 0.0055));
        setHoveredInfo(null);
        return;
      }

      const ndc = getNormalizedCoords(e.clientX, e.clientY);
      raycaster.setFromCamera(ndc, camera);
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
          setHoveredInfo({
            name: humanizeNodeText(node.properties.name),
            subtitle: [topicName, regionLabel].filter(Boolean).join(" · ") || "Earth observation",
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
          renderer.domElement.style.cursor = "pointer";
          return;
        }
      }

      // Check front-hemisphere teleconnection arcs (guard against picking far-side arcs through globe)
      const earthHitsHover = raycaster.intersectObject(earthMesh, false);
      const earthDistHover = earthHitsHover.length > 0 ? earthHitsHover[0].distance : Infinity;
      const arcHitsHover = raycaster.intersectObjects(arcsGroup.children, false);
      const arcHitHover = arcHitsHover.find(
        (h) => arcMap.has(h.object) && h.distance <= earthDistHover + 2.0
      );
      if (arcHitHover) {
        const edge = arcMap.get(arcHitHover.object);
        if (edge) {
          const rect = container.getBoundingClientRect();
          const srcName =
            nodesRef.current.find((n) => n.uuid === edge.source_uuid)?.properties.region ||
            "Spot A";
          const tgtName =
            nodesRef.current.find((n) => n.uuid === edge.target_uuid)?.properties.region ||
            "Spot B";
          const linkKind =
            edge.type === "drives_opposite" ? "Opposite trends" : "Linked trends";
          setHoveredInfo({
            name: edge.properties.mechanism || linkKind,
            subtitle: `${srcName} ↔ ${tgtName}`,
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

      const markerHits = raycaster.intersectObjects(markersGroup.children, false);
      const markerHit = markerHits.find((h) => markerMap.has(h.object));
      if (markerHit) {
        const node = markerMap.get(markerHit.object);
        if (node) {
          callbacksRef.current.onSelectNode(node);
          return;
        }
      }

      const earthHits = raycaster.intersectObject(earthMesh, false);
      const earthDist = earthHits.length > 0 ? earthHits[0].distance : Infinity;
      const arcHits = raycaster.intersectObjects(arcsGroup.children, false);
      const arcHit = arcHits.find(
        (h) => arcMap.has(h.object) && h.distance <= earthDist + 2.0
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
      spherical.radius = Math.max(145, Math.min(430, spherical.radius + e.deltaY * 0.16));
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
    const clock = new THREE.Clock();
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();

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
        if (Math.abs(dTheta) < 0.005 && Math.abs(t.phi - spherical.phi) < 0.005) {
          cameraTargetRef.current = null;
        }
      } else if (autoRotateRef.current && !isDragging) {
        spherical.theta += 0.0012;
      }

      const targetOffsetX =
        inspectorOpenRef.current && currentW >= 1024
          ? Math.round(Math.min(368, currentW * 0.30) * 0.34)
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

      // Animate traveling light pulses along teleconnection splines
      const travelers = sceneRefs.current?.arcTravelers ?? [];
      for (const tr of travelers) {
        const u = (elapsed * tr.speed + tr.phase) % 1;
        const fIdx = u * (tr.pts.length - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(tr.pts.length - 1, i0 + 1);
        const frac = fIdx - i0;
        tr.sprite.position.lerpVectors(tr.pts[i0], tr.pts[i1], frac);
      }

      camera.position.setFromSpherical(spherical);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
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
        disposeGroupResources(markersGroup, sharedTextures);
        disposeGroupResources(arcsGroup, sharedTextures);
        disposeGroupResources(probeGroup, sharedTextures);
      }
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
      topologyTex.dispose();
      waterTex.dispose();
      lightsTex.dispose();
      nightTex.dispose();
      cloudsTex.dispose();
      glowTex.dispose();
      ringTex.dispose();
      starTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRefs.current = null;
    };
  }, []);

  // Reconcile Orbital Beacons & Clean Teleconnection Splines when nodes/edges/selection change
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;

    disposeGroupResources(refs.markersGroup, refs.sharedTextures);
    disposeGroupResources(refs.arcsGroup, refs.sharedTextures);
    refs.markerMap.clear();
    refs.arcMap.clear();
    refs.arcTravelers = [];

    const visibleArcs = selectVisibleGlobeArcs({
      nodes,
      edges,
      mode: arcMode,
      selectedNodeUuid,
      selectedEdgeUuid,
      cascadeEdgeUuids,
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

      const unitNormal = latLngToVector3(lat, lng, 1).normalize();
      const surfacePos = unitNormal.clone().multiplyScalar(EARTH_RADIUS + 0.5);
      const beaconAltitude =
        isEndpointFocused || node.label === "Insight"
          ? EARTH_RADIUS + 3.4
          : node.label === "Concept"
            ? EARTH_RADIUS + 2.3
            : EARTH_RADIUS + 1.6;
      const orbPos = unitNormal.clone().multiplyScalar(beaconAltitude);
      const phaseOffset = (idx * 0.27) % 1;

      // 1. Tangent Surface Footprint Reticle (compact precision scale)
      const footprintSize = isEndpointFocused ? 3.2 : 2.0;
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
        const pulseGeo = new THREE.PlaneGeometry(3.2, 3.2);
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
      const baseScale = isEndpointFocused
        ? 3.8
        : node.label === "Insight"
          ? 2.3
          : 1.7;
      haloSprite.position.copy(orbPos);
      haloSprite.scale.setScalar(baseScale);
      haloSprite.userData.haloSprite = true;
      haloSprite.userData.baseScale = baseScale;
      haloSprite.userData.phaseOffset = phaseOffset * Math.PI * 2;
      refs.markersGroup.add(haloSprite);

      // 5. Crisp Inner Diamond-White Pin Core
      const innerGeo = new THREE.SphereGeometry(
        isEndpointFocused ? 0.56 : node.label === "Insight" ? 0.42 : 0.32,
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
      const targetGeo = new THREE.SphereGeometry(isEndpointFocused ? 3.8 : 3.1, 10, 10);
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

      const pts = buildElevatedGreatCircleCurve(
        src.properties.lat,
        src.properties.lng,
        tgt.properties.lat,
        tgt.properties.lng,
        64
      );

      const arcGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const isOpposite = edge.type === "drives_opposite";
      const isSupersedes = edge.type === "supersedes";
      const isCoTrending = edge.type === "correlates_with" || edge.type === "teleconnects";
      const isEdgeSelected = selectedEdgeUuid === edge.properties.uuid;
      const isInCascade = cascadeEdgeUuids.includes(edge.properties.uuid);

      const arcColor = isEdgeSelected
        ? 0xfef08a
        : isInCascade
          ? 0xfbbf24
          : isOpposite
            ? 0xfb7185
            : isSupersedes
              ? 0xf59e0b
              : isCoTrending
                ? 0x38bdf8
                : 0x34d399;

      const arcMat = new THREE.LineBasicMaterial({
        color: arcColor,
        transparent: true,
        blending: THREE.NormalBlending,
        depthTest: true,
        depthWrite: false,
        opacity: hasActiveFocus ? 0.92 : isOpposite ? 0.72 : 0.62,
      });
      const arcLine = new THREE.Line(arcGeo, arcMat);
      refs.arcsGroup.add(arcLine);
      refs.arcMap.set(arcLine, edge);

      // Spawn a single gentle pulse sprite only along actively focused arcs
      if (hasActiveFocus) {
        const pulseSpriteMat = new THREE.SpriteMaterial({
          map: refs.glowTex,
          color: arcColor,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const pulseSprite = new THREE.Sprite(pulseSpriteMat);
        pulseSprite.scale.setScalar(2.6);
        pulseSprite.position.copy(pts[0]);
        refs.arcsGroup.add(pulseSprite);
        refs.arcTravelers.push({
          sprite: pulseSprite,
          pts,
          speed: 0.28,
          phase: (eIdx * 0.31) % 1,
        });
      }
    });
  }, [nodes, edges, arcMode, selectedNodeUuid, selectedEdgeUuid, cascadeEdgeUuids]);

  // Render Sleek Surface Probe Reticle(s) + Live Comparison Arc for 1-Pin / 2-Pin Earth Probe
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;

    disposeGroupResources(refs.probeGroup, refs.sharedTextures);

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

    if (probedCoord) addProbeReticle(probedCoord, 0xfacc15);
    if (comparePinB) addProbeReticle(comparePinB, 0x22d3ee);

    if (probedCoord && comparePinB && !selectedEdgeUuid) {
      const curvePts = buildElevatedGreatCircleCurve(
        probedCoord.lat,
        probedCoord.lng,
        comparePinB.lat,
        comparePinB.lng,
        72
      );
      const cmpGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
      const cmpMat = new THREE.LineBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      refs.probeGroup.add(new THREE.Line(cmpGeo, cmpMat));
    }
  }, [probedCoord, comparePinB, selectedEdgeUuid]);

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
    cameraTargetRef.current = { ...base, radius: Math.max(135, base.radius - 32) };
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

  const sunLabels: Record<SunPreset, string> = {
    americas: "Americas",
    eurasia: "Eurasia",
    live: "UTC",
    night: "Night",
  };

  const arcLabels: Record<GlobeArcMode, string> = {
    focus: "Links: Selected",
    dipoles: "Links: Top 6",
    off: "Links: Off",
  };

  const cycleArcMode = () => {
    setArcMode((prev) => (prev === "focus" ? "dipoles" : prev === "dipoles" ? "off" : "focus"));
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden select-none"
      style={{
        background: "radial-gradient(circle at 50% 50%, #0b1930 0%, #050b18 58%, #02040a 100%)",
      }}
    >
      <div ref={containerRef} className="h-full w-full" aria-label="Interactive 3D Earth Globe" />

      {/* Left-Edge Vertical Camera Dock */}
      <div className="absolute left-6 top-1/2 z-10 -translate-y-1/2">
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

      {/* Bottom-Left Single-Row Globe Control Pill (clear of Next badge and centered TimelineScrubber) */}
      <div className="absolute bottom-6 left-14 z-10 flex flex-col items-start gap-2">
        {probedCoord && !inspectorOpen && (
          <div className="etg-hud-pill ws-numeric inline-flex items-center gap-2 rounded-full px-3.5 py-1 font-mono text-[11px] text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            <span>
              Probe{" "}
              {probedCoord.lat >= 0 ? `${probedCoord.lat.toFixed(2)}°N` : `${Math.abs(probedCoord.lat).toFixed(2)}°S`},{" "}
              {probedCoord.lng >= 0 ? `${probedCoord.lng.toFixed(2)}°E` : `${Math.abs(probedCoord.lng).toFixed(2)}°W`}
            </span>
          </div>
        )}

        <div className="etg-hud-pill inline-flex items-center gap-0.5 rounded-full p-1 text-[11px]">
          <button
            type="button"
            aria-pressed={showClouds}
            onClick={() => setShowClouds((v) => !v)}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              showClouds
                ? "bg-accent/18 text-accent-fg"
                : "text-text-muted hover:bg-surface-band hover:text-text-primary"
            }`}
          >
            <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Clouds</span>
          </button>

          <button
            type="button"
            onClick={cycleArcMode}
            aria-label={arcLabels[arcMode]}
            title="Show connection lines: Selected spot, Top 6 global links, or Off"
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              arcMode === "dipoles"
                ? "bg-sky-500/18 text-sky-300"
                : arcMode === "off"
                  ? "text-text-subtle hover:bg-surface-band hover:text-text-primary"
                  : "text-text-muted hover:bg-surface-band hover:text-text-primary"
            }`}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{arcLabels[arcMode]}</span>
          </button>

          {onToggleCompareMode && (
            <button
              type="button"
              aria-pressed={Boolean(compareMode)}
              onClick={onToggleCompareMode}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                compareMode
                  ? "bg-cyan-500/20 text-cyan-200"
                  : "text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Compare</span>
            </button>
          )}

          <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />

          <button
            type="button"
            popoverTarget="etg-sun-popover"
            title="Solar illumination preset"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <Sun className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
            <span>{sunLabels[sunPreset]}</span>
          </button>
        </div>

        {/* Upward Lighting Popover */}
        <div
          id="etg-sun-popover"
          popover="auto"
          className="etg-popover etg-popover-up w-48 space-y-1.5 p-2.5"
        >
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Solar Lighting
          </div>
          {(
            [
              { id: "americas", label: "Americas" },
              { id: "eurasia", label: "Eurasia" },
              { id: "live", label: "Live UTC" },
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
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                sunPreset === opt.id
                  ? "bg-accent/18 text-accent-fg"
                  : "text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <span>{opt.label}</span>
              {sunPreset === opt.id && (
                <span className="h-1.5 w-1.5 rounded-full bg-accent-fg" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Hover Tooltip */}
      {hoveredInfo && (
        <div
          className="etg-hud-pill pointer-events-none absolute z-20 max-w-xs rounded-xl px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(hoveredInfo.x + 14, (containerRef.current?.clientWidth ?? 600) - 240),
            top: Math.max(12, hoveredInfo.y - 46),
          }}
        >
          <div className="font-medium text-text-primary">{hoveredInfo.name}</div>
          <div className="mt-0.5 text-[11px] text-text-muted">{hoveredInfo.subtitle}</div>
        </div>
      )}
    </div>
  );
}
