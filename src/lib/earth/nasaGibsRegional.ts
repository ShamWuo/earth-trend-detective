import type { ETGDatasetId } from "@/types/etg";

export type ActiveGibsLayerId =
  | "winds"
  | "precip"
  | "thermal"
  | "sst_anomaly"
  | "air_temp"
  | "aerosols"
  | "ndvi"
  | "true_color"
  | "night_viirs";

export type RegionalSatelliteMode =
  | "auto"
  | "multi_slice"
  | ActiveGibsLayerId
  | "off";

export type RegionalZoomTier = "mesoscale" | "corridor";

export interface GibsLayerColorbar {
  gradientCss: string;
  minLabel: string;
  midLabel: string;
  maxLabel: string;
  unitLabel: string;
}

export interface GibsWmtsSubLayer {
  wmtsLayer: string;
  tileMatrixSet: "2km" | "1km" | "500m" | "250m";
  ext: "png" | "jpeg";
  timeless?: boolean;
  lagDays?: number;
  monthly?: boolean;
}

export interface GlobalWmtsSubLayerPlan {
  wmtsLayer: string;
  tileMatrixSet: "2km" | "1km" | "500m" | "250m";
  ext: "png" | "jpeg";
  timeless: boolean;
  dateIso: string;
  fallbackDateIso: string;
}

export interface GlobalWmtsMosaicSpec {
  key: string;
  layerId: ActiveGibsLayerId;
  zoom: 2 | 3;
  cols: number;
  rows: number;
  tileSize: 512;
  width: number;
  height: number;
  badgeLabel: "5K HD" | "2.5K HD";
  primaryDateIso: string;
  subLayers: GlobalWmtsSubLayerPlan[];
}

export interface GibsLayerDescriptor {
  id: ActiveGibsLayerId;
  label: string;
  shortLabel: string;
  resolutionLabel: string;
  wmsLayers: string;
  globalWmsLayers: string;
  globalFormat: "image/jpeg" | "image/png";
  lagDays: number;
  globalLagDays?: number;
  minEpochMs: number;
  isDataLayer: boolean;
  monthly?: boolean;
  globalMonthly?: boolean;
  shaderMode: number;
  colorbar?: GibsLayerColorbar;
  wmtsZoom: 2 | 3;
  wmtsSubLayers: GibsWmtsSubLayer[];
}

export interface GlobalLayerSpec {
  key: string;
  layerId: ActiveGibsLayerId;
  dateIso: string;
  width: number;
  height: number;
  url: string;
  proxyUrl: string;
}

export interface RegionalTileSpec {
  key: string;
  layerId: ActiveGibsLayerId;
  tier: RegionalZoomTier;
  /** [minLng, minLat, maxLng, maxLat] */
  bounds: [number, number, number, number];
  dateIso: string;
  width: number;
  height: number;
  url: string;
  proxyUrl: string;
}

export const MIN_GLOBE_CAMERA_RADIUS = 116;
export const CORRIDOR_TIER_MAX_RADIUS = 146;
export const REGIONAL_ZOOM_ACTIVATE_RADIUS = 192;
export const REGIONAL_ZOOM_EXIT_RADIUS = 196;
export const DEFAULT_REGIONAL_FOCUS_RADIUS = 132;
export const GIBS_WMS_ENDPOINT =
  "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
export const GIBS_WMTS_ENDPOINT =
  "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best";

