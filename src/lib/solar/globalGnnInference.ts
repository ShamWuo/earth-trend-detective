import fs from "node:fs";
import path from "node:path";
import type { ClimateGraphNode, DailyWeatherRow } from "./denverClimateGraph";

export const GLOBAL_GNN_WINDOW_LEN = 7;
export const GLOBAL_GNN_NUM_NODES = 7;
export const GLOBAL_GNN_F_NODE = 26;
export const GLOBAL_GNN_F_EDGE = 10;
export const GLOBAL_GNN_F_PHYS = 16;

const TO_RAD = Math.PI / 180;

export interface GlobalGnnTensorSpec {
  name: string;
  shape: number[];
  dtype: string;
  offset: number;
  byte_length: number;
}

export interface GlobalGnnMeta {
  schema_version: string;
  architecture: {
    f_node: number;
    f_edge: number;
    f_phys: number;
    window_len: number;
    num_nodes: number;
    d_model: number;
    num_layers: number;
    num_heads: number;
    param_count: number;
  };
  total_bytes: number;
  tensors: GlobalGnnTensorSpec[];
  summary?: Record<string, unknown>;
  golden_parity_check?: {
    next_date: string;
    window: number[][][];
    edge_index: number[][];
    edge_attr: number[][];
    phys: number[];
    clrsky_next: number;
    expected_quantiles: number[];
    expected_storm_prob: number;
  };
}

interface DecodedGnnLayer {
  qW: Float32Array;
  qB: Float32Array;
  kNodeW: Float32Array;
  kEdgeW: Float32Array;
  kB: Float32Array;
  vNodeW: Float32Array;
  vEdgeW: Float32Array;
  vB: Float32Array;
  attnVec: Float32Array;
  eg0W: Float32Array;
  eg0B: Float32Array;
  eg2W: Float32Array;
  eg2B: Float32Array;
  outW: Float32Array;
  outB: Float32Array;
  norm1W: Float32Array;
  norm1B: Float32Array;
  ffn0W: Float32Array;
  ffn0B: Float32Array;
  ffn2W: Float32Array;
  ffn2B: Float32Array;
  norm2W: Float32Array;
  norm2B: Float32Array;
}

export interface GlobalGnnScratch7 {
  hNodes: Float32Array;
  gruHidden7: Float32Array;
  tEmb7: Float32Array;
  ihProj7: Float32Array;
  hhProj7: Float32Array;
  qAll: Float32Array;
  kNodeAll: Float32Array;
  vNodeAll: Float32Array;
  kVec: Float32Array;
  vVec: Float32Array;
  edgeSlice: Float32Array;
  egMid: Float32Array;
  egOut: Float32Array;
  agg: Float32Array;
  deg: Float32Array;
  outAll7: Float32Array;
  ffnMidAll7: Float32Array;
  hTgt: Float32Array;
  adDown: Float32Array;
  adUp: Float32Array;
  headIn: Float32Array;
  zMid: Float32Array;
  z: Float32Array;
  rawQ: Float32Array;
  stormLogitArr: Float32Array;
}

export interface LoadedGlobalGnnModel {
  meta: GlobalGnnMeta;
  dModel: number;
  numLayers: number;
  numHeads: number;
  headDim: number;
  tempInW: Float32Array;
  tempInB: Float32Array;
  gruWih: Float32Array;
  gruWhh: Float32Array;
  gruBih: Float32Array;
  gruBhh: Float32Array;
  tempNormW: Float32Array;
  tempNormB: Float32Array;
  layers: DecodedGnnLayer[];
  adapterDownW: Float32Array;
  adapterDownB: Float32Array;
  adapterUpW: Float32Array;
  adapterUpB: Float32Array;
  head0W: Float32Array;
  head0B: Float32Array;
  head2W: Float32Array;
  head2B: Float32Array;
  head3W: Float32Array;
  head3B: Float32Array;
  ktHeadW: Float32Array;
  ktHeadB: Float32Array;
  stormHeadW: Float32Array;
  stormHeadB: Float32Array;
  scratch7?: GlobalGnnScratch7;
}

export interface GlobalGnnPrediction {
  p10: number;
  q268: number;
  p50: number;
  p90: number;
  stormProb: number;
}

export interface GlobalGnnCityBenchmarkRow {
  city_id: string;
  name: string;
  regime: string;
  n_test: number;
  persistence_rmse: number;
  clear_sky_persistence_rmse: number;
  local_eve_rmse: number;
  global_gnn_rmse: number;
  global_gnn_skill_pct: number;
  p_vs_local_eve: number;
}

export interface GlobalGnnSummaryMetricsBlock {
  rmse: number;
  mae: number;
  r2: number;
  skill_pct: number;
  storm_precision: number;
  storm_recall: number;
  storm_f1: number;
  annualized_penalty_usd: number;
  storm_capture_recall_pct: number;
  savings_usd?: number;
  p_vs_persistence?: number;
  p_vs_local_daily?: number;
  p_vs_local_eve?: number;
  p_cost_vs_local_eve?: number;
}

export interface GlobalGnnSummaryJson {
  train_cities: number;
  test_cities: number;
  total_cities: number;
  total_stations: number;
  train_graph_days: number;
  val_graph_days: number;
  global_val_rmse: number;
  global_5city_benchmark: GlobalGnnCityBenchmarkRow[];
  denver_showcase: {
    n_test: number;
    persistence: GlobalGnnSummaryMetricsBlock;
    clear_sky_persistence: GlobalGnnSummaryMetricsBlock;
    local_daily: GlobalGnnSummaryMetricsBlock;
    local_eve: GlobalGnnSummaryMetricsBlock;
    global_gnn_zeroshot: GlobalGnnSummaryMetricsBlock;
    global_gnn_adapted: GlobalGnnSummaryMetricsBlock;
  };
  elapsed_sec?: number;
}

const modelCache = new Map<string, { mtimeMs: number; model: LoadedGlobalGnnModel }>();
const summaryCache = new Map<string, { mtimeMs: number; summary: GlobalGnnSummaryJson }>();

