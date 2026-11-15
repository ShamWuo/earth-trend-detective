import crypto from "node:crypto";
import { bearingDeg } from "@/lib/solar/denverClimateGraph";
import type {
  EarthSphere,
  ETGRelationshipType,
  GraphMlDatasetExport,
  GraphMlDatasetExportV2,
  GraphPredictionResult,
  ProspectiveForecastRecord,
  ProspectiveLedgerSummary,
  TimeSeriesPoint,
} from "@/types/etg";
import {
  aggregateSeriesByBucket,
  buildCausalScaleBlock,
  computeCausalPearsonAndLag,
  haversineKm,
  inferEarthSphere,
  inferNodeTemporalScale,
  inferSeriesBucket,
  isCommunityContributorNode,
  normalizeBucketPeriodKey,
  parseSeriesDateMs,
  toTimeSeriesPoint,
  type CausalImpulseEvent,
  type TemporalBucket,
} from "./etgSeriesAndTrustUtils";
import type { EtgStoreContext } from "./etgStoreContext";

/**
 * Exports a PyTorch Geometric / NetworkX-compatible node-feature & edge-index tensor bundle.
 */
export function exportMlGraphDatasetOp(
  ctx: EtgStoreContext,
  options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
  }
): GraphMlDatasetExport {
  const sub =
    options?.rootUuid && ctx.nodes.has(options.rootUuid)
      ? ctx.traverseSubgraph({
          rootUuid: options.rootUuid,
          maxHops: options.maxHops ?? 2,
          direction: "both",
        })
      : null;

  const nodes = (sub ? sub.nodes : Array.from(ctx.nodes.values())).filter(
    (n) => n.properties.status !== "Superseded"
  );
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, idx) => nodeIndex.set(n.uuid, idx));

  const edges = (sub ? sub.edges : Array.from(ctx.edges.values())).filter(
    (e) => nodeIndex.has(e.source_uuid) && nodeIndex.has(e.target_uuid)
  );

  let bucket: TemporalBucket = options?.bucket ?? "year";
  if (!options?.bucket) {
    const rootSeries = options?.rootUuid ? ctx.getNodeSeries(options.rootUuid) : undefined;
    if (rootSeries && rootSeries.length >= 3) {
      bucket = inferSeriesBucket(rootSeries);
    } else {
      const counts: Record<TemporalBucket, number> = { day: 0, month: 0, year: 0 };
      for (const n of nodes) {
        const s = ctx.getNodeSeries(n.uuid);
        if (s && s.length >= 3) counts[inferSeriesBucket(s)] += 1;
      }
      if (counts.day >= counts.month && counts.day >= counts.year && counts.day > 0) bucket = "day";
      else if (counts.month >= counts.year && counts.month > 0) bucket = "month";
    }
  }

  const bucketedMaps = nodes.map((n) => {
    const s = ctx.getNodeSeries(n.uuid);
    return s && s.length > 0 ? aggregateSeriesByBucket(s, bucket) : new Map<string, TimeSeriesPoint>();
  });

  const timeKeyToT = new Map<string, number>();
  for (const m of bucketedMaps) {
    for (const [k, pt] of m.entries()) {
      if (!timeKeyToT.has(k)) timeKeyToT.set(k, pt.t);
    }
  }
  const timeIndex = Array.from(timeKeyToT.keys()).sort(
    (a, b) => (timeKeyToT.get(a) ?? 0) - (timeKeyToT.get(b) ?? 0)
  );

  const nodeStats = bucketedMaps.map((m) => {
    const vals = timeIndex
      .map((k) => m.get(k)?.value)
      .filter((v): v is number => v !== undefined && Number.isFinite(v));
    const mean = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    const variance =
      vals.length > 1
        ? vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1)
        : 1;
    return { mean, std: Math.max(1e-6, Math.sqrt(variance)) };
  });

  const featureTensor: number[][][] = [];
  const maskTensor: number[][] = [];
  const prevObserved: Array<number | null> = nodes.map(() => null);

  for (const tKey of timeIndex) {
    const rowFeat: number[][] = [];
    const rowMask: number[] = [];
    for (let j = 0; j < nodes.length; j++) {
      const pt = bucketedMaps[j].get(tKey);
      if (pt && Number.isFinite(pt.value)) {
        const z = (pt.value - nodeStats[j].mean) / nodeStats[j].std;
        const prev = prevObserved[j];
        const diff = prev !== null ? (pt.value - prev) / nodeStats[j].std : 0;
        prevObserved[j] = pt.value;
        rowFeat.push([
          Number(pt.value.toFixed(4)),
          Number(z.toFixed(4)),
          Number(diff.toFixed(4)),
        ]);
        rowMask.push(1);
      } else {
        rowFeat.push([0, 0, 0]);
        rowMask.push(0);
      }
    }
    featureTensor.push(rowFeat);
    maskTensor.push(rowMask);
  }

  const srcIdx: number[] = [];
  const dstIdx: number[] = [];
  const edgeTypes: ETGRelationshipType[] = [];
  const edgeAttr: number[][] = [];

  for (const e of edges) {
    const s = nodeIndex.get(e.source_uuid);
    const d = nodeIndex.get(e.target_uuid);
    if (s === undefined || d === undefined) continue;
    srcIdx.push(s);
    dstIdx.push(d);
    edgeTypes.push(e.type);

    const srcNode = nodes[s];
    const dstNode = nodes[d];
    let distKm = 0;
    let brgRad = 0;
    if (
      srcNode.properties.lat !== undefined &&
      srcNode.properties.lng !== undefined &&
      dstNode.properties.lat !== undefined &&
      dstNode.properties.lng !== undefined
    ) {
      distKm = haversineKm(
        srcNode.properties.lat,
        srcNode.properties.lng,
        dstNode.properties.lat,
        dstNode.properties.lng
      );
      brgRad =
        (bearingDeg(
          srcNode.properties.lat,
          srcNode.properties.lng,
          dstNode.properties.lat,
          dstNode.properties.lng
        ) *
          Math.PI) /
        180;
    }

    edgeAttr.push([
      Number((e.properties.correlation_r ?? 0).toFixed(4)),
      Number((e.properties.detrended_r ?? 0).toFixed(4)),
      e.properties.optimal_lag_steps ?? 0,
      Number(ctx.getEdgeWeight(e).toFixed(4)),
      Number(Math.min(1, distKm / 20000).toFixed(4)),
      Number(Math.sin(brgRad).toFixed(4)),
      Number(Math.cos(brgRad).toFixed(4)),
      e.type === "drives_opposite" ? 1 : 0,
    ]);
  }

  return {
    schema_version: "etg-ml-v1",
    bucket,
    node_ids: nodes.map((n) => n.uuid),
    node_metadata: nodes.map((n, index) => ({
      index,
      uuid: n.uuid,
      label: n.label,
      name: n.properties.name,
      dataset: n.properties.dataset,
      phenomenon_type: n.properties.phenomenon_type,
      lat: n.properties.lat,
      lng: n.properties.lng,
      slope_per_decade: n.properties.theil_sen_slope,
      p_value: n.properties.p_value,
    })),
    edge_index: [srcIdx, dstIdx],
    edge_types: edgeTypes,
    edge_attr_names: [
      "correlation_r",
      "detrended_r",
      "optimal_lag_steps",
      "weight",
      "distance_km_norm",
      "sin_bearing",
      "cos_bearing",
      "is_opposite",
    ],
    edge_attr: edgeAttr,
    time_index: timeIndex,
    feature_names: ["value", "z_score", "diff_1"],
    feature_tensor: featureTensor,
    mask_tensor: maskTensor,
  };
}

