import { beforeEach, describe, expect, it } from "vitest";
import { FORBIDDEN_SAAS_LABELS } from "@/types/etg";
import { extractValueByPath, getEtgStore, haversineKm } from "@/lib/graph/etgStore";

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
});
