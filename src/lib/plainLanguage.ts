import { DATASET_BY_ID } from "@/lib/datasets";
import {
  convertSlopeUnitLabel,
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  isTemperatureUnitString,
} from "@/lib/earth/currentConditionsClient";
import type {
  CrossRegionComparison,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  RelationCategory,
  TemperatureUnit,
  TrendAnalysisSummary,
} from "@/types/etg";

export interface PlainTrendDigest {
  topicLabel: string;
  parameterShort: string;
  headline: string;
  ratePerDecade: string;
  certaintyLabel: "Clear trend" | "Likely trend" | "Normal swings";
  isSignificant: boolean;
  summarySentence: string;
  latestFormatted: string;
  meanFormatted: string;
  anomalyFormatted: string;
  anomalyZFormatted: string | null;
  rangeFormatted: string;
  windowYears: number;
  periodRange: string;
  tone: "rising" | "falling" | "steady";
  isProxy?: boolean;
  proxyNote?: string;
}

export interface PlainComparisonDigest {
  badgeLabel: "Opposite trends" | "Moving together" | "No clear link";
  strengthLabel: "Strong link" | "Moderate link" | "Weak link" | "Shared long-term drift";
  headline: string;
  explanation: string;
  timingNote: string;
}

const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Computes great-circle distance in kilometers between two Earth coordinates.
 */
export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Formats latitude and longitude into compact N/S/E/W shorthand.
 */
export function formatCoordShort(lat: number, lng: number): string {
  const latStr = lat >= 0 ? `${lat.toFixed(1)}°N` : `${Math.abs(lat).toFixed(1)}°S`;
  const lngStr = lng >= 0 ? `${lng.toFixed(1)}°E` : `${Math.abs(lng).toFixed(1)}°W`;
  return `${latStr}, ${lngStr}`;
}

function isCoordinateOnlyRegion(region: string): boolean {
  return /^-?\d+(?:\.\d+)?°,\s*-?\d+(?:\.\d+)?°$/.test(region.trim());
}

/**
 * Returns a human-friendly place/zone title using a nearby named node when within 350 km.
 */
export function describeGeographicZone(
  lat: number,
  lng: number,
  nearbyNode?: ETGNode | null
): string {
  const region = nearbyNode?.properties.region?.trim();
  if (
    region &&
    !isCoordinateOnlyRegion(region) &&
    typeof nearbyNode?.properties.lat === "number" &&
    typeof nearbyNode?.properties.lng === "number" &&
    haversineDistanceKm(lat, lng, nearbyNode.properties.lat, nearbyNode.properties.lng) <= 350
  ) {
    return `Near ${region}`;
  }

  if (lat >= 66.5) return "Arctic Region";
  if (lat >= 50) return "Northern High Latitudes";
  if (lat >= 23.5) return "Northern Mid-Latitudes";
  if (lat > -23.5) return "Tropical Belt";
  if (lat > -55) return "Southern Mid-Latitudes";
  return "Southern Ocean & Antarctica";
}

function formatDecadeUnit(unit: string, slopeUnit: string): string {
  const trimmedSlopeUnit = slopeUnit.trim();
  if (trimmedSlopeUnit.endsWith("/d/yr")) {
    return `${trimmedSlopeUnit.slice(0, -3)} / decade`;
  }
  if (trimmedSlopeUnit.endsWith("/yr")) {
    const base = trimmedSlopeUnit.slice(0, -3).trim();
    if (!base || base === "unit") {
      if (unit === "0–1 wet") return "moisture / decade";
      return unit && unit !== "value" ? `${unit} / decade` : "units / decade";
    }
    return `${base} / decade`;
  }
  return unit && unit !== "value" ? `${unit} / decade` : "units / decade";
}

function formatSignedRatePerDecade(
  annualSlope: number,
  unit: string,
  slopeUnit: string
): string {
  const decadeSlope = annualSlope * 10;
  const absVal = Math.abs(decadeSlope);
  const decimals = absVal >= 10 ? 1 : absVal >= 0.1 ? 2 : 3;
  const rounded = Number(absVal.toFixed(decimals));
  const sign = rounded === 0 ? "" : decadeSlope > 0 ? "+" : "-";
  const decadeUnit = formatDecadeUnit(unit, slopeUnit);
  return `${sign}${absVal.toFixed(decimals)} ${decadeUnit}`;
}

