import type { ETGNode } from "@/types/etg";
import { humanizeNodeText } from "@/lib/plainLanguage";

export interface EarthPlaceTarget {
  id: string;
  label: string;
  subtitle: string;
  lat: number;
  lng: number;
  kind: "coordinate" | "node" | "place";
  nodeUuid?: string;
  aliases?: readonly string[];
}

export const CURATED_EARTH_PLACES: readonly EarthPlaceTarget[] = [
  {
    id: "place-boulder",
    label: "Boulder, Colorado",
    subtitle: "Front Range foothills & alpine transition · 40.02°N, 105.27°W",
    lat: 40.015,
    lng: -105.2705,
    kind: "place",
    aliases: ["boulder", "front range", "niwot", "ncar", "cu boulder"],
  },
  {
    id: "place-denver",
    label: "Denver, Colorado",
    subtitle: "Colorado Front Range metro observatory · 39.74°N, 104.99°W",
    lat: 39.7392,
    lng: -104.9903,
    kind: "place",
    aliases: ["denver", "colorado", "front range", "solar microgrid"],
  },
  {
    id: "place-fort-collins",
    label: "Fort Collins, Colorado",
    subtitle: "Northern Front Range plains & Cache la Poudre · 40.59°N, 105.08°W",
    lat: 40.5853,
    lng: -105.0844,
    kind: "place",
    aliases: ["fort collins", "ft collins", "csu"],
  },
  {
    id: "place-nino34",
    label: "Niño 3.4 Equatorial Pacific",
    subtitle: "Central Pacific ENSO SST index core · 0.00°, 145.00°W",
    lat: 0,
    lng: -145,
    kind: "place",
    aliases: ["enso", "el nino", "la nina", "nino 3.4", "pacific", "ocean"],
  },
  {
    id: "place-amazon",
    label: "Central Amazon Basin, Brazil",
    subtitle: "Tropical rainforest canopy & drought coupling · 3.47°S, 62.22°W",
    lat: -3.4653,
    lng: -62.2159,
    kind: "place",
    aliases: ["amazon", "brazil", "rainforest", "ndvi", "manaus"],
  },
  {
    id: "place-svalbard",
    label: "Svalbard, Arctic Norway",
    subtitle: "High-Arctic permafrost & sea-ice amplification · 78.22°N, 15.63°E",
    lat: 78.2232,
    lng: 15.6267,
    kind: "place",
    aliases: ["svalbard", "arctic", "longyearbyen", "permafrost", "ice"],
  },
  {
    id: "place-great-barrier-reef",
    label: "Great Barrier Reef, Australia",
    subtitle: "Coral Sea marine heatwave corridor · 18.29°S, 147.70°E",
    lat: -18.2871,
    lng: 147.6992,
    kind: "place",
    aliases: ["great barrier reef", "coral", "australia", "queensland"],
  },
  {
    id: "place-sierra-nevada",
    label: "Sierra Nevada, California",
    subtitle: "Wildfire VPD & snowpack watershed · 37.87°N, 119.54°W",
    lat: 37.8651,
    lng: -119.5383,
    kind: "place",
    aliases: ["california", "sierra nevada", "yosemite", "wildfire"],
  },
  {
    id: "place-maui",
    label: "Maui, Hawaiʻi",
    subtitle: "Trade-wind leeward fire & coastal station · 20.80°N, 156.33°W",
    lat: 20.7984,
    lng: -156.3319,
    kind: "place",
    aliases: ["maui", "hawaii", "pacific"],
  },
  {
    id: "place-sahel",
    label: "Sahel & Lake Chad Basin",
    subtitle: "West-Central African monsoon & dust corridor · 13.00°N, 14.20°E",
    lat: 13.0,
    lng: 14.2,
    kind: "place",
    aliases: ["sahel", "chad", "sahara", "dust", "africa"],
  },
  {
    id: "place-greenland",
    label: "Summit Camp, Greenland",
    subtitle: "Greenland Ice Sheet mass balance interior · 72.58°N, 38.46°W",
    lat: 72.58,
    lng: -38.46,
    kind: "place",
    aliases: ["greenland", "ice sheet", "summit"],
  },
  {
    id: "place-mississippi-delta",
    label: "Mississippi River Delta, Louisiana",
    subtitle: "Gulf Coast hydrology & flood discharge · 29.95°N, 90.07°W",
    lat: 29.9511,
    lng: -90.0715,
    kind: "place",
    aliases: ["mississippi", "new orleans", "louisiana", "river", "flood"],
  },
  {
    id: "place-tokyo",
    label: "Tokyo Bay, Japan",
    subtitle: "Kuroshio western boundary current & urban heat · 35.68°N, 139.77°E",
    lat: 35.6762,
    lng: 139.6503,
    kind: "place",
    aliases: ["tokyo", "japan", "kuroshio"],
  },
  {
    id: "place-phoenix",
    label: "Phoenix, Arizona",
    subtitle: "Sonoran extreme heat & southwestern monsoon · 33.45°N, 112.07°W",
    lat: 33.4484,
    lng: -112.074,
    kind: "place",
    aliases: ["phoenix", "arizona", "desert", "heat"],
  },
  {
    id: "place-mumbai",
    label: "Mumbai, India",
    subtitle: "Arabian Sea coastal monsoon rainfall & aerosol hub · 19.08°N, 72.88°E",
    lat: 19.076,
    lng: 72.8777,
    kind: "place",
    aliases: ["mumbai", "india", "monsoon"],
  },
  {
    id: "place-patagonia",
    label: "Patagonian Icefield, Chile",
    subtitle: "Southern Hemisphere glacial hydrology · 49.00°S, 73.50°W",
    lat: -49.0,
    lng: -73.5,
    kind: "place",
    aliases: ["patagonia", "chile", "andes", "glacier"],
  },
];

