import { createBoundedSignal, normalizeEarthCoordinates } from "@/lib/earth/coordinates";
import type { ETGDatasetId, TimeSeriesPoint, TrendProvenanceSource } from "@/types/etg";

const USER_AGENT = "EarthTrendDetective/1.0 (NASA-Space-Apps; Scientific-Observatory)";

export interface AgencyTimeSeriesRecord {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  dataset: ETGDatasetId;
  parameter: string;
  unit: string;
  slopeUnit: string;
  sourceSystem: string;
  sourceUrl: string;
  provenance: TrendProvenanceSource;
  producerType: "research_station" | "nasa_satellite";
  points: TimeSeriesPoint[];
}

export interface OrbitalMissionPass {
  id: string;
  title: string;
  mission: "SWOT" | "RCM" | "SeaWiFS" | "AppEEARS";
  lat: number;
  lng: number;
  observedAt: string;
  sourceUrl: string;
  summary: string;
}

interface NoaaCdoStationMeta {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
}

const NOAA_CDO_STATIONS: Record<string, NoaaCdoStationMeta> = {
  USW00027502: {
    id: "USW00027502",
    name: "Utqiagvik (Barrow) Arctic Observatory",
    region: "North Slope, Alaska (NOAA CDO)",
    lat: 71.29,
    lng: -156.79,
  },
  USW00023174: {
    id: "USW00023174",
    name: "Los Angeles Coastal Basin Station",
    region: "Southern California Coast (NOAA CDO)",
    lat: 33.94,
    lng: -118.39,
  },
  GM000010147: {
    id: "GM000010147",
    name: "Hamburg North Sea Weather Station",
    region: "Northern Europe (NOAA CDO)",
    lat: 53.63,
    lng: 9.99,
  },
  ASN00086071: {
    id: "ASN00086071",
    name: "Melbourne Southern Ocean Station",
    region: "Victoria, Australia (NOAA CDO)",
    lat: -37.81,
    lng: 144.97,
  },
};

const NOAA_CDO_ENDPOINT =
  "https://www.ncei.noaa.gov/access/services/data/v1?dataset=global-summary-of-the-year&stations=USW00027502,USW00023174,ASN00086071,GM000010147&startDate=1995-01-01&endDate=2025-12-31&format=json&dataTypes=TAVG,PRCP&units=metric";

/**
 * Pure parser for NOAA NCEI Climate Data Online (CDO) Access Data Service v1 JSON rows.
 */
export function parseNoaaCdoGsoyJson(
  rows: ReadonlyArray<Record<string, unknown>>,
  startYear = 1995,
  endYear = 2025
): AgencyTimeSeriesRecord[] {
  const byStation = new Map<string, TimeSeriesPoint[]>();

  for (const row of rows) {
    const stationId = String(row.STATION ?? "").trim();
    const meta = NOAA_CDO_STATIONS[stationId];
    if (!meta) continue;

    const yearStr = String(row.DATE ?? "").trim().slice(0, 4);
    const year = Number(yearStr);
    if (!Number.isInteger(year) || year < startYear || year > endYear) continue;

    const rawTavg = row.TAVG;
    if (rawTavg === null || rawTavg === undefined || String(rawTavg).trim() === "") continue;
    const tavg = Number(rawTavg);
    if (!Number.isFinite(tavg) || tavg <= -900) continue;

    const list = byStation.get(stationId) ?? [];
    list.push({ date: `${year}`, t: year, value: Number(tavg.toFixed(2)) });
    byStation.set(stationId, list);
  }

  const out: AgencyTimeSeriesRecord[] = [];
  for (const [stationId, pts] of byStation.entries()) {
    const meta = NOAA_CDO_STATIONS[stationId];
    const deduped = Array.from(new Map(pts.map((p) => [p.date, p])).values()).sort(
      (a, b) => a.t - b.t
    );
    if (deduped.length < 5) continue;

    out.push({
      id: `noaa-cdo-${stationId.toLowerCase()}`,
      name: `NOAA CDO TAVG: ${meta.name}`,
      region: meta.region,
      lat: meta.lat,
      lng: meta.lng,
      dataset: "nasa_power",
      parameter: `TAVG (${stationId})`,
      unit: "°C",
      slopeUnit: "°C/yr",
      sourceSystem: "NOAA NCEI CDO (GSOY)",
      sourceUrl: NOAA_CDO_ENDPOINT,
      provenance: "NOAA NCEI CDO (Live)",
      producerType: "research_station",
      points: deduped,
    });
  }

  return out;
}