/**
 * Exports a zero-leakage multi-scale spatio-temporal graph tensor bundle (`etg-ml-v2`).
 */
export function exportMlGraphDatasetV2Op(
  ctx: EtgStoreContext,
  options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
    trainFraction?: number;
    trainCutoffDate?: string;
    horizonSteps?: number;
  }
): GraphMlDatasetExportV2 {
  const sub =
    options?.rootUuid && ctx.nodes.has(options.rootUuid)
      ? ctx.traverseSubgraph({
          rootUuid: options.rootUuid,
          maxHops: options.maxHops ?? 2,
          direction: "both",
        })
      : null;

  const nodes = (sub ? sub.nodes : Array.from(ctx.nodes.values())).filter(
    (n) => n.properties.status !== "Superseded"
  );
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, idx) => nodeIndex.set(n.uuid, idx));

  const edges = (sub ? sub.edges : Array.from(ctx.edges.values())).filter(
    (e) =>
      nodeIndex.has(e.source_uuid) &&
      nodeIndex.has(e.target_uuid) &&
      !e.properties.superseded_at
  );

  let bucket: TemporalBucket = options?.bucket ?? "month";
  if (!options?.bucket) {
    const rootSeries = options?.rootUuid ? ctx.getNodeMultiScaleSeries(options.rootUuid) : undefined;
    if (rootSeries && rootSeries.length >= 3) {
      bucket = inferSeriesBucket(rootSeries);
    } else {
      const counts: Record<TemporalBucket, number> = { day: 0, month: 0, year: 0 };
      for (const n of nodes) {
        if (ctx.multiScaleSeriesByNode.get(n.uuid)?.month?.length) {
          counts.month += 1;
          continue;
        }
        const s = ctx.getNodeSeries(n.uuid);
        if (s && s.length >= 3) counts[inferSeriesBucket(s)] += 1;
      }
      if (counts.day > counts.month && counts.day >= counts.year && counts.day > 0) {
        bucket = "day";
      } else if (counts.month >= counts.year && counts.month > 0) {
        bucket = "month";
      } else if (counts.year > 0) {
        bucket = "year";
      }
    }
  }

  const impulseEventsByNode = new Map<number, CausalImpulseEvent[]>();
  for (let j = 0; j < nodes.length; j++) {
    const n = nodes[j];
    const s = ctx.getNodeSeries(n.uuid);
    const scale = inferNodeTemporalScale(n, s);
    const events: CausalImpulseEvent[] = [];
    const intensity = n.properties.event_intensity ?? 1;
    const decayDays = n.properties.event_decay_days ?? (n.properties.event_ended_at ? 10 : 18);

    if (scale === "impulse" || typeof n.properties.event_intensity === "number") {
      if (n.properties.observed_at) {
        const ms = parseSeriesDateMs(n.properties.observed_at);
        if (ms !== null) events.push({ ms, intensity, decayDays });
      }
      if (s) {
        for (const pt of s) {
          const ms = parseSeriesDateMs(pt.date);
          if (ms !== null) {
            events.push({
              ms,
              intensity: Number.isFinite(pt.value) && pt.value > 0 ? Math.min(2.5, Math.max(0.4, intensity)) : intensity,
              decayDays,
            });
          }
        }
      }
    }
    if (events.length > 0) {
      impulseEventsByNode.set(j, events);
    }
  }

  const incidentImpulsesByNode = new Map<number, number[]>();
  for (const e of edges) {
    const s = nodeIndex.get(e.source_uuid);
    const d = nodeIndex.get(e.target_uuid);
    if (s === undefined || d === undefined) continue;
    if (impulseEventsByNode.has(s)) {
      const list = incidentImpulsesByNode.get(d) ?? [];
      if (!list.includes(s)) list.push(s);
      incidentImpulsesByNode.set(d, list);
    }
  }

  const primaryMaps = nodes.map((n) => {
    const s = ctx.getNodeMultiScaleSeries(n.uuid, bucket) ?? ctx.getNodeSeries(n.uuid);
    return s && s.length > 0
      ? aggregateSeriesByBucket(s, bucket)
      : new Map<string, TimeSeriesPoint>();
  });

  const trainFraction = options?.trainFraction ?? 0.75;
  const trainCutoffDate = options?.trainCutoffDate;
  const primaryBlock = buildCausalScaleBlock({
    nodeCount: nodes.length,
    scaleMaps: primaryMaps,
    impulseEventsByNode,
    incidentImpulsesByNode,
    trainFraction,
    trainCutoffDate,
  });

  const trainKeys = primaryBlock.timeIndex.slice(0, primaryBlock.trainCutoffIndex);

  const srcIdx: number[] = [];
  const dstIdx: number[] = [];
  const edgeTypes: ETGRelationshipType[] = [];
  const edgeAttr: number[][] = [];

  for (const e of edges) {
    const s = nodeIndex.get(e.source_uuid);
    const d = nodeIndex.get(e.target_uuid);
    if (s === undefined || d === undefined) continue;
    srcIdx.push(s);
    dstIdx.push(d);
    edgeTypes.push(e.type);

    const srcNode = nodes[s];
    const dstNode = nodes[d];
    const { corrR, optimalLag } = computeCausalPearsonAndLag(
      primaryMaps[s],
      primaryMaps[d],
      trainKeys
    );

    let distKm = 0;
    let brgRad = 0;
    if (
      srcNode.properties.lat !== undefined &&
      srcNode.properties.lng !== undefined &&
      dstNode.properties.lat !== undefined &&
      dstNode.properties.lng !== undefined
    ) {
      distKm = haversineKm(
        srcNode.properties.lat,
        srcNode.properties.lng,
        dstNode.properties.lat,
        dstNode.properties.lng
      );
      brgRad =
        (bearingDeg(
          srcNode.properties.lat,
          srcNode.properties.lng,
          dstNode.properties.lat,
          dstNode.properties.lng
        ) *
          Math.PI) /
        180;
    }

    const structuralWeight =
      typeof e.properties.weight === "number" && Number.isFinite(e.properties.weight)
        ? Math.max(0.05, Math.min(1, e.properties.weight))
        : Math.abs(corrR) > 0.05
        ? Math.max(0.2, Math.abs(corrR))
        : 0.72;

    edgeAttr.push([
      corrR,
      Number(Math.max(-1, Math.min(1, optimalLag / 6)).toFixed(4)),
      Number(structuralWeight.toFixed(4)),
      Number(Math.min(1, distKm / 20000).toFixed(4)),
      Number(Math.sin(brgRad).toFixed(4)),
      Number(Math.cos(brgRad).toFixed(4)),
      e.type === "drives_opposite" ? 1 : 0,
      e.properties.cross_scale ? 1 : 0,
    ]);
  }

  const nodeMetadata: GraphMlDatasetExportV2["node_metadata"] = [];
  const nodeStaticFeatures: number[][] = [];

  for (let index = 0; index < nodes.length; index++) {
    const n = nodes[index];
    const s = ctx.getNodeSeries(n.uuid);
    const scale = inferNodeTemporalScale(n, s);
    const sphere: EarthSphere = inferEarthSphere(n);
    const trustScore = ctx.computeNodeTrustScore(n);
    const isCommunity = isCommunityContributorNode(n);
    const corroborated = Boolean(n.properties.corroborated);

    nodeMetadata.push({
      index,
      uuid: n.uuid,
      label: n.label,
      name: n.properties.name,
      dataset: n.properties.dataset,
      sphere,
      temporal_scale: scale,
      phenomenon_type: n.properties.phenomenon_type,
      lat: n.properties.lat,
      lng: n.properties.lng,
      elevation_m: n.properties.elevation_m,
      trust_score: trustScore,
      is_community: isCommunity,
      corroborated,
      slope_per_decade: n.properties.theil_sen_slope,
      p_value: n.properties.p_value,
    });

    const latRad = ((n.properties.lat ?? 0) * Math.PI) / 180;
    const lngRad = ((n.properties.lng ?? 0) * Math.PI) / 180;
    const elevNorm = Math.max(-1, Math.min(1, (n.properties.elevation_m ?? 0) / 5000));
    const msEntry = ctx.multiScaleSeriesByNode.get(n.uuid);
    const avail = new Set<string>(n.properties.available_scales ?? []);
    const hasDay = scale === "day" || avail.has("day") || Boolean(msEntry?.day?.length) ? 1 : 0;
    const hasMonth =
      scale === "month" || avail.has("month") || Boolean(msEntry?.month?.length) ? 1 : 0;
    const hasYear = scale === "year" || avail.has("year") || Boolean(msEntry?.year?.length) ? 1 : 0;
    const hasImpulse = scale === "impulse" ? 1 : 0;

    nodeStaticFeatures.push([
      Number(Math.sin(latRad).toFixed(4)),
      Number(Math.cos(latRad).toFixed(4)),
      Number(Math.sin(lngRad).toFixed(4)),
      Number(Math.cos(lngRad).toFixed(4)),
      Number(elevNorm.toFixed(4)),
      trustScore,
      isCommunity ? 1 : 0,
      corroborated ? 1 : 0,
      hasDay,
      hasMonth,
      hasYear,
      hasImpulse,
      sphere === "Atmosphere" ? 1 : 0,
      sphere === "Ocean" ? 1 : 0,
      sphere === "Hydrosphere" ? 1 : 0,
      sphere === "Biosphere" || sphere === "Cryosphere" ? 1 : 0,
    ]);
  }

  const multiScaleBlocks: GraphMlDatasetExportV2["multi_scale_blocks"] = {};
  for (const scale of ["day", "month", "year"] as const) {
    const scaleNodeIndices: number[] = [];
    const scaleMaps: Array<Map<string, TimeSeriesPoint>> = [];
    for (let j = 0; j < nodes.length; j++) {
      const msSeries = ctx.multiScaleSeriesByNode.get(nodes[j].uuid)?.[scale];
      const primary = ctx.getNodeSeries(nodes[j].uuid);
      const matchesPrimary =
        primary && primary.length >= 2 && inferSeriesBucket(primary) === scale;
      const chosen =
        msSeries && msSeries.length >= 2 ? msSeries : matchesPrimary ? primary : undefined;
      if (chosen && chosen.length >= 2) {
        scaleNodeIndices.push(j);
        scaleMaps.push(aggregateSeriesByBucket(chosen, scale));
      }
    }

    if (scaleNodeIndices.length === 0) continue;
    const subIndexMap = new Map<number, number>();
    scaleNodeIndices.forEach((origIdx, subIdx) => subIndexMap.set(origIdx, subIdx));

    const subImpulseEvents = new Map<number, CausalImpulseEvent[]>();
    const subIncidentImpulses = new Map<number, number[]>();
    for (const [origIdx, evs] of impulseEventsByNode.entries()) {
      const subIdx = subIndexMap.get(origIdx);
      if (subIdx !== undefined) subImpulseEvents.set(subIdx, evs);
    }
    for (const [origDst, origSrcList] of incidentImpulsesByNode.entries()) {
      const subDst = subIndexMap.get(origDst);
      if (subDst === undefined) continue;
      const mapped = origSrcList
        .map((src) => subIndexMap.get(src))
        .filter((v): v is number => v !== undefined);
      if (mapped.length > 0) subIncidentImpulses.set(subDst, mapped);
    }

    const block = buildCausalScaleBlock({
      nodeCount: scaleNodeIndices.length,
      scaleMaps,
      impulseEventsByNode: subImpulseEvents,
      incidentImpulsesByNode: subIncidentImpulses,
      trainFraction,
      trainCutoffDate,
    });

    multiScaleBlocks[scale] = {
      time_index: block.timeIndex,
      node_indices: scaleNodeIndices,
      feature_tensor: block.featureTensor,
      mask_tensor: block.maskTensor,
    };
  }

  const horizonSteps = Math.max(1, Math.min(6, options?.horizonSteps ?? 1));
  const T = primaryBlock.timeIndex.length;
  const N = nodes.length;
  const nextValueTargets: Array<Array<number | null>> = [];
  const trendClassTargets: Array<Array<number | null>> = [];
  const regimeShiftTargets: Array<Array<number | null>> = [];

  for (let t = 0; t < T; t++) {
    const nvRow: Array<number | null> = [];
    const tcRow: Array<number | null> = [];
    const rsRow: Array<number | null> = [];
    const fIdx = t + horizonSteps;

    for (let j = 0; j < N; j++) {
      if (fIdx < T && primaryBlock.maskTensor[fIdx][j] === 1) {
        const futureZ = primaryBlock.featureTensor[fIdx][j][1];
        nvRow.push(futureZ);

        if (primaryBlock.maskTensor[t][j] === 1) {
          const curZ = primaryBlock.featureTensor[t][j][1];
          const deltaZ = futureZ - curZ;
          tcRow.push(deltaZ <= -0.35 ? 0 : deltaZ >= 0.35 ? 2 : 1);

          const rollMeanZ = primaryBlock.featureTensor[t][j][3];
          const signFlip = futureZ * rollMeanZ < -0.5 && Math.abs(futureZ) >= 1.1;
          const jump = Math.abs(futureZ - rollMeanZ) >= 1.5;
          rsRow.push(jump || signFlip ? 1 : 0);
        } else {
          tcRow.push(null);
          rsRow.push(null);
        }
      } else {
        nvRow.push(null);
        tcRow.push(null);
        rsRow.push(null);
      }
    }
    nextValueTargets.push(nvRow);
    trendClassTargets.push(tcRow);
    regimeShiftTargets.push(rsRow);
  }

  return {
    schema_version: "etg-ml-v2",
    primary_bucket: bucket,
    train_cutoff_index: primaryBlock.trainCutoffIndex,
    node_ids: nodes.map((n) => n.uuid),
    node_metadata: nodeMetadata,
    node_static_feature_names: [
      "lat_sin",
      "lat_cos",
      "lng_sin",
      "lng_cos",
      "elevation_norm",
      "trust_score",
      "is_community",
      "corroborated",
      "scale_day",
      "scale_month",
      "scale_year",
      "scale_impulse",
      "sphere_atmosphere",
      "sphere_ocean",
      "sphere_hydrosphere",
      "sphere_biosphere_cryo",
    ],
    node_static_features: nodeStaticFeatures,
    edge_index: [srcIdx, dstIdx],
    edge_types: edgeTypes,
    edge_attr_names: [
      "causal_corr_r",
      "causal_optimal_lag_norm",
      "weight",
      "distance_km_norm",
      "sin_bearing",
      "cos_bearing",
      "is_opposite",
      "is_cross_scale",
    ],
    edge_attr: edgeAttr,
    time_index: primaryBlock.timeIndex,
    feature_names: [
      "value",
      "z_score",
      "diff_1",
      "rolling_mean_4",
      "rolling_std_4",
      "seasonal_anom",
      "event_impulse",
      "covar_primary",
    ],
    feature_tensor: primaryBlock.featureTensor,
    mask_tensor: primaryBlock.maskTensor,
    multi_scale_blocks: multiScaleBlocks,
    labels: {
      horizon_steps: horizonSteps,
      next_value_targets: nextValueTargets,
      trend_class_targets: trendClassTargets,
      regime_shift_targets: regimeShiftTargets,
    },
    normalization: primaryBlock.normStats.map((s) => ({
      mean: Number(s.mean.toFixed(6)),
      std: Number(s.std.toFixed(6)),
    })),
  };
}