/**
 * Parses explicit coordinate strings such as `40.01, -105.27`, `40.01°N 105.27°W`,
 * or `-3.47 -62.22`.
 */
export function parseCoordinateQuery(raw: string): EarthPlaceTarget | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const match = cleaned.match(
    /^([+-]?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,\s;]+\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/i
  );
  if (!match) return null;

  let lat = Number(match[1]);
  let lng = Number(match[3]);
  const ns = match[2]?.toUpperCase();
  const ew = match[4]?.toUpperCase();
  if (ns === "S" && lat > 0) lat = -lat;
  if (ns === "N" && lat < 0) lat = -lat;
  if (ew === "W" && lng > 0) lng = -lng;
  if (ew === "E" && lng < 0) lng = -lng;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const latLabel = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`;
  const lngLabel = `${Math.abs(lng).toFixed(2)}°${lng >= 0 ? "E" : "W"}`;

  return {
    id: `coord-${lat.toFixed(3)}-${lng.toFixed(3)}`,
    label: `Inspect ${latLabel}, ${lngLabel}`,
    subtitle: "Query live NASA POWER & regional GIBS imagery at coordinates",
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4)),
    kind: "coordinate",
  };
}

/**
 * Finds matching observatory places, graph pins, or explicit coordinates
 * for the top-bar search combobox in both 3D Earth and Knowledge Graph views.
 */
export function searchObservatoryTargets(
  query: string,
  nodes: readonly ETGNode[],
  limit = 8
): EarthPlaceTarget[] {
  const results: EarthPlaceTarget[] = [];
  const trimmed = query.trim();

  const coordHit = parseCoordinateQuery(trimmed);
  if (coordHit) {
    results.push(coordHit);
  }

  const tokens = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const matchesTokens = (haystack: string) =>
    tokens.length === 0 || tokens.every((tok) => haystack.includes(tok));

  // Matching curated observatory places (great for jumping anywhere on Earth)
  for (const place of CURATED_EARTH_PLACES) {
    const haystack = [
      place.label,
      place.subtitle,
      ...(place.aliases ?? []),
    ]
      .join(" ")
      .toLowerCase();
    if (matchesTokens(haystack)) {
      results.push(place);
    }
  }

  // Matching geo-pinned graph nodes
  const matchedNodes: EarthPlaceTarget[] = [];
  for (const node of nodes) {
    const { lat, lng, name, region, parameter, concept_name } = node.properties;
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      continue;
    }
    const cleanName = humanizeNodeText(name);
    const haystack = [cleanName, name, region ?? "", parameter ?? "", concept_name ?? ""]
      .join(" ")
      .toLowerCase();
    if (!matchesTokens(haystack)) continue;

    matchedNodes.push({
      id: `node-${node.uuid}`,
      label: cleanName,
      subtitle: `${region && region !== cleanName ? `${region} · ` : ""}${lat.toFixed(2)}°, ${lng.toFixed(2)}°`,
      lat,
      lng,
      kind: "node",
      nodeUuid: node.uuid,
    });
    if (matchedNodes.length >= limit) break;
  }

  // When searching by query, surface matching graph pins right after any direct coordinate match
  if (tokens.length > 0) {
    const combined = [
      ...(coordHit ? [coordHit] : []),
      ...matchedNodes.slice(0, Math.ceil(limit / 2)),
      ...results.filter((r) => r.kind === "place"),
    ];
    return combined.slice(0, limit);
  }

  // Empty query suggestions: curated flagship places
  return results.slice(0, limit);
}
