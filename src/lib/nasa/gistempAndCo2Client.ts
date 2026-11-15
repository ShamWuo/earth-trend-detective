import { type DataProvenanceMode } from "@/lib/earth/coordinates";
import {
  classifyUpstreamFault,
  createTelemetryBudget,
  parseUpstreamText,
  type TelemetryBudget,
} from "@/lib/earth/upstreamResilience";
import type { ETGDatasetId, TimeSeriesPoint, UpstreamFaultDetail } from "@/types/etg";

const USER_AGENT = "EarthTrendDetective/1.0 (NASA-Space-Apps; Scientific-Observatory)";
const CACHE_TTL_MS = 1000 * 60 * 15;

let gistempCsvCache: { expiresAt: number; csvText: string } | null = null;
let gistempMonthlyCache: { expiresAt: number; points: TimeSeriesPoint[] } | null = null;
let co2Cache: { expiresAt: number; sourceUrl: string; points: TimeSeriesPoint[] } | null = null;
let co2MonthlyCache: { expiresAt: number; points: TimeSeriesPoint[] } | null = null;
let nsidcCache: { expiresAt: number; sourceUrl: string; points: TimeSeriesPoint[] } | null = null;

export function clearGistempAndCo2Caches(): void {
  gistempCsvCache = null;
  gistempMonthlyCache = null;
  co2Cache = null;
  co2MonthlyCache = null;
  nsidcCache = null;
}

