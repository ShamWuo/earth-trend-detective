import fs from "node:fs";
import path from "node:path";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  GraphMlDatasetExportV2,
  LinkTrendMicroscopeCue,
  NodeTrendMicroscopeCue,
  TimeSeriesPoint,
  TrendMicroscopeRadarBadge,
  TrendMicroscopeScanResult,
} from "@/types/etg";
import {
  alignCompatibleSeries,
  computeEtgNodeTrustScore,
  inferNodeTemporalScale,
  isCommunityContributorNode,
  type TemporalBucket,
} from "@/lib/graph/store/etgSeriesAndTrustUtils";
import { fetchRegionalMultiScaleSeries } from "@/lib/nasa/nasaPowerClient";

export interface LinearLayerWeights {
  weight: number[][];
  bias: number[];
}

export interface PortableTrendMicroscopeWeightsV1 {
  schema_version: "etg-trend-microscope-v1";
  hidden_dim: number;
  trust_gate: {
    w_trust: number;
    w_corroborated: number;
    w_community: number;
    bias: number;
  };
  node_enc1: LinearLayerWeights;
  edge_enc1: LinearLayerWeights;
  edge_attn: LinearLayerWeights;
  node_enc2: LinearLayerWeights;
  inflection_head: LinearLayerWeights;
  dealias_head: LinearLayerWeights;
  coupling_head: LinearLayerWeights;
}

export interface TrendMicroscopeStoreLike {
  getSnapshot: () => { nodes: ETGNode[]; edges: ETGEdge[] };
  getNode: (uuid: string) => ETGNode | undefined;
  getNodeSeries: (uuid: string) => TimeSeriesPoint[] | undefined;
  computeNodeTrustScore?: (node: ETGNode) => number;
  traverseSubgraph: (options: {
    rootUuid: string;
    maxHops?: number;
    direction?: "upstream" | "downstream" | "both";
  }) => { nodes: ETGNode[]; edges: ETGEdge[] };
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
  };
  exportMlGraphDatasetV2?: (options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
    horizonSteps?: number;
  }) => GraphMlDatasetExportV2;
}

export interface TrendMicroscopeScanOptions {
  focusNodeUuid?: string;
  lat?: number;
  lng?: number;
  dataset?: ETGDatasetId;
  maxHops?: number;
  topK?: number;
  extraSeries?: {
    uuid: string;
    name: string;
    lat: number;
    lng: number;
    dataset?: ETGDatasetId;
    series: TimeSeriesPoint[];
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round6(v: number): number {
  return Number(v.toFixed(6));
}

function round4(v: number): number {
  return Number(v.toFixed(4));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-Math.min(50, x));
    return 1 / (1 + z);
  }
  const z = Math.exp(Math.max(-50, x));
  return z / (1 + z);
}

function softplus(x: number): number {
  if (x > 25) return x;
  if (x < -25) return Math.exp(x);
  return Math.log1p(Math.exp(x));
}

function softmax(logits: readonly number[]): number[] {
  if (logits.length === 0) return [];
  let m = logits[0];
  for (let i = 1; i < logits.length; i++) {
    if (logits[i] > m) m = logits[i];
  }
  const exps = logits.map((v) => Math.exp(Math.max(-40, v - m)));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

function haversineKmLocal(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371;
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = (lat2 - lat1) * rad;
  const dl = (lng2 - lng1) * rad;
  const a =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function popStd(vals: readonly number[]): number {
  const n = vals.length;
  if (n < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = vals[i] - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / n);
}

function olsSlope(vals: readonly number[]): number {
  const n = vals.length;
  if (n < 2) return 0;
  const mk = (n - 1) * 0.5;
  const my = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    const dk = k - mk;
    num += dk * (vals[k] - my);
    den += dk * dk;
  }
  return den > 1e-12 ? num / den : 0;
}

function olsLine(vals: readonly number[]): { slope: number; intercept: number } {
  const n = vals.length;
  if (n < 2) return { slope: 0, intercept: vals[0] ?? 0 };
  const mk = (n - 1) * 0.5;
  const my = vals.reduce((a, b) => a + b, 0) / n;
  const slope = olsSlope(vals);
  return { slope, intercept: my - slope * mk };
}

function solveLinearSystem(a: number[][], b: number[]): number[] {
  const n = b.length;
  const mat = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(mat[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(mat[r][col]) > best) {
        best = Math.abs(mat[r][col]);
        piv = r;
      }
    }
    if (piv !== col) {
      const tmp = mat[col];
      mat[col] = mat[piv];
      mat[piv] = tmp;
    }
    let diag = mat[col][col];
    if (Math.abs(diag) < 1e-12) diag = diag >= 0 ? 1e-12 : -1e-12;
    for (let c = col; c <= n; c++) mat[col][c] /= diag;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = mat[r][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let c = col; c <= n; c++) mat[r][c] -= factor * mat[col][c];
    }
  }
  return mat.map((row) => row[n]);
}

function fitRidgeBasis(design: number[][], y: readonly number[], ridge = 1e-5): number[] {
  const n = design.length;
  if (n === 0) return [];
  const p = design[0].length;
  const xtx = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (__, j) => (i === j ? ridge : 0))
  );
  const xty = new Array<number>(p).fill(0);
  for (let k = 0; k < n; k++) {
    const row = design[k];
    const target = y[k];
    for (let i = 0; i < p; i++) {
      xty[i] += row[i] * target;
      const ri = row[i];
      for (let j = 0; j < p; j++) {
        xtx[i][j] += ri * row[j];
      }
    }
  }
  return solveLinearSystem(xtx, xty);
}

function fitHarmonicR2(vals: readonly number[], period: number): { comp: number[]; r2: number } {
  const n = vals.length;
  if (n < 6 || period <= 1) {
    return { comp: new Array<number>(n).fill(0), r2: 0 };
  }
  const twoPiP = (2 * Math.PI) / period;
  const design = Array.from({ length: n }, (_, k) => [1, Math.sin(twoPiP * k), Math.cos(twoPiP * k)]);
  const beta = fitRidgeBasis(design, vals, 1e-5);
  const comp = design.map((row) => beta[1] * row[1] + beta[2] * row[2]);
  const meanV = vals.reduce((a, b) => a + b, 0) / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let k = 0; k < n; k++) {
    ssTot += (vals[k] - meanV) * (vals[k] - meanV);
    const err = vals[k] - (beta[0] + comp[k]);
    ssRes += err * err;
  }
  const r2 = ssTot <= 1e-8 ? 0 : clamp(1 - ssRes / ssTot, 0, 1);
  return { comp, r2 };
}

