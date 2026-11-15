import { DATASET_BY_ID } from "@/lib/datasets";
import {
  fetchCamsSurfacePm25Series,
  fetchGlofasDischargeSeries,
  fetchNearestUsgsGaugeAnnualSeries,
} from "@/lib/earth/openFeedsClient";
import {
  analyzeTimeSeries,
  computeSeasonalMannKendall,
} from "@/lib/stats/trendEngine";
import type {
  DatasetTelemetryDiagnostic,
  ETGDatasetId,
  TimeSeriesPoint,
  TrendAnalysisSummary,
} from "@/types/etg";

export class TelemetryUnavailableError extends Error {
  readonly kind = "unavailable" as const;
  readonly dataset?: ETGDatasetId;
  constructor(message: string, dataset?: ETGDatasetId) {
    super(message);
    this.name = "TelemetryUnavailableError";
    this.dataset = dataset;
  }
}

export function isTelemetryUnavailableError(
  err: unknown
): err is TelemetryUnavailableError {
  return (
    err instanceof TelemetryUnavailableError ||
    (typeof err === "object" &&
      err !== null &&
      "kind" in err &&
      (err as { kind?: unknown }).kind === "unavailable")
  );
}

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

function attachMeasurementMetadata(
  dataset: ETGDatasetId,
  summary: TrendAnalysisSummary,
  overrideKind?: TrendAnalysisSummary["measurementKind"],
  overrideNote?: string
): TrendAnalysisSummary {
  if (overrideKind) {
    return {
      ...summary,
      measurementKind: overrideKind,
      ...(overrideNote ? { proxyNote: overrideNote } : {}),
    };
  }
  if (
    summary.provenance === "USGS NWIS River Gauge (Live)" ||
    summary.provenance === "Copernicus GloFAS v4 (Live)" ||
    summary.provenance === "Copernicus CAMS PM2.5 (Live)" ||
    summary.provenance === "NASA POWER AOD_55 (Live)" ||
    summary.provenance === "NASA POWER Evapotranspiration (Live)" ||
    summary.provenance === "NASA GES DISC / POWER Hydrology (Live)"
  ) {
    return {
      ...summary,
      measurementKind:
        summary.provenance === "USGS NWIS River Gauge (Live)"
          ? "direct_observation"
          : "reanalysis_physical",
      ...(overrideNote ? { proxyNote: overrideNote } : {}),
    };
  }
  if (dataset === "deforestation") {
    return {
      ...summary,
      measurementKind: "meteorological_proxy",
      proxyNote:
        "MERRA-2 surface relative humidity proxy (% RH); evapotranspiration or MODIS NDVI unavailable at this grid cell.",
    };
  }
  if (dataset === "air_quality") {
    return {
      ...summary,
      measurementKind: "meteorological_proxy",
      proxyNote:
        "MERRA-2 surface solar transmittance proxy (kWh/m²/d); direct AOD_55 and CAMS PM2.5 feeds were unavailable at this coordinate.",
    };
  }
  return {
    ...summary,
    measurementKind: "reanalysis_physical",
  };
}

/**
 * Computes annual mean Vapor Pressure Deficit (VPD, kPa) from monthly peak
 * air temperature (T2M_MAX, °C) and relative humidity (RH2M, %) using the
 * Tetens saturation vapor pressure equation, skipping M13 summaries and sentinels.
 */
export function computeMonthlyVpdSeries(
  tMaxMonthly: Record<string, unknown>,
  rhMonthly: Record<string, unknown>
): TimeSeriesPoint[] {
  const byYear = new Map<number, number[]>();

  for (const [ym, rawT] of Object.entries(tMaxMonthly)) {
    if (!/^\d{6}$/.test(ym) || ym.endsWith("13")) continue;
    const rawRh = rhMonthly[ym];
    const tMax = typeof rawT === "number" ? rawT : Number(rawT);
    const rh = typeof rawRh === "number" ? rawRh : Number(rawRh);
    if (!Number.isFinite(tMax) || tMax <= -900 || !Number.isFinite(rh) || rh < 0 || rh > 105) {
      continue;
    }

    const es = 0.61078 * Math.exp((17.27 * tMax) / (tMax + 237.3));
    const vpd = Math.max(0, es * (1 - Math.min(100, rh) / 100));
    const year = Number(ym.slice(0, 4));
    const bucket = byYear.get(year) ?? [];
    bucket.push(vpd);
    byYear.set(year, bucket);
  }

  return Array.from(byYear.entries())
    .sort((a, b) => a[0] - b[0])
    .filter(([, vals]) => vals.length >= 6)
    .map(([year, vals]) => ({
      date: `${year}`,
      t: year,
      value: Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4)),
    }));
}

/**
 * Extracts individual `YYYY-MM` monthly points from a NASA POWER monthly dictionary,
 * strictly skipping M13 annual summary keys and missing-value sentinels (`<= -900`).
 */