function float16ToFloat32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) {
    return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  }
  if (e === 31) {
    return f ? Number.NaN : s ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function erfApprox(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return sign * y;
}

function gelu(x: number): number {
  return 0.5 * x * (1 + erfApprox(x * Math.SQRT1_2));
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
  return x > 20 ? x : Math.log1p(Math.exp(x));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function linearVec(
  w: Float32Array,
  b: Float32Array,
  x: Float32Array,
  outDim: number,
  inDim: number,
  out: Float32Array
): void {
  const unrollEnd = inDim - (inDim % 4);
  for (let o = 0; o < outDim; o++) {
    let acc0 = b[o];
    let acc1 = 0;
    let acc2 = 0;
    let acc3 = 0;
    const rowOff = o * inDim;
    for (let i = 0; i < unrollEnd; i += 4) {
      acc0 += w[rowOff + i] * x[i];
      acc1 += w[rowOff + i + 1] * x[i + 1];
      acc2 += w[rowOff + i + 2] * x[i + 2];
      acc3 += w[rowOff + i + 3] * x[i + 3];
    }
    let acc = acc0 + acc1 + acc2 + acc3;
    for (let i = unrollEnd; i < inDim; i++) {
      acc += w[rowOff + i] * x[i];
    }
    out[o] = acc;
  }
}

function linearAddVec(
  w: Float32Array,
  base: Float32Array,
  baseOffset: number,
  x: Float32Array,
  outDim: number,
  inDim: number,
  out: Float32Array
): void {
  const unrollEnd = inDim - (inDim % 4);
  for (let o = 0; o < outDim; o++) {
    let acc0 = base[baseOffset + o];
    let acc1 = 0;
    let acc2 = 0;
    let acc3 = 0;
    const rowOff = o * inDim;
    for (let i = 0; i < unrollEnd; i += 4) {
      acc0 += w[rowOff + i] * x[i];
      acc1 += w[rowOff + i + 1] * x[i + 1];
      acc2 += w[rowOff + i + 2] * x[i + 2];
      acc3 += w[rowOff + i + 3] * x[i + 3];
    }
    let acc = acc0 + acc1 + acc2 + acc3;
    for (let i = unrollEnd; i < inDim; i++) {
      acc += w[rowOff + i] * x[i];
    }
    out[o] = acc;
  }
}

function linearBatch7(
  w: Float32Array,
  b: Float32Array,
  x7: Float32Array,
  outDim: number,
  inDim: number,
  out7: Float32Array,
  xOffset = 0
): void {
  const s0 = xOffset;
  const s1 = xOffset + inDim;
  const s2 = xOffset + inDim * 2;
  const s3 = xOffset + inDim * 3;
  const s4 = xOffset + inDim * 4;
  const s5 = xOffset + inDim * 5;
  const s6 = xOffset + inDim * 6;
  const o1 = outDim;
  const o2 = outDim * 2;
  const o3 = outDim * 3;
  const o4 = outDim * 4;
  const o5 = outDim * 5;
  const o6 = outDim * 6;

  for (let o = 0; o < outDim; o++) {
    const bv = b[o];
    let a0 = bv;
    let a1 = bv;
    let a2 = bv;
    let a3 = bv;
    let a4 = bv;
    let a5 = bv;
    let a6 = bv;
    const rowOff = o * inDim;
    for (let i = 0; i < inDim; i++) {
      const wi = w[rowOff + i];
      a0 += wi * x7[s0 + i];
      a1 += wi * x7[s1 + i];
      a2 += wi * x7[s2 + i];
      a3 += wi * x7[s3 + i];
      a4 += wi * x7[s4 + i];
      a5 += wi * x7[s5 + i];
      a6 += wi * x7[s6 + i];
    }
    out7[o] = a0;
    out7[o1 + o] = a1;
    out7[o2 + o] = a2;
    out7[o3 + o] = a3;
    out7[o4 + o] = a4;
    out7[o5 + o] = a5;
    out7[o6 + o] = a6;
  }
}

function splitNodeEdgeWeight(
  w: Float32Array,
  outDim: number,
  nodeDim: number,
  edgeDim: number
): { nodeW: Float32Array; edgeW: Float32Array } {
  const totalIn = nodeDim + edgeDim;
  const nodeW = new Float32Array(outDim * nodeDim);
  const edgeW = new Float32Array(outDim * edgeDim);
  for (let o = 0; o < outDim; o++) {
    const srcOff = o * totalIn;
    nodeW.set(w.subarray(srcOff, srcOff + nodeDim), o * nodeDim);
    edgeW.set(w.subarray(srcOff + nodeDim, srcOff + totalIn), o * edgeDim);
  }
  return { nodeW, edgeW };
}

function layerNormInPlace(x: Float32Array, w: Float32Array, b: Float32Array, dim: number): void {
  let mean = 0;
  for (let i = 0; i < dim; i++) mean += x[i];
  mean /= dim;
  let varSum = 0;
  for (let i = 0; i < dim; i++) {
    const d = x[i] - mean;
    varSum += d * d;
  }
  const invStd = 1 / Math.sqrt(varSum / dim + 1e-5);
  for (let i = 0; i < dim; i++) {
    x[i] = (x[i] - mean) * invStd * w[i] + b[i];
  }
}

export function loadGlobalGnnSummary(weightsDir?: string): GlobalGnnSummaryJson | null {
  const dir = weightsDir ?? path.join(process.cwd(), "ml", "weights");
  const summaryPath = path.join(dir, "etg-global-gnn-v3-summary.json");
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ summaryPath)) {
      return null;
    }
    const stat = fs.statSync(/*turbopackIgnore: true*/ summaryPath);
    const cached = summaryCache.get(summaryPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.summary;
    }
    const parsed = JSON.parse(
      fs.readFileSync(/*turbopackIgnore: true*/ summaryPath, "utf8")
    ) as GlobalGnnSummaryJson;
    if (!parsed || typeof parsed.train_cities !== "number" || !parsed.denver_showcase) {
      return null;
    }
    summaryCache.set(summaryPath, { mtimeMs: stat.mtimeMs, summary: parsed });
    return parsed;
  } catch {
    return null;
  }
}

