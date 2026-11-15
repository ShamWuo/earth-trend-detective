import {
  normalizeEarthCoordinates,
  type DataProvenanceMode,
} from "@/lib/earth/coordinates";
import {
  classifyUpstreamFault,
  createTelemetryBudget,
  parseUpstreamJson,
  type TelemetryBudget,
} from "@/lib/earth/upstreamResilience";
import { haversineKm } from "@/lib/graph/etgStore";
import { classifyEarthRegionByCoord } from "@/lib/graph/regionalSubgraph";
import type { ETGDatasetId, ETGNode, UpstreamFaultDetail } from "@/types/etg";

const EONET_CACHE_TTL_MS = 1000 * 60 * 15;
let eonetCache: { expiresAt: number; signals: ETGNode[] } | null = null;

export function clearEonetCache(): void {
  eonetCache = null;
}

interface EonetGeometry {
  date?: string;
  type?: string;
  coordinates?: unknown;
}

interface EonetSource {
  id: string;
  url?: string;
}

interface EonetEvent {
  id: string;
  title: string;
  description?: string | null;
  link?: string;
  categories?: Array<{ id: string; title: string }>;
  sources?: EonetSource[];
  geometry?: EonetGeometry[];
}

const EONET_CATEGORIES = [
  "wildfires",
  "severeStorms",
  "seaLakeIce",
  "volcanoes",
  "floods",
  "dustHaze",
  "drought",
] as const;

const USER_AGENT = "EarthTrendDetective/1.0 (NASA-Space-Apps; Scientific-Observatory)";

function mapEonetCategoryToDataset(categoryId?: string): ETGDatasetId {
  const lower = (categoryId || "").toLowerCase();
  if (lower.includes("wildfire")) return "wildfire";
  if (lower.includes("dust") || lower.includes("haze") || lower.includes("volcano")) {
    return "air_quality";
  }
  if (lower.includes("flood") || lower.includes("storm") || lower.includes("drought")) {
    return "hydrology";
  }
  if (lower.includes("ice") || lower.includes("temp")) return "ocean_temp";
  return "nasa_power";
}

/**
 * Resolves GeoJSON Point [lng, lat], LineString, Polygon, or MultiPolygon rings
 * to a single representative [lng, lat] centroid.
 */
export function extractGeometryCentroid(coords: unknown): [number, number] | null {
  if (!Array.isArray(coords) || coords.length === 0) return null;

  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    return [coords[0], coords[1]];
  }

  const flatPoints: Array<[number, number]> = [];
  const collect = (node: unknown) => {
    if (!Array.isArray(node) || node.length === 0) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      flatPoints.push([node[0], node[1]]);
      return;
    }
    for (const child of node) {
      collect(child);
    }
  };
  collect(coords);

  if (flatPoints.length === 0) return null;
  const sum = flatPoints.reduce(
    (acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat] as [number, number],
    [0, 0] as [number, number]
  );
  return [sum[0] / flatPoints.length, sum[1] / flatPoints.length];
}