/**
 * Logs an ex-ante live forecast onto the prospective verification ledger.
 */
export function logProspectiveForecastOp(
  ctx: EtgStoreContext,
  prediction: GraphPredictionResult
): ProspectiveForecastRecord {
  const targetNode = ctx.nodes.get(prediction.targetUuid);
  const series = ctx.getNodeSeries(prediction.targetUuid) ?? [];
  const issuedFromRaw =
    series[series.length - 1]?.date ??
    targetNode?.properties.observed_at ??
    new Date().toISOString().slice(0, 10);
  const issuedFromPeriod =
    normalizeBucketPeriodKey(issuedFromRaw, prediction.bucket) ?? issuedFromRaw;
  const normalizedTargetPeriod =
    normalizeBucketPeriodKey(
      prediction.nextForecast.nextPeriodLabel,
      prediction.bucket
    ) ?? prediction.nextForecast.nextPeriodLabel;

  const existingPending = Array.from(ctx.forecasts.values()).find(
    (f) =>
      f.target_uuid === prediction.targetUuid &&
      f.bucket === prediction.bucket &&
      f.target_period === normalizedTargetPeriod &&
      f.status === "pending"
  );

  const record: ProspectiveForecastRecord = {
    id: existingPending?.id ?? `fc-${crypto.randomUUID().slice(0, 8)}`,
    target_uuid: prediction.targetUuid,
    target_name: prediction.targetName,
    unit: prediction.unit,
    bucket: prediction.bucket,
    issued_at: new Date().toISOString(),
    issued_from_period: issuedFromPeriod,
    target_period: normalizedTargetPeriod,
    last_actual: prediction.nextForecast.lastActual,
    predicted_value: prediction.recommendedForecastValue,
    self_only_pred: prediction.nextForecast.selfOnlyPred,
    persistence_pred: prediction.nextForecast.persistencePred,
    ci95_half_width: prediction.nextForecast.ci95HalfWidth,
    recommended_model: prediction.recommendedModel,
    architecture: prediction.activeGraphArchitecture,
    driver_uuids: prediction.neighborContributions.map((n) => n.nodeUuid),
    status: "pending",
  };

  ctx.forecasts.set(record.id, record);
  if (series.length > 0) {
    ctx.reconcileSeriesForTarget(prediction.targetUuid, series);
  }

  const stored = ctx.forecasts.get(record.id) ?? record;
  const act = ctx.pushActivity({
    kind: "prediction",
    nodeUuid: prediction.targetUuid,
    summary: `Logged prospective forecast for "${prediction.targetName}" (${stored.target_period}: ${stored.predicted_value} ± ${stored.ci95_half_width} ${prediction.unit}, status=${stored.status}).`,
  });
  ctx.emitUpdate(act);
  return stored;
}

