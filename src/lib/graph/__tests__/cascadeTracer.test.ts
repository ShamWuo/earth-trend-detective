import { describe, expect, it } from "vitest";
import { findMultiHopCascades, inferEarthSphere } from "@/lib/graph/cascadeTracer";
import type { ETGEdge, ETGNode } from "@/types/etg";

function makeNode(
  uuid: string,
  name: string,
  dataset: ETGNode["properties"]["dataset"],
  parameter?: string,
  label: ETGNode["label"] = "Signal",
  withSeries = true
): ETGNode {
  return {
    uuid,
    label,
    is_provisional: false,
    properties: {
      name,
      description: `${name} observation`,
      dataset,
      parameter,
      created_at: "2026-01-01T00:00:00.000Z",
      series: withSeries
        ? [
            { date: "2020", t: 2020, value: 1 },
            { date: "2021", t: 2021, value: 2 },
            { date: "2022", t: 2022, value: 3 },
          ]
        : undefined,
    },
  };
}

function makeEdge(
  uuid: string,
  source: string,
  target: string,
  type: ETGEdge["type"],
  r: number,
  lag = 0
): ETGEdge {
  return {
    source_uuid: source,
    target_uuid: target,
    type,
    properties: {
      uuid,
      is_provisional: false,
      source_snippet: `${type} (${r})`,
      correlation_r: r,
      optimal_lag_steps: lag,
    },
  };
}

describe("Earth-System Multi-Sphere Cascade Tracer", () => {
  it("classifies nodes accurately into the 5 Earth spheres including NSIDC sea ice", () => {
    const co2 = makeNode("co2", "Mauna Loa CO₂", "air_quality", "CO2");
    const sst = makeNode("sst", "Niño 3.4 SST", "ocean_temp", "NINO34");
    const seaIce = makeNode(
      "ice",
      "Arctic September Sea Ice Extent (NSIDC)",
      "ocean_temp",
      "SEA_ICE_EXTENT_09"
    );
    const mackenzie = makeNode(
      "mack",
      "Mackenzie River Discharge (SWOT / GEO.ca)",
      "hydrology",
      "DISCHARGE"
    );
    const amazon = makeNode("amz", "Amazon Canopy NDVI Loss", "deforestation", "NDVI");

    expect(inferEarthSphere(co2)).toBe("Atmosphere");
    expect(inferEarthSphere(sst)).toBe("Ocean");
    expect(inferEarthSphere(seaIce)).toBe("Cryosphere");
    expect(inferEarthSphere(mackenzie)).toBe("Hydrosphere");
    expect(inferEarthSphere(amazon)).toBe("Biosphere");
  });

  it("discovers multi-sphere domino cascades while skipping Rule nodes and cycles", () => {
    const nodes: ETGNode[] = [
      makeNode("n-co2", "Mauna Loa CO₂", "air_quality", "CO2"),
      makeNode("n-arctic", "Arctic 64N-90N Warming", "nasa_power", "GISTEMP"),
      makeNode("n-ice", "Arctic Sea Ice Extent", "ocean_temp", "SEA_ICE_EXTENT_09"),
      makeNode("n-mack", "Mackenzie River Discharge", "hydrology", "DISCHARGE"),
      makeNode("rule-mk", "Mann-Kendall Significance Rule", "nasa_power", "MK", "Rule", false),
    ];

    const edges: ETGEdge[] = [
      makeEdge("e1", "n-co2", "n-arctic", "corroborates", 0.91, 1),
      makeEdge("e2", "n-arctic", "n-ice", "drives_opposite", -0.87, 0),
      makeEdge("e3", "n-ice", "n-mack", "teleconnects", -0.74, 1),
      // Closing cycle + Rule edge that must not corrupt cascade paths
      makeEdge("e-cycle", "n-mack", "n-co2", "correlates_with", 0.61, 0),
      makeEdge("e-rule", "rule-mk", "n-arctic", "verified_by", 0.99, 0),
    ];

    const chains = findMultiHopCascades(nodes, edges, "n-arctic", 5);
    expect(chains.length).toBeGreaterThanOrEqual(1);

    const top = chains[0];
    expect(top.spheres.length).toBeGreaterThanOrEqual(3);
    expect(top.spheres).toContain("Atmosphere");
    expect(top.spheres).toContain("Cryosphere");
    expect(top.spheres).toContain("Hydrosphere");
    expect(top.nodeUuids).not.toContain("rule-mk");
    expect(new Set(top.nodeUuids).size).toBe(top.nodeUuids.length);
  });
});