function formatMagnitude(val: number, unit: string): string {
  const absVal = Math.abs(val);
  const decimals = absVal >= 100 ? 1 : absVal >= 1 ? 2 : 3;
  const cleanUnit = unit && unit !== "value" ? ` ${unit}` : "";
  return `${val.toFixed(decimals)}${cleanUnit}`;
}

function formatDeltaMagnitude(val: number, unit: string): string {
  const baseUnit = unit.replace(/\s+(max|skin|wet)$/i, "").trim();
  const absVal = Math.abs(val);
  const decimals = absVal >= 100 ? 1 : absVal >= 0.1 ? 2 : 3;
  const cleanUnit = baseUnit && baseUnit !== "value" ? ` ${baseUnit}` : "";
  return `${absVal.toFixed(decimals)}${cleanUnit}`;
}

function formatSignedDelta(diff: number, unit: string): string {
  const baseUnit = unit.replace(/\s+(max|skin|wet)$/i, "").trim();
  const absVal = Math.abs(diff);
  const decimals = absVal >= 100 ? 1 : absVal >= 0.1 ? 2 : 3;
  const roundedAbs = Number(absVal.toFixed(decimals));
  const sign = roundedAbs === 0 ? "" : diff > 0 ? "+" : "-";
  const cleanUnit = baseUnit && baseUnit !== "value" ? ` ${baseUnit}` : "";
  return `${sign}${absVal.toFixed(decimals)}${cleanUnit}`;
}

function extractParameterShort(parameter: string, dataset: ETGDatasetId): string {
  const lower = parameter.toLowerCase();
  if (/\bt2m_max\b/.test(lower)) return "T2M Max";
  if (/\bt2m\b/.test(lower)) return "T2M Air";
  if (/\bvpd\b/.test(lower)) return "Vapor Pressure Deficit";
  if (/\bprectotcorr\b/.test(lower)) return "Precip";
  if (/\bgwetprof\b/.test(lower)) return "Soil Moist.";
  if (/\bts\b/.test(lower)) return "Skin Temp";
  if (/\bevptrns\b/.test(lower)) return "Canopy ET";
  if (/\ballsky_sfc_sw_dwn\b/.test(lower)) return "Solar SW";
  if (lower.includes("discharge")) return "River Flow";
  if (lower.includes("pm2.5") || lower.includes("pm2_5")) return "PM2.5";
  if (lower.includes("sea ice")) return "Sea Ice";
  if (lower.includes("co2")) return "CO₂";
  const stripped = parameter.replace(/\s*\([^)]*\)/g, "").trim();
  if (stripped.length > 0 && stripped.length <= 20) return stripped;
  return DATASET_BY_ID[dataset]?.shortLabel ?? "Signal";
}