export function loadGlobalGnnModel(
  variant: "zeroshot" | "denver_adapter" = "zeroshot",
  weightsDir?: string
): LoadedGlobalGnnModel | null {
  const dir = weightsDir ?? path.join(process.cwd(), "ml", "weights");
  const stem =
    variant === "denver_adapter" ? "etg-global-gnn-v3-denver-adapter" : "etg-global-gnn-v3";
  const binPath = path.join(dir, `${stem}.bin`);
  const metaPath = path.join(dir, `${stem}.meta.json`);

  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ binPath) || !fs.existsSync(/*turbopackIgnore: true*/ metaPath)) {
      return null;
    }
    const stat = fs.statSync(/*turbopackIgnore: true*/ binPath);
    const cached = modelCache.get(binPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.model;
    }

    const meta = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ metaPath, "utf8")) as GlobalGnnMeta;
    const rawBuf = fs.readFileSync(/*turbopackIgnore: true*/ binPath);
    if (rawBuf.byteLength < meta.total_bytes) return null;

    const tensors = new Map<string, Float32Array>();
    const dv = new DataView(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
    for (const spec of meta.tensors) {
      const count = spec.byte_length / 2;
      const arr = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        arr[i] = float16ToFloat32(dv.getUint16(spec.offset + i * 2, true));
      }
      tensors.set(spec.name, arr);
    }

    const getT = (name: string): Float32Array => {
      const t = tensors.get(name);
      if (!t) throw new Error(`Missing tensor '${name}' in ${metaPath}`);
      return t;
    };

    const { d_model: dModel, num_layers: numLayers, num_heads: numHeads, f_edge: fEdge } = meta.architecture;
    const layers: DecodedGnnLayer[] = [];
    for (let l = 0; l < numLayers; l++) {
      const p = `gnn_layers.${l}`;
      const kSplit = splitNodeEdgeWeight(getT(`${p}.k_proj.weight`), dModel, dModel, fEdge);
      const vSplit = splitNodeEdgeWeight(getT(`${p}.v_proj.weight`), dModel, dModel, fEdge);
      layers.push({
        qW: getT(`${p}.q_proj.weight`),
        qB: getT(`${p}.q_proj.bias`),
        kNodeW: kSplit.nodeW,
        kEdgeW: kSplit.edgeW,
        kB: getT(`${p}.k_proj.bias`),
        vNodeW: vSplit.nodeW,
        vEdgeW: vSplit.edgeW,
        vB: getT(`${p}.v_proj.bias`),
        attnVec: getT(`${p}.attn_vec`),
        eg0W: getT(`${p}.edge_gate.0.weight`),
        eg0B: getT(`${p}.edge_gate.0.bias`),
        eg2W: getT(`${p}.edge_gate.2.weight`),
        eg2B: getT(`${p}.edge_gate.2.bias`),
        outW: getT(`${p}.out_proj.weight`),
        outB: getT(`${p}.out_proj.bias`),
        norm1W: getT(`${p}.norm1.weight`),
        norm1B: getT(`${p}.norm1.bias`),
        ffn0W: getT(`${p}.ffn.0.weight`),
        ffn0B: getT(`${p}.ffn.0.bias`),
        ffn2W: getT(`${p}.ffn.2.weight`),
        ffn2B: getT(`${p}.ffn.2.bias`),
        norm2W: getT(`${p}.norm2.weight`),
        norm2B: getT(`${p}.norm2.bias`),
      });
    }

    const model: LoadedGlobalGnnModel = {
      meta,
      dModel,
      numLayers,
      numHeads,
      headDim: dModel / numHeads,
      tempInW: getT("temp_in.weight"),
      tempInB: getT("temp_in.bias"),
      gruWih: getT("temp_gru.weight_ih_l0"),
      gruWhh: getT("temp_gru.weight_hh_l0"),
      gruBih: getT("temp_gru.bias_ih_l0"),
      gruBhh: getT("temp_gru.bias_hh_l0"),
      tempNormW: getT("temp_norm.weight"),
      tempNormB: getT("temp_norm.bias"),
      layers,
      adapterDownW: getT("adapter_down.weight"),
      adapterDownB: getT("adapter_down.bias"),
      adapterUpW: getT("adapter_up.weight"),
      adapterUpB: getT("adapter_up.bias"),
      head0W: getT("head_mlp.0.weight"),
      head0B: getT("head_mlp.0.bias"),
      head2W: getT("head_mlp.2.weight"),
      head2B: getT("head_mlp.2.bias"),
      head3W: getT("head_mlp.3.weight"),
      head3B: getT("head_mlp.3.bias"),
      ktHeadW: getT("kt_head.weight"),
      ktHeadB: getT("kt_head.bias"),
      stormHeadW: getT("storm_head.weight"),
      stormHeadB: getT("storm_head.bias"),
    };

    if (meta.architecture.num_nodes === 7) {
      const W = meta.architecture.window_len;
      const Fn = meta.architecture.f_node;
      const Fe = meta.architecture.f_edge;
      const Fp = meta.architecture.f_phys;
      const adapterDim = model.adapterDownB.length;
      model.scratch7 = {
        hNodes: new Float32Array(7 * dModel),
        gruHidden7: new Float32Array(7 * dModel),
        tEmb7: new Float32Array(7 * dModel),
        ihProj7: new Float32Array(7 * 3 * dModel),
        hhProj7: new Float32Array(7 * 3 * dModel),
        qAll: new Float32Array(7 * dModel),
        kNodeAll: new Float32Array(7 * dModel),
        vNodeAll: new Float32Array(7 * dModel),
        kVec: new Float32Array(dModel),
        vVec: new Float32Array(dModel),
        edgeSlice: new Float32Array(Fe),
        egMid: new Float32Array(24),
        egOut: new Float32Array(1),
        agg: new Float32Array(7 * dModel),
        deg: new Float32Array(7),
        outAll7: new Float32Array(7 * dModel),
        ffnMidAll7: new Float32Array(7 * dModel * 2),
        hTgt: new Float32Array(dModel),
        adDown: new Float32Array(adapterDim),
        adUp: new Float32Array(dModel),
        headIn: new Float32Array(dModel + Fp),
        zMid: new Float32Array(dModel),
        z: new Float32Array(128),
        rawQ: new Float32Array(4),
        stormLogitArr: new Float32Array(1),
      };

      const winDummy = new Float32Array(W * 7 * Fn);
      const eSrcDummy = new Int32Array(42);
      const eDstDummy = new Int32Array(42);
      let ei = 0;
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          if (i !== j) {
            eSrcDummy[ei] = i;
            eDstDummy[ei] = j;
            ei++;
          }
        }
      }
      const eaDummy = new Float32Array(42 * Fe);
      const pDummy = new Float32Array(Fp);
      for (let warm = 0; warm < 4; warm++) {
        predictSingleGlobalGnnSample(model, winDummy, eSrcDummy, eDstDummy, eaDummy, pDummy, 5.0);
      }
    }

    modelCache.set(binPath, { mtimeMs: stat.mtimeMs, model });
    return model;
  } catch {
    return null;
  }
}

