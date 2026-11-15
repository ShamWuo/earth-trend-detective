import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DENVER_CLIMATE_NODES,
  type DailyWeatherRow,
} from "../denverClimateGraph";
import {
  loadGlobalGnnModel,
  predictSingleGlobalGnnSample,
  runGlobalGnnOverAlignedSeries,
} from "../globalGnnInference";

function makeSyntheticSevenNodeSeries(days = 26): DailyWeatherRow[][] {
  return DENVER_CLIMATE_NODES.map((n, j) => {
    const rows: DailyWeatherRow[] = [];
    for (let i = 0; i < days; i++) {
      const yyyymmdd = `202501${String(i + 1).padStart(2, "0")}`;
      const clr = 4.2 + 0.04 * i + 0.0001 * n.elevationM;
      const kt = Math.max(0.15, Math.min(0.95, 0.65 + 0.16 * Math.sin(i * 0.37 + j * 0.2)));
      rows.push({
        date: yyyymmdd,
        allsky: Number((kt * clr).toFixed(4)),
        clrsky: Number(clr.toFixed(4)),
        kt: Number(kt.toFixed(4)),
        t2m: 4 + 5 * Math.sin(i * 0.2),
        rh2m: 48,
        precip: i % 8 === 0 ? 3.2 : 0,
        ws10m: 4.5,
        wd10m: 265,
        ps: 83.2,
        eveCloudPct: 32,
        eveCloud23Pct: 36,
        eveRhPct: 51,
        eveWsMs: 4.2,
        eveWdDeg: 270,
        evePsTrendHpa: i % 8 === 0 ? -1.4 : 0.5,
      });
    }
    return rows;
  });
}

describe("Global Spatiotemporal GNN (etg-global-gnn-v3) CPU Parity & Causality", () => {
  it("loads fp16 weights, matches PyTorch golden sample within fp16 tolerance, and runs fast on CPU", () => {
    const binPath = path.join(process.cwd(), "ml", "weights", "etg-global-gnn-v3.bin");
    if (!fs.existsSync(binPath)) {
      return;
    }

    const model = loadGlobalGnnModel("zeroshot");
    expect(model).not.toBeNull();
    const loaded = model!;
    const golden = loaded.meta.golden_parity_check!;
    expect(golden).toBeDefined();

    const W = loaded.meta.architecture.window_len;
    const N = loaded.meta.architecture.num_nodes;
    const Fn = loaded.meta.architecture.f_node;
    const Fe = loaded.meta.architecture.f_edge;
    const Fp = loaded.meta.architecture.f_phys;
    const E = golden.edge_index[0].length;

    const winFlat = new Float32Array(W * N * Fn);
    for (let wi = 0; wi < W; wi++) {
      for (let j = 0; j < N; j++) {
        for (let f = 0; f < Fn; f++) {
          winFlat[(wi * N + j) * Fn + f] = golden.window[wi][j][f];
        }
      }
    }
    const edgeSrc = Int32Array.from(golden.edge_index[0]);
    const edgeDst = Int32Array.from(golden.edge_index[1]);
    const edgeAttrFlat = new Float32Array(E * Fe);
    for (let e = 0; e < E; e++) {
      for (let f = 0; f < Fe; f++) {
        edgeAttrFlat[e * Fe + f] = golden.edge_attr[e][f];
      }
    }
    const phys = Float32Array.from(golden.phys.slice(0, Fp));

    let bestElapsedMs = Number.POSITIVE_INFINITY;
    let pred = predictSingleGlobalGnnSample(
      loaded,
      winFlat,
      edgeSrc,
      edgeDst,
      edgeAttrFlat,
      phys,
      golden.clrsky_next
    );
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      pred = predictSingleGlobalGnnSample(
        loaded,
        winFlat,
        edgeSrc,
        edgeDst,
        edgeAttrFlat,
        phys,
        golden.clrsky_next
      );
      bestElapsedMs = Math.min(bestElapsedMs, performance.now() - t0);
    }

    expect(bestElapsedMs).toBeLessThan(75);
    expect(pred.p10).toBeLessThanOrEqual(pred.q268 + 1e-4);
    expect(pred.q268).toBeLessThanOrEqual(pred.p50 + 1e-4);
    expect(pred.p50).toBeLessThanOrEqual(pred.p90 + 1e-4);

    const expectedQ = golden.expected_quantiles;
    expect(Math.abs(pred.p10 - expectedQ[0])).toBeLessThan(0.025);
    expect(Math.abs(pred.q268 - expectedQ[1])).toBeLessThan(0.025);
    expect(Math.abs(pred.p50 - expectedQ[2])).toBeLessThan(0.025);
    expect(Math.abs(pred.p90 - expectedQ[3])).toBeLessThan(0.025);
    expect(Math.abs(pred.stormProb - golden.expected_storm_prob)).toBeLessThan(0.01);
  });

  it("enforces strict causality when future rows are spiked", () => {
    const binPath = path.join(process.cwd(), "ml", "weights", "etg-global-gnn-v3.bin");
    if (!fs.existsSync(binPath)) {
      return;
    }

    const model = loadGlobalGnnModel("zeroshot")!;
    const baseSeries = makeSyntheticSevenNodeSeries(26);
    const dates = baseSeries[0].map((r) => r.date);
    const basePreds = runGlobalGnnOverAlignedSeries(model, DENVER_CLIMATE_NODES, dates, baseSeries);

    const spikedSeries = baseSeries.map((rows) =>
      rows.map((r, idx) =>
        idx >= 18
          ? {
              ...r,
              allsky: 0.05,
              kt: 0.01,
              t2m: -40,
              precip: 99,
              eveCloud23Pct: 100,
              evePsTrendHpa: -9.5,
            }
          : r
      )
    );
    const spikedPreds = runGlobalGnnOverAlignedSeries(
      model,
      DENVER_CLIMATE_NODES,
      dates,
      spikedSeries
    );

    // Predictions at origins t = 6..16 predict days 7..17 (< 18) -> must match to 0.000000
    for (let t = 6; t <= 16; t++) {
      expect(basePreds[t]).not.toBeNull();
      expect(spikedPreds[t]).not.toBeNull();
      expect(Math.abs(basePreds[t]!.p50 - spikedPreds[t]!.p50)).toBe(0);
      expect(Math.abs(basePreds[t]!.q268 - spikedPreds[t]!.q268)).toBe(0);
      expect(Math.abs(basePreds[t]!.stormProb - spikedPreds[t]!.stormProb)).toBe(0);
    }
  });
});
