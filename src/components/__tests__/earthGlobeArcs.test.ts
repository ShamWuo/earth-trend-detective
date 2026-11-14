import { describe, expect, it } from "vitest";
import {
  buildElevatedGreatCircleCurve,
  selectVisibleGlobeArcs,
} from "@/components/EarthGlobe3D";
import type { ETGEdge, ETGNode, ETGRelationshipType } from "@/types/etg";

function makeGeoNode(uuid: string, lat: number, lng: number): ETGNode {
  return {
    uuid,
    label: "Signal",
    is_provisional: false,
    properties: {
      name: `Region ${uuid}`,
      description: "Test geo-pinned telemetry node",
      lat,
      lng,
      importance: 7,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function makeEdge(
  uuid: string,
  source: string,
  target: string,
  type: ETGRelationshipType,
  correlationR?: number
): ETGEdge {
  return {
    source_uuid: source,
    target_uuid: target,
    type,
    properties: {
      uuid,
      is_provisional: false,
      source_snippet: "Test relation",
      correlation_r: correlationR,
    },
  };
}

describe("EarthGlobe3D arc filtering & low-profile geometry", () => {
  const nodes: ETGNode[] = [
    makeGeoNode("hub", 67.55, -64.83),
    makeGeoNode("andes", -36.86, -71.4),
    makeGeoNode("amazon", -3.4, -62.2),
    makeGeoNode("sahel", 13.5, 2.1),
    makeGeoNode("med", 38.0, 15.0),
    makeGeoNode("tibetan", 32.0, 88.0),
    makeGeoNode("coral", -18.0, 147.0),
    makeGeoNode("sierra", 37.5, -119.0),
    makeGeoNode("nordic", 63.0, 11.0),
    makeGeoNode("dup-near-andes", -36.0, -71.0),
  ];

  const edges: ETGEdge[] = [
    makeEdge("e-dipole-1", "hub", "andes", "drives_opposite", -0.82),
    makeEdge("e-dipole-dup", "hub", "dup-near-andes", "drives_opposite", -0.78),
    makeEdge("e-dipole-weak", "hub", "nordic", "drives_opposite", -0.42),
    makeEdge("e-tele-2", "andes", "amazon", "teleconnects", 0.74),
    makeEdge("e-tele-3", "sahel", "med", "teleconnects", -0.71),
    makeEdge("e-tele-4", "tibetan", "coral", "teleconnects", 0.69),
    makeEdge("e-tele-5", "sierra", "amazon", "drives_opposite", -0.66),
    makeEdge("e-tele-6", "nordic", "med", "teleconnects", 0.61),
    makeEdge("e-tele-7", "coral", "sahel", "drives_opposite", -0.59),
    makeEdge("e-support-1", "hub", "sierra", "supports", 0.5),
    makeEdge("e-support-2", "hub", "med", "supports", 0.45),
    makeEdge("e-support-3", "hub", "coral", "supports", 0.4),
    makeEdge("e-corrob-1", "hub", "tibetan", "corroborates", 0.88),
  ];

  it("returns 0 arcs in default focus mode when nothing is selected", () => {
    const visible = selectVisibleGlobeArcs({
      nodes,
      edges,
      mode: "focus",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
    });

    expect(visible).toHaveLength(0);
  });

  it("returns only the single focused arc when selectedEdgeUuid is set", () => {
    const visible = selectVisibleGlobeArcs({
      nodes,
      edges,
      mode: "focus",
      selectedNodeUuid: "hub",
      selectedEdgeUuid: "e-dipole-1",
      cascadeEdgeUuids: [],
    });

    expect(visible.map((e) => e.properties.uuid)).toEqual(["e-dipole-1"]);
  });

  it("caps incident arcs at 6 prioritized relations when a node is selected", () => {
    const visible = selectVisibleGlobeArcs({
      nodes,
      edges,
      mode: "focus",
      selectedNodeUuid: "hub",
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
    });

    expect(visible).toHaveLength(6);
    expect(visible[0]?.type).toBe("drives_opposite");
  });

  it("limits dipoles overview mode to at most 6 spatially deduplicated high-|r| links", () => {
    const visible = selectVisibleGlobeArcs({
      nodes,
      edges,
      mode: "dipoles",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
    });

    expect(visible.length).toBeLessThanOrEqual(6);
    expect(visible.map((e) => e.properties.uuid)).not.toContain("e-dipole-dup");
    expect(visible.map((e) => e.properties.uuid)).not.toContain("e-dipole-weak");
    for (const edge of visible) {
      expect(["drives_opposite", "teleconnects"]).toContain(edge.type);
      expect(Math.abs(edge.properties.correlation_r ?? 0)).toBeGreaterThanOrEqual(0.55);
    }
  });

  it("returns 0 idle arcs when mode is off and shows cascade edges when selected", () => {
    expect(
      selectVisibleGlobeArcs({
        nodes,
        edges,
        mode: "off",
        selectedNodeUuid: null,
        selectedEdgeUuid: null,
        cascadeEdgeUuids: [],
      })
    ).toHaveLength(0);

    const cascadeVisible = selectVisibleGlobeArcs({
      nodes,
      edges,
      mode: "off",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: ["e-dipole-1", "e-tele-2"],
    });
    expect(cascadeVisible.map((e) => e.properties.uuid)).toEqual(["e-dipole-1", "e-tele-2"]);
  });

  it("builds low-profile great-circle curves hugging the globe without NaN on antipodes", () => {
    const pts = buildElevatedGreatCircleCurve(67.55, -64.83, -36.86, -71.4, 64);
    expect(pts).toHaveLength(65);

    let peakRadius = 0;
    for (const pt of pts) {
      const len = pt.length();
      expect(len).toBeGreaterThan(100);
      expect(len).toBeLessThanOrEqual(114);
      if (len > peakRadius) peakRadius = len;
    }
    expect(peakRadius).toBeGreaterThan(104);

    const antipodes = buildElevatedGreatCircleCurve(0, 0, 0, 180, 16);
    for (const pt of antipodes) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
      expect(Number.isFinite(pt.z)).toBe(true);
    }
  });
});