const DAY_MS = 86_400_000;
const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export const GIBS_LAYERS: Record<ActiveGibsLayerId, GibsLayerDescriptor> = {
  winds: {
    id: "winds",
    label: "Surface Winds (GEOS / MERRA-2)",
    shortLabel: "Winds",
    resolutionLabel: "MERRA-2 Wind Speed · 50km",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,MERRA2_Surface_Wind_Speed_Monthly,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers: "MERRA2_Surface_Wind_Speed_Monthly",
    globalFormat: "image/jpeg",
    lagDays: 110,
    minEpochMs: Date.UTC(1980, 0, 1),
    isDataLayer: true,
    monthly: true,
    shaderMode: 1,
    wmtsZoom: 2,
    wmtsSubLayers: [
      {
        wmtsLayer: "MERRA2_Surface_Wind_Speed_Monthly",
        tileMatrixSet: "2km",
        ext: "png",
        lagDays: 110,
        monthly: true,
      },
    ],
    colorbar: {
      gradientCss:
        "linear-gradient(90deg, #0b2a5b 0%, #1d70b8 24%, #2dd4bf 46%, #fde047 68%, #f97316 84%, #dc2626 100%)",
      minLabel: "0 m/s",
      midLabel: "12 m/s",
      maxLabel: "25+ m/s",
      unitLabel: "10m Surface Wind Speed",
    },
  },
  precip: {
    id: "precip",
    label: "Precipitable Water & Rain (GEOS / IMERG)",
    shortLabel: "Water / Rain",
    resolutionLabel: "MERRA-2 Vapor + GPM IMERG · 10km",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,IMERG_Precipitation_Rate,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers:
      "MERRA2_Total_Precipitable_Water_Vapor_Monthly,IMERG_Precipitation_Rate",
    globalFormat: "image/jpeg",
    lagDays: 4,
    globalLagDays: 110,
    minEpochMs: Date.UTC(2000, 5, 1),
    isDataLayer: true,
    globalMonthly: true,
    shaderMode: 2,
    wmtsZoom: 3,
    wmtsSubLayers: [
      {
        wmtsLayer: "MERRA2_Total_Precipitable_Water_Vapor_Monthly",
        tileMatrixSet: "2km",
        ext: "png",
        lagDays: 110,
        monthly: true,
      },
      {
        wmtsLayer: "IMERG_Precipitation_Rate",
        tileMatrixSet: "2km",
        ext: "png",
        lagDays: 4,
        monthly: false,
      },
    ],
    colorbar: {
      gradientCss:
        "linear-gradient(90deg, #1e3a5f 0%, #16a34a 32%, #84cc16 54%, #facc15 74%, #ef4444 90%, #f8fafc 100%)",
      minLabel: "5 mm",
      midLabel: "35 mm",
      maxLabel: "70+ mm",
      unitLabel: "Precipitable Water & Rain",
    },
  },
  thermal: {
    id: "thermal",
    label: "Thermal Skin Temp (MUR SST + MODIS LST)",
    shortLabel: "Thermal",
    resolutionLabel: "MODIS LST + MUR SST · 1km",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,GHRSST_L4_MUR_Sea_Surface_Temperature,MODIS_Terra_Land_Surface_Temp_Day,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,GHRSST_L4_MUR_Sea_Surface_Temperature,MODIS_Terra_Land_Surface_Temp_Day",
    globalFormat: "image/jpeg",
    lagDays: 5,
    minEpochMs: Date.UTC(2003, 0, 1),
    isDataLayer: true,
    shaderMode: 3,
    wmtsZoom: 3,
    wmtsSubLayers: [
      {
        wmtsLayer: "GHRSST_L4_MUR_Sea_Surface_Temperature",
        tileMatrixSet: "1km",
        ext: "png",
        lagDays: 5,
      },
      {
        wmtsLayer: "MODIS_Terra_Land_Surface_Temp_Day",
        tileMatrixSet: "1km",
        ext: "png",
        lagDays: 5,
      },
    ],
    colorbar: {
      gradientCss:
        "linear-gradient(90deg, #3b0764 0%, #2563eb 22%, #06b6d4 40%, #22c55e 56%, #facc15 74%, #ea580c 88%, #b91c1c 100%)",
      minLabel: "-2 °C",
      midLabel: "18 °C",
      maxLabel: "38+ °C",
      unitLabel: "Land & Sea Surface Temp",
    },
  },
  sst_anomaly: {
    id: "sst_anomaly",
    label: "Ocean Temp Anomaly (1km MUR SST)",
    shortLabel: "Ocean Anomaly",
    resolutionLabel: "GHRSST L4 MUR Anomaly · 1km",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers: "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies",
    globalFormat: "image/png",
    lagDays: 4,
    minEpochMs: Date.UTC(2019, 7, 1),
    isDataLayer: true,
    shaderMode: 4,
    wmtsZoom: 3,
    wmtsSubLayers: [
      {
        wmtsLayer: "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies",
        tileMatrixSet: "1km",
        ext: "png",
        lagDays: 4,
      },
    ],
    colorbar: {
      gradientCss:
        "linear-gradient(90deg, #4c1d95 0%, #2563eb 22%, #38bdf8 36%, #0b2545 50%, #facc15 66%, #f97316 82%, #991b1b 100%)",
      minLabel: "-4 °C",
      midLabel: "0 °C",
      maxLabel: "+4 °C",
      unitLabel: "Sea Surface Temp Anomaly",
    },
  },
  air_temp: {
    id: "air_temp",
    label: "2m Air Temperature (MERRA-2)",
    shortLabel: "Air Temp",
    resolutionLabel: "MERRA-2 Assimilated T2M · 50km",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,MERRA2_2m_Air_Temperature_Assimilated_Monthly,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers: "MERRA2_2m_Air_Temperature_Assimilated_Monthly",
    globalFormat: "image/jpeg",
    lagDays: 110,
    minEpochMs: Date.UTC(1980, 0, 1),
    isDataLayer: true,
    monthly: true,
    shaderMode: 5,
    wmtsZoom: 2,
    wmtsSubLayers: [
      {
        wmtsLayer: "MERRA2_2m_Air_Temperature_Assimilated_Monthly",
        tileMatrixSet: "2km",
        ext: "png",
        lagDays: 110,
        monthly: true,
      },
    ],
    colorbar: {
      gradientCss:
        "linear-gradient(90deg, #312e81 0%, #38bdf8 24%, #bef264 46%, #fdba74 68%, #ef4444 86%, #7f1d1d 100%)",
      minLabel: "-30 °C",
      midLabel: "10 °C",
      maxLabel: "42 °C",
      unitLabel: "2m Air Temperature",
    },
  },
  aerosols: {
    id: "aerosols",
    label: "Aerosols, Smoke & Dust (MERRA-2 AOD)",
    shortLabel: "Aerosols",
    resolutionLabel: "MERRA-2 Aerosol Optical Depth · 50km",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,MODIS_Combined_Value_Added_AOD,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers: "MERRA2_Aerosol_Optical_Depth_Analysis_Monthly",
    globalFormat: "image/jpeg",
    lagDays: 5,
    globalLagDays: 110,
    minEpochMs: Date.UTC(2003, 0, 1),
    isDataLayer: true,
    globalMonthly: true,
    shaderMode: 6,
    wmtsZoom: 2,
    wmtsSubLayers: [
      {
        wmtsLayer: "MERRA2_Aerosol_Optical_Depth_Analysis_Monthly",
        tileMatrixSet: "2km",
        ext: "png",
        lagDays: 110,
        monthly: true,
      },
    ],
    colorbar: {
      gradientCss:
        "linear-gradient(90deg, #0f172a 0%, #0d9488 28%, #fef08a 56%, #f97316 80%, #991b1b 100%)",
      minLabel: "0.0",
      midLabel: "0.4",
      maxLabel: "1.0+ AOD",
      unitLabel: "550nm Aerosol Optical Depth",
    },
  },
  ndvi: {
    id: "ndvi",
    label: "Vegetation Canopy (MODIS 250m NDVI)",
    shortLabel: "NDVI",
    resolutionLabel: "MODIS 8-Day NDVI · 250m",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,MODIS_Terra_NDVI_8Day,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers: "MODIS_Terra_NDVI_8Day",
    globalFormat: "image/png",
    lagDays: 10,
    minEpochMs: Date.UTC(2003, 0, 1),
    isDataLayer: true,
    shaderMode: 7,
    wmtsZoom: 3,
    wmtsSubLayers: [
      {
        wmtsLayer: "MODIS_Terra_NDVI_8Day",
        tileMatrixSet: "250m",
        ext: "png",
        lagDays: 10,
      },
    ],
    colorbar: {
      gradientCss:
        "linear-gradient(90deg, #d6c7b2 0%, #a3a380 25%, #84cc16 55%, #15803d 80%, #052e16 100%)",
      minLabel: "0.0 Barren",
      midLabel: "0.45 Shrub",
      maxLabel: "0.90 Canopy",
      unitLabel: "NDVI Vegetation Index",
    },
  },
  true_color: {
    id: "true_color",
    label: "Satellite True Color + Clouds (MODIS)",
    shortLabel: "True Color",
    resolutionLabel: "MODIS Terra 250m · Live Clouds",
    wmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,MODIS_Terra_CorrectedReflectance_TrueColor,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers:
      "BlueMarble_ShadedRelief_Bathymetry,MODIS_Terra_CorrectedReflectance_TrueColor",
    globalFormat: "image/jpeg",
    lagDays: 4,
    minEpochMs: Date.UTC(2003, 0, 1),
    isDataLayer: false,
    shaderMode: 8,
    wmtsZoom: 3,
    wmtsSubLayers: [
      {
        wmtsLayer: "MODIS_Terra_CorrectedReflectance_TrueColor",
        tileMatrixSet: "250m",
        ext: "jpeg",
        lagDays: 4,
      },
    ],
  },
  night_viirs: {
    id: "night_viirs",
    label: "Night Radiance (VIIRS Black Marble)",
    shortLabel: "VIIRS Night",
    resolutionLabel: "VIIRS Day/Night Band · 500m",
    wmsLayers:
      "VIIRS_SNPP_DayNightBand_At_Sensor_Radiance,Coastlines_15m,Reference_Features_15m",
    globalWmsLayers: "VIIRS_CityLights_2012",
    globalFormat: "image/jpeg",
    lagDays: 4,
    minEpochMs: Date.UTC(2012, 1, 1),
    isDataLayer: true,
    shaderMode: 9,
    wmtsZoom: 3,
    wmtsSubLayers: [
      {
        wmtsLayer: "VIIRS_CityLights_2012",
        tileMatrixSet: "500m",
        ext: "jpeg",
        timeless: true,
      },
    ],
  },
};

