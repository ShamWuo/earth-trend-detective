import { DATASET_BY_ID } from "@/lib/datasets";
import { fetchRegionalMultiScaleSeries } from "@/lib/nasa/nasaPowerClient";
import type { ETGDatasetId, GraphPredictionResult } from "@/types/etg";
import { predictFromGraph } from "./corePredictor";
import type { EtgStoreLike } from "./predictorTypesAndUtils";

/**
 * Predicts Earth trends for an arbitrary coordinate `(lat, lng, dataset)` even if no
 * node exists yet at that location: resolves an existing regional anchor within 85 km
 * or queries live NASA POWER / GloFAS / CAMS multi-scale series, attaches nearby &
 * global climate-mode drivers into ETG, and runs leak-free graph prediction.
 */
export async function predictRegion(
  store: EtgStoreLike,
  options: {
    targetUuid?: string;
    lat?: number;
    lng?: number;
    dataset?: ETGDatasetId;
    maxHops?: number;
    horizonSteps?: number;
    candidateNeighborUuid?: string;
    persistRegionNode?: boolean;
  }
): Promise<GraphPredictionResult> {
  if (options.targetUuid) {
    const existing = store.getNode(options.targetUuid);
    const existingSeries = store.getNodeSeries(options.targetUuid);
    if (existing && existingSeries && existingSeries.length >= 10) {
      const pred = predictFromGraph(store, {
        targetUuid: options.targetUuid,
        maxHops: options.maxHops,
        horizonSteps: options.horizonSteps,
        candidateNeighborUuid: options.candidateNeighborUuid,
      });
      if (options.lat !== undefined && options.lng !== undefined) {
        return {
          ...pred,
          regionQuery: {
            lat: options.lat,
            lng: options.lng,
            dataset: options.dataset ?? existing.properties.dataset ?? "nasa_power",
            synthesizedAnchor: false,
          },
        };
      }
      return pred;
    }
  }

  if (
    typeof options.lat !== "number" ||
    !Number.isFinite(options.lat) ||
    typeof options.lng !== "number" ||
    !Number.isFinite(options.lng) ||
    options.lat < -90 ||
    options.lat > 90 ||
    options.lng < -180 ||
    options.lng > 180
  ) {
    throw new Error("Valid targetUuid or finite lat (-90..90) and lng (-180..180) are required.");
  }

  const lat = Number(options.lat.toFixed(3));
  const lng = Number(options.lng.toFixed(3));
  const dataset: ETGDatasetId = options.dataset ?? "nasa_power";

  const ctx = store.assembleRegionalContextSubgraph?.({
    lat,
    lng,
    dataset,
    radiusKm: 1800,
    maxHops: options.maxHops ?? 2,
    includeGlobalModes: true,
  });

  if (ctx?.targetNode) {
    const existingSeries = store.getNodeSeries(ctx.targetNode.uuid);
    if (existingSeries && existingSeries.length >= 10) {
      const pred = predictFromGraph(store, {
        targetUuid: ctx.targetNode.uuid,
        maxHops: options.maxHops,
        horizonSteps: options.horizonSteps,
        candidateNeighborUuid: options.candidateNeighborUuid,
      });
      return {
        ...pred,
        regionQuery: {
          lat,
          lng,
          dataset,
          synthesizedAnchor: false,
        },
      };
    }
  }

  const regional = await fetchRegionalMultiScaleSeries(lat, lng, dataset);
  const chosenPrimary =
    regional.month.length >= 14
      ? regional.month
      : regional.annual.length >= 10
        ? regional.annual
        : regional.day;
  if (chosenPrimary.length < 10) {
    throw new Error(
      `Insufficient multi-scale observations at (${lat.toFixed(2)}, ${lng.toFixed(2)}) for ${dataset}.`
    );
  }

  const dsMeta = DATASET_BY_ID[dataset];
  const anchorUuid = `signal-region-${dataset}-${String(lat).replace(/[^0-9-]/g, "p")}_${String(lng).replace(/[^0-9-]/g, "p")}`;
  const isProvisional = options.persistRegionNode === false;
  const anchorNode = store.createNode({
    uuid: anchorUuid,
    label: "Signal",
    is_provisional: isProvisional,
    properties: {
      name: `${dsMeta.shortLabel} @ (${lat.toFixed(2)}°, ${lng.toFixed(2)}°)`,
      description: `Regional multi-scale query node (${regional.summary.parameter}) synthesized from ${regional.summary.provenance}.`,
      lat,
      lng,
      region: `(${lat.toFixed(2)}°, ${lng.toFixed(2)}°)`,
      dataset,
      parameter: regional.summary.parameter,
      unit: regional.summary.unit,
      slope_unit: regional.summary.slopeUnit,
      provenance_source: regional.summary.provenance,
      producer_type: "nasa_satellite",
      authored_by: "satellite_pipeline",
      p_value: regional.summary.mannKendall.pValue,
      theil_sen_slope: regional.summary.theilSen.slope,
      temporal_scale: regional.month.length >= 14 ? "month" : "year",
      channel_names: regional.channelNames,
      series: chosenPrimary,
    },
    silent: isProvisional,
  });

  if (store.setNodeMultiScaleSeries) {
    if (regional.month.length >= 12) {
      store.setNodeMultiScaleSeries(anchorNode.uuid, "month", regional.month, true);
    }
    if (regional.annual.length >= 5) {
      store.setNodeMultiScaleSeries(anchorNode.uuid, "year", regional.annual, true);
    }
    if (regional.day.length >= 14) {
      store.setNodeMultiScaleSeries(anchorNode.uuid, "day", regional.day, true);
    }
  }

  // Wire up to 6 regional/global driver nodes so graph message passing can assist regional inference
  if (ctx?.nodes?.length) {
    const scoredDrivers = ctx.nodes
      .filter((n) => n.uuid !== anchorNode.uuid && (store.getNodeSeries(n.uuid)?.length ?? 0) >= 8)
      .sort((a, b) => (ctx.distancesByUuid[a.uuid] ?? 9999) - (ctx.distancesByUuid[b.uuid] ?? 9999))
      .slice(0, 6);
    for (const drv of scoredDrivers) {
      const dist = ctx.distancesByUuid[drv.uuid] ?? 2000;
      const isGlobal = dist > 1800 || drv.properties.phenomenon_type === "climate_index";
      store.createEdge({
        uuid: `edge-region-${drv.uuid.slice(0, 10)}-${anchorNode.uuid.slice(0, 12)}`,
        source_uuid: drv.uuid,
        target_uuid: anchorNode.uuid,
        type: isGlobal ? "teleconnects" : "correlates_with",
        cross_scale: isGlobal,
        source_snippet: isGlobal
          ? "Global climate mode link"
          : `Regional context (${Math.round(dist)} km)`,
        authored_by: "ai",
        silent: true,
      });
    }
  }

  const pred = predictFromGraph(store, {
    targetUuid: anchorNode.uuid,
    maxHops: options.maxHops,
    horizonSteps: options.horizonSteps,
    candidateNeighborUuid: options.candidateNeighborUuid,
  });

  return {
    ...pred,
    regionQuery: {
      lat,
      lng,
      dataset,
      synthesizedAnchor: true,
    },
  };
}