function resolveTopicHeadline(summary: TrendAnalysisSummary): {
  headline: string;
  tone: "rising" | "falling" | "steady";
} {
  const { dataset, mannKendall, parameter, unit } = summary;
  const paramLower = parameter.toLowerCase();
  const unitLower = unit.toLowerCase();
  const isSeaIceMetric = paramLower.includes("ice") && unitLower.includes("km");
  const isVpd = dataset === "wildfire" && (unit === "kPa" || paramLower.includes("vpd"));
  const isDischarge =
    paramLower.includes("discharge") ||
    paramLower.includes("river") ||
    unitLower.includes("m³/s");
  const isEvap =
    paramLower.includes("evap") ||
    paramLower.includes("evptrns") ||
    unitLower.includes("mj");
  const isPm25 =
    paramLower.includes("pm2.5") ||
    paramLower.includes("pm2_5") ||
    unitLower.includes("μg/m");
  const isAod = paramLower.includes("aod") || paramLower.includes("optical depth");
  const isSolarIrradiance =
    dataset === "nasa_power" &&
    (paramLower.includes("allsky") ||
      paramLower.includes("solar") ||
      unitLower.includes("kwh"));
  const isWindSpeed =
    dataset === "nasa_power" && /\bws10m\b|\bws50m\b|\bwind/.test(paramLower);
  const effectiveSig = mannKendall.significant && (mannKendall.significantAdjusted ?? true);

  if (!effectiveSig || mannKendall.direction === "no_trend") {
    const steadyMap: Record<TrendAnalysisSummary["dataset"], string> = {
      nasa_power: isSolarIrradiance
        ? "Steady solar irradiance"
        : isWindSpeed
          ? "Steady wind speeds"
          : "Steady temperatures",
      wildfire: isVpd ? "Steady fire-weather aridity" : "Typical peak heat",
      hydrology: isDischarge ? "Steady river flow" : "Steady rainfall & moisture",
      ocean_temp: isSeaIceMetric ? "Steady sea ice extent" : "Steady surface warmth",
      deforestation: isEvap ? "Steady evapotranspiration" : "Steady land moisture",
      air_quality: paramLower.includes("co2")
        ? "Steady CO₂ levels"
        : isPm25
          ? "Steady PM2.5 levels"
          : isAod
            ? "Steady aerosol haze"
            : "Steady air & sunlight",
      community: "Steady local readings",
    };
    return { headline: steadyMap[dataset] ?? "Steady conditions", tone: "steady" };
  }

  const rising = mannKendall.direction === "increasing";
  const tone = rising ? "rising" : "falling";

  if (dataset === "nasa_power") {
    if (isSolarIrradiance) {
      return {
        headline: rising ? "Brightening (more sunlight)" : "Dimming (less sunlight)",
        tone,
      };
    }
    if (isWindSpeed) {
      return {
        headline: rising ? "Rising wind speeds" : "Calming wind speeds",
        tone,
      };
    }
    return { headline: rising ? "Warming steadily" : "Cooling trend", tone };
  }
  if (dataset === "wildfire") {
    if (isVpd) {
      return {
        headline: rising ? "Drier air & higher fire risk" : "Moister air & lower fire risk",
        tone,
      };
    }
    return { headline: rising ? "Peak heat rising" : "Peak heat easing", tone };
  }
  if (dataset === "hydrology") {
    if (isDischarge) {
      return { headline: rising ? "River flow rising" : "River flow declining", tone };
    }
    return { headline: rising ? "Getting wetter" : "Getting drier", tone };
  }
  if (dataset === "ocean_temp") {
    if (isSeaIceMetric) {
      return { headline: rising ? "Sea ice expanding" : "Sea ice shrinking", tone };
    }
    return { headline: rising ? "Surface warming" : "Surface cooling", tone };
  }
  if (dataset === "deforestation") {
    if (isEvap) {
      return { headline: rising ? "Higher canopy water flux" : "Lower canopy water flux", tone };
    }
    return { headline: rising ? "Greening / moister" : "Drying / canopy stress", tone };
  }
  if (dataset === "air_quality") {
    if (paramLower.includes("co2")) {
      return { headline: rising ? "CO₂ rising" : "CO₂ declining", tone };
    }
    if (isPm25) {
      return {
        headline: rising ? "PM2.5 pollution rising" : "Air clearing (lower PM2.5)",
        tone,
      };
    }
    if (isAod) {
      return {
        headline: rising ? "More aerosol haze (AOD)" : "Air clearing (lower AOD)",
        tone,
      };
    }
    return { headline: rising ? "Higher sunlight / clearer" : "More haze / cloudier", tone };
  }
  return { headline: rising ? "Rising steadily" : "Declining steadily", tone };
}

/**
 * Translates technical Mann-Kendall and Theil-Sen output into plain, jargon-free English,
 * along with tabular-friendly formatted stats and unit conversion (°C / °F).
 */