function mannKendallAbsZ(vals: readonly number[]): number {
  const n = vals.length;
  if (n < 4) return 0;
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    const vi = vals[i];
    for (let j = i + 1; j < n; j++) {
      const diff = vals[j] - vi;
      if (diff > 1e-12) s += 1;
      else if (diff < -1e-12) s -= 1;
    }
  }
  if (s === 0) return 0;
  const sortedV = [...vals].sort((a, b) => a - b);
  const tieCounts: number[] = [];
  let run = 1;
  for (let i = 1; i < n; i++) {
    if (Math.abs(sortedV[i] - sortedV[i - 1]) <= 1e-12) {
      run += 1;
    } else {
      if (run > 1) tieCounts.push(run);
      run = 1;
    }
  }
  if (run > 1) tieCounts.push(run);
  const tieSum = tieCounts.reduce((acc, tp) => acc + tp * (tp - 1) * (2 * tp + 5), 0);
  const varS = Math.max(1e-9, (n * (n - 1) * (2 * n + 5) - tieSum) / 18);
  return (Math.abs(s) - 1) / Math.sqrt(varS);
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx;
    const ay = ys[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  const den = Math.sqrt(dx * dy);
  return den <= 1e-9 ? 0 : clamp(num / den, -1, 1);
}

function lagCorr(a: readonly number[], b: readonly number[], tau: number): number {
  const m = a.length;
  if (tau < 0 || m - tau < 4) return 0;
  return pearson(a.slice(0, m - tau), b.slice(tau));
}

/**
 * Exact 20-dim causal node feature vector matching `ml/etg_trend_microscope.py`.
 */
export function extractNodeMicroscopeFeatures(
  values: readonly number[],
  options: {
    scale?: "day" | "month" | "year" | "impulse";
    lat?: number;
    lng?: number;
    trustScore?: number;
    isCommunity?: boolean;
    corroborated?: boolean;
    fullLen?: number;
  } = {}
): number[] {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  const scale = options.scale ?? "month";
  const totalLen = options.fullLen ?? clean.length;
  const rad = Math.PI / 180;
  const latR = (options.lat ?? 0) * rad;
  const lngR = (options.lng ?? 0) * rad;
  const latSin = Math.sin(latR);
  const latCos = Math.cos(latR);
  const lngSin = Math.sin(lngR);
  const lngCos = Math.cos(lngR);
  const trust = clamp(options.trustScore ?? 0.8, 0.05, 1.0);
  const isCommF = options.isCommunity ? 1.0 : 0.0;
  const corrF = options.corroborated ? 1.0 : 0.0;
  const logLen = clamp(Math.log(Math.max(2, totalLen)) / Math.log(120), 0, 1);

  if (clean.length < 2) {
    return [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      latSin, latCos, lngSin, lngCos, trust, isCommF, corrF, logLen,
    ];
  }

  const window = clean.slice(-24);
  const L = window.length;
  const halfN = Math.min(L, Math.max(3, Math.floor(L / 2)));
  const base = window.slice(0, halfN);
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const std = Math.max(1e-4, popStd(base), 0.35 * popStd(window));
  const z = window.map((v) => clamp((v - mean) / std, -10, 10));

  const pSeas = scale === "month" ? 12 : scale === "day" ? 7 : null;
  let seasR2 = 0;
  let zDeseason: number[];
  if (pSeas !== null && L >= 6) {
    const fitted = fitHarmonicR2(z, pSeas);
    seasR2 = fitted.r2;
    zDeseason = z.map((zk, k) => zk - fitted.comp[k]);
  } else {
    zDeseason = [...z];
  }

  const oscTail = clean.slice(-48);
  const LOsc = oscTail.length;
  let zTailResid: number[];
  if (LOsc >= 10) {
    const mTail = oscTail.reduce((a, b) => a + b, 0) / LOsc;
    const sTail = Math.max(1e-4, popStd(oscTail));
    const zTail = oscTail.map((v) => (v - mTail) / sTail);
    let zTailDes: number[];
    if (pSeas !== null && LOsc >= 6) {
      const seasT = fitHarmonicR2(zTail, pSeas);
      zTailDes = zTail.map((zk, k) => zk - seasT.comp[k]);
    } else {
      zTailDes = zTail;
    }
    const { slope: slT, intercept: icT } = olsLine(zTailDes);
    zTailResid = zTailDes.map((zk, k) => zk - (icT + slT * k));
  } else {
    zTailResid = [];
  }

  const oscPeriods =
    scale === "month" ? [24, 30, 36, 42] : scale === "day" ? [30, 60, 90] : scale === "year" ? [4, 7, 11] : [];
  let oscR2 = 0;
  if (zTailResid.length >= 10 && oscPeriods.length > 0) {
    for (const pOsc of oscPeriods) {
      const { r2 } = fitHarmonicR2(zTailResid, pOsc);
      if (r2 > oscR2) oscR2 = r2;
    }
  }

  const recStart = Math.max(0, L - 6);
  const priorEnd = Math.min(L, Math.max(3, L - 6));
  const recentSlice = z.slice(recStart);
  const priorSlice = z.slice(0, priorEnd);

  const recentSlope6 = clamp(olsSlope(recentSlice), -2, 2);
  const priorSlopePrev = clamp(olsSlope(priorSlice), -2, 2);
  const slopeDelta = clamp(recentSlope6 - priorSlopePrev, -3, 3);

  let curvatureQuad = 0;
  if (L >= 3) {
    const t1 = Math.max(1, Math.floor(L / 3));
    const t2 = Math.min(L - 1, Math.max(t1 + 1, Math.floor((2 * L) / 3)));
    const m1 = z.slice(0, t1).reduce((a, b) => a + b, 0) / t1;
    const m2 = z.slice(t1, t2).reduce((a, b) => a + b, 0) / Math.max(1, t2 - t1);
    const m3 = z.slice(t2).reduce((a, b) => a + b, 0) / Math.max(1, L - t2);
    curvatureQuad = clamp(m3 - 2 * m2 + m1, -3, 3);
  }

  const mz = z.reduce((a, b) => a + b, 0) / L;
  let acc = 0;
  let maxCusum = 0;
  for (let k = 0; k < L; k++) {
    acc += z[k] - mz;
    if (Math.abs(acc) > maxCusum) maxCusum = Math.abs(acc);
  }
  const cusumMaxNorm = clamp(maxCusum / Math.sqrt(L), 0, 4);

  const varianceRatio = clamp(popStd(recentSlice) / Math.max(0.05, popStd(priorSlice)) - 1, -1, 3);
  const lag1Autocorr = L >= 4 ? pearson(z.slice(0, -1), z.slice(1)) : 0;
  const seasonalPowerShare = clamp(seasR2, 0, 1);
  const oscillationPowerShare = clamp(oscR2, 0, 1);

  let maxStep = 0;
  for (let k = 1; k < L; k++) {
    const diff = Math.abs(z[k] - z[k - 1]);
    if (diff > maxStep) maxStep = diff;
  }
  const stepJumpMaxRatio = clamp(maxStep / Math.max(0.1, popStd(z)) / 4, 0, 2);
  const mkZWindow = clamp(mannKendallAbsZ(window) / 4, 0, 2);
  const deseasonRecentSlope6 = clamp(olsSlope(zDeseason.slice(recStart)), -2, 2);

  return [
    round6(recentSlope6),
    round6(priorSlopePrev),
    round6(slopeDelta),
    round6(curvatureQuad),
    round6(cusumMaxNorm),
    round6(varianceRatio),
    round6(lag1Autocorr),
    round6(seasonalPowerShare),
    round6(oscillationPowerShare),
    round6(stepJumpMaxRatio),
    round6(mkZWindow),
    round6(deseasonRecentSlope6),
    round6(latSin),
    round6(latCos),
    round6(lngSin),
    round6(lngCos),
    round6(trust),
    isCommF,
    corrF,
    round6(logLen),
  ];
}

