import { normalizeEarthCoordinates } from "@/lib/earth/coordinates";
import {
  REGIONAL_ZOOM_EXIT_RADIUS,
  type RegionalSatelliteMode,
} from "@/lib/earth/nasaGibsRegional";
import type { ETGDatasetId } from "@/types/etg";

export const AERIAL_IMAGERY_ENDPOINT =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
export const AERIAL_LABELS_ENDPOINT =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile";
export const WEB_MERCATOR_MAX_LAT = 85.05112878;
export const MAX_AERIAL_SLIPPY_ZOOM = 18;
export const MAX_AERIAL_LABELS_ZOOM = 17;
export const DEFAULT_AERIAL_GRID_SIZE = 12;
export const BACKDROP_AERIAL_GRID_SIZE = 10;

export type SatelliteDepthTier =
  | "mesoscale"
  | "corridor"
  | "metro"
  | "city"
  | "ground";

export interface AerialSlippyTileCell {
  colOffset: number;
  rowOffset: number;
  z: number;
  x: number;
  y: number;
  imageryUrl: string;
  labelsUrl: string | null;
}

export interface AerialSlippyMosaicSpec {
  key: string;
  zoom: number;
  cols: number;
  rows: number;
  tileSize: 256;
  width: number;
  height: number;
  xStart: number;
  yStart: number;
  /** [mercXMin, mercYMin, mercXMax, mercYMax] in normalized [0..1] Web Mercator space (xStart may wrap antimeridian). */
  mercBounds: [number, number, number, number];
  includeLabels: boolean;
  resolutionLabel: string;
  tiles: AerialSlippyTileCell[];
}

/**
 * Converts geographic (lat, lng) to normalized Web Mercator coordinates [0..1],
 * with mercY=0 at the northern boundary (+85.0511°) and mercY=1 at the southern boundary (-85.0511°).
 */
export function latLngToNormalizedMercator(
  lat: number,
  lng: number
): { mercX: number; mercY: number } {
  const norm = normalizeEarthCoordinates(lat, lng, {
    poleGuardMargin: 0,
    antimeridianMargin: 0,
  });
  const clampedLat = Math.max(-85.05, Math.min(85.05, norm.lat));
  const mercX = (norm.lng + 180) / 360;
  const latRad = (clampedLat * Math.PI) / 180;
  const mercY =
    (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) * 0.5;
  return { mercX, mercY };
}

/**
 * Selects an optimal Web Mercator slippy zoom level (z = 4 .. 18) for the current globe camera radius and latitude.
 */
export function selectAerialSlippyZoom(
  cameraRadius: number,
  lat: number
): number {
  const alt = Math.max(0.01, cameraRadius - 100);
  const cosLat = Math.max(
    0.25,
    Math.cos((Math.min(82, Math.abs(lat)) * Math.PI) / 180)
  );
  const raw = Math.floor(Math.log2((4200 * cosLat) / alt));
  return Math.max(4, Math.min(MAX_AERIAL_SLIPPY_ZOOM, raw));
}

/**
 * Maps camera radius to a semantic depth tier for HUD readouts and geodesic scale rings.
 */
export function resolveSatelliteDepthTier(
  cameraRadius: number
): SatelliteDepthTier {
  if (cameraRadius <= 100.09) return "ground";
  if (cameraRadius <= 101.8) return "city";
  if (cameraRadius <= 114) return "metro";
  if (cameraRadius <= 146) return "corridor";
  return "mesoscale";
}

/**
 * Estimates camera altitude above Earth's mean surface (km) from the Three.js spherical radius (EARTH_RADIUS = 100).
 */
export function estimateCameraAltitudeKm(cameraRadius: number): number {
  const altKm = Math.max(0.1, (cameraRadius - 100) * 63.71);
  return altKm >= 10 ? Math.round(altKm) : Number(altKm.toFixed(1));
}

/**
 * Formats ground pixel resolution (m/px or km/px) at a given slippy zoom level and latitude.
 */
