import type { ETGDatasetId, ETGDatasetMeta } from "@/types/etg";

/**
 * Pure Earth-observation physical dataset schema definitions (no seeded nodes or coordinates).
 */
export const EARTH_TREND_DATASETS: readonly ETGDatasetMeta[] = [
  {
    id: "nasa_power",
    label: "Temperature (Air & Weather Stations)",
    shortLabel: "Temperature",
    color: "#818cf8",
    unit: "°C",
    slopeUnit: "°C/yr",
    sourceName: "NASA POWER MERRA-2 / GISTEMP v4 / NOAA CDO",
    description:
      "Surface air temperature & station anomalies via NASA POWER, Giovanni, GISTEMP v4, and NOAA CDO.",
    studentPlainSummary:
      "How hot or cold the air is 2 meters above the ground, tracked year after year.",
    whyItMatters:
      "Even +0.5 °C of warming shifts heatwaves, crop bloom dates, and snowmelt timing.",
  },
  {
    id: "wildfire",
    label: "Wildfires & Fire-Weather Aridity",
    shortLabel: "Wildfires & Heat",
    color: "#f43f5e",
    unit: "kPa",
    slopeUnit: "kPa/yr",
    sourceName: "NASA EONET v3 · POWER MERRA-2 VPD (T2M_MAX + RH2M)",
    description:
      "Vapor Pressure Deficit (kPa) derived from peak temperature and relative humidity — physical driver of fuel aridity — paired with NASA EONET wildfire events.",
    studentPlainSummary:
      "Air thirstiness (Vapor Pressure Deficit): how strongly warm, dry air pulls water out of trees and grass.",
    whyItMatters:
      "When VPD rises above ~1.5 kPa, forests dry out quickly and small sparks can explode into megafires.",
  },
  {
    id: "ocean_temp",
    label: "Oceans, Polar Ice & El Niño",
    shortLabel: "Oceans & Ice",
    color: "#38bdf8",
    unit: "°C",
    slopeUnit: "°C/yr",
    sourceName: "NOAA/NSIDC v4 · KNMI ENSO/AMO/PDO · NASA Skin Temp",
    description:
      "Sea surface skin temperature, Arctic sea ice extent, and KNMI oceanic teleconnection modes.",
    studentPlainSummary:
      "Ocean surface warmth, polar sea ice area, and Pacific El Niño swings that steer Earth's jet stream.",
    whyItMatters:
      "Oceans absorb over 90% of excess heat — a warmer Tropical Pacific redirects storms and droughts thousands of miles away.",
  },
  {
    id: "air_quality",
    label: "Air Quality, Aerosols & PM2.5",
    shortLabel: "Air & CO₂",
    color: "#f59e0b",
    unit: "AOD",
    slopeUnit: "/yr",
    sourceName: "NASA AOD_55 · Copernicus CAMS PM2.5 · NOAA GML CO₂",
    description:
      "NASA Aerosol Optical Depth (550nm) enriched with live Copernicus CAMS hourly surface PM2.5 (μg/m³), plus direct NOAA GML marine CO₂.",
    studentPlainSummary:
      "How hazy the sky is with smoke, dust, or pollution (AOD & fine PM2.5 particles humans breathe).",
    whyItMatters:
      "Spikes track wildfire smoke plumes and urban smog, helping schools decide when outdoor recess is unsafe.",
  },
  {
    id: "deforestation",
    label: "Forests, Canopy Flux & Vegetation",
    shortLabel: "Vegetation",
    color: "#10b981",
    unit: "MJ/m²/d",
    slopeUnit: "MJ/m²/d/yr",
    sourceName: "NASA EVPTRNS Evapotranspiration · AppEEARS MODIS · CSA RADARSAT",
    description:
      "Physical canopy evapotranspiration energy flux (MJ/m²/d) across global land surfaces paired with MODIS NDVI & RADARSAT imports.",
    studentPlainSummary:
      "Plant breathing energy: sunlight used by healthy leaves to move water from soil into the sky.",
    whyItMatters:
      "Falling flux flags drought stress or forest loss before bare ground even appears from space.",
  },
  {
    id: "hydrology",
    label: "Rivers, Discharge & Land Moisture",
    shortLabel: "Water & Rain",
    color: "#22d3ee",
    unit: "m³/s",
    slopeUnit: "m³/s/yr",
    sourceName: "USGS NWIS Stream Gauges · Copernicus GloFAS v4 · NASA GWETROOT",
    description:
      "Live USGS river gauge discharge (m³/s) in North America, Copernicus GloFAS 5km river discharge globally, and NASA root-zone soil wetness.",
    studentPlainSummary:
      "River flow speed (cubic meters per second) plus how damp the soil is down at plant root depth.",
    whyItMatters:
      "Links mountain snowmelt and rainstorms directly to floods downstream or drying farm irrigation canals.",
  },
  {
    id: "community",
    label: "Local Sensors & Imported Data",
    shortLabel: "Local Sensors",
    color: "#c084fc",
    unit: "value",
    slopeUnit: "unit/yr",
    sourceName: "Giovanni / Data Rods / AppEEARS / KNMI / Edge Webhooks",
    description:
      "Open community sensors and imported Giovanni, AppEEARS, Data Rods, CDO, KNMI, or Geo.ca datasets.",
    studentPlainSummary:
      "Local school weather stations, citizen sensors, and custom CSV files dropped onto the same globe.",
    whyItMatters:
      "Lets students compare backyard observations against NASA satellites to spot microclimates.",
  },
] as const;

