import { bearingDeg } from "@/lib/solar/denverClimateGraph";
import { scorePairWithTrendMicroscope } from "@/lib/graph/trendMicroscope";
import {
  benjaminiHochbergAdjust,
  compareRegionalSeries,
} from "@/lib/stats/trendEngine";
import type {
  CandidateLinkSuggestion,
  CausalPathSummary,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  OppositeTrendPair,
  ProvenanceHop,
  SubgraphNodeRole,
  SubgraphTraversalOptions,
  SubgraphTraversalResult,
  TraversalDirection,
} from "@/types/etg";
import {
  SYMMETRIC_EDGE_TYPES,
  alignCompatibleSeries,
  haversineKm,
  inferNodeTemporalScale,
  type EtgGraphSnapshot,
  type EtgQueryFilter,
} from "./etgSeriesAndTrustUtils";
import type { EtgStoreContext } from "./etgStoreContext";

export function assembleRegionalContextSubgraphOp(
  ctx: EtgStoreContext,
  options: {
    targetUuid?: string;
    lat?: number;
    lng?: number;
    dataset?: ETGDatasetId;
    radiusKm?: number;
    maxHops?: number;
    includeGlobalModes?: boolean;
  }
): {
  targetNode?: ETGNode;
  nodes: ETGNode[];
  edges: ETGEdge[];
  scalesUsed: Array<"day" | "month" | "year" | "impulse">;
  distancesByUuid: Record<string, number>;
} {
  const radiusKm = Math.max(100, Math.min(8000, options.radiusKm ?? 1800));
  let targetNode = options.targetUuid ? ctx.nodes.get(options.targetUuid) : undefined;
  if (targetNode?.properties.status === "Superseded") {
    targetNode = undefined;
  }

  const anchorLat = options.lat ?? targetNode?.properties.lat;
  const anchorLng = options.lng ?? targetNode?.properties.lng;

  if (!targetNode && anchorLat !== undefined && anchorLng !== undefined) {
    let bestDist = Infinity;
    for (const n of ctx.nodes.values()) {
      if (n.properties.status === "Superseded") continue;
      if (n.properties.lat === undefined || n.properties.lng === undefined) continue;
      if (options.dataset && n.properties.dataset && n.properties.dataset !== options.dataset) {
        continue;
      }
      const d = haversineKm(anchorLat, anchorLng, n.properties.lat, n.properties.lng);
      if (d <= 85 && d < bestDist) {
        bestDist = d;
        targetNode = n;
      }
    }
  }

  const nodeMap = new Map<string, ETGNode>();
  const distancesByUuid: Record<string, number> = {};
  if (targetNode) {
    nodeMap.set(targetNode.uuid, targetNode);
    distancesByUuid[targetNode.uuid] = 0;
  }

  if (anchorLat !== undefined && anchorLng !== undefined) {
    for (const n of ctx.nodes.values()) {
      if (n.properties.status === "Superseded") continue;
      if (n.properties.lat !== undefined && n.properties.lng !== undefined) {
        const d = haversineKm(anchorLat, anchorLng, n.properties.lat, n.properties.lng);
        if (d <= radiusKm) {
          nodeMap.set(n.uuid, n);
          distancesByUuid[n.uuid] = Number(d.toFixed(1));
        }
      }
    }
  }

  const kHopSeeds = Array.from(nodeMap.keys());
  const hops = Math.max(1, Math.min(4, options.maxHops ?? 2));
  for (const seed of kHopSeeds.slice(0, 12)) {
    const trav = ctx.traverseSubgraph({
      rootUuid: seed,
      maxHops: hops,
      direction: "both",
    });
    for (const n of trav.nodes) {
      if (n.properties.status !== "Superseded") {
        nodeMap.set(n.uuid, n);
      }
    }
  }

  if (options.includeGlobalModes !== false) {
    for (const n of ctx.nodes.values()) {
      if (n.properties.status === "Superseded") continue;
      const rawTags = Array.isArray(n.properties.domain_tags) ? n.properties.domain_tags : [];
      const tags = rawTags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase());
      const isGlobalMode =
        n.uuid.startsWith("signal-knmi-") ||
        n.uuid.startsWith("signal-gistemp-") ||
        n.uuid === "signal-noaa-global-co2" ||
        n.uuid === "signal-nsidc-arctic-seaice" ||
        n.properties.phenomenon_type === "climate_index" ||
        tags.some(
          (t) =>
            t === "global" ||
            t === "teleconnection" ||
            t === "enso" ||
            t === "climate_mode"
        );
      if (isGlobalMode) {
        nodeMap.set(n.uuid, n);
      }
    }
  }

  for (const n of nodeMap.values()) {
    if (distancesByUuid[n.uuid] === undefined) {
      if (
        anchorLat !== undefined &&
        anchorLng !== undefined &&
        n.properties.lat !== undefined &&
        n.properties.lng !== undefined
      ) {
        distancesByUuid[n.uuid] = Number(
          haversineKm(anchorLat, anchorLng, n.properties.lat, n.properties.lng).toFixed(1)
        );
      } else {
        distancesByUuid[n.uuid] = 0;
      }
    }
  }

  const nodes = Array.from(nodeMap.values());
  const edges = Array.from(ctx.edges.values()).filter(
    (e) =>
      nodeMap.has(e.source_uuid) &&
      nodeMap.has(e.target_uuid) &&
      !e.properties.superseded_at
  );

  const scalesSet = new Set<"day" | "month" | "year" | "impulse">();
  for (const n of nodes) {
    const s = ctx.getNodeSeries(n.uuid);
    scalesSet.add(inferNodeTemporalScale(n, s));
    for (const av of n.properties.available_scales ?? []) {
      scalesSet.add(av);
    }
    const ms = ctx.multiScaleSeriesByNode.get(n.uuid);
    if (ms?.day?.length) scalesSet.add("day");
    if (ms?.month?.length) scalesSet.add("month");
    if (ms?.year?.length) scalesSet.add("year");
  }

  return {
    targetNode,
    nodes,
    edges,
    scalesUsed: Array.from(scalesSet),
    distancesByUuid,
  };
}

