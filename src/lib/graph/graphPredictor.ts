import fs from "node:fs";
import path from "node:path";
import {
  aggregateSeriesByBucket,
  alignCompatibleSeries,
  computeEtgNodeTrustScore,
  haversineKm,
  inferNodeTemporalScale,
  inferSeriesBucket,
  isCommunityContributorNode,
  type TemporalBucket,
} from "@/lib/graph/etgStore";
import { DATASET_BY_ID } from "@/lib/datasets";
import { fetchRegionalMultiScaleSeries } from "@/lib/nasa/nasaPowerClient";
import {
  bearingDeg,
  DENVER_CLIMATE_NODES,
  fitRidgeRegression,
  type DailyWeatherRow,
} from "@/lib/solar/denverClimateGraph";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import type {
  CommunityImpactSummary,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  GraphMlDatasetExport,
  GraphMlDatasetExportV2,
  GraphNeighborContribution,
  GraphPredictionEngineUsed,
  GraphPredictionResult,
  GraphPredictorModelKind,
  PredictorEvalMetrics,
  TimeSeriesPoint,
  TrendEmergenceForecast,
} from "@/types/etg";

export interface EtgStoreLike {
  getNode: (uuid: string) => ETGNode | undefined;
  getNodeSeries: (uuid: string) => TimeSeriesPoint[] | undefined;
  getNodeWithSeries: (uuid: string) => (ETGNode & { series?: TimeSeriesPoint[] }) | undefined;
  getNodeMultiScaleSeries?: (
    uuid: string,
    scale?: TemporalBucket
  ) => TimeSeriesPoint[] | undefined;
  setNodeMultiScaleSeries?: (
    uuid: string,
    scale: TemporalBucket,
    series: readonly TimeSeriesPoint[],
    silent?: boolean
  ) => boolean;
  computeNodeTrustScore?: (node: ETGNode) => number;
  assembleRegionalContextSubgraph?: (options: {
    targetUuid?: string;
    lat?: number;
    lng?: number;
    dataset?: ETGDatasetId;
    radiusKm?: number;
    maxHops?: number;
    includeGlobalModes?: boolean;
  }) => {
    targetNode?: ETGNode;
    nodes: ETGNode[];
    edges: ETGEdge[];
    scalesUsed: Array<"day" | "month" | "year" | "impulse">;
    distancesByUuid: Record<string, number>;
  };
  traverseSubgraph: (options: {
    rootUuid: string;
    maxHops?: number;
    direction?: "upstream" | "downstream" | "both";
  }) => {
    nodes: ETGNode[];
    edges: ETGEdge[];
    hopByNode: Record<string, number>;
  };
  createNode: (input: {
    uuid?: string;
    label: string;
    is_provisional?: boolean;
    properties: Partial<ETGNode["properties"]> & { name: string; description: string };
    silent?: boolean;
  }) => ETGNode;
  createEdge: (input: {
    uuid?: string;
    source_uuid: string;
    target_uuid: string;
    type: ETGEdge["type"];
    source_snippet?: string;
    rationale?: string;
    correlation_r?: number;
    detrended_r?: number;
    lag_days?: number;
    optimal_lag_steps?: number;
    lag_unit?: "months" | "years" | "days";
    mechanism?: string;
    weight?: number;
    cross_scale?: boolean;
    authored_by?: "human" | "ai" | "satellite_pipeline" | "iot_sensor";
    silent?: boolean;
  }) => ETGEdge;
  updateNode?: (
    uuid: string,
    patch: Partial<ETGNode["properties"]>,
    silent?: boolean
  ) => unknown;
  updateEdge?: (
    edgeUuid: string,
    patch: { predictive_lift_pct?: number },
    silent?: boolean
  ) => unknown;
  recordActivity?: (entry: {
    kind: "prediction" | "discovery";
    summary: string;
    nodeUuid?: string;
  }) => unknown;
  exportMlGraphDataset?: (options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
  }) => GraphMlDatasetExport;
  exportMlGraphDatasetV2?: (options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
    trainFraction?: number;
    horizonSteps?: number;
  }) => GraphMlDatasetExportV2;
}

function pearsonTrain(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom > 1e-12 ? num / denom : 0;
}

function dot(weights: readonly number[], x: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i] * x[i];
  }
  return sum;
}

function computeEvalMetrics(
  actuals: readonly number[],
  preds: readonly number[],
  persistenceRmse: number
): PredictorEvalMetrics {
  const n = actuals.length;
  if (n === 0) {
    return { rmse: 0, mae: 0, r2: 0, skillVsPersistencePct: 0 };
  }
  let sq = 0;
  let abs = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const err = preds[i] - actuals[i];
    sq += err * err;
    abs += Math.abs(err);
    sumY += actuals[i];
  }
  const rmse = Math.sqrt(sq / n);
  const mae = abs / n;
  const meanY = sumY / n;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (actuals[i] - meanY) ** 2;
  }
  const r2 = ssTot > 1e-12 ? 1 - sq / ssTot : 0;
  const skillVsPersistencePct =
    persistenceRmse > 1e-9 ? ((persistenceRmse - rmse) / persistenceRmse) * 100 : 0;

  return {
    rmse: Number(rmse.toFixed(4)),
    mae: Number(mae.toFixed(4)),
    r2: Number(Math.max(-5, Math.min(1, r2)).toFixed(3)),
    skillVsPersistencePct: Number(skillVsPersistencePct.toFixed(2)),
  };
}