export function predictSingleGlobalGnnSample(
  model: LoadedGlobalGnnModel,
  windowFlat: Float32Array, // [W * N * F_NODE]
  edgeIndexSrc: Int32Array, // [E]
  edgeIndexDst: Int32Array, // [E]
  edgeAttrFlat: Float32Array, // [E * F_EDGE]
  phys: Float32Array, // [F_PHYS]
  clrskyNext: number
): GlobalGnnPrediction {
  const { dModel, numLayers, numHeads, headDim } = model;
  const W = model.meta.architecture.window_len;
  const N = model.meta.architecture.num_nodes;
  const Fn = model.meta.architecture.f_node;
  const Fe = model.meta.architecture.f_edge;
  const Fp = model.meta.architecture.f_phys;
  const E = edgeIndexSrc.length;
  const adapterDim = model.adapterDownB.length;
  const sc = N === 7 ? model.scratch7 : undefined;

  // 1. Temporal GRU across W steps (batch-7 vectorized across N=7 nodes when N===7)
  const hNodes = sc ? sc.hNodes : new Float32Array(N * dModel);

  if (N === 7) {
    const gruHidden7 = sc ? sc.gruHidden7 : new Float32Array(7 * dModel);
    gruHidden7.fill(0);
    const tEmb7 = sc ? sc.tEmb7 : new Float32Array(7 * dModel);
    const ihProj7 = sc ? sc.ihProj7 : new Float32Array(7 * 3 * dModel);
    const hhProj7 = sc ? sc.hhProj7 : new Float32Array(7 * 3 * dModel);
    const stride3 = 3 * dModel;
    const total7d = 7 * dModel;

    for (let w = 0; w < W; w++) {
      linearBatch7(
        model.tempInW,
        model.tempInB,
        windowFlat,
        dModel,
        Fn,
        tEmb7,
        w * 7 * Fn
      );
      for (let idx = 0; idx < total7d; idx++) tEmb7[idx] = gelu(tEmb7[idx]);
      linearBatch7(model.gruWih, model.gruBih, tEmb7, stride3, dModel, ihProj7);
      linearBatch7(model.gruWhh, model.gruBhh, gruHidden7, stride3, dModel, hhProj7);

      for (let j = 0; j < 7; j++) {
        const hOff = j * dModel;
        const pOff = j * stride3;
        for (let d = 0; d < dModel; d++) {
          const r = sigmoid(ihProj7[pOff + d] + hhProj7[pOff + d]);
          const z = sigmoid(ihProj7[pOff + dModel + d] + hhProj7[pOff + dModel + d]);
          const n = Math.tanh(
            ihProj7[pOff + 2 * dModel + d] + r * hhProj7[pOff + 2 * dModel + d]
          );
          gruHidden7[hOff + d] = (1 - z) * n + z * gruHidden7[hOff + d];
        }
      }
    }
    hNodes.set(gruHidden7);
    for (let j = 0; j < 7; j++) {
      layerNormInPlace(
        hNodes.subarray(j * dModel, (j + 1) * dModel),
        model.tempNormW,
        model.tempNormB,
        dModel
      );
    }
  } else {
    const xStep = new Float32Array(Fn);
    const tEmb = new Float32Array(dModel);
    const gruHidden = new Float32Array(dModel);
    const ihProj = new Float32Array(3 * dModel);
    const hhProj = new Float32Array(3 * dModel);

    for (let j = 0; j < N; j++) {
      gruHidden.fill(0);
      for (let w = 0; w < W; w++) {
        const base = (w * N + j) * Fn;
        for (let f = 0; f < Fn; f++) xStep[f] = windowFlat[base + f];
        linearVec(model.tempInW, model.tempInB, xStep, dModel, Fn, tEmb);
        for (let d = 0; d < dModel; d++) tEmb[d] = gelu(tEmb[d]);

        linearVec(model.gruWih, model.gruBih, tEmb, 3 * dModel, dModel, ihProj);
        linearVec(model.gruWhh, model.gruBhh, gruHidden, 3 * dModel, dModel, hhProj);

        for (let d = 0; d < dModel; d++) {
          const r = sigmoid(ihProj[d] + hhProj[d]);
          const z = sigmoid(ihProj[dModel + d] + hhProj[dModel + d]);
          const n = Math.tanh(ihProj[2 * dModel + d] + r * hhProj[2 * dModel + d]);
          gruHidden[d] = (1 - z) * n + z * gruHidden[d];
        }
      }
      const dst = hNodes.subarray(j * dModel, (j + 1) * dModel);
      dst.set(gruHidden);
      layerNormInPlace(dst, model.tempNormW, model.tempNormB, dModel);
    }
  }

  // 2. Stacked PhysicsTrustGATv2 layers
  const qAll = sc ? sc.qAll : new Float32Array(N * dModel);
  const kNodeAll = sc ? sc.kNodeAll : new Float32Array(N * dModel);
  const vNodeAll = sc ? sc.vNodeAll : new Float32Array(N * dModel);
  const kVec = sc ? sc.kVec : new Float32Array(dModel);
  const vVec = sc ? sc.vVec : new Float32Array(dModel);
  const edgeSlice = sc ? sc.edgeSlice : new Float32Array(Fe);
  const egMid = sc ? sc.egMid : new Float32Array(24);
  const egOut = sc ? sc.egOut : new Float32Array(1);
  const agg = sc ? sc.agg : new Float32Array(N * dModel);
  const deg = sc ? sc.deg : new Float32Array(N);
  const outAll7 = sc ? sc.outAll7 : N === 7 ? new Float32Array(7 * dModel) : null;
  const ffnMidAll7 = sc ? sc.ffnMidAll7 : N === 7 ? new Float32Array(7 * dModel * 2) : null;
  const outBuf = N === 7 ? null : new Float32Array(dModel);
  const ffnMid = N === 7 ? null : new Float32Array(dModel * 2);
  const ffnOut = N === 7 ? null : new Float32Array(dModel);

  for (let l = 0; l < numLayers; l++) {
    const L = model.layers[l];
    agg.fill(0);
    deg.fill(0);

    // Precompute q_proj and node-part of k_proj / v_proj once per N nodes (exact factoring)
    if (N === 7) {
      linearBatch7(L.qW, L.qB, hNodes, dModel, dModel, qAll);
      linearBatch7(L.kNodeW, L.kB, hNodes, dModel, dModel, kNodeAll);
      linearBatch7(L.vNodeW, L.vB, hNodes, dModel, dModel, vNodeAll);
    } else {
      for (let j = 0; j < N; j++) {
        const hSlice = hNodes.subarray(j * dModel, (j + 1) * dModel);
        linearVec(L.qW, L.qB, hSlice, dModel, dModel, qAll.subarray(j * dModel, (j + 1) * dModel));
        linearVec(
          L.kNodeW,
          L.kB,
          hSlice,
          dModel,
          dModel,
          kNodeAll.subarray(j * dModel, (j + 1) * dModel)
        );
        linearVec(
          L.vNodeW,
          L.vB,
          hSlice,
          dModel,
          dModel,
          vNodeAll.subarray(j * dModel, (j + 1) * dModel)
        );
      }
    }

    for (let e = 0; e < E; e++) {
      const sIdx = edgeIndexSrc[e];
      const dIdx = edgeIndexDst[e];
      const eOff = e * Fe;
      for (let f = 0; f < Fe; f++) {
        edgeSlice[f] = edgeAttrFlat[eOff + f];
      }

      const qBase = dIdx * dModel;
      const srcBase = sIdx * dModel;
      linearAddVec(L.kEdgeW, kNodeAll, srcBase, edgeSlice, dModel, Fe, kVec);
      linearAddVec(L.vEdgeW, vNodeAll, srcBase, edgeSlice, dModel, Fe, vVec);

      linearVec(L.eg0W, L.eg0B, edgeSlice, 24, Fe, egMid);
      for (let m = 0; m < 24; m++) egMid[m] = gelu(egMid[m]);
      linearVec(L.eg2W, L.eg2B, egMid, 1, 24, egOut);
      const gate = sigmoid(egOut[0]);

      let attnMean = 0;
      const aggBase = dIdx * dModel;
      for (let hd = 0; hd < numHeads; hd++) {
        let dotScore = 0;
        const hdOff = hd * headDim;
        for (let k = 0; k < headDim; k++) {
          const sumQk = qAll[qBase + hdOff + k] + kVec[hdOff + k];
          const lrelu = sumQk >= 0 ? sumQk : 0.2 * sumQk;
          dotScore += lrelu * L.attnVec[hdOff + k];
        }
        const aw = sigmoid(dotScore) * gate;
        attnMean += aw;
        for (let k = 0; k < headDim; k++) {
          agg[aggBase + hdOff + k] += vVec[hdOff + k] * aw;
        }
      }
      deg[dIdx] += attnMean / numHeads;
    }

    if (N === 7 && outAll7 && ffnMidAll7) {
      const total7d = 7 * dModel;
      const total7d2 = total7d * 2;
      for (let j = 0; j < 7; j++) {
        const dj = Math.max(1, deg[j]);
        const base = j * dModel;
        for (let d = 0; d < dModel; d++) agg[base + d] /= dj;
      }
      linearBatch7(L.outW, L.outB, agg, dModel, dModel, outAll7);
      for (let i = 0; i < total7d; i++) hNodes[i] += outAll7[i];
      for (let j = 0; j < 7; j++) {
        layerNormInPlace(hNodes.subarray(j * dModel, (j + 1) * dModel), L.norm1W, L.norm1B, dModel);
      }
      linearBatch7(L.ffn0W, L.ffn0B, hNodes, dModel * 2, dModel, ffnMidAll7);
      for (let i = 0; i < total7d2; i++) ffnMidAll7[i] = gelu(ffnMidAll7[i]);
      linearBatch7(L.ffn2W, L.ffn2B, ffnMidAll7, dModel, dModel * 2, outAll7);
      for (let i = 0; i < total7d; i++) hNodes[i] += outAll7[i];
      for (let j = 0; j < 7; j++) {
        layerNormInPlace(hNodes.subarray(j * dModel, (j + 1) * dModel), L.norm2W, L.norm2B, dModel);
      }
    } else if (outBuf && ffnMid && ffnOut) {
      for (let j = 0; j < N; j++) {
        const dj = Math.max(1, deg[j]);
        const nodeSlice = hNodes.subarray(j * dModel, (j + 1) * dModel);
        const aggSlice = agg.subarray(j * dModel, (j + 1) * dModel);
        for (let d = 0; d < dModel; d++) aggSlice[d] /= dj;

        linearVec(L.outW, L.outB, aggSlice, dModel, dModel, outBuf);
        for (let d = 0; d < dModel; d++) nodeSlice[d] += outBuf[d];
        layerNormInPlace(nodeSlice, L.norm1W, L.norm1B, dModel);

        linearVec(L.ffn0W, L.ffn0B, nodeSlice, dModel * 2, dModel, ffnMid);
        for (let d = 0; d < dModel * 2; d++) ffnMid[d] = gelu(ffnMid[d]);
        linearVec(L.ffn2W, L.ffn2B, ffnMid, dModel, dModel * 2, ffnOut);
        for (let d = 0; d < dModel; d++) nodeSlice[d] += ffnOut[d];
        layerNormInPlace(nodeSlice, L.norm2W, L.norm2B, dModel);
      }
    }
  }

  // 3. Target node 0 + Residual Local Adapter
  const hTgt = sc ? sc.hTgt : new Float32Array(dModel);
  hTgt.set(hNodes.subarray(0, dModel));
  const adDown = sc ? sc.adDown : new Float32Array(adapterDim);
  const adUp = sc ? sc.adUp : new Float32Array(dModel);
  linearVec(model.adapterDownW, model.adapterDownB, hTgt, adapterDim, dModel, adDown);
  for (let i = 0; i < adapterDim; i++) adDown[i] = gelu(adDown[i]);
  linearVec(model.adapterUpW, model.adapterUpB, adDown, dModel, adapterDim, adUp);
  for (let i = 0; i < dModel; i++) hTgt[i] += adUp[i];

  // 4. Head MLP + Monotonic Quantile Readout
  const headIn = sc ? sc.headIn : new Float32Array(dModel + Fp);
  headIn.set(hTgt, 0);
  headIn.set(phys, dModel);

  const zMid = sc ? sc.zMid : new Float32Array(dModel);
  linearVec(model.head0W, model.head0B, headIn, dModel, dModel + Fp, zMid);
  for (let i = 0; i < dModel; i++) zMid[i] = gelu(zMid[i]);
  layerNormInPlace(zMid, model.head2W, model.head2B, dModel);

  const z = sc ? sc.z : new Float32Array(128);
  linearVec(model.head3W, model.head3B, zMid, 128, dModel, z);
  for (let i = 0; i < 128; i++) z[i] = gelu(z[i]);

  const rawQ = sc ? sc.rawQ : new Float32Array(4);
  linearVec(model.ktHeadW, model.ktHeadB, z, 4, 128, rawQ);
  const stormLogitArr = sc ? sc.stormLogitArr : new Float32Array(1);
  linearVec(model.stormHeadW, model.stormHeadB, z, 1, 128, stormLogitArr);

  const baseKt = phys[0];
  const kt50 = clamp(baseKt + rawQ[2], 0.02, 1.06);
  const d268 = softplus(rawQ[1]) + 1e-3;
  const d10 = softplus(rawQ[0]) + 1e-3;
  const d90 = softplus(rawQ[3]) + 1e-3;

  const kt268 = clamp(kt50 - d268, 0.02, 1.06);
  const kt10 = clamp(kt268 - d10, 0.02, 1.06);
  const kt90 = clamp(kt50 + d90, 0.02, 1.06);

  return {
    p10: kt10 * clrskyNext,
    q268: kt268 * clrskyNext,
    p50: kt50 * clrskyNext,
    p90: kt90 * clrskyNext,
    stormProb: sigmoid(stormLogitArr[0]),
  };
}