export function getOppositeTrendPairsOp(
  ctx: EtgStoreContext,
  nodeSubset?: Set<string>
): OppositeTrendPair[] {
  const pairs: OppositeTrendPair[] = [];
  for (const edge of ctx.edges.values()) {
    if (edge.type !== "drives_opposite") continue;
    if (nodeSubset && (!nodeSubset.has(edge.source_uuid) || !nodeSubset.has(edge.target_uuid))) {
      continue;
    }
    const source = ctx.nodes.get(edge.source_uuid);
    const target = ctx.nodes.get(edge.target_uuid);
    if (!source || !target) continue;
    pairs.push({
      edgeUuid: edge.properties.uuid,
      source,
      target,
      correlationR: edge.properties.correlation_r,
      detrendedR: edge.properties.detrended_r,
      lagDays: edge.properties.lag_days,
      optimalLagSteps: edge.properties.optimal_lag_steps,
      mechanism: edge.properties.mechanism,
      rationale: edge.properties.rationale || edge.properties.source_snippet,
    });
  }
  return pairs;
}

export function queryGraphOp(
  ctx: EtgStoreContext,
  filter: EtgQueryFilter = {}
): EtgGraphSnapshot {
  const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
  const untilMs = filter.until ? Date.parse(filter.until) : NaN;
  const searchLower = filter.search?.trim().toLowerCase() || "";
  const includeSuperseded = filter.includeSuperseded ?? true;

  let filteredNodes = Array.from(ctx.nodes.values()).filter((node) => {
    if (!includeSuperseded && node.properties.status === "Superseded") return false;
    if (filter.label && filter.label !== "all" && node.label !== filter.label) return false;
    if (filter.dataset && filter.dataset !== "all") {
      // Keep Rule/System nodes if dataset is unspecified on them, otherwise filter strictly
      if (node.properties.dataset && node.properties.dataset !== filter.dataset) return false;
      if (!node.properties.dataset && node.label !== "Rule") return false;
    }

    const tsStr = node.properties.observed_at || node.properties.created_at;
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    if (!Number.isNaN(sinceMs) && !Number.isNaN(tsMs) && tsMs < sinceMs) return false;
    if (!Number.isNaN(untilMs) && !Number.isNaN(tsMs) && tsMs > untilMs) return false;

    if (
      filter.lat !== undefined &&
      filter.lng !== undefined &&
      filter.radiusKm !== undefined
    ) {
      if (node.properties.lat === undefined || node.properties.lng === undefined) return false;
      const dist = haversineKm(filter.lat, filter.lng, node.properties.lat, node.properties.lng);
      if (dist > filter.radiusKm) return false;
    }

    if (searchLower) {
      const hay = `${node.properties.name} ${node.properties.description} ${node.properties.region || ""} ${node.label}`.toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });

  if (filter.onlyOppositeTrends) {
    const preNodeSet = new Set(filteredNodes.map((n) => n.uuid));
    const oppIds = new Set<string>();
    for (const e of ctx.edges.values()) {
      if (
        e.type === "drives_opposite" &&
        preNodeSet.has(e.source_uuid) &&
        preNodeSet.has(e.target_uuid)
      ) {
        oppIds.add(e.source_uuid);
        oppIds.add(e.target_uuid);
      }
    }
    filteredNodes = filteredNodes.filter((n) => oppIds.has(n.uuid));
  }

  const nodeSet = new Set(filteredNodes.map((n) => n.uuid));
  const filteredEdges = Array.from(ctx.edges.values()).filter(
    (e) => nodeSet.has(e.source_uuid) && nodeSet.has(e.target_uuid)
  );

  return {
    nodes: filteredNodes,
    edges: filteredEdges,
    oppositeTrendPairs: ctx.getOppositeTrendPairs(nodeSet),
    activity: ctx.activity,
    stats: ctx.computeStats(),
  };
}

export function traceShortestPathOp(
  ctx: EtgStoreContext,
  fromUuid: string,
  toUuid: string,
  maxHops = 6
): ProvenanceHop[] | null {
  if (!ctx.nodes.has(fromUuid) || !ctx.nodes.has(toUuid)) return null;
  if (fromUuid === toUuid) {
    const n = ctx.nodes.get(fromUuid)!;
    return [{ nodeUuid: n.uuid, name: n.properties.name, label: n.label, depth: 0 }];
  }

  const adj = new Map<string, Array<{ next: string; type: ETGRelationshipType }>>();
  for (const e of ctx.edges.values()) {
    const fwd = adj.get(e.source_uuid) ?? [];
    fwd.push({ next: e.target_uuid, type: e.type });
    adj.set(e.source_uuid, fwd);

    const rev = adj.get(e.target_uuid) ?? [];
    rev.push({ next: e.source_uuid, type: e.type });
    adj.set(e.target_uuid, rev);
  }

  const visited = new Set<string>([fromUuid]);
  let frontier: Array<Array<{ id: string; via?: ETGRelationshipType }>> = [[{ id: fromUuid }]];

  for (let depth = 1; depth <= maxHops; depth++) {
    const nextFrontier: typeof frontier = [];
    for (const pathItems of frontier) {
      const tail = pathItems[pathItems.length - 1].id;
      for (const edge of adj.get(tail) ?? []) {
        if (visited.has(edge.next)) continue;
        const extended = [...pathItems, { id: edge.next, via: edge.type }];
        if (edge.next === toUuid) {
          return extended.map((item, idx) => {
            const node = ctx.nodes.get(item.id)!;
            return {
              nodeUuid: node.uuid,
              name: node.properties.name,
              label: node.label,
              edgeType: item.via,
              depth: idx,
            };
          });
        }
        visited.add(edge.next);
        nextFrontier.push(extended);
      }
    }
    if (nextFrontier.length === 0) return null;
    frontier = nextFrontier;
  }
  return null;
}

export function isBidirectionalTraversalEdge(edge: ETGEdge): boolean {
  if (!SYMMETRIC_EDGE_TYPES.has(edge.type)) return false;
  const lag = edge.properties.optimal_lag_steps;
  return lag === undefined || lag === 0;
}

/**
 * Traverses a k-hop neighborhood from `rootUuid` respecting causal direction (`upstream`, `downstream`, or `both`).
 */
export function traverseSubgraphOp(
  ctx: EtgStoreContext,
  options: SubgraphTraversalOptions
): SubgraphTraversalResult {
  const maxHops = Math.max(1, Math.min(6, Math.round(options.maxHops ?? 2)));
  const direction: TraversalDirection = options.direction ?? "both";
  const includeSuperseded = options.includeSuperseded ?? false;
  const allowedTypes =
    options.edgeTypes && options.edgeTypes.length > 0 ? new Set(options.edgeTypes) : null;
  const minWeight = options.minWeight ?? 0;

  const rootNode = ctx.nodes.get(options.rootUuid);
  if (!rootNode) {
    return {
      rootUuid: options.rootUuid,
      maxHops,
      direction,
      nodes: [],
      edges: [],
      hopByNode: {},
      roleByNode: {},
      causalPaths: [],
    };
  }

  const canTraverseEdge = (edge: ETGEdge): boolean => {
    if (allowedTypes && !allowedTypes.has(edge.type)) return false;
    if (ctx.getEdgeWeight(edge) < minWeight) return false;
    const src = ctx.nodes.get(edge.source_uuid);
    const dst = ctx.nodes.get(edge.target_uuid);
    if (!src || !dst) return false;
    if (!includeSuperseded && (src.properties.status === "Superseded" || dst.properties.status === "Superseded")) {
      return false;
    }
    return true;
  };

  const runDirectionalBfs = (mode: "upstream" | "downstream"): Map<string, number> => {
    const dist = new Map<string, number>([[options.rootUuid, 0]]);
    const queue: string[] = [options.rootUuid];
    let head = 0;

    while (head < queue.length) {
      const curr = queue[head++];
      const d = dist.get(curr)!;
      if (d >= maxHops) continue;

      for (const edge of ctx.edges.values()) {
        if (!canTraverseEdge(edge)) continue;
        const isSym = isBidirectionalTraversalEdge(edge);
        const lagNeg =
          typeof edge.properties.optimal_lag_steps === "number" && edge.properties.optimal_lag_steps < 0;

        let next: string | null = null;
        if (mode === "upstream") {
          if (!lagNeg && edge.target_uuid === curr) next = edge.source_uuid;
          else if (lagNeg && edge.source_uuid === curr) next = edge.target_uuid;
          else if (isSym) {
            if (edge.target_uuid === curr) next = edge.source_uuid;
            else if (edge.source_uuid === curr) next = edge.target_uuid;
          }
        } else {
          if (!lagNeg && edge.source_uuid === curr) next = edge.target_uuid;
          else if (lagNeg && edge.target_uuid === curr) next = edge.source_uuid;
          else if (isSym) {
            if (edge.source_uuid === curr) next = edge.target_uuid;
            else if (edge.target_uuid === curr) next = edge.source_uuid;
          }
        }

        if (next && !dist.has(next)) {
          dist.set(next, d + 1);
          queue.push(next);
        }
      }
    }
    return dist;
  };

  const upDist = direction === "downstream" ? new Map<string, number>() : runDirectionalBfs("upstream");
  const downDist = direction === "upstream" ? new Map<string, number>() : runDirectionalBfs("downstream");

  const hopByNode: Record<string, number> = { [options.rootUuid]: 0 };
  const roleByNode: Record<string, SubgraphNodeRole> = { [options.rootUuid]: "root" };

  const allIds = new Set<string>([options.rootUuid, ...upDist.keys(), ...downDist.keys()]);
  for (const id of allIds) {
    if (id === options.rootUuid) continue;
    const u = upDist.get(id);
    const dn = downDist.get(id);
    const minHop = Math.min(u ?? Infinity, dn ?? Infinity);
    hopByNode[id] = minHop;
    if (u !== undefined && dn !== undefined) {
      roleByNode[id] = "bidirectional";
    } else if (u !== undefined) {
      roleByNode[id] = "upstream";
    } else {
      roleByNode[id] = "downstream";
    }
  }

  const inducedNodes = Array.from(allIds)
    .map((id) => ctx.nodes.get(id))
    .filter((n): n is ETGNode => Boolean(n))
    .sort((a, b) => (hopByNode[a.uuid] ?? 99) - (hopByNode[b.uuid] ?? 99));

  const inducedEdges = Array.from(ctx.edges.values()).filter(
    (e) => allIds.has(e.source_uuid) && allIds.has(e.target_uuid) && canTraverseEdge(e)
  );

  // Rank top causal paths radiating up/down from root
  const causalPaths: CausalPathSummary[] = [];
  const buildPathsFromRoot = (mode: "upstream" | "downstream") => {
    const dfs = (curr: string, pathNodes: string[], pathEdges: string[], lagSum: number, scoreProd: number) => {
      if (pathEdges.length >= 1) {
        const orderedNodes = mode === "upstream" ? [...pathNodes].reverse() : pathNodes;
        const orderedEdges = mode === "upstream" ? [...pathEdges].reverse() : pathEdges;
        const labels = orderedNodes.map((id) => ctx.nodes.get(id)?.properties.name ?? id);
        causalPaths.push({
          nodeUuids: orderedNodes,
          edgeUuids: orderedEdges,
          cumulativeLagSteps: lagSum,
          score: Number(scoreProd.toFixed(3)),
          summary: labels.join(" → "),
        });
      }
      if (pathEdges.length >= maxHops) return;
      for (const edge of inducedEdges) {
        if (pathEdges.includes(edge.properties.uuid)) continue;
        const next =
          mode === "downstream" && edge.source_uuid === curr
            ? edge.target_uuid
            : mode === "upstream" && edge.target_uuid === curr
              ? edge.source_uuid
              : null;
        if (!next || pathNodes.includes(next)) continue;
        const w = ctx.getEdgeWeight(edge);
        const lag = Math.abs(edge.properties.optimal_lag_steps ?? 0);
        dfs(next, [...pathNodes, next], [...pathEdges, edge.properties.uuid], lagSum + lag, scoreProd * w);
      }
    };
    dfs(options.rootUuid, [options.rootUuid], [], 0, 1);
  };

  if (direction !== "downstream") buildPathsFromRoot("upstream");
  if (direction !== "upstream") buildPathsFromRoot("downstream");

  causalPaths.sort((a, b) => b.edgeUuids.length - a.edgeUuids.length || b.score - a.score);

  return {
    rootUuid: options.rootUuid,
    maxHops,
    direction,
    nodes: inducedNodes,
    edges: inducedEdges,
    hopByNode,
    roleByNode,
    causalPaths: causalPaths.slice(0, 8),
  };
}

/**
 * Returns top weighted simple paths between two nodes (up to 6 results).
 */
export function findAllPathsOp(
  ctx: EtgStoreContext,
  fromUuid: string,
  toUuid: string,
  maxHops = 5
): CausalPathSummary[] {
  if (!ctx.nodes.has(fromUuid) || !ctx.nodes.has(toUuid)) return [];
  const results: CausalPathSummary[] = [];
  const clampedHops = Math.max(1, Math.min(6, maxHops));

  const dfs = (curr: string, visited: string[], viaEdges: string[], lagSum: number, scoreProd: number) => {
    if (results.length >= 24) return;
    if (curr === toUuid && viaEdges.length > 0) {
      const names = visited.map((id) => ctx.nodes.get(id)?.properties.name ?? id);
      results.push({
        nodeUuids: visited,
        edgeUuids: viaEdges,
        cumulativeLagSteps: lagSum,
        score: Number(Math.pow(scoreProd, 1 / viaEdges.length).toFixed(3)),
        summary: names.join(" → "),
      });
      return;
    }
    if (viaEdges.length >= clampedHops) return;

    for (const edge of ctx.edges.values()) {
      const next =
        edge.source_uuid === curr
          ? edge.target_uuid
          : edge.target_uuid === curr
            ? edge.source_uuid
            : null;
      if (!next || visited.includes(next)) continue;
      dfs(
        next,
        [...visited, next],
        [...viaEdges, edge.properties.uuid],
        lagSum + Math.abs(edge.properties.optimal_lag_steps ?? 0),
        scoreProd * ctx.getEdgeWeight(edge)
      );
    }
  };

  dfs(fromUuid, [fromUuid], [], 0, 1);
  results.sort((a, b) => b.score - a.score || a.edgeUuids.length - b.edgeUuids.length);
  return results.slice(0, 6);
}

/**
 * Scans unconnected node pairs across the graph for latent lead-lag, opposite, or structural connections.
 */
export function discoverCandidateLinksOp(
  ctx: EtgStoreContext,
  options?: {
    anchorUuid?: string;
    minAbsR?: number;
    limit?: number;
  }
): CandidateLinkSuggestion[] {
  const minAbsR = options?.minAbsR ?? 0.42;
  const limit = Math.max(1, Math.min(30, options?.limit ?? 12));
  const anchorUuid = options?.anchorUuid;

  const candidates = Array.from(ctx.nodes.values()).filter(
    (n) => n.properties.status !== "Superseded" && n.label !== "Rule"
  );
  if (candidates.length < 2) return [];

  const pairQueue: Array<[ETGNode, ETGNode]> = [];
  if (anchorUuid) {
    const anchor = ctx.nodes.get(anchorUuid);
    if (!anchor) return [];
    for (const other of candidates) {
      if (other.uuid === anchorUuid) continue;
      if (ctx.hasEdgeBetween(anchor.uuid, other.uuid, false)) continue;
      pairQueue.push([anchor, other]);
    }
  } else {
    const capped = candidates.slice(0, 60);
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        if (ctx.hasEdgeBetween(capped[i].uuid, capped[j].uuid, false)) continue;
        pairQueue.push([capped[i], capped[j]]);
      }
    }
  }

  const suggestions: CandidateLinkSuggestion[] = [];

  for (const [nodeA, nodeB] of pairQueue) {
    const seriesA = ctx.getNodeSeries(nodeA.uuid);
    const seriesB = ctx.getNodeSeries(nodeB.uuid);
    const hasCoords =
      nodeA.properties.lat !== undefined &&
      nodeA.properties.lng !== undefined &&
      nodeB.properties.lat !== undefined &&
      nodeB.properties.lng !== undefined;
    const distKm = hasCoords
      ? Math.round(haversineKm(nodeA.properties.lat!, nodeA.properties.lng!, nodeB.properties.lat!, nodeB.properties.lng!))
      : undefined;

    if (seriesA && seriesB && seriesA.length >= 8 && seriesB.length >= 8) {
      const aligned = alignCompatibleSeries(seriesA, seriesB);
      if (aligned && aligned.alignedA.length >= 8) {
        const comp = compareRegionalSeries(aligned.alignedA, aligned.alignedB, {
          latA: nodeA.properties.lat,
          lngA: nodeA.properties.lng,
          datasetA: nodeA.properties.dataset,
          latB: nodeB.properties.lat,
          lngB: nodeB.properties.lng,
          datasetB: nodeB.properties.dataset,
        });
        const maxAbsR = Math.max(
          Math.abs(comp.pearsonR),
          Math.abs(comp.detrendedR),
          Math.abs(comp.optimalLagR)
        );
        if (maxAbsR < minAbsR) continue;

        const swap = comp.optimalLagSteps < 0;
        const src = swap ? nodeB : nodeA;
        const dst = swap ? nodeA : nodeB;
        const lag = Math.abs(comp.optimalLagSteps);
        const bearing =
          src.properties.lat !== undefined &&
          src.properties.lng !== undefined &&
          dst.properties.lat !== undefined &&
          dst.properties.lng !== undefined
            ? Math.round(bearingDeg(src.properties.lat, src.properties.lng, dst.properties.lat, dst.properties.lng))
            : undefined;

        let suggestedType: ETGRelationshipType = "correlates_with";
        if (comp.classification === "opposite_teleconnection" || comp.detrendedR <= -0.5) {
          suggestedType = "drives_opposite";
        } else if (lag >= 1) {
          suggestedType = "leads";
        } else if (distKm !== undefined && distKm >= 1500) {
          suggestedType = "teleconnects";
        }

        const sigBoost = comp.pValue < 0.05 || comp.detrendedPValue < 0.05 ? 0.12 : 0;
        const lagBoost = lag >= 1 ? 0.08 : 0;
        const secularPenalty = comp.isSecularDriftOnly ? -0.22 : 0;
        const srcSer = swap ? seriesB : seriesA;
        const dstSer = swap ? seriesA : seriesB;
        const micro = scorePairWithTrendMicroscope(src, srcSer, dst, dstSer);
        const microLift = micro
          ? 0.12 * (micro.trueCouplingProb - micro.confounderProb)
          : 0;
        const score = Math.max(
          0.05,
          Math.min(0.99, Number((maxAbsR * 0.8 + sigBoost + lagBoost + secularPenalty + microLift).toFixed(3)))
        );
        const rawP = comp.isSecularDriftOnly
          ? Math.min(comp.detrendedPValue, comp.optimalLagPValue)
          : Math.min(comp.pValue, comp.detrendedPValue, comp.optimalLagPValue);

        suggestions.push({
          id: `cand-${src.uuid.slice(0, 8)}-${dst.uuid.slice(0, 8)}`,
          sourceUuid: src.uuid,
          targetUuid: dst.uuid,
          sourceName: src.properties.name,
          targetName: dst.properties.name,
          suggestedType,
          pearsonR: Number(comp.pearsonR.toFixed(3)),
          detrendedR: Number(comp.detrendedR.toFixed(3)),
          pValue: Number(rawP.toFixed(4)),
          isSecularDriftOnly: Boolean(comp.isSecularDriftOnly),
          optimalLagSteps: lag,
          lagUnit: comp.lagUnit,
          distanceKm: distKm,
          bearingDeg: bearing,
          ...(micro
            ? {
                microscopeCouplingProb: micro.trueCouplingProb,
                confounderProb: micro.confounderProb,
              }
            : {}),
          score,
          mechanism: comp.mechanism,
          rationale: `${src.properties.name} ${suggestedType === "leads" ? `leads ${dst.properties.name} by ${lag} ${comp.lagUnit}` : `couples with ${dst.properties.name}`} (r=${comp.pearsonR.toFixed(2)}, detrended r=${comp.detrendedR.toFixed(2)}${distKm !== undefined ? `, ${distKm} km` : ""}${comp.isSecularDriftOnly ? ", shared long-term drift only" : ""}).`,
        });
        continue;
      }
    }

    // Structural fallback for discrete events, rules, or newly added human phenomena without long series
    const tagsA = new Set((nodeA.properties.domain_tags ?? []).map((t) => t.toLowerCase()));
    const tagsB = new Set((nodeB.properties.domain_tags ?? []).map((t) => t.toLowerCase()));
    const sharedTags = Array.from(tagsA).filter((t) => tagsB.has(t));
    const closeInSpace = distKm !== undefined && distKm < 1200;

    if (closeInSpace || sharedTags.length > 0) {
      const proximityScore = closeInSpace ? Math.max(0.25, 1 - distKm! / 1500) * 0.65 : 0;
      const tagScore = Math.min(0.45, sharedTags.length * 0.25);
      const score = Number(Math.min(0.92, proximityScore + tagScore + 0.18).toFixed(3));
      if (score < 0.52) continue;

      const isEventSrc = nodeA.properties.phenomenon_type === "discrete_event" || nodeA.properties.dataset === "wildfire";
      const src = isEventSrc ? nodeA : nodeB;
      const dst = isEventSrc ? nodeB : nodeA;
      const suggestedType: ETGRelationshipType =
        dst.properties.phenomenon_type === "physical_impact"
          ? "impacts"
          : isEventSrc
            ? "triggers"
            : "relates_to";

      suggestions.push({
        id: `cand-struct-${src.uuid.slice(0, 8)}-${dst.uuid.slice(0, 8)}`,
        sourceUuid: src.uuid,
        targetUuid: dst.uuid,
        sourceName: src.properties.name,
        targetName: dst.properties.name,
        suggestedType,
        distanceKm: distKm,
        score,
        mechanism: closeInSpace
          ? `Regional coupling (${distKm} km separation)`
          : `Shared domain markers (${sharedTags.join(", ")})`,
        rationale: closeInSpace
          ? `${src.properties.name} is located ${distKm} km from ${dst.properties.name}; potential physical driver/impact link.`
          : `${src.properties.name} and ${dst.properties.name} share ${sharedTags.join(", ")} tags.`,
      });
    }
  }

  // Apply Benjamini-Hochberg FDR across all statistical candidate suggestions
  const statIndices: number[] = [];
  const statPValues: number[] = [];
  suggestions.forEach((s, i) => {
    if (typeof s.pValue === "number" && Number.isFinite(s.pValue)) {
      statIndices.push(i);
      statPValues.push(s.pValue);
    }
  });
  if (statPValues.length > 0) {
    const fdrQs = benjaminiHochbergAdjust(statPValues);
    statIndices.forEach((sugIdx, pos) => {
      const q = Number(fdrQs[pos].toFixed(4));
      const sug = suggestions[sugIdx];
      sug.fdrQValue = q;
      if (!sug.isSecularDriftOnly && q < 0.05) {
        sug.score = Math.min(0.99, Number((sug.score + 0.05).toFixed(3)));
      }
      sug.rationale = `${sug.rationale.replace(/\.$/, "")} [FDR q=${q.toFixed(3)}].`;
    });
  }

  suggestions.sort((a, b) => {
    const driftA = a.isSecularDriftOnly ? 1 : 0;
    const driftB = b.isSecularDriftOnly ? 1 : 0;
    if (driftA !== driftB) return driftA - driftB;
    return b.score - a.score;
  });
  return suggestions.slice(0, limit);
}