export async function fetchNoaaCdoGlobalStations(
  startYear = 1995,
  endYear = 2025
): Promise<AgencyTimeSeriesRecord[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (process.env.NOAA_CDO_TOKEN) {
    headers.token = process.env.NOAA_CDO_TOKEN;
  }

  try {
    const res = await fetch(NOAA_CDO_ENDPOINT, {
      signal: createBoundedSignal(1100),
      headers,
    });
    if (!res.ok) {
      throw new Error(`NOAA CDO HTTP ${res.status}`);
    }
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) {
      throw new Error("NOAA CDO returned non-array JSON");
    }
    return parseNoaaCdoGsoyJson(rows, startYear, endYear);
  } catch {
    return [];
  }
}

/**
 * Pure parser for KNMI Climate Explorer monthly table `.dat` ASCII files
 * (`#` comments + `YEAR JAN FEB ... DEC`, ignoring `-999.9` sentinels).
 */
export function parseKnmiIndexDat(
  text: string,
  startYear = 1995,
  endYear = 2025
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 7) continue;

    const year = Number(parts[0]);
    if (!Number.isInteger(year) || year < startYear || year > endYear) continue;

    const monthlyVals: number[] = [];
    for (let i = 1; i < Math.min(parts.length, 13); i++) {
      const v = Number(parts[i]);
      if (Number.isFinite(v) && v > -900) {
        monthlyVals.push(v);
      }
    }
    if (monthlyVals.length < 6) continue;

    const mean = monthlyVals.reduce((s, v) => s + v, 0) / monthlyVals.length;
    points.push({
      date: `${year}`,
      t: year,
      value: Number(mean.toFixed(3)),
    });
  }

  return points.sort((a, b) => a.t - b.t);
}

/**
 * Pure parser for KNMI Climate Explorer `.dat` monthly index tables preserving
 * all 12 monthly columns (`YYYY-MM`) for multi-scale teleconnection modeling.
 */
export function parseKnmiMonthlyIndexDat(
  text: string,
  startYear = 1995,
  endYear = 2025
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const year = Number(parts[0]);
    if (!Number.isInteger(year) || year < startYear || year > endYear) continue;

    for (let m = 1; m <= Math.min(12, parts.length - 1); m++) {
      const v = Number(parts[m]);
      if (!Number.isFinite(v) || v <= -900) continue;
      points.push({
        date: `${year}-${String(m).padStart(2, "0")}`,
        t: Number((year + (m - 0.5) / 12).toFixed(4)),
        value: Number(v.toFixed(3)),
      });
    }
  }

  return points.sort((a, b) => a.t - b.t);
}

interface KnmiIndexSpec {
  id: string;
  url: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  dataset: ETGDatasetId;
  parameter: string;
  unit: string;
  slopeUnit: string;
}

const KNMI_INDICES: readonly KnmiIndexSpec[] = [
  {
    id: "knmi-nino34",
    url: "https://climexp.knmi.nl/data/iersst_nino3.4a.dat",
    name: "KNMI ENSO Niño 3.4 SST Anomaly",
    region: "Equatorial Central Pacific (5°S–5°N, 170°–120°W)",
    lat: 0.0,
    lng: -140.0,
    dataset: "ocean_temp",
    parameter: "NINO3.4 ERSSTv5",
    unit: "°C anom",
    slopeUnit: "°C/yr",
  },
  {
    id: "knmi-amo",
    url: "https://climexp.knmi.nl/data/iamo_ersst.dat",
    name: "KNMI Atlantic Multidecadal Oscillation (AMO)",
    region: "North Atlantic Basin",
    lat: 44.0,
    lng: -36.0,
    dataset: "ocean_temp",
    parameter: "AMO Index (ERSST)",
    unit: "°C anom",
    slopeUnit: "°C/yr",
  },
  {
    id: "knmi-pdo",
    url: "https://climexp.knmi.nl/data/ipdo.dat",
    name: "KNMI Pacific Decadal Oscillation (PDO)",
    region: "North Pacific Gyre",
    lat: 41.0,
    lng: -158.0,
    dataset: "ocean_temp",
    parameter: "PDO Index",
    unit: "index σ",
    slopeUnit: "σ/yr",
  },
  {
    id: "knmi-nao",
    url: "https://climexp.knmi.nl/data/inao.dat",
    name: "KNMI North Atlantic Oscillation (NAO)",
    region: "Iceland–Azores Pressure Dipole",
    lat: 64.1,
    lng: -21.9,
    dataset: "nasa_power",
    parameter: "NAO Sea-Level Pressure",
    unit: "hPa σ",
    slopeUnit: "σ/yr",
  },
];