/**
 * Reconciles pending prospective forecasts against newly arrived observations.
 */
export function reconcileProspectiveForecastsOp(
  ctx: EtgStoreContext,
  targetUuid?: string
): {
  scoredNow: number;
  ledger: {
    records: ProspectiveForecastRecord[];
    summary: ProspectiveLedgerSummary;
  };
} {
  const pendingTargets = new Set<string>();
  for (const f of ctx.forecasts.values()) {
    if (f.status !== "pending") continue;
    if (targetUuid && f.target_uuid !== targetUuid) continue;
    pendingTargets.add(f.target_uuid);
  }

  let scoredNow = 0;
  for (const uuid of pendingTargets) {
    const series = ctx.getNodeSeries(uuid) ?? [];
    if (series.length > 0) {
      scoredNow += ctx.reconcileSeriesForTarget(uuid, series);
    } else {
      const node = ctx.nodes.get(uuid);
      if (
        node &&
        typeof node.properties.value === "number" &&
        node.properties.observed_at
      ) {
        const singlePt = toTimeSeriesPoint(
          node.properties.observed_at,
          node.properties.value
        );
        if (singlePt) {
          scoredNow += ctx.reconcileSeriesForTarget(uuid, [singlePt]);
        }
      }
    }
  }

  if (scoredNow > 0) {
    const act = ctx.pushActivity({
      kind: "prediction",
      nodeUuid: targetUuid,
      summary: `Reconciled ${scoredNow} prospective forecast${scoredNow === 1 ? "" : "s"} against new ground-truth observations.`,
    });
    ctx.emitUpdate(act);
  }

  return {
    scoredNow,
    ledger: getProspectiveLedgerOp(ctx, targetUuid),
  };
}

