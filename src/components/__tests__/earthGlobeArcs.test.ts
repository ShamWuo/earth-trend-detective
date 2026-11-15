import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  buildElevatedGreatCircleCurve,
  createDynamicTextureTracker,
  disposeGroupResources,
  resolveComparisonArcVisuals,
  selectVisibleGlobeArcs,
} from "@/components/EarthGlobe3D";
import {
  GUIDED_DIPOLE_CASES,
  computeDipoleFramingTarget,
} from "@/components/DetectiveWorkspace";
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

  it("supports all, opposite, causal, probedAnchorUuid focus, and enabledCategories filtering", () => {
    const extraEdges: ETGEdge[] = [
      ...edges,
      makeEdge("e-leads-1", "hub", "sahel", "leads", 0.72),
      makeEdge("e-triggers-1", "sierra", "med", "triggers", 0.65),
    ];

    const allArcs = selectVisibleGlobeArcs({
      nodes,
      edges: extraEdges,
      mode: "all",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
    });
    expect(allArcs.length).toBeGreaterThan(0);

    const oppArcs = selectVisibleGlobeArcs({
      nodes,
      edges: extraEdges,
      mode: "opposite",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
    });
    expect(oppArcs.length).toBeGreaterThan(0);
    expect(oppArcs.every((e) => e.type === "drives_opposite")).toBe(true);

    const causalArcs = selectVisibleGlobeArcs({
      nodes,
      edges: extraEdges,
      mode: "causal",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
    });
    expect(causalArcs.map((e) => e.properties.uuid)).toEqual(
      expect.arrayContaining(["e-leads-1", "e-triggers-1"])
    );
    expect(causalArcs.every((e) => e.type === "leads" || e.type === "triggers")).toBe(true);

    const probedFocus = selectVisibleGlobeArcs({
      nodes,
      edges: extraEdges,
      mode: "focus",
      selectedNodeUuid: null,
      probedAnchorUuid: "hub",
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
    });
    expect(probedFocus.length).toBeGreaterThan(0);
    expect(probedFocus.every((e) => e.source_uuid === "hub" || e.target_uuid === "hub")).toBe(
      true
    );

    const evidenceOnly = selectVisibleGlobeArcs({
      nodes,
      edges: extraEdges,
      mode: "all",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
      enabledCategories: ["corroboration"],
    });
    expect(evidenceOnly.length).toBeGreaterThan(0);
    expect(
      evidenceOnly.every((e) => e.type === "supports" || e.type === "corroborates")
    ).toBe(true);
  });

  it("reveals short-range regional Front Range corridors only in regional zoom", () => {
    const frontRangeNodes: ETGNode[] = [
      makeGeoNode("denver", 39.74, -104.99),
      makeGeoNode("boulder", 40.015, -105.27),
      makeGeoNode("golden", 39.755, -105.221),
    ];
    const frontRangeEdges: ETGEdge[] = [
      makeEdge("fr-boulder", "boulder", "denver", "leads", 0.78),
      makeEdge("fr-golden", "golden", "denver", "triggers", 0.74),
    ];

    const globalView = selectVisibleGlobeArcs({
      nodes: frontRangeNodes,
      edges: frontRangeEdges,
      mode: "all",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
      isRegionalZoom: false,
      regionalCenter: null,
    });
    expect(globalView).toHaveLength(0);

    const regionalView = selectVisibleGlobeArcs({
      nodes: frontRangeNodes,
      edges: frontRangeEdges,
      mode: "all",
      selectedNodeUuid: null,
      selectedEdgeUuid: null,
      cascadeEdgeUuids: [],
      isRegionalZoom: true,
      regionalCenter: { lat: 39.74, lng: -104.99 },
    });
    expect(regionalView.map((e) => e.properties.uuid)).toEqual(
      expect.arrayContaining(["fr-boulder", "fr-golden"])
    );
  });

  it("builds low-altitude corridor curves for short-range regional arcs", () => {
    const pts = buildElevatedGreatCircleCurve(40.015, -105.27, 39.74, -104.99, 64, {
      lowAltitudeCorridor: true,
    });
    expect(pts).toHaveLength(65);
    let peakRadius = 0;
    for (const pt of pts) {
      const len = pt.length();
      expect(len).toBeGreaterThan(100);
      expect(len).toBeLessThanOrEqual(102.2);
      if (len > peakRadius) peakRadius = len;
    }
    expect(peakRadius).toBeGreaterThan(100.25);
  });

  it("produces non-NaN TubeGeometry bounding spheres for coincident and near-coincident coordinates", () => {
    for (const opts of [{ lowAltitudeCorridor: false }, { lowAltitudeCorridor: true }] as const) {
      const pts = buildElevatedGreatCircleCurve(
        39.7392,
        -104.9903,
        39.7392,
        -104.9903,
        64,
        opts
      );
      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeo = new THREE.TubeGeometry(curve, 56, 0.28, 6, false);
      tubeGeo.computeBoundingSphere();
      expect(tubeGeo.boundingSphere).not.toBeNull();
      expect(Number.isFinite(tubeGeo.boundingSphere!.radius)).toBe(true);
      expect(tubeGeo.boundingSphere!.radius).toBeGreaterThan(0);
      tubeGeo.dispose();
    }
  });

  it("frames the ENSO Lima ↔ Darwin dipole over the Tropical Pacific without polar pull", () => {
    const target = computeDipoleFramingTarget(
      { lat: -12.05, lng: -77.04 },
      { lat: -12.46, lng: 130.84 }
    );
    expect(target.lat).toBeCloseTo(-12.255, 2);
    expect(target.lng < -130 || target.lng > 160).toBe(true);
    expect(target.radius).toBeGreaterThanOrEqual(248);
    expect(target.radius).toBeLessThanOrEqual(295);
  });

  it("includes guided Space Apps case studies with distinct opposite-trend endpoints", () => {
    const ids = GUIDED_DIPOLE_CASES.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "enso-pacific-dipole",
        "arctic-north-atlantic",
        "western-us-aridity-east-hydro",
      ])
    );
    for (const item of GUIDED_DIPOLE_CASES) {
      expect(
        Math.hypot(item.spotA.lat - item.spotB.lat, item.spotA.lng - item.spotB.lng)
      ).toBeGreaterThan(0.1);
    }
  });

  it("resolves distinct comparison arc visual styles by category and significance", () => {
    const sigOpposite = resolveComparisonArcVisuals({
      category: "opposite",
      badgeText: "Drives Opposite",
      pairLabel: "Lima ↔ Darwin",
      statText: "r = -0.78 · p = 0.004",
      isSignificant: true,
    });
    const weakOpposite = resolveComparisonArcVisuals({
      category: "opposite",
      badgeText: "Drives Opposite",
      pairLabel: "A ↔ B",
      statText: null,
      isSignificant: false,
    });
    expect(sigOpposite.colorCss).toBe("#fb7185");
    expect(sigOpposite.coreRadius).toBeGreaterThan(weakOpposite.coreRadius);
    expect(sigOpposite.haloOpacity).toBeGreaterThan(weakOpposite.haloOpacity);

    const causal = resolveComparisonArcVisuals({
      category: "causal",
      badgeText: "Drives",
      pairLabel: "A → B",
      statText: "r = +0.71",
      isSignificant: true,
    });
    expect(causal.colorCss).toBe("#34d399");

    const coupled = resolveComparisonArcVisuals({
      category: "coupled",
      badgeText: "Co-Trending",
      pairLabel: "A ↔ B",
      statText: null,
    });
    expect(coupled.colorCss).toBe("#38bdf8");

    const fallback = resolveComparisonArcVisuals(null);
    expect(fallback.colorCss).toBe("#22d3ee");
  });

  it("defers GPU disposal for uniform-bound evicted textures until unbound", () => {
    const texA = { id: "a", dispose: vi.fn() };
    const texB = { id: "b", dispose: vi.fn() };
    const bound = new Set([texA]);

    const tracker = createDynamicTextureTracker<typeof texA>((tex) => bound.has(tex));
    tracker.register(texA);
    tracker.register(texB);
    expect(tracker.activeCount()).toBe(2);

    // Evicting texA while still referenced by shader uniform queues deferred disposal
    expect(tracker.evictFromCache(texA)).toBe(false);
    expect(texA.dispose).not.toHaveBeenCalled();
    expect(tracker.pendingCount()).toBe(1);

    // Once uniform swaps away from texA, releaseUnbound() frees GPU texture
    bound.delete(texA);
    expect(tracker.releaseUnbound()).toBe(1);
    expect(texA.dispose).toHaveBeenCalledTimes(1);
    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.activeCount()).toBe(1);

    // Unmount cleanup disposes remaining tracked textures
    expect(tracker.disposeAll()).toBe(1);
    expect(texB.dispose).toHaveBeenCalledTimes(1);
    expect(tracker.activeCount()).toBe(0);
  });

  it("recursively disposes nested Group meshes and Points while preserving shared textures", () => {
    const sharedTex = new THREE.Texture();
    const ownedTex = new THREE.Texture();
    const sharedDisposeSpy = vi.spyOn(sharedTex, "dispose");
    const ownedDisposeSpy = vi.spyOn(ownedTex, "dispose");

    const root = new THREE.Group();
    const nested = new THREE.Group();

    const meshGeo = new THREE.BufferGeometry();
    const meshMat = new THREE.MeshBasicMaterial({ map: ownedTex });
    const meshGeoSpy = vi.spyOn(meshGeo, "dispose");
    const meshMatSpy = vi.spyOn(meshMat, "dispose");
    nested.add(new THREE.Mesh(meshGeo, meshMat));

    const ptsGeo = new THREE.BufferGeometry();
    const ptsMat = new THREE.PointsMaterial({ map: sharedTex, size: 2 });
    const ptsGeoSpy = vi.spyOn(ptsGeo, "dispose");
    const ptsMatSpy = vi.spyOn(ptsMat, "dispose");
    nested.add(new THREE.Points(ptsGeo, ptsMat));

    root.add(nested);

    disposeGroupResources(root, new Set([sharedTex]));

    expect(root.children).toHaveLength(0);
    expect(nested.children).toHaveLength(0);
    expect(meshGeoSpy).toHaveBeenCalledTimes(1);
    expect(meshMatSpy).toHaveBeenCalledTimes(1);
    expect(ownedDisposeSpy).toHaveBeenCalledTimes(1);
    expect(ptsGeoSpy).toHaveBeenCalledTimes(1);
    expect(ptsMatSpy).toHaveBeenCalledTimes(1);
    expect(sharedDisposeSpy).not.toHaveBeenCalled();

    sharedTex.dispose();
  });
});
