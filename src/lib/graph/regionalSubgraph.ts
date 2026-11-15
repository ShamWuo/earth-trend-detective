import type { ETGEdge, ETGNode } from "@/types/etg";

export interface RegionOption {
  id: string;
  label: string;
  count: number;
}

export interface RegionalSubgraphResult {
  nodes: ETGNode[];
  edges: ETGEdge[];
  localNodeUuids: Set<string>;
  bridgeNodeUuids: Set<string>;
}

const CROSS_REGION_DRIVER_TYPES = new Set<string>([
  "drives_opposite",
  "teleconnects",
  "advects_to",
  "leads",
  "amplifies",
  "dampens",
  "triggers",
  "corroborates",
]);

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Computes the circular mean of longitudes (degrees in [-180, 180]) so clusters
 * spanning the International Date Line (e.g. +165°E & -155°W) average into the Pacific
 * rather than collapsing onto 0°E (Gulf of Guinea / Europe).
 */
export function computeCircularMeanLng(lngs: readonly number[]): number {
  if (lngs.length === 0) return 0;
  let sinSum = 0;
  let cosSum = 0;
  for (const lng of lngs) {
    const rad = (lng * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }
  if (Math.hypot(sinSum, cosSum) < 1e-9) {
    const fallback = lngs[0] ?? 0;
    return Object.is(fallback, -0) ? 0 : fallback;
  }
  const deg = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
  return Object.is(deg, -0) ? 0 : deg;
}

function isCoordOnlyRegion(region: string): boolean {
  return /^-?\d+(\.\d+)?°?,\s*-?\d+(\.\d+)?°?$/.test(region.trim());
}

/**
 * Maps any finite (lat, lng) coordinate to a canonical macro-geographic Earth region
 * so nodes without a named basin/region form coherent planetary clusters instead of
 * single-node islands or a lumped "Global Earth System" blob.
 */
export function classifyEarthRegionByCoord(
  lat: number,
  lng: number
): { id: string; label: string } {
  if (lat >= 64) {
    return { id: "arctic & subarctic", label: "Arctic & Subarctic" };
  }
  if (lat <= -56) {
    return { id: "southern ocean & antarctica", label: "Southern Ocean & Antarctica" };
  }
  if (Math.abs(lat) <= 23.5 && (lng <= -82 || lng >= 150)) {
    return { id: "equatorial & tropical pacific", label: "Equatorial & Tropical Pacific" };
  }
  if (lat > 15 && lng >= -170 && lng <= -50) {
    return { id: "north america", label: "North America" };
  }
  if (lat <= 15 && lat > -56 && lng >= -92 && lng <= -30) {
    return { id: "south america & amazonia", label: "South America & Amazonia" };
  }
  if (lat >= 34 && lng > -30 && lng <= 50) {
    return { id: "europe & north atlantic", label: "Europe & North Atlantic" };
  }
  if (lat > -40 && lat < 34 && lng > -30 && lng <= 55) {
    return { id: "africa & tropical atlantic", label: "Africa & Tropical Atlantic" };
  }
  if (lat >= 5 && lng > 50 && lng < 150) {
    return { id: "asia & indo-pacific", label: "Asia & Indo-Pacific" };
  }
  if (lat < 5 && lat > -56 && lng >= 95 && lng <= 180) {
    return { id: "australia & oceania", label: "Australia & Oceania" };
  }
  if (lng > 40 && lng < 100 && lat < 5) {
    return { id: "indian ocean basin", label: "Indian Ocean Basin" };
  }
  if (lat >= 0) {
    return { id: "north pacific & atlantic gyres", label: "North Pacific & Atlantic Gyres" };
  }
  return { id: "southern hemisphere oceans", label: "Southern Hemisphere Oceans" };
}

/**
 * Classifies a raw `node.properties.region` string so orbital swaths, raw coordinates,
 * EONET event titles, and global reference hubs are grouped cleanly.
 */
export function classifyRegionStringKind(
  raw: string | undefined,
  node?: ETGNode
): "named" | "coord_or_pass" | "global_reference" | "empty" {
  const trimmed = raw?.trim();
  if (!trimmed) return "empty";

  if (
    isCoordOnlyRegion(trimmed) ||
    /^swot swath\s*\(/i.test(trimmed) ||
    /\bcorridor\s*\(\d+\s*km\)/i.test(trimmed) ||
    /\bredteam\b/i.test(trimmed) ||
    /^(wildfire|severe storm|volcano|flood|drought|dust and haze|sea and lake ice|landslide|manmade|snow|water color)s?\s*[-–—:]/i.test(
      trimmed
    ) ||
    (node && node.uuid.startsWith("signal-power-") && trimmed === node.properties.concept_name)
  ) {
    return "coord_or_pass";
  }

  if (
    /\b(global zonal|global reanalysis|global orbital|global surface|global marine|global modes|earthdata|surface water swath)\b/i.test(
      trimmed
    )
  ) {
    return "global_reference";
  }

  return "named";
}

/**
 * Resolves a single node's canonical region/area bucket when viewed in isolation.
 */
export function resolveSingleNodeRegion(node: ETGNode): { id: string; label: string } {
  const raw = node.properties.region?.trim();
  const kind = classifyRegionStringKind(raw, node);

  if (kind === "named" && raw) {
    return { id: raw.toLowerCase(), label: raw };
  }
  if (kind === "global_reference") {
    return { id: "__global_reference__", label: "Global Satellites & Reference" };
  }
  if (
    typeof node.properties.lat === "number" &&
    typeof node.properties.lng === "number" &&
    Number.isFinite(node.properties.lat) &&
    Number.isFinite(node.properties.lng)
  ) {
    return classifyEarthRegionByCoord(node.properties.lat, node.properties.lng);
  }
  if (kind === "coord_or_pass") {
    return { id: "__local_probes__", label: "Local Probes" };
  }
  if (node.label === "Rule") {
    return { id: "__global_rules__", label: "Verification & Rules" };
  }
  return { id: "__global_system__", label: "Global Earth System" };
}

/**
 * Resolves consistent region assignments across a node set:
 * keeps explicit named regions, consolidates global reference networks, snaps
 * coordinate-pinned/unlabeled geo nodes within `maxSnapKm` to nearby named regions,
 * and falls back to macro-geographic Earth regions by `(lat, lng)`.
 */
export function assignNodeRegions(
  nodes: readonly ETGNode[],
  maxSnapKm = 1200
): Map<string, { id: string; label: string }> {
  const geoAccum = new Map<
    string,
    { label: string; sumLat: number; lngs: number[]; count: number }
  >();

  for (const node of nodes) {
    const raw = node.properties.region?.trim();
    if (!raw || classifyRegionStringKind(raw, node) !== "named") continue;
    const lat = node.properties.lat;
    const lng = node.properties.lng;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const id = raw.toLowerCase();
    const cur = geoAccum.get(id);
    if (cur) {
      cur.sumLat += lat;
      cur.lngs.push(lng);
      cur.count += 1;
    } else {
      geoAccum.set(id, { label: raw, sumLat: lat, lngs: [lng], count: 1 });
    }
  }

  const namedCentroids = Array.from(geoAccum.entries()).map(([id, entry]) => ({
    id,
    label: entry.label,
    lat: entry.sumLat / entry.count,
    lng: computeCircularMeanLng(entry.lngs),
  }));

  const assignments = new Map<string, { id: string; label: string }>();
  for (const node of nodes) {
    const raw = node.properties.region?.trim();
    const kind = classifyRegionStringKind(raw, node);

    if (kind === "named" && raw) {
      assignments.set(node.uuid, { id: raw.toLowerCase(), label: raw });
      continue;
    }
    if (kind === "global_reference") {
      assignments.set(node.uuid, {
        id: "__global_reference__",
        label: "Global Satellites & Reference",
      });
      continue;
    }

    const lat = node.properties.lat;
    const lng = node.properties.lng;
    if (
      typeof lat === "number" &&
      typeof lng === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
    ) {
      let best: { id: string; label: string } | null = null;
      let bestDist = maxSnapKm;
      for (const c of namedCentroids) {
        const d = haversineKm(lat, lng, c.lat, c.lng);
        if (d <= bestDist) {
          bestDist = d;
          best = { id: c.id, label: c.label };
        }
      }
      assignments.set(node.uuid, best ?? classifyEarthRegionByCoord(lat, lng));
      continue;
    }

    assignments.set(node.uuid, resolveSingleNodeRegion(node));
  }

  return assignments;
}

/**
 * Extracts distinct area/region buckets from graph nodes, matching the 3D/2D spatial
 * clustering: named/geographic regions first (sorted by node count desc), followed by
 * any remaining global hub or verification buckets.
 */
export function extractRegionOptions(nodes: readonly ETGNode[]): RegionOption[] {
  const assignments = assignNodeRegions(nodes);
  const counts = new Map<string, { label: string; count: number }>();

  for (const node of nodes) {
    const assigned = assignments.get(node.uuid) ?? resolveSingleNodeRegion(node);
    const existing = counts.get(assigned.id);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(assigned.id, { label: assigned.label, count: 1 });
    }
  }

  return Array.from(counts.entries())
    .map(([id, info]) => ({ id, label: info.label, count: info.count }))
    .sort((a, b) => {
      const aSys = a.id.startsWith("__") ? 1 : 0;
      const bSys = b.id.startsWith("__") ? 1 : 0;
      if (aSys !== bSys) return aSys - bSys;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}

export interface ProjectRegionalSubgraphOptions {
  regionId: string | null;
  anchorCoord?: { lat: number; lng: number } | null;
  radiusKm?: number;
  includeCrossRegionDrivers?: boolean;
}

/**
 * Projects an area-specific subgraph from the canonical Earth Trend Graph.
 * Preserves local nodes/edges and optionally includes 1-hop cross-region teleconnection
 * or causal driver bridge nodes so local trends remain grounded in global Earth processes.
 */
export function projectRegionalSubgraph(
  nodes: readonly ETGNode[],
  edges: readonly ETGEdge[],
  options: ProjectRegionalSubgraphOptions
): RegionalSubgraphResult {
  const {
    regionId,
    anchorCoord = null,
    radiusKm = 1200,
    includeCrossRegionDrivers = true,
  } = options;

  if (!regionId) {
    const allIds = new Set(nodes.map((n) => n.uuid));
    return {
      nodes: [...nodes],
      edges: [...edges],
      localNodeUuids: allIds,
      bridgeNodeUuids: new Set(),
    };
  }

  const localNodeUuids = new Set<string>();

  if (regionId === "__nearby__" && anchorCoord) {
    for (const node of nodes) {
      if (
        typeof node.properties.lat === "number" &&
        typeof node.properties.lng === "number" &&
        haversineKm(anchorCoord.lat, anchorCoord.lng, node.properties.lat, node.properties.lng) <=
          radiusKm
      ) {
        localNodeUuids.add(node.uuid);
      }
    }
  } else {
    const targetKey = regionId.trim().toLowerCase();
    const regionMap = assignNodeRegions(nodes);
    const regionCoords: Array<{ lat: number; lng: number }> = [];

    for (const node of nodes) {
      const assigned = regionMap.get(node.uuid);
      const rawReg = node.properties.region?.trim().toLowerCase();
      if (assigned?.id === targetKey || (rawReg && rawReg === targetKey)) {
        localNodeUuids.add(node.uuid);
        if (
          typeof node.properties.lat === "number" &&
          typeof node.properties.lng === "number" &&
          Number.isFinite(node.properties.lat) &&
          Number.isFinite(node.properties.lng)
        ) {
          regionCoords.push({ lat: node.properties.lat, lng: node.properties.lng });
        }
      }
    }

    // Also include uncategorized coordinate-pinned probes within 650 km of non-global clusters
    if (regionCoords.length > 0 && !targetKey.startsWith("__")) {
      const centroidLat =
        regionCoords.reduce((acc, c) => acc + c.lat, 0) / regionCoords.length;
      const centroidLng = computeCircularMeanLng(regionCoords.map((c) => c.lng));
      for (const node of nodes) {
        if (localNodeUuids.has(node.uuid)) continue;
        const assigned = regionMap.get(node.uuid);
        if (assigned?.id.startsWith("__global_")) continue;
        if (
          typeof node.properties.lat === "number" &&
          typeof node.properties.lng === "number" &&
          haversineKm(centroidLat, centroidLng, node.properties.lat, node.properties.lng) <= 650
        ) {
          localNodeUuids.add(node.uuid);
        }
      }
    }
  }

  const bridgeNodeUuids = new Set<string>();

  if (includeCrossRegionDrivers && localNodeUuids.size > 0) {
    for (const edge of edges) {
      if (!CROSS_REGION_DRIVER_TYPES.has(edge.type)) continue;
      const srcLocal = localNodeUuids.has(edge.source_uuid);
      const tgtLocal = localNodeUuids.has(edge.target_uuid);
      if (srcLocal && !tgtLocal) {
        bridgeNodeUuids.add(edge.target_uuid);
      } else if (tgtLocal && !srcLocal) {
        bridgeNodeUuids.add(edge.source_uuid);
      }
    }
  }

  const includedIds = new Set<string>([...localNodeUuids, ...bridgeNodeUuids]);
  const projectedNodes = nodes.filter((n) => includedIds.has(n.uuid));
  const projectedEdges = edges.filter(
    (e) => includedIds.has(e.source_uuid) && includedIds.has(e.target_uuid)
  );

  return {
    nodes: projectedNodes,
    edges: projectedEdges,
    localNodeUuids,
    bridgeNodeUuids,
  };
}