function stripLinearAndSeason(vals: readonly number[], scale: string): number[] {
  const n = vals.length;
  if (n < 4) return [...vals];
  const p = scale === "month" ? 12 : scale === "day" ? 7 : null;
  const design: number[][] = [];
  if (p !== null && n >= 6) {
    const twoPiP = (2 * Math.PI) / p;
    for (let k = 0; k < n; k++) {
      design.push([1, k / Math.max(1, n - 1), Math.sin(twoPiP * k), Math.cos(twoPiP * k)]);
    }
  } else {
    for (let k = 0; k < n; k++) {
      design.push([1, k / Math.max(1, n - 1)]);
    }
  }
  const beta = fitRidgeBasis(design, vals, 1e-5);
  return vals.map((v, k) => v - design[k].reduce((s, dVal, dIdx) => s + beta[dIdx] * dVal, 0));
}

/**
 * Exact 12-dim causal directed pair feature vector matching `ml/etg_trend_microscope.py`.
 */
export function extractPairMicroscopeFeatures(
  uValues: readonly number[],
  vValues: readonly number[],
  options: {
    uLat?: number;
    uLng?: number;
    vLat?: number;
    vLng?: number;
    uTrust?: number;
    vTrust?: number;
    scale?: "day" | "month" | "year" | "impulse";
  } = {}
): number[] {
  const pairs: Array<[number, number]> = [];
  const lim = Math.min(uValues.length, vValues.length);
  for (let i = 0; i < lim; i++) {
    const u = uValues[i];
    const v = vValues[i];
    if (Number.isFinite(u) && Number.isFinite(v)) pairs.push([u, v]);
  }
  const distNorm = Math.min(
    1,
    haversineKmLocal(options.uLat ?? 0, options.uLng ?? 0, options.vLat ?? 0, options.vLng ?? 0) / 20000
  );
  const trustProd = clamp((options.uTrust ?? 0.8) * (options.vTrust ?? 0.8), 0.01, 1.0);

  if (pairs.length < 6) {
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, round6(distNorm), round6(trustProd)];
  }

  const win = pairs.slice(-36);
  const uArr = win.map((p) => p[0]);
  const vArr = win.map((p) => p[1]);
  const mu = uArr.reduce((a, b) => a + b, 0) / uArr.length;
  const mv = vArr.reduce((a, b) => a + b, 0) / vArr.length;
  const su = Math.max(1e-4, popStd(uArr));
  const sv = Math.max(1e-4, popStd(vArr));
  const zu = uArr.map((x) => clamp((x - mu) / su, -6, 6));
  const zv = vArr.map((x) => clamp((x - mv) / sv, -6, 6));

  const scale = options.scale ?? "month";
  const ru = stripLinearAndSeason(zu, scale);
  const rv = stripLinearAndSeason(zv, scale);

  const rawCorrs = [0, 1, 2, 3].map((tau) => lagCorr(zu, zv, tau));
  const cleanCorrs = [0, 1, 2, 3].map((tau) => lagCorr(ru, rv, tau));

  let bestTau = 0;
  let bestAbs = -1;
  for (let tau = 0; tau <= 5; tau++) {
    const val = Math.abs(lagCorr(ru, rv, tau));
    if (val > bestAbs + 1e-9) {
      bestAbs = val;
      bestTau = tau;
    }
  }

  let fwdPos = 0;
  let revPos = 0;
  for (let tau = 1; tau <= 5; tau++) {
    fwdPos = Math.max(fwdPos, Math.abs(lagCorr(ru, rv, tau)));
    revPos = Math.max(revPos, Math.abs(lagCorr(rv, ru, tau)));
  }
  const asym = clamp(fwdPos - revPos, -1, 1);

  return [
    ...rawCorrs.map(round6),
    ...cleanCorrs.map(round6),
    round6(asym),
    round6(bestTau / 5),
    round6(distNorm),
    round6(trustProd),
  ];
}

let cachedMicroscopeWeights: {
  filePath: string;
  mtimeMs: number;
  weights: PortableTrendMicroscopeWeightsV1;
} | null = null;

