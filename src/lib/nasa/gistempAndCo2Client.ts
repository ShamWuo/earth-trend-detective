import type { ETGDatasetId, TimeSeriesPoint } from "@/types/etg";

const USER_AGENT = "EarthTrendDetective/1.0 (NASA-Space-Apps; Scientific-Observatory)";

export interface GistempZoneMeta {
  column: string;
  id: string;
  regionName: string;
  lat: number;
  lng: number;
  dataset: ETGDatasetId;
}

export const GISTEMP_ZONE_METADATA: readonly GistempZoneMeta[] = [
  { column: "64N-90N", id: "64n-90n", regionName: "Arctic Polar Band (64°N–90°N)", lat: 76.0, lng: -15.0, dataset: "ocean_temp" },
  { column: "44N-64N", id: "44n-64n", regionName: "Northern Boreal Belt (44°N–64°N)", lat: 54.0, lng: 85.0, dataset: "nasa_power" },
  { column: "24N-44N", id: "24n-44n", regionName: "Northern Subtropics (24°N–44°N)", lat: 34.0, lng: -118.0, dataset: "nasa_power" },
  { column: "EQU-24N", id: "equ-24n", regionName: "Northern Tropics (0°–24°N)", lat: 12.0, lng: -145.0, dataset: "ocean_temp" },
  { column: "24S-EQU", id: "24s-equ", regionName: "Southern Tropics (24°S–0°)", lat: -12.0, lng: -55.0, dataset: "nasa_power" },
  { column: "44S-24S", id: "44s-24s", regionName: "Southern Subtropics (44°S–24°S)", lat: -34.0, lng: 138.0, dataset: "ocean_temp" },
  { column: "64S-44S", id: "64s-44s", regionName: "Sub-Antarctic Belt (64°S–44°S)", lat: -54.0, lng: -35.0, dataset: "ocean_temp" },
  { column: "90S-64S", id: "90s-64s", regionName: "Antarctic Polar Zone (90°S–64°S)", lat: -76.0, lng: 165.0, dataset: "ocean_temp" },
] as const;

export interface ParsedGistempData {
  sourceUrl: string;
  globalSeries: TimeSeriesPoint[];
  zones: Array<GistempZoneMeta & { points: TimeSeriesPoint[] }>;
}

/**
 * Pure parser for NASA GISS GISTEMP v4 ZonAnn.Ts+dSST.csv.
 */
export function parseGistempZonalCsv(
  csvText: string,
  startYear = 1995,
  endYear = 2025
): ParsedGistempData {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("NASA GISTEMP v4 CSV contained insufficient rows.");
  }

  const headers = lines[0].split(",").map((h) => h.trim());
  const yearIdx = headers.indexOf("Year");
  const globIdx = headers.indexOf("Glob");
  if (yearIdx < 0 || globIdx < 0) {
    throw new Error("NASA GISTEMP v4 CSV missing expected Year or Glob column.");
  }

  const globalSeries: TimeSeriesPoint[] = [];
  const zoneBuckets = new Map<string, TimeSeriesPoint[]>();
  for (const z of GISTEMP_ZONE_METADATA) {
    zoneBuckets.set(z.column, []);
  }

  const colIndices = new Map<string, number>();
  for (const z of GISTEMP_ZONE_METADATA) {
    const idx = headers.indexOf(z.column);
    if (idx >= 0) colIndices.set(z.column, idx);
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim());
    const year = Number(cells[yearIdx]);
    if (!Number.isInteger(year) || year < startYear || year > endYear) continue;

    const globRaw = cells[globIdx];
    const globVal = Number(globRaw);
    if (globRaw && !globRaw.includes("*") && Number.isFinite(globVal)) {
      globalSeries.push({ date: `${year}`, t: year, value: globVal });
    }

    for (const z of GISTEMP_ZONE_METADATA) {
      const idx = colIndices.get(z.column);
      if (idx === undefined) continue;
      const raw = cells[idx];
      const val = Number(raw);
      if (!raw || raw.includes("*") || !Number.isFinite(val)) continue;
      zoneBuckets.get(z.column)!.push({ date: `${year}`, t: year, value: val });
    }
  }

  return {
    sourceUrl: "https://data.giss.nasa.gov/gistemp/tabledata_v4/ZonAnn.Ts+dSST.csv",
    globalSeries,
    zones: GISTEMP_ZONE_METADATA.map((z) => ({
      ...z,
      points: zoneBuckets.get(z.column) ?? [],
    })).filter((z) => z.points.length >= 5),
  };
}

