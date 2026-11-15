import { parseUsgsAnnualRdb } from "@/lib/agencies/challengeSourcesClient";
import { haversineDistanceKm } from "@/lib/plainLanguage";
import type { TimeSeriesPoint, TrendProvenanceSource } from "@/types/etg";

const USER_AGENT =
  "EarthTrendDetective/1.0 (NASA-Space-Apps; Open-Physical-Feeds)";

export interface UsgsSiteCandidate {
  siteNo: string;
  siteName: string;
  lat: number;
  lng: number;
  distanceKm: number;
}

export interface OpenFeedSeriesResult {
  points: TimeSeriesPoint[];
  metricName: string;
  unit: string;
  parameterCode: string;
  provenanceSource: TrendProvenanceSource;
  sourceUrl: string;
  siteInfo?: UsgsSiteCandidate;
}

/**
 * USGS NWIS gauges cover the United States, territories, and border basins.
 */
export function isWithinUsgsBounds(lat: number, lng: number): boolean {
  return lat >= 17.5 && lat <= 72 && lng >= -170 && lng <= -64.5;
}

/**
 * Parses USGS NWIS `/nwis/site/?format=rdb` tab-delimited station metadata and
 * orders candidate stream gauges by geodesic distance from `(targetLat, targetLng)`.
 */
export function parseUsgsSiteRdb(
  rdbText: string,
  targetLat: number,
  targetLng: number
): UsgsSiteCandidate[] {
  const lines = rdbText.split(/\r?\n/);
  let headers: string[] | null = null;
  let sawFormatRow = false;
  const candidates: UsgsSiteCandidate[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;

    if (!headers) {
      headers = line.split("\t").map((col) => col.trim());
      continue;
    }

    if (!sawFormatRow) {
      sawFormatRow = true;
      continue;
    }

    const cols = line.split("\t");
    const row = new Map<string, string>();
    for (let i = 0; i < headers.length; i++) {
      row.set(headers[i], (cols[i] ?? "").trim());
    }

    const siteNo = row.get("site_no") ?? "";
    const siteName = row.get("station_nm") || `USGS ${siteNo}`;
    const lat = Number(row.get("dec_lat_va"));
    const lng = Number(row.get("dec_long_va"));

    if (!siteNo || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }

    candidates.push({
      siteNo,
      siteName,
      lat,
      lng,
      distanceKm: Number(haversineDistanceKm(targetLat, targetLng, lat, lng).toFixed(1)),
    });
  }

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  return candidates;
}

/**
 * Finds the nearest active USGS stream gauge within ~1.25 deg bounding box and
 * retrieves its annual mean discharge (`parameterCd=00060`) converted to m³/s.
 */
export async function fetchNearestUsgsGaugeAnnualSeries(
  lat: number,
  lng: number,
  startYear = 1995,
  endYear = 2025
): Promise<OpenFeedSeriesResult | null> {
  if (!isWithinUsgsBounds(lat, lng)) {
    return null;
  }

  const delta = 1.25;
  const minLng = Math.max(-170, lng - delta);
  const maxLng = Math.min(-64.5, lng + delta);
  const minLat = Math.max(17.5, lat - delta);
  const maxLat = Math.min(72, lat + delta);

  // NOTE: USGS NWIS requires mixed-case `bBox` (lowercase returns HTTP 400).
  const siteQueryUrl =
    `https://waterservices.usgs.gov/nwis/site/?format=rdb` +
    `&bBox=${minLng.toFixed(3)},${minLat.toFixed(3)},${maxLng.toFixed(3)},${maxLat.toFixed(3)}` +
    `&parameterCd=00060&siteStatus=active&hasDataTypeCd=dv`;

  const siteRes = await fetch(siteQueryUrl, {
    signal: AbortSignal.timeout(9000),
    headers: { Accept: "text/plain", "User-Agent": USER_AGENT },
  });
  if (!siteRes.ok) {
    return null;
  }

  const siteRdb = await siteRes.text();
  const candidates = parseUsgsSiteRdb(siteRdb, lat, lng).slice(0, 3);
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    const statUrl =
      `https://waterservices.usgs.gov/nwis/stat/?format=rdb` +
      `&sites=${encodeURIComponent(candidate.siteNo)}` +
      `&statReportType=annual&statTypeCd=mean&parameterCd=00060`;

    const statRes = await fetch(statUrl, {
      signal: AbortSignal.timeout(9000),
      headers: { Accept: "text/plain", "User-Agent": USER_AGENT },
    });
    if (!statRes.ok) continue;

    const statRdb = await statRes.text();
    const points = parseUsgsAnnualRdb(statRdb, startYear, endYear);
    if (points.length >= 6) {
      return {
        points,
        metricName: `River Discharge — ${candidate.siteName} (${candidate.distanceKm} km)`,
        unit: "m³/s",
        parameterCode: "USGS_00060",
        provenanceSource: "USGS NWIS River Gauge (Live)",
        sourceUrl: statUrl,
        siteInfo: candidate,
      };
    }
  }

  return null;
}

/**
 * Parses Copernicus GloFAS v4 daily river discharge JSON (`river_discharge`, m³/s)
 * into annual or monthly mean time-series points.
 */
