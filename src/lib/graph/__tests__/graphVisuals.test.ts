import { describe, expect, it } from "vitest";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  computeLayout2D,
  computeLayout3D,
  filterEtgGraphData,
  resolveDetailTier,
  selectNonOverlappingEdgePills,
  selectNonOverlappingLabels,
} from "@/lib/graph/graphVisuals";
import type { ETGEdge, ETGNode } from "@/types/etg";

function makeSyntheticTopology(count: number): { nodes: ETGNode[]; edges: ETGEdge[] } {
  const labels = ["Concept", "Signal", "Insight", "Rule"] as const;
  const now = "2026-01-01T00:00:00.000Z";
  const nodes: ETGNode[] = Array.from({ length: count }, (_, i) => ({
    uuid: `node-${i}`,
    label: labels[i % labels.length],
    is_provisional: false,
    properties: {
      name: `Observed Region ${i}`,
      description: "Test layout node",
      importance: 6 + (i % 4),
      created_at: now,
    },
  }));

  const edges: ETGEdge[] = [];
  for (let i = 1; i < count; i++) {
    edges.push({
      source_uuid: `node-${i % 4}`,
      target_uuid: `node-${i}`,
      type: i % 5 === 0 ? "drives_opposite" : "supports",
      properties: {
        uuid: `edge-${i}`,
        is_provisional: false,
        source_snippet: "Test connection",
      },
    });
  }
  return { nodes, edges };
}