export async function fetchLiveEonetSignals(
  limit = 10,
  budget?: TelemetryBudget
): Promise<{
  provenance: "NASA EONET v3 (Live)" | "NASA EONET v3 (Cached)" | "NASA EONET v3 (Baseline Fallback)";
  provenanceMode: DataProvenanceMode;
  signals: ETGNode[];
  upstreamFault?: UpstreamFaultDetail;
  upstreamFaults?: UpstreamFaultDetail[];
  elapsedMs?: number;
}> {
  const safeLimit = Math.max(1, Math.min(30, Math.floor(limit)));
  const perCategoryLimit = Math.max(2, Math.min(5, Math.ceil(safeLimit / 2)));
  const activeBudget = budget ?? createTelemetryBudget(1400);

  if (eonetCache && eonetCache.expiresAt > Date.now() && eonetCache.signals.length > 0) {
    return {
      provenance: "NASA EONET v3 (Cached)",
      provenanceMode: "cached",
      signals: eonetCache.signals.slice(0, safeLimit),
      elapsedMs: activeBudget.elapsedMs(),
    };
  }

  const responses = await Promise.allSettled(
    EONET_CATEGORIES.map(async (category) => {
      const retryDelayMs = process.env.NODE_ENV === "test" ? 10 : 40;
      for (let attempt = 0; attempt < 2; attempt++) {
        const startedAttemptAt = Date.now();
        try {
          const res = await fetch(
            `https://eonet.gsfc.nasa.gov/api/v3/events?category=${category}&status=all&limit=${perCategoryLimit}`,
            {
              signal: activeBudget.signal(1150),
              headers: {
                Accept: "application/json",
                "User-Agent": USER_AGENT,
              },
            }
          );
          const data = await parseUpstreamJson<{ events?: EonetEvent[] }>(
            res,
            `NASA EONET v3 (${category})`
          );
          return Array.isArray(data?.events) ? data.events : [];
        } catch (err) {
          const fault = classifyUpstreamFault(err, `NASA EONET v3 (${category})`);
          activeBudget.recordFault(fault);
          const attemptElapsed = Date.now() - startedAttemptAt;
          if (
            attempt === 0 &&
            fault.retryable &&
            attemptElapsed < 250 &&
            activeBudget.remainingMs() > 500
          ) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
          }
          return [] as EonetEvent[];
        }
      }
      return [] as EonetEvent[];
    })
  );

  const rawById = new Map<string, EonetEvent>();
  for (const r of responses) {
    if (r.status === "fulfilled") {
      for (const ev of r.value) {
        if (!ev || typeof ev.id !== "string" || typeof ev.title !== "string") continue;
        if (!rawById.has(ev.id)) {
          rawById.set(ev.id, ev);
        }
      }
    }
  }

  const parsedCandidates: ETGNode[] = [];
  for (const ev of rawById.values()) {
    const latestGeo = Array.isArray(ev.geometry) ? ev.geometry[ev.geometry.length - 1] : undefined;
    const lngLat = extractGeometryCentroid(latestGeo?.coordinates);
    if (!lngLat) continue;
    const [rawLng, rawLat] = lngLat;
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) continue;

    const norm = normalizeEarthCoordinates(rawLat, rawLng, {
      poleGuardMargin: 0,
      antimeridianMargin: 0,
    });
    const lat = norm.lat;
    const lng = norm.lng;

    const cat = ev.categories?.[0];
    const dataset = mapEonetCategoryToDataset(cat?.id);
    const observedAt = latestGeo?.date ?? new Date().toISOString();
    const sourceAgencies = (ev.sources ?? []).map((s) => s.id).filter(Boolean).join(", ");

    parsedCandidates.push({
      uuid: `signal-eonet-${ev.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`,
      label: "Signal",
      is_provisional: false,
      properties: {
        name: ev.title,
        concept_name: ev.title,
        description:
          ev.description ||
          `Live NASA EONET ${cat?.title || "Earth observation"} event${sourceAgencies ? ` reported by ${sourceAgencies}` : ""}.`,
        status: "Active",
        importance: 8,
        lat: Number(lat.toFixed(3)),
        lng: Number(lng.toFixed(3)),
        region: classifyEarthRegionByCoord(lat, lng).label,
        dataset,
        producer_type: "nasa_satellite",
        confidence: 0.92,
        observed_at: observedAt,
        created_at: observedAt,
        eonet_id: ev.id,
        eonet_category: cat?.id,
        eonet_url: ev.link,
        source_url: ev.link,
        source_system: sourceAgencies ? `NASA EONET v3 (${sourceAgencies})` : "NASA EONET v3",
      },
    });
  }

  if (parsedCandidates.length === 0) {
    const faults = activeBudget.faults;
    if (eonetCache && eonetCache.signals.length > 0) {
      return {
        provenance: "NASA EONET v3 (Cached)",
        provenanceMode: "cached",
        signals: eonetCache.signals.slice(0, safeLimit),
        ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
        elapsedMs: activeBudget.elapsedMs(),
      };
    }
    return {
      provenance: "NASA EONET v3 (Baseline Fallback)",
      provenanceMode: "climatological_fallback",
      signals: [],
      ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
      elapsedMs: activeBudget.elapsedMs(),
    };
  }

  // Enforce global spatial & category diversity (>= 800 km separation first, then fill remainder)
  const selected: ETGNode[] = [];
  const usedIds = new Set<string>();
  const seenCategories = new Set<string>();

  // Pass 1: one representative per category with >= 800 km spatial spread
  for (const node of parsedCandidates) {
    if (selected.length >= safeLimit) break;
    const cat = String(node.properties.eonet_category || "");
    if (seenCategories.has(cat)) continue;
    const farEnough = selected.every(
      (s) =>
        haversineKm(
          s.properties.lat ?? 0,
          s.properties.lng ?? 0,
          node.properties.lat ?? 0,
          node.properties.lng ?? 0
        ) >= 800
    );
    if (farEnough || selected.length === 0) {
      selected.push(node);
      usedIds.add(node.uuid);
      if (cat) seenCategories.add(cat);
    }
  }

  // Pass 2: fill remaining slots keeping >= 800 km separation where possible
  for (const node of parsedCandidates) {
    if (selected.length >= safeLimit) break;
    if (usedIds.has(node.uuid)) continue;
    const farEnough = selected.every(
      (s) =>
        haversineKm(
          s.properties.lat ?? 0,
          s.properties.lng ?? 0,
          node.properties.lat ?? 0,
          node.properties.lng ?? 0
        ) >= 800
    );
    if (farEnough) {
      selected.push(node);
      usedIds.add(node.uuid);
    }
  }

  // Pass 3: if still below limit, fill with remaining live events
  for (const node of parsedCandidates) {
    if (selected.length >= safeLimit) break;
    if (usedIds.has(node.uuid)) continue;
    selected.push(node);
    usedIds.add(node.uuid);
  }

  eonetCache = {
    expiresAt: Date.now() + EONET_CACHE_TTL_MS,
    signals: selected,
  };

  const faults = activeBudget.faults;
  return {
    provenance: "NASA EONET v3 (Live)",
    provenanceMode: "live",
    signals: selected,
    ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
    elapsedMs: activeBudget.elapsedMs(),
  };
}
