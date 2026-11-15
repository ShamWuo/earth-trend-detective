import { parseUsgsAnnualRdb } from "@/lib/agencies/challengeSourcesClient";
import {
  buildClimatologicalSeriesPoints,
  normalizeEarthCoordinates,
  type DataProvenanceMode,
} from "@/lib/earth/coordinates";
import {
  classifyUpstreamFault,
  createTelemetryBudget,
  parseUpstreamJson,
  parseUpstreamText,
  type TelemetryBudget,
} from "@/lib/earth/upstreamResilience";
import { haversineDistanceKm } from "@/lib/plainLanguage";
import type { TimeSeriesPoint, TrendProvenanceSource, UpstreamFaultDetail } from "@/types/etg";

const USER_AGENT =
  "EarthTrendDetective/1.0 (NASA-Space-Apps; Open-Physical-Feeds)";
const OPEN_FEEDS_CACHE_TTL_MS = 1000 * 60 * 15;
const OPEN_FEEDS_CACHE = new Map<
  string,
  { expiresAt: number; result: OpenFeedSeriesResult }
>();

export function clearOpenFeedsCache(): void {
  OPEN_FEEDS_CACHE.clear();
}

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
  provenanceMode?: DataProvenanceMode;
  sourceUrl: string;
  siteInfo?: UsgsSiteCandidate;
  upstreamFault?: UpstreamFaultDetail;
}

/**
 * Deterministic climatological baseline for Copernicus GloFAS / CAMS PM2.5 / USGS
 * when live upstream endpoints time out, return HTTP 429/5xx, or fail offline.
 */
