import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EtgStore, getEtgStore } from "@/lib/graph/etgStore";
import {
  loadLocalInductiveWeightsV2,
  predictFromGraph,
  predictRegion,
} from "@/lib/graph/graphPredictor";
import { parseKnmiMonthlyIndexDat } from "@/lib/agencies/challengeSourcesClient";
import { parseNasaPowerMonthlyMultiChannel } from "@/lib/nasa/nasaPowerClient";
import { GET as predictGET, POST as predictPOST } from "@/app/api/graph/predict/route";
import type { TimeSeriesPoint } from "@/types/etg";

function makeMonthlySeries(
  count: number,
  fn: (i: number) => number,
  channelsFn?: (i: number) => Record<string, number>
): TimeSeriesPoint[] {
  const pts: TimeSeriesPoint[] = [];
  let year = 2020;
  let month = 1;
  for (let i = 0; i < count; i++) {
    const date = `${year}-${String(month).padStart(2, "0")}`;
    const t = Number((year + (month - 0.5) / 12).toFixed(4));
    pts.push({
      date,
      t,
      value: Number(fn(i).toFixed(4)),
      ...(channelsFn ? { channels: channelsFn(i) } : {}),
    });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return pts;
}

describe("Global Multi-Scale ETG v2, Community Trust Gate & Regional Prediction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ETG_ML_SERVICE_URL;
    getEtgStore().clearGraph(false);
  });

  it("parses KNMI monthly .dat indices and NASA POWER monthly multi-channel covariates (including derived VPD)", () => {
    const sampleDat = [
      "# Monthly Nino 3.4 anomaly",
      "2022   -0.91  -0.84  -0.96  -1.05  -1.01  -0.78  -0.66  -0.89  -0.95  -0.98  -0.92  -0.81",
      "2023   -0.69  -0.44  -0.11   0.18   0.46   0.83   1.12   1.38   1.55   1.69   1.92   2.02",
    ].join("\n");
    const knmiPts = parseKnmiMonthlyIndexDat(sampleDat, 2020, 2025);
    expect(knmiPts).toHaveLength(24);
    expect(knmiPts[0].date).toBe("2022-01");
    expect(knmiPts[0].value).toBeCloseTo(-0.91, 3);
    expect(knmiPts[23].date).toBe("2023-12");
    expect(knmiPts[23].value).toBeCloseTo(2.02, 3);

    const powerMonthly = parseNasaPowerMonthlyMultiChannel(
      {
        T2M: { "202301": 12.4, "202302": 14.1, "202313": 99.9 },
        T2M_MAX: { "202301": 21.0, "202302": 24.0 },
        RH2M: { "202301": 40.0, "202302": 35.0 },
        PRECTOTCORR: { "202301": 1.25, "202302": 0.8 },
      },
      "T2M"
    );
    expect(powerMonthly).toHaveLength(2);
    expect(powerMonthly[0].date).toBe("2023-01");
    expect(powerMonthly[0].channels?.t2m).toBeCloseTo(12.4, 3);
    expect(powerMonthly[0].channels?.precip).toBeCloseTo(1.25, 3);
    expect(powerMonthly[0].channels?.vpd).toBeGreaterThan(1.0);
  });

  it("exports zero-leakage etg-ml-v2 tensors invariant to future post-cutoff mutations & preserves multi-scale bundles", () => {
    const store = new EtgStore({ persistDir: null });
    const driverSeries = makeMonthlySeries(48, (i) => Math.sin(i / 4) * 2.2 + 0.03 * i);
    const targetSeries = makeMonthlySeries(
      48,
      (i) => (i > 0 ? driverSeries[i - 1].value * 1.4 : 0) + 10.0,
      (i) => ({ vpd: 0.9 + 0.3 * Math.cos(i / 6), rh2m: 45 - i * 0.1 })
    );
    const dailySeries = [
      { date: "2023-12-01", t: 2023.91, value: 11.2, channels: { t2m: 11.2, vpd: 0.7 } },
      { date: "2023-12-02", t: 2023.913, value: 11.9, channels: { t2m: 11.9, vpd: 0.8 } },
    ];

    const driver = store.createNode({
      uuid: "driver-enso",
      label: "Signal",
      properties: {
        name: "ENSO Driver",
        description: "Monthly ENSO sea surface anomaly driver",
        lat: 0,
        lng: -140,
        dataset: "ocean_temp",
        temporal_scale: "month",
        series: driverSeries,
      },
    });
    const target = store.createNode({
      uuid: "target-basin",
      label: "Signal",
      properties: {
        name: "Basin Target",
        description: "Monthly regional runoff response signal",
        lat: 39.5,
        lng: -106.0,
        dataset: "hydrology",
        temporal_scale: "month",
        series: targetSeries,
      },
    });
    store.setNodeMultiScaleSeries(target.uuid, "day", dailySeries);
    store.createEdge({
      source_uuid: driver.uuid,
      target_uuid: target.uuid,
      type: "teleconnects",
      cross_scale: true,
      weight: 0.9,
    });

    const expBefore = store.exportMlGraphDatasetV2({ rootUuid: target.uuid, horizonSteps: 1 });
    expect(expBefore.schema_version).toBe("etg-ml-v2");
    expect(expBefore.normalization).toBeDefined();
    expect(expBefore.multi_scale_blocks?.day).toBeDefined();
    expect(expBefore.multi_scale_blocks?.month).toBeDefined();
    expect(expBefore.node_static_features[0]).toHaveLength(16);
    expect(expBefore.edge_attr[0]).toHaveLength(8);
    expect(expBefore.edge_attr[0][7]).toBe(1); // cross_scale flag

    // Mutate strictly future values >= train_cutoff_index by +5000 and re-export
    const cutoff = expBefore.train_cutoff_index;
    const mutatedTargetSeries = targetSeries.map((pt, idx) =>
      idx >= cutoff ? { ...pt, value: pt.value + 5000 } : pt
    );
    store.updateNode(target.uuid, { series: mutatedTargetSeries });

    const expAfter = store.exportMlGraphDatasetV2({ rootUuid: target.uuid, horizonSteps: 1 });
    expect(expAfter.train_cutoff_index).toBe(cutoff);
    expect(expAfter.normalization).toEqual(expBefore.normalization);
    expect(expAfter.edge_attr).toEqual(expBefore.edge_attr);
    expect(expAfter.node_static_features).toEqual(expBefore.node_static_features);
    expect(expAfter.feature_tensor.slice(0, cutoff)).toEqual(
      expBefore.feature_tensor.slice(0, cutoff)
    );

    // Workspace bundle round-trip preserves multi-scale daily channel series
    const bundle = store.exportWorkspaceBundle();
    const restored = new EtgStore({ persistDir: null });
    restored.importWorkspaceBundle(bundle);
    const restoredDaily = restored.getNodeMultiScaleSeries(target.uuid, "day");
    expect(restoredDaily).toHaveLength(2);
    expect(restoredDaily?.[0].channels?.vpd).toBeCloseTo(0.7, 4);
  });

  it("rewards corroborated informative community sensors with positive marginal lift and gates noisy low-trust crowd injections", () => {
    const store = new EtgStore({ persistDir: null });
    const len = 46;
    const baseDriver = makeMonthlySeries(len, (i) => Math.sin(i * 0.45) * 1.4);
    const goodComm = makeMonthlySeries(len, (i) => Math.cos(i * 0.35) * 2.2);
    // Deliberately make target depend nonlinearly & strongly on goodComm at t-1, weakly on baseDriver
    const target = makeMonthlySeries(len, (i) => {
      const cPrev = i > 0 ? goodComm[i - 1].value : goodComm[0].value;
      const dPrev = i > 0 ? baseDriver[i - 1].value : baseDriver[0].value;
      return 20 + 2.4 * cPrev + 0.45 * dPrev;
    });
    const noisyCrowd = makeMonthlySeries(
      len,
      (i) => ((i * 7919) % 23) - 11
    );

    const nBase = store.createNode({
      uuid: "agency-driver",
      label: "Signal",
      properties: {
        name: "Official Meteorological Index",
        description: "NASA reference synoptic oscillation signal",
        lat: 40.0,
        lng: -105.0,
        dataset: "nasa_power",
        producer_type: "nasa_satellite",
        corroborated: true,
        series: baseDriver,
      },
    });
    const nTarget = store.createNode({
      uuid: "target-station",
      label: "Signal",
      properties: {
        name: "Alpine Basin Station",
        description: "Hydrology monitoring gauge",
        lat: 39.8,
        lng: -105.5,
        dataset: "hydrology",
        producer_type: "research_station",
        corroborated: true,
        series: target,
      },
    });
    const nGoodComm = store.createNode({
      uuid: "comm-good-iot",
      label: "Signal",
      properties: {
        name: "Corroborated Soil Flux Node",
        description: "Calibrated community soil flux IoT sensor",
        lat: 39.82,
        lng: -105.52,
        dataset: "community",
        producer_type: "iot_sensor",
        corroborated: true,
        trust_score: 0.92,
        confidence: 0.92,
        series: goodComm,
      },
    });
    const nBadComm = store.createNode({
      uuid: "comm-bad-iot",
      label: "Signal",
      properties: {
        name: "Uncalibrated Balcony Toy Sensor",
        description: "Uncorroborated noisy crowd device",
        lat: 39.9,
        lng: -105.4,
        dataset: "community",
        producer_type: "iot_sensor",
        corroborated: false,
        trust_score: 0.15,
        confidence: 0.15,
        series: noisyCrowd,
      },
    });

    store.createEdge({ source_uuid: nBase.uuid, target_uuid: nTarget.uuid, type: "correlates_with" });
    store.createEdge({ source_uuid: nGoodComm.uuid, target_uuid: nTarget.uuid, type: "supports" });
    store.createEdge({ source_uuid: nBadComm.uuid, target_uuid: nTarget.uuid, type: "correlates_with" });

    const pred = predictFromGraph(store, { targetUuid: nTarget.uuid });
    expect(pred.quantiles).toBeDefined();
    expect(pred.quantiles!.p10).toBeLessThanOrEqual(pred.quantiles!.p50);
    expect(pred.quantiles!.p50).toBeLessThanOrEqual(pred.quantiles!.p90);
    expect(pred.trendForecast).toBeDefined();
    expect(pred.communityImpact).toBeDefined();
    expect(pred.communityImpact!.communityNodesActive).toBe(1);
    expect(pred.communityImpact!.trustGatedCount).toBeGreaterThanOrEqual(1);
    expect(pred.communityImpact!.marginalCommunityLiftPct).toBeGreaterThan(0);

    const gatedEntry = pred.neighborContributions.find((c) => c.nodeUuid === nBadComm.uuid);
    expect(gatedEntry).toBeUndefined();
    expect(store.getNode(nBadComm.uuid)?.properties.community_lift_pct).toBe(-1);
    expect(store.getNode(nGoodComm.uuid)?.properties.community_lift_pct).toBeGreaterThan(0);
  });

  it("predicts arbitrary (lat, lng, dataset) coordinates and serves v1, v2, and L4 fallback routes cleanly", async () => {
    const store = getEtgStore();
    store.clearGraph(false);

    // Seed an ENSO teleconnection anchor globally
    const ninoPts = makeMonthlySeries(36, (i) => Math.sin(i * 0.4) * 1.5);
    store.createNode({
      uuid: "global-enso-anchor",
      label: "Signal",
      properties: {
        name: "Global ENSO Index",
        description: "Global equatorial SST oscillation anchor",
        lat: 0.0,
        lng: -140.0,
        dataset: "ocean_temp",
        producer_type: "research_station",
        corroborated: true,
        series: ninoPts,
      },
    });

    // Mock NASA POWER monthly+daily multi-scale JSON for an unmapped Alpine coordinate (45.2, 6.1)
    const monthlyParamBlock = (offset: number) =>
      Object.fromEntries(
        Array.from({ length: 36 }, (_, idx) => {
          const y = 2021 + Math.floor(idx / 12);
          const m = (idx % 12) + 1;
          const prevNino = ninoPts[Math.max(0, idx - 1)].value;
          return [`${y}${String(m).padStart(2, "0")}`, Number((offset + 1.2 * prevNino).toFixed(3))];
        })
      );
    const mockPowerMonthly = {
      properties: {
        parameter: {
          T2M: monthlyParamBlock(9.5),
          T2M_MAX: monthlyParamBlock(15.0),
          RH2M: monthlyParamBlock(48.0),
          PRECTOTCORR: monthlyParamBlock(2.2),
          WS10M: monthlyParamBlock(3.1),
          ALLSKY_SFC_SW_DWN: monthlyParamBlock(4.8),
        },
      },
    };
    const mockPowerDaily = {
      properties: {
        parameter: {
          T2M: { "20231228": 4.1, "20231229": 4.4, "20231230": 4.9 },
        },
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/temporal/daily/") ? mockPowerDaily : mockPowerMonthly;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const regionPred = await predictRegion(store, {
      lat: 45.2,
      lng: 6.1,
      dataset: "nasa_power",
      persistRegionNode: true,
    });
    expect(regionPred.regionQuery?.synthesizedAnchor).toBe(true);
    expect(regionPred.regionQuery?.dataset).toBe("nasa_power");
    expect(regionPred.scalesUsed?.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(regionPred.recommendedForecastValue)).toBe(true);

    // Check API route formats: ml_export (v1), ml_export_v2 (v2), coordinate GET, and sync_l4_finetune fallback
    const resV1 = await predictGET(
      new NextRequest(
        `http://localhost/api/graph/predict?format=ml_export&rootUuid=${encodeURIComponent(regionPred.targetUuid)}`
      )
    );
    expect(resV1.status).toBe(200);
    const jsonV1 = await resV1.json();
    expect(jsonV1.schema_version).toBe("etg-ml-v1");

    const resV2 = await predictGET(
      new NextRequest(
        `http://localhost/api/graph/predict?format=ml_export_v2&rootUuid=${encodeURIComponent(regionPred.targetUuid)}`
      )
    );
    expect(resV2.status).toBe(200);
    const jsonV2 = await resV2.json();
    expect(jsonV2.schema_version).toBe("etg-ml-v2");

    const resV2QueryAlias = await predictGET(
      new NextRequest(
        `http://localhost/api/graph/predict?format=ml_export&v=2&rootUuid=${encodeURIComponent(regionPred.targetUuid)}`
      )
    );
    expect(resV2QueryAlias.status).toBe(200);
    const jsonV2Alias = await resV2QueryAlias.json();
    expect(jsonV2Alias.schema_version).toBe("etg-ml-v2");

    const resCoord = await predictGET(
      new NextRequest("http://localhost/api/graph/predict?lat=45.2&lng=6.1&dataset=nasa_power")
    );
    expect(resCoord.status).toBe(200);
    const jsonCoord = await resCoord.json();
    expect(jsonCoord.targetUuid).toBeDefined();

    const resSync = await predictPOST(
      new NextRequest("http://localhost/api/graph/predict", {
        method: "POST",
        body: JSON.stringify({
          action: "sync_l4_finetune",
          rootUuid: regionPred.targetUuid,
        }),
      })
    );
    expect(resSync.status).toBe(200);
    const jsonSync = await resSync.json();
    expect(jsonSync.synced).toBe(false);
    expect(jsonSync.mode).toBe("local_fallback");
  });

  it("loads bundled ml/weights/etg-inductive-weights-v2.json automatically when .data is absent and prefers .data when present", () => {
    const repoWeightsPath = path.join(
      process.cwd(),
      "ml",
      "weights",
      "etg-inductive-weights-v2.json"
    );
    expect(fs.existsSync(repoWeightsPath)).toBe(true);

    const repoWeights = loadLocalInductiveWeightsV2();
    expect(repoWeights?.schema_version).toBe("etg-inductive-weights-v2");
    expect(repoWeights?.residual_z_weight).toBeDefined();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "etg-v2-fallback-"));
    try {
      const mlWeightsDir = path.join(tempRoot, "ml", "weights");
      fs.mkdirSync(mlWeightsDir, { recursive: true });
      const trackedFallback = path.join(mlWeightsDir, "etg-inductive-weights-v2.json");
      fs.copyFileSync(repoWeightsPath, trackedFallback);

      // Fresh clone simulation: only ml/weights exists, .data does not
      const loadedFallback = loadLocalInductiveWeightsV2({ rootDir: tempRoot });
      expect(loadedFallback?.schema_version).toBe("etg-inductive-weights-v2");
      expect(loadedFallback?.head_b).toBeCloseTo(repoWeights!.head_b, 6);

      // Local runtime .data override should take precedence over tracked ml/weights
      const dataDir = path.join(tempRoot, ".data");
      fs.mkdirSync(dataDir, { recursive: true });
      const overridePayload = { ...loadedFallback!, head_b: 0.424242 };
      fs.writeFileSync(
        path.join(dataDir, "etg-inductive-weights-v2.json"),
        JSON.stringify(overridePayload),
        "utf8"
      );
      const loadedOverride = loadLocalInductiveWeightsV2({ rootDir: tempRoot });
      expect(loadedOverride?.head_b).toBeCloseTo(0.424242, 6);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
