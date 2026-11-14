import { DATASET_BY_ID } from "@/lib/datasets";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import type { ETGDatasetId, TimeSeriesPoint, TrendAnalysisSummary } from "@/types/etg";

interface PowerDatasetConfig {
  parameter: string;
  unit: string;
  slopeUnit: string;
}

const POWER_PARAM_MAP: Record<ETGDatasetId, PowerDatasetConfig> = {
  nasa_power: { parameter: "T2M", unit: "°C", slopeUnit: "°C/yr" },
  wildfire: { parameter: "T2M_MAX", unit: "°C max", slopeUnit: "°C/yr" },
  ocean_temp: { parameter: "TS", unit: "°C skin", slopeUnit: "°C/yr" },
  air_quality: { parameter: "ALLSKY_SFC_SW_DWN", unit: "kWh/m²/d", slopeUnit: "kWh/yr" },
  deforestation: { parameter: "RH2M", unit: "% RH", slopeUnit: "%/yr" },
  hydrology: { parameter: "PRECTOTCORR", unit: "mm/day", slopeUnit: "mm/d/yr" },
  community: { parameter: "T2M", unit: "°C", slopeUnit: "°C/yr" },
};

const USER_AGENT = "EarthTrendDetective/1.0 (NASA-Space-Apps; Scientific-Observatory)";
const SERIES_CACHE = new Map<string, { expiresAt: number; summary: TrendAnalysisSummary }>();

function cacheKey(lat: number, lng: number, dataset: ETGDatasetId): string {
  return `${lat.toFixed(2)}:${lng.toFixed(2)}:${dataset}`;
}

/**
 * Parses NASA POWER monthly JSON payload, strictly excluding M13 annual summary
 * keys (e.g. "202413") and missing-value sentinels (<= -900).
 * Aggregates monthly values into annual means so Mann-Kendall and Theil-Sen
 * evaluate secular multi-year change without seasonal sine-wave confounding.
 */
export function parseNasaPowerMonthlyPayload(
  rawSeries: Record<string, unknown>
): TimeSeriesPoint[] {
  const byYear = new Map<number, number[]>();

  for (const [ym, rawVal] of Object.entries(rawSeries)) {
    if (!/^\d{6}$/.test(ym)) continue;
    if (ym.endsWith("13")) continue; // M13 annual summary key
    const val = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(val) || val <= -900) continue; // -999 fill sentinel

    const year = Number(ym.slice(0, 4));
    const bucket = byYear.get(year) ?? [];
    bucket.push(val);
    byYear.set(year, bucket);
  }

  return Array.from(byYear.entries())
    .sort((a, b) => a[0] - b[0])
    .filter(([, vals]) => vals.length >= 6)
    .map(([year, vals]) => ({
      date: `${year}`,
      t: year,
      value: Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)),
    }));
}

async function fetchNasaPowerRaw(url: string): Promise<{
  properties?: { parameter?: Record<string, Record<string, unknown>> };
}> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });
      if (!res.ok) {
        const msg = `NASA POWER MERRA-2 HTTP ${res.status} ${res.statusText}`;
        if (res.status >= 500 && attempt === 0) {
          lastError = new Error(msg);
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw new Error(msg);
      }
      return (await res.json()) as {
        properties?: { parameter?: Record<string, Record<string, unknown>> };
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("NASA POWER request failed");
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
    }
  }
  throw lastError ?? new Error("NASA POWER request failed");
}

