import type {
  EarthCascadeChain,
  EarthCascadeStep,
  EarthSphere,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
} from "@/types/etg";

const ALLOWED_CASCADE_EDGES = new Set<ETGRelationshipType>([
  "drives_opposite",
  "correlates_with",
  "teleconnects",
  "corroborates",
  "supports",
  "relates_to",
]);

const DIRECTED_SUPPORT_EDGES = new Set<ETGRelationshipType>(["supports", "corroborates"]);

/**
 * Classifies an Earth Trend Graph node into one of five primary Earth-system spheres
 * (`Atmosphere`, `Ocean`, `Cryosphere`, `Hydrosphere`, `Biosphere`) using dataset and metadata cues.
 */
export function inferEarthSphere(node: ETGNode): EarthSphere {
  const ds = (node.properties.dataset ?? "").toLowerCase();
  const param = (node.properties.parameter ?? "").toLowerCase();
  const tagsText = Array.isArray(node.properties.tags)
    ? (node.properties.tags as string[]).join(" ")
    : "";
  const text = `${node.properties.name} ${node.properties.description ?? ""} ${
    node.properties.parameter ?? ""
  } ${tagsText}`.toLowerCase();

  // Check Cryosphere first so "Arctic Sea Ice" maps to Cryosphere even when grouped under ocean_temp.
  if (
    /\b(sea ice|ice sheet|glacier|permafrost|snow cover|albedo|cryosphere|sea_ice|nsidc)\b/.test(
      text
    )
  ) {
    return "Cryosphere";
  }

  if (param === "rh2m" || /\b(relative humidity|rh2m|co2|carbon dioxide|aerosol|pm2\.5|temperature|t2m|gistemp|air quality|monsoon)\b/.test(text)) {
    // River/flood/precip take priority over temperature if explicitly hydrological.
    if (ds === "hydrology" || /\b(river|discharge|runoff|streamflow|flood|swot|mackenzie|precip|drought|soil moisture)\b/.test(text)) {
      return "Hydrosphere";
    }
    if (ds !== "ocean_temp") {
      return "Atmosphere";
    }
  }

  if (
    ds === "ocean_temp" ||
    /\b(sst|sea surface|nino|enso|pdo|amo|iod|ocean|maritime|marine|coral|pacific|atlantic|indian ocean)\b/.test(
      text
    )
  ) {
    return "Ocean";
  }

  if (
    ds === "hydrology" ||
    /\b(river|discharge|runoff|streamflow|flood|swot|mackenzie|lake|reservoir|watershed|hydrolog|precip|prectotcorr|rainfall|drought|soil moisture)\b/.test(
      text
    )
  ) {
    return "Hydrosphere";
  }

  if (
    ds === "deforestation" ||
    ds === "wildfire" ||
    /\b(ndvi|canopy|forest|amazon|vegetation|ecosystem|wildfire|fire|burn|biome|biosphere|chlorophyll|productivity)\b/.test(
      text
    )
  ) {
    return "Biosphere";
  }

  return "Atmosphere";
}

interface AdjacencyLink {
  nextUuid: string;
  edge: ETGEdge;
  forwardAligned: boolean;
}

function shortenLabel(name: string): string {
  const cleaned = name
    .replace(/\([^)]*\)/g, "")
    .replace(/^(NASA|NOAA|NSIDC|GISTEMP|KNMI|SWOT|EONET|MERRA-2)\s+/i, "")
    .trim();
  const words = cleaned.split(/\s+/);
  if (words.length <= 3) return cleaned;
  return words.slice(0, 3).join(" ");
}

/**
 * Traces multi-hop cross-sphere Earth-system cascade chains (3 to 5 nodes, 2 to 4 hops)
 * through causal, corroborating, and teleconnection links in the Earth Trend Graph.
 */