export function describeTrendPlainly(
  summary: TrendAnalysisSummary,
  tempUnit: TemperatureUnit = "C"
): PlainTrendDigest {
  const dsMeta = DATASET_BY_ID[summary.dataset];
  const paramLower = summary.parameter.toLowerCase();
  const unitLower = summary.unit.toLowerCase();
  const isSolarTopic =
    summary.dataset === "nasa_power" &&
    (paramLower.includes("allsky") ||
      paramLower.includes("solar") ||
      unitLower.includes("kwh"));
  const isWindTopic =
    summary.dataset === "nasa_power" && /\bws10m\b|\bws50m\b|\bwind/.test(paramLower);
  const topicLabel = isSolarTopic
    ? "Solar Irradiance"
    : isWindTopic
      ? "Wind Speed"
      : dsMeta?.shortLabel ?? "Earth trend";
  const parameterShort = extractParameterShort(summary.parameter, summary.dataset);
  const { headline, tone } = resolveTopicHeadline(summary);
  const effectiveSignificant =
    summary.mannKendall.significant && (summary.mannKendall.significantAdjusted ?? true);
  const p = Math.max(
    summary.mannKendall.pValue,
    summary.mannKendall.pValueAdjusted ?? summary.mannKendall.pValue
  );
  const certaintyLabel: PlainTrendDigest["certaintyLabel"] =
    effectiveSignificant && p < 0.01
      ? "Clear trend"
      : effectiveSignificant && p < 0.05
        ? "Likely trend"
        : "Normal swings";

  const hasTempUnit = isTemperatureUnitString(summary.unit);
  const convertSlopeToF =
    tempUnit === "F" &&
    (hasTempUnit || /(?:°\s*c|deg\s*c|celsius)/i.test(summary.slopeUnit));
  const convertSlopeToC =
    tempUnit === "C" && /(?:°\s*f|deg\s*f|fahrenheit)/i.test(summary.slopeUnit);
  const displayUnit = hasTempUnit
    ? convertTemperatureUnitLabel(summary.unit, tempUnit)
    : summary.unit;
  const displaySlope = convertSlopeToF && !/(?:°\s*f|deg\s*f|fahrenheit)/i.test(summary.slopeUnit)
    ? summary.theilSen.slope * 1.8
    : convertSlopeToC
      ? summary.theilSen.slope / 1.8
      : summary.theilSen.slope;
  const displaySlopeUnit =
    convertSlopeToF || convertSlopeToC
      ? convertSlopeUnitLabel(summary.slopeUnit, tempUnit)
      : summary.slopeUnit;

  const ratePerDecade = formatSignedRatePerDecade(
    displaySlope,
    displayUnit,
    displaySlopeUnit
  );

  const fallbackMin =
    summary.points.length > 0
      ? Math.min(...summary.points.map((p) => p.value))
      : summary.mean - summary.stdDev;
  const fallbackMax =
    summary.points.length > 0
      ? Math.max(...summary.points.map((p) => p.value))
      : summary.mean + summary.stdDev;
  const rawMin = Number.isFinite(summary.min) ? summary.min : fallbackMin;
  const rawMax = Number.isFinite(summary.max) ? summary.max : fallbackMax;

  const rawDiff = summary.latestValue - summary.mean;
  const rawAbsDiff = Math.abs(rawDiff);
  const latestVal = hasTempUnit
    ? convertTemperatureDisplayValue(summary.latestValue, summary.unit, tempUnit)
    : summary.latestValue;
  const meanVal = hasTempUnit
    ? convertTemperatureDisplayValue(summary.mean, summary.unit, tempUnit)
    : summary.mean;
  const minVal = hasTempUnit
    ? convertTemperatureDisplayValue(rawMin, summary.unit, tempUnit)
    : rawMin;
  const maxVal = hasTempUnit
    ? convertTemperatureDisplayValue(rawMax, summary.unit, tempUnit)
    : rawMax;
  const displayDiff = latestVal - meanVal;
  const absDisplayDiff = Math.abs(displayDiff);

  const latestFormatted = formatMagnitude(latestVal, displayUnit);
  const meanFormatted = formatMagnitude(meanVal, displayUnit);
  const anomalyFormatted = formatSignedDelta(displayDiff, displayUnit);
  const anomalyZFormatted =
    summary.stdDev > 1e-6
      ? `${rawDiff >= 0 ? "+" : ""}${(rawDiff / summary.stdDev).toFixed(1)}σ`
      : null;
  const rangeFormatted = `${formatMagnitude(minVal, "")}–${formatMagnitude(maxVal, displayUnit)}`;

  const yearsCount = summary.points.length;
  const periodRange =
    yearsCount >= 2
      ? `${summary.points[0].date.slice(0, 4)}–${summary.points[yearsCount - 1].date.slice(0, 4)}`
      : (summary.points[0]?.date.slice(0, 4) ?? "Recent");
  const windowLabel =
    yearsCount >= 20 ? `${yearsCount}-year average` : "historical average";
  const diffDir =
    rawAbsDiff < Math.max(0.01, summary.stdDev * 0.15)
      ? "close to"
      : displayDiff > 0
        ? `${formatDeltaMagnitude(absDisplayDiff, displayUnit)} above`
        : `${formatDeltaMagnitude(absDisplayDiff, displayUnit)} below`;

  let summarySentence =
    diffDir === "close to"
      ? `Recent average (${latestFormatted}) is close to the ${windowLabel} (${meanFormatted}).`
      : `Recent average (${latestFormatted}) is ${diffDir} the ${windowLabel} (${meanFormatted}).`;

  if (!effectiveSignificant) {
    summarySentence += " Year-to-year swings stay within the normal range.";
  } else if (summary.changePoint?.significant && summary.changePoint.date) {
    summarySentence += ` Shifted noticeably around ${summary.changePoint.date}.`;
  }

  return {
    topicLabel,
    parameterShort,
    headline,
    ratePerDecade,
    certaintyLabel,
    isSignificant: effectiveSignificant,
    summarySentence,
    latestFormatted,
    meanFormatted,
    anomalyFormatted,
    anomalyZFormatted,
    rangeFormatted,
    windowYears: yearsCount,
    periodRange,
    tone,
    isProxy: summary.measurementKind === "meteorological_proxy",
    proxyNote: summary.proxyNote,
  };
}