export function estimateSlippyGroundResolutionLabel(
  zoom: number,
  lat: number
): string {
  const cosLat = Math.max(
    0.2,
    Math.cos((Math.min(82, Math.abs(lat)) * Math.PI) / 180)
  );
  const mPerPx = (156543.03392 * cosLat) / Math.pow(2, zoom);
  if (mPerPx >= 1000) {
    return `${(mPerPx / 1000).toFixed(1)} km/px`;
  }
  if (mPerPx >= 10) {
    return `${Math.round(mPerPx)} m/px`;
  }
  if (mPerPx >= 1) {
    return `${mPerPx.toFixed(1)} m/px`;
  }
  return `${mPerPx.toFixed(2)} m/px`;
}

/**
 * Builds an ArcGIS REST MapServer tile URL. Note ArcGIS order is {z}/{y}/{x} (row before column).
 */
export function buildArcGisSlippyTileUrl(
  endpoint: string,
  z: number,
  x: number,
  y: number
): string {
  return `${endpoint}/${z}/${y}/${x}`;
}

/**
 * Computes a center-outward sorted Web Mercator slippy tile mosaic specification (default 12x12 = 3072x3072 px)
 * centered around (lat, lng), supporting antimeridian wrapping and skipping empty label layers above z17.
 */
export function computeAerialSlippyMosaicSpec(params: {
  lat: number;
  lng: number;
  cameraRadius: number;
  includeLabels: boolean;
  zoomOverride?: number;
  gridSize?: number;
}): AerialSlippyMosaicSpec | null {
  const { lat, lng, cameraRadius, includeLabels, zoomOverride, gridSize } = params;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(cameraRadius) ||
    cameraRadius > REGIONAL_ZOOM_EXIT_RADIUS ||
    Math.abs(lat) > 85.05
  ) {
    return null;
  }

  const rawZoom = zoomOverride ?? selectAerialSlippyZoom(cameraRadius, lat);
  const zoom = Math.max(4, Math.min(MAX_AERIAL_SLIPPY_ZOOM, Math.round(rawZoom)));
  const effectiveIncludeLabels = includeLabels && zoom <= MAX_AERIAL_LABELS_ZOOM;
  const n = 1 << zoom;
  const requestedGrid = Math.max(
    4,
    Math.min(16, Math.round(gridSize ?? DEFAULT_AERIAL_GRID_SIZE))
  );
  const evenGrid = requestedGrid % 2 === 0 ? requestedGrid : requestedGrid + 1;
  const cols = Math.min(n, evenGrid);
  const rows = Math.min(n, evenGrid);
  const tileSize = 256 as const;
  const width = cols * tileSize;
  const height = rows * tileSize;

  const { mercX, mercY } = latLngToNormalizedMercator(lat, lng);
  const centerTileX = Math.min(n - 1, Math.max(0, Math.floor(mercX * n)));
  const centerTileY = Math.min(n - 1, Math.max(0, Math.floor(mercY * n)));

  const halfCols = Math.floor(cols / 2);
  const halfRows = Math.floor(rows / 2);
  const xStart = centerTileX - halfCols;
  const yStart = Math.max(0, Math.min(n - rows, centerTileY - halfRows));

  const mercBounds: [number, number, number, number] = [
    xStart / n,
    yStart / n,
    (xStart + cols) / n,
    (yStart + rows) / n,
  ];

  const tiles: AerialSlippyTileCell[] = [];
  for (let rowOffset = 0; rowOffset < rows; rowOffset++) {
    const y = yStart + rowOffset;
    for (let colOffset = 0; colOffset < cols; colOffset++) {
      const x = (((xStart + colOffset) % n) + n) % n;
      tiles.push({
        colOffset,
        rowOffset,
        z: zoom,
        x,
        y,
        imageryUrl: buildArcGisSlippyTileUrl(AERIAL_IMAGERY_ENDPOINT, zoom, x, y),
        labelsUrl: effectiveIncludeLabels
          ? buildArcGisSlippyTileUrl(AERIAL_LABELS_ENDPOINT, zoom, x, y)
          : null,
      });
    }
  }

  // Stream the 2x2 tiles directly under the focal point first, spiraling outward in concentric rings.
  const focalCol = cols / 2 - 0.5;
  const focalRow = Math.max(0.5, Math.min(rows - 1.5, centerTileY - yStart - 0.5));
  tiles.sort((a, b) => {
    const da = (a.colOffset - focalCol) ** 2 + (a.rowOffset - focalRow) ** 2;
    const db = (b.colOffset - focalCol) ** 2 + (b.rowOffset - focalRow) ** 2;
    return da - db;
  });

  return {
    key: `aerial:z${zoom}:g${cols}x${rows}:x${xStart}:y${yStart}:lbl${effectiveIncludeLabels ? 1 : 0}`,
    zoom,
    cols,
    rows,
    tileSize,
    width,
    height,
    xStart,
    yStart,
    mercBounds,
    includeLabels: effectiveIncludeLabels,
    resolutionLabel: estimateSlippyGroundResolutionLabel(zoom, lat),
    tiles,
  };
}

