import { beforeEach, describe, expect, it } from "vitest";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  materializeDenverSolarGraphIntoEtg,
  predictFromGraph,
} from "@/lib/graph/graphPredictor";
import { DENVER_CLIMATE_NODES } from "@/lib/solar/denverClimateGraph";
import type { TimeSeriesPoint } from "@/types/etg";

describe("Graph-Aware Earth Trend Predictor & Solar Materializer", () => {
  beforeEach(() => {
    getEtgStore().clearGraph(false);
  });

  it("outperforms persistence and self-only AR when upstream graph nodes carry causal lagged drivers (zero leakage)", () => {
    const store = getEtgStore();
    const total = 48;
    const dates = Array.from({ length: total }, (_, i) => {
      const y = 2021 + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, "0");
      return `${y}-${m}-01`;
    });

    // Two irregular, non-repeating upstream atmospheric/oceanic drivers
    const driverASeries: TimeSeriesPoint[] = dates.map((date, i) => ({
      date,
      t: i,
      value: Number((Math.sin(i * 1.13) * 3.1 + Math.cos(i * 0.47) * 2.2).toFixed(4)),
    }));
    const driverBSeries: TimeSeriesPoint[] = dates.map((date, i) => ({
      date,
      t: i,
      value: Number((Math.cos(i * 0.89) * 2.7 - Math.sin(i * 1.61) * 1.8).toFixed(4)),
    }));

    // Target at step t responds cleanly to lagged Driver A (t-1) and Driver B (t-2)
    const targetSeries: TimeSeriesPoint[] = dates.map((date, i) => {
      const aLag1 = i >= 1 ? driverASeries[i - 1].value : 0;
      const bLag2 = i >= 2 ? driverBSeries[i - 2].value : 0;
      const val = 10 + 0.72 * aLag1 - 0.64 * bLag2 + 0.08 * Math.sin(i * 0.5);
      return { date, t: i, value: Number(val.toFixed(4)) };
    });

    // Unlinked candidate driver C for what-if preview
    const candidateCSeries: TimeSeriesPoint[] = dates.map((date, i) => ({
      date,
      t: i,
      value: Number((i >= 1 ? driverASeries[i - 1].value * 0.5 + 1.0 : 1.0).toFixed(4)),
    }));

    const driverA = store.createNode({
      uuid: "driver-a",
      label: "Concept",
      properties: {
        name: "Upwind Cloud Clearing Index",
        description: "Synthetic lag-1 driver",
        lat: 39.6,
        lng: -106.1,
        dataset: "nasa_power",
        unit: "kWh/m²/d",
        series: driverASeries,
      },
    });
    const driverB = store.createNode({
      uuid: "driver-b",
      label: "Signal",
      properties: {
        name: "Eastern Plains Moisture Influx",
        description: "Synthetic lag-2 opposing driver",
        lat: 39.3,
        lng: -103.7,
        dataset: "hydrology",
        unit: "kWh/m²/d",
        series: driverBSeries,
      },
    });
    const target = store.createNode({
      uuid: "target-denver",
      label: "Insight",
      properties: {
        name: "Denver Grid Net Solar Generation",
        description: "Causal target time-series",
        lat: 39.74,
        lng: -104.99,
        dataset: "nasa_power",
        unit: "kWh/m²/d",
        series: targetSeries,
      },
    });
    const candidateC = store.createNode({
      uuid: "candidate-c",
      label: "Signal",
      properties: {
        name: "Unlinked Preview Station",
        description: "Unwired candidate for what-if feature evaluation",
        lat: 40.5,
        lng: -105.1,
        dataset: "nasa_power",
        unit: "kWh/m²/d",
        series: candidateCSeries,
      },
    });

    store.createEdge({
      source_uuid: driverA.uuid,
      target_uuid: target.uuid,
      type: "leads",
      optimal_lag_steps: 1,
      lag_unit: "months",
      weight: 0.9,
    });
    store.createEdge({
      source_uuid: driverB.uuid,
      target_uuid: target.uuid,
      type: "dampens",
      optimal_lag_steps: 2,
      lag_unit: "months",
      weight: 0.85,
    });

    const pred = predictFromGraph(store, {
      targetUuid: target.uuid,
      maxHops: 2,
      horizonSteps: 1,
    });

    expect(pred.targetUuid).toBe(target.uuid);
    expect(pred.neighborContributions.length).toBe(2);
    expect(pred.graphAware.rmse).toBeLessThan(pred.selfOnly.rmse);
    expect(pred.graphAware.rmse).toBeLessThan(pred.persistence.rmse);
    expect(pred.skillLiftVsSelfPct).toBeGreaterThan(0);
    expect(pred.nextForecast.ci95HalfWidth).toBeGreaterThan(0);
    expect(pred.backtest.length).toBe(pred.testCount);

    // What-if candidate neighbor preview evaluates an unlinked node without mutating the graph
    const previewPred = predictFromGraph(store, {
      targetUuid: target.uuid,
      maxHops: 2,
      horizonSteps: 1,
      candidateNeighborUuid: candidateC.uuid,
    });
    expect(
      previewPred.neighborContributions.some(
        (c) => c.nodeUuid === candidateC.uuid && c.isCandidatePreview === true
      )
    ).toBe(true);
  });

  it("materializes the 7-node Front Range solar graph cleanly with deterministic overrides and runs prediction", async () => {
    const store = getEtgStore();
    const dates = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, 1 + i));
      return d.toISOString().slice(0, 10);
    });

    const seriesOverride: Record<string, TimeSeriesPoint[]> = {};
    const upwindBase = dates.map((_, i) => 4.5 + Math.sin(i * 0.8) * 1.4);

    for (const cfg of DENVER_CLIMATE_NODES) {
      if (cfg.role === "target") {
        seriesOverride[cfg.id] = dates.map((date, i) => ({
          date,
          t: i,
          value: Number((i > 0 ? upwindBase[i - 1] * 0.92 + 0.3 : 4.5).toFixed(3)),
        }));
      } else {
        seriesOverride[cfg.id] = dates.map((date, i) => ({
          date,
          t: i,
          value: Number((upwindBase[i] + cfg.distanceKm * 0.002).toFixed(3)),
        }));
      }
    }

    const mat1 = await materializeDenverSolarGraphIntoEtg(store, seriesOverride);
    expect(mat1.hubUuid).toBe("signal-solar-denver-target");
    expect(mat1.createdNodes.length).toBe(7);
    expect(mat1.createdEdges.length).toBe(6);

    const pred = predictFromGraph(store, { targetUuid: mat1.hubUuid, maxHops: 2 });
    expect(pred.sampleCount).toBe(26);
    expect(pred.trainCount + pred.testCount).toBe(26);
    expect(pred.neighborContributions.length).toBeGreaterThanOrEqual(1);
    expect(pred.graphAware.rmse).toBeLessThan(pred.persistence.rmse);
  });

  it("writes back positive ablation lift on causal links and warns when noise neighbors hurt holdout RMSE", () => {
    const store = getEtgStore();
    const total = 48;
    const dates = Array.from({ length: total }, (_, i) => {
      const y = 2021 + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, "0");
      return `${y}-${m}-01`;
    });

    const signalSeries: TimeSeriesPoint[] = dates.map((date, i) => ({
      date,
      t: i,
      value: Number((10 + 3.2 * Math.sin(i * 0.77) + 1.4 * Math.cos(i * 1.31)).toFixed(3)),
    }));
    const causalTargetSeries: TimeSeriesPoint[] = dates.map((date, i) => ({
      date,
      t: i,
      value: Number(
        (2 + (i > 0 ? 0.92 * signalSeries[i - 1].value : 10) + 0.04 * Math.sin(i * 2.1)).toFixed(3)
      ),
    }));

    const causalSrc = store.createNode({
      label: "Signal",
      properties: {
        name: "Causal Driver",
        description: "Strong lagged upstream physical driver",
        series: signalSeries,
        unit: "°C",
      },
    });
    const causalTgt = store.createNode({
      label: "Signal",
      properties: {
        name: "Causal Response",
        description: "Lagged target signal",
        series: causalTargetSeries,
        unit: "°C",
      },
    });
    const causalEdge = store.createEdge({
      source_uuid: causalSrc.uuid,
      target_uuid: causalTgt.uuid,
      type: "leads",
      optimal_lag_steps: 1,
      weight: 0.9,
    });

    const causalPred = predictFromGraph(store, { targetUuid: causalTgt.uuid, maxHops: 1 });
    expect(causalPred.recommendedModel).toBe("graph_aware");
    expect(causalPred.recommendedForecastValue).toBe(causalPred.nextForecast.graphAwarePred);
    expect(causalPred.neighborContributions[0].ablationLiftPct).toBeGreaterThan(0);

    const updatedEdge = store
      .getSnapshot()
      .edges.find((e) => e.properties.uuid === causalEdge.properties.uuid);
    expect(updatedEdge?.properties.predictive_lift_pct).toBeGreaterThan(0);

    // Spurious in-sample correlated neighbor whose regime reverses out-of-sample triggers negative-skill guardrail
    const targetVals = dates.map((_, i) =>
      Number((5 + Math.sin(i * 0.45) * 1.5 + Math.cos(i * 1.13) * 0.9).toFixed(3))
    );
    const noisyTarget = store.createNode({
      label: "Signal",
      properties: {
        name: "Self-Driven AR Series",
        description: "Autoregressive target with regime-shifting false friend",
        series: dates.map((date, i) => ({
          date,
          t: i,
          value: targetVals[i],
        })),
        unit: "°C",
      },
    });
    const spuriousNoise = store.createNode({
      label: "Signal",
      properties: {
        name: "Spurious In-Sample Driver",
        description: "Mirrors training targets then flips out-of-sample",
        series: dates.map((date, i) => ({
          date,
          t: i,
          value:
            i < 32
              ? Number((targetVals[Math.min(i + 1, targetVals.length - 1)] * 1.02).toFixed(3))
              : Number((-targetVals[i] * 2.5).toFixed(3)),
        })),
        unit: "kPa",
      },
    });
    store.createEdge({
      source_uuid: spuriousNoise.uuid,
      target_uuid: noisyTarget.uuid,
      type: "hypothesized_link",
      optimal_lag_steps: 1,
      weight: 0.5,
    });

    const noisyPred = predictFromGraph(store, { targetUuid: noisyTarget.uuid, maxHops: 1 });
    expect(noisyPred.recommendedModel).not.toBe("graph_aware");
    expect(noisyPred.reliabilityWarning).toBeTruthy();
  });

  it("selects nonlinear interaction or stacked ensemble when target coupling includes state interactions and threshold hinges", () => {
    const store = getEtgStore();
    const total = 48;
    const dates = Array.from({ length: total }, (_, i) => {
      const y = 2021 + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, "0");
      return `${y}-${m}-01`;
    });

    const driverVals = dates.map((_, i) =>
      Number((Math.sin(i * 0.42) * 2.1 + Math.cos(i * 0.17) * 0.7).toFixed(3))
    );
    const targetSeries: TimeSeriesPoint[] = [];
    let yVal = 12.0;
    for (let i = 0; i < total; i++) {
      if (i > 0) {
        const dPrev = driverVals[i - 1];
        const yCentered = yVal - 12.0;
        const surge = 2.4 * Math.max(0, dPrev - 0.5);
        const deficit = -1.6 * Math.max(0, -0.5 - dPrev);
        const inter = 0.45 * yCentered * dPrev;
        yVal = 12.0 + 0.3 * yCentered + surge + deficit + inter + 0.08 * Math.sin(i);
      }
      targetSeries.push({ date: dates[i], t: i, value: Number(yVal.toFixed(3)) });
    }

    const driver = store.createNode({
      label: "Concept",
      properties: {
        name: "Heat Dome Forcing",
        description: "Nonlinear threshold driver",
        series: dates.map((date, i) => ({ date, t: i, value: driverVals[i] })),
        unit: "sigma",
      },
    });
    const target = store.createNode({
      label: "Signal",
      properties: {
        name: "Canopy Aridity Surge",
        description: "State-amplified fire-weather response",
        series: targetSeries,
        unit: "kPa",
      },
    });
    store.createEdge({
      source_uuid: driver.uuid,
      target_uuid: target.uuid,
      type: "amplifies",
      optimal_lag_steps: 1,
      weight: 0.95,
    });

    const pred = predictFromGraph(store, { targetUuid: target.uuid, maxHops: 1 });
    expect(["nonlinear_interaction", "stacked_ensemble"]).toContain(
      pred.activeGraphArchitecture
    );
    expect(pred.skillLiftVsSelfPct).toBeGreaterThan(10);
    expect(pred.nonlinearSkillGainPct ?? 0).toBeGreaterThanOrEqual(0);
    expect(pred.recommendedModel).toBe("graph_aware");
    expect(pred.nextForecast.ci95HalfWidth).toBeGreaterThan(0);
  });
});