export function extractMonthlySeriesFromPowerDict(
  rawSeries: Record<string, unknown>
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (const [ym, rawVal] of Object.entries(rawSeries)) {
    if (!/^\d{6}$/.test(ym) || ym.endsWith("13")) continue;
    const val = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(val) || val <= -900) continue;
    const year = Number(ym.slice(0, 4));
    const month = Number(ym.slice(4, 6));
    if (month < 1 || month > 12) continue;
    points.push({
      date: `${year}-${String(month).padStart(2, "0")}`,
      t: Number((year + (month - 0.5) / 12).toFixed(4)),
      value: Number(val.toFixed(4)),
    });
  }
  return points.sort((a, b) => a.t - b.t);
}

/**
 * Extracts individual `YYYY-MM` Vapor Pressure Deficit (kPa) points from NASA POWER
 * monthly `T2M_MAX` and `RH2M` dictionaries for Seasonal Mann-Kendall analysis.
 */
export function extractMonthlyVpdSeriesFromPowerDicts(
  tMaxMonthly: Record<string, unknown>,
  rhMonthly: Record<string, unknown>
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (const [ym, rawT] of Object.entries(tMaxMonthly)) {
    if (!/^\d{6}$/.test(ym) || ym.endsWith("13")) continue;
    const rawRh = rhMonthly[ym];
    const tMax = typeof rawT === "number" ? rawT : Number(rawT);
    const rh = typeof rawRh === "number" ? rawRh : Number(rawRh);
    if (!Number.isFinite(tMax) || tMax <= -900 || !Number.isFinite(rh) || rh < 0 || rh > 105) {
      continue;
    }
    const year = Number(ym.slice(0, 4));
    const month = Number(ym.slice(4, 6));
    if (month < 1 || month > 12) continue;
    const es = 0.61078 * Math.exp((17.27 * tMax) / (tMax + 237.3));
    const vpd = Math.max(0, es * (1 - Math.min(100, rh) / 100));
    points.push({
      date: `${year}-${String(month).padStart(2, "0")}`,
      t: Number((year + (month - 0.5) / 12).toFixed(4)),
      value: Number(vpd.toFixed(4)),
    });
  }
  return points.sort((a, b) => a.t - b.t);
}

/**
 * Attaches Seasonal Mann-Kendall results (`p_s`) and deseasonalized monthly points
 * onto an annual `TrendAnalysisSummary` when monthly observations are available.
 */
export function enrichSummaryWithMonthlySeasonality(
  summary: TrendAnalysisSummary,
  monthlyPoints: readonly TimeSeriesPoint[]
): TrendAnalysisSummary {
  if (monthlyPoints.length < 18) return summary;
  const sortedMonthly = [...monthlyPoints]
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value))
    .sort((a, b) => a.t - b.t);
  const seasonalAnalysis = computeSeasonalMannKendall(sortedMonthly);
  if (!seasonalAnalysis) return summary;
  return {
    ...summary,
    seasonalAnalysis,
    seasonalPoints: sortedMonthly.map((p, idx) => ({
      date: p.date,
      t: p.t,
      value: p.value,
      anomalyValue: Number((seasonalAnalysis.deseasonalizedValues[idx] ?? 0).toFixed(4)),
    })),
  };
}

const USER_AGENT = "EarthTrendDetective/1.0 (NASA-Space-Apps; Scientific-Observatory)";
const SERIES_CACHE = new Map<string, { expiresAt: number; summary: TrendAnalysisSummary }>();