export async function fetchKnmiClimateIndices(
  startYear = 1995,
  endYear = 2025
): Promise<AgencyTimeSeriesRecord[]> {
  const settled = await Promise.allSettled(
    KNMI_INDICES.map(async (spec) => {
      const res = await fetch(spec.url, {
        signal: createBoundedSignal(1100),
        headers: { "User-Agent": USER_AGENT },
      });
      if (!res.ok) throw new Error(`KNMI ${spec.id} HTTP ${res.status}`);
      const txt = await res.text();
      const points = parseKnmiIndexDat(txt, startYear, endYear);
      if (points.length < 5) {
        throw new Error(`KNMI ${spec.id} yielded insufficient annual rows`);
      }
      const record: AgencyTimeSeriesRecord = {
        id: spec.id,
        name: spec.name,
        region: spec.region,
        lat: spec.lat,
        lng: spec.lng,
        dataset: spec.dataset,
        parameter: spec.parameter,
        unit: spec.unit,
        slopeUnit: spec.slopeUnit,
        sourceSystem: "KNMI Climate Explorer",
        sourceUrl: spec.url,
        provenance: "KNMI Climate Explorer (Live)",
        producerType: "research_station",
        points,
      };
      return record;
    })
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<AgencyTimeSeriesRecord> => r.status === "fulfilled")
    .map((r) => r.value);
}

export async function fetchKnmiMonthlyClimateIndices(
  startYear = 1995,
  endYear = 2025
): Promise<AgencyTimeSeriesRecord[]> {
  const settled = await Promise.allSettled(
    KNMI_INDICES.map(async (spec) => {
      const res = await fetch(spec.url, {
        signal: createBoundedSignal(1100),
        headers: { "User-Agent": USER_AGENT },
      });
      if (!res.ok) throw new Error(`KNMI ${spec.id} HTTP ${res.status}`);
      const txt = await res.text();
      const points = parseKnmiMonthlyIndexDat(txt, startYear, endYear);
      if (points.length < 24) {
        throw new Error(`KNMI ${spec.id} yielded insufficient monthly rows`);
      }
      const record: AgencyTimeSeriesRecord = {
        id: spec.id,
        name: spec.name,
        region: spec.region,
        lat: spec.lat,
        lng: spec.lng,
        dataset: spec.dataset,
        parameter: spec.parameter,
        unit: spec.unit,
        slopeUnit: spec.slopeUnit,
        sourceSystem: "KNMI Climate Explorer",
        sourceUrl: spec.url,
        provenance: "KNMI Climate Explorer (Live)",
        producerType: "research_station",
        points,
      };
      return record;
    })
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<AgencyTimeSeriesRecord> => r.status === "fulfilled")
    .map((r) => r.value);
}

/**
 * Pure parser for Geo.ca / ECCC MSC GeoMet `hydrometric-annual-statistics` GeoJSON.
 */
export function parseGeocaHydrometricJson(
  geojson: {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: Record<string, unknown>;
    }>;
  },
  meta: {
    id: string;
    name: string;
    region: string;
    fallbackLat: number;
    fallbackLng: number;
    sourceUrl: string;
  },
  startYear = 1995,
  endYear = 2025
): AgencyTimeSeriesRecord | null {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const pts: TimeSeriesPoint[] = [];
  let lat = meta.fallbackLat;
  let lng = meta.fallbackLng;

  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      if (Number.isFinite(coords[1]) && Number.isFinite(coords[0])) {
        lat = coords[1];
        lng = coords[0];
      }
    }
    const p = f.properties ?? {};
    const dateRaw = String(p.MAX_DATE ?? p.YEAR ?? "").trim();
    const year = Number(dateRaw.slice(0, 4));
    const val = Number(p.MAX_VALUE ?? p.MEAN_VALUE);
    if (
      !Number.isInteger(year) ||
      year < startYear ||
      year > endYear ||
      !Number.isFinite(val) ||
      val <= -900
    ) {
      continue;
    }
    pts.push({ date: `${year}`, t: year, value: Number(val.toFixed(1)) });
  }

  const deduped = Array.from(new Map(pts.map((p) => [p.date, p])).values()).sort(
    (a, b) => a.t - b.t
  );
  if (deduped.length < 5) return null;

  return {
    id: meta.id,
    name: meta.name,
    region: meta.region,
    lat,
    lng,
    dataset: "hydrology",
    parameter: "Peak River Discharge (Geo.ca)",
    unit: "m³/s",
    slopeUnit: "m³/s/yr",
    sourceSystem: "CSA / Geo.ca MSC GeoMet",
    sourceUrl: meta.sourceUrl,
    provenance: "CSA / Geo.ca Hydrometric & AHCCD (Live)",
    producerType: "research_station",
    points: deduped,
  };
}