/**
 * Checks whether a normalized Web Mercator coordinate still lies comfortably inside
 * the current mosaic patch so gentle panning avoids unnecessary tile re-fetches.
 */
export function isMercatorPointComfortablyInsideMosaic(
  mercX: number,
  mercY: number,
  spec: AerialSlippyMosaicSpec
): boolean {
  const n = 1 << spec.zoom;
  const centerX = 0.5 * (spec.mercBounds[0] + spec.mercBounds[2]);
  const shiftedX = mercX + Math.floor(centerX - mercX + 0.5);
  const marginX = Math.max(1.35, spec.cols * 0.28) / n;
  const marginY = Math.max(1.35, spec.rows * 0.28) / n;

  if (
    shiftedX < spec.mercBounds[0] + marginX ||
    shiftedX > spec.mercBounds[2] - marginX
  ) {
    return false;
  }

  const minAllowedY =
    spec.yStart === 0 ? spec.mercBounds[1] : spec.mercBounds[1] + marginY;
  const maxAllowedY =
    spec.yStart + spec.rows >= n
      ? spec.mercBounds[3]
      : spec.mercBounds[3] - marginY;

  return mercY >= minAllowedY && mercY <= maxAllowedY;
}

/**
 * Computes 64-bit camera-relative Mercator patch bounds [dxMin, dyMin, invSpanX, invSpanY]
 * around `mercRef` so WebGL float32 fragment shaders avoid UV quantization at z15..z18.
 */
export function computeRelativeMercatorPatchBounds(
  mercBounds: [number, number, number, number],
  mercRef: { mercX: number; mercY: number }
): [number, number, number, number] {
  const patchCenterX = 0.5 * (mercBounds[0] + mercBounds[2]);
  const shiftedRefX =
    mercRef.mercX + Math.floor(patchCenterX - mercRef.mercX + 0.5);
  const dxMin = mercBounds[0] - shiftedRefX;
  const dyMin = mercBounds[1] - mercRef.mercY;
  const invSpanX = 1 / Math.max(1e-12, mercBounds[2] - mercBounds[0]);
  const invSpanY = 1 / Math.max(1e-12, mercBounds[3] - mercBounds[1]);
  return [dxMin, dyMin, invSpanX, invSpanY];
}

/**
 * Returns true when regional/deep zoom should display crisp cloud-free high-res satellite
 * photography as its primary base instead of NASA GIBS daily/cloudy imagery.
 */
export function shouldUseCloudFreeAerialPrimary(
  mode: RegionalSatelliteMode,
  activeTopics?: readonly ETGDatasetId[]
): boolean {
  if (mode === "aerial") return true;
  if (mode !== "auto") return false;
  const primary = activeTopics?.[0];
  return (
    primary !== "wildfire" &&
    primary !== "ocean_temp" &&
    primary !== "hydrology" &&
    primary !== "air_quality" &&
    primary !== "deforestation"
  );
}

/**
 * Returns true when high-res cloud-free aerial imagery should load underneath the active mode
 * (used both when aerial is primary and as a sharp terrain underlay beneath scientific GIBS data layers).
 */
export function shouldRenderAerialUnderlay(mode: RegionalSatelliteMode): boolean {
  return mode !== "off" && mode !== "true_color" && mode !== "night_viirs";
}
