import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeDataDir } from "@/lib/runtimePaths";
import type { TemporalBucket } from "@/lib/graph/etgStore";
import { fitRidgeRegression } from "@/lib/solar/denverClimateGraph";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  GraphMlDatasetExport,
  GraphMlDatasetExportV2,
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
    trainCutoffDate?: string;
    horizonSteps?: number;
  }) => GraphMlDatasetExportV2;
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

export function pearsonTrain(a: readonly number[], b: readonly number[]): number {
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

export function dot(weights: readonly number[], x: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i] * x[i];
  }
  return sum;
}

export function computeEvalMetrics(
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

export function advanceDateLabel(lastDate: string, bucket: TemporalBucket, steps = 1): string {
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

export function seasonalAngle(dateKey: string, bucket: TemporalBucket): number | null {
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

export function parseDateKeyMs(raw: string): number | null {
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

export function previousCoarsePeriodKey(
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

function fitAnchoredRidge(
  xRows: number[][],
  yTargets: number[],
  lambda: number,
  anchorPrior: 0 | 1
): number[] {
  if (anchorPrior === 1 && (xRows[0]?.length ?? 0) > 1) {
    const deltaTargets = yTargets.map((y, i) => y - (xRows[i][1] ?? 0));
    const weights = fitRidgeRegression(xRows, deltaTargets, lambda).slice();
    weights[1] = (weights[1] ?? 0) + 1;
    return weights;
  }
  return fitRidgeRegression(xRows, yTargets, lambda);
}

export function tuneAndFitRidgeWithVal(
  xRows: number[][],
  yTrainZ: number[],
  trainCount: number,
  fallbackLambda: number
): { weights: number[]; valRmse: number; innerWeights: number[] } {
  let chosenLambda = fallbackLambda;
  let chosenAnchor: 0 | 1 = 0;
  let bestValRmse = Infinity;
  let bestInnerWeights: number[] = [];

  if (trainCount >= 12) {
    const innerValSize = Math.max(3, Math.floor(trainCount * 0.25));
    const innerTrainEnd = trainCount - innerValSize;
    if (innerTrainEnd >= 6) {
      let bestValErr = Infinity;
      const innerX = xRows.slice(0, innerTrainEnd);
      const innerY = yTrainZ.slice(0, innerTrainEnd);
      for (const anchorPrior of [0, 1] as const) {
        let anchorBestErr = Infinity;
        let anchorBestLambda = fallbackLambda;
        let anchorBestWeights: number[] = [];
        for (const candLambda of [0.5, 1.5, 4.0, 9.0, 18.0]) {
          const w = fitAnchoredRidge(innerX, innerY, candLambda, anchorPrior);
          let sq = 0;
          for (let i = innerTrainEnd; i < trainCount; i++) {
            const err = dot(w, xRows[i]) - yTrainZ[i];
            sq += err * err;
          }
          if (sq < anchorBestErr) {
            anchorBestErr = sq;
            anchorBestLambda = candLambda;
            anchorBestWeights = w;
          }
        }
        // Require >= 1% chronological validation MSE reduction to adopt the Delta-Anchored prior
        // so stationary oscillating indices keep Level-Ridge while trending series avoid shrinkage bias.
        const improvesEnough =
          anchorPrior === 0 ? anchorBestErr < bestValErr : anchorBestErr < bestValErr * 0.99;
        if (improvesEnough) {
          bestValErr = anchorBestErr;
          chosenLambda = anchorBestLambda;
          chosenAnchor = anchorPrior;
          bestInnerWeights = anchorBestWeights;
        }
      }
      bestValRmse = Math.sqrt(bestValErr / innerValSize);
    }
  }
  const finalWeights = fitAnchoredRidge(
    xRows.slice(0, trainCount),
    yTrainZ,
    chosenLambda,
    chosenAnchor
  );
  if (bestInnerWeights.length === 0) {
    bestInnerWeights = finalWeights;
  }
  return {
    weights: finalWeights,
    valRmse: bestValRmse,
    innerWeights: bestInnerWeights,
  };
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
    const runtimeOverrideCandidates = Array.from(
      new Set([
        path.join(resolveRuntimeDataDir(), "etg-inductive-weights-v2.json"),
        path.join(process.cwd(), ".data", "etg-inductive-weights-v2.json"),
      ])
    );
    for (const dataPath of runtimeOverrideCandidates) {
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

export function evalPortableInductiveV2ForNode(
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

export function buildQuantilesAndTrendForecast(args: {
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