/**
 * Pure parser for Geo.ca AHCCD homogenized Canadian climate station annual GeoJSON,
 * strictly discarding `null` and `<= -900` (`-9999.9` missing sentinels).
 */
export function parseGeocaAhccdJson(
  geojson: {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: Record<string, unknown>;
    }>;
  },
  meta: {
    id: string;
    name: string;
    region: string;
    fallbackLat: number;
    fallbackLng: number;
    sourceUrl: string;
  },
  startYear = 1995,
  endYear = 2025
): AgencyTimeSeriesRecord | null {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const pts: TimeSeriesPoint[] = [];
  let lat = meta.fallbackLat;
  let lng = meta.fallbackLng;

  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      if (Number.isFinite(coords[1]) && Number.isFinite(coords[0])) {
        lat = coords[1];
        lng = coords[0];
      }
    }
    const p = f.properties ?? {};
    const year = Number(p.year__annee ?? p.year);
    const rawTemp = p.temp_mean__temp_moyenne;
    if (rawTemp === null || rawTemp === undefined) continue;
    const temp = Number(rawTemp);
    if (
      !Number.isInteger(year) ||
      year < startYear ||
      year > endYear ||
      !Number.isFinite(temp) ||
      temp <= -900
    ) {
      continue;
    }
    pts.push({ date: `${year}`, t: year, value: Number(temp.toFixed(2)) });
  }

  const deduped = Array.from(new Map(pts.map((p) => [p.date, p])).values()).sort(
    (a, b) => a.t - b.t
  );
  if (deduped.length < 5) return null;

  return {
    id: meta.id,
    name: meta.name,
    region: meta.region,
    lat,
    lng,
    dataset: "ocean_temp",
    parameter: "AHCCD Mean Temp (Geo.ca)",
    unit: "°C",
    slopeUnit: "°C/yr",
    sourceSystem: "CSA / Geo.ca AHCCD",
    sourceUrl: meta.sourceUrl,
    provenance: "CSA / Geo.ca Hydrometric & AHCCD (Live)",
    producerType: "research_station",
    points: deduped,
  };
}

