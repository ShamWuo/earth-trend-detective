import { describe, expect, it } from "vitest";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  computeLayout2D,
  resolveDetailTier,
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

  it("places all ETG 2D cards (216x42) with zero overlapping bounding boxes", () => {
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
});