/**
 * Removes statistical jargon from auto-generated node titles and descriptions for default cards.
 */
export function humanizeNodeText(text: string): string {
  return text
    .replace(/Statistically Significant Increasing Trend/gi, "Rising trend")
    .replace(/Statistically Significant Decreasing Trend/gi, "Declining trend")
    .replace(/Normal Environmental Variability/gi, "Steady")
    .replace(/\s*\(r\*?=[-+]?\d+(?:\.\d+)?[^)]*\)/gi, "")
    .replace(/\s*,?\s*analyzed via Mann-Kendall\s*\([^)]*\)\s*(?:and\s+)?/gi, ", ")
    .replace(/\s*,?\s*Mann-Kendall\s+p\s*[=<>]\s*\d+(?:\.\d+)?(?:\s*\([^)]*\))?\.?/gi, ".")
    .replace(/Theil-Sen slope\s*\(([^)]+)\)/gi, "rate $1")
    .replace(/\s*Provenance:\s*/gi, " Source: ")
    .replace(/\.\s*\./g, ".")
    .replace(/,\s*\./g, ".")
    .replace(/:\s*,/g, ":")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Translates cross-region statistical correlation & lead-lag metrics into plain English.
 */
export function describeComparisonPlainly(
  comparison: CrossRegionComparison,
  labelA: string,
  labelB: string
): PlainComparisonDigest {
  const absR = Math.max(Math.abs(comparison.pearsonR), Math.abs(comparison.detrendedR));
  const strengthLabel: PlainComparisonDigest["strengthLabel"] =
    comparison.isSecularDriftOnly
      ? "Shared long-term drift"
      : absR >= 0.6
        ? "Strong link"
        : absR >= 0.35
          ? "Moderate link"
          : "Weak link";

  const badgeLabel: PlainComparisonDigest["badgeLabel"] =
    comparison.classification === "opposite_teleconnection"
      ? "Opposite trends"
      : comparison.classification === "co_trending"
        ? "Moving together"
        : "No clear link";

  const headline =
    badgeLabel === "Opposite trends"
      ? `${labelA} and ${labelB} move in opposite directions`
      : badgeLabel === "Moving together"
        ? `${labelA} and ${labelB} shift together`
        : `${labelA} and ${labelB} show little connection`;

  let explanation: string;
  if (comparison.isSecularDriftOnly) {
    explanation = `Both places shifted over the multi-decade window, though their year-to-year swings move mostly independently.`;
  } else if (badgeLabel === "Opposite trends") {
    explanation = `When conditions rise in ${labelA}, they tend to fall in ${labelB} (${comparison.mechanism.toLowerCase()}).`;
  } else if (badgeLabel === "Moving together") {
    explanation = `Both places tend to rise and fall together over time (${comparison.mechanism.toLowerCase()}).`;
  } else {
    explanation = `Changes at these two spots do not follow a consistent shared pattern over time.`;
  }

  let timingNote: string;
  const lagCount = Math.abs(comparison.optimalLagSteps);
  const lagWord =
    lagCount === 1 && comparison.lagUnit.endsWith("s")
      ? comparison.lagUnit.slice(0, -1)
      : comparison.lagUnit;
  if (comparison.optimalLagSteps === 0) {
    timingNote = "Both locations respond in the same year.";
  } else if (comparison.optimalLagSteps > 0) {
    timingNote = `Shifts in ${labelA} typically show up about ${lagCount} ${lagWord} before ${labelB}.`;
  } else {
    timingNote = `Shifts in ${labelB} typically show up about ${lagCount} ${lagWord} before ${labelA}.`;
  }

  if (comparison.sharedRegimeShiftYear) {
    timingNote += ` Both shifted around ${comparison.sharedRegimeShiftYear}.`;
  }

  return {
    badgeLabel,
    strengthLabel,
    headline,
    explanation,
    timingNote,
  };
}

