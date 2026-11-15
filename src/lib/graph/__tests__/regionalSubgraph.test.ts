import { describe, expect, it } from "vitest";
import {
  buildRegionAssignmentMap,
  computeGraphBoundingSphere3D,
  computeLayout3D,
  computeRegionClusters3D,
} from "@/lib/graph/graphVisuals";
import {
  computeCircularMeanLng,
  extractRegionOptions,
  haversineKm,
  projectRegionalSubgraph,
} from "@/lib/graph/regionalSubgraph";
import type { ETGEdge, ETGNode } from "@/types/etg";

function makeNode(
  uuid: string,
  name: string,
  region?: string,
  lat?: number,
  lng?: number
): ETGNode {
  return {
    uuid,
    label: "Signal",
    is_provisional: false,
    properties: {
      name,
      description: name,
      region,
      lat,
      lng,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function makeEdge(uuid: string, source_uuid: string, target_uuid: string, type: ETGEdge["type"]): ETGEdge {
  return {
    source_uuid,
    target_uuid,
    type,
    properties: {
      uuid,
      is_provisional: false,
      source_snippet: "test",
    },
  };
}

describe("regionalSubgraph projection", () => {
  const nodes: ETGNode[] = [
    makeNode("denver-1", "Denver Heatwave", "Colorado Front Range", 39.74, -104.99),
    makeNode("boulder-1", "Boulder Canopy", "Colorado Front Range", 40.01, -105.27),
    makeNode("probe-1", "39.80°, -105.00°", "39.80°, -105.00°", 39.8, -105.0),
    makeNode("arctic-1", "Arctic Sea Ice", "Arctic", 78.0, 15.0),
    makeNode("amazon-1", "Amazon Moisture", "Amazon Basin", -3.4, -62.2),
  ];

  const edges: ETGEdge[] = [
    makeEdge("e-local", "denver-1", "boulder-1", "supports"),
    makeEdge("e-tele", "arctic-1", "denver-1", "drives_opposite"),
    makeEdge("e-other", "arctic-1", "amazon-1", "relates_to"),
  ];

  it("extracts named region options and snaps nearby coordinate probes to their region", () => {
    const options = extractRegionOptions(nodes);
    expect(options.map((o) => o.label)).toEqual([
      "Colorado Front Range",
      "Amazon Basin",
      "Arctic",
    ]);
    expect(options[0].count).toBe(3);
  });

  it("projects local region nodes plus nearby coordinate probes and 1-hop cross-region drivers", () => {
    const res = projectRegionalSubgraph(nodes, edges, {
      regionId: "colorado front range",
      includeCrossRegionDrivers: true,
    });

    const ids = new Set(res.nodes.map((n) => n.uuid));
    expect(ids.has("denver-1")).toBe(true);
    expect(ids.has("boulder-1")).toBe(true);
    expect(ids.has("probe-1")).toBe(true); // within 650km of Denver/Boulder centroid
    expect(ids.has("arctic-1")).toBe(true); // 1-hop drives_opposite bridge
    expect(ids.has("amazon-1")).toBe(false);

    expect(res.bridgeNodeUuids.has("arctic-1")).toBe(true);
    expect(res.localNodeUuids.has("denver-1")).toBe(true);
    expect(res.edges.map((e) => e.properties.uuid)).toEqual(["e-local", "e-tele"]);
  });

  it("excludes cross-region bridges when includeCrossRegionDrivers is false", () => {
    const res = projectRegionalSubgraph(nodes, edges, {
      regionId: "colorado front range",
      includeCrossRegionDrivers: false,
    });

    const ids = new Set(res.nodes.map((n) => n.uuid));
    expect(ids.has("arctic-1")).toBe(false);
    expect(res.bridgeNodeUuids.size).toBe(0);
    expect(res.edges.map((e) => e.properties.uuid)).toEqual(["e-local"]);
  });

  it("supports __nearby__ spatial radius filtering around a coordinate", () => {
    const res = projectRegionalSubgraph(nodes, edges, {
      regionId: "__nearby__",
      anchorCoord: { lat: 39.74, lng: -104.99 },
      radiusKm: 200,
      includeCrossRegionDrivers: false,
    });

    const ids = new Set(res.nodes.map((n) => n.uuid));
    expect(ids.has("denver-1")).toBe(true);
    expect(ids.has("boulder-1")).toBe(true);
    expect(ids.has("probe-1")).toBe(true);
    expect(ids.has("arctic-1")).toBe(false);
    expect(haversineKm(39.74, -104.99, 40.01, -105.27)).toBeLessThan(50);
  });

  it("keeps extractRegionOptions and computeRegionClusters3D 100% consistent with distant probes and rules", () => {
    const distantProbe = makeNode("probe-ocean", "-25.00°, -135.00°", "-25.00°, -135.00°", -25, -135);
    const ruleNode: ETGNode = {
      uuid: "rule-mk",
      label: "Rule",
      is_provisional: false,
      properties: {
        name: "Mann-Kendall Significance Gate",
        description: "p < 0.05",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    };
    const combined = [...nodes, distantProbe, ruleNode];
    const assignments = buildRegionAssignmentMap(combined);
    expect(assignments.get("probe-1")?.id).toBe("colorado front range");
    expect(assignments.get("probe-ocean")?.id).toBe("southern hemisphere oceans");
    expect(assignments.get("rule-mk")?.id).toBe("__global_rules__");

    const pos = computeLayout3D(combined, edges);
    const clusters = computeRegionClusters3D(combined, pos);
    const options = extractRegionOptions(combined);
    expect(new Set(options.map((o) => o.id))).toEqual(new Set(clusters.map((c) => c.id)));
  });

  it("classifies unlabeled geo-pinned nodes into macro-regions and snaps nearby unlabeled points", () => {
    const unlabeledNearDenver = makeNode("unlabeled-den", "Unlabeled Denver Sensor", undefined, 39.8, -105.0);
    const unlabeledPacific = makeNode("unlabeled-pac", "Equatorial Buoy", undefined, 0, -140);
    const combined = [...nodes, unlabeledNearDenver, unlabeledPacific];

    const assignments = buildRegionAssignmentMap(combined);
    expect(assignments.get("unlabeled-den")?.id).toBe("colorado front range");
    expect(assignments.get("unlabeled-pac")?.id).toBe("equatorial & tropical pacific");
  });

  it("consolidates global reference feeds and classifies swath/event strings by coordinates", () => {
    const globalZonal = makeNode("g-zonal", "Zonal Wind Anomaly", "Global Zonal Network", 0, 0);
    const globalReanalysis = makeNode("g-reanalysis", "ERA5 Temp Anomaly", "Global Reanalysis Grid");
    const earthdataFeed = makeNode("g-earthdata", "NASA Earthdata Feed", "GSFC / LP DAAC Earthdata", 38.99, -76.85);
    const swotSwath = makeNode("swot-1", "SWOT Discharge Pass", "SWOT Swath (12.3, -45.6)", 12.3, -45.6);
    const eonetWildfire = makeNode("eonet-1", "Wildfire - Western US", "Wildfire - Western US", 40, -120);

    const sample = [globalZonal, globalReanalysis, earthdataFeed, swotSwath, eonetWildfire];
    const assignments = buildRegionAssignmentMap(sample);
    expect(assignments.get("g-zonal")?.id).toBe("__global_reference__");
    expect(assignments.get("g-reanalysis")?.id).toBe("__global_reference__");
    expect(assignments.get("g-earthdata")?.id).toBe("__global_reference__");
    expect(assignments.get("swot-1")?.id).toBe("south america & amazonia");
    expect(assignments.get("eonet-1")?.id).toBe("north america");

    const pos = computeLayout3D(sample, []);
    const clusters = computeRegionClusters3D(sample, pos);
    const options = extractRegionOptions(sample);
    expect(new Set(options.map((o) => o.id))).toEqual(new Set(clusters.map((c) => c.id)));
  });

  it("computes an expanded 3D bounding sphere for large multi-region teleconnection graphs", () => {
    const manyRegionNodes: ETGNode[] = Array.from({ length: 14 }, (_, idx) =>
      makeNode(`r-${idx}`, `Region Signal ${idx}`, `Region ${idx}`, idx * 5 - 30, idx * 12 - 80)
    );
    const pos = computeLayout3D(manyRegionNodes, []);
    const sphere = computeGraphBoundingSphere3D(pos);
    expect(sphere.radius).toBeGreaterThan(150);
    expect(Math.max(195, Math.min(820, sphere.radius * 2.35))).toBeGreaterThan(225);
  });

  it("handles Pacific antimeridian longitudes cleanly via computeCircularMeanLng and projectRegionalSubgraph", () => {
    const mid180 = computeCircularMeanLng([170, -170]);
    expect(Math.abs(mid180)).toBeGreaterThan(179.9);
    const midWestOfDateline = computeCircularMeanLng([165, -155]);
    expect(midWestOfDateline).toBeCloseTo(-175, 1);

    const pacWest = makeNode("pac-w", "Western Pacific Warm Pool", undefined, 0.2, 168);
    const pacEast = makeNode("pac-e", "Central Pacific Nino 3.4", undefined, -0.4, -162);
    const pacProbe = makeNode("pac-probe", "0.10°, -178.00°", "0.10°, -178.00°", 0.1, -178);
    const europeNode = makeNode("eu-1", "Rhine Drought", "Western Europe", 50.1, 8.6);
    const pacSample = [pacWest, pacEast, pacProbe, europeNode];
    const pacEdges = [makeEdge("e-pac", "pac-w", "pac-e", "correlates_with")];

    const assignments = buildRegionAssignmentMap(pacSample);
    expect(assignments.get("pac-w")?.id).toBe("equatorial & tropical pacific");
    expect(assignments.get("pac-e")?.id).toBe("equatorial & tropical pacific");
    expect(assignments.get("pac-probe")?.id).toBe("equatorial & tropical pacific");

    const projected = projectRegionalSubgraph(pacSample, pacEdges, {
      regionId: "equatorial & tropical pacific",
    });
    const ids = new Set(projected.nodes.map((n) => n.uuid));
    expect(ids.has("pac-w")).toBe(true);
    expect(ids.has("pac-e")).toBe(true);
    expect(ids.has("pac-probe")).toBe(true);
    expect(ids.has("eu-1")).toBe(false);
    const circularLng = computeCircularMeanLng(
      projected.nodes.map((n) => n.properties.lng as number)
    );
    expect(Math.abs(circularLng)).toBeGreaterThan(150);
  });
});
