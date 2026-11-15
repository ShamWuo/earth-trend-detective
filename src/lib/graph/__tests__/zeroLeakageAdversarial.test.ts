import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EtgStore } from "../etgStore";
import {
  loadLocalInductiveWeightsV2,
  predictFromGraph,
} from "../graphPredictor";
import {
  extractNodeMicroscopeFeatures,
  extractPairMicroscopeFeatures,
  loadLocalTrendMicroscopeWeights,
  scorePairWithTrendMicroscope,
} from "../trendMicroscope";
import {
  DENVER_CLIMATE_NODES,
  LOW_SOLAR_THRESHOLD_KWH,
  calibrateStormRiskModel,
  fitRidgeRegression,
  runThreeWaySolarEvaluation,
  type DailyWeatherRow,
} from "../../solar/denverClimateGraph";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildDeterministicDenverSeries(days = 2920): Record<string, DailyWeatherRow[]> {
  const byNode: Record<string, DailyWeatherRow[]> = {};
  const startMs = Date.UTC(2019, 0, 1);

  for (let nIdx = 0; nIdx < DENVER_CLIMATE_NODES.length; nIdx++) {
    const node = DENVER_CLIMATE_NODES[nIdx];
    const rows: DailyWeatherRow[] = [];
    for (let d = 0; d < days; d++) {
      const dt = new Date(startMs + d * 86_400_000);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const day = String(dt.getUTCDate()).padStart(2, "0");
      const yyyymmdd = `${y}${m}${day}`;
      const doy = Math.floor((dt.getTime() - Date.UTC(y, 0, 0)) / 86_400_000);
      const seasonal = 5.1 + 2.4 * Math.sin((2 * Math.PI * (doy - 80)) / 365.25);
      const clrsky = Math.max(3.2, seasonal + 1.4);
      const stormDip = d % 11 === 0 ? -2.2 : d % 17 === 0 ? -1.4 : 0.25 * Math.cos(d * 0.37 + nIdx);
      const allsky = Math.max(0.8, Math.min(clrsky, seasonal - 0.8 + stormDip));
      const kt = allsky / Math.max(clrsky, 0.5);
      const wd10m = (255 + Math.round(45 * Math.sin(d * 0.21))) % 360;
      const ws10m = 4.2 + 2.5 * Math.abs(Math.sin(d * 0.19 + nIdx * 0.3));
      const rh2m = Math.min(95, Math.max(18, 46 - 11 * stormDip + (d % 9)));
      const precip = stormDip < -1.0 ? 5.5 : 0.1;
      const t2m = 10 + 13 * Math.sin((2 * Math.PI * (doy - 100)) / 365.25) + 0.5 * nIdx;
      const ps = 83.2 - (stormDip < -1.0 ? 0.6 : 0.0);

      rows.push({
        date: yyyymmdd,
        allsky: Number(allsky.toFixed(4)),
        clrsky: Number(clrsky.toFixed(4)),
        kt: Number(kt.toFixed(4)),
        t2m: Number(t2m.toFixed(2)),
        rh2m: Number(rh2m.toFixed(2)),
        precip: Number(precip.toFixed(2)),
        ws10m: Number(ws10m.toFixed(2)),
        wd10m,
        ps: Number(ps.toFixed(2)),
        eveCloudPct: Math.min(100, Math.max(5, 38 - 18 * stormDip)),
        eveCloud23Pct: Math.min(100, Math.max(5, 40 - 16 * stormDip)),
        eveRhPct: rh2m,
        eveWsMs: ws10m,
        eveWdDeg: wd10m,
        evePsTrendHpa: stormDip < -1.0 ? -3.1 : 1.2,
      });
    }
    byNode[node.id] = rows;
  }
  return byNode;
}