function advanceDateLabel(lastDate: string, bucket: TemporalBucket, steps = 1): string {
  if (bucket === "year") {
    const y = Number.parseInt(lastDate.slice(0, 4), 10);
    return Number.isFinite(y) ? String(y + steps) : `+${steps}y`;
  }
  if (bucket === "month") {
    const m = lastDate.match(/^(\d{4})-(\d{2})/);
    if (m) {
      const baseMonths = Number(m[1]) * 12 + (Number(m[2]) - 1) + steps;
      const ny = Math.floor(baseMonths / 12);
      const nm = (baseMonths % 12) + 1;
      return `${ny}-${String(nm).padStart(2, "0")}`;
    }
  }
  const ms = Date.parse(lastDate);
  if (Number.isFinite(ms)) {
    const d = new Date(ms + steps * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return `+${steps} step`;
}

function seasonalAngle(dateKey: string, bucket: TemporalBucket): number | null {
  if (bucket === "month") {
    const m = dateKey.match(/^\d{4}-(\d{2})/);
    if (m) return (2 * Math.PI * (Number(m[1]) - 1)) / 12;
  }
  if (bucket === "day") {
    const ms = Date.parse(dateKey);
    if (Number.isFinite(ms)) {
      const dt = new Date(ms);
      const start = Date.UTC(dt.getUTCFullYear(), 0, 1);
      const doy = Math.floor((ms - start) / 86_400_000);
      return (2 * Math.PI * doy) / 365.25;
    }
  }
  return null;
}

function parseDateKeyMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{4}$/.test(trimmed)) return Date.UTC(Number(trimmed), 6, 1);
  const ym = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) {
    const y = Number(ym[1]);
    const m = Number(ym[2]);
    if (m >= 1 && m <= 12) return Date.UTC(y, m - 1, 15);
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function previousCoarsePeriodKey(
  targetDate: string,
  coarseBucket: "month" | "year"
): string | null {
  const yMatch = targetDate.match(/^(\d{4})/);
  if (!yMatch) return null;
  const year = Number(yMatch[1]);
  if (coarseBucket === "year") {
    return String(year - 1);
  }
  const ymMatch = targetDate.match(/^(\d{4})[-/](\d{1,2})/);
  if (!ymMatch) return null;
  const month = Number(ymMatch[2]);
  if (month < 1 || month > 12) return null;
  const prevTotal = year * 12 + (month - 1) - 1;
  const py = Math.floor(prevTotal / 12);
  const pm = (prevTotal % 12) + 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

export interface PortableInductiveWeightsV2 {
  schema_version: "etg-inductive-weights-v2";
  static_proj_w: number[][];
  static_proj_b: number[];
  temp_proj_w: number[][];
  temp_proj_b: number[];
  msg_proj_w: number[][];
  msg_proj_b: number[];
  trust_gate_w: number;
  trust_gate_b: number;
  head_w: number[];
  head_b: number;
  residual_z_weight?: number;
}

let cachedWeightsV2: {
  filePath: string;
  mtimeMs: number;
  weights: PortableInductiveWeightsV2;
} | null = null;

function parseInductiveWeightsV2(
  filePath: string,
  mtimeMs: number,
  raw: string
): PortableInductiveWeightsV2 | null {
  const parsed = JSON.parse(raw) as PortableInductiveWeightsV2;
  if (
    parsed?.schema_version === "etg-inductive-weights-v2" &&
    Array.isArray(parsed.static_proj_w) &&
    Array.isArray(parsed.head_w)
  ) {
    cachedWeightsV2 = { filePath, mtimeMs, weights: parsed };
    return parsed;
  }
  return null;
}

/**
 * Loads portable `etg-inductive-weights-v2` weights from local runtime cache
 * (`.data/etg-inductive-weights-v2.json`) first, automatically falling back to
 * git-tracked bundled weights (`ml/weights/etg-inductive-weights-v2.json`) on
 * fresh repository clones or zero-cold-start deployments.
 */
export function loadLocalInductiveWeightsV2(options?: {
  rootDir?: string;
}): PortableInductiveWeightsV2 | null {
  if (!options?.rootDir) {
    const dataPath = path.join(process.cwd(), ".data", "etg-inductive-weights-v2.json");
    try {
      if (fs.existsSync(dataPath)) {
        const stat = fs.statSync(dataPath);
        if (cachedWeightsV2?.filePath === dataPath && cachedWeightsV2.mtimeMs === stat.mtimeMs) {
          return cachedWeightsV2.weights;
        }
        const hit = parseInductiveWeightsV2(dataPath, stat.mtimeMs, fs.readFileSync(dataPath, "utf8"));
        if (hit) return hit;
      }
    } catch {
      // Fall through to tracked weights bundle
    }

    const trackedPath = path.join(process.cwd(), "ml", "weights", "etg-inductive-weights-v2.json");
    try {
      if (fs.existsSync(trackedPath)) {
        const stat = fs.statSync(trackedPath);
        if (
          cachedWeightsV2?.filePath === trackedPath &&
          cachedWeightsV2.mtimeMs === stat.mtimeMs
        ) {
          return cachedWeightsV2.weights;
        }
        const hit = parseInductiveWeightsV2(
          trackedPath,
          stat.mtimeMs,
          fs.readFileSync(trackedPath, "utf8")
        );
        if (hit) return hit;
      }
    } catch {
      // Optional tracked artifact not present or malformed
    }
    return null;
  }

  const customCandidates = [
    path.join(options.rootDir, ".data", "etg-inductive-weights-v2.json"),
    path.join(options.rootDir, "ml", "weights", "etg-inductive-weights-v2.json"),
  ];
  for (const filePath of customCandidates) {
    try {
      if (!fs.existsSync(/*turbopackIgnore: true*/ filePath)) continue;
      const stat = fs.statSync(/*turbopackIgnore: true*/ filePath);
      if (cachedWeightsV2?.filePath === filePath && cachedWeightsV2.mtimeMs === stat.mtimeMs) {
        return cachedWeightsV2.weights;
      }
      const hit = parseInductiveWeightsV2(
        filePath,
        stat.mtimeMs,
        fs.readFileSync(/*turbopackIgnore: true*/ filePath, "utf8")
      );
      if (hit) return hit;
    } catch {
      // Fall through to next candidate path
    }
  }
  return null;
}

function evalPortableInductiveV2ForNode(
  weights: PortableInductiveWeightsV2,
  bundle: GraphMlDatasetExportV2,
  targetIdx: number,
  tIdx: number
): number | null {
  const staticFeat = bundle.node_static_features[targetIdx];
  const tempFeat = bundle.feature_tensor[tIdx]?.[targetIdx];
  const norm = bundle.normalization?.[targetIdx];
  if (!staticFeat || !tempFeat || bundle.mask_tensor[tIdx]?.[targetIdx] !== 1) return null;

  const H = weights.head_w.length;
  const hidden = new Array<number>(H).fill(0);
  for (let h = 0; h < H; h++) {
    let acc = (weights.static_proj_b[h] ?? 0) + (weights.temp_proj_b[h] ?? 0);
    const sw = weights.static_proj_w[h];
    const tw = weights.temp_proj_w[h];
    if (sw) {
      for (let i = 0; i < Math.min(sw.length, staticFeat.length); i++) acc += sw[i] * staticFeat[i];
    }
    if (tw) {
      for (let i = 0; i < Math.min(tw.length, tempFeat.length); i++) acc += tw[i] * tempFeat[i];
    }
    hidden[h] = acc;
  }

  const [srcs, dsts] = bundle.edge_index;
  let weightSum = 0;
  const msgAgg = new Array<number>(H).fill(0);
  for (let e = 0; e < dsts.length; e++) {
    if (dsts[e] !== targetIdx) continue;
    const srcIdx = srcs[e];
    if (bundle.mask_tensor[tIdx]?.[srcIdx] !== 1) continue;
    const srcTemp = bundle.feature_tensor[tIdx][srcIdx];
    const eAttr = bundle.edge_attr[e];
    const srcTrust = bundle.node_metadata[srcIdx]?.trust_score ?? 0.7;
    const gate = 1 / (1 + Math.exp(-(weights.trust_gate_w * srcTrust + weights.trust_gate_b)));
    const edgeW = Math.max(0.05, eAttr?.[2] ?? 0.5) * gate;
    weightSum += edgeW;
    for (let h = 0; h < H; h++) {
      let m = weights.msg_proj_b[h] ?? 0;
      const mw = weights.msg_proj_w[h];
      if (mw) {
        for (let i = 0; i < 8; i++) m += (mw[i] ?? 0) * (srcTemp[i] ?? 0);
        for (let i = 0; i < 8; i++) m += (mw[8 + i] ?? 0) * (eAttr?.[i] ?? 0);
      }
      msgAgg[h] += edgeW * Math.tanh(m);
    }
  }

  let outZ = weights.head_b + (weights.residual_z_weight ?? 0) * (tempFeat[1] ?? 0);
  const denom = Math.max(1e-6, weightSum);
  for (let h = 0; h < H; h++) {
    const act = Math.tanh(hidden[h] + (weightSum > 0 ? msgAgg[h] / denom : 0));
    outZ += weights.head_w[h] * act;
  }
  return norm ? outZ * norm.std + norm.mean : outZ;
}

function buildQuantilesAndTrendForecast(args: {
  recommendedForecastValue: number;
  lastActual: number;
  horizonSteps: number;
  winningRmse: number;
  yStd: number;
  rollingMean4: number;
  signedResiduals: readonly number[];
}): {
  quantiles: { p10: number; p50: number; p90: number };
  trendForecast: TrendEmergenceForecast;
} {
  const {
    recommendedForecastValue,
    lastActual,
    horizonSteps,
    winningRmse,
    yStd,
    rollingMean4,
    signedResiduals,
  } = args;
  const gaussian10 = 1.2816 * winningRmse;
  let lowerSpan = gaussian10;
  let upperSpan = gaussian10;
  if (signedResiduals.length >= 8) {
    const sorted = [...signedResiduals].sort((a, b) => a - b);
    const q10 = sorted[Math.max(0, Math.floor(0.1 * (sorted.length - 1)))];
    const q90 = sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * (sorted.length - 1)))];
    lowerSpan = Math.max(gaussian10 * 0.65, Math.abs(Math.min(0, q10)));
    upperSpan = Math.max(gaussian10 * 0.65, Math.max(0, q90));
  }
  const p50 = Number(recommendedForecastValue.toFixed(3));
  const p10 = Number((recommendedForecastValue - lowerSpan).toFixed(3));
  const p90 = Number((recommendedForecastValue + upperSpan).toFixed(3));

  const predictedSlopePerStep = Number(
    ((recommendedForecastValue - lastActual) / Math.max(1, horizonSteps)).toFixed(4)
  );
  const zDelta = (recommendedForecastValue - lastActual) / Math.max(1e-6, yStd);
  const lDec = (-zDelta - 0.15) * 2.2;
  const lSta = 0.55 - Math.abs(zDelta) * 1.8;
  const lInc = (zDelta - 0.15) * 2.2;
  const maxL = Math.max(lDec, lSta, lInc);
  const eDec = Math.exp(lDec - maxL);
  const eSta = Math.exp(lSta - maxL);
  const eInc = Math.exp(lInc - maxL);
  const eSum = eDec + eSta + eInc;

  const pDec = Number((eDec / eSum).toFixed(3));
  const pSta = Number((eSta / eSum).toFixed(3));
  const pInc = Number(Math.max(0, 1 - pDec - pSta).toFixed(3));

  const direction: TrendEmergenceForecast["direction"] =
    pInc >= pDec && pInc >= pSta
      ? "increasing"
      : pDec >= pInc && pDec >= pSta
      ? "decreasing"
      : "stable";

  const zShift = Math.abs(recommendedForecastValue - rollingMean4) / Math.max(1e-6, yStd);
  const rawRegime = 1 / (1 + Math.exp(-1.8 * (zShift - 1.35)));
  const regimeShiftProb = Number(Math.max(0.01, Math.min(0.99, rawRegime)).toFixed(3));

  return {
    quantiles: { p10, p50, p90 },
    trendForecast: {
      direction,
      probabilities: { increasing: pInc, decreasing: pDec, stable: pSta },
      regimeShiftProb,
      predictedSlopePerStep,
    },
  };
}