export async function fetchGeocaCanadianSeries(
  startYear = 1995,
  endYear = 2025
): Promise<AgencyTimeSeriesRecord[]> {
  const mackenzieUrl =
    "https://api.weather.gc.ca/collections/hydrometric-annual-statistics/items?f=json&STATION_NUMBER=10LC014&DATA_TYPE_EN=Discharge&limit=80";
  const stLawrenceUrl =
    "https://api.weather.gc.ca/collections/hydrometric-annual-statistics/items?f=json&STATION_NUMBER=02OA016&DATA_TYPE_EN=Discharge&limit=80";
  const clydeRiverUrl =
    "https://api.weather.gc.ca/collections/ahccd-annual/items?f=json&station_id__id_station=2400573&limit=80";

  const results = await Promise.allSettled([
    fetch(mackenzieUrl, { signal: createBoundedSignal(1100), headers: { "User-Agent": USER_AGENT } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) =>
        parseGeocaHydrometricJson(
          json,
          {
            id: "geoca-mackenzie-10lc014",
            name: "Geo.ca Mackenzie River Peak Discharge (Arctic Red River)",
            region: "Northwest Territories Arctic Delta (Geo.ca)",
            fallbackLat: 67.46,
            fallbackLng: -133.75,
            sourceUrl: mackenzieUrl,
          },
          startYear,
          endYear
        )
      ),
    fetch(stLawrenceUrl, { signal: createBoundedSignal(1100), headers: { "User-Agent": USER_AGENT } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) =>
        parseGeocaHydrometricJson(
          json,
          {
            id: "geoca-stlawrence-02oa016",
            name: "Geo.ca St. Lawrence River Peak Discharge (Lasalle)",
            region: "St. Lawrence Seaway, Quebec (Geo.ca)",
            fallbackLat: 45.42,
            fallbackLng: -73.62,
            sourceUrl: stLawrenceUrl,
          },
          startYear,
          endYear
        )
      ),
    fetch(clydeRiverUrl, { signal: createBoundedSignal(1100), headers: { "User-Agent": USER_AGENT } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) =>
        parseGeocaAhccdJson(
          json,
          {
            id: "geoca-ahccd-2400573",
            name: "Geo.ca AHCCD Clyde River Mean Temp (Nunavut)",
            region: "Baffin Island, Nunavut Arctic (Geo.ca)",
            fallbackLat: 70.49,
            fallbackLng: -68.52,
            sourceUrl: clydeRiverUrl,
          },
          startYear,
          endYear
        )
      ),
  ]);

  return results
    .filter((r): r is PromiseFulfilledResult<AgencyTimeSeriesRecord | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v): v is AgencyTimeSeriesRecord => v !== null);
}

const USGS_MISSISSIPPI_URL =
  "https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=07374000&statReportType=annual&statTypeCd=mean&parameterCd=00060";

/**
 * Pure parser for USGS NWIS tab-delimited RDB annual discharge output
 * (converts ft³/s to m³/s when requested, used alongside NASA NTRS SeaWiFS coastal plume analysis).
 */
export function parseUsgsAnnualRdb(
  rdbText: string,
  startYear = 1995,
  endYear = 2025
): TimeSeriesPoint[] {
  const lines = rdbText.split(/\r?\n/);
  let headers: string[] | null = null;
  let passedFormatRow = false;
  const points: TimeSeriesPoint[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;

    const cols = line.split("\t");
    if (!headers) {
      headers = cols.map((c) => c.trim());
      continue;
    }
    if (!passedFormatRow) {
      // USGS RDB emits a column-width definition row immediately after headers (e.g., "5s\t15s\t4s...")
      if (cols.every((c) => /^\d+[sdn]$/i.test(c.trim()) || !c.trim())) {
        passedFormatRow = true;
        continue;
      }
      passedFormatRow = true;
    }

    const yearIdx = headers.indexOf("year_nu");
    const valIdx = headers.indexOf("mean_va");
    if (yearIdx < 0 || valIdx < 0) continue;

    const year = Number(cols[yearIdx]?.trim());
    const cfs = Number(cols[valIdx]?.trim());
    if (
      !Number.isInteger(year) ||
      year < startYear ||
      year > endYear ||
      !Number.isFinite(cfs) ||
      cfs <= -900
    ) {
      continue;
    }

    const cms = cfs * 0.0283168466;
    points.push({
      date: `${year}`,
      t: year,
      value: Number(cms.toFixed(1)),
    });
  }

  return points.sort((a, b) => a.t - b.t);
}

