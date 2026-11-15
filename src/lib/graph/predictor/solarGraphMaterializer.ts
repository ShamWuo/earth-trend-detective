import { alignCompatibleSeries } from "@/lib/graph/etgStore";
import {
  bearingDeg,
  DENVER_CLIMATE_NODES,
  type DailyWeatherRow,
} from "@/lib/solar/denverClimateGraph";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import type { ETGEdge, ETGNode, TimeSeriesPoint } from "@/types/etg";
import type { EtgStoreLike } from "./predictorTypesAndUtils";

function dailyRowsToTimeSeries(rows: readonly DailyWeatherRow[]): TimeSeriesPoint[] {
  return rows.map((r) => {
    const iso = `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`;
    const y = Number(r.date.slice(0, 4));
    const m = Number(r.date.slice(4, 6)) - 1;
    const d = Number(r.date.slice(6, 8));
    const ms = Date.UTC(y, m, d);
    const start = Date.UTC(y, 0, 1);
    return {
      date: iso,
      t: Number((y + (ms - start) / (365.25 * 86_400_000)).toFixed(6)),
      value: Number(r.allsky.toFixed(3)),
    };
  });
}

async function fetchSolarDailyRowsForNode(
  lat: number,
  lng: number,
  startYear = 2024,
  endYear = 2025
): Promise<DailyWeatherRow[]> {
  const start = `${startYear}0101`;
  const end = `${endYear}1231`;
  const params = "ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN,T2M,RH2M,PRECTOTCORR,WS10M,WD10M";
  const url =
    `https://power.larc.nasa.gov/api/temporal/daily/point` +
    `?parameters=${params}&community=RE&longitude=${lng}&latitude=${lat}` +
    `&start=${start}&end=${end}&format=JSON`;
  let res: Response | null = null;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const candidate = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: {
          Accept: "application/json",
          "User-Agent": "EarthTrendDetective/1.0 (NASA-Space-Apps)",
        },
      });
      if ((candidate.status === 429 || candidate.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      res = candidate;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }
  if (!res) {
    throw lastErr instanceof Error ? lastErr : new Error("NASA POWER Daily fetch failed");
  }
  if (!res.ok) {
    throw new Error(`NASA POWER Daily HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    properties?: { parameter?: Record<string, Record<string, number>> };
  };
  const p = json.properties?.parameter;
  if (!p?.ALLSKY_SFC_SW_DWN || !p?.CLRSKY_SFC_SW_DWN) {
    throw new Error("Missing ALLSKY_SFC_SW_DWN from NASA POWER");
  }
  const rows: DailyWeatherRow[] = [];
  for (const date of Object.keys(p.ALLSKY_SFC_SW_DWN).sort()) {
    const allsky = Number(p.ALLSKY_SFC_SW_DWN[date]);
    const clrsky = Number(p.CLRSKY_SFC_SW_DWN[date]);
    if (allsky <= -900 || clrsky <= -900 || !Number.isFinite(allsky)) continue;
    rows.push({
      date,
      allsky,
      clrsky,
      kt: allsky / Math.max(clrsky, 0.5),
      t2m: Number(p.T2M?.[date] ?? 10),
      rh2m: Number(p.RH2M?.[date] ?? 50),
      precip: Number(p.PRECTOTCORR?.[date] ?? 0),
      ws10m: Number(p.WS10M?.[date] ?? 3),
      wd10m: Number(p.WD10M?.[date] ?? 270),
    });
  }
  return rows;
}

/**
 * Materializes the 7-node Front Range solar irradiance graph directly inside the main ETG store
 * with directed `advects_to` edges into Denver Microgrid Target so users can traverse, edit, and run
 * `predictFromGraph` on real NASA POWER daily telemetry inside Knowledge Graph View.
 */
export async function materializeDenverSolarGraphIntoEtg(
  store: EtgStoreLike,
  seriesOverride?: Record<string, TimeSeriesPoint[]>
): Promise<{
  hubUuid: string;
  createdNodes: ETGNode[];
  createdEdges: ETGEdge[];
}> {
  const seriesById: Record<string, TimeSeriesPoint[]> = {};
  if (seriesOverride) {
    for (const node of DENVER_CLIMATE_NODES) {
      seriesById[node.id] = seriesOverride[node.id] ?? [];
    }
  } else {
    const fetched = await Promise.all(
      DENVER_CLIMATE_NODES.map(async (node) => {
        const rows = await fetchSolarDailyRowsForNode(node.lat, node.lng, 2024, 2025);
        return [node.id, dailyRowsToTimeSeries(rows)] as const;
      })
    );
    for (const [id, s] of fetched) seriesById[id] = s;
  }

  const createdNodes: ETGNode[] = [];
  const createdEdges: ETGEdge[] = [];
  const hubUuid = "signal-solar-denver-target";

  for (const cfg of DENVER_CLIMATE_NODES) {
    const uuid = `signal-solar-${cfg.id}`;
    const series = seriesById[cfg.id] ?? [];
    const summary =
      series.length >= 6
        ? analyzeTimeSeries(series, {
            lat: cfg.lat,
            lng: cfg.lng,
            dataset: "nasa_power",
            parameter: "ALLSKY_SFC_SW_DWN",
            unit: "kWh/m²/d",
            slopeUnit: "kWh/m²/d/yr",
            provenance: "NASA POWER MERRA-2 (Live)",
          })
        : null;

    const node = store.createNode({
      uuid,
      label: "Signal",
      is_provisional: false,
      silent: true,
      properties: {
        name: cfg.role === "target" ? "Denver Solar Microgrid Irradiance" : `${cfg.name} Solar Flux`,
        description: cfg.rationale,
        lat: cfg.lat,
        lng: cfg.lng,
        region: cfg.direction === "CENTER" ? "Front Range Hub, CO" : `${cfg.direction} Corridor (${cfg.distanceKm} km)`,
        dataset: "nasa_power",
        parameter: "ALLSKY_SFC_SW_DWN",
        unit: "kWh/m²/d",
        slope_unit: "kWh/m²/d/yr",
        phenomenon_type: cfg.role === "target" ? "physical_impact" : "sensor_station",
        domain_tags: ["solar", "irradiance", "advection", "microgrid"],
        authored_by: seriesOverride ? "human" : "satellite_pipeline",
        producer_type: "nasa_satellite",
        provenance_source: "NASA POWER MERRA-2 (Live)",
        value: series[series.length - 1]?.value,
        p_value: summary?.mannKendall.pValue,
        theil_sen_slope: summary?.theilSen.slope,
        ols_r2: summary?.ols.rSquared,
        importance: cfg.role === "target" ? 10 : 7,
        series,
      },
    });
    createdNodes.push(node);
  }

  const targetSeries = seriesById["denver-target"] ?? [];
  const targetCfg = DENVER_CLIMATE_NODES.find((n) => n.role === "target")!;
  for (const cfg of DENVER_CLIMATE_NODES) {
    if (cfg.role === "target") continue;
    const srcUuid = `signal-solar-${cfg.id}`;
    const srcSeries = seriesById[cfg.id] ?? [];
    const aligned =
      srcSeries.length >= 6 && targetSeries.length >= 6
        ? alignCompatibleSeries(srcSeries, targetSeries)
        : null;
    const comp = aligned
      ? compareRegionalSeries(aligned.alignedA, aligned.alignedB, {
          latA: cfg.lat,
          lngA: cfg.lng,
          datasetA: "nasa_power",
          latB: targetCfg.lat,
          lngB: targetCfg.lng,
          datasetB: "nasa_power",
        })
      : null;

    const brg = Math.round(bearingDeg(cfg.lat, cfg.lng, targetCfg.lat, targetCfg.lng));
    const edge = store.createEdge({
      uuid: `edge-solar-${cfg.id}-to-denver`,
      source_uuid: srcUuid,
      target_uuid: hubUuid,
      type: "advects_to",
      source_snippet: `${cfg.distanceKm} km upwind (${cfg.direction}, bearing ${brg}°)`,
      rationale: `${cfg.name} (${cfg.distanceKm} km ${cfg.direction} of Denver, ${cfg.elevationM} m elev) advects cloud/smoke clearness variations into the Denver Microgrid (${comp ? `r=${comp.pearsonR.toFixed(2)}, optimal lag=${comp.optimalLagSteps} days` : "upwind atmospheric corridor"}).`,
      correlation_r: comp?.pearsonR,
      detrended_r: comp?.detrendedR,
      optimal_lag_steps: comp ? Math.max(1, Math.abs(comp.optimalLagSteps)) : 1,
      lag_unit: "days",
      mechanism: comp?.mechanism ?? "Front Range atmospheric cloud/aerosol advection",
      weight: comp ? Math.max(0.45, Math.min(1, Math.abs(comp.pearsonR))) : 0.78,
      authored_by: seriesOverride ? "human" : "satellite_pipeline",
      silent: true,
    });
    createdEdges.push(edge);
  }

  store.recordActivity?.({
    kind: "discovery",
    nodeUuid: hubUuid,
    summary: `Materialized 7-node Front Range Solar Predictive Subgraph into ETG (${createdEdges.length} advects_to links).`,
  });

  return { hubUuid, createdNodes, createdEdges };
}
