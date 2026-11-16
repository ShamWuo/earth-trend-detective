import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverGlobalEarthTrends } from "@/lib/discovery/globalTrendPipeline";
import { EtgStore } from "@/lib/graph/etgStore";
import { filterEtgGraphData } from "@/lib/graph/graphVisuals";

describe("Compact Starter Earth Trend Knowledge Graph", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes a fast, zero-orphan, single-component 20-node graph under offline fetch failure and survives persistence reload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network offline")));

    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "etg-starter-test-"));
    tempDirs.push(persistDir);
    const store = new EtgStore({ persistDir });

    const startedAt = performance.now();
    const { summary, snapshot } = await discoverGlobalEarthTrends(store, {
      compact: true,
      clearExisting: true,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(summary.corroboratedInsights).toBeGreaterThanOrEqual(5);

    const { visibleNodes, visibleEdges } = filterEtgGraphData(
      snapshot.nodes,
      snapshot.edges,
      false,
      true,
      undefined,
      { showProvenanceHubs: false }
    );

    expect(visibleNodes.length).toBeGreaterThanOrEqual(18);
    expect(visibleNodes.length).toBeLessThanOrEqual(24);
    expect(visibleNodes.length).toBe(20);

    // Every visible scientific node has non-provenance degree >= 2 (zero orphans, zero dead leaves)
    const adj = new Map<string, Set<string>>();
    for (const n of visibleNodes) adj.set(n.uuid, new Set());
    for (const e of visibleEdges) {
      adj.get(e.source_uuid)?.add(e.target_uuid);
      adj.get(e.target_uuid)?.add(e.source_uuid);
    }
    for (const n of visibleNodes) {
      const deg = adj.get(n.uuid)?.size ?? 0;
      expect(deg, `Node ${n.uuid} had degree ${deg}`).toBeGreaterThanOrEqual(2);
    }

    // Single connected component via undirected BFS
    const visited = new Set<string>();
    const queue = [visibleNodes[0].uuid];
    visited.add(visibleNodes[0].uuid);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    expect(visited.size).toBe(visibleNodes.length);

    const corroboratedInsights = visibleNodes.filter(
      (n) => n.label === "Insight" && n.properties.corroborated === true
    );
    expect(corroboratedInsights.length).toBeGreaterThanOrEqual(5);

    const activeInsights = visibleNodes.filter(
      (n) => n.label === "Insight" && n.properties.status !== "Superseded"
    );
    expect(activeInsights.length).toBe(6);
    for (const ins of activeInsights) {
      expect(ins.properties.dossier?.abstract).toBeTruthy();
      expect(ins.properties.dossier?.citations.length).toBeGreaterThanOrEqual(1);
    }

    expect(visibleEdges.filter((e) => e.type === "drives_opposite").length).toBeGreaterThanOrEqual(3);
    expect(visibleEdges.filter((e) => e.type === "supersedes").length).toBeGreaterThanOrEqual(1);

    // Persistence reload invariant: 0 nodes dropped or altered by surface-mask sanitization
    const reloaded = new EtgStore({ persistDir });
    const reloadedSnap = reloaded.getSnapshot();
    expect(reloadedSnap.nodes.length).toBe(snapshot.nodes.length);
    expect(reloadedSnap.edges.length).toBe(snapshot.edges.length);
  });
});