export async function fetchUsgsCoastalPlumeDischarge(
  startYear = 1995,
  endYear = 2025
): Promise<AgencyTimeSeriesRecord | null> {
  try {
    const res = await fetch(USGS_MISSISSIPPI_URL, {
      signal: createBoundedSignal(1100),
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      return null;
    }
    const rdb = await res.text();
    const points = parseUsgsAnnualRdb(rdb, startYear, endYear);
    if (points.length < 5) return null;

    return {
      id: "usgs-mississippi-07374000",
      name: "Mississippi River Coastal Plume Discharge (SeaWiFS Reference)",
      region: "Lower Mississippi Delta / Gulf of Mexico Plume",
      lat: 30.45,
      lng: -91.19,
      dataset: "air_quality",
      parameter: "River Discharge vs SeaWiFS Chl-a",
      unit: "m³/s",
      slopeUnit: "m³/s/yr",
      sourceSystem: "USGS / NASA NTRS SeaWiFS Plume",
      sourceUrl: USGS_MISSISSIPPI_URL,
      provenance: "USGS / NASA SeaWiFS Coastal Plume (Live)",
      producerType: "research_station",
      points,
    };
  } catch {
    return null;
  }
}

function parseCmrBoxCentroid(boxes?: string[]): { lat: number; lng: number } | null {
  if (!Array.isArray(boxes) || boxes.length === 0) return null;
  const parts = String(boxes[0] ?? "").trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [south, west, north, east] = parts;
  const norm = normalizeEarthCoordinates((south + north) / 2, (west + east) / 2, {
    poleGuardMargin: 0,
    antimeridianMargin: 0,
  });
  return {
    lat: Number(norm.lat.toFixed(2)),
    lng: Number(norm.lng.toFixed(2)),
  };
}

export async function fetchCsaSwotAndRcmMetadata(): Promise<{
  passes: OrbitalMissionPass[];
  appeearsProductCount: number;
  rcmCollectionCount: number;
  seawifsCollectionTitle: string | null;
}> {
  const swotUrl =
    "https://cmr.earthdata.nasa.gov/search/granules.json?short_name=SWOT_L2_HR_RiverSP_2.0&page_size=4&sort_key=-start_date";
  const rcmUrl =
    "https://cmr.earthdata.nasa.gov/search/collections.json?keyword=RADARSAT&page_size=4";
  const seawifsUrl =
    "https://cmr.earthdata.nasa.gov/search/collections.json?keyword=SeaWiFS%20Chlorophyll&page_size=2";
  const appeearsUrl = "https://appeears.earthdatacloud.nasa.gov/api/product?limit=8";

  const [swotRes, rcmRes, seawifsRes, appeearsRes] = await Promise.allSettled([
    fetch(swotUrl, { signal: createBoundedSignal(1100), headers: { "User-Agent": USER_AGENT } }).then((r) =>
      r.ok ? r.json() : null
    ),
    fetch(rcmUrl, { signal: createBoundedSignal(1100), headers: { "User-Agent": USER_AGENT } }).then((r) =>
      r.ok ? r.json() : null
    ),
    fetch(seawifsUrl, { signal: createBoundedSignal(1100), headers: { "User-Agent": USER_AGENT } }).then((r) =>
      r.ok ? r.json() : null
    ),
    fetch(appeearsUrl, { signal: createBoundedSignal(1100), headers: { "User-Agent": USER_AGENT } }).then((r) =>
      r.ok ? r.json() : null
    ),
  ]);

  const passes: OrbitalMissionPass[] = [];
  if (swotRes.status === "fulfilled" && swotRes.value?.feed?.entry) {
    const entries = swotRes.value.feed.entry as Array<{
      id?: string;
      producer_granule_id?: string;
      boxes?: string[];
      time_start?: string;
    }>;
    for (const entry of entries.slice(0, 3)) {
      const centroid = parseCmrBoxCentroid(entry.boxes);
      if (!centroid) continue;
      passes.push({
        id: `swot-pass-${String(entry.id || passes.length).slice(-10).toLowerCase()}`,
        title: `SWOT RiverSP Vector Pass (${entry.producer_granule_id?.slice(0, 26) || "Global"})`,
        mission: "SWOT",
        lat: centroid.lat,
        lng: centroid.lng,
        observedAt: entry.time_start || new Date().toISOString(),
        sourceUrl: swotUrl,
        summary: `Live NASA/CNES/CSA SWOT_L2_HR_RiverSP_2.0 granule at (${centroid.lat}°, ${centroid.lng}°).`,
      });
    }
  }

  let rcmCollectionCount = 0;
  if (rcmRes.status === "fulfilled" && rcmRes.value?.feed?.entry) {
    rcmCollectionCount = (rcmRes.value.feed.entry as unknown[]).length;
  }

  let seawifsCollectionTitle: string | null = null;
  if (seawifsRes.status === "fulfilled" && seawifsRes.value?.feed?.entry?.[0]) {
    seawifsCollectionTitle = String(
      seawifsRes.value.feed.entry[0].title ?? "OrbView-2 SeaWiFS Chlorophyll"
    );
  }

  let appeearsProductCount = 0;
  if (appeearsRes.status === "fulfilled" && Array.isArray(appeearsRes.value)) {
    appeearsProductCount = appeearsRes.value.length;
  }

  return {
    passes,
    appeearsProductCount,
    rcmCollectionCount,
    seawifsCollectionTitle,
  };
}