export const DATASET_BY_ID = Object.fromEntries(
  EARTH_TREND_DATASETS.map((d) => [d.id, d])
) as Record<(typeof EARTH_TREND_DATASETS)[number]["id"], ETGDatasetMeta>;

export interface ChallengeAgencyResource {
  id: string;
  group:
    | "NASA Data & Resources"
    | "Space Agency Partner Resources"
    | "CSA (Canadian Space Agency)";
  title: string;
  url: string;
  summary: string;
  integrationRole: "Live API Wired" | "Import Parser Ready" | "Methodology Applied";
  integrationNote: string;
}

export const CHALLENGE_SPACE_AGENCY_RESOURCES: readonly ChallengeAgencyResource[] = [
  {
    id: "nasa-giovanni",
    group: "NASA Data & Resources",
    title: "NASA Giovanni",
    url: "https://giovanni.gsfc.nasa.gov/",
    summary: "NASA GES DISC web environment for multi-parameter Earth time-series generation and CSV export.",
    integrationRole: "Import Parser Ready",
    integrationNote: "Supports direct coordinate deep-links and native Giovanni CSV preamble ingestion.",
  },
  {
    id: "nasa-ges-disc-hydrology",
    group: "NASA Data & Resources",
    title: "NASA GES DISC Hydrology Time Series",
    url: "https://disc.gsfc.nasa.gov/information/tools?title=Hydrology%20Time%20Series",
    summary: "Hydrology Data Rods time-series generation for land-surface soil moisture, runoff, and rainfall.",
    integrationRole: "Live API Wired",
    integrationNote: "Probing Hydrology queries NASA AG GWETROOT/PRECTOTCORR live and parses Data Rods BEGIN DATA ASCII.",
  },
  {
    id: "nasa-appeears",
    group: "NASA Data & Resources",
    title: "NASA AppEEARS (LP DAAC)",
    url: "https://appeears.earthdatacloud.nasa.gov/",
    summary: "Geospatial extraction and point/area time-series across MODIS, VIIRS, SMAP, and ECOSTRESS archives.",
    integrationRole: "Live API Wired",
    integrationNote: "Fetches live LP DAAC AppEEARS product metadata and parses AppEEARS Point CSV exports.",
  },
  {
    id: "noaa-cdo",
    group: "NASA Data & Resources",
    title: "NOAA NCEI Climate Data Online (CDO)",
    url: "https://www.ncei.noaa.gov/cdo-web/",
    summary: "Global historical weather station archive (GSOY temperature & precipitation records across continents).",
    integrationRole: "Live API Wired",
    integrationNote: "Streams live NOAA CDO v1 global stations (Barrow AK, Los Angeles, Hamburg, Melbourne).",
  },
  {
    id: "nasa-seawifs-paper",
    group: "NASA Data & Resources",
    title: "Time-Series Analysis of SeaWiFS Chlorophyll in River-Influenced Coastal Regions",
    url: "https://ntrs.nasa.gov/api/citations/20090042747/downloads/20090042747.pdf",
    summary: "NASA NTRS technical methodology linking coastal chlorophyll blooms to river discharge & OLS significance.",
    integrationRole: "Methodology Applied",
    integrationNote: "Paired with live Mississippi River USGS discharge + NASA CMR SeaWiFS_L3m_CHL & OLS R²/p.",
  },
  {
    id: "knmi-climate-explorer",
    group: "Space Agency Partner Resources",
    title: "Royal Netherlands Meteorological Institute (KNMI) Climate Explorer",
    url: "https://climexp.knmi.nl/",
    summary: "Canonical empirical climate index archive (ENSO Niño 3.4, AMO, PDO, NAO) and teleconnection tools.",
    integrationRole: "Live API Wired",
    integrationNote: "Ingests live KNMI .dat climate indices and wires teleconnects edges to global trends.",
  },
  {
    id: "statistical-trend-methods",
    group: "Space Agency Partner Resources",
    title: "Statistical Test Methods to Detect Trends in Time Series Data",
    url: "https://medium.com/@snp.kriss/statistical-test-methods-to-detect-trends-in-time-series-data-b361a0ec530b",
    summary: "Reference guide covering Mann-Kendall, Sen's slope, seasonal/serial correlation, and change-points.",
    integrationRole: "Methodology Applied",
    integrationNote: "Powers Hamed-Rao (1998) modified Mann-Kendall, Theil-Sen 95% CI, and Pettitt change-point detection.",
  },
  {
    id: "statsig-significance-guide",
    group: "Space Agency Partner Resources",
    title: "A Comprehensive Guide to Statistical Significance",
    url: "https://www.statsig.com/perspectives/a-comprehensive-guide-to-statistical-significance",
    summary: "Hypothesis framing, p-value interpretation, sample power, and multiple-comparison rigor.",
    integrationRole: "Methodology Applied",
    integrationNote: "Surfaces effective sample size n*, α=0.05 thresholds, and Fisher z/Student-t p-values.",
  },
  {
    id: "csa-rcm",
    group: "CSA (Canadian Space Agency)",
    title: "CSA RADARSAT Constellation Mission (RCM)",
    url: "https://donnees-data.asc-csa.gc.ca/en/dataset/rcm",
    summary: "All-weather day/night C-band SAR trio for maritime ice, disaster response, and ecosystem monitoring.",
    integrationRole: "Live API Wired",
    integrationNote: "Queries live NASA CMR CWIC_REG_RCM collection metadata and links Arctic Cryosphere corroboration.",
  },
  {
    id: "csa-geoca",
    group: "CSA (Canadian Space Agency)",
    title: "GEO.ca Open Geospatial Platform (MSC GeoMet)",
    url: "https://geo.ca/",
    summary: "Canada's open geospatial portal feeding live AHCCD Arctic stations and national hydrometric river gauges.",
    integrationRole: "Live API Wired",
    integrationNote: "Streams live api.weather.gc.ca hydrometric discharge (Mackenzie, St. Lawrence) & Clyde River AHCCD.",
  },
  {
    id: "csa-swot",
    group: "CSA (Canadian Space Agency)",
    title: "NASA / CNES / CSA SWOT Mission",
    url: "https://www.asc-csa.gc.ca/eng/satellites/swot/",
    summary: "Surface Water and Ocean Topography mission surveying 90% of global lakes, rivers, reservoirs, and oceans.",
    integrationRole: "Live API Wired",
    integrationNote: "Queries live CMR SWOT_L2_HR_RiverSP_2.0 granules and corroborates river basin hydrology nodes.",
  },
  {
    id: "csa-ecosystem-sar",
    group: "CSA (Canadian Space Agency)",
    title: "CSA Ecosystem Monitoring & SAR Python Tutorial",
    url: "https://github.com/asc-csa/Synthetic_Aperture_Radar_Tutorial",
    summary: "CSA ecosystem monitoring guidance and open-source SAR workflow repository.",
    integrationRole: "Methodology Applied",
    integrationNote: "Links CSA Earth observation workflows for wetlands, forestry, coastal change, and ice monitoring.",
  },
] as const;

export function buildExternalExplorerLinks(
  lat: number,
  lng: number,
  dataset: ETGDatasetId = "nasa_power"
): { giovanniUrl: string; appeearsUrl: string; knmiUrl: string; geocaUrl: string } {
  const west = Math.max(-180, lng - 1.5).toFixed(2);
  const east = Math.min(180, lng + 1.5).toFixed(2);
  const south = Math.max(-90, lat - 1.5).toFixed(2);
  const north = Math.min(90, lat + 1.5).toFixed(2);
  const service = dataset === "hydrology" || dataset === "air_quality" ? "ArAvTs" : "TmAvMp";

  return {
    giovanniUrl: `https://giovanni.gsfc.nasa.gov/giovanni/#service=${service}&starttime=2000-01-01T00:00:00Z&endtime=2024-12-31T23:59:59Z&bbox=${west},${south},${east},${north}`,
    appeearsUrl: "https://appeears.earthdatacloud.nasa.gov/",
    knmiUrl: "https://climexp.knmi.nl/",
    geocaUrl: "https://geo.ca/",
  };
}