export function findMultiHopCascades(
  nodes: readonly ETGNode[],
  edges: readonly ETGEdge[],
  focusUuid?: string,
  limit = 6
): EarthCascadeChain[] {
  const nodeMap = new Map<string, ETGNode>();
  const adjacency = new Map<string, AdjacencyLink[]>();

  for (const node of nodes) {
    if (node.label === "Rule") continue;
    // Skip static catalog agency Concept shells that lack observational telemetry series.
    const seriesLen = node.properties.series?.length ?? node.properties.series_count ?? 0;
    if (node.label === "Concept" && seriesLen === 0) {
      continue;
    }
    nodeMap.set(node.uuid, node);
    adjacency.set(node.uuid, []);
  }

  for (const edge of edges) {
    if (!ALLOWED_CASCADE_EDGES.has(edge.type)) continue;
    const src = nodeMap.get(edge.source_uuid);
    const dst = nodeMap.get(edge.target_uuid);
    if (!src || !dst || src.uuid === dst.uuid) continue;

    const lag = edge.properties.optimal_lag_steps;
    const srcToDstAligned = lag === undefined || lag >= 0;
    adjacency.get(src.uuid)?.push({
      nextUuid: dst.uuid,
      edge,
      forwardAligned: srcToDstAligned,
    });

    if (!DIRECTED_SUPPORT_EDGES.has(edge.type)) {
      const dstToSrcAligned = lag !== undefined && lag < 0;
      adjacency.get(dst.uuid)?.push({
        nextUuid: src.uuid,
        edge,
        forwardAligned: dstToSrcAligned,
      });
    }
  }

  const rawCandidates: Array<EarthCascadeChain & { nodeSetKey: string; edgeSetKey: string }> = [];
  const maxPathsCollected = 200;

  function dfs(
    pathNodes: ETGNode[],
    pathEdges: ETGEdge[],
    forwardFlags: boolean[],
    visited: Set<string>
  ): void {
    if (rawCandidates.length >= maxPathsCollected) return;

    if (pathNodes.length >= 3) {
      const spheres: EarthSphere[] = [];
      for (const n of pathNodes) {
        const sp = inferEarthSphere(n);
        if (!spheres.includes(sp)) spheres.push(sp);
      }

      if (spheres.length >= 2) {
        const steps: EarthCascadeStep[] = pathNodes.map((n, idx) => {
          const prevEdge = idx > 0 ? pathEdges[idx - 1] : undefined;
          return {
            nodeUuid: n.uuid,
            nodeName: n.properties.name,
            sphere: inferEarthSphere(n),
            dataset: n.properties.dataset,
            edgeUuid: prevEdge?.properties.uuid,
            edgeType: prevEdge?.type,
            correlationR: prevEdge?.properties.correlation_r,
            detrendedR: prevEdge?.properties.detrended_r,
            lagSteps: prevEdge?.properties.optimal_lag_steps,
            lagUnit: prevEdge?.properties.lag_unit,
            mechanism: prevEdge?.properties.mechanism,
          };
        });

        const absRs = pathEdges.map((e) => Math.abs(e.properties.correlation_r ?? 0.6));
        const meanAbsR = absRs.reduce((s, v) => s + v, 0) / Math.max(1, absRs.length);
        const oppositeCount = pathEdges.filter((e) => e.type === "drives_opposite").length;
        const lagBonus = forwardFlags.filter(Boolean).length * 0.14;
        const includesFocus = Boolean(focusUuid && pathNodes.some((n) => n.uuid === focusUuid));

        const score =
          spheres.length * 1.5 +
          pathNodes.length * 0.5 +
          meanAbsR * 1.6 +
          oppositeCount * 0.25 +
          lagBonus +
          (includesFocus ? 2.5 : 0);

        const title = pathNodes.map((n) => shortenLabel(n.properties.name)).join(" → ");
        const summary = `${pathNodes.length}-stage pathway across ${spheres.join(" → ")} (mean |r| = ${meanAbsR.toFixed(2)})`;

        rawCandidates.push({
          id: pathEdges.map((e) => e.properties.uuid).join(">"),
          title,
          summary,
          spheres,
          nodeUuids: pathNodes.map((n) => n.uuid),
          edgeUuids: pathEdges.map((e) => e.properties.uuid),
          steps,
          meanAbsR,
          score,
          nodeSetKey: [...pathNodes.map((n) => n.uuid)].sort().join("|"),
          edgeSetKey: [...pathEdges.map((e) => e.properties.uuid)].sort().join("|"),
        });
      }
    }

    if (pathNodes.length >= 5) return;

    const current = pathNodes[pathNodes.length - 1];
    const neighbors = [...(adjacency.get(current.uuid) ?? [])].sort((a, b) => {
      const aScore =
        Math.abs(a.edge.properties.correlation_r ?? 0.6) +
        (a.edge.type === "drives_opposite" ? 0.2 : 0) +
        (a.forwardAligned ? 0.12 : 0);
      const bScore =
        Math.abs(b.edge.properties.correlation_r ?? 0.6) +
        (b.edge.type === "drives_opposite" ? 0.2 : 0) +
        (b.forwardAligned ? 0.12 : 0);
      return bScore - aScore;
    });

    for (const link of neighbors.slice(0, 6)) {
      if (visited.has(link.nextUuid)) continue;
      const nextNode = nodeMap.get(link.nextUuid);
      if (!nextNode) continue;

      visited.add(link.nextUuid);
      pathNodes.push(nextNode);
      pathEdges.push(link.edge);
      forwardFlags.push(link.forwardAligned);
      dfs(pathNodes, pathEdges, forwardFlags, visited);
      forwardFlags.pop();
      pathEdges.pop();
      pathNodes.pop();
      visited.delete(link.nextUuid);
    }
  }

  const orderedNodes = [...nodeMap.values()].sort((a, b) => {
    if (a.uuid === focusUuid) return -1;
    if (b.uuid === focusUuid) return 1;
    return (adjacency.get(b.uuid)?.length ?? 0) - (adjacency.get(a.uuid)?.length ?? 0);
  });

  for (const startNode of orderedNodes) {
    if (rawCandidates.length >= maxPathsCollected) break;
    if ((adjacency.get(startNode.uuid)?.length ?? 0) === 0) continue;
    dfs([startNode], [], [], new Set([startNode.uuid]));
  }

  rawCandidates.sort((a, b) => b.score - a.score);

  const selected: EarthCascadeChain[] = [];
  const seenNodeSets = new Set<string>();
  const seenEdgeSets = new Set<string>();

  for (const cand of rawCandidates) {
    if (seenNodeSets.has(cand.nodeSetKey) || seenEdgeSets.has(cand.edgeSetKey)) continue;
    const overlapsExisting = selected.some((existing) => {
      const existingEdges = new Set(existing.edgeUuids);
      const sharedCount = cand.edgeUuids.filter((id) => existingEdges.has(id)).length;
      return sharedCount >= cand.edgeUuids.length;
    });
    if (overlapsExisting) continue;

    seenNodeSets.add(cand.nodeSetKey);
    seenEdgeSets.add(cand.edgeSetKey);
    selected.push({
      id: cand.id,
      title: cand.title,
      summary: cand.summary,
      spheres: cand.spheres,
      nodeUuids: cand.nodeUuids,
      edgeUuids: cand.edgeUuids,
      steps: cand.steps,
      meanAbsR: cand.meanAbsR,
      score: cand.score,
    });
    if (selected.length >= limit) break;
  }

  return selected;
}