export async function fetchEarthTimeSeries(
  lat: number,
  lng: number,
  dataset: ETGDatasetId = "nasa_power",
  startYear = 1995,
  endYear = 2025
): Promise<TrendAnalysisSummary> {
  const clampedLat = Math.max(-89.5, Math.min(89.5, lat));
  const clampedLng = Math.max(-179.5, Math.min(179.5, lng));
  const key = cacheKey(clampedLat, clampedLng, dataset);
  const cached = SERIES_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }

  const config = POWER_PARAM_MAP[dataset] ?? POWER_PARAM_MAP.nasa_power;
  const datasetMeta = DATASET_BY_ID[dataset] ?? DATASET_BY_ID.nasa_power;

  // For Hydrology probes on land, try NASA GES DISC / POWER Root-Zone Soil Wetness (GWETROOT, community=AG)
  // first, falling back seamlessly to PRECTOTCORR over ocean grid cells where root-zone wetness is masked.
  if (dataset === "hydrology") {
    const hydroUrl =
      `https://power.larc.nasa.gov/api/temporal/monthly/point` +
      `?parameters=GWETROOT&community=AG&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
      `&start=${startYear}&end=${endYear}&format=JSON`;
    try {
      const hydroJson = await fetchNasaPowerRaw(hydroUrl);
      const rawHydro = hydroJson?.properties?.parameter?.GWETROOT;
      const hydroPts =
        rawHydro && typeof rawHydro === "object"
          ? parseNasaPowerMonthlyPayload(rawHydro)
          : [];
      if (hydroPts.length >= 5) {
        const hydroSummary = analyzeTimeSeries(hydroPts, {
          lat: clampedLat,
          lng: clampedLng,
          dataset: "hydrology",
          parameter: "GWETROOT (NASA Land Hydrology)",
          unit: "0–1 wet",
          slopeUnit: "/yr",
          provenance: "NASA GES DISC / POWER Hydrology (Live)",
        });
        SERIES_CACHE.set(key, {
          expiresAt: Date.now() + 1000 * 60 * 15,
          summary: hydroSummary,
        });
        return hydroSummary;
      }
    } catch {
      // Fall back to PRECTOTCORR on ocean cells or transient AG errors
    }
  }

  const url =
    `https://power.larc.nasa.gov/api/temporal/monthly/point` +
    `?parameters=${encodeURIComponent(config.parameter)}` +
    `&community=RE&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
    `&start=${startYear}&end=${endYear}&format=JSON`;

  const json = await fetchNasaPowerRaw(url);
  const rawParamSeries = json?.properties?.parameter?.[config.parameter];
  const points =
    rawParamSeries && typeof rawParamSeries === "object"
      ? parseNasaPowerMonthlyPayload(rawParamSeries)
      : [];

  if (points.length < 5) {
    throw new Error(
      `NASA POWER MERRA-2 returned insufficient observations at (${clampedLat.toFixed(2)}, ${clampedLng.toFixed(2)})`
    );
  }

  const summary = analyzeTimeSeries(points, {
    lat: clampedLat,
    lng: clampedLng,
    dataset,
    parameter: `${config.parameter} (${datasetMeta.shortLabel})`,
    unit: config.unit,
    slopeUnit: config.slopeUnit,
    provenance: "NASA POWER MERRA-2 (Live)",
  });

  SERIES_CACHE.set(key, {
    expiresAt: Date.now() + 1000 * 60 * 15,
    summary,
  });

  return summary;
}

export async function fetchMultiParamNasaPower(
  lat: number,
  lng: number,
  startYear = 1995,
  endYear = 2025
): Promise<{
  t2m: TimeSeriesPoint[];
  ts: TimeSeriesPoint[];
  precip: TimeSeriesPoint[];
  rh2m: TimeSeriesPoint[];
  sourceUrl: string;
}> {
  const clampedLat = Math.max(-89.5, Math.min(89.5, lat));
  const clampedLng = Math.max(-179.5, Math.min(179.5, lng));

  const sourceUrl =
    `https://power.larc.nasa.gov/api/temporal/monthly/point` +
    `?parameters=T2M,TS,PRECTOTCORR,RH2M` +
    `&community=RE&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
    `&start=${startYear}&end=${endYear}&format=JSON`;

  const json = await fetchNasaPowerRaw(sourceUrl);
  const params = json?.properties?.parameter ?? {};

  const t2m = params.T2M ? parseNasaPowerMonthlyPayload(params.T2M) : [];
  const ts = params.TS ? parseNasaPowerMonthlyPayload(params.TS) : [];
  const precip = params.PRECTOTCORR ? parseNasaPowerMonthlyPayload(params.PRECTOTCORR) : [];
  const rh2m = params.RH2M ? parseNasaPowerMonthlyPayload(params.RH2M) : [];

  const cacheEntries: Array<[ETGDatasetId, TimeSeriesPoint[]]> = [
    ["nasa_power", t2m],
    ["ocean_temp", ts],
    ["hydrology", precip],
    ["deforestation", rh2m],
  ];
  for (const [ds, pts] of cacheEntries) {
    if (pts.length >= 5) {
      const config = POWER_PARAM_MAP[ds];
      const meta = DATASET_BY_ID[ds];
      SERIES_CACHE.set(cacheKey(clampedLat, clampedLng, ds), {
        expiresAt: Date.now() + 1000 * 60 * 15,
        summary: analyzeTimeSeries(pts, {
          lat: clampedLat,
          lng: clampedLng,
          dataset: ds,
          parameter: `${config.parameter} (${meta.shortLabel})`,
          unit: config.unit,
          slopeUnit: config.slopeUnit,
          provenance: "NASA POWER MERRA-2 (Live)",
        }),
      });
    }
  }

  return { t2m, ts, precip, rh2m, sourceUrl };
}

const GRIDDED_DATASETS = new Set<ETGDatasetId>([
  "nasa_power",
  "wildfire",
  "hydrology",
  "ocean_temp",
  "deforestation",
  "air_quality",
]);

/**
 * Fetches and analyzes multiple Earth datasets for a coordinate using a single
 * batched NASA POWER MERRA-2 request for any uncached variables.
 */
export async function fetchMultiDatasetSummaries(
  lat: number,
  lng: number,
  datasets: ETGDatasetId[],
  startYear = 1995,
  endYear = 2025
): Promise<TrendAnalysisSummary[]> {
  const clampedLat = Math.max(-89.5, Math.min(89.5, lat));
  const clampedLng = Math.max(-179.5, Math.min(179.5, lng));

  const uniqueRequested = Array.from(
    new Set(datasets.filter((d) => GRIDDED_DATASETS.has(d)))
  );
  const targets: ETGDatasetId[] =
    uniqueRequested.length > 0 ? uniqueRequested : ["nasa_power"];

  const resolved = new Map<ETGDatasetId, TrendAnalysisSummary>();
  const missing: ETGDatasetId[] = [];
  const now = Date.now();

  for (const ds of targets) {
    const cached = SERIES_CACHE.get(cacheKey(clampedLat, clampedLng, ds));
    if (cached && cached.expiresAt > now) {
      resolved.set(ds, cached.summary);
    } else {
      missing.push(ds);
    }
  }

  if (missing.length === 1) {
    const single = await fetchEarthTimeSeries(
      clampedLat,
      clampedLng,
      missing[0],
      startYear,
      endYear
    );
    resolved.set(missing[0], single);
  } else if (missing.length >= 2) {
    const paramNames = Array.from(
      new Set(missing.map((ds) => POWER_PARAM_MAP[ds].parameter))
    );
    const url =
      `https://power.larc.nasa.gov/api/temporal/monthly/point` +
      `?parameters=${encodeURIComponent(paramNames.join(","))}` +
      `&community=RE&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
      `&start=${startYear}&end=${endYear}&format=JSON`;

    const json = await fetchNasaPowerRaw(url);
    const params = json?.properties?.parameter ?? {};

    for (const ds of missing) {
      const config = POWER_PARAM_MAP[ds];
      const meta = DATASET_BY_ID[ds];
      const rawParamSeries = params[config.parameter];
      const points =
        rawParamSeries && typeof rawParamSeries === "object"
          ? parseNasaPowerMonthlyPayload(rawParamSeries)
          : [];
      if (points.length < 5) continue;

      const summary = analyzeTimeSeries(points, {
        lat: clampedLat,
        lng: clampedLng,
        dataset: ds,
        parameter: `${config.parameter} (${meta.shortLabel})`,
        unit: config.unit,
        slopeUnit: config.slopeUnit,
        provenance: "NASA POWER MERRA-2 (Live)",
      });
      SERIES_CACHE.set(cacheKey(clampedLat, clampedLng, ds), {
        expiresAt: Date.now() + 1000 * 60 * 15,
        summary,
      });
      resolved.set(ds, summary);
    }
  }

  const ordered = targets
    .map((ds) => resolved.get(ds))
    .filter((item): item is TrendAnalysisSummary => Boolean(item));

  if (ordered.length === 0) {
    throw new Error(
      `NASA POWER MERRA-2 returned insufficient observations at (${clampedLat.toFixed(2)}, ${clampedLng.toFixed(2)})`
    );
  }

  return ordered;
}