/**
 * Returns up to `limit` active geo-pinned nodes within `maxKm` of `(lat, lng)`, closest first.
 */
export function findNearbyFilteredNodes(
  lat: number,
  lng: number,
  nodes: ETGNode[],
  maxKm = 950,
  limit = 3
): Array<{ node: ETGNode; distanceKm: number }> {
  const hits: Array<{ node: ETGNode; distanceKm: number }> = [];
  for (const node of nodes) {
    if (node.label === "Rule") continue;
    const nLat = node.properties.lat;
    const nLng = node.properties.lng;
    if (typeof nLat !== "number" || typeof nLng !== "number") continue;
    const dist = haversineDistanceKm(lat, lng, nLat, nLng);
    if (dist <= maxKm) {
      hits.push({ node, distanceKm: Math.round(dist) });
    }
  }
  return hits.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
}

export const ALL_RELATION_CATEGORIES: readonly RelationCategory[] = [
  "opposite",
  "causal",
  "coupled",
  "corroboration",
] as const;

export const RELATION_CATEGORY_META: Record<
  RelationCategory,
  { label: string; shortLabel: string; description: string }
> = {
  opposite: {
    label: "Opposite Trends",
    shortLabel: "Opposite",
    description: "Regions or variables moving in opposing directions from a shared driver",
  },
  causal: {
    label: "Causal & Transport",
    shortLabel: "Causal →",
    description: "Directional leads, heat/smoke transport, amplification, dampening, or impact chains",
  },
  coupled: {
    label: "Coupled & Teleconnected",
    shortLabel: "Coupled",
    description: "Co-varying regions, atmospheric teleconnections, or hypothesized links",
  },
  corroboration: {
    label: "Evidence & Lineage",
    shortLabel: "Evidence",
    description: "Independent corroboration, rule verification, sensor monitoring, and belief revision",
  },
};

/** Canonical list of all 16 ETG relationship types. */
export const ALL_ETG_RELATIONSHIP_TYPES: readonly ETGRelationshipType[] = [
  "drives_opposite",
  "leads",
  "advects_to",
  "amplifies",
  "dampens",
  "triggers",
  "impacts",
  "correlates_with",
  "teleconnects",
  "relates_to",
  "hypothesized_link",
  "corroborates",
  "supports",
  "verified_by",
  "monitors",
  "supersedes",
] as const;

/** Resolve allowed ETG relationship types matching the workspace's active filter toggles. */
export function getRelationshipTypesForFilter(
  onlyOpposite: boolean,
  enabledCategories: readonly RelationCategory[]
): ETGRelationshipType[] {
  if (onlyOpposite) {
    return ["drives_opposite"];
  }
  const catSet = new Set(enabledCategories);
  return ALL_ETG_RELATIONSHIP_TYPES.filter((type) =>
    catSet.has(classifyRelationCategory(type))
  );
}