/**
 * Returns all prospective forecasts and aggregate out-of-sample calibration statistics.
 */
export function getProspectiveLedgerOp(
  ctx: EtgStoreContext,
  targetUuid?: string
): {
  records: ProspectiveForecastRecord[];
  summary: ProspectiveLedgerSummary;
} {
  const records = Array.from(ctx.forecasts.values())
    .filter((r) => !targetUuid || r.target_uuid === targetUuid)
    .sort((a, b) => Date.parse(b.issued_at) - Date.parse(a.issued_at));

  const scored = records.filter((r) => r.status === "scored");
  const pendingCount = records.length - scored.length;

  let meanAbsError: number | null = null;
  let selfMeanAbsError: number | null = null;
  let persistenceMeanAbsError: number | null = null;
  let ci95CoveragePct: number | null = null;
  let skillVsSelfPct: number | null = null;

  if (scored.length > 0) {
    const sumErr = scored.reduce((s, r) => s + (r.abs_error ?? 0), 0);
    const sumSelfErr = scored.reduce((s, r) => s + (r.self_abs_error ?? 0), 0);
    const sumPersistErr = scored.reduce(
      (s, r) => s + (r.persistence_abs_error ?? 0),
      0
    );
    const coveredCount = scored.filter((r) => r.covered_by_ci95).length;

    meanAbsError = Number((sumErr / scored.length).toFixed(4));
    selfMeanAbsError = Number((sumSelfErr / scored.length).toFixed(4));
    persistenceMeanAbsError = Number((sumPersistErr / scored.length).toFixed(4));
    ci95CoveragePct = Number(((coveredCount / scored.length) * 100).toFixed(1));
    if (selfMeanAbsError > 1e-9) {
      skillVsSelfPct = Number(
        (((selfMeanAbsError - meanAbsError) / selfMeanAbsError) * 100).toFixed(2)
      );
    }
  }

  return {
    records,
    summary: {
      total_logged: records.length,
      pending_count: pendingCount,
      scored_count: scored.length,
      mean_abs_error: meanAbsError,
      self_mean_abs_error: selfMeanAbsError,
      persistence_mean_abs_error: persistenceMeanAbsError,
      ci95_coverage_pct: ci95CoveragePct,
      skill_vs_self_pct: skillVsSelfPct,
    },
  };
}