/**
 * Fetches live NASA GISS GISTEMP v4 zonal surface temperature anomaly CSV.
 */
export async function fetchNasaGistempZonalCsvText(): Promise<string> {
  const url = "https://data.giss.nasa.gov/gistemp/tabledata_v4/ZonAnn.Ts+dSST.csv";
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: {
      Accept: "text/csv,text/plain,*/*",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`NASA GISTEMP v4 HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

export async function fetchNasaGistempZonalSeries(
  startYear = 1995,
  endYear = 2025
): Promise<ParsedGistempData> {
  const csvText = await fetchNasaGistempZonalCsvText();
  return parseGistempZonalCsv(csvText, startYear, endYear);
}

/**
 * Pure parser for NOAA GML co2_annmean_gl.txt.
 */
export function parseNoaaCo2AnnMean(
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
    const mean = Number(parts[1]);
    if (!Number.isInteger(year) || !Number.isFinite(mean)) continue;
    if (year < startYear || year > endYear) continue;
    points.push({
      date: `${year}`,
      t: year,
      value: Number(mean.toFixed(2)),
    });
  }
  return points.sort((a, b) => a.t - b.t);
}

/**
 * Fetches live NOAA Global Monitoring Laboratory annual marine surface CO2 mean.
 */
export async function fetchNoaaGlobalCo2Series(
  startYear = 1995,
  endYear = 2025
): Promise<{
  sourceUrl: string;
  points: TimeSeriesPoint[];
}> {
  const sourceUrl = "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.txt";
  const res = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(12000),
    headers: {
      Accept: "text/plain,*/*",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`NOAA GML CO2 HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const points = parseNoaaCo2AnnMean(text, startYear, endYear);
  if (points.length < 5) {
    throw new Error("NOAA GML global CO2 series returned fewer than 5 annual points.");
  }
  return { sourceUrl, points };
}

/**
 * Pure parser for NOAA/NSIDC Sea Ice Index v4.0 monthly September CSV
 * (`year, mo,source_dataset, region, extent, area`).
 */
export function parseNsidcSeaIceCsv(
  csvText: string,
  startYear = 1995,
  endYear = 2025
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  const lines = csvText.split(/\r?\n/);

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;
    const cols = rawLine.split(",").map((c) => c.trim());
    if (cols.length < 5) continue;

    const year = Number(cols[0]);
    const extent = Number(cols[4]);
    if (!Number.isInteger(year) || year < startYear || year > endYear) continue;
    if (!Number.isFinite(extent) || extent <= 0) continue; // skip negative sentinel fill (-9999)

    points.push({
      date: `${year}`,
      t: year,
      value: Number(extent.toFixed(2)),
    });
  }

  return points.sort((a, b) => a.t - b.t);
}

/**
 * Fetches live NOAA/NSIDC Sea Ice Index v4.0 September Arctic sea ice minimum extent (million km^2).
 */
export async function fetchNsidcArcticSeaIceSeries(
  startYear = 1995,
  endYear = 2025
): Promise<{
  sourceUrl: string;
  points: TimeSeriesPoint[];
}> {
  const sourceUrl =
    "https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_09_extent_v4.0.csv";
  const res = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(12000),
    headers: {
      Accept: "text/csv,text/plain,*/*",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`NOAA/NSIDC Sea Ice v4 HTTP ${res.status} ${res.statusText}`);
  }
  const csvText = await res.text();
  const points = parseNsidcSeaIceCsv(csvText, startYear, endYear);
  if (points.length < 5) {
    throw new Error("NOAA/NSIDC Sea Ice v4 returned fewer than 5 annual September points.");
  }
  return { sourceUrl, points };
}