/** Classify any of the 16 ETGRelationshipTypes into one of four top-level UI/globe categories. */
export function classifyRelationCategory(
  type: ETGRelationshipType
): RelationCategory {
  switch (type) {
    case "drives_opposite":
      return "opposite";
    case "leads":
    case "advects_to":
    case "amplifies":
    case "dampens":
    case "triggers":
    case "impacts":
      return "causal";
    case "correlates_with":
    case "teleconnects":
    case "relates_to":
    case "hypothesized_link":
      return "coupled";
    case "corroborates":
    case "supports":
    case "verified_by":
    case "monitors":
    case "supersedes":
      return "corroboration";
  }
}

export interface FormattedRelationItem {
  edgeUuid: string;
  edgeType: ETGRelationshipType;
  category: RelationCategory;
  categoryLabel: string;
  direction: "outgoing" | "incoming" | "undirected";
  badgeText: string;
  verbPhrase: string;
  peerName: string;
  peerRegion: string | null;
  distanceKm: number | null;
  correlationText: string | null;
  lagText: string | null;
  liftText: string | null;
  summaryLine: string;
}

const SYMMETRIC_TYPES = new Set<ETGRelationshipType>([
  "drives_opposite",
  "correlates_with",
  "teleconnects",
  "relates_to",
  "hypothesized_link",
]);

function describeRelationVerb(
  type: ETGRelationshipType,
  direction: "outgoing" | "incoming" | "undirected"
): { badgeText: string; verbPhrase: string } {
  const incoming = direction === "incoming";
  switch (type) {
    case "drives_opposite":
      return { badgeText: "Opposite trends", verbPhrase: "moves opposite to" };
    case "leads":
      return incoming
        ? { badgeText: "Lags behind", verbPhrase: "responds after" }
        : { badgeText: "Leads", verbPhrase: "leads shifts in" };
    case "advects_to":
      return incoming
        ? { badgeText: "Receives flow", verbPhrase: "receives plumes or air from" }
        : { badgeText: "Transports", verbPhrase: "transports plumes toward" };
    case "amplifies":
      return incoming
        ? { badgeText: "Amplified by", verbPhrase: "amplified by" }
        : { badgeText: "Amplifies", verbPhrase: "amplifies" };
    case "dampens":
      return incoming
        ? { badgeText: "Dampened by", verbPhrase: "dampened by" }
        : { badgeText: "Dampens", verbPhrase: "dampens" };
    case "triggers":
      return incoming
        ? { badgeText: "Triggered by", verbPhrase: "triggered by" }
        : { badgeText: "Triggers", verbPhrase: "triggers" };
    case "impacts":
      return incoming
        ? { badgeText: "Impacted by", verbPhrase: "impacted by" }
        : { badgeText: "Impacts", verbPhrase: "impacts" };
    case "correlates_with":
      return { badgeText: "Correlates", verbPhrase: "moves together with" };
    case "teleconnects":
      return { badgeText: "Teleconnects", verbPhrase: "teleconnects with" };
    case "relates_to":
      return { badgeText: "Related", verbPhrase: "relates to" };
    case "hypothesized_link":
      return { badgeText: "Hypothesis", verbPhrase: "hypothesized link to" };
    case "corroborates":
      return incoming
        ? { badgeText: "Corroborated by", verbPhrase: "corroborated by" }
        : { badgeText: "Corroborates", verbPhrase: "corroborates" };
    case "supports":
      return incoming
        ? { badgeText: "Supported by", verbPhrase: "supported by" }
        : { badgeText: "Supports", verbPhrase: "supports" };
    case "verified_by":
      return incoming
        ? { badgeText: "Verifies", verbPhrase: "verifies" }
        : { badgeText: "Verified by", verbPhrase: "verified under" };
    case "monitors":
      return incoming
        ? { badgeText: "Monitored by", verbPhrase: "monitored by" }
        : { badgeText: "Monitors", verbPhrase: "monitors" };
    case "supersedes":
      return incoming
        ? { badgeText: "Superseded by", verbPhrase: "updated by" }
        : { badgeText: "Supersedes", verbPhrase: "revises / supersedes" };
  }
}

/**
 * Format an ETGEdge and its peer node into a concise, plain-language relation item
 * suitable for the Spot Card, Relations drawer, and Knowledge Graph overlays.
 */