/**
 * Resolves the concrete NASA GIBS layer ID from the selected satellite mode and active topics.
 */
export function resolveActiveGibsLayer(
  mode: RegionalSatelliteMode,
  activeTopics?: readonly ETGDatasetId[]
): ActiveGibsLayerId | null {
  if (mode === "off") return null;
  if (mode === "multi_slice") return "true_color";
  if (mode !== "auto") return mode;

  const primary = activeTopics?.[0];
  if (primary === "wildfire" || primary === "ocean_temp") {
    return "thermal";
  }
  if (primary === "hydrology") {
    return "precip";
  }
  if (primary === "air_quality") {
    return "aerosols";
  }
  if (primary === "deforestation") {
    return "ndvi";
  }
  return "true_color";
}

/**
 * Resolves the global full-sphere NASA GIBS filter layer from mode and active topics.
 * Returns null in "auto" when no dataset filter is selected, or for "multi_slice" / "off".
 */
export function resolveGlobalFilterLayer(
  mode: RegionalSatelliteMode,
  activeTopics?: readonly ETGDatasetId[]
): ActiveGibsLayerId | null {
  if (mode === "off" || mode === "multi_slice") return null;
  if (mode !== "auto") return mode;
  if (!activeTopics || activeTopics.length === 0) return null;

  const primary = activeTopics[0];
  if (primary === "ocean_temp") {
    return "sst_anomaly";
  }
  if (primary === "nasa_power") {
    return "air_temp";
  }
  if (primary === "wildfire") {
    return "thermal";
  }
  if (primary === "hydrology") {
    return "precip";
  }
  if (primary === "air_quality") {
    return "aerosols";
  }
  if (primary === "deforestation") {
    return "ndvi";
  }
  return "true_color";
}