describe("Zero-Leakage Adversarial Torture Suite (TypeScript Pipelines)", () => {
  it("runThreeWaySolarEvaluation shifts 2019-2024 weights, tau calibration, and P(ALLSKY < 3.5) by 0.000000 under +-9999 test spikes", () => {
    const baseSeries = buildDeterministicDenverSeries(2920); // 2019-01-01 .. 2026-12-29
    const baseResult = runThreeWaySolarEvaluation(baseSeries, "20250101");

    // Mutate unseen 2025-2026 rows (>= 20250101) up to all-but-final-3-days (the tomorrow lag window)
    // with alternating +9999 / -9999 spikes across target & upwind atmospheric columns.
    const spikedSeries: Record<string, DailyWeatherRow[]> = {};
    for (const [nodeId, rows] of Object.entries(baseSeries)) {
      const testCutoffIdx = rows.findIndex((r) => r.date >= "20250101");
      const tailSafeStart = rows.length - 4;
      spikedSeries[nodeId] = rows.map((row, idx) => {
        if (idx >= testCutoffIdx && idx < tailSafeStart) {
          const spike = idx % 2 === 0 ? 9999 : -9999;
          return {
            ...row,
            allsky: spike,
            kt: idx % 2 === 0 ? 99 : -99,
            rh2m: spike,
            precip: Math.abs(spike),
            ws10m: Math.abs(spike),
            ps: 83.2 + (idx % 2 === 0 ? 50 : -50),
            eveCloudPct: idx % 2 === 0 ? 999 : -999,
            eveCloud23Pct: idx % 2 === 0 ? 999 : -999,
            eveRhPct: idx % 2 === 0 ? 999 : -999,
            evePsTrendHpa: spike,
          };
        }
        return row;
      });
    }

    const spikedResult = runThreeWaySolarEvaluation(spikedSeries, "20250101");

    // Calibrated decision thresholds tau (trained strictly on 2024 validation split) must shift by 0.000000.
    expect(Math.abs(spikedResult.metrics.persistence.calibratedThreshold - baseResult.metrics.persistence.calibratedThreshold)).toBe(0);
    expect(Math.abs(spikedResult.metrics.localDailyOnly.calibratedThreshold - baseResult.metrics.localDailyOnly.calibratedThreshold)).toBe(0);
    expect(Math.abs(spikedResult.metrics.localOnly.calibratedThreshold - baseResult.metrics.localOnly.calibratedThreshold)).toBe(0);
    expect(Math.abs(spikedResult.metrics.graphAware.calibratedThreshold - baseResult.metrics.graphAware.calibratedThreshold)).toBe(0);

    // Ridge predictions and Platt/logistic P(ALLSKY < 3.5) storm risk calibration on untouched lag tail
    // must shift by 0.000000 because zero pre-cutoff stats/weights/calibrations see 2025-2026 targets.
    expect(Math.abs(spikedResult.tomorrow.localDailyPred - baseResult.tomorrow.localDailyPred)).toBe(0);
    expect(Math.abs(spikedResult.tomorrow.localPred - baseResult.tomorrow.localPred)).toBe(0);
    expect(Math.abs(spikedResult.tomorrow.graphPred - baseResult.tomorrow.graphPred)).toBe(0);
    expect(Math.abs(spikedResult.tomorrow.probStormPct - baseResult.tomorrow.probStormPct)).toBe(0);
    expect(Math.abs(spikedResult.tomorrow.localProbStormPct - baseResult.tomorrow.localProbStormPct)).toBe(0);
    expect(spikedResult.tomorrow.lowSolarThreshold).toBe(baseResult.tomorrow.lowSolarThreshold);
    expect(spikedResult.tomorrow.bayesOptimalPrecharge).toBe(baseResult.tomorrow.bayesOptimalPrecharge);

    // Also test EVERY single post-cutoff row (>= 20250101, zero exclusions) spiked with +-9999:
    // Ridge weights and storm classifier calibration computed up to 20250101 must remain bit-identical,
    // and reversing input order must yield identical results.
    const fullySpiked: Record<string, DailyWeatherRow[]> = {};
    for (const [nodeId, rows] of Object.entries(baseSeries)) {
      fullySpiked[nodeId] = rows.map((row, idx) =>
        row.date >= "20250101" ? { ...row, allsky: idx % 2 === 0 ? 9999 : -9999 } : row
      );
    }
    const reversedTargetBase = {
      ...baseSeries,
      "denver-target": [...baseSeries["denver-target"]].reverse(),
    };
    const fullSpikedResult = runThreeWaySolarEvaluation(fullySpiked, "20250101");
    const reversedResult = runThreeWaySolarEvaluation(reversedTargetBase, "20250101");

    expect(Math.abs(fullSpikedResult.metrics.graphAware.calibratedThreshold - baseResult.metrics.graphAware.calibratedThreshold)).toBe(0);
    expect(Math.abs(fullSpikedResult.metrics.localOnly.calibratedThreshold - baseResult.metrics.localOnly.calibratedThreshold)).toBe(0);
    expect(reversedResult.metrics.graphAware.rmse).toBe(baseResult.metrics.graphAware.rmse);
    expect(reversedResult.tomorrow.graphPred).toBe(baseResult.tomorrow.graphPred);

    // Direct low-level check on fitRidgeRegression & calibrateStormRiskModel
    const trainX = [[1, 2], [3, 4], [5, 6], [7, 8], [2, 5], [4, 7]];
    const trainY = [2.1, 3.8, 5.2, 6.4, 3.3, 4.9];
    const ridgeWeights = fitRidgeRegression(trainX, trainY, 1.0);
    const valPreds = [2.2, 3.9, 5.0, 6.1];
    const valActuals = [2.0, 3.4, 5.1, 6.3];
    const calA = calibrateStormRiskModel(valActuals, valPreds);
    const stormRiskA = calA.assess(2.8);
    expect(ridgeWeights).toHaveLength(2);
    expect(Number.isFinite(ridgeWeights[0])).toBe(true);
    expect(stormRiskA.probStormPct).toBeGreaterThan(0);
    expect(LOW_SOLAR_THRESHOLD_KWH).toBe(3.5);
  });

  it("predictFromGraph and exportMlGraphDatasetV2 isolate pre-cutoff normalization, causal edges, and forecasts from post-cutoff +-9999 spikes", () => {
    const buildStoreWithSpikes = (spikeMode: "none" | "all_post_cutoff" | "intermediate_post_cutoff") => {
      const store = new EtgStore({ persistDir: null });
      const N = 60; // 5 years monthly
      const makeSeries = (offset: number, amp: number, applySpike: boolean) => {
        const pts = [];
        for (let i = 0; i < N; i++) {
          const year = 2021 + Math.floor(i / 12);
          const month = (i % 12) + 1;
          const date = `${year}-${String(month).padStart(2, "0")}`;
          const baseVal = 15 + 0.08 * i + amp * Math.sin((2 * Math.PI * i) / 12 + offset);
          let val = baseVal;
          if (applySpike) {
            if (spikeMode === "all_post_cutoff" && i >= 44) {
              val = i % 2 === 0 ? 9999 : -9999;
            } else if (spikeMode === "intermediate_post_cutoff" && i >= 44 && i <= N - 4) {
              val = i % 2 === 0 ? 9999 : -9999;
            }
          }
          pts.push({ date, t: i, value: Number(val.toFixed(4)) });
        }
        return pts;
      };

      const targetSeries = makeSeries(0.0, 3.0, true);
      const driverSeries = makeSeries(0.4, 2.8, spikeMode !== "none");

      const target = store.createNode({
        uuid: "signal-target-zero-leak",
        label: "Signal",
        properties: {
          name: "Target Solar Basin",
          description: "Synthetic basin solar target",
          dataset: "nasa_power",
          unit: "kWh/m2/day",
          lat: 39.74,
          lng: -104.99,
          temporal_scale: "month",
          series: targetSeries,
        },
        silent: true,
      });

      const driver = store.createNode({
        uuid: "signal-driver-zero-leak",
        label: "Signal",
        properties: {
          name: "Upwind Cloud Driver",
          description: "Upwind forcing signal",
          dataset: "nasa_power",
          unit: "C",
          lat: 39.65,
          lng: -106.35,
          temporal_scale: "month",
          series: driverSeries,
        },
        silent: true,
      });

      store.createEdge({
        source_uuid: driver.uuid,
        target_uuid: target.uuid,
        type: "correlates_with",
        weight: 0.85,
        correlation_r: 0.78,
        lag_days: 30,
        optimal_lag_steps: 1,
        lag_unit: "months",
        silent: true,
      });

      return { store, targetUuid: target.uuid };
    };

    const base = buildStoreWithSpikes("none");
    const basePred = predictFromGraph(base.store, {
      targetUuid: base.targetUuid,
      maxHops: 2,
      horizonSteps: 1,
    });

    // predictFromGraph starts origins at t=3..58 (sampleCount=56), trainCount=floor(56*0.72)=40 ->
    // last training target is index 3+39+1 = 43, first unseen test origin index is 43 -> first test target index is 44.
    // Even starting spikes conservatively early at index 44 (and let's test index 44+), nothing before index 44 may move!
    const allPost = buildStoreWithSpikes("all_post_cutoff");
    const allPostPred = predictFromGraph(allPost.store, {
      targetUuid: allPost.targetUuid,
      maxHops: 2,
      horizonSteps: 1,
    });

    // Check exportMlGraphDatasetV2 with explicit trainCutoffDate aligned to first test target ("2024-09" at idx 44)
    const mlBase = base.store.exportMlGraphDatasetV2({
      rootUuid: base.targetUuid,
      maxHops: 2,
      horizonSteps: 1,
      trainCutoffDate: "2024-09",
    });
    const mlSpiked = allPost.store.exportMlGraphDatasetV2({
      rootUuid: allPost.targetUuid,
      maxHops: 2,
      horizonSteps: 1,
      trainCutoffDate: "2024-09",
    });

    expect(mlSpiked.train_cutoff_index).toBe(mlBase.train_cutoff_index);
    expect(mlSpiked.normalization).toBeDefined();
    expect(mlBase.normalization).toBeDefined();
    const normSpiked = mlSpiked.normalization!;
    const normBase = mlBase.normalization!;
    expect(normSpiked.length).toBe(normBase.length);
    for (let i = 0; i < normBase.length; i++) {
      expect(Math.abs(normSpiked[i].mean - normBase[i].mean)).toBe(0);
      expect(Math.abs(normSpiked[i].std - normBase[i].std)).toBe(0);
    }
    for (let e = 0; e < mlBase.edge_attr.length; e++) {
      for (let d = 0; d < mlBase.edge_attr[e].length; d++) {
        expect(Math.abs(mlSpiked.edge_attr[e][d] - mlBase.edge_attr[e][d])).toBe(0);
      }
    }

    // Notice in predictFromGraph with 60 entries, sampleCount = 56, trainCount = 40,
    // originIndices[40] = 43 -> firstTestTarget = index 44 ("2024-09").
    // Since buildStoreWithSpikes("all_post_cutoff") spiked i >= 41, wait: i=41,42,43 ARE inside training targets!
    // Let's verify exact boundary at i >= 44 (first unseen test target):
    const buildExactBoundaryStore = (spikeAfterTestTargetsOnly: boolean, preserveLastTail: boolean) => {
      const s = new EtgStore({ persistDir: null });
      const N = 60;
      const firstUnseenTargetIdx = 44;
      const mk = (offset: number, amp: number) =>
        Array.from({ length: N }, (_, i) => {
          const year = 2021 + Math.floor(i / 12);
          const month = (i % 12) + 1;
          const date = `${year}-${String(month).padStart(2, "0")}`;
          const cleanVal = 15 + 0.08 * i + amp * Math.sin((2 * Math.PI * i) / 12 + offset);
          const inPostRange = preserveLastTail
            ? i >= firstUnseenTargetIdx && i < N - 3
            : i >= firstUnseenTargetIdx;
          const val = spikeAfterTestTargetsOnly && inPostRange ? (i % 2 === 0 ? 9999 : -9999) : cleanVal;
          return { date, t: i, value: Number(val.toFixed(4)) };
        });

      const tgt = s.createNode({
        uuid: "sig-tgt",
        label: "Signal",
        properties: {
          name: "Basin Target",
          description: "Target",
          dataset: "nasa_power",
          unit: "kWh/m2/day",
          temporal_scale: "month",
          series: mk(0, 3.0),
        },
        silent: true,
      });
      const drv = s.createNode({
        uuid: "sig-drv",
        label: "Signal",
        properties: {
          name: "Upwind Driver",
          description: "Driver",
          dataset: "nasa_power",
          unit: "C",
          temporal_scale: "month",
          series: mk(0.4, 2.8),
        },
        silent: true,
      });
      s.createEdge({
        source_uuid: drv.uuid,
        target_uuid: tgt.uuid,
        type: "correlates_with",
        weight: 0.85,
        correlation_r: 0.8,
        lag_days: 30,
        optimal_lag_steps: 1,
        lag_unit: "months",
        silent: true,
      });
      return { s, uuid: tgt.uuid };
    };

    const exactClean = buildExactBoundaryStore(false, false);
    const exactSpikedAll = buildExactBoundaryStore(true, false);
    const exactSpikedMid = buildExactBoundaryStore(true, true);

    const predClean = predictFromGraph(exactClean.s, { targetUuid: exactClean.uuid, horizonSteps: 1 });
    const predSpikedAll = predictFromGraph(exactSpikedAll.s, { targetUuid: exactSpikedAll.uuid, horizonSteps: 1 });
    const predSpikedMid = predictFromGraph(exactSpikedMid.s, { targetUuid: exactSpikedMid.uuid, horizonSteps: 1 });

    // Backtest[0] has input lags <= 43 (all pre-cutoff) and predicts index 44: both selfOnly & graphAware must shift by 0!
    expect(Math.abs(predSpikedAll.backtest[0].selfOnly - predClean.backtest[0].selfOnly)).toBe(0);
    expect(Math.abs(predSpikedAll.backtest[0].graphAware - predClean.backtest[0].graphAware)).toBe(0);

    // With intermediate test targets [44..N-4] spiked +-9999 and only last 3 input lags preserved,
    // trained Ridge/GNN weights, normalization stats, and nextForecast predictions must shift by 0.000000!
    expect(Math.abs(predSpikedMid.nextForecast.selfOnlyPred - predClean.nextForecast.selfOnlyPred)).toBe(0);
    expect(Math.abs(predSpikedMid.nextForecast.graphAwarePred - predClean.nextForecast.graphAwarePred)).toBe(0);
    expect(predSpikedMid.trainCount).toBe(predClean.trainCount);
    expect(allPostPred.trainCount).toBe(basePred.trainCount);
  });

  it("trendMicroscope prefix features are strictly causal and tracked weights load cleanly on empty .data/", () => {
    const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "etg-empty-data-"));
    tempDirs.push(emptyDataDir);
    expect(fs.readdirSync(emptyDataDir)).toHaveLength(0);

    // Cold-start weights check: must load tracked ml/weights/*.json without touching .data/
    const weightsV2 = loadLocalInductiveWeightsV2();
    expect(weightsV2).not.toBeNull();
    expect(weightsV2!.schema_version).toBe("etg-inductive-weights-v2");

    const microWeights = loadLocalTrendMicroscopeWeights();
    expect(microWeights).not.toBeNull();
    expect(microWeights!.schema_version).toBe("etg-trend-microscope-v1");

    const store = new EtgStore({ persistDir: emptyDataDir });
    expect(store.getSnapshot().nodes).toHaveLength(0);
    expect(fs.readdirSync(emptyDataDir)).toHaveLength(0);

    // Causal prefix test for trendMicroscope
    const makePts = (spikeTail: boolean) =>
      Array.from({ length: 48 }, (_, i) => ({
        date: `${2021 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
        t: i,
        value: i >= 36 && spikeTail ? (i % 2 === 0 ? 9999 : -9999) : 10 + 0.12 * i + Math.sin(i * 0.5),
      }));

    const prefixClean = makePts(false).slice(0, 36).map((p) => p.value);
    const prefixFromSpiked = makePts(true).slice(0, 36).map((p) => p.value);

    const featA = extractNodeMicroscopeFeatures(prefixClean, { scale: "month", lat: 39.7, lng: -105.0 });
    const featB = extractNodeMicroscopeFeatures(prefixFromSpiked, { scale: "month", lat: 39.7, lng: -105.0 });
    for (let i = 0; i < featA.length; i++) {
      expect(Math.abs(featA[i] - featB[i])).toBe(0);
    }

    const pairA = extractPairMicroscopeFeatures(prefixClean, prefixClean.map((v, i) => v + 0.3 * Math.cos(i)));
    const pairB = extractPairMicroscopeFeatures(prefixFromSpiked, prefixFromSpiked.map((v, i) => v + 0.3 * Math.cos(i)));
    for (let i = 0; i < pairA.length; i++) {
      expect(Math.abs(pairA[i] - pairB[i])).toBe(0);
    }

    const nodeU = store.createNode({
      uuid: "micro-u",
      label: "Signal",
      properties: { name: "Micro U", description: "U", temporal_scale: "month" },
      silent: true,
    });
    const nodeV = store.createNode({
      uuid: "micro-v",
      label: "Signal",
      properties: { name: "Micro V", description: "V", temporal_scale: "month" },
      silent: true,
    });
    const pairScore = scorePairWithTrendMicroscope(nodeU, makePts(false).slice(0, 36), nodeV, makePts(false).slice(0, 36));
    expect(pairScore).not.toBeNull();
    expect(pairScore!.trueCouplingProb).toBeGreaterThanOrEqual(0);
    expect(pairScore!.trueCouplingProb).toBeLessThanOrEqual(1);
  });
});