export function clearNasaPowerSeriesCache(): void {
  SERIES_CACHE.clear();
}

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

  // 1) Hydrology cascade: USGS NWIS stream gauge -> Copernicus GloFAS v4 (5km) -> NASA GWETROOT -> MERRA-2 PRECTOTCORR.
  if (dataset === "hydrology") {
    try {
      const usgs = await fetchNearestUsgsGaugeAnnualSeries(clampedLat, clampedLng, startYear, endYear);
      if (usgs && usgs.points.length >= 6) {
        const usgsSummary = attachMeasurementMetadata(
          "hydrology",
          analyzeTimeSeries(usgs.points, {
            lat: clampedLat,
            lng: clampedLng,
            dataset: "hydrology",
            parameter: usgs.metricName,
            unit: usgs.unit,
            slopeUnit: "m³/s/yr",
            provenance: usgs.provenanceSource,
          }),
          "direct_observation"
        );
        SERIES_CACHE.set(key, { expiresAt: Date.now() + 1000 * 60 * 15, summary: usgsSummary });
        return usgsSummary;
      }
    } catch {
      // Fall through to Copernicus GloFAS v4
    }

    try {
      const glofas = await fetchGlofasDischargeSeries(
        clampedLat,
        clampedLng,
        startYear,
        endYear,
        "annual"
      );
      if (glofas && glofas.points.length >= 6) {
        const glofasSummary = attachMeasurementMetadata(
          "hydrology",
          analyzeTimeSeries(glofas.points, {
            lat: clampedLat,
            lng: clampedLng,
            dataset: "hydrology",
            parameter: glofas.metricName,
            unit: glofas.unit,
            slopeUnit: "m³/s/yr",
            provenance: glofas.provenanceSource,
          }),
          "reanalysis_physical"
        );
        SERIES_CACHE.set(key, { expiresAt: Date.now() + 1000 * 60 * 15, summary: glofasSummary });
        return glofasSummary;
      }
    } catch {
      // Fall through to NASA POWER GWETROOT / PRECTOTCORR
    }

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
        const hydroMonthly =
          rawHydro && typeof rawHydro === "object"
            ? extractMonthlySeriesFromPowerDict(rawHydro)
            : [];
        const hydroSummary = attachMeasurementMetadata(
          "hydrology",
          enrichSummaryWithMonthlySeasonality(
            analyzeTimeSeries(hydroPts, {
              lat: clampedLat,
              lng: clampedLng,
              dataset: "hydrology",
              parameter: "GWETROOT (NASA Land Hydrology)",
              unit: "0–1 wet",
              slopeUnit: "/yr",
              provenance: "NASA GES DISC / POWER Hydrology (Live)",
            }),
            hydroMonthly
          ),
          "reanalysis_physical"
        );
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

  // 2) Air Quality cascade: NASA POWER AOD_55 (2001+, enriched with CAMS PM2.5) -> Copernicus CAMS monthly PM2.5 -> solar transmittance proxy.
  if (dataset === "air_quality") {
    const aodStart = Math.max(2001, startYear);
    const aodUrl =
      `https://power.larc.nasa.gov/api/temporal/monthly/point` +
      `?parameters=AOD_55&community=AG&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
      `&start=${aodStart}&end=${endYear}&format=JSON`;

    const [aodResult, camsResult] = await Promise.allSettled([
      fetchNasaPowerRaw(aodUrl),
      fetchCamsSurfacePm25Series(clampedLat, clampedLng, Math.max(2022, endYear - 2), endYear, "monthly"),
    ]);

    const camsSnapshot =
      camsResult.status === "fulfilled" && camsResult.value && camsResult.value.points.length > 0
        ? camsResult.value
        : null;

    if (aodResult.status === "fulfilled") {
      const rawAod = aodResult.value?.properties?.parameter?.AOD_55;
      const aodPts =
        rawAod && typeof rawAod === "object" ? parseNasaPowerMonthlyPayload(rawAod) : [];
      if (aodPts.length >= 5) {
        const aodMonthly =
          rawAod && typeof rawAod === "object"
            ? extractMonthlySeriesFromPowerDict(rawAod)
            : [];
        const latestPm25 =
          camsSnapshot?.points[camsSnapshot.points.length - 1];
        const note = latestPm25
          ? `Paired with live Copernicus CAMS surface PM2.5 (${latestPm25.date}: ${latestPm25.value.toFixed(1)} μg/m³).`
          : undefined;
        const aodSummary = attachMeasurementMetadata(
          "air_quality",
          enrichSummaryWithMonthlySeasonality(
            analyzeTimeSeries(aodPts, {
              lat: clampedLat,
              lng: clampedLng,
              dataset: "air_quality",
              parameter: "AOD_55 (Aerosol Optical Depth 550nm)",
              unit: "AOD",
              slopeUnit: "/yr",
              provenance: "NASA POWER AOD_55 (Live)",
            }),
            aodMonthly
          ),
          "reanalysis_physical",
          note
        );
        SERIES_CACHE.set(key, { expiresAt: Date.now() + 1000 * 60 * 15, summary: aodSummary });
        return aodSummary;
      }
    }

    if (camsSnapshot && camsSnapshot.points.length >= 6) {
      const camsBase = analyzeTimeSeries(camsSnapshot.points, {
        lat: clampedLat,
        lng: clampedLng,
        dataset: "air_quality",
        parameter: camsSnapshot.metricName,
        unit: camsSnapshot.unit,
        slopeUnit: "μg/m³/yr",
        provenance: camsSnapshot.provenanceSource,
      });
      const camsSummary = attachMeasurementMetadata(
        "air_quality",
        camsBase.seasonalAnalysis
          ? camsBase
          : enrichSummaryWithMonthlySeasonality(camsBase, camsSnapshot.points),
        "reanalysis_physical"
      );
      SERIES_CACHE.set(key, { expiresAt: Date.now() + 1000 * 60 * 15, summary: camsSummary });
      return camsSummary;
    }
  }

  // 3) Vegetation / Land Flux cascade: NASA POWER EVPTRNS (canopy evapotranspiration energy flux) -> RH2M proxy.
  if (dataset === "deforestation") {
    const evapUrl =
      `https://power.larc.nasa.gov/api/temporal/monthly/point` +
      `?parameters=EVPTRNS&community=AG&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
      `&start=${startYear}&end=${endYear}&format=JSON`;
    try {
      const evapJson = await fetchNasaPowerRaw(evapUrl);
      const rawEvap = evapJson?.properties?.parameter?.EVPTRNS;
      const evapPts =
        rawEvap && typeof rawEvap === "object"
          ? parseNasaPowerMonthlyPayload(rawEvap)
          : [];
      if (evapPts.length >= 5) {
        const evapMonthly =
          rawEvap && typeof rawEvap === "object"
            ? extractMonthlySeriesFromPowerDict(rawEvap)
            : [];
        const evapSummary = attachMeasurementMetadata(
          "deforestation",
          enrichSummaryWithMonthlySeasonality(
            analyzeTimeSeries(evapPts, {
              lat: clampedLat,
              lng: clampedLng,
              dataset: "deforestation",
              parameter: "EVPTRNS (Canopy Evapotranspiration Flux)",
              unit: "MJ/m²/d",
              slopeUnit: "MJ/m²/d/yr",
              provenance: "NASA POWER Evapotranspiration (Live)",
            }),
            evapMonthly
          ),
          "reanalysis_physical"
        );
        SERIES_CACHE.set(key, { expiresAt: Date.now() + 1000 * 60 * 15, summary: evapSummary });
        return evapSummary;
      }
    } catch {
      // Fall back to MERRA-2 RH2M proxy
    }
  }

  const requestParams = dataset === "wildfire" ? "T2M_MAX,RH2M" : config.parameter;
  const url =
    `https://power.larc.nasa.gov/api/temporal/monthly/point` +
    `?parameters=${encodeURIComponent(requestParams)}` +
    `&community=RE&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
    `&start=${startYear}&end=${endYear}&format=JSON`;

  const json = await fetchNasaPowerRaw(url);
  const allParams = json?.properties?.parameter ?? {};

  if (dataset === "wildfire" && allParams.T2M_MAX && allParams.RH2M) {
    const vpdPoints = computeMonthlyVpdSeries(allParams.T2M_MAX, allParams.RH2M);
    if (vpdPoints.length >= 5) {
      const vpdMonthly = extractMonthlyVpdSeriesFromPowerDicts(
        allParams.T2M_MAX,
        allParams.RH2M
      );
      const vpdSummary = attachMeasurementMetadata(
        "wildfire",
        enrichSummaryWithMonthlySeasonality(
          analyzeTimeSeries(vpdPoints, {
            lat: clampedLat,
            lng: clampedLng,
            dataset: "wildfire",
            parameter: "VPD (Vapor Pressure Deficit)",
            unit: "kPa",
            slopeUnit: "kPa/yr",
            provenance: "NASA POWER MERRA-2 (Live)",
          }),
          vpdMonthly
        )
      );
      SERIES_CACHE.set(key, {
        expiresAt: Date.now() + 1000 * 60 * 15,
        summary: vpdSummary,
      });
      return vpdSummary;
    }
  }

  const rawParamSeries = allParams[config.parameter];
  const points =
    rawParamSeries && typeof rawParamSeries === "object"
      ? parseNasaPowerMonthlyPayload(rawParamSeries)
      : [];

  if (points.length < 5) {
    throw new TelemetryUnavailableError(
      `NASA POWER MERRA-2 has no valid ${config.parameter} observations at (${clampedLat.toFixed(2)}, ${clampedLng.toFixed(2)}).`,
      dataset
    );
  }

  const monthlyRawPoints =
    rawParamSeries && typeof rawParamSeries === "object"
      ? extractMonthlySeriesFromPowerDict(rawParamSeries)
      : [];

  const summary = attachMeasurementMetadata(
    dataset,
    enrichSummaryWithMonthlySeasonality(
      analyzeTimeSeries(points, {
        lat: clampedLat,
        lng: clampedLng,
        dataset,
        parameter: `${config.parameter} (${datasetMeta.shortLabel})`,
        unit: config.unit,
        slopeUnit: config.slopeUnit,
        provenance: "NASA POWER MERRA-2 (Live)",
      }),
      monthlyRawPoints
    )
  );

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
  monthly?: {
    t2m: TimeSeriesPoint[];
    ts: TimeSeriesPoint[];
    precip: TimeSeriesPoint[];
    rh2m: TimeSeriesPoint[];
  };
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

  const monthly = {
    t2m: params.T2M ? parseNasaPowerMonthlyMultiChannel(params, "T2M") : [],
    ts: params.TS ? parseNasaPowerMonthlyMultiChannel(params, "TS") : [],
    precip: params.PRECTOTCORR ? parseNasaPowerMonthlyMultiChannel(params, "PRECTOTCORR") : [],
    rh2m: params.RH2M ? parseNasaPowerMonthlyMultiChannel(params, "RH2M") : [],
  };

  const cacheEntries: Array<[ETGDatasetId, TimeSeriesPoint[], TimeSeriesPoint[]]> = [
    ["nasa_power", t2m, monthly.t2m],
    ["ocean_temp", ts, monthly.ts],
    ["hydrology", precip, monthly.precip],
    ["deforestation", rh2m, monthly.rh2m],
  ];
  for (const [ds, pts, monthlyPts] of cacheEntries) {
    if (pts.length >= 5) {
      const config = POWER_PARAM_MAP[ds];
      const meta = DATASET_BY_ID[ds];
      SERIES_CACHE.set(cacheKey(clampedLat, clampedLng, ds), {
        expiresAt: Date.now() + 1000 * 60 * 15,
        summary: enrichSummaryWithMonthlySeasonality(
          analyzeTimeSeries(pts, {
            lat: clampedLat,
            lng: clampedLng,
            dataset: ds,
            parameter: `${config.parameter} (${meta.shortLabel})`,
            unit: config.unit,
            slopeUnit: config.slopeUnit,
            provenance: "NASA POWER MERRA-2 (Live)",
          }),
          monthlyPts
        ),
      });
    }
  }

  return { t2m, ts, precip, rh2m, monthly, sourceUrl };
}

const GRIDDED_DATASETS = new Set<ETGDatasetId>([
  "nasa_power",
  "wildfire",
  "hydrology",
  "ocean_temp",
  "deforestation",
  "air_quality",
]);

export async function fetchMultiDatasetSummariesDetailed(
  lat: number,
  lng: number,
  datasets: ETGDatasetId[],
  startYear = 1995,
  endYear = 2025
): Promise<{
  summaries: TrendAnalysisSummary[];
  diagnostics: DatasetTelemetryDiagnostic[];
}> {
  const clampedLat = Math.max(-89.5, Math.min(89.5, lat));
  const clampedLng = Math.max(-179.5, Math.min(179.5, lng));

  const diagnostics: DatasetTelemetryDiagnostic[] = [];
  const uniqueRequested = Array.from(
    new Set(datasets.filter((d) => GRIDDED_DATASETS.has(d)))
  );

  if (datasets.includes("community") && uniqueRequested.length === 0) {
    diagnostics.push({
      dataset: "community",
      status: "unavailable",
      reason:
        "Local sensor trends come from nearby geo-pinned stations rather than a global gridded feed.",
    });
    return { summaries: [], diagnostics };
  }

  const targets: ETGDatasetId[] =
    uniqueRequested.length > 0 ? uniqueRequested : ["nasa_power"];

  if (datasets.includes("community")) {
    diagnostics.push({
      dataset: "community",
      status: "unavailable",
      reason:
        "Local sensor trends come from nearby geo-pinned stations rather than a global gridded feed.",
    });
  }

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
    const targetDs = missing[0];
    try {
      const single = await fetchEarthTimeSeries(
        clampedLat,
        clampedLng,
        targetDs,
        startYear,
        endYear
      );
      resolved.set(targetDs, single);
    } catch (err) {
      diagnostics.push({
        dataset: targetDs,
        status: isTelemetryUnavailableError(err) ? "unavailable" : "failed_to_fetch",
        reason:
          err instanceof Error
            ? err.message
            : `Failed to fetch ${DATASET_BY_ID[targetDs]?.shortLabel ?? targetDs} telemetry.`,
      });
    }
  } else if (missing.length >= 2) {
    const SPECIALIZED_DATASETS = new Set<ETGDatasetId>([
      "hydrology",
      "air_quality",
      "deforestation",
    ]);
    const specialMissing = missing.filter((ds) => SPECIALIZED_DATASETS.has(ds));
    const reMissing = missing.filter((ds) => !SPECIALIZED_DATASETS.has(ds));

    type SpecialOutcome =
      | { ok: true; ds: ETGDatasetId; summary: TrendAnalysisSummary }
      | { ok: false; ds: ETGDatasetId; status: "unavailable" | "failed_to_fetch"; reason: string };

    const specialPromises: Array<Promise<SpecialOutcome>> = specialMissing.map((ds) =>
      fetchEarthTimeSeries(clampedLat, clampedLng, ds, startYear, endYear)
        .then((summary): SpecialOutcome => ({ ok: true, ds, summary }))
        .catch(
          (err): SpecialOutcome => ({
            ok: false,
            ds,
            status: isTelemetryUnavailableError(err) ? "unavailable" : "failed_to_fetch",
            reason:
              err instanceof Error
                ? err.message
                : `Failed to fetch ${DATASET_BY_ID[ds]?.shortLabel ?? ds} telemetry.`,
          })
        )
    );

    const paramSet = new Set<string>(reMissing.map((ds) => POWER_PARAM_MAP[ds].parameter));
    if (reMissing.includes("wildfire")) {
      paramSet.add("RH2M");
    }

    type ReOutcome =
      | { ok: true; params: Record<string, Record<string, unknown>> }
      | { ok: false; reason: string };

    const rePromise: Promise<ReOutcome> =
      reMissing.length > 0
        ? (async (): Promise<ReOutcome> => {
            try {
              const url =
                `https://power.larc.nasa.gov/api/temporal/monthly/point` +
                `?parameters=${encodeURIComponent(Array.from(paramSet).join(","))}` +
                `&community=RE&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
                `&start=${startYear}&end=${endYear}&format=JSON`;
              const json = await fetchNasaPowerRaw(url);
              return { ok: true, params: json?.properties?.parameter ?? {} };
            } catch (err) {
              return {
                ok: false,
                reason:
                  err instanceof Error
                    ? err.message
                    : "NASA POWER MERRA-2 request failed.",
              };
            }
          })()
        : Promise.resolve<ReOutcome>({ ok: true, params: {} });

    const [specialEntries, reOutcome] = await Promise.all([
      Promise.all(specialPromises),
      rePromise,
    ]);

    for (const outcome of specialEntries) {
      if (outcome.ok) {
        resolved.set(outcome.ds, outcome.summary);
      } else {
        diagnostics.push({
          dataset: outcome.ds,
          status: outcome.status,
          reason: outcome.reason,
        });
      }
    }

    if (!reOutcome.ok) {
      for (const ds of reMissing) {
        diagnostics.push({
          dataset: ds,
          status: "failed_to_fetch",
          reason: reOutcome.reason,
        });
      }
    } else {
      const params = reOutcome.params;
      for (const ds of reMissing) {
        const config = POWER_PARAM_MAP[ds];
        const meta = DATASET_BY_ID[ds];

        if (ds === "wildfire" && params.T2M_MAX && params.RH2M) {
          const vpdPoints = computeMonthlyVpdSeries(params.T2M_MAX, params.RH2M);
          if (vpdPoints.length >= 5) {
            const vpdMonthly = extractMonthlyVpdSeriesFromPowerDicts(
              params.T2M_MAX,
              params.RH2M
            );
            const vpdSummary = attachMeasurementMetadata(
              "wildfire",
              enrichSummaryWithMonthlySeasonality(
                analyzeTimeSeries(vpdPoints, {
                  lat: clampedLat,
                  lng: clampedLng,
                  dataset: "wildfire",
                  parameter: "VPD (Vapor Pressure Deficit)",
                  unit: "kPa",
                  slopeUnit: "kPa/yr",
                  provenance: "NASA POWER MERRA-2 (Live)",
                }),
                vpdMonthly
              )
            );
            SERIES_CACHE.set(cacheKey(clampedLat, clampedLng, ds), {
              expiresAt: Date.now() + 1000 * 60 * 15,
              summary: vpdSummary,
            });
            resolved.set(ds, vpdSummary);
            continue;
          }
        }

        const rawParamSeries = params[config.parameter];
        const points =
          rawParamSeries && typeof rawParamSeries === "object"
            ? parseNasaPowerMonthlyPayload(rawParamSeries)
            : [];
        if (points.length < 5) {
          diagnostics.push({
            dataset: ds,
            status: "unavailable",
            reason: `NASA POWER MERRA-2 reports no valid ${config.parameter} observations at (${clampedLat.toFixed(2)}, ${clampedLng.toFixed(2)}).`,
          });
          continue;
        }

        const monthlyRawPoints =
          rawParamSeries && typeof rawParamSeries === "object"
            ? extractMonthlySeriesFromPowerDict(rawParamSeries)
            : [];
        const summary = attachMeasurementMetadata(
          ds,
          enrichSummaryWithMonthlySeasonality(
            analyzeTimeSeries(points, {
              lat: clampedLat,
              lng: clampedLng,
              dataset: ds,
              parameter: `${config.parameter} (${meta.shortLabel})`,
              unit: config.unit,
              slopeUnit: config.slopeUnit,
              provenance: "NASA POWER MERRA-2 (Live)",
            }),
            monthlyRawPoints
          )
        );
        SERIES_CACHE.set(cacheKey(clampedLat, clampedLng, ds), {
          expiresAt: Date.now() + 1000 * 60 * 15,
          summary,
        });
        resolved.set(ds, summary);
      }
    }
  }

  const summaries = targets
    .map((ds) => resolved.get(ds))
    .filter((item): item is TrendAnalysisSummary => Boolean(item));

  return { summaries, diagnostics };
}

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
  const { summaries, diagnostics } = await fetchMultiDatasetSummariesDetailed(
    lat,
    lng,
    datasets,
    startYear,
    endYear
  );
  if (summaries.length === 0) {
    const failed = diagnostics.find((d) => d.status === "failed_to_fetch");
    if (failed) {
      throw new Error(failed.reason);
    }
    const unavailable = diagnostics[0];
    throw new TelemetryUnavailableError(
      unavailable?.reason ||
        `NASA POWER MERRA-2 returned insufficient observations at (${lat.toFixed(2)}, ${lng.toFixed(2)})`
    );
  }
  return summaries;
}

const CHANNEL_ALIAS_MAP: Record<string, string> = {
  T2M: "t2m",
  T2M_MAX: "t2m_max",
  TS: "ts",
  RH2M: "rh2m",
  PRECTOTCORR: "precip",
  WS10M: "ws10m",
  WD10M: "wd10m",
  ALLSKY_SFC_SW_DWN: "allsky",
  CLRSKY_SFC_SW_DWN: "clrsky",
  GWETROOT: "gwetroot",
  AOD_55: "aod",
  EVPTRNS: "evptrns",
};

/**
 * Parses NASA POWER monthly JSON parameters into native `YYYY-MM` time-series points
 * while preserving aligned multivariate physical covariates in `point.channels`.
 */
export function parseNasaPowerMonthlyMultiChannel(
  allParams: Record<string, Record<string, unknown>>,
  primaryKey: string
): TimeSeriesPoint[] {
  const rawPrimary = allParams[primaryKey];
  if (!rawPrimary || typeof rawPrimary !== "object") return [];

  const points: TimeSeriesPoint[] = [];
  for (const [ym, rawVal] of Object.entries(rawPrimary)) {
    if (!/^\d{6}$/.test(ym) || ym.endsWith("13")) continue;
    const val = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(val) || val <= -900) continue;

    const year = Number(ym.slice(0, 4));
    const month = Number(ym.slice(4, 6));
    if (month < 1 || month > 12) continue;

    const channels: Record<string, number> = {};
    for (const [paramKey, seriesMap] of Object.entries(allParams)) {
      if (!seriesMap || typeof seriesMap !== "object") continue;
      const cv = Number(seriesMap[ym]);
      if (!Number.isFinite(cv) || cv <= -900) continue;
      const alias = CHANNEL_ALIAS_MAP[paramKey] ?? paramKey.toLowerCase();
      channels[alias] = Number(cv.toFixed(4));
    }

    if (channels.t2m_max !== undefined && channels.rh2m !== undefined) {
      const es = 0.61078 * Math.exp((17.27 * channels.t2m_max) / (channels.t2m_max + 237.3));
      const vpd = Math.max(0, es * (1 - Math.min(100, channels.rh2m) / 100));
      channels.vpd = Number(vpd.toFixed(4));
    }

    points.push({
      date: `${year}-${String(month).padStart(2, "0")}`,
      t: Number((year + (month - 0.5) / 12).toFixed(4)),
      value: Number(val.toFixed(4)),
      ...(Object.keys(channels).length > 0 ? { channels } : {}),
    });
  }

  return points.sort((a, b) => a.t - b.t);
}

function parseNasaPowerDailyMultiChannel(
  allParams: Record<string, Record<string, unknown>>,
  primaryKey: string
): TimeSeriesPoint[] {
  const rawPrimary = allParams[primaryKey];
  if (!rawPrimary || typeof rawPrimary !== "object") return [];

  const points: TimeSeriesPoint[] = [];
  for (const [ymd, rawVal] of Object.entries(rawPrimary)) {
    if (!/^\d{8}$/.test(ymd)) continue;
    const val = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(val) || val <= -900) continue;

    const y = Number(ymd.slice(0, 4));
    const m = Number(ymd.slice(4, 6));
    const d = Number(ymd.slice(6, 8));
    const ms = Date.UTC(y, m - 1, d);
    const yearStart = Date.UTC(y, 0, 1);

    const channels: Record<string, number> = {};
    for (const [paramKey, seriesMap] of Object.entries(allParams)) {
      if (!seriesMap || typeof seriesMap !== "object") continue;
      const cv = Number(seriesMap[ymd]);
      if (!Number.isFinite(cv) || cv <= -900) continue;
      const alias = CHANNEL_ALIAS_MAP[paramKey] ?? paramKey.toLowerCase();
      channels[alias] = Number(cv.toFixed(4));
    }
    if (channels.allsky !== undefined && channels.clrsky !== undefined) {
      channels.kt = Number((channels.allsky / Math.max(0.5, channels.clrsky)).toFixed(4));
    }

    points.push({
      date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      t: Number((y + (ms - yearStart) / (365.25 * 86_400_000)).toFixed(6)),
      value: Number(val.toFixed(4)),
      ...(Object.keys(channels).length > 0 ? { channels } : {}),
    });
  }

  return points.sort((a, b) => a.t - b.t);
}

/**
 * Fetches native multi-scale series (`annual`, `month`, and optional recent `day`)
 * with aligned multivariate physical covariates for any Earth coordinate & dataset.
 */
export async function fetchRegionalMultiScaleSeries(
  lat: number,
  lng: number,
  dataset: ETGDatasetId = "nasa_power",
  options?: { startYear?: number; endYear?: number; includeDailyRecent?: boolean }
): Promise<{
  annual: TimeSeriesPoint[];
  month: TimeSeriesPoint[];
  day: TimeSeriesPoint[];
  summary: TrendAnalysisSummary;
  channelNames: string[];
}> {
  const clampedLat = Math.max(-89.5, Math.min(89.5, lat));
  const clampedLng = Math.max(-179.5, Math.min(179.5, lng));
  const startYear = options?.startYear ?? 1995;
  const endYear = options?.endYear ?? 2025;
  const includeDailyRecent = options?.includeDailyRecent ?? false;

  const config = POWER_PARAM_MAP[dataset] ?? POWER_PARAM_MAP.nasa_power;
  const datasetMeta = DATASET_BY_ID[dataset] ?? DATASET_BY_ID.nasa_power;
  const monthlyUrl =
    `https://power.larc.nasa.gov/api/temporal/monthly/point` +
    `?parameters=T2M,T2M_MAX,TS,RH2M,PRECTOTCORR,WS10M,WD10M,ALLSKY_SFC_SW_DWN` +
    `&community=RE&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
    `&start=${startYear}&end=${endYear}&format=JSON`;

  const [summaryRes, monthlyRawRes, extraFeedRes, dailyRawRes] = await Promise.allSettled([
    fetchEarthTimeSeries(clampedLat, clampedLng, dataset, startYear, endYear),
    fetchNasaPowerRaw(monthlyUrl),
    dataset === "hydrology"
      ? fetchGlofasDischargeSeries(clampedLat, clampedLng, startYear, endYear, "monthly")
      : dataset === "air_quality"
        ? fetchCamsSurfacePm25Series(clampedLat, clampedLng, Math.max(2022, endYear - 2), endYear, "monthly")
        : Promise.resolve(null),
    includeDailyRecent
      ? fetchNasaPowerRaw(
          `https://power.larc.nasa.gov/api/temporal/daily/point` +
            `?parameters=ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN,T2M,RH2M,PRECTOTCORR,WS10M,WD10M` +
            `&community=RE&longitude=${clampedLng.toFixed(3)}&latitude=${clampedLat.toFixed(3)}` +
            `&start=${Math.max(startYear, endYear - 1)}0101&end=${endYear}1231&format=JSON`
        )
      : Promise.resolve(null),
  ]);

  const monthlyParams =
    monthlyRawRes.status === "fulfilled"
      ? monthlyRawRes.value?.properties?.parameter ?? {}
      : {};

  let monthPoints: TimeSeriesPoint[] = [];
  if (dataset === "wildfire" && monthlyParams.T2M_MAX && monthlyParams.RH2M) {
    const baseTmax = parseNasaPowerMonthlyMultiChannel(monthlyParams, "T2M_MAX");
    monthPoints = baseTmax.map((pt) => ({
      ...pt,
      value: pt.channels?.vpd ?? pt.value,
    }));
  } else {
    monthPoints = parseNasaPowerMonthlyMultiChannel(monthlyParams, config.parameter);
  }

  // Merge specialized hydrology (GloFAS monthly) or air quality (CAMS monthly) if returned
  if (extraFeedRes.status === "fulfilled" && extraFeedRes.value && extraFeedRes.value.points.length >= 6) {
    const channelCovByDate = new Map(
      monthPoints.map((p) => [p.date, p.channels])
    );
    monthPoints = extraFeedRes.value.points.map((p) => ({
      ...p,
      channels: {
        ...(channelCovByDate.get(p.date) ?? {}),
        ...(dataset === "air_quality" ? { pm25: p.value } : { glofas: p.value }),
      },
    }));
  }

  const dailyParams =
    dailyRawRes.status === "fulfilled" && dailyRawRes.value
      ? dailyRawRes.value?.properties?.parameter ?? {}
      : {};
  const dailyKey =
    dataset === "hydrology"
      ? "PRECTOTCORR"
      : dataset === "air_quality"
        ? "ALLSKY_SFC_SW_DWN"
        : config.parameter === "TS" || config.parameter === "T2M_MAX"
          ? "T2M"
          : config.parameter;
  const dayPoints = Object.keys(dailyParams).length > 0
    ? parseNasaPowerDailyMultiChannel(dailyParams, dailyKey)
    : [];

  let summary: TrendAnalysisSummary;
  let annualPoints: TimeSeriesPoint[];
  if (summaryRes.status === "fulfilled") {
    summary = summaryRes.value;
    annualPoints = summary.points.map((p) => ({
      date: p.date,
      t: p.t,
      value: p.value,
    }));
  } else if (monthPoints.length >= 12) {
    const byYear = new Map<string, number[]>();
    for (const pt of monthPoints) {
      const y = pt.date.slice(0, 4);
      const list = byYear.get(y) ?? [];
      list.push(pt.value);
      byYear.set(y, list);
    }
    annualPoints = Array.from(byYear.entries())
      .filter(([, vals]) => vals.length >= 6)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([y, vals]) => ({
        date: y,
        t: Number(y),
        value: Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)),
      }));
    summary = analyzeTimeSeries(annualPoints.length >= 5 ? annualPoints : monthPoints, {
      lat: clampedLat,
      lng: clampedLng,
      dataset,
      parameter: `${config.parameter} (${datasetMeta.shortLabel})`,
      unit: dataset === "wildfire" ? "kPa" : config.unit,
      slopeUnit: dataset === "wildfire" ? "kPa/yr" : config.slopeUnit,
      provenance: "NASA POWER MERRA-2 (Live)",
    });
  } else {
    throw summaryRes.status === "rejected"
      ? summaryRes.reason
      : new Error("Insufficient regional multi-scale observations");
  }

  const channelSet = new Set<string>();
  for (const pt of monthPoints.slice(0, 12)) {
    if (pt.channels) {
      for (const k of Object.keys(pt.channels)) channelSet.add(k);
    }
  }

  return {
    annual: annualPoints,
    month: monthPoints,
    day: dayPoints,
    summary,
    channelNames: Array.from(channelSet),
  };
}