function resolveGibsDateIsoWithOptions(
  layer: GibsLayerDescriptor,
  cutoffMs: number | undefined,
  nowMs: number,
  lagDays: number,
  monthly: boolean
): string {
  const maxSafeMs = nowMs - lagDays * DAY_MS;
  const candidateMs =
    typeof cutoffMs === "number" && Number.isFinite(cutoffMs)
      ? Math.min(cutoffMs, maxSafeMs)
      : maxSafeMs;
  const clampedMs = Math.max(layer.minEpochMs, candidateMs);
  const iso = new Date(clampedMs).toISOString().slice(0, 10);
  return monthly ? `${iso.slice(0, 7)}-01` : iso;
}

/**
 * Resolves a safe ISO date (YYYY-MM-DD) with an NRT lag buffer so GIBS swaths are never incomplete/blank.
 */
export function resolveGibsDateIso(
  layerId: ActiveGibsLayerId,
  cutoffMs?: number,
  nowMs: number = Date.now()
): string {
  const layer = GIBS_LAYERS[layerId];
  return resolveGibsDateIsoWithOptions(
    layer,
    cutoffMs,
    nowMs,
    layer.lagDays,
    Boolean(layer.monthly)
  );
}

/**
 * Builds a global equirectangular (EPSG:4326) NASA GIBS WMS request spec for the entire 3D Earth.
 */