function parseMicroscopeWeightsV1(
  filePath: string,
  mtimeMs: number,
  raw: string
): PortableTrendMicroscopeWeightsV1 | null {
  const parsed = JSON.parse(raw) as PortableTrendMicroscopeWeightsV1;
  if (
    parsed?.schema_version === "etg-trend-microscope-v1" &&
    parsed.node_enc1?.weight &&
    parsed.edge_enc1?.weight &&
    parsed.inflection_head?.weight &&
    parsed.dealias_head?.weight &&
    parsed.coupling_head?.weight
  ) {
    cachedMicroscopeWeights = { filePath, mtimeMs, weights: parsed };
    return parsed;
  }
  return null;
}

/**
 * Loads portable `etg-trend-microscope-v1` weights from `.data/` first and
 * falls back automatically to tracked `ml/weights/etg-trend-microscope-v1.json`
 * on fresh clones or cold deployments.
 */
export function loadLocalTrendMicroscopeWeights(options?: {
  rootDir?: string;
}): PortableTrendMicroscopeWeightsV1 | null {
  if (!options?.rootDir) {
    const dataPath = path.join(process.cwd(), ".data", "etg-trend-microscope-v1.json");
    try {
      if (fs.existsSync(dataPath)) {
        const stat = fs.statSync(dataPath);
        if (
          cachedMicroscopeWeights?.filePath === dataPath &&
          cachedMicroscopeWeights.mtimeMs === stat.mtimeMs
        ) {
          return cachedMicroscopeWeights.weights;
        }
        const hit = parseMicroscopeWeightsV1(dataPath, stat.mtimeMs, fs.readFileSync(dataPath, "utf8"));
        if (hit) return hit;
      }
    } catch {
      // Fall through to tracked weights bundle
    }

    const trackedPath = path.join(process.cwd(), "ml", "weights", "etg-trend-microscope-v1.json");
    try {
      if (fs.existsSync(trackedPath)) {
        const stat = fs.statSync(trackedPath);
        if (
          cachedMicroscopeWeights?.filePath === trackedPath &&
          cachedMicroscopeWeights.mtimeMs === stat.mtimeMs
        ) {
          return cachedMicroscopeWeights.weights;
        }
        const hit = parseMicroscopeWeightsV1(
          trackedPath,
          stat.mtimeMs,
          fs.readFileSync(trackedPath, "utf8")
        );
        if (hit) return hit;
      }
    } catch {
      // Optional weights artifact missing or unreadable
    }
    return null;
  }

  const customCandidates = [
    path.join(options.rootDir, ".data", "etg-trend-microscope-v1.json"),
    path.join(options.rootDir, "ml", "weights", "etg-trend-microscope-v1.json"),
  ];
  for (const filePath of customCandidates) {
    try {
      if (!fs.existsSync(/*turbopackIgnore: true*/ filePath)) continue;
      const stat = fs.statSync(/*turbopackIgnore: true*/ filePath);
      if (
        cachedMicroscopeWeights?.filePath === filePath &&
        cachedMicroscopeWeights.mtimeMs === stat.mtimeMs
      ) {
        return cachedMicroscopeWeights.weights;
      }
      const hit = parseMicroscopeWeightsV1(
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

function matvec(layer: LinearLayerWeights, x: readonly number[]): number[] {
  const out = new Array<number>(layer.weight.length);
  for (let o = 0; o < layer.weight.length; o++) {
    const row = layer.weight[o];
    let acc = layer.bias[o] ?? 0;
    for (let d = 0; d < Math.min(row.length, x.length); d++) {
      acc += row[d] * x[d];
    }
    out[o] = acc;
  }
  return out;
}

function tanhVec(xs: readonly number[]): number[] {
  return xs.map((v) => Math.tanh(clamp(v, -20, 20)));
}

function classifyRadarBadge(
  onsetProb: number,
  mkZNorm: number,
  shares: readonly [number, number, number],
  falseTrendProb: number
): TrendMicroscopeRadarBadge {
  const [, cycShare, artShare] = shares;
  const secShare = shares[0];
  if (falseTrendProb >= 0.52) {
    return artShare >= cycShare ? "SENSOR_GLITCH_RISK" : "FALSE_TREND_CYCLE";
  }
  if (onsetProb >= 0.55) {
    return mkZNorm < 0.49 ? "EARLY_ONSET" : "SECULAR_ACCELERATION";
  }
  if (secShare >= 0.55 && mkZNorm >= 0.45) {
    return "SECULAR_ACCELERATION";
  }
  return "NOMINAL";
}

function computeCalibratedFallbackForward(
  xNodes: number[][],
  pairMap: Map<string, { u: number; v: number; xp: number[] }>
): {
  nodeOuts: Array<{
    trustGate: number;
    onsetProb: number;
    directionProbs: { decreasing: number; steady: number; increasing: number };
    leadSteps: number;
    secularShare: number;
    oscillationShare: number;
    artifactShare: number;
    falseTrendProb: number;
    radarBadge: TrendMicroscopeRadarBadge;
  }>;
  pairOuts: Map<
    string,
    {
      u: number;
      v: number;
      trueCouplingProb: number;
      confounderProb: number;
      polarity: "drives_opposite" | "co_trending" | "none";
      optimalLagSteps: number;
    }
  >;
} {
  const nodeOuts = xNodes.map((x) => {
    const gate = sigmoid(4.0 * x[16] + 1.8 * x[18] - 0.25 * x[17] - 2.55);
    const slopeAbs = Math.max(Math.abs(x[0]), Math.abs(x[11]));
    const breakStrength = Math.abs(x[2]) * 1.4 + Math.abs(x[3]) * 0.6 + x[4] * 0.45 + slopeAbs * 0.5;
    const isGlitch = x[17] > 0.5 && x[18] < 0.5 && x[9] > 0.45;
    const onsetLogit = breakStrength * 2.1 - x[8] * 2.4 - (isGlitch ? 3.0 : 0) - 1.35;
    const onsetProb = sigmoid(onsetLogit);
    const dirScores = softmax([
      -x[11] * 2.5,
      1.0 - slopeAbs * 2.0,
      x[11] * 2.5,
    ]);
    const leadSteps = onsetProb >= 0.5 ? clamp(3 + Math.abs(x[2]), 0, 12) : 0;

    const rawSec = isGlitch ? 0.1 : Math.max(0.1, (slopeAbs + Math.abs(x[2])) * 1.5 - x[8] * 1.2);
    const rawCyc = Math.max(0.1, x[7] * 1.3 + x[8] * 2.2);
    const rawArt = isGlitch ? 2.5 : Math.max(0.15, (x[9] * 1.4 + (1 - x[16])) * 0.8);
    const sh = softmax([rawSec, rawCyc, rawArt]);
    const falseTrendProb = sigmoid((isGlitch ? 2.6 : 0) + x[8] * 2.8 + (1 - x[16]) * 1.2 - rawSec * 1.4 - 0.8);

    return {
      trustGate: round4(gate),
      onsetProb: round4(onsetProb),
      directionProbs: {
        decreasing: round4(dirScores[0]),
        steady: round4(dirScores[1]),
        increasing: round4(dirScores[2]),
      },
      leadSteps: Number(leadSteps.toFixed(2)),
      secularShare: round4(sh[0]),
      oscillationShare: round4(sh[1]),
      artifactShare: round4(sh[2]),
      falseTrendProb: round4(falseTrendProb),
      radarBadge: classifyRadarBadge(onsetProb, x[10], [sh[0], sh[1], sh[2]], falseTrendProb),
    };
  });

  const pairOuts = new Map<
    string,
    {
      u: number;
      v: number;
      trueCouplingProb: number;
      confounderProb: number;
      polarity: "drives_opposite" | "co_trending" | "none";
      optimalLagSteps: number;
    }
  >();

  for (const [key, { u, v, xp }] of pairMap.entries()) {
    const rawPeak = xp.slice(0, 4).reduce((best, c) => (Math.abs(c) > Math.abs(best) ? c : best), 0);
    let cleanPeak = 0;
    for (let k = 0; k < 4; k++) {
      if (Math.abs(xp[4 + k]) > Math.abs(cleanPeak)) cleanPeak = xp[4 + k];
    }
    const cleanAbs = Math.abs(cleanPeak);
    const rawAbs = Math.abs(rawPeak);
    const asym = xp[8];
    const confLogit = (rawAbs - cleanAbs) * 4.5 + (rawAbs > 0.45 && cleanAbs < 0.25 ? 1.8 : -1.2);
    const confounderProb = sigmoid(confLogit);
    const coupLogit = cleanAbs * 5.0 + Math.max(0, asym) * 2.2 - confounderProb * 2.5 - 1.4;
    const trueCouplingProb = sigmoid(coupLogit);
    const pol: "drives_opposite" | "co_trending" | "none" =
      trueCouplingProb < 0.5 ? "none" : cleanPeak < 0 ? "drives_opposite" : "co_trending";
    pairOuts.set(key, {
      u,
      v,
      trueCouplingProb: round4(trueCouplingProb),
      confounderProb: round4(confounderProb),
      polarity: pol,
      optimalLagSteps: Math.round(xp[9] * 5),
    });
  }

  return { nodeOuts, pairOuts };
}

export function runPortableMicroscopeForward(
  weights: PortableTrendMicroscopeWeightsV1,
  xNodes: number[][],
  pairMap: Map<string, { u: number; v: number; xp: number[] }>
): ReturnType<typeof computeCalibratedFallbackForward> {
  const n = xNodes.length;
  const hDim = weights.hidden_dim || 32;
  const tg = weights.trust_gate;
  const gates = xNodes.map((x) =>
    sigmoid(tg.w_trust * x[16] + tg.w_corroborated * x[18] + tg.w_community * x[17] + tg.bias)
  );
  const h0 = xNodes.map((x) => tanhVec(matvec(weights.node_enc1, x)));

  const ctx = Array.from({ length: n }, () => new Array<number>(hDim).fill(0));
  const denom = new Array<number>(n).fill(1);
  const edgeMsgs = new Map<string, { u: number; v: number; m: number[] }>();

  for (const [key, { u, v, xp }] of pairMap.entries()) {
    if (u === v) continue;
    const inp = [...h0[u], ...h0[v], ...xp];
    const mUv = tanhVec(matvec(weights.edge_enc1, inp));
    const aRaw = matvec(weights.edge_attn, mUv)[0] ?? 0;
    let cleanAbsMax = 0;
    for (let k = 0; k < 4; k++) {
      const cAbs = Math.abs(xp[4 + k] ?? 0);
      if (cAbs > cleanAbsMax) cleanAbsMax = cAbs;
    }
    const relUv = clamp((cleanAbsMax - 0.28) / 0.72, 0, 1);
    const aUv = gates[u] * relUv * sigmoid(aRaw);
    edgeMsgs.set(key, { u, v, m: mUv });
    denom[v] += aUv;
    const cv = ctx[v];
    for (let d = 0; d < hDim; d++) {
      cv[d] += aUv * mUv[d];
    }
  }

  for (let v = 0; v < n; v++) {
    const inv = 1 / denom[v];
    for (let d = 0; d < hDim; d++) ctx[v][d] *= inv;
  }

  const hNodes = Array.from({ length: n }, (_, v) =>
    tanhVec(matvec(weights.node_enc2, [...h0[v], ...ctx[v]]))
  );

  const nodeOuts = hNodes.map((hv, v) => {
    const infOut = matvec(weights.inflection_head, hv);
    const deaOut = matvec(weights.dealias_head, hv);
    const onsetProb = sigmoid(infOut[0]);
    const dirProbs = softmax(infOut.slice(1, 4));
    const leadSteps = clamp(softplus(infOut[4]), 0, 12);
    const shares = softmax(deaOut.slice(0, 3));
    const falseProb = sigmoid(deaOut[3]);
    return {
      trustGate: round4(gates[v]),
      onsetProb: round4(onsetProb),
      directionProbs: {
        decreasing: round4(dirProbs[0]),
        steady: round4(dirProbs[1]),
        increasing: round4(dirProbs[2]),
      },
      leadSteps: Number(leadSteps.toFixed(2)),
      secularShare: round4(shares[0]),
      oscillationShare: round4(shares[1]),
      artifactShare: round4(shares[2]),
      falseTrendProb: round4(falseProb),
      radarBadge: classifyRadarBadge(
        onsetProb,
        xNodes[v][10],
        [shares[0], shares[1], shares[2]],
        falseProb
      ),
    };
  });

  const pairOuts = new Map<
    string,
    {
      u: number;
      v: number;
      trueCouplingProb: number;
      confounderProb: number;
      polarity: "drives_opposite" | "co_trending" | "none";
      optimalLagSteps: number;
    }
  >();

  for (const [key, { u, v, m }] of edgeMsgs.entries()) {
    const cOut = matvec(weights.coupling_head, m);
    const trueProb = sigmoid(cOut[0]);
    const polProbs = softmax(cOut.slice(1, 4));
    const lagProbs = softmax(cOut.slice(4, 10));
    const confProb = sigmoid(cOut[10]);
    let bestLag = 0;
    for (let k = 1; k < lagProbs.length; k++) {
      if (lagProbs[k] > lagProbs[bestLag]) bestLag = k;
    }
    const pol: "drives_opposite" | "co_trending" | "none" =
      polProbs[0] >= polProbs[1] && polProbs[0] >= polProbs[2]
        ? "drives_opposite"
        : polProbs[2] >= polProbs[1]
          ? "co_trending"
          : "none";
    pairOuts.set(key, {
      u,
      v,
      trueCouplingProb: round4(trueProb),
      confounderProb: round4(confProb),
      polarity: pol,
      optimalLagSteps: bestLag,
    });
  }

  return { nodeOuts, pairOuts };
}

/**
 * Fast pairwise scorer used inside `etgStore.discoverCandidateLinks` so latent link
 * ranking surfaces true lagged/opposite couplings while flagging seasonal/drift illusions.
 */
export function scorePairWithTrendMicroscope(
  nodeU: ETGNode,
  seriesU: readonly TimeSeriesPoint[],
  nodeV: ETGNode,
  seriesV: readonly TimeSeriesPoint[]
): {
  trueCouplingProb: number;
  confounderProb: number;
  polarity: "drives_opposite" | "co_trending" | "none";
  optimalLagSteps: number;
} | null {
  const aligned = alignCompatibleSeries(seriesU, seriesV);
  if (!aligned || aligned.alignedA.length < 6) return null;

  const uVals = aligned.alignedA.map((p) => p.value);
  const vVals = aligned.alignedB.map((p) => p.value);
  const scaleU = inferNodeTemporalScale(nodeU, aligned.alignedA);
  const scaleV = inferNodeTemporalScale(nodeV, aligned.alignedB);
  const trustU = computeEtgNodeTrustScore(nodeU);
  const trustV = computeEtgNodeTrustScore(nodeV);

  const xu = extractNodeMicroscopeFeatures(uVals, {
    scale: scaleU,
    lat: nodeU.properties.lat ?? 0,
    lng: nodeU.properties.lng ?? 0,
    trustScore: trustU,
    isCommunity: isCommunityContributorNode(nodeU),
    corroborated: Boolean(nodeU.properties.corroborated),
    fullLen: seriesU.length,
  });
  const xv = extractNodeMicroscopeFeatures(vVals, {
    scale: scaleV,
    lat: nodeV.properties.lat ?? 0,
    lng: nodeV.properties.lng ?? 0,
    trustScore: trustV,
    isCommunity: isCommunityContributorNode(nodeV),
    corroborated: Boolean(nodeV.properties.corroborated),
    fullLen: seriesV.length,
  });
  const xp = extractPairMicroscopeFeatures(uVals, vVals, {
    uLat: nodeU.properties.lat ?? 0,
    uLng: nodeU.properties.lng ?? 0,
    vLat: nodeV.properties.lat ?? 0,
    vLng: nodeV.properties.lng ?? 0,
    uTrust: trustU,
    vTrust: trustV,
    scale: scaleV,
  });

  const pairMap = new Map<string, { u: number; v: number; xp: number[] }>([
    ["0->1", { u: 0, v: 1, xp }],
  ]);
  const weights = loadLocalTrendMicroscopeWeights();
  const out = weights
    ? runPortableMicroscopeForward(weights, [xu, xv], pairMap)
    : computeCalibratedFallbackForward([xu, xv], pairMap);

  const res = out.pairOuts.get("0->1");
  if (!res) return null;
  return {
    trueCouplingProb: res.trueCouplingProb,
    confounderProb: res.confounderProb,
    polarity: res.polarity,
    optimalLagSteps: res.optimalLagSteps,
  };
}

export function scanTrendMicroscope(
  store: TrendMicroscopeStoreLike,
  options: TrendMicroscopeScanOptions = {}
): TrendMicroscopeScanResult {
  const topK = Math.max(1, Math.min(24, options.topK ?? 8));
  const maxHops = Math.max(1, Math.min(4, options.maxHops ?? 2));
  const snapshot = store.getSnapshot();

  let targetNode = options.focusNodeUuid ? store.getNode(options.focusNodeUuid) : undefined;
  let candidateNodes: ETGNode[] = [];
  let candidateEdges: ETGEdge[] = snapshot.edges;

  if (targetNode) {
    const trav = store.traverseSubgraph({ rootUuid: targetNode.uuid, maxHops, direction: "both" });
    candidateNodes = trav.nodes;
    candidateEdges = trav.edges;
  } else if (
    typeof options.lat === "number" &&
    typeof options.lng === "number" &&
    store.assembleRegionalContextSubgraph
  ) {
    const ctx = store.assembleRegionalContextSubgraph({
      lat: options.lat,
      lng: options.lng,
      dataset: options.dataset,
      maxHops,
      includeGlobalModes: true,
    });
    targetNode = ctx.targetNode;
    candidateNodes = ctx.nodes;
    candidateEdges = ctx.edges;
  }

  // Ensure rich coverage across active time-series nodes when neighborhood is tiny
  const seen = new Set(candidateNodes.map((n) => n.uuid));
  const mergedNodes = [...candidateNodes];
  for (const n of snapshot.nodes) {
    if (mergedNodes.length >= 28) break;
    if (n.properties.status === "Superseded" || seen.has(n.uuid)) continue;
    const s = n.properties.series ?? store.getNodeSeries(n.uuid);
    if (s && s.length >= 6) {
      mergedNodes.push(n);
      seen.add(n.uuid);
    }
  }

  interface ActiveSeriesNode {
    uuid: string;
    name: string;
    lat: number;
    lng: number;
    scale: "day" | "month" | "year" | "impulse";
    trust: number;
    isCommunity: boolean;
    corroborated: boolean;
    series: TimeSeriesPoint[];
    values: number[];
  }

  const activeNodes: ActiveSeriesNode[] = [];
  for (const n of mergedNodes) {
    const s = n.properties.series ?? store.getNodeSeries(n.uuid);
    if (!s || s.length < 6) continue;
    const scale = inferNodeTemporalScale(n, s);
    const trust = store.computeNodeTrustScore
      ? store.computeNodeTrustScore(n)
      : computeEtgNodeTrustScore(n);
    activeNodes.push({
      uuid: n.uuid,
      name: n.properties.name,
      lat: n.properties.lat ?? 0,
      lng: n.properties.lng ?? 0,
      scale,
      trust,
      isCommunity: isCommunityContributorNode(n),
      corroborated: Boolean(n.properties.corroborated),
      series: s,
      values: s.map((pt) => pt.value),
    });
  }

  if (options.extraSeries && options.extraSeries.series.length >= 6 && !seen.has(options.extraSeries.uuid)) {
    activeNodes.unshift({
      uuid: options.extraSeries.uuid,
      name: options.extraSeries.name,
      lat: options.extraSeries.lat,
      lng: options.extraSeries.lng,
      scale: options.extraSeries.series[0]?.date.length === 10 ? "day" : "month",
      trust: 0.85,
      isCommunity: false,
      corroborated: false,
      series: options.extraSeries.series,
      values: options.extraSeries.series.map((p) => p.value),
    });
  }

  const focusUuid = options.extraSeries?.uuid ?? targetNode?.uuid ?? options.focusNodeUuid;
  const focusIdx = focusUuid ? activeNodes.findIndex((n) => n.uuid === focusUuid) : -1;

  if (activeNodes.length === 0) {
    return {
      schemaVersion: "etg-trend-microscope-v1",
      engineUsed: loadLocalTrendMicroscopeWeights() ? "local_microscope_weights" : "fallback_calibrated",
      nodeCount: 0,
      nodes: [],
      verifiedCouplings: [],
      suppressedIllusions: [],
      aiPerceptionBrief: "ETG Trend Microscope (etg-trend-microscope-v1): 0 time-series nodes ready for scan.",
    };
  }

  const xNodes = activeNodes.map((n) =>
    extractNodeMicroscopeFeatures(n.values, {
      scale: n.scale,
      lat: n.lat,
      lng: n.lng,
      trustScore: n.trust,
      isCommunity: n.isCommunity,
      corroborated: n.corroborated,
      fullLen: n.values.length,
    })
  );

  const pairMap = new Map<string, { u: number; v: number; xp: number[]; rawPeak: number; cleanPeak: number }>();
  for (let u = 0; u < activeNodes.length; u++) {
    for (let v = 0; v < activeNodes.length; v++) {
      if (u === v) continue;
      if (focusIdx >= 0 && u !== focusIdx && v !== focusIdx && activeNodes.length > 10) {
        continue;
      }
      const nu = activeNodes[u];
      const nv = activeNodes[v];
      const aligned = alignCompatibleSeries(nu.series, nv.series);
      if (!aligned || aligned.alignedA.length < 6) continue;
      const uVals = aligned.alignedA.map((p) => p.value);
      const vVals = aligned.alignedB.map((p) => p.value);
      const xp = extractPairMicroscopeFeatures(uVals, vVals, {
        uLat: nu.lat,
        uLng: nu.lng,
        vLat: nv.lat,
        vLng: nv.lng,
        uTrust: nu.trust,
        vTrust: nv.trust,
        scale: nv.scale,
      });
      const rawPeak = xp.slice(0, 4).reduce((best, c) => (Math.abs(c) > Math.abs(best) ? c : best), 0);
      const cleanPeak = xp.slice(4, 8).reduce((best, c) => (Math.abs(c) > Math.abs(best) ? c : best), 0);
      pairMap.set(`${u}->${v}`, { u, v, xp, rawPeak, cleanPeak });
    }
  }

  const weights = loadLocalTrendMicroscopeWeights();
  const engineUsed: TrendMicroscopeScanResult["engineUsed"] = weights
    ? "local_microscope_weights"
    : "fallback_calibrated";
  const fwd = weights
    ? runPortableMicroscopeForward(weights, xNodes, pairMap)
    : computeCalibratedFallbackForward(xNodes, pairMap);

  const existingPairSet = new Set<string>();
  for (const e of candidateEdges) {
    existingPairSet.add(`${e.source_uuid}->${e.target_uuid}`);
    existingPairSet.add(`${e.target_uuid}->${e.source_uuid}`);
  }

  const nodeCues: NodeTrendMicroscopeCue[] = fwd.nodeOuts.map((o, idx) => {
    const an = activeNodes[idx];
    const mkZ = Number((xNodes[idx][10] * 4).toFixed(3));
    const dp = o.directionProbs;
    const emergingDirection: NodeTrendMicroscopeCue["emergingDirection"] =
      dp.increasing >= dp.decreasing && dp.increasing >= dp.steady
        ? "increasing"
        : dp.decreasing >= dp.steady
          ? "decreasing"
          : "stable";
    const preMannKendallAlert = o.onsetProb >= 0.55 && mkZ < 1.96;
    const aiCue = `[${an.name}] badge=${o.radarBadge} | onset=${Math.round(o.onsetProb * 100)}% (${
      preMannKendallAlert ? "PRE-MK" : `MK |Z|=${mkZ.toFixed(2)}`
    }) | attrib: ${Math.round(o.secularShare * 100)}% secular / ${Math.round(
      o.oscillationShare * 100
    )}% cycle / ${Math.round(o.artifactShare * 100)}% noise (false_prob=${Math.round(
      o.falseTrendProb * 100
    )}%)`;

    return {
      uuid: an.uuid,
      name: an.name,
      radarBadge: o.radarBadge,
      onsetProb: o.onsetProb,
      preMannKendallAlert,
      mkAbsZ: mkZ,
      emergingDirection,
      leadStepsAhead: o.leadSteps,
      dealiasing: {
        secularShare: o.secularShare,
        oscillationShare: o.oscillationShare,
        artifactShare: o.artifactShare,
        falseTrendProb: o.falseTrendProb,
      },
      trustGate: o.trustGate,
      aiCue,
    };
  });

  const verifiedCouplings: LinkTrendMicroscopeCue[] = [];
  const suppressedIllusions: LinkTrendMicroscopeCue[] = [];

  for (const [key, pOut] of fwd.pairOuts.entries()) {
    if (focusIdx >= 0 && pOut.u !== focusIdx && pOut.v !== focusIdx) continue;
    const nu = activeNodes[pOut.u];
    const nv = activeNodes[pOut.v];
    const meta = pairMap.get(key)!;
    const cue: LinkTrendMicroscopeCue = {
      sourceUuid: nu.uuid,
      targetUuid: nv.uuid,
      sourceName: nu.name,
      targetName: nv.name,
      alreadyWired: existingPairSet.has(`${nu.uuid}->${nv.uuid}`),
      trueCouplingProb: pOut.trueCouplingProb,
      confounderProb: pOut.confounderProb,
      polarity: pOut.polarity,
      optimalLagSteps: pOut.optimalLagSteps,
      rawPeakR: Number(meta.rawPeak.toFixed(3)),
      cleanPeakR: Number(meta.cleanPeak.toFixed(3)),
      aiCue: `${nu.name} -> ${nv.name}: ${pOut.polarity} (P_true=${Math.round(
        pOut.trueCouplingProb * 100
      )}%, lag=${pOut.optimalLagSteps}, P_illusion=${Math.round(
        pOut.confounderProb * 100
      )}%, raw_r=${meta.rawPeak >= 0 ? "+" : ""}${meta.rawPeak.toFixed(2)}, clean_r=${
        meta.cleanPeak >= 0 ? "+" : ""
      }${meta.cleanPeak.toFixed(2)})`,
    };
    if (pOut.trueCouplingProb >= 0.55 && pOut.polarity !== "none" && pOut.confounderProb < 0.55) {
      verifiedCouplings.push(cue);
    } else if (pOut.confounderProb >= 0.55 && Math.abs(meta.rawPeak) >= 0.45) {
      suppressedIllusions.push(cue);
    }
  }

  verifiedCouplings.sort((a, b) => b.trueCouplingProb - a.trueCouplingProb);
  suppressedIllusions.sort((a, b) => b.confounderProb - a.confounderProb);

  const onsets = [...nodeCues]
    .filter((c) => c.onsetProb >= 0.52)
    .sort((a, b) => b.onsetProb - a.onsetProb);
  const alerts = [...nodeCues]
    .filter((c) => c.dealiasing.falseTrendProb >= 0.52)
    .sort((a, b) => b.dealiasing.falseTrendProb - a.dealiasing.falseTrendProb);

  const briefLines = [
    `ETG Trend Microscope (etg-trend-microscope-v1) — ${activeNodes.length} nodes scanned:`,
    `Emerging Onsets: ${onsets.length > 0 ? onsets.slice(0, 3).map((c) => c.aiCue).join("; ") : "None flagged."}`,
    `Verified Lagged/Dipole Couplings: ${
      verifiedCouplings.length > 0
        ? verifiedCouplings.slice(0, 3).map((l) => l.aiCue).join("; ")
        : "None above gate."
    }`,
    `Suppressed Confounder Illusions: ${
      suppressedIllusions.length > 0
        ? suppressedIllusions.slice(0, 3).map((l) => l.aiCue).join("; ")
        : "None detected."
    }`,
    `Cycle / Sensor-Drift Alerts: ${alerts.length > 0 ? alerts.slice(0, 3).map((c) => c.aiCue).join("; ") : "None."}`,
  ];

  return {
    schemaVersion: "etg-trend-microscope-v1",
    engineUsed,
    nodeCount: activeNodes.length,
    nodes: nodeCues,
    verifiedCouplings: verifiedCouplings.slice(0, topK),
    suppressedIllusions: suppressedIllusions.slice(0, topK),
    aiPerceptionBrief: briefLines.join("\n"),
  };
}

export async function scanTrendMicroscopeAsync(
  store: TrendMicroscopeStoreLike,
  options: TrendMicroscopeScanOptions = {}
): Promise<TrendMicroscopeScanResult> {
  let effectiveOptions = { ...options };

  if (
    !options.focusNodeUuid &&
    !options.extraSeries &&
    typeof options.lat === "number" &&
    typeof options.lng === "number"
  ) {
    const snap = store.getSnapshot();
    const nearest = snap.nodes
      .filter((n) => typeof n.properties.lat === "number" && typeof n.properties.lng === "number")
      .map((n) => ({
        node: n,
        km: haversineKmLocal(options.lat!, options.lng!, n.properties.lat!, n.properties.lng!),
      }))
      .sort((a, b) => a.km - b.km)[0];

    if (nearest && nearest.km <= 120) {
      effectiveOptions.focusNodeUuid = nearest.node.uuid;
    } else {
      try {
        const fetched = await fetchRegionalMultiScaleSeries(
          options.lat,
          options.lng,
          options.dataset ?? "nasa_power"
        );
        if (fetched.month.length >= 6) {
          effectiveOptions.extraSeries = {
            uuid: `probe-${options.lat.toFixed(2)}-${options.lng.toFixed(2)}`,
            name: `Probed Region (${options.lat.toFixed(1)}°, ${options.lng.toFixed(1)}°)`,
            lat: options.lat,
            lng: options.lng,
            dataset: options.dataset ?? "nasa_power",
            series: fetched.month,
          };
        }
      } catch {
        // Proceed gracefully with graph peers only
      }
    }
  }

  const mlServiceUrl = process.env.ETG_ML_SERVICE_URL?.trim();
  if (mlServiceUrl && store.exportMlGraphDatasetV2 && !effectiveOptions.extraSeries) {
    try {
      const bundle = store.exportMlGraphDatasetV2({
        rootUuid: effectiveOptions.focusNodeUuid,
        maxHops: effectiveOptions.maxHops ?? 2,
      });
      if (bundle.node_ids.length >= 2) {
        const endpoint = `${mlServiceUrl.replace(/\/$/, "")}/microscope/scan`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(4500),
          body: JSON.stringify({
            bundle,
            focusUuid: effectiveOptions.focusNodeUuid,
            topK: effectiveOptions.topK ?? 8,
          }),
        });
        if (res.ok) {
          const remote = (await res.json()) as Omit<TrendMicroscopeScanResult, "engineUsed">;
          if (remote?.schemaVersion === "etg-trend-microscope-v1" && Array.isArray(remote.nodes)) {
            return {
              ...remote,
              engineUsed: "l4_microscope",
            };
          }
        }
      }
    } catch {
      // Fall back transparently to local weights
    }
  }

  return scanTrendMicroscope(store, effectiveOptions);
}