/**
 * General Graph-Reading Predictive Engine:
 * Reads a target node's multi-scale time-series, multivariate covariates, discrete
 * impulse events, and community/satellite neighbors in ETG, trains strict temporal
 * holdout Ridge/Ensemble regressors without future data leakage, trust-gates noisy
 * community nodes, and quantifies graph & community lift over Persistence/Self-AR.
 */
export function predictFromGraph(
  store: EtgStoreLike,
  options: {
    targetUuid: string;
    maxHops?: number;
    horizonSteps?: number;
    candidateNeighborUuid?: string;
  }
): GraphPredictionResult {
  const targetNode = store.getNodeWithSeries(options.targetUuid);
  if (!targetNode) {
    throw new Error(`Target node "${options.targetUuid}" not found.`);
  }
  const rawSeries = targetNode.series ?? store.getNodeSeries(options.targetUuid);
  if (!rawSeries || rawSeries.length < 8) {
    throw new Error(
      `Need at least 8 time-series observations on "${targetNode.properties.name}" to run graph prediction.`
    );
  }

  const bucket = inferSeriesBucket(rawSeries);
  const targetMap = aggregateSeriesByBucket(rawSeries, bucket);
  const targetEntries = Array.from(targetMap.values()).sort(
    (a, b) => a.t - b.t || a.date.localeCompare(b.date)
  );
  if (targetEntries.length < 10) {
    throw new Error(
      `Target node "${targetNode.properties.name}" has only ${targetEntries.length} bucketed observations (need >= 10).`
    );
  }

  const horizonSteps = Math.max(1, Math.min(3, Math.round(options.horizonSteps ?? 1)));
  const maxHops = Math.max(1, Math.min(4, Math.round(options.maxHops ?? 2)));

  // Gather upstream drivers first; fall back to bidirectional neighbors if graph uses undirected links
  const upstreamSub = store.traverseSubgraph({
    rootUuid: options.targetUuid,
    maxHops,
    direction: "upstream",
  });
  const bothSub = store.traverseSubgraph({
    rootUuid: options.targetUuid,
    maxHops,
    direction: "both",
  });

  const regionalSub = store.assembleRegionalContextSubgraph
    ? store.assembleRegionalContextSubgraph({
        targetUuid: options.targetUuid,
        radiusKm: 1600,
        maxHops,
        includeGlobalModes: true,
      })
    : null;

  const incidentEdgeByNeighbor = new Map<string, ETGEdge>();
  for (const e of [...upstreamSub.edges, ...bothSub.edges, ...(regionalSub?.edges ?? [])]) {
    if (e.target_uuid === options.targetUuid && !incidentEdgeByNeighbor.has(e.source_uuid)) {
      incidentEdgeByNeighbor.set(e.source_uuid, e);
    } else if (e.source_uuid === options.targetUuid && !incidentEdgeByNeighbor.has(e.target_uuid)) {
      incidentEdgeByNeighbor.set(e.target_uuid, e);
    }
  }

  interface CandidateNeighbor {
    node: ETGNode;
    edge?: ETGEdge;
    hop: number;
    isCandidatePreview: boolean;
    isCommunity: boolean;
    trustScore: number;
    values: Array<number | null>;
    coverage: number;
    rawLagSteps: number;
    edgeWeight: number;
    edgeType: string;
    sourceScale: TemporalBucket;
    isCrossScale: boolean;
  }

  const neighborMap = new Map<string, CandidateNeighbor>();
  const impulseEvents: Array<{ ms: number; intensity: number; decayDays: number }> = [];
  const scalesUsedSet = new Set<"day" | "month" | "year" | "impulse">([bucket]);
  for (const av of targetNode.properties.available_scales ?? []) {
    scalesUsedSet.add(av);
  }

  const seenConnected = new Set<string>();
  const connectedNodes = [...upstreamSub.nodes, ...bothSub.nodes];
  for (const cn of connectedNodes) seenConnected.add(cn.uuid);

  const orderedNodes: ETGNode[] = [...connectedNodes];
  if (regionalSub) {
    for (const rn of regionalSub.nodes) {
      if (!seenConnected.has(rn.uuid)) orderedNodes.push(rn);
    }
  }

  const considerNode = (n: ETGNode, hop: number, isPreview: boolean, connectedOnly: boolean) => {
    if (n.uuid === options.targetUuid) return;
    if (n.properties.status === "Superseded") return;

    const multiScaled = store.getNodeMultiScaleSeries?.(n.uuid, bucket);
    const rawS = multiScaled && multiScaled.length > 0 ? multiScaled : store.getNodeSeries(n.uuid);
    const scaleKind = inferNodeTemporalScale(n, rawS);

    // Record discrete impulse events (connected OR within 1600 km regional radius)
    if (
      scaleKind === "impulse" ||
      typeof n.properties.event_intensity === "number" ||
      ((!rawS || rawS.length < 8) && (n.uuid.includes("eonet") || Boolean(n.properties.observed_at)))
    ) {
      let withinRange = seenConnected.has(n.uuid);
      if (
        !withinRange &&
        targetNode.properties.lat !== undefined &&
        targetNode.properties.lng !== undefined &&
        n.properties.lat !== undefined &&
        n.properties.lng !== undefined
      ) {
        withinRange =
          haversineKm(
            targetNode.properties.lat,
            targetNode.properties.lng,
            n.properties.lat,
            n.properties.lng
          ) <= 1600;
      }
      if (withinRange) {
        const intensity = n.properties.event_intensity ?? 1.0;
        const decayDays = n.properties.event_decay_days ?? (n.properties.event_ended_at ? 10 : 18);
        if (n.properties.observed_at) {
          const ms = parseDateKeyMs(n.properties.observed_at);
          if (ms !== null) impulseEvents.push({ ms, intensity, decayDays });
        }
        if (rawS) {
          for (const pt of rawS) {
            const ms = parseDateKeyMs(pt.date);
            if (ms !== null) impulseEvents.push({ ms, intensity, decayDays });
          }
        }
      }
      if (!rawS || rawS.length < 8) return;
    }

    if (connectedOnly && !seenConnected.has(n.uuid) && !isPreview) return;
    if (neighborMap.has(n.uuid)) return;
    if (!rawS || rawS.length < 8) return;

    const nbNativeBucket = inferSeriesBucket(rawS);
    const isCoarserToFiner =
      (nbNativeBucket === "year" && (bucket === "month" || bucket === "day")) ||
      (nbNativeBucket === "month" && bucket === "day");

    let hits = 0;
    let alignedVals: Array<number | null>;
    if (!isCoarserToFiner) {
      const bucketMap = aggregateSeriesByBucket(rawS, bucket);
      alignedVals = targetEntries.map((tp) => {
        const pt = bucketMap.get(tp.date);
        if (pt && Number.isFinite(pt.value)) {
          hits++;
          return pt.value;
        }
        return null;
      });
    } else {
      const coarseBucket: "month" | "year" = nbNativeBucket === "year" ? "year" : "month";
      const coarseMap = aggregateSeriesByBucket(rawS, coarseBucket);
      alignedVals = targetEntries.map((tp) => {
        const prevKey = previousCoarsePeriodKey(tp.date, coarseBucket);
        const pt = prevKey ? coarseMap.get(prevKey) : undefined;
        if (pt && Number.isFinite(pt.value)) {
          hits++;
          return pt.value;
        }
        return null;
      });
    }

    // Fallback: backfill single missing gap via previous observation only (causal LOCF)
    const filledVals: Array<number | null> = [];
    for (let i = 0; i < alignedVals.length; i++) {
      if (alignedVals[i] !== null) {
        filledVals.push(alignedVals[i]);
      } else if (i > 0 && filledVals[i - 1] !== null && alignedVals[i - 1] !== null) {
        filledVals.push(filledVals[i - 1]);
      } else {
        filledVals.push(null);
      }
    }

    const coverage = hits / targetEntries.length;
    if (hits < 8 || coverage < 0.55) return;

    const edge = incidentEdgeByNeighbor.get(n.uuid);
    const hopDecay = hop > 1 ? Math.pow(0.75, hop - 1) : 1;
    const baseWeight =
      edge?.properties.weight ??
      (edge?.properties.correlation_r !== undefined
        ? Math.max(0.35, Math.min(1, Math.abs(edge.properties.correlation_r)))
        : 0.72);
    const isCommunity = isCommunityContributorNode(n);
    const trustScore = store.computeNodeTrustScore
      ? store.computeNodeTrustScore(n)
      : computeEtgNodeTrustScore(n);
    const trustMultiplier = isCommunity ? Math.max(0.25, trustScore) : 1;
    const lagRaw = edge?.properties.optimal_lag_steps ?? 1;

    neighborMap.set(n.uuid, {
      node: n,
      edge,
      hop,
      isCandidatePreview: isPreview,
      isCommunity,
      trustScore,
      values: filledVals,
      coverage,
      rawLagSteps: Math.max(1, Math.min(3, Math.abs(lagRaw) || 1)),
      edgeWeight: Math.max(0.15, Math.min(1, baseWeight * hopDecay * trustMultiplier)),
      edgeType: edge ? edge.properties.custom_label || edge.type : "candidate_preview",
      sourceScale: nbNativeBucket,
      isCrossScale: Boolean(edge?.properties.cross_scale) || isCoarserToFiner,
    });
  };

  for (const n of orderedNodes) {
    const hop = upstreamSub.hopByNode[n.uuid] ?? bothSub.hopByNode[n.uuid] ?? 1;
    considerNode(n, hop, false, true);
  }
  if (options.candidateNeighborUuid) {
    const previewNode = store.getNode(options.candidateNeighborUuid);
    if (previewNode) {
      considerNode(previewNode, 1, !incidentEdgeByNeighbor.has(previewNode.uuid), false);
    }
  }

  // Strict temporal origin indices `t` predicting `t + horizonSteps`
  const maxHistoryLag = 3;
  const originIndices: number[] = [];
  for (let t = maxHistoryLag; t < targetEntries.length - horizonSteps; t++) {
    originIndices.push(t);
  }
  if (originIndices.length < 8) {
    throw new Error(
      `Insufficient aligned prediction origins (${originIndices.length}) on "${targetNode.properties.name}".`
    );
  }

  const sampleCount = originIndices.length;
  const trainCount = Math.max(6, Math.min(sampleCount - 2, Math.floor(sampleCount * 0.72)));
  const testCount = sampleCount - trainCount;

  // Target standardization computed strictly on training target values
  const trainYs = originIndices.slice(0, trainCount).map((t) => targetEntries[t + horizonSteps].value);
  const yMean = trainYs.reduce((s, v) => s + v, 0) / trainCount;
  const yVar =
    trainYs.reduce((s, v) => s + (v - yMean) ** 2, 0) / Math.max(1, trainCount - 1);
  const yStd = Math.max(1e-6, Math.sqrt(yVar));

  const yNorm = (val: number) => (val - yMean) / yStd;
  const yUnnorm = (z: number) => z * yStd + yMean;

  // Causal impulse series over targetEntries (only events <= target timestamp)
  const targetMsArr = targetEntries.map((tp) => parseDateKeyMs(tp.date) ?? 0);
  const rawImpulseSeries = targetMsArr.map((tMs) => {
    if (impulseEvents.length === 0 || tMs === 0) return 0;
    let sum = 0;
    for (const ev of impulseEvents) {
      if (ev.ms <= tMs) {
        const deltaDays = (tMs - ev.ms) / 86_400_000;
        if (deltaDays <= ev.decayDays * 4) {
          sum += ev.intensity * Math.exp(-deltaDays / Math.max(1, ev.decayDays));
        }
      }
    }
    return Math.min(2.5, sum);
  });
  const trainImpulses = originIndices.slice(0, trainCount).map((t) => rawImpulseSeries[t]);
  const impMean = trainImpulses.reduce((s, v) => s + v, 0) / trainCount;
  const impVar =
    trainImpulses.reduce((s, v) => s + (v - impMean) ** 2, 0) / Math.max(1, trainCount - 1);
  const hasCausalImpulseFeature = impulseEvents.length > 0 && impVar > 1e-8;
  const impStd = Math.max(1e-6, Math.sqrt(impVar));
  if (hasCausalImpulseFeature) scalesUsedSet.add("impulse");

  // Causal multivariate `channels` covariates from targetEntries strictly using `< trainCount` stats
  const covarPrefOrder = ["vpd", "rh2m", "precip", "ws10m", "clrsky", "kt", "t2m_max", "glofas", "pm25"];
  const candidateCovarKeys = new Set<string>();
  for (let i = 0; i < trainCount; i++) {
    const ch = targetEntries[originIndices[i]].channels;
    if (ch) {
      for (const k of Object.keys(ch)) candidateCovarKeys.add(k);
    }
  }
  const activeCovarStats: Array<{ key: string; mean: number; std: number }> = [];
  const orderedCovarKeys = [
    ...covarPrefOrder.filter((k) => candidateCovarKeys.has(k)),
    ...Array.from(candidateCovarKeys).filter((k) => !covarPrefOrder.includes(k)),
  ];
  for (const ck of orderedCovarKeys) {
    if (activeCovarStats.length >= 2) break;
    const vals: number[] = [];
    for (let i = 0; i < trainCount; i++) {
      const v = targetEntries[originIndices[i]].channels?.[ck];
      if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < Math.max(6, Math.floor(trainCount * 0.75))) continue;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1);
    if (variance > 1e-8) {
      activeCovarStats.push({ key: ck, mean, std: Math.sqrt(variance) });
    }
  }

  // Evaluate candidate neighbors strictly on the training split (selecting causal offset 0..2)
  interface SelectedNeighbor {
    cand: CandidateNeighbor;
    offset: number;
    mean: number;
    std: number;
    trainCorr: number;
    weightScale: number;
  }

  const trainTargetSeries = originIndices.slice(0, trainCount).map((t) => targetEntries[t + horizonSteps].value);
  const evaluatedNeighbors: SelectedNeighbor[] = [];

  for (const cand of neighborMap.values()) {
    let bestOffset = Math.max(0, Math.min(2, cand.rawLagSteps - horizonSteps));
    let bestAbsR = -1;
    let bestMean = 0;
    let bestStd = 1;
    let bestCorr = 0;

    for (const offset of [0, 1, 2]) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < trainCount; i++) {
        const t = originIndices[i];
        const xv = cand.values[t - offset];
        if (xv !== null && Number.isFinite(xv)) {
          xs.push(xv);
          ys.push(trainTargetSeries[i]);
        }
      }
      if (xs.length < Math.max(6, Math.floor(trainCount * 0.75))) continue;
      const r = pearsonTrain(xs, ys);
      if (Math.abs(r) > bestAbsR) {
        bestAbsR = Math.abs(r);
        bestCorr = r;
        bestOffset = offset;
        bestMean = xs.reduce((s, v) => s + v, 0) / xs.length;
        const xVar = xs.reduce((s, v) => s + (v - bestMean) ** 2, 0) / Math.max(1, xs.length - 1);
        bestStd = Math.max(1e-6, Math.sqrt(xVar));
      }
    }

    if (bestAbsR >= 0) {
      evaluatedNeighbors.push({
        cand,
        offset: bestOffset,
        mean: bestMean,
        std: bestStd,
        trainCorr: bestCorr,
        weightScale: cand.edgeWeight,
      });
    }
  }

  evaluatedNeighbors.sort(
    (a, b) =>
      Math.abs(b.trainCorr) * b.weightScale - Math.abs(a.trainCorr) * a.weightScale
  );
  const maxNeighborsAllowed = Math.max(1, Math.min(6, Math.floor(trainCount / 4)));
  const poolNeighbors = evaluatedNeighbors.slice(0, maxNeighborsAllowed);

  const includeSeasonal = bucket !== "year" && trainCount >= 18;
  const yTrainZ = originIndices.slice(0, trainCount).map((t) => yNorm(targetEntries[t + horizonSteps].value));

  const buildLocalFeatures = (t: number): number[] => {
    const y0 = yNorm(targetEntries[t].value);
    const y1 = yNorm(targetEntries[t - 1].value);
    const trendNorm = (t - originIndices[Math.floor(trainCount / 2)]) / Math.max(1, sampleCount);
    const base = [1, y0, y0 - y1, trendNorm];
    if (includeSeasonal) {
      const ang = seasonalAngle(targetEntries[t + horizonSteps]?.date ?? targetEntries[t].date, bucket);
      if (ang !== null) {
        base.push(Math.sin(ang), Math.cos(ang));
      } else {
        base.push(0, 0);
      }
    }
    return base;
  };

  const localXAll = originIndices.map((t) => buildLocalFeatures(t));

  // Inner-validation trust gate against noisy/harmful low-trust community edits (strictly `< trainCount`)
  const activeNeighbors: SelectedNeighbor[] = [];
  let trustGatedCount = 0;
  let communityNodesEvaluated = 0;
  for (const nb of poolNeighbors) {
    if (nb.cand.isCommunity) {
      communityNodesEvaluated++;
    }
    if (nb.cand.isCommunity && nb.cand.trustScore < 0.72 && !nb.cand.isCandidatePreview) {
      let rejectNoise = nb.cand.trustScore < 0.5 && Math.abs(nb.trainCorr) < 0.25;
      if (!rejectNoise && trainCount >= 12) {
        const innerValSize = Math.max(3, Math.floor(trainCount * 0.25));
        const innerTrainEnd = trainCount - innerValSize;
        if (innerTrainEnd >= 6) {
          const buildNbPair = (t: number) => {
            const raw = nb.cand.values[t - nb.offset];
            const z = raw !== null && Number.isFinite(raw) ? (raw - nb.mean) / nb.std : 0;
            const prevRaw = t - nb.offset - 1 >= 0 ? nb.cand.values[t - nb.offset - 1] : raw;
            const prevZ = prevRaw !== null && Number.isFinite(prevRaw) ? (prevRaw - nb.mean) / nb.std : z;
            return [z * nb.weightScale, (z - prevZ) * nb.weightScale];
          };
          const baseTrainX = localXAll.slice(0, trainCount);
          const withNbX = originIndices.slice(0, trainCount).map((t, i) => [...baseTrainX[i], ...buildNbPair(t)]);
          const wBase = fitRidgeRegression(baseTrainX.slice(0, innerTrainEnd), yTrainZ.slice(0, innerTrainEnd), Math.max(1.5, baseTrainX[0].length * 0.65));
          const wWith = fitRidgeRegression(withNbX.slice(0, innerTrainEnd), yTrainZ.slice(0, innerTrainEnd), Math.max(2.0, withNbX[0].length * 0.85));
          let sqBase = 0;
          let sqWith = 0;
          for (let i = innerTrainEnd; i < trainCount; i++) {
            const eb = dot(wBase, baseTrainX[i]) - yTrainZ[i];
            const ew = dot(wWith, withNbX[i]) - yTrainZ[i];
            sqBase += eb * eb;
            sqWith += ew * ew;
          }
          if (Math.sqrt(sqWith / innerValSize) > Math.sqrt(sqBase / innerValSize) * 1.005) {
            rejectNoise = true;
          }
        }
      }
      if (rejectNoise) {
        trustGatedCount++;
        store.updateNode?.(nb.cand.node.uuid, { community_lift_pct: -1 }, true);
        continue;
      }
    }
    activeNeighbors.push(nb);
    scalesUsedSet.add(nb.cand.sourceScale);
  }

  const buildGraphExtraFeatures = (t: number): number[] => {
    const extra: number[] = [];
    if (hasCausalImpulseFeature) {
      extra.push((rawImpulseSeries[t] - impMean) / impStd);
    }
    for (const cov of activeCovarStats) {
      const v = targetEntries[t].channels?.[cov.key];
      const z = typeof v === "number" && Number.isFinite(v) ? (v - cov.mean) / cov.std : 0;
      extra.push(Math.max(-4, Math.min(4, z)));
    }
    return extra;
  };

  const buildGraphFeatures = (t: number, localX: number[]): number[] => {
    const neighborFeats = activeNeighbors.map((nb) => {
      const raw = nb.cand.values[t - nb.offset];
      const z = raw !== null && Number.isFinite(raw) ? (raw - nb.mean) / nb.std : 0;
      const prevRaw = t - nb.offset - 1 >= 0 ? nb.cand.values[t - nb.offset - 1] : raw;
      const prevZ = prevRaw !== null && Number.isFinite(prevRaw) ? (prevRaw - nb.mean) / nb.std : z;
      return [z * nb.weightScale, (z - prevZ) * nb.weightScale];
    });
    return [...localX, ...neighborFeats.flat(), ...buildGraphExtraFeatures(t)];
  };

  const buildNonlinearGraphFeatures = (t: number, linearGraphX: number[]): number[] => {
    if (activeNeighbors.length === 0) return linearGraphX;
    const y0 = linearGraphX[1] ?? 0;
    const extraFeats = activeNeighbors.flatMap((nb, idx) => {
      const zScaled = linearGraphX[localXAll[0].length + idx * 2] ?? 0;
      const raw = nb.cand.values[t - nb.offset];
      const z = raw !== null && Number.isFinite(raw) ? (raw - nb.mean) / nb.std : 0;
      const interaction = Math.max(-4, Math.min(4, y0 * zScaled));
      const upperHinge = Math.max(0, z - 0.5) * nb.weightScale;
      const lowerHinge = Math.max(0, -0.5 - z) * nb.weightScale;
      return [interaction, upperHinge, lowerHinge];
    });
    return [...linearGraphX, ...extraFeats];
  };

  const linearXAll = originIndices.map((t, idx) => buildGraphFeatures(t, localXAll[idx]));
  const nonlinearXAll =
    activeNeighbors.length > 0 && trainCount >= 18
      ? originIndices.map((t, idx) => buildNonlinearGraphFeatures(t, linearXAll[idx]))
      : linearXAll;
  const yAllActual = originIndices.map((t) => targetEntries[t + horizonSteps].value);
  const yAllPersist = originIndices.map((t) => targetEntries[t].value);

  const lambdaSelf = Math.max(1.5, localXAll[0].length * 0.65);
  const selfWeights = fitRidgeRegression(localXAll.slice(0, trainCount), yTrainZ, lambdaSelf);

  // Tune Ridge lambda on a temporal tail inside the training split (never peeking at test!)
  const tuneAndFitRidgeWithVal = (
    xRows: number[][],
    fallbackLambda: number
  ): { weights: number[]; valRmse: number; innerWeights: number[] } => {
    let chosenLambda = fallbackLambda;
    let bestValRmse = Infinity;
    let bestInnerWeights: number[] = [];

    if (trainCount >= 16) {
      const innerValSize = Math.max(4, Math.floor(trainCount * 0.25));
      const innerTrainEnd = trainCount - innerValSize;
      if (innerTrainEnd >= 8) {
        let bestValErr = Infinity;
        for (const candLambda of [0.5, 1.5, 4.0, 9.0, 18.0]) {
          const w = fitRidgeRegression(
            xRows.slice(0, innerTrainEnd),
            yTrainZ.slice(0, innerTrainEnd),
            candLambda
          );
          let sq = 0;
          for (let i = innerTrainEnd; i < trainCount; i++) {
            const err = dot(w, xRows[i]) - yTrainZ[i];
            sq += err * err;
          }
          if (sq < bestValErr) {
            bestValErr = sq;
            chosenLambda = candLambda;
            bestInnerWeights = w;
          }
        }
        bestValRmse = Math.sqrt(bestValErr / innerValSize);
      }
    }
    const finalWeights = fitRidgeRegression(xRows.slice(0, trainCount), yTrainZ, chosenLambda);
    if (bestInnerWeights.length === 0) {
      bestInnerWeights = finalWeights;
    }
    return {
      weights: finalWeights,
      valRmse: bestValRmse,
      innerWeights: bestInnerWeights,
    };
  };

  const hasGraphFeatures =
    activeNeighbors.length > 0 || hasCausalImpulseFeature || activeCovarStats.length > 0;
  const linearFit = hasGraphFeatures
    ? tuneAndFitRidgeWithVal(linearXAll, Math.max(2.0, linearXAll[0].length * 0.85))
    : { weights: selfWeights, valRmse: Infinity, innerWeights: selfWeights };

  let activeGraphArchitecture: GraphPredictorModelKind = "linear_ridge";
  let nonlinFit = linearFit;

  if (activeNeighbors.length > 0 && trainCount >= 18) {
    nonlinFit = tuneAndFitRidgeWithVal(
      nonlinearXAll,
      Math.max(3.5, nonlinearXAll[0].length * 1.1)
    );
    const innerValSize = Math.max(4, Math.floor(trainCount * 0.25));
    const innerTrainEnd = trainCount - innerValSize;
    let ensValRmse = Infinity;
    if (innerTrainEnd >= 8) {
      let ensSq = 0;
      for (let i = innerTrainEnd; i < trainCount; i++) {
        const pLin = dot(linearFit.innerWeights, linearXAll[i]);
        const pNonlin = dot(nonlinFit.innerWeights, nonlinearXAll[i]);
        const err = 0.5 * (pLin + pNonlin) - yTrainZ[i];
        ensSq += err * err;
      }
      ensValRmse = Math.sqrt(ensSq / innerValSize);
    }

    if (
      ensValRmse < Math.min(linearFit.valRmse, nonlinFit.valRmse) * 0.99
    ) {
      activeGraphArchitecture = "stacked_ensemble";
    } else if (nonlinFit.valRmse < linearFit.valRmse * 0.985) {
      activeGraphArchitecture = "nonlinear_interaction";
    }
  }

  const predictGraphRow = (linearRow: number[], nonlinearRow: number[]): number => {
    if (!hasGraphFeatures) {
      return yUnnorm(dot(selfWeights, linearRow.slice(0, localXAll[0].length)));
    }
    if (activeGraphArchitecture === "nonlinear_interaction") {
      return yUnnorm(dot(nonlinFit.weights, nonlinearRow));
    }
    if (activeGraphArchitecture === "stacked_ensemble") {
      return yUnnorm(
        0.5 * dot(linearFit.weights, linearRow) +
          0.5 * dot(nonlinFit.weights, nonlinearRow)
      );
    }
    return yUnnorm(dot(linearFit.weights, linearRow));
  };

  const testActuals = yAllActual.slice(trainCount);
  const testPersist = yAllPersist.slice(trainCount);
  const testSelf = localXAll.slice(trainCount).map((x) => yUnnorm(dot(selfWeights, x)));
  const testLinearGraph = linearXAll
    .slice(trainCount)
    .map((x) => yUnnorm(dot(linearFit.weights, x)));
  let testGraph = linearXAll
    .slice(trainCount)
    .map((linRow, i) => predictGraphRow(linRow, nonlinearXAll[trainCount + i]));

  const persistTemp = computeEvalMetrics(testActuals, testPersist, 1);
  const persistRmse = Math.max(1e-9, persistTemp.rmse);
  const persistence = computeEvalMetrics(testActuals, testPersist, persistRmse);
  const selfOnly = computeEvalMetrics(testActuals, testSelf, persistRmse);
  const linearGraphMetrics = computeEvalMetrics(testActuals, testLinearGraph, persistRmse);
  let graphAware = computeEvalMetrics(testActuals, testGraph, persistRmse);

  // Next-step forecast from latest timestamp index `lastT = targetEntries.length - 1`
  const lastT = targetEntries.length - 1;
  const lastActual = targetEntries[lastT].value;
  const latestLocalX = [
    1,
    yNorm(targetEntries[lastT].value),
    yNorm(targetEntries[lastT].value) - yNorm(targetEntries[lastT - 1].value),
    (lastT - originIndices[Math.floor(trainCount / 2)]) / Math.max(1, sampleCount),
    ...(includeSeasonal
      ? (() => {
          const nextLbl = advanceDateLabel(targetEntries[lastT].date, bucket, horizonSteps);
          const ang = seasonalAngle(nextLbl, bucket);
          return ang !== null ? [Math.sin(ang), Math.cos(ang)] : [0, 0];
        })()
      : []),
  ];
  const latestLinearX = buildGraphFeatures(lastT, latestLocalX);
  const latestNonlinearX =
    activeNeighbors.length > 0 && trainCount >= 18
      ? buildNonlinearGraphFeatures(lastT, latestLinearX)
      : latestLinearX;
  const selfPredNext = yUnnorm(dot(selfWeights, latestLocalX));
  let graphPredNext = hasGraphFeatures
    ? predictGraphRow(latestLinearX, latestNonlinearX)
    : selfPredNext;

  // Optional portable inductive GNN v2 weights check (only when inner chronological validation is available)
  let usedLocalInductiveGnn = false;
  const localWeightsV2 = loadLocalInductiveWeightsV2();
  const activeInnerZ =
    Math.min(linearFit.valRmse, nonlinFit.valRmse) * yStd;
  if (
    localWeightsV2 &&
    store.exportMlGraphDatasetV2 &&
    activeNeighbors.length > 0 &&
    trainCount >= 16 &&
    Number.isFinite(activeInnerZ)
  ) {
    try {
      const mlV2 = store.exportMlGraphDatasetV2({
        rootUuid: targetNode.uuid,
        maxHops,
        bucket,
        horizonSteps,
      });
      const nodeIdx = mlV2.node_ids.indexOf(targetNode.uuid);
      if (nodeIdx >= 0 && mlV2.time_index.length >= 10) {
        const idxByDate = new Map(mlV2.time_index.map((d, i) => [d, i]));
        const innerValSize = Math.max(4, Math.floor(trainCount * 0.25));
        const valStart = Math.max(0, trainCount - innerValSize);
        let innerSqGnn = 0;
        let innerSqBlend = 0;
        let innerCount = 0;
        for (let i = valStart; i < trainCount; i++) {
          const tKey = targetEntries[originIndices[i]].date;
          const mlT = idxByDate.get(tKey);
          if (mlT === undefined) continue;
          const gnnPred = evalPortableInductiveV2ForNode(localWeightsV2, mlV2, nodeIdx, mlT);
          if (gnnPred !== null && Number.isFinite(gnnPred)) {
            const innerRidgePred =
              activeGraphArchitecture === "nonlinear_interaction"
                ? yUnnorm(dot(nonlinFit.innerWeights, nonlinearXAll[i]))
                : activeGraphArchitecture === "stacked_ensemble"
                  ? yUnnorm(
                      0.5 * dot(linearFit.innerWeights, linearXAll[i]) +
                        0.5 * dot(nonlinFit.innerWeights, nonlinearXAll[i])
                    )
                  : yUnnorm(dot(linearFit.innerWeights, linearXAll[i]));
            const err = gnnPred - yAllActual[i];
            const blendErr = 0.5 * gnnPred + 0.5 * innerRidgePred - yAllActual[i];
            innerSqGnn += err * err;
            innerSqBlend += blendErr * blendErr;
            innerCount++;
          }
        }
        const gnnInnerRmse = innerCount >= 3 ? Math.sqrt(innerSqGnn / innerCount) : Infinity;
        const blendInnerRmse = innerCount >= 3 ? Math.sqrt(innerSqBlend / innerCount) : Infinity;
        if (gnnInnerRmse < activeInnerZ * 0.99 && blendInnerRmse < activeInnerZ * 0.99) {
          const gnnNext = evalPortableInductiveV2ForNode(
            localWeightsV2,
            mlV2,
            nodeIdx,
            mlV2.time_index.length - 1
          );
          if (gnnNext !== null && Number.isFinite(gnnNext)) {
            const gnnTest = originIndices.slice(trainCount).map((origT, idx) => {
              const mlT = idxByDate.get(targetEntries[origT].date);
              const gp =
                mlT !== undefined
                  ? evalPortableInductiveV2ForNode(localWeightsV2, mlV2, nodeIdx, mlT)
                  : null;
              return gp !== null && Number.isFinite(gp) ? 0.5 * gp + 0.5 * testGraph[idx] : testGraph[idx];
            });
            testGraph = gnnTest;
            graphAware = computeEvalMetrics(testActuals, testGraph, persistRmse);
            graphPredNext = 0.5 * gnnNext + 0.5 * graphPredNext;
            usedLocalInductiveGnn = true;
          }
        }
      }
    } catch {
      // Fall back silently to Ridge/Ensemble fit
    }
  }

  const nonlinearSkillGainPct =
    activeNeighbors.length > 0 && linearGraphMetrics.rmse > 1e-9
      ? Number(
          (
            ((linearGraphMetrics.rmse - graphAware.rmse) /
              linearGraphMetrics.rmse) *
            100
          ).toFixed(2)
        )
      : 0;

  const skillLiftVsSelfPct =
    selfOnly.rmse > 1e-9
      ? Number((((selfOnly.rmse - graphAware.rmse) / selfOnly.rmse) * 100).toFixed(2))
      : 0;

  // Neighbor contribution attribution + leave-one-neighbor-out holdout ablation lift
  const localFeatureLen = localXAll[0].length;
  const linearBaseLen = linearXAll[0].length;
  const rawContribs = activeNeighbors.map((nb, idx) => {
    const activeW =
      activeGraphArchitecture === "nonlinear_interaction"
        ? nonlinFit.weights
        : linearFit.weights;
    const wLevel = activeW[localFeatureLen + idx * 2] ?? 0;
    const wDiff = activeW[localFeatureLen + idx * 2 + 1] ?? 0;
    const wInter =
      activeGraphArchitecture !== "linear_ridge"
        ? nonlinFit.weights[linearBaseLen + idx * 3] ?? 0
        : 0;
    const wHingeHi =
      activeGraphArchitecture !== "linear_ridge"
        ? nonlinFit.weights[linearBaseLen + idx * 3 + 1] ?? 0
        : 0;
    const wHingeLo =
      activeGraphArchitecture !== "linear_ridge"
        ? nonlinFit.weights[linearBaseLen + idx * 3 + 2] ?? 0
        : 0;
    const importance =
      Math.hypot(wLevel, wDiff, wInter, wHingeHi, wHingeLo) * nb.weightScale;

    let ablationLiftPct: number | undefined;
    if (testActuals.length >= 3) {
      let rmseWithout = selfOnly.rmse;
      if (activeNeighbors.length > 1) {
        const dropA = localFeatureLen + idx * 2;
        const dropB = dropA + 1;
        if (activeGraphArchitecture === "linear_ridge") {
          const keepCols = Array.from(
            { length: linearXAll[0].length },
            (_, col) => col
          ).filter((col) => col !== dropA && col !== dropB);
          const reducedX = linearXAll.map((row) => keepCols.map((c) => row[c]));
          const reducedFit = tuneAndFitRidgeWithVal(
            reducedX,
            Math.max(2.0, keepCols.length * 0.85)
          );
          const predWithout = reducedX
            .slice(trainCount)
            .map((x) => yUnnorm(dot(reducedFit.weights, x)));
          rmseWithout = computeEvalMetrics(testActuals, predWithout, persistRmse).rmse;
        } else {
          const nlBase = linearBaseLen + idx * 3;
          const dropSet = new Set([dropA, dropB, nlBase, nlBase + 1, nlBase + 2]);
          const keepCols = Array.from(
            { length: nonlinearXAll[0].length },
            (_, col) => col
          ).filter((col) => !dropSet.has(col));
          const reducedX = nonlinearXAll.map((row) => keepCols.map((c) => row[c]));
          const reducedFit = tuneAndFitRidgeWithVal(
            reducedX,
            Math.max(3.0, keepCols.length * 1.0)
          );
          const predWithout = reducedX
            .slice(trainCount)
            .map((x) => yUnnorm(dot(reducedFit.weights, x)));
          rmseWithout = computeEvalMetrics(testActuals, predWithout, persistRmse).rmse;
        }
      }
      ablationLiftPct =
        rmseWithout > 1e-9
          ? Number((((rmseWithout - graphAware.rmse) / rmseWithout) * 100).toFixed(2))
          : 0;

      const edgeUuid = nb.cand.edge?.properties.uuid;
      if (!nb.cand.isCandidatePreview && edgeUuid && store.updateEdge) {
        store.updateEdge(edgeUuid, { predictive_lift_pct: ablationLiftPct }, true);
      }
      if (nb.cand.isCommunity && !nb.cand.isCandidatePreview) {
        store.updateNode?.(nb.cand.node.uuid, { community_lift_pct: ablationLiftPct }, true);
      }
    }

    return { nb, wLevel, importance, ablationLiftPct };
  });
  const totalImp = rawContribs.reduce((s, c) => s + c.importance, 0);

  const neighborContributions: GraphNeighborContribution[] = rawContribs
    .map((c) => ({
      nodeUuid: c.nb.cand.node.uuid,
      nodeName: c.nb.cand.node.properties.name,
      edgeUuid: c.nb.cand.edge?.properties.uuid,
      edgeType: c.nb.cand.edgeType,
      lagSteps: c.nb.offset + horizonSteps,
      correlationR: Number(c.nb.trainCorr.toFixed(3)),
      standardizedWeight: Number((c.wLevel * c.nb.weightScale).toFixed(3)),
      sharePct:
        totalImp > 1e-9
          ? Number(((c.importance / totalImp) * 100).toFixed(1))
          : Number((100 / Math.max(1, rawContribs.length)).toFixed(1)),
      ablationLiftPct: c.ablationLiftPct,
      isCandidatePreview: c.nb.cand.isCandidatePreview || undefined,
    }))
    .sort((a, b) => b.sharePct - a.sharePct);

  // Compute leave-all-community-out Marginal Community Lift when community nodes are evaluated
  let communityImpact: CommunityImpactSummary | undefined;
  if (communityNodesEvaluated > 0) {
    const activeCommIndices = activeNeighbors
      .map((nb, i) => (nb.cand.isCommunity ? i : -1))
      .filter((i) => i >= 0);

    let marginalCommunityLiftPct = 0;
    if (activeCommIndices.length > 0 && testActuals.length >= 3) {
      let rmseNoComm = selfOnly.rmse;
      if (activeCommIndices.length < activeNeighbors.length) {
        const dropSet = new Set<number>();
        for (const ci of activeCommIndices) {
          dropSet.add(localFeatureLen + ci * 2);
          dropSet.add(localFeatureLen + ci * 2 + 1);
          if (activeGraphArchitecture !== "linear_ridge") {
            dropSet.add(linearBaseLen + ci * 3);
            dropSet.add(linearBaseLen + ci * 3 + 1);
            dropSet.add(linearBaseLen + ci * 3 + 2);
          }
        }
        const sourceX =
          activeGraphArchitecture === "linear_ridge" ? linearXAll : nonlinearXAll;
        const keepCols = Array.from({ length: sourceX[0].length }, (_, col) => col).filter(
          (col) => !dropSet.has(col)
        );
        const reducedX = sourceX.map((row) => keepCols.map((c) => row[c]));
        const reducedFit = tuneAndFitRidgeWithVal(
          reducedX,
          Math.max(2.0, keepCols.length * 0.85)
        );
        const predNoComm = reducedX
          .slice(trainCount)
          .map((x) => yUnnorm(dot(reducedFit.weights, x)));
        rmseNoComm = computeEvalMetrics(testActuals, predNoComm, persistRmse).rmse;
      }
      if (rmseNoComm > 1e-9) {
        marginalCommunityLiftPct = Number(
          (((rmseNoComm - graphAware.rmse) / rmseNoComm) * 100).toFixed(2)
        );
      }
    }

    const topContributors = rawContribs
      .filter((c) => c.nb.cand.isCommunity)
      .map((c) => ({
        uuid: c.nb.cand.node.uuid,
        name: c.nb.cand.node.properties.name,
        liftPct: c.ablationLiftPct ?? 0,
        trustScore: c.nb.cand.trustScore,
      }))
      .sort((a, b) => b.liftPct - a.liftPct)
      .slice(0, 5);

    communityImpact = {
      communityNodesEvaluated,
      communityNodesActive: activeCommIndices.length,
      trustGatedCount,
      marginalCommunityLiftPct,
      topContributors,
    };
  }

  // Honest out-of-sample model selection & overfit guardrail
  let recommendedModel: GraphPredictionResult["recommendedModel"] = "graph_aware";
  let recommendedForecastValue = graphPredNext;
  if (!hasGraphFeatures || graphAware.rmse > Math.min(selfOnly.rmse, persistence.rmse) + 1e-9) {
    if (selfOnly.rmse <= persistence.rmse + 1e-9) {
      recommendedModel = "self_ar";
      recommendedForecastValue = selfPredNext;
    } else {
      recommendedModel = "persistence";
      recommendedForecastValue = lastActual;
    }
  }

  const engineUsed: GraphPredictionEngineUsed = usedLocalInductiveGnn
    ? "local_inductive_gnn"
    : recommendedModel === "graph_aware"
      ? activeGraphArchitecture
      : recommendedModel;

  const warnings: string[] = [];
  if (testActuals.length < 8) {
    warnings.push(`Small holdout window (n=${testActuals.length} steps); interpret skill percentages cautiously.`);
  }
  if (activeNeighbors.length > 0 && recommendedModel !== "graph_aware") {
    const winnerLabel = recommendedModel === "self_ar" ? "Self-AR" : "Persistence";
    warnings.push(
      `Connected neighbors did not beat ${winnerLabel} out-of-sample (${skillLiftVsSelfPct >= 0 ? "+" : ""}${skillLiftVsSelfPct.toFixed(1)}% vs Self-AR). Prune negative-lift edges to reduce overfitting.`
    );
  }
  if (trustGatedCount > 0) {
    warnings.push(
      `Trust gate filtered ${trustGatedCount} noisy/uncorroborated community contributor(s) from the fit.`
    );
  }
  const reliabilityWarning = warnings.length > 0 ? warnings.join(" ") : undefined;

  const backtest = testActuals.slice(-36).map((act, i) => {
    const startOffset = Math.max(0, testActuals.length - 36);
    const idx = startOffset + i;
    const originIdx = trainCount + idx;
    const targetEntryIdx = originIndices[originIdx] + horizonSteps;
    return {
      date: targetEntries[targetEntryIdx]?.date ?? String(idx),
      actual: Number(act.toFixed(3)),
      persistence: Number(testPersist[idx].toFixed(3)),
      selfOnly: Number(testSelf[idx].toFixed(3)),
      graphAware: Number(testGraph[idx].toFixed(3)),
    };
  });

  const nextPeriodLabel = advanceDateLabel(targetEntries[lastT].date, bucket, horizonSteps);
  const unit = targetNode.properties.unit || "units";

  // Empirical residual conformal interval combined with Gaussian 1.96*RMSE for honest uncertainty
  const winningPreds =
    recommendedModel === "graph_aware"
      ? testGraph
      : recommendedModel === "self_ar"
        ? testSelf
        : testPersist;
  const winningRmse =
    recommendedModel === "graph_aware"
      ? graphAware.rmse
      : recommendedModel === "self_ar"
        ? selfOnly.rmse
        : persistence.rmse;
  const signedResiduals = testActuals.map((act, idx) => act - (winningPreds[idx] ?? act));
  const absResiduals = signedResiduals.map((r) => Math.abs(r)).sort((a, b) => a - b);
  const q95Idx = Math.min(
    Math.max(0, absResiduals.length - 1),
    Math.max(0, Math.ceil(0.95 * absResiduals.length) - 1)
  );
  const empiricalQ95 = absResiduals.length >= 6 ? absResiduals[q95Idx] : 0;
  const ci95HalfWidth = Number(
    Math.max(1.96 * winningRmse, empiricalQ95).toFixed(3)
  );

  const recentTail = targetEntries.slice(Math.max(0, lastT - 3), lastT + 1);
  const rollingMean4 =
    recentTail.reduce((s, p) => s + p.value, 0) / Math.max(1, recentTail.length);
  const { quantiles, trendForecast } = buildQuantilesAndTrendForecast({
    recommendedForecastValue,
    lastActual,
    horizonSteps,
    winningRmse,
    yStd,
    rollingMean4,
    signedResiduals,
  });

  const archLabel = usedLocalInductiveGnn
    ? "Local Inductive GNN + Ensemble"
    : activeGraphArchitecture === "stacked_ensemble"
      ? "Stacked Interaction+Linear Ensemble"
      : activeGraphArchitecture === "nonlinear_interaction"
        ? "Nonlinear Interaction+Hinge Ridge"
        : "Graph-Aware Ridge";

  const summary =
    activeNeighbors.length === 0 && !hasCausalImpulseFeature
      ? `No overlapping upstream/connected time-series neighbors were available for "${targetNode.properties.name}". Running Self-Only AR baseline (${selfOnly.rmse.toFixed(3)} ${unit} RMSE). Connect overlapping drivers to unlock graph lift.`
      : skillLiftVsSelfPct > 0
        ? `${archLabel} reading ${activeNeighbors.length} ETG neighbor(s) reduced unseen ${testCount}-step RMSE by ${skillLiftVsSelfPct.toFixed(1)}% (${selfOnly.rmse.toFixed(3)} → ${graphAware.rmse.toFixed(3)} ${unit}) and achieved ${graphAware.skillVsPersistencePct.toFixed(1)}% skill over persistence.`
        : `Evaluated ${activeNeighbors.length} connected ETG neighbor(s) with ${archLabel} on ${testCount} unseen ${bucket} steps (Graph RMSE ${graphAware.rmse.toFixed(3)} vs Self RMSE ${selfOnly.rmse.toFixed(3)} ${unit}). Connect stronger lead-lag drivers or discover candidate links to raise skill.`;

  return {
    targetUuid: targetNode.uuid,
    targetName: targetNode.properties.name,
    unit,
    bucket,
    sampleCount,
    trainCount,
    testCount,
    horizonSteps,
    persistence,
    selfOnly,
    graphAware,
    skillLiftVsSelfPct,
    recommendedModel,
    activeGraphArchitecture:
      activeNeighbors.length > 0 ? activeGraphArchitecture : undefined,
    engineUsed,
    nonlinearSkillGainPct:
      activeNeighbors.length > 0 ? nonlinearSkillGainPct : undefined,
    recommendedForecastValue: Number(recommendedForecastValue.toFixed(3)),
    quantiles,
    scalesUsed: Array.from(scalesUsedSet),
    trendForecast,
    ...(communityImpact ? { communityImpact } : {}),
    reliabilityWarning,
    nextForecast: {
      nextPeriodLabel,
      lastActual: Number(lastActual.toFixed(3)),
      persistencePred: Number(lastActual.toFixed(3)),
      selfOnlyPred: Number(selfPredNext.toFixed(3)),
      graphAwarePred: Number(graphPredNext.toFixed(3)),
      ci95HalfWidth,
    },
    backtest,
    neighborContributions,
    summary,
  };
}

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