export function computeGlobalLayerSpec(params: {
  layerId: ActiveGibsLayerId;
  cutoffMs?: number;
  nowMs?: number;
}): GlobalLayerSpec {
  const { layerId, cutoffMs, nowMs = Date.now() } = params;
  const layer = GIBS_LAYERS[layerId];
  const dateIso = resolveGibsDateIsoWithOptions(
    layer,
    cutoffMs,
    nowMs,
    layer.globalLagDays ?? layer.lagDays,
    Boolean(layer.globalMonthly ?? layer.monthly)
  );
  const width = 2048;
  const height = 1024;
  const transparentPart = layer.globalFormat === "image/png" ? "&TRANSPARENT=TRUE" : "";
  const url = `${GIBS_WMS_ENDPOINT}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer.globalWmsLayers}&STYLES=&FORMAT=${layer.globalFormat}${transparentPart}&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=${width}&HEIGHT=${height}&TIME=${dateIso}`;
  const proxyUrl = `/api/earth/gibs?layer=${layerId}&scope=global&bbox=-180,-90,180,90&width=${width}&height=${height}&time=${dateIso}`;
  return {
    key: `global:${layerId}:${dateIso}`,
    layerId,
    dateIso,
    width,
    height,
    url,
    proxyUrl,
  };
}

/**
 * Returns the scale-independent global NASA GIBS coastline & political borders PNG URL.
 */
export function computeGlobalBordersUrl(): string {
  return `${GIBS_WMS_ENDPOINT}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=Coastlines,Reference_Features&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=2048&HEIGHT=1024`;
}

/**
 * Builds a single NASA GIBS WMTS tile URL for a sub-layer plan and tile index.
 */
export function buildWmtsTileUrl(
  sub: GlobalWmtsSubLayerPlan,
  zoom: 2 | 3,
  row: number,
  col: number,
  useFallbackDate = false
): string {
  if (sub.timeless) {
    return `${GIBS_WMTS_ENDPOINT}/${sub.wmtsLayer}/default/${sub.tileMatrixSet}/${zoom}/${row}/${col}.${sub.ext}`;
  }
  const timeSegment = useFallbackDate ? sub.fallbackDateIso : sub.dateIso;
  return `${GIBS_WMTS_ENDPOINT}/${sub.wmtsLayer}/default/${timeSegment}/${sub.tileMatrixSet}/${zoom}/${row}/${col}.${sub.ext}`;
}

/**
 * Builds a global equirectangular (EPSG:4326) NASA GIBS WMTS mosaic spec for 5K/2.5K client-side stitching.
 */