export function formatRelationForDisplay(
  edge: ETGEdge,
  anchorNode: ETGNode | null | undefined,
  peerNode: ETGNode
): FormattedRelationItem {
  const category = classifyRelationCategory(edge.type);
  const categoryLabel = RELATION_CATEGORY_META[category].shortLabel;
  const isSymmetric = SYMMETRIC_TYPES.has(edge.type);
  const direction: FormattedRelationItem["direction"] = isSymmetric
    ? "undirected"
    : anchorNode && edge.target_uuid === anchorNode.uuid
      ? "incoming"
      : "outgoing";

  const { badgeText, verbPhrase } = describeRelationVerb(edge.type, direction);
  const peerName = humanizeNodeText(peerNode.properties.name);

  const rawRegion = peerNode.properties.region?.trim();
  const peerRegion =
    rawRegion && !isCoordinateOnlyRegion(rawRegion)
      ? rawRegion
      : typeof peerNode.properties.lat === "number" &&
          typeof peerNode.properties.lng === "number"
        ? formatCoordShort(peerNode.properties.lat, peerNode.properties.lng)
        : null;

  const distanceKm =
    anchorNode &&
    typeof anchorNode.properties.lat === "number" &&
    typeof anchorNode.properties.lng === "number" &&
    typeof peerNode.properties.lat === "number" &&
    typeof peerNode.properties.lng === "number"
      ? Math.round(
          haversineDistanceKm(
            anchorNode.properties.lat,
            anchorNode.properties.lng,
            peerNode.properties.lat,
            peerNode.properties.lng
          )
        )
      : null;

  const detrended = edge.properties.detrended_r;
  const pearson = edge.properties.correlation_r;
  let correlationText: string | null = null;
  if (typeof detrended === "number" && Number.isFinite(detrended)) {
    correlationText = `r* ${detrended >= 0 ? "+" : ""}${detrended.toFixed(2)}`;
  } else if (typeof pearson === "number" && Number.isFinite(pearson)) {
    correlationText = `r ${pearson >= 0 ? "+" : ""}${pearson.toFixed(2)}`;
  }

  let lagText: string | null = null;
  const steps = edge.properties.optimal_lag_steps;
  const days = edge.properties.lag_days;
  if (typeof steps === "number" && Number.isFinite(steps) && steps !== 0) {
    const absSteps = Math.abs(steps);
    const unitRaw = edge.properties.lag_unit ?? "years";
    const unitWord =
      absSteps === 1 && unitRaw.endsWith("s") ? unitRaw.slice(0, -1) : unitRaw;
    lagText = `lag ${absSteps} ${unitWord}`;
  } else if (typeof days === "number" && Number.isFinite(days) && days !== 0) {
    const absDays = Math.abs(days);
    lagText = `lag ${absDays}d`;
  }

  const lift = edge.properties.predictive_lift_pct;
  const liftText =
    typeof lift === "number" && Number.isFinite(lift) && lift > 0
      ? `+${Math.round(lift)}% skill`
      : null;

  const rawRationale =
    edge.properties.rationale?.trim() ||
    edge.properties.mechanism?.trim() ||
    edge.properties.source_snippet?.trim() ||
    "";
  const summaryLine = rawRationale
    ? humanizeNodeText(rawRationale)
    : `${anchorNode ? humanizeNodeText(anchorNode.properties.name) : "Source"} ${verbPhrase} ${peerName}`;

  return {
    edgeUuid: edge.properties.uuid,
    edgeType: edge.type,
    category,
    categoryLabel,
    direction,
    badgeText,
    verbPhrase,
    peerName,
    peerRegion,
    distanceKm,
    correlationText,
    lagText,
    liftText,
    summaryLine,
  };
}

/**
 * Formats cross-region lead/lag steps cleanly without mid-word slice truncation.
 */
export function formatCompactLag(steps: number, lagUnit: string): string {
  if (!Number.isFinite(steps) || steps === 0) return "0 lag";
  const abs = Math.abs(steps);
  const norm = lagUnit.trim().toLowerCase();
  const unitLabel =
    norm.startsWith("year") || norm === "yr" || norm === "yrs"
      ? abs === 1
        ? "yr"
        : "yrs"
      : norm.startsWith("month") || norm === "mo" || norm === "mos"
        ? abs === 1
          ? "mo"
          : "mos"
        : norm.startsWith("day") || norm === "d"
          ? "d"
          : lagUnit.trim();
  return `${steps} ${unitLabel}`;
}