export function parseGlofasDailyPayload(
  payload: unknown,
  startYear = 1995,
  endYear = 2025,
  granularity: "annual" | "monthly" = "annual"
): TimeSeriesPoint[] {
  const daily = (payload as { daily?: { time?: unknown; river_discharge?: unknown } })?.daily;
  if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.river_discharge)) {
    return [];
  }

  const buckets = new Map<string, { t: number; values: number[] }>();
  const len = Math.min(daily.time.length, daily.river_discharge.length);

  for (let i = 0; i < len; i++) {
    const rawDate = daily.time[i];
    const rawVal = daily.river_discharge[i];
    if (typeof rawDate !== "string") continue;
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(rawDate);
    if (!match) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year < startYear || year > endYear) continue;

    const val = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(val) || val < 0) continue;

    const key = granularity === "monthly" ? `${year}-${match[2]}` : `${year}`;
    const t =
      granularity === "monthly"
        ? Number((year + (month - 0.5) / 12).toFixed(4))
        : year;

    const existing = buckets.get(key) ?? { t, values: [] };
    existing.values.push(val);
    buckets.set(key, existing);
  }

  const minSamplesPerBucket = granularity === "monthly" ? 10 : 30;
  return Array.from(buckets.entries())
    .filter(([, entry]) => entry.values.length >= minSamplesPerBucket)
    .sort((a, b) => a[1].t - b[1].t)
    .map(([date, entry]) => {
      const mean =
        entry.values.reduce((sum, v) => sum + v, 0) / entry.values.length;
      return {
        date,
        t: entry.t,
        value: Number(mean.toFixed(3)),
      };
    });
}

/**
 * Fetches Copernicus GloFAS v4 5km river discharge time-series (`m³/s`) via Open-Meteo Flood API.
 */
export async function fetchGlofasDischargeSeries(
  lat: number,
  lng: number,
  startYear = 1995,
  endYear = 2025,
  granularity: "annual" | "monthly" = "annual"
): Promise<OpenFeedSeriesResult | null> {
  const safeStartYear = Math.max(1984, startYear);
  const safeEndYear = Math.min(2026, endYear);
  const url =
    `https://flood-api.open-meteo.com/v1/flood` +
    `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&daily=river_discharge&start_date=${safeStartYear}-01-01&end_date=${safeEndYear}-12-31`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    return null;
  }

  const json = await res.json();
  const points = parseGlofasDailyPayload(json, startYear, endYear, granularity);
  if (points.length < 6) {
    return null;
  }

  return {
    points,
    metricName: "GloFAS v4 River Discharge (5km Grid)",
    unit: "m³/s",
    parameterCode: "GLOFAS_RIVER_DISCHARGE",
    provenanceSource: "Copernicus GloFAS v4 (Live)",
    sourceUrl: url,
  };
}

/**
 * Parses Copernicus CAMS hourly PM2.5 JSON (`pm2_5`, μg/m³) into monthly or annual means.
 */
export function parseCamsHourlyPm25Payload(
  payload: unknown,
  startYear = 2020,
  endYear = 2025,
  granularity: "annual" | "monthly" = "monthly"
): TimeSeriesPoint[] {
  const hourly = (payload as { hourly?: { time?: unknown; pm2_5?: unknown } })?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.pm2_5)) {
    return [];
  }

  const buckets = new Map<string, { t: number; values: number[] }>();
  const len = Math.min(hourly.time.length, hourly.pm2_5.length);

  for (let i = 0; i < len; i++) {
    const rawTime = hourly.time[i];
    const rawVal = hourly.pm2_5[i];
    if (typeof rawTime !== "string") continue;
    const match = /^(\d{4})-(\d{2})-\d{2}T/.exec(rawTime);
    if (!match) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year < startYear || year > endYear) continue;

    const val = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(val) || val < 0) continue;

    const key = granularity === "monthly" ? `${year}-${match[2]}` : `${year}`;
    const t =
      granularity === "monthly"
        ? Number((year + (month - 0.5) / 12).toFixed(4))
        : year;

    const existing = buckets.get(key) ?? { t, values: [] };
    existing.values.push(val);
    buckets.set(key, existing);
  }

  const minHoursPerBucket = granularity === "monthly" ? 24 : 200;
  return Array.from(buckets.entries())
    .filter(([, entry]) => entry.values.length >= minHoursPerBucket)
    .sort((a, b) => a[1].t - b[1].t)
    .map(([date, entry]) => {
      const mean =
        entry.values.reduce((sum, v) => sum + v, 0) / entry.values.length;
      return {
        date,
        t: entry.t,
        value: Number(mean.toFixed(2)),
      };
    });
}

/**
 * Fetches live Copernicus CAMS hourly surface PM2.5 (`μg/m³`) via Open-Meteo Air Quality API
 * and returns monthly or annual mean observations.
 */
export async function fetchCamsSurfacePm25Series(
  lat: number,
  lng: number,
  startYear = 2022,
  endYear = 2025,
  granularity: "annual" | "monthly" = "monthly"
): Promise<OpenFeedSeriesResult | null> {
  // CAMS reanalysis PM2.5 archive on Open-Meteo starts mid-2022; clamping keeps payloads fast.
  const queryStartYear = endYear >= 2022 ? Math.max(startYear, 2022) : startYear;
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&hourly=pm2_5&start_date=${queryStartYear}-01-01&end_date=${endYear}-12-31`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    return null;
  }

  const json = await res.json();
  const points = parseCamsHourlyPm25Payload(json, startYear, endYear, granularity);
  if (points.length < 6) {
    return null;
  }

  return {
    points,
    metricName: "Copernicus CAMS Surface PM2.5",
    unit: "μg/m³",
    parameterCode: "CAMS_PM2_5",
    provenanceSource: "Copernicus CAMS PM2.5 (Live)",
    sourceUrl: url,
  };
}