export function computeGlobalWmtsMosaicSpec(params: {
  layerId: ActiveGibsLayerId;
  cutoffMs?: number;
  nowMs?: number;
  zoomOverride?: 2 | 3;
}): GlobalWmtsMosaicSpec {
  const { layerId, cutoffMs, nowMs = Date.now(), zoomOverride } = params;
  const layer = GIBS_LAYERS[layerId];
  const zoom = zoomOverride ?? layer.wmtsZoom;
  const cols = zoom === 3 ? 10 : 5;
  const rows = zoom === 3 ? 5 : 3;
  const width = zoom === 3 ? 5120 : 2560;
  const height = zoom === 3 ? 2560 : 1280;
  const badgeLabel = zoom === 3 ? "5K HD" : "2.5K HD";

  const subLayers: GlobalWmtsSubLayerPlan[] = layer.wmtsSubLayers.map((sub) => {
    const monthly = Boolean(sub.monthly);
    const dateIso = resolveGibsDateIsoWithOptions(
      layer,
      cutoffMs,
      nowMs,
      sub.lagDays ?? layer.lagDays,
      monthly
    );
    const fallbackDateIso = monthly ? "2025-07-01" : "2025-07-15";
    return {
      wmtsLayer: sub.wmtsLayer,
      tileMatrixSet: sub.tileMatrixSet,
      ext: sub.ext,
      timeless: Boolean(sub.timeless),
      dateIso,
      fallbackDateIso,
    };
  });

  const primaryDateIso =
    subLayers[subLayers.length - 1]?.dateIso ??
    resolveGibsDateIsoWithOptions(
      layer,
      cutoffMs,
      nowMs,
      layer.globalLagDays ?? layer.lagDays,
      Boolean(layer.globalMonthly ?? layer.monthly)
    );
  const key = `wmts:${layerId}:z${zoom}:${subLayers
    .map((s) => (s.timeless ? "static" : s.dateIso))
    .join("+")}`;

  return {
    key,
    layerId,
    zoom,
    cols,
    rows,
    tileSize: 512,
    width,
    height,
    badgeLabel,
    primaryDateIso,
    subLayers,
  };
}

/**
 * Returns the 4 quadrant specs assembling a 4096x2048 global coastlines & political borders texture.
 */
export function computeGlobalBordersQuadrantSpecs(): Array<{
  bbox: string;
  dx: number;
  dy: number;
  width: 2048;
  height: 1024;
  proxyUrl: string;
}> {
  const quadrants: Array<{ bbox: string; dx: number; dy: number }> = [
    { bbox: "-180,0,0,90", dx: 0, dy: 0 },
    { bbox: "0,0,180,90", dx: 2048, dy: 0 },
    { bbox: "-180,-90,0,0", dx: 0, dy: 1024 },
    { bbox: "0,-90,180,0", dx: 2048, dy: 1024 },
  ];
  return quadrants.map(({ bbox, dx, dy }) => ({
    bbox,
    dx,
    dy,
    width: 2048,
    height: 1024,
    proxyUrl: `/api/earth/gibs?layer=borders&scope=global&bbox=${encodeURIComponent(bbox)}&width=2048&height=1024&time=2026-01-01`,
  }));
}

/**
 * Returns the same-origin proxy URL for global NASA GIBS coastline & political borders PNG.
 */
export function computeGlobalBordersProxyUrl(): string {
  return "/api/earth/gibs?layer=borders&scope=global&bbox=-180,-90,180,90&width=2048&height=1024&time=2026-01-01";
}

/**
 * Computes a quantized, pole/antimeridian-safe NASA GIBS WMS EPSG:4326 tile request spec.
 */