async function fetchTextWithRetry(
  url: string,
  accept: string,
  label: string,
  budget?: TelemetryBudget
): Promise<string> {
  const activeBudget = budget ?? createTelemetryBudget(1350);
  let lastError: unknown = null;
  const retryDelayMs = process.env.NODE_ENV === "test" ? 10 : 40;
  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAttemptAt = Date.now();
    try {
      const res = await fetch(url, {
        signal: activeBudget.signal(1150),
        headers: {
          Accept: accept,
          "User-Agent": USER_AGENT,
        },
      });
      return await parseUpstreamText(res, label);
    } catch (err) {
      const fault = classifyUpstreamFault(err, label);
      activeBudget.recordFault(fault);
      lastError = err;
      const attemptElapsed = Date.now() - startedAttemptAt;
      if (
        attempt === 0 &&
        fault.retryable &&
        attemptElapsed < 250 &&
        activeBudget.remainingMs() > 500
      ) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw err instanceof Error ? err : new Error(fault.message);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} request failed`);
}

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
  if (gistempCsvCache && gistempCsvCache.expiresAt > Date.now()) {
    return gistempCsvCache.csvText;
  }
  const url = "https://data.giss.nasa.gov/gistemp/tabledata_v4/ZonAnn.Ts+dSST.csv";
  try {
    const csvText = await fetchTextWithRetry(url, "text/csv,text/plain,*/*", "NASA GISTEMP v4");
    gistempCsvCache = { expiresAt: Date.now() + CACHE_TTL_MS, csvText };
    return csvText;
  } catch (err) {
    if (gistempCsvCache) {
      return gistempCsvCache.csvText;
    }
    throw err;
  }
}

export async function fetchNasaGistempZonalSeries(
  startYear = 1995,
  endYear = 2025
): Promise<ParsedGistempData> {
  const csvText = await fetchNasaGistempZonalCsvText();
  return parseGistempZonalCsv(csvText, startYear, endYear);
}

/**
 * Deterministic latitudinal GISTEMP zonal temperature anomaly baseline for offline/outage fallback.
 */
export function buildGistempClimatologicalFallback(
  startYear = 1995,
  endYear = 2025
): ParsedGistempData {
  const safeStart = Math.max(1980, Math.min(endYear - 2, startYear));
  const safeEnd = Math.max(safeStart + 2, endYear);
  const globalSeries: TimeSeriesPoint[] = [];
  for (let y = safeStart; y <= safeEnd; y++) {
    const dt = y - 1995;
    const val = 0.42 + dt * 0.029 + Math.sin(dt * 1.1) * 0.07;
    globalSeries.push({ date: String(y), t: y, value: Number(val.toFixed(2)) });
  }
  const zones = GISTEMP_ZONE_METADATA.map((z) => {
    const latFactor = z.lat > 60 ? 2.65 : z.lat < -60 ? 1.15 : 1 + (Math.abs(z.lat) / 90) * 0.65;
    const points: TimeSeriesPoint[] = [];
    for (let y = safeStart; y <= safeEnd; y++) {
      const dt = y - 1995;
      const val =
        (0.4 + dt * 0.028 * latFactor) +
        Math.sin(dt * 1.15 + z.lat * 0.04) * (0.1 + Math.abs(z.lat) * 0.002);
      points.push({ date: String(y), t: y, value: Number(val.toFixed(2)) });
    }
    return { ...z, points };
  });
  return {
    sourceUrl: "climatological://nasa-gistemp-v4-fallback",
    globalSeries,
    zones,
  };
}

export async function fetchNasaGistempZonalSeriesWithFallback(
  startYear = 1995,
  endYear = 2025,
  budget?: TelemetryBudget
): Promise<ParsedGistempData & { provenanceMode: DataProvenanceMode; upstreamFault?: UpstreamFaultDetail }> {
  const hadFreshCache = Boolean(gistempCsvCache && gistempCsvCache.expiresAt > Date.now());
  try {
    const csvText = gistempCsvCache && gistempCsvCache.expiresAt > Date.now()
      ? gistempCsvCache.csvText
      : await fetchTextWithRetry(
          "https://data.giss.nasa.gov/gistemp/tabledata_v4/ZonAnn.Ts+dSST.csv",
          "text/csv,text/plain,*/*",
          "NASA GISTEMP v4",
          budget
        ).then((text) => {
          gistempCsvCache = { expiresAt: Date.now() + CACHE_TTL_MS, csvText: text };
          return text;
        });
    const parsed = parseGistempZonalCsv(csvText, startYear, endYear);
    if (parsed.zones.length > 0) {
      return { ...parsed, provenanceMode: hadFreshCache ? "cached" : "live" };
    }
    const fault = classifyUpstreamFault(
      new Error("NASA GISTEMP v4 returned malformed or empty CSV zones"),
      "NASA GISTEMP v4"
    );
    budget?.recordFault(fault);
    return {
      ...buildGistempClimatologicalFallback(startYear, endYear),
      provenanceMode: "climatological_fallback",
      upstreamFault: fault,
    };
  } catch (err) {
    const fault = classifyUpstreamFault(err, "NASA GISTEMP v4");
    budget?.recordFault(fault);
    if (gistempCsvCache) {
      try {
        const parsed = parseGistempZonalCsv(gistempCsvCache.csvText, startYear, endYear);
        if (parsed.zones.length > 0) {
          return { ...parsed, provenanceMode: "cached", upstreamFault: fault };
        }
      } catch {
        // Fall through to climatological baseline
      }
    }
    return {
      ...buildGistempClimatologicalFallback(startYear, endYear),
      provenanceMode: "climatological_fallback",
      upstreamFault: fault,
    };
  }
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
 * Pure parser for NASA GISS GISTEMP v4 monthly global means CSV (`GLB.Ts+dSST.csv`).
 */
export function parseGistempMonthlyCsv(
  csvText: string,
  startYear = 1995,
  endYear = 2025
): TimeSeriesPoint[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const headerIdx = lines.findIndex((l) => l.startsWith("Year,Jan,Feb"));
  if (headerIdx < 0) return [];

  const headers = lines[headerIdx].split(",").map((h) => h.trim());
  const yearIdx = headers.indexOf("Year");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthCols = monthNames.map((m) => headers.indexOf(m));
  if (yearIdx < 0 || monthCols.some((idx) => idx < 0)) return [];

  const points: TimeSeriesPoint[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim());
    const year = Number(cells[yearIdx]);
    if (!Number.isInteger(year) || year < startYear || year > endYear) continue;
    for (let m = 0; m < 12; m++) {
      const raw = cells[monthCols[m]];
      if (!raw || raw.includes("*")) continue;
      const val = Number(raw);
      if (!Number.isFinite(val)) continue;
      points.push({
        date: `${year}-${String(m + 1).padStart(2, "0")}`,
        t: Number((year + (m + 0.5) / 12).toFixed(4)),
        value: Number(val.toFixed(3)),
      });
    }
  }
  return points.sort((a, b) => a.t - b.t);
}

/**
 * Fetches live NASA GISS GISTEMP v4 monthly global temperature anomaly (`GLB.Ts+dSST.csv`).
 * Returns `[]` gracefully on upstream timeout or malformed payload.
 */
export async function fetchNasaGistempGlobalMonthlySeries(
  startYear = 1995,
  endYear = 2025,
  budget?: TelemetryBudget
): Promise<TimeSeriesPoint[]> {
  if (gistempMonthlyCache && gistempMonthlyCache.expiresAt > Date.now()) {
    return gistempMonthlyCache.points.filter((p) => p.t >= startYear && p.t < endYear + 1);
  }
  try {
    const csvText = await fetchTextWithRetry(
      "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv",
      "text/csv,text/plain,*/*",
      "NASA GISTEMP v4 Monthly",
      budget
    );
    const parsed = parseGistempMonthlyCsv(csvText, startYear, endYear);
    if (parsed.length >= 24) {
      gistempMonthlyCache = { expiresAt: Date.now() + CACHE_TTL_MS, points: parsed };
      return parsed;
    }
  } catch {
    // Non-fatal: pipeline falls back cleanly to annual GISTEMP series
  }
  return [];
}

/**
 * Pure parser for NOAA GML Mauna Loa monthly CO2 CSV (`co2_mm_mlo.csv`).
 */
export function parseNoaaCo2MonthlyCsv(
  csvText: string,
  startYear = 1995,
  endYear = 2025
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (const rawLine of csvText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("year")) continue;
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 4) continue;
    const year = Number(cols[0]);
    const month = Number(cols[1]);
    const average = Number(cols[3]);
    if (
      !Number.isInteger(year) ||
      year < startYear ||
      year > endYear ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !Number.isFinite(average) ||
      average <= 0
    ) {
      continue;
    }
    points.push({
      date: `${year}-${String(month).padStart(2, "0")}`,
      t: Number((year + (month - 0.5) / 12).toFixed(4)),
      value: Number(average.toFixed(2)),
    });
  }
  return points.sort((a, b) => a.t - b.t);
}

/**
 * Fetches live NOAA GML monthly Mauna Loa CO2 concentration (`co2_mm_mlo.csv`).
 * Returns `[]` gracefully on upstream timeout or malformed payload.
 */
export async function fetchNoaaMonthlyCo2Series(
  startYear = 1995,
  endYear = 2025,
  budget?: TelemetryBudget
): Promise<TimeSeriesPoint[]> {
  if (co2MonthlyCache && co2MonthlyCache.expiresAt > Date.now()) {
    return co2MonthlyCache.points.filter((p) => p.t >= startYear && p.t < endYear + 1);
  }
  try {
    const csvText = await fetchTextWithRetry(
      "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv",
      "text/csv,text/plain,*/*",
      "NOAA GML CO2 Monthly",
      budget
    );
    const parsed = parseNoaaCo2MonthlyCsv(csvText, startYear, endYear);
    if (parsed.length >= 24) {
      co2MonthlyCache = { expiresAt: Date.now() + CACHE_TTL_MS, points: parsed };
      return parsed;
    }
  } catch {
    // Non-fatal: pipeline falls back cleanly to annual CO2 series
  }
  return [];
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
  if (co2Cache && co2Cache.expiresAt > Date.now()) {
    return { sourceUrl: co2Cache.sourceUrl, points: co2Cache.points };
  }
  const sourceUrl = "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.txt";
  try {
    const text = await fetchTextWithRetry(sourceUrl, "text/plain,*/*", "NOAA GML CO2");
    const points = parseNoaaCo2AnnMean(text, startYear, endYear);
    if (points.length < 5) {
      throw new Error("NOAA GML global CO2 series returned fewer than 5 annual points.");
    }
    co2Cache = { expiresAt: Date.now() + CACHE_TTL_MS, sourceUrl, points };
    return { sourceUrl, points };
  } catch (err) {
    if (co2Cache) {
      return { sourceUrl: co2Cache.sourceUrl, points: co2Cache.points };
    }
    throw err;
  }
}

export function buildNoaaCo2ClimatologicalFallback(
  startYear = 1995,
  endYear = 2025
): { sourceUrl: string; points: TimeSeriesPoint[] } {
  const safeStart = Math.max(1980, Math.min(endYear - 2, startYear));
  const safeEnd = Math.max(safeStart + 2, endYear);
  const points: TimeSeriesPoint[] = [];
  for (let y = safeStart; y <= safeEnd; y++) {
    const dt = y - 1995;
    const ppm = 360.2 + dt * 2.12 + 0.012 * dt * dt;
    points.push({ date: String(y), t: y, value: Number(ppm.toFixed(2)) });
  }
  return { sourceUrl: "climatological://noaa-gml-co2-fallback", points };
}

export async function fetchNoaaGlobalCo2SeriesWithFallback(
  startYear = 1995,
  endYear = 2025,
  budget?: TelemetryBudget
): Promise<{
  sourceUrl: string;
  points: TimeSeriesPoint[];
  provenanceMode: DataProvenanceMode;
  upstreamFault?: UpstreamFaultDetail;
}> {
  const hadFreshCache = Boolean(co2Cache && co2Cache.expiresAt > Date.now());
  try {
    if (co2Cache && co2Cache.expiresAt > Date.now()) {
      return {
        sourceUrl: co2Cache.sourceUrl,
        points: co2Cache.points.filter((p) => p.t >= startYear && p.t <= endYear),
        provenanceMode: "cached",
      };
    }
    const sourceUrl = "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.txt";
    const text = await fetchTextWithRetry(sourceUrl, "text/plain,*/*", "NOAA GML CO2", budget);
    const parsed = parseNoaaCo2AnnMean(text, startYear, endYear);
    if (parsed.length < 3) {
      throw new Error("NOAA GML CO2 returned malformed or empty rows");
    }
    co2Cache = { expiresAt: Date.now() + CACHE_TTL_MS, sourceUrl, points: parsed };
    return { sourceUrl, points: parsed, provenanceMode: hadFreshCache ? "cached" : "live" };
  } catch (err) {
    const fault = classifyUpstreamFault(err, "NOAA GML CO2");
    budget?.recordFault(fault);
    if (co2Cache) {
      return {
        sourceUrl: co2Cache.sourceUrl,
        points: co2Cache.points,
        provenanceMode: "cached",
        upstreamFault: fault,
      };
    }
    return {
      ...buildNoaaCo2ClimatologicalFallback(startYear, endYear),
      provenanceMode: "climatological_fallback",
      upstreamFault: fault,
    };
  }
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
  if (nsidcCache && nsidcCache.expiresAt > Date.now()) {
    return { sourceUrl: nsidcCache.sourceUrl, points: nsidcCache.points };
  }
  const sourceUrl =
    "https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_09_extent_v4.0.csv";
  try {
    const csvText = await fetchTextWithRetry(
      sourceUrl,
      "text/csv,text/plain,*/*",
      "NOAA/NSIDC Sea Ice v4"
    );
    const points = parseNsidcSeaIceCsv(csvText, startYear, endYear);
    if (points.length < 5) {
      throw new Error("NOAA/NSIDC Sea Ice v4 returned fewer than 5 annual September points.");
    }
    nsidcCache = { expiresAt: Date.now() + CACHE_TTL_MS, sourceUrl, points };
    return { sourceUrl, points };
  } catch (err) {
    if (nsidcCache) {
      return { sourceUrl: nsidcCache.sourceUrl, points: nsidcCache.points };
    }
    throw err;
  }
}

export function buildNsidcSeaIceClimatologicalFallback(
  startYear = 1995,
  endYear = 2025
): { sourceUrl: string; points: TimeSeriesPoint[] } {
  const safeStart = Math.max(1980, Math.min(endYear - 2, startYear));
  const safeEnd = Math.max(safeStart + 2, endYear);
  const points: TimeSeriesPoint[] = [];
  for (let y = safeStart; y <= safeEnd; y++) {
    const dt = y - 1995;
    const extent = Math.max(3.4, 6.28 - dt * 0.072 + Math.sin(dt * 1.45) * 0.24);
    points.push({ date: String(y), t: y, value: Number(extent.toFixed(2)) });
  }
  return { sourceUrl: "climatological://nsidc-seaice-v4-fallback", points };
}

export async function fetchNsidcArcticSeaIceSeriesWithFallback(
  startYear = 1995,
  endYear = 2025,
  budget?: TelemetryBudget
): Promise<{
  sourceUrl: string;
  points: TimeSeriesPoint[];
  provenanceMode: DataProvenanceMode;
  upstreamFault?: UpstreamFaultDetail;
}> {
  const hadFreshCache = Boolean(nsidcCache && nsidcCache.expiresAt > Date.now());
  try {
    if (nsidcCache && nsidcCache.expiresAt > Date.now()) {
      return {
        sourceUrl: nsidcCache.sourceUrl,
        points: nsidcCache.points.filter((p) => p.t >= startYear && p.t <= endYear),
        provenanceMode: "cached",
      };
    }
    const sourceUrl =
      "https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_09_extent_v4.0.csv";
    const csvText = await fetchTextWithRetry(
      sourceUrl,
      "text/csv,text/plain,*/*",
      "NSIDC Sea Ice Index v4",
      budget
    );
    const parsed = parseNsidcSeaIceCsv(csvText, startYear, endYear);
    if (parsed.length < 3) {
      throw new Error("NSIDC Sea Ice Index returned malformed or empty CSV");
    }
    nsidcCache = { expiresAt: Date.now() + CACHE_TTL_MS, sourceUrl, points: parsed };
    return { sourceUrl, points: parsed, provenanceMode: hadFreshCache ? "cached" : "live" };
  } catch (err) {
    const fault = classifyUpstreamFault(err, "NSIDC Sea Ice Index v4");
    budget?.recordFault(fault);
    if (nsidcCache) {
      return {
        sourceUrl: nsidcCache.sourceUrl,
        points: nsidcCache.points,
        provenanceMode: "cached",
        upstreamFault: fault,
      };
    }
    return {
      ...buildNsidcSeaIceClimatologicalFallback(startYear, endYear),
      provenanceMode: "climatological_fallback",
      upstreamFault: fault,
    };
  }
}
