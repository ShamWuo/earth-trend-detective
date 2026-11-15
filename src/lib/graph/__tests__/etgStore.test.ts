import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FORBIDDEN_SAAS_LABELS } from "@/types/etg";
import {
  EtgStore,
  extractValueByPath,
  getEtgStore,
  haversineKm,
} from "@/lib/graph/etgStore";
import { predictFromGraph } from "@/lib/graph/graphPredictor";

describe("Earth Trend Graph Store (ETG)", () => {
  beforeEach(() => {
    getEtgStore().clearGraph(false);
  });

  it("starts empty with zero seeded nodes and zero SaaS / Blueprint concepts", () => {
    const snapshot = getEtgStore().getSnapshot();
    expect(snapshot.nodes.length).toBe(0);
    expect(snapshot.edges.length).toBe(0);
    expect(snapshot.oppositeTrendPairs.length).toBe(0);
  });

  it("rejects forbidden Blueprint SaaS entity labels", () => {
    const store = getEtgStore();
    for (const bad of ["Variable", "Task", "Goal", "Project", "Billing"]) {
      expect(() =>
        store.createNode({
          label: bad,
          properties: {
            name: "Invalid",
            description: "Should fail",
          },
        })
      ).toThrow();
    }
  });

  it("promotes provisional Insight via >=2 independent sources and tracks belief revision", () => {
    const store = getEtgStore();
    const insight = store.createNode({
      label: "Insight",
      is_provisional: true,
      properties: {
        name: "Boreal Thermal Rise",
        description: "Initial thermal observation",
        lat: 64.5,
        lng: -147.7,
        dataset: "nasa_power",
      },
    });
    expect(insight.is_provisional).toBe(true);

    const sat = store.createNode({
      label: "Signal",
      properties: {
        name: "NASA POWER Boreal Series",
        description: "MERRA-2 30yr T2M",
        lat: 64.5,
        lng: -147.7,
        dataset: "nasa_power",
        producer_type: "nasa_satellite",
        source_system: "NASA POWER MERRA-2",
      },
    });
    const stn = store.createNode({
      label: "Signal",
      properties: {
        name: "GISTEMP Arctic Band",
        description: "GISS surface anomaly",
        lat: 65.0,
        lng: -147.0,
        dataset: "ocean_temp",
        producer_type: "research_station",
        source_system: "NASA GISTEMP v4",
      },
    });

    store.createEdge({ source_uuid: sat.uuid, target_uuid: insight.uuid, type: "supports" });
    store.createEdge({ source_uuid: stn.uuid, target_uuid: insight.uuid, type: "corroborates" });

    const updated = store.getNode(insight.uuid)!;
    expect(updated.is_provisional).toBe(false);
    expect(updated.properties.status).toBe("Active");
    expect(FORBIDDEN_SAAS_LABELS.has(updated.label)).toBe(false);

    const rev = store.reviseBelief({
      priorNodeUuid: insight.uuid,
      newName: "Accelerated High-Latitude Warming",
      newDescription: "Revised slope incorporating extended 31-year GISTEMP record.",
      rationale: "Updated Theil-Sen slope exceeded baseline window.",
      confidence: 0.96,
      p_value: 0.0002,
    });

    expect(rev.priorNode.properties.status).toBe("Superseded");
    expect(rev.priorNode.properties.superseded_by).toBe(rev.revisedNode.uuid);
    expect(rev.supersedesEdge.type).toBe("supersedes");
    expect(rev.lineage.map((n) => n.uuid)).toContain(insight.uuid);
    expect(rev.lineage[0].uuid).toBe(rev.revisedNode.uuid);
  });

  it("ingests hardware webhooks safely, guards prototype paths, and corroborates nearby insights", () => {
    const store = getEtgStore();
    const insight = store.createNode({
      label: "Insight",
      is_provisional: true,
      properties: {
        name: "Smoke Particulate Surge",
        description: "Thermal wildfire smoke signature",
        lat: 39.1,
        lng: -120.2,
        dataset: "wildfire",
        producer_type: "nasa_satellite",
      },
    });
    const sat = store.createNode({
      label: "Signal",
      properties: {
        name: "Orbital Hotspot",
        description: "Thermal beacon",
        lat: 39.1,
        lng: -120.2,
        dataset: "wildfire",
        producer_type: "nasa_satellite",
        source_system: "NASA EONET v3",
      },
    });
    store.createEdge({ source_uuid: sat.uuid, target_uuid: insight.uuid, type: "supports" });

    const result = store.ingestHardwareWebhook(
      "field-sensor-01",
      {
        metrics: { pm25: 142.8 },
        lat: 39.12,
        lng: -120.24,
      },
      {
        value_path: "metrics.pm25",
      }
    );

    expect(result.signalNode.label).toBe("Signal");
    expect(result.signalNode.properties.value).toBe(142.8);
    expect(result.linkedInsights.length).toBe(1);
    expect(store.getNode(insight.uuid)?.is_provisional).toBe(false);

    expect(extractValueByPath({ metrics: { pm25: 10 } }, "__proto__.polluted")).toBeUndefined();
    expect(extractValueByPath({ metrics: { pm25: 10 } }, "constructor.prototype")).toBeUndefined();
  });

  it("computes accurate great-circle distance and traces shortest provenance path", () => {
    const km = haversineKm(0, 0, 0, 1);
    expect(km).toBeCloseTo(111.19, 0);

    const store = getEtgStore();
    const a = store.createNode({
      uuid: "node-a",
      label: "Signal",
      properties: { name: "Region A", description: "Test A", lat: 10, lng: -120 },
    });
    const b = store.createNode({
      uuid: "node-b",
      label: "Insight",
      properties: { name: "Teleconnection B", description: "Test B", lat: -10, lng: -55 },
    });
    store.createEdge({
      source_uuid: a.uuid,
      target_uuid: b.uuid,
      type: "drives_opposite",
      correlation_r: -0.84,
    });

    const path = store.traceShortestPath(a.uuid, b.uuid);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
    expect(path![0].nodeUuid).toBe(a.uuid);
    expect(path![1].nodeUuid).toBe(b.uuid);
  });

  it("accumulates rolling webhook series without duplicating Signals and auto-wires overlapping opposite trends", () => {
    const store = getEtgStore();

    // Distant (>800 km) insight with decreasing trend over 2018-2025
    const southernSeries = Array.from({ length: 8 }, (_, idx) => ({
      date: `${2018 + idx}`,
      t: 2018 + idx,
      value: Number((10 - idx * 0.9).toFixed(2)),
    }));
    const remoteInsight = store.createNode({
      uuid: "insight-south-sea-ice",
      label: "Insight",
      is_provisional: false,
      properties: {
        name: "Southern Ocean Cooling Anomaly",
        description: "Multi-year sea surface cooling series",
        lat: -62.0,
        lng: -45.0,
        dataset: "ocean_temp",
        theil_sen_slope: -0.9,
        series: southernSeries,
      },
    });

    let lastRes!: ReturnType<typeof store.ingestHardwareWebhook>;
    let discoveredAtFifth = 0;
    for (let idx = 0; idx < 8; idx++) {
      lastRes = store.ingestHardwareWebhook("arctic-buoy-07", {
        value: Number((1.2 + idx * 0.65).toFixed(2)),
        unit: "°C",
        lat: 71.5,
        lng: -156.4,
        dataset: "nasa_power",
        observed_at: `${2018 + idx}-07-15T12:00:00Z`,
      });
      if (idx === 4) {
        discoveredAtFifth = lastRes.discoveredConnections.length;
      }
    }

    const allSignals = store.getSnapshot().nodes.filter((n) => n.label === "Signal");
    expect(allSignals.length).toBe(1);
    expect(lastRes.signalNode.uuid).toBe("signal-wh-arctic-buoy-07");

    const accumulated = store.getNodeSeries(lastRes.signalNode.uuid);
    expect(accumulated?.length).toBe(8);
    expect(lastRes.signalNode.properties.series_count).toBe(8);
    expect(lastRes.signalNode.properties.theil_sen_slope).toBeGreaterThan(0);
    expect(lastRes.signalNode.properties.p_value).toBeLessThan(0.05);

    expect(discoveredAtFifth).toBeGreaterThanOrEqual(1);
    const matchingOppositeEdges = store.getSnapshot().edges.filter(
      (e) =>
        e.type === "drives_opposite" &&
        ((e.source_uuid === lastRes.signalNode.uuid && e.target_uuid === remoteInsight.uuid) ||
          (e.target_uuid === lastRes.signalNode.uuid && e.source_uuid === remoteInsight.uuid))
    );
    expect(matchingOppositeEdges.length).toBe(1);
  });

  it("does not spuriously correlate non-overlapping timeframes across distant nodes", () => {
    const store = getEtgStore();

    // Historical series 1995-2002
    const legacySeries = Array.from({ length: 8 }, (_, idx) => ({
      date: `${1995 + idx}`,
      t: 1995 + idx,
      value: Number((20 - idx * 0.8).toFixed(2)),
    }));
    store.createNode({
      uuid: "insight-legacy-1995",
      label: "Insight",
      is_provisional: false,
      properties: {
        name: "Legacy 1995-2002 Station",
        description: "Historical series with no overlap to 2026",
        lat: -35.0,
        lng: 149.0,
        dataset: "nasa_power",
        theil_sen_slope: -0.8,
        series: legacySeries,
      },
    });

    let lastRes!: ReturnType<typeof store.ingestHardwareWebhook>;
    for (let idx = 0; idx < 6; idx++) {
      lastRes = store.ingestHardwareWebhook("modern-sensor-2026", {
        value: Number((10 + idx * 1.1).toFixed(2)),
        unit: "°C",
        lat: 48.8,
        lng: 2.3,
        dataset: "community",
        observed_at: `2026-05-0${idx + 1}T12:00:00Z`,
      });
    }

    expect(lastRes.discoveredConnections.length).toBe(0);
  });

  it("auto-links incoming NASA EONET signals to nearby Insights and Signals", () => {
    const store = getEtgStore();

    const nearbyInsight = store.createNode({
      uuid: "insight-cal-drought",
      label: "Insight",
      is_provisional: true,
      properties: {
        name: "Sierra Fuel Aridity Surge",
        description: "Pre-existing regional drying trend",
        lat: 39.2,
        lng: -120.5,
        dataset: "wildfire",
        producer_type: "research_station",
        source_system: "NOAA CDO",
      },
    });
    const nearbySignal = store.createNode({
      uuid: "signal-cal-ridge-cam",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "Tahoe Ridge Sensor",
        description: "Edge camera & smoke sensor",
        lat: 39.15,
        lng: -120.4,
        dataset: "air_quality",
        device_id: "ridge-cam-01",
      },
    });

    const eonetRes = store.ingestEonetSignals([
      {
        uuid: "eonet-test-fire-01",
        label: "Signal",
        is_provisional: false,
        properties: {
          name: "EONET Sierra Wildfire Event",
          description: "Active wildfire thermal anomaly",
          lat: 39.25,
          lng: -120.45,
          dataset: "wildfire",
          producer_type: "nasa_satellite",
          source_system: "NASA EONET v3",
          created_at: new Date().toISOString(),
        },
      },
    ]);

    expect(eonetRes.added).toBe(1);
    expect(eonetRes.linkedEdges).toBeGreaterThanOrEqual(2);

    const edges = store.getSnapshot().edges;
    expect(
      edges.some(
        (e) =>
          e.source_uuid === "eonet-test-fire-01" &&
          e.target_uuid === nearbyInsight.uuid &&
          e.type === "corroborates"
      )
    ).toBe(true);
    expect(
      edges.some(
        (e) =>
          ((e.source_uuid === "eonet-test-fire-01" && e.target_uuid === nearbySignal.uuid) ||
            (e.source_uuid === nearbySignal.uuid && e.target_uuid === "eonet-test-fire-01")) &&
          e.type === "relates_to"
      )
    ).toBe(true);
  });

  it("supports CRUD edits/unlinking, sparkline caching, k-hop traversal, path finding, link discovery, and ML export", () => {
    const store = getEtgStore();

    const dates = Array.from({ length: 18 }, (_, i) => {
      const y = 2020 + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, "0");
      return `${y}-${m}-01`;
    });

    // Driver X leads Intermediate Y by 1 step, and Y leads Impact Z by 1 step
    const xSeries = dates.map((date, i) => ({
      date,
      t: i,
      value: Number((Math.sin(i * 0.7) * 4 + i * 0.25).toFixed(3)),
    }));
    const ySeries = dates.map((date, i) => ({
      date,
      t: i,
      value: Number((i > 0 ? xSeries[i - 1].value * 1.4 + 2 : 2).toFixed(3)),
    }));
    const zSeries = dates.map((date, i) => ({
      date,
      t: i,
      value: Number((i > 0 ? ySeries[i - 1].value * 0.8 - 1 : -1).toFixed(3)),
    }));

    const nodeX = store.createNode({
      uuid: "node-driver-x",
      label: "Concept",
      properties: {
        name: "Upwind Jet Index",
        description: "Upstream atmospheric driver",
        lat: 40.0,
        lng: -107.0,
        dataset: "nasa_power",
        phenomenon_type: "climate_index",
        authored_by: "human",
        series: xSeries,
      },
    });
    const nodeY = store.createNode({
      uuid: "node-mid-y",
      label: "Signal",
      properties: {
        name: "Front Range Cloud Shield",
        description: "Mid-chain transport anomaly",
        lat: 39.74,
        lng: -105.0,
        dataset: "nasa_power",
        phenomenon_type: "climate_trend",
        series: ySeries,
      },
    });
    const nodeZ = store.createNode({
      uuid: "node-impact-z",
      label: "Insight",
      properties: {
        name: "Microgrid Battery Draw",
        description: "Downstream physical impact",
        lat: 39.7,
        lng: -104.9,
        dataset: "community",
        phenomenon_type: "physical_impact",
        series: zSeries,
      },
    });

    // Sparkline preview & series hydration
    expect(nodeX.properties.sparkline_preview?.length).toBeGreaterThanOrEqual(6);
    expect(store.getNodeWithSeries(nodeX.uuid)?.series?.length).toBe(18);

    // Connect X -> Y, leave X..Z unlinked so discoverCandidateLinks can find X->Z or similar
    const edgeXY = store.createEdge({
      source_uuid: nodeX.uuid,
      target_uuid: nodeY.uuid,
      type: "leads",
      optimal_lag_steps: 1,
      lag_unit: "months",
      weight: 0.9,
      authored_by: "human",
    });
    expect(edgeXY.properties.correlation_r).toBeDefined();

    // Update node metadata & edge
    const updatedY = store.updateNode(nodeY.uuid, {
      domain_tags: ["front_range", "cloud"],
    });
    expect(updatedY?.properties.domain_tags).toEqual(["front_range", "cloud"]);
    const updatedEdgeXY = store.updateEdge(edgeXY.properties.uuid, {
      custom_label: "Advection Flow",
      weight: 0.95,
    });
    expect(updatedEdgeXY?.properties.custom_label).toBe("Advection Flow");

    // Discover candidate links (Y -> Z should be suggested with lead-lag correlation!)
    const suggestions = store.discoverCandidateLinks({ anchorUuid: nodeZ.uuid, minAbsR: 0.35 });
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    const yzCandidate = suggestions.find(
      (s) =>
        (s.sourceUuid === nodeY.uuid && s.targetUuid === nodeZ.uuid) ||
        (s.sourceUuid === nodeZ.uuid && s.targetUuid === nodeY.uuid)
    );
    expect(yzCandidate).toBeDefined();

    // Wire Y -> Z
    store.createEdge({
      source_uuid: nodeY.uuid,
      target_uuid: nodeZ.uuid,
      type: "impacts",
      optimal_lag_steps: 1,
      lag_unit: "months",
    });

    // Multi-hop traversal from Z upstream reaches Y (1h) and X (2h)
    const upstreamSub = store.traverseSubgraph({
      rootUuid: nodeZ.uuid,
      maxHops: 2,
      direction: "upstream",
    });
    expect(upstreamSub.hopByNode[nodeZ.uuid]).toBe(0);
    expect(upstreamSub.hopByNode[nodeY.uuid]).toBe(1);
    expect(upstreamSub.hopByNode[nodeX.uuid]).toBe(2);
    expect(upstreamSub.roleByNode[nodeY.uuid]).toBe("upstream");
    expect(upstreamSub.roleByNode[nodeX.uuid]).toBe("upstream");

    // findAllPaths X -> Z
    const paths = store.findAllPaths(nodeX.uuid, nodeZ.uuid, 4);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0].nodeUuids).toEqual([nodeX.uuid, nodeY.uuid, nodeZ.uuid]);
    expect(paths[0].cumulativeLagSteps).toBe(2);

    // Export PyG/ML dataset
    const ml = store.exportMlGraphDataset({ rootUuid: nodeZ.uuid, maxHops: 2 });
    expect(ml.schema_version).toBe("etg-ml-v1");
    expect(ml.node_ids.length).toBe(3);
    expect(ml.edge_index[0].length).toBe(2);
    expect(ml.edge_index[1].length).toBe(2);
    expect(ml.time_index.length).toBe(18);
    expect(ml.feature_tensor.length).toBe(18);

    // Unlink & delete node
    const unlinked = store.unlinkNodes(nodeY.uuid, nodeZ.uuid);
    expect(unlinked).toBe(1);
    expect(store.findAllPaths(nodeX.uuid, nodeZ.uuid, 4).length).toBe(0);
    expect(store.deleteNode(nodeZ.uuid)).toBe(true);
    expect(store.getNode(nodeZ.uuid)).toBeUndefined();
  });

  it("exports and imports portable ETG workspace bundles while rejecting forbidden SaaS labels", () => {
    const store = getEtgStore();
    const src = store.createNode({
      label: "Concept",
      properties: {
        name: "Pacific Niño 3.4 Index",
        description: "Equatorial SST anomaly index",
        lat: 0,
        lng: -140,
      },
    });
    const tgt = store.createNode({
      label: "Signal",
      properties: {
        name: "Atacama Precipitation",
        description: "Regional rainfall response",
        lat: -23.6,
        lng: -70.4,
      },
    });
    store.createEdge({
      source_uuid: src.uuid,
      target_uuid: tgt.uuid,
      type: "teleconnects",
      weight: 0.85,
    });

    const bundle = store.exportWorkspaceBundle();
    expect(bundle.schema_version).toBe("etg-workspace-v1");
    expect(bundle.nodes).toHaveLength(2);
    expect(bundle.edges).toHaveLength(1);

    store.clearGraph(false);
    expect(store.getSnapshot().nodes).toHaveLength(0);

    const imported = store.importWorkspaceBundle(bundle, { merge: false });
    expect(imported.importedNodes).toBe(2);
    expect(imported.importedEdges).toBe(1);
    expect(store.getSnapshot().nodes).toHaveLength(2);
    expect(store.getSnapshot().edges).toHaveLength(1);

    expect(() =>
      store.importWorkspaceBundle({
        ...bundle,
        nodes: [
          {
            ...bundle.nodes[0],
            label: "Variable" as never,
          },
        ],
      })
    ).toThrow(/forbids SaaS\/productivity labels/i);
  });

  it("persists graph & prospective forecasts to disk and auto-reconciles when matching future observations arrive", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "etg-persist-"));
    try {
      const store1 = new EtgStore({ persistDir: tmpDir });
      const driverSeries = Array.from({ length: 18 }, (_, i) => {
        const y = 2023 + Math.floor(i / 12);
        const m = String((i % 12) + 1).padStart(2, "0");
        return { date: `${y}-${m}-01`, t: i, value: Number((10 + Math.sin(i * 0.6) * 3).toFixed(3)) };
      });
      const targetSeries = Array.from({ length: 18 }, (_, i) => {
        const y = 2023 + Math.floor(i / 12);
        const m = String((i % 12) + 1).padStart(2, "0");
        const prevD = driverSeries[Math.max(0, i - 1)].value;
        return { date: `${y}-${m}-01`, t: i, value: Number((prevD * 1.15 + 4).toFixed(3)) };
      });

      const driver = store1.createNode({
        uuid: "persist-driver",
        label: "Concept",
        properties: {
          name: "Upwind Driver",
          description: "Persisted upstream signal",
          lat: 39.8,
          lng: -105.2,
          unit: "°C",
          series: driverSeries,
        },
      });
      const target = store1.createNode({
        uuid: "persist-target",
        label: "Signal",
        properties: {
          name: "Downstream Station",
          description: "Persisted target series",
          lat: 39.74,
          lng: -104.99,
          unit: "μg/m³",
          series: targetSeries,
        },
      });
      store1.createEdge({
        source_uuid: driver.uuid,
        target_uuid: target.uuid,
        type: "leads",
        optimal_lag_steps: 1,
        weight: 0.9,
      });

      const pred = predictFromGraph(store1, { targetUuid: target.uuid, maxHops: 1 });
      const logged = store1.logProspectiveForecast(pred);
      expect(logged.status).toBe("pending");
      expect(logged.target_period).toBe("2024-07");

      // Simulate restart #1: reload from tmpDir
      const store2 = new EtgStore({ persistDir: tmpDir });
      expect(store2.getSnapshot().nodes).toHaveLength(2);
      expect(store2.getNodeSeries(target.uuid)?.length).toBe(18);
      const ledgerBefore = store2.getProspectiveLedger(target.uuid);
      expect(ledgerBefore.summary.total_logged).toBe(1);
      expect(ledgerBefore.summary.pending_count).toBe(1);

      // Push future ground-truth reading matching target_period ("2024-07") via webhook
      store2.ingestHardwareWebhook(target.uuid, {
        observed_at: "2024-07-01",
        value: Number(pred.recommendedForecastValue.toFixed(2)),
        confidence: 0.95,
      });

      const ledgerAfter = store2.getProspectiveLedger(target.uuid);
      expect(ledgerAfter.summary.scored_count).toBe(1);
      expect(ledgerAfter.summary.pending_count).toBe(0);
      expect(ledgerAfter.records[0].status).toBe("scored");
      expect(ledgerAfter.records[0].covered_by_ci95).toBe(true);
      expect(ledgerAfter.records[0].abs_error).toBeLessThan(0.05);

      // Simulate restart #2: verify scored record survives restart cleanly
      const store3 = new EtgStore({ persistDir: tmpDir });
      expect(store3.getProspectiveLedger(target.uuid).summary.scored_count).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("carries forward active edges on reviseBelief, clears region on updateNode, filters opposite endpoints, and rejects out-of-range webhook coords", () => {
    const store = getEtgStore();
    const driver = store.createNode({
      uuid: "rev-driver",
      label: "Concept",
      properties: {
        name: "Arctic Oscillation",
        description: "Driver",
        dataset: "nasa_power",
        region: "Arctic",
        lat: 75,
        lng: 10,
      },
    });
    const prior = store.createNode({
      uuid: "rev-prior",
      label: "Signal",
      properties: {
        name: "Mid-Latitude Freeze Hypothesis",
        description: "Initial hypothesis",
        dataset: "ocean_temp",
        region: "North Atlantic",
        lat: 52,
        lng: -30,
      },
    });
    const downstream = store.createNode({
      uuid: "rev-down",
      label: "Signal",
      properties: {
        name: "Subtropical Drought Belt",
        description: "Downstream signal",
        dataset: "wildfire",
        region: "Mediterranean",
        lat: 38,
        lng: 5,
      },
    });

    store.createEdge({
      source_uuid: driver.uuid,
      target_uuid: prior.uuid,
      type: "leads",
      rationale: "Upstream forcing",
    });
    store.createEdge({
      source_uuid: prior.uuid,
      target_uuid: downstream.uuid,
      type: "drives_opposite",
      rationale: "Opposite dipole",
    });

    const cleared = store.updateNode(downstream.uuid, { region: "" });
    expect(cleared?.properties.region).toBeUndefined();

    // Cross-dataset opposite edge should NOT survive strict dataset filter on queryGraph
    const oceanOpposite = store.queryGraph({
      dataset: "ocean_temp",
      onlyOppositeTrends: true,
    });
    expect(oceanOpposite.edges).toHaveLength(0);
    expect(oceanOpposite.nodes).toHaveLength(0);

    // Epistemic revision clones active incident edges onto revisedNode while preserving prior history
    const { priorNode, revisedNode, supersedesEdge } = store.reviseBelief({
      priorNodeUuid: prior.uuid,
      newName: "Updated Mid-Latitude Blocking Signal",
      newDescription: "Revised after reanalysis",
      rationale: "New satellite climatology",
    });
    expect(priorNode.properties.status).toBe("Superseded");
    expect(supersedesEdge.type).toBe("supersedes");

    const activeSnapshot = store.getSnapshot();
    const carriedIn = activeSnapshot.edges.find(
      (e) => e.source_uuid === driver.uuid && e.target_uuid === revisedNode.uuid && e.type === "leads"
    );
    const carriedOut = activeSnapshot.edges.find(
      (e) =>
        e.source_uuid === revisedNode.uuid &&
        e.target_uuid === downstream.uuid &&
        e.type === "drives_opposite"
    );
    expect(carriedIn).toBeDefined();
    expect(carriedOut).toBeDefined();

    // Strict coordinate validation in ingestHardwareWebhook
    expect(() =>
      store.ingestHardwareWebhook(downstream.uuid, {
        value: 42,
        lat: 95,
        lng: 5,
      })
    ).toThrow(/latitude/i);
  });
});