export function buildOpenFeedClimatologicalFallback(
  feed: "cams_pm25" | "usgs_gauge" | "glofas_discharge",
  lat: number,
  lng: number,
  startYear = 1995,
  endYear = 2025,
  granularity: "annual" | "monthly" = feed === "cams_pm25" ? "monthly" : "annual"
): OpenFeedSeriesResult {
  const coord = normalizeEarthCoordinates(lat, lng, {
    poleGuardMargin: 0,
    antimeridianMargin: 0,
  });
  const dataset = feed === "cams_pm25" ? "air_quality" : "hydrology";
  const subMetric = feed === "cams_pm25" ? "pm25" : "river_discharge";
  const base = buildClimatologicalSeriesPoints(
    coord.lat,
    coord.lng,
    dataset,
    startYear,
    endYear,
    { subMetric }
  );

  let points = base.points;
  if (granularity === "monthly") {
    const phase = ((coord.lat * 0.17 + coord.lng * 0.11) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const amp = feed === "cams_pm25" ? 1.8 : 12.0;
    points = base.points.flatMap((pt) => {
      const y = Number(pt.date.slice(0, 4));
      if (!Number.isInteger(y)) return [];
      return Array.from({ length: 12 }, (_, idx) => {
        const m = idx + 1;
        const val = Math.max(0.2, pt.value + Math.sin(((m - 1) / 12) * Math.PI * 2 + phase) * amp);
        return {
          date: `${y}-${String(m).padStart(2, "0")}`,
          t: Number((y + (m - 0.5) / 12).toFixed(4)),
          value: Number(val.toFixed(2)),
        };
      });
    });
  }

  return {
    points,
    metricName:
      feed === "cams_pm25"
        ? "Copernicus CAMS Surface PM2.5 (Climatological Fallback)"
        : "GloFAS v4 River Discharge (Climatological Fallback)",
    unit: feed === "cams_pm25" ? "μg/m³" : "m³/s",
    parameterCode: feed === "cams_pm25" ? "CAMS_PM2_5" : "GLOFAS_RIVER_DISCHARGE",
    provenanceSource:
      feed === "cams_pm25"
        ? "Copernicus CAMS PM2.5 (Climatological Fallback)"
        : "Copernicus GloFAS v4 (Climatological Fallback)",
    provenanceMode: "climatological_fallback",
    sourceUrl: "climatological://open-feeds-fallback",
  };
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
  endYear = 2025,
  budget?: TelemetryBudget
): Promise<OpenFeedSeriesResult | null> {
  const coord = normalizeEarthCoordinates(lat, lng, {
    poleGuardMargin: 0,
    antimeridianMargin: 0,
  });
  if (!isWithinUsgsBounds(coord.lat, coord.lng)) {
    return null;
  }

  const cacheKey = `usgs:${coord.lat.toFixed(2)}:${coord.lng.toFixed(2)}:${startYear}:${endYear}`;
  const cached = OPEN_FEEDS_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, provenanceMode: "cached" };
  }

  const activeBudget = budget ?? createTelemetryBudget(1350);
  const delta = 1.25;
  const minLng = Math.max(-170, coord.lng - delta);
  const maxLng = Math.min(-64.5, coord.lng + delta);
  const minLat = Math.max(17.5, coord.lat - delta);
  const maxLat = Math.min(72, coord.lat + delta);

  // NOTE: USGS NWIS requires mixed-case `bBox` (lowercase returns HTTP 400).
  const siteQueryUrl =
    `https://waterservices.usgs.gov/nwis/site/?format=rdb` +
    `&bBox=${minLng.toFixed(3)},${minLat.toFixed(3)},${maxLng.toFixed(3)},${maxLat.toFixed(3)}` +
    `&parameterCd=00060&siteStatus=active&hasDataTypeCd=dv`;

  try {
    const siteRes = await fetch(siteQueryUrl, {
      signal: activeBudget.signal(650),
      headers: { Accept: "text/plain", "User-Agent": USER_AGENT },
    });
    const siteRdb = await parseUpstreamText(siteRes, "USGS NWIS Site");
    const candidates = parseUsgsSiteRdb(siteRdb, coord.lat, coord.lng).slice(0, 3);
    if (candidates.length === 0) {
      return null;
    }

    const statAttempts = await Promise.allSettled(
      candidates.map(async (candidate) => {
        const statUrl =
          `https://waterservices.usgs.gov/nwis/stat/?format=rdb` +
          `&sites=${encodeURIComponent(candidate.siteNo)}` +
          `&statReportType=annual&statTypeCd=mean&parameterCd=00060`;

        const statRes = await fetch(statUrl, {
          signal: activeBudget.signal(750),
          headers: { Accept: "text/plain", "User-Agent": USER_AGENT },
        });
        const statRdb = await parseUpstreamText(statRes, `USGS NWIS Stat (${candidate.siteNo})`);
        const points = parseUsgsAnnualRdb(statRdb, startYear, endYear);
        if (points.length < 6) {
          throw new Error(`USGS site ${candidate.siteNo} returned < 6 annual points`);
        }
        return { candidate, statUrl, points };
      })
    );

    for (const outcome of statAttempts) {
      if (outcome.status === "fulfilled") {
        const { candidate, statUrl, points } = outcome.value;
        const result: OpenFeedSeriesResult = {
          points,
          metricName: `River Discharge — ${candidate.siteName} (${candidate.distanceKm} km)`,
          unit: "m³/s",
          parameterCode: "USGS_00060",
          provenanceSource: "USGS NWIS River Gauge (Live)",
          provenanceMode: "live",
          sourceUrl: statUrl,
          siteInfo: candidate,
        };
        OPEN_FEEDS_CACHE.set(cacheKey, {
          expiresAt: Date.now() + OPEN_FEEDS_CACHE_TTL_MS,
          result,
        });
        return result;
      } else {
        activeBudget.recordFault(
          classifyUpstreamFault(outcome.reason, "USGS NWIS Stat")
        );
      }
    }
  } catch (err) {
    const fault = classifyUpstreamFault(err, "USGS NWIS Site");
    activeBudget.recordFault(fault);
    return cached ? { ...cached.result, provenanceMode: "cached", upstreamFault: fault } : null;
  }

  return cached
    ? {
        ...cached.result,
        provenanceMode: "cached",
        ...(activeBudget.faults[0] ? { upstreamFault: activeBudget.faults[0] } : {}),
      }
    : null;
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
  granularity: "annual" | "monthly" = "annual",
  budget?: TelemetryBudget
): Promise<OpenFeedSeriesResult | null> {
  const coord = normalizeEarthCoordinates(lat, lng);
  const safeStartYear = Math.max(1984, startYear);
  const safeEndYear = Math.min(2026, endYear);
  const cacheKey = `glofas:${coord.apiLat.toFixed(2)}:${coord.apiLng.toFixed(2)}:${safeStartYear}:${safeEndYear}:${granularity}`;
  const cached = OPEN_FEEDS_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, provenanceMode: "cached" };
  }

  const activeBudget = budget ?? createTelemetryBudget(1350);
  const url =
    `https://flood-api.open-meteo.com/v1/flood` +
    `?latitude=${coord.apiLat.toFixed(4)}&longitude=${coord.apiLng.toFixed(4)}` +
    `&daily=river_discharge&start_date=${safeStartYear}-01-01&end_date=${safeEndYear}-12-31`;

  try {
    const res = await fetch(url, {
      signal: activeBudget.signal(1150),
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    const json = await parseUpstreamJson<unknown>(res, "Copernicus GloFAS v4");
    const points = parseGlofasDailyPayload(json, startYear, endYear, granularity);
    if (points.length < 6) {
      return null;
    }

    const result: OpenFeedSeriesResult = {
      points,
      metricName: "GloFAS v4 River Discharge (5km Grid)",
      unit: "m³/s",
      parameterCode: "GLOFAS_RIVER_DISCHARGE",
      provenanceSource: "Copernicus GloFAS v4 (Live)",
      provenanceMode: "live",
      sourceUrl: url,
    };
    OPEN_FEEDS_CACHE.set(cacheKey, {
      expiresAt: Date.now() + OPEN_FEEDS_CACHE_TTL_MS,
      result,
    });
    return result;
  } catch (err) {
    const fault = classifyUpstreamFault(err, "Copernicus GloFAS v4");
    activeBudget.recordFault(fault);
    return cached ? { ...cached.result, provenanceMode: "cached", upstreamFault: fault } : null;
  }
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
  granularity: "annual" | "monthly" = "monthly",
  budget?: TelemetryBudget
): Promise<OpenFeedSeriesResult | null> {
  const coord = normalizeEarthCoordinates(lat, lng);
  // CAMS reanalysis PM2.5 archive on Open-Meteo starts mid-2022; clamping keeps payloads fast.
  const queryStartYear = endYear >= 2022 ? Math.max(startYear, 2022) : startYear;
  const cacheKey = `cams:${coord.apiLat.toFixed(2)}:${coord.apiLng.toFixed(2)}:${queryStartYear}:${endYear}:${granularity}`;
  const cached = OPEN_FEEDS_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, provenanceMode: "cached" };
  }

  const activeBudget = budget ?? createTelemetryBudget(1350);
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${coord.apiLat.toFixed(4)}&longitude=${coord.apiLng.toFixed(4)}` +
    `&hourly=pm2_5&start_date=${queryStartYear}-01-01&end_date=${endYear}-12-31`;

  try {
    const res = await fetch(url, {
      signal: activeBudget.signal(1150),
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    const json = await parseUpstreamJson<unknown>(res, "Copernicus CAMS PM2.5");
    const points = parseCamsHourlyPm25Payload(json, startYear, endYear, granularity);
    if (points.length < 6) {
      return null;
    }

    const result: OpenFeedSeriesResult = {
      points,
      metricName: "Copernicus CAMS Surface PM2.5",
      unit: "μg/m³",
      parameterCode: "CAMS_PM2_5",
      provenanceSource: "Copernicus CAMS PM2.5 (Live)",
      provenanceMode: "live",
      sourceUrl: url,
    };
    OPEN_FEEDS_CACHE.set(cacheKey, {
      expiresAt: Date.now() + OPEN_FEEDS_CACHE_TTL_MS,
      result,
    });
    return result;
  } catch (err) {
    const fault = classifyUpstreamFault(err, "Copernicus CAMS PM2.5");
    activeBudget.recordFault(fault);
    return cached ? { ...cached.result, provenanceMode: "cached", upstreamFault: fault } : null;
  }
}