export function computeRegionalTileSpec(params: {
  lat: number;
  lng: number;
  cameraRadius: number;
  layerId: ActiveGibsLayerId;
  cutoffMs?: number;
  nowMs?: number;
}): RegionalTileSpec | null {
  const { lat, lng, cameraRadius, layerId, cutoffMs, nowMs } = params;
  if (
    !Number.isFinite(cameraRadius) ||
    cameraRadius > REGIONAL_ZOOM_EXIT_RADIUS
  ) {
    return null;
  }

  const tier: RegionalZoomTier =
    cameraRadius <= CORRIDOR_TIER_MAX_RADIUS ? "corridor" : "mesoscale";

  const spanLng = tier === "corridor" ? 16 : 36;
  const spanLat = tier === "corridor" ? 12 : 27;
  const snapDeg = tier === "corridor" ? 2 : 4;
  const width = tier === "corridor" ? 2048 : 1600;
  const height = tier === "corridor" ? 1536 : 1200;

  // Normalize longitude cleanly before snapping
  let normLng = ((((lng + 180) % 360) + 360) % 360) - 180;
  if (normLng === -180 && lng > 0) normLng = 180;
  const clampedLat = Math.max(-85, Math.min(85, lat));

  const centerLng = Math.round(normLng / snapDeg) * snapDeg;
  const centerLat = Math.round(clampedLat / snapDeg) * snapDeg;

  let minLng = centerLng - spanLng / 2;
  let maxLng = centerLng + spanLng / 2;
  if (minLng < -180) {
    const shift = -180 - minLng;
    minLng += shift;
    maxLng += shift;
  }
  if (maxLng > 180) {
    const shift = 180 - maxLng;
    minLng += shift;
    maxLng += shift;
  }

  let minLat = centerLat - spanLat / 2;
  let maxLat = centerLat + spanLat / 2;
  if (minLat < -85) {
    const shift = -85 - minLat;
    minLat += shift;
    maxLat += shift;
  }
  if (maxLat > 85) {
    const shift = 85 - maxLat;
    minLat += shift;
    maxLat += shift;
  }

  const bounds: [number, number, number, number] = [
    minLng,
    minLat,
    maxLng,
    maxLat,
  ];
  const dateIso = resolveGibsDateIso(layerId, cutoffMs, nowMs);
  const layer = GIBS_LAYERS[layerId];
  const bboxStr = `${minLng},${minLat},${maxLng},${maxLat}`;
  const url = `${GIBS_WMS_ENDPOINT}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer.wmsLayers}&STYLES=&FORMAT=image/jpeg&SRS=EPSG:4326&BBOX=${bboxStr}&WIDTH=${width}&HEIGHT=${height}&TIME=${dateIso}`;
  const proxyUrl = `/api/earth/gibs?layer=${layerId}&bbox=${encodeURIComponent(bboxStr)}&width=${width}&height=${height}&time=${dateIso}`;
  const key = `${layerId}:${tier}:${bboxStr}:${dateIso}`;

  return {
    key,
    layerId,
    tier,
    bounds,
    dateIso,
    width,
    height,
    url,
    proxyUrl,
  };
}

/**
 * Generates a closed geodesic ring (segments + 1 coordinates) around a center coordinate.
 */
export function buildGeodesicCircleLatLng(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  segments = 72
): Array<{ lat: number; lng: number }> {
  const lat1 = Math.max(-89.9, Math.min(89.9, centerLat)) * DEG_TO_RAD;
  const lng1 = centerLng * DEG_TO_RAD;
  const angularDist = Math.max(0, radiusKm) / EARTH_RADIUS_KM;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAd = Math.sin(angularDist);
  const cosAd = Math.cos(angularDist);

  const ring: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = (i / segments) * Math.PI * 2;
    const lat2 = Math.asin(
      Math.max(
        -1,
        Math.min(1, sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(bearing))
      )
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * sinAd * cosLat1,
        cosAd - sinLat1 * Math.sin(lat2)
      );

    let outLng = lng2 * RAD_TO_DEG;
    outLng = ((((outLng + 180) % 360) + 360) % 360) - 180;
    const outLat = Math.max(-89.99, Math.min(89.99, lat2 * RAD_TO_DEG));
    ring.push({ lat: outLat, lng: outLng });
  }
  return ring;
}

/**
 * Estimates the visible regional ground swath width in kilometers from the globe camera radius.
 */
export function estimateRegionalSwathKm(cameraRadius: number): number {
  const clamped = Math.max(
    MIN_GLOBE_CAMERA_RADIUS,
    Math.min(REGIONAL_ZOOM_EXIT_RADIUS, cameraRadius)
  );
  const frac =
    (clamped - MIN_GLOBE_CAMERA_RADIUS) /
    (REGIONAL_ZOOM_EXIT_RADIUS - MIN_GLOBE_CAMERA_RADIUS);
  return Math.round(420 + frac * 1480);
}
