import { haversineKm } from "@/lib/graph/etgStore";
import { classifyEarthRegionByCoord } from "@/lib/graph/regionalSubgraph";
import type { ETGDatasetId, ETGNode } from "@/types/etg";

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

export async function fetchLiveEonetSignals(limit = 10): Promise<{
  provenance: "NASA EONET v3 (Live)";
  signals: ETGNode[];
}> {
  const perCategoryLimit = Math.max(2, Math.min(5, Math.ceil(limit / 2)));

  const responses = await Promise.allSettled(
    EONET_CATEGORIES.map(async (category) => {
      const res = await fetch(
        `https://eonet.gsfc.nasa.gov/api/v3/events?category=${category}&status=all&limit=${perCategoryLimit}`,
        {
          signal: AbortSignal.timeout(12000),
          headers: {
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
        }
      );
      if (!res.ok) {
        throw new Error(`NASA EONET ${category} HTTP ${res.status}`);
      }
      const data = (await res.json()) as { events?: EonetEvent[] };
      return Array.isArray(data.events) ? data.events : [];
    })
  );

  const rawById = new Map<string, EonetEvent>();
  for (const r of responses) {
    if (r.status === "fulfilled") {
      for (const ev of r.value) {
        if (!rawById.has(ev.id)) {
          rawById.set(ev.id, ev);
        }
      }
    }
  }

  const parsedCandidates: ETGNode[] = [];
  for (const ev of rawById.values()) {
    const latestGeo = ev.geometry?.[ev.geometry.length - 1];
    const lngLat = extractGeometryCentroid(latestGeo?.coordinates);
    if (!lngLat) continue;
    const [lng, lat] = lngLat;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

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
    throw new Error("NASA EONET v3 returned 0 live Earth observation events.");
  }

  // Enforce global spatial & category diversity (>= 800 km separation first, then fill remainder)
  const selected: ETGNode[] = [];
  const usedIds = new Set<string>();
  const seenCategories = new Set<string>();

  // Pass 1: one representative per category with >= 800 km spatial spread
  for (const node of parsedCandidates) {
    if (selected.length >= limit) break;
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
    if (selected.length >= limit) break;
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
    if (selected.length >= limit) break;
    if (usedIds.has(node.uuid)) continue;
    selected.push(node);
    usedIds.add(node.uuid);
  }

  return {
    provenance: "NASA EONET v3 (Live)",
    signals: selected,
  };
}