describe("graphVisuals layout and readability helpers", () => {
  it("resolves 2D semantic zoom tiers cleanly", () => {
    expect(resolveDetailTier(0.5)).toBe("dots");
    expect(resolveDetailTier(0.82)).toBe("compact");
    expect(resolveDetailTier(1.0)).toBe("full");
  });

  it("places all ETG 2D cards with zero overlapping bounding boxes", () => {
    const { nodes, edges } = makeSyntheticTopology(24);
    const { positions } = computeLayout2D(nodes, edges);

    expect(positions.size).toBe(nodes.length);

    const coords = Array.from(positions.entries());
    for (let i = 0; i < coords.length; i++) {
      const [, a] = coords[i];
      for (let j = i + 1; j < coords.length; j++) {
        const [, b] = coords[j];
        const overlapX = Math.abs(a.x - b.x) < CARD_WIDTH;
        const overlapY = Math.abs(a.y - b.y) < CARD_HEIGHT;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("orders upstream left and downstream right with zero overlap in causal_flow 2D layout", () => {
    const { nodes, edges } = makeSyntheticTopology(9);
    const roleByNode: Record<string, "root" | "upstream" | "downstream"> = {
      "node-0": "upstream",
      "node-1": "upstream",
      "node-2": "root",
      "node-3": "downstream",
      "node-4": "downstream",
    };
    const hopByNode: Record<string, number> = {
      "node-0": 2,
      "node-1": 1,
      "node-2": 0,
      "node-3": 1,
      "node-4": 2,
    };

    const { positions } = computeLayout2D(nodes, edges, {
      mode: "causal_flow",
      rootUuid: "node-2",
      roleByNode,
      hopByNode,
    });

    const pUp = positions.get("node-0")!;
    const pRoot = positions.get("node-2")!;
    const pDown = positions.get("node-4")!;
    expect(pUp.x).toBeLessThan(pRoot.x);
    expect(pRoot.x).toBeLessThan(pDown.x);

    const coords = Array.from(positions.entries());
    for (let i = 0; i < coords.length; i++) {
      const [, a] = coords[i];
      for (let j = i + 1; j < coords.length; j++) {
        const [, b] = coords[j];
        const overlapX = Math.abs(a.x - b.x) < CARD_WIDTH;
        const overlapY = Math.abs(a.y - b.y) < CARD_HEIGHT;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("rejects colliding screen-space labels while keeping higher-priority items", () => {
    const placed = selectNonOverlappingLabels(
      [
        {
          uuid: "low",
          title: "Basin Moisture Shift",
          label: "Signal",
          color: "#38bdf8",
          x: 200,
          y: 200,
          priority: 100,
        },
        {
          uuid: "high",
          title: "Zonal Surface Warming",
          label: "Insight",
          color: "#a78bfa",
          x: 206,
          y: 202,
          priority: 500,
        },
        {
          uuid: "far",
          title: "Polar Cryosphere Flux",
          label: "Concept",
          color: "#e2a856",
          x: 560,
          y: 340,
          priority: 200,
        },
      ],
      10,
      10,
      8
    );

    const ids = placed.map((p) => p.uuid);
    expect(ids).toContain("high");
    expect(ids).toContain("far");
    expect(ids).not.toContain("low");
  });

  it("places high-latitude Arctic clusters north of Southern Ocean clusters in 3D and 2D with zero 2D overlap", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const mkGeoNode = (uuid: string, name: string, region: string, lat: number, lng: number): ETGNode => ({
      uuid,
      label: "Signal",
      is_provisional: false,
      properties: { name, description: name, region, lat, lng, created_at: now },
    });
    const nodes: ETGNode[] = [
      mkGeoNode("arc-1", "Svalbard Permafrost Flux", "Arctic Svalbard", 78, 15),
      mkGeoNode("arc-2", "Svalbard Sea Ice Decline", "Arctic Svalbard", 77.5, 16),
      mkGeoNode("so-1", "Drake Passage SST Anomaly", "Southern Ocean", -65, -60),
      mkGeoNode("so-2", "Antarctic Circumpolar Shift", "Southern Ocean", -64.5, -59),
    ];
    const edges: ETGEdge[] = [
      {
        source_uuid: "arc-1",
        target_uuid: "arc-2",
        type: "corroborates",
        properties: { uuid: "e-a", is_provisional: false, source_snippet: "test" },
      },
      {
        source_uuid: "so-1",
        target_uuid: "so-2",
        type: "corroborates",
        properties: { uuid: "e-s", is_provisional: false, source_snippet: "test" },
      },
      {
        source_uuid: "arc-1",
        target_uuid: "so-1",
        type: "teleconnects",
        properties: { uuid: "e-tel", is_provisional: false, source_snippet: "test" },
      },
    ];

    const pos3d = computeLayout3D(nodes, edges);
    const arcY3d = ((pos3d.get("arc-1")?.y ?? 0) + (pos3d.get("arc-2")?.y ?? 0)) / 2;
    const soY3d = ((pos3d.get("so-1")?.y ?? 0) + (pos3d.get("so-2")?.y ?? 0)) / 2;
    expect(arcY3d).toBeGreaterThan(soY3d);

    const layout2d = computeLayout2D(nodes, edges, { mode: "force" });
    const arcY2d = ((layout2d.positions.get("arc-1")?.y ?? 0) + (layout2d.positions.get("arc-2")?.y ?? 0)) / 2;
    const soY2d = ((layout2d.positions.get("so-1")?.y ?? 0) + (layout2d.positions.get("so-2")?.y ?? 0)) / 2;
    expect(arcY2d).toBeLessThan(soY2d);

    const coords = Array.from(layout2d.positions.values());
    for (let i = 0; i < coords.length; i++) {
      for (let j = i + 1; j < coords.length; j++) {
        const overlapX = Math.abs(coords[i].x - coords[j].x) < CARD_WIDTH;
        const overlapY = Math.abs(coords[i].y - coords[j].y) < CARD_HEIGHT;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("matches spacious two-row SVG card dimensions and returns empty nodes when onlyOpposite finds no dipole edges", () => {
    expect(CARD_WIDTH).toBe(296);
    expect(CARD_HEIGHT).toBe(76);
    const { nodes } = makeSyntheticTopology(4);
    const nonOppositeEdges: ETGEdge[] = [
      {
        source_uuid: "node-0",
        target_uuid: "node-1",
        type: "leads",
        properties: { uuid: "e-1", is_provisional: false, source_snippet: "test" },
      },
    ];

    const emptyOpposite = filterEtgGraphData(nodes, nonOppositeEdges, true, true);
    expect(emptyOpposite.visibleNodes).toEqual([]);
    expect(emptyOpposite.visibleEdges).toEqual([]);

    const oppositeEdges: ETGEdge[] = [
      ...nonOppositeEdges,
      {
        source_uuid: "node-2",
        target_uuid: "node-3",
        type: "drives_opposite",
        properties: { uuid: "e-opp", is_provisional: false, source_snippet: "test" },
      },
    ];
    const withOpposite = filterEtgGraphData(nodes, oppositeEdges, true, true);
    expect(withOpposite.visibleNodes.map((n) => n.uuid)).toEqual(["node-2", "node-3"]);
    expect(withOpposite.visibleEdges.map((e) => e.properties.uuid)).toEqual(["e-opp"]);
  });

  it("accounts for extra badge width in selectNonOverlappingLabels and de-overlaps edge midpoint pills", () => {
    const labels = selectNonOverlappingLabels(
      [
        {
          uuid: "primary",
          title: "Arctic Warming",
          label: "Insight",
          color: "#fbbf24",
          x: 200,
          y: 200,
          priority: 900,
          extraWidthPx: 80,
        },
        {
          uuid: "crowded-neighbor",
          title: "Barents Anomaly",
          label: "Signal",
          color: "#38bdf8",
          x: 295,
          y: 200,
          priority: 500,
        },
        {
          uuid: "distant-node",
          title: "Humboldt Upwelling",
          label: "Concept",
          color: "#34d399",
          x: 520,
          y: 360,
          priority: 400,
        },
      ],
      10,
      10,
      8
    );
    expect(labels.map((l) => l.uuid)).toEqual(["primary", "distant-node"]);

    const edgePills = selectNonOverlappingEdgePills(
      [
        { uuid: "e-opposite", x: 100, y: 100, label: "⇄ Drives Opposite · r=-0.81", priority: 450 },
        { uuid: "e-overlap", x: 112, y: 103, label: "Correlates · r=0.55", priority: 240 },
        { uuid: "e-on-node", x: 420, y: 100, label: "Leads", priority: 240 },
        { uuid: "e-focused-on-node", x: 425, y: 100, label: "Selected Edge", priority: 900 },
        { uuid: "e-clear", x: 520, y: 260, label: "Supersedes", priority: 380 },
      ],
      [{ x: 422, y: 100, halfW: 124, halfH: 20 }]
    );
    expect(edgePills.map((p) => p.uuid)).toEqual(["e-focused-on-node", "e-opposite", "e-clear"]);
  });
});