function bearingRad(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const p1 = lat1 * TO_RAD;
  const p2 = lat2 * TO_RAD;
  const dl = (lng2 - lng1) * TO_RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const p1 = lat1 * TO_RAD;
  const p2 = lat2 * TO_RAD;
  const dp = (lat2 - lat1) * TO_RAD;
  const dl = (lng2 - lng1) * TO_RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function tetensVpdKpa(t2mC: number, rhPct: number): number {
  const es = 0.61078 * Math.exp((17.27 * t2mC) / Math.max(10, t2mC + 237.3));
  return Math.max(0, es * Math.max(0, 1 - rhPct / 100));
}

function doyFromYyyymmdd(d: string): number {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6)) - 1;
  const day = Number(d.slice(6, 8));
  const dt = Date.UTC(y, m, day);
  return Math.floor((dt - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

function resolveCloudPct(r: DailyWeatherRow, prefer23h: boolean): number {
  if (prefer23h && r.eveCloud23Pct !== undefined) return r.eveCloud23Pct;
  if (r.eveCloudPct !== undefined) return r.eveCloudPct;
  if (r.cloudAmt !== undefined) return r.cloudAmt;
  return (1 - clamp(r.kt, 0, 1)) * 100;
}

function nextYyyymmddString(yyyymmdd: string): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  return new Date(Date.UTC(y, m, d + 1)).toISOString().slice(0, 10).replace(/-/g, "");
}

function buildStaticRingTopology(nodes: readonly ClimateGraphNode[]) {
  const N = nodes.length;
  const E = N * (N - 1);
  const edgeSrc = new Int32Array(E);
  const edgeDst = new Int32Array(E);
  const edgeStaticDist = new Float32Array(E);
  const edgeStaticBrg = new Float32Array(E);
  const edgeStaticSin = new Float32Array(E);
  const edgeStaticCos = new Float32Array(E);
  const edgeStaticElev = new Float32Array(E);
  const edgeStaticToTgt = new Float32Array(E);

  let eCounter = 0;
  for (let dst = 0; dst < N; dst++) {
    const dn = nodes[dst];
    for (let src = 0; src < N; src++) {
      if (src === dst) continue;
      const sn = nodes[src];
      const brg = bearingRad(dn.lat, dn.lng, sn.lat, sn.lng);
      edgeSrc[eCounter] = src;
      edgeDst[eCounter] = dst;
      edgeStaticDist[eCounter] = haversineKm(dn.lat, dn.lng, sn.lat, sn.lng) / 150;
      edgeStaticBrg[eCounter] = brg;
      edgeStaticSin[eCounter] = Math.sin(brg);
      edgeStaticCos[eCounter] = Math.cos(brg);
      edgeStaticElev[eCounter] = (sn.elevationM - dn.elevationM) / 2000;
      edgeStaticToTgt[eCounter] = dst === 0 ? 1 : 0;
      eCounter++;
    }
  }

  const neighborBrgToTarget = nodes.map((n) =>
    bearingRad(nodes[0].lat, nodes[0].lng, n.lat, n.lng)
  );
  return {
    E,
    edgeSrc,
    edgeDst,
    edgeStaticDist,
    edgeStaticBrg,
    edgeStaticSin,
    edgeStaticCos,
    edgeStaticElev,
    edgeStaticToTgt,
    neighborBrgToTarget,
  };
}

function computeCausalSoilProxy(
  nodesCount: number,
  rowsByNode: readonly DailyWeatherRow[][],
  T: number
): Float32Array[] {
  const soilProxy = Array.from({ length: nodesCount }, () => new Float32Array(T));
  for (let j = 0; j < nodesCount; j++) {
    let sVal = 0.22;
    for (let t = 0; t < T; t++) {
      const pr = rowsByNode[j][t]?.precip ?? 0;
      sVal = clamp(0.9 * sVal + 0.015 * pr, 0.05, 0.65);
      soilProxy[j][t] = sVal;
    }
  }
  return soilProxy;
}

function fillSingleOriginFeatures(
  t: number,
  nextDateYyyymmdd: string,
  clrNextByNode: readonly number[],
  nodes: readonly ClimateGraphNode[],
  rowsByNode: readonly DailyWeatherRow[][],
  soilProxy: readonly Float32Array[],
  topo: ReturnType<typeof buildStaticRingTopology>,
  windowFlat: Float32Array,
  edgeAttrFlat: Float32Array,
  phys: Float32Array
): void {
  const N = nodes.length;
  const doyNext = doyFromYyyymmdd(nextDateYyyymmdd);
  const angNext = (2 * Math.PI * doyNext) / 365.25;
  const sinDoyN = Math.sin(angNext);
  const cosDoyN = Math.cos(angNext);

  for (let wi = 0; wi < GLOBAL_GNN_WINDOW_LEN; wi++) {
    const s = t - GLOBAL_GNN_WINDOW_LEN + 1 + wi;
    for (let j = 0; j < N; j++) {
      const r = rowsByNode[j][s];
      const r1 = rowsByNode[j][Math.max(0, s - 1)];
      const r2 = rowsByNode[j][Math.max(0, s - 2)];
      const wdRad = r.wd10m * TO_RAD;
      const ewdRad = (r.eveWdDeg ?? r.wd10m) * TO_RAD;
      const base = (wi * N + j) * GLOBAL_GNN_F_NODE;

      windowFlat[base + 0] = r.kt;
      windowFlat[base + 1] = r.kt - r1.kt;
      windowFlat[base + 2] = r.kt - r2.kt;
      windowFlat[base + 3] = (r.kt + r1.kt + r2.kt) / 3;
      windowFlat[base + 4] = r.clrsky / 10;
      windowFlat[base + 5] = clrNextByNode[j] / 10;
      windowFlat[base + 6] = sinDoyN;
      windowFlat[base + 7] = cosDoyN;
      windowFlat[base + 8] = Math.abs(nodes[j].lat) / 90;
      windowFlat[base + 9] = nodes[j].elevationM / 3000;
      windowFlat[base + 10] = r.t2m / 35;
      windowFlat[base + 11] = r.rh2m / 100;
      windowFlat[base + 12] = tetensVpdKpa(r.t2m, r.rh2m) / 4;
      windowFlat[base + 13] = soilProxy[j][s];
      windowFlat[base + 14] = Math.log1p(Math.max(0, r.precip)) / 3;
      windowFlat[base + 15] = r.ws10m / 15;
      windowFlat[base + 16] = Math.sin(wdRad);
      windowFlat[base + 17] = Math.cos(wdRad);
      windowFlat[base + 18] = resolveCloudPct(r, false) / 100;
      windowFlat[base + 19] = resolveCloudPct(r, true) / 100;
      windowFlat[base + 20] = (r.eveRhPct ?? r.rh2m) / 100;
      windowFlat[base + 21] = (r.eveWsMs ?? r.ws10m) / 15;
      windowFlat[base + 22] = Math.sin(ewdRad);
      windowFlat[base + 23] = clamp((r.evePsTrendHpa ?? 0) / 10, -1.5, 1.5);
      windowFlat[base + 24] = Math.cos(ewdRad);
      windowFlat[base + 25] = ((r.ps ?? 90) - 90) / 20;
    }
  }

  for (let e = 0; e < topo.E; e++) {
    const rs = rowsByNode[topo.edgeSrc[e]][t];
    const rd = rowsByNode[topo.edgeDst[e]][t];
    const brg = topo.edgeStaticBrg[e];
    const dWd = rd.wd10m * TO_RAD;
    const dEwd = (rd.eveWdDeg ?? rd.wd10m) * TO_RAD;
    const off = e * GLOBAL_GNN_F_EDGE;
    edgeAttrFlat[off + 0] = topo.edgeStaticDist[e];
    edgeAttrFlat[off + 1] = topo.edgeStaticSin[e];
    edgeAttrFlat[off + 2] = topo.edgeStaticCos[e];
    edgeAttrFlat[off + 3] = topo.edgeStaticElev[e];
    edgeAttrFlat[off + 4] = Math.max(0, Math.cos(dWd - brg));
    edgeAttrFlat[off + 5] = Math.max(0, Math.cos(dEwd - brg));
    edgeAttrFlat[off + 6] = rs.kt - rd.kt;
    edgeAttrFlat[off + 7] = (resolveCloudPct(rs, true) - resolveCloudPct(rd, true)) / 100;
    edgeAttrFlat[off + 8] = Math.max(0, Math.sin(dEwd)) * ((rs.eveRhPct ?? rs.rh2m) / 100);
    edgeAttrFlat[off + 9] = topo.edgeStaticToTgt[e];
  }

  const rt0 = rowsByNode[0][t];
  const rt1 = rowsByNode[0][Math.max(0, t - 1)];
  const rt2 = rowsByNode[0][Math.max(0, t - 2)];
  const clrNext0 = clrNextByNode[0];
  const rt0Ec23 = resolveCloudPct(rt0, true);
  const rt0Erh = rt0.eveRhPct ?? rt0.rh2m;
  const rt0Ewd = rt0.eveWdDeg ?? rt0.wd10m;

  let upKtNum = 0;
  let upKtDen = 0;
  let upEcNum = 0;
  let upErhNum = 0;
  let upEDen = 0;
  let meanKt = 0;
  let meanEc = 0;
  let meanErh = 0;
  const nbrKts: number[] = [];

  for (let j = 1; j < N; j++) {
    const rj = rowsByNode[j][t];
    const brgJ = topo.neighborBrgToTarget[j];
    const wd = Math.max(0, Math.cos(rt0.wd10m * TO_RAD - brgJ));
    const we = Math.max(0, Math.cos(rt0Ewd * TO_RAD - brgJ));
    const ec23 = resolveCloudPct(rj, true);
    const erh = rj.eveRhPct ?? rj.rh2m;

    upKtNum += wd * rj.kt;
    upKtDen += wd;
    upEcNum += we * ec23;
    upErhNum += we * erh;
    upEDen += we;
    meanKt += rj.kt;
    meanEc += ec23;
    meanErh += erh;
    nbrKts.push(rj.kt);
  }

  const avgNKt = meanKt / (N - 1);
  const nKtStd = Math.sqrt(
    nbrKts.reduce((acc, k) => acc + (k - avgNKt) ** 2, 0) / (N - 1)
  );
  const upKt = upKtDen > 1e-4 ? upKtNum / upKtDen : avgNKt;
  const upEc23 = upEDen > 1e-4 ? upEcNum / upEDen : meanEc / (N - 1);
  const upErh = upEDen > 1e-4 ? upErhNum / upEDen : meanErh / (N - 1);

  phys[0] = rt0.kt;
  phys[1] = rt0.kt - rt1.kt;
  phys[2] = (rt0.kt + rt1.kt + rt2.kt) / 3;
  phys[3] = clrNext0 / 10;
  phys[4] = 1 - rt0Ec23 / 100;
  phys[5] = ((1 - rt0Ec23 / 100) * clrNext0) / 10;
  phys[6] = rt0Erh / 100;
  phys[7] = clamp((rt0.evePsTrendHpa ?? 0) / 10, -1.5, 1.5);
  phys[8] = upKt;
  phys[9] = avgNKt;
  phys[10] = upKt - rt0.kt;
  phys[11] = nKtStd;
  phys[12] = upEc23 / 100;
  phys[13] = ((1 - upEc23 / 100) * clrNext0) / 10;
  phys[14] = upErh / 100;
  phys[15] = Math.max(0, Math.sin(rt0Ewd * TO_RAD)) * (upErh / 100);
}

export function runGlobalGnnOverAlignedSeries(
  model: LoadedGlobalGnnModel,
  nodes: readonly ClimateGraphNode[],
  alignedDates: readonly string[],
  rowsByNode: readonly DailyWeatherRow[][]
): Array<GlobalGnnPrediction | null> {
  const T = alignedDates.length;
  const N = nodes.length;
  const out: Array<GlobalGnnPrediction | null> = new Array(T).fill(null);
  if (N !== GLOBAL_GNN_NUM_NODES || T < GLOBAL_GNN_WINDOW_LEN + 1) return out;

  const soilProxy = computeCausalSoilProxy(N, rowsByNode, T);
  const topo = buildStaticRingTopology(nodes);

  const windowFlat = new Float32Array(GLOBAL_GNN_WINDOW_LEN * N * GLOBAL_GNN_F_NODE);
  const edgeAttrFlat = new Float32Array(topo.E * GLOBAL_GNN_F_EDGE);
  const phys = new Float32Array(GLOBAL_GNN_F_PHYS);

  for (let t = GLOBAL_GNN_WINDOW_LEN - 1; t < T - 1; t++) {
    const clrNextByNode = rowsByNode.map((rows) => rows[t + 1].clrsky);
    fillSingleOriginFeatures(
      t,
      alignedDates[t + 1],
      clrNextByNode,
      nodes,
      rowsByNode,
      soilProxy,
      topo,
      windowFlat,
      edgeAttrFlat,
      phys
    );
    out[t] = predictSingleGlobalGnnSample(
      model,
      windowFlat,
      topo.edgeSrc,
      topo.edgeDst,
      edgeAttrFlat,
      phys,
      clrNextByNode[0]
    );
  }

  return out;
}

export function predictLatestGlobalGnnTomorrow(
  nodes: readonly ClimateGraphNode[],
  seriesByNode: Record<string, DailyWeatherRow[]>,
  variant: "zeroshot" | "denver_adapter" = "zeroshot",
  weightsDir?: string
): (GlobalGnnPrediction & { inferenceMs: number; variant: "zeroshot" | "denver_adapter" }) | null {
  if (nodes.length !== GLOBAL_GNN_NUM_NODES) return null;

  let usedVariant: "zeroshot" | "denver_adapter" = variant;
  let model = loadGlobalGnnModel(variant, weightsDir);
  if (!model && variant === "denver_adapter") {
    usedVariant = "zeroshot";
    model = loadGlobalGnnModel("zeroshot", weightsDir);
  }
  if (!model) return null;

  const nodeMaps = nodes.map((n) => {
    const m = new Map<string, DailyWeatherRow>();
    for (const r of seriesByNode[n.id] ?? []) {
      m.set(r.date, r);
    }
    return m;
  });

  const targetSortedDates = Array.from(nodeMaps[0].keys()).sort();
  const commonDates = targetSortedDates.filter((d) => nodeMaps.every((m) => m.has(d)));
  if (commonDates.length < GLOBAL_GNN_WINDOW_LEN) return null;

  const alignedRows = nodeMaps.map((m) => commonDates.map((d) => m.get(d)!));
  const T = commonDates.length;
  const t = T - 1;
  const soilProxy = computeCausalSoilProxy(GLOBAL_GNN_NUM_NODES, alignedRows, T);
  const topo = buildStaticRingTopology(nodes);

  const windowFlat = new Float32Array(GLOBAL_GNN_WINDOW_LEN * GLOBAL_GNN_NUM_NODES * GLOBAL_GNN_F_NODE);
  const edgeAttrFlat = new Float32Array(topo.E * GLOBAL_GNN_F_EDGE);
  const phys = new Float32Array(GLOBAL_GNN_F_PHYS);

  const clrNextByNode = alignedRows.map((rows) => rows[t].clrsky);
  fillSingleOriginFeatures(
    t,
    nextYyyymmddString(commonDates[t]),
    clrNextByNode,
    nodes,
    alignedRows,
    soilProxy,
    topo,
    windowFlat,
    edgeAttrFlat,
    phys
  );

  const t0 = performance.now();
  const pred = predictSingleGlobalGnnSample(
    model,
    windowFlat,
    topo.edgeSrc,
    topo.edgeDst,
    edgeAttrFlat,
    phys,
    clrNextByNode[0]
  );
  const inferenceMs = Number(Math.max(0.01, performance.now() - t0).toFixed(2));
  return { ...pred, inferenceMs, variant: usedVariant };
}
