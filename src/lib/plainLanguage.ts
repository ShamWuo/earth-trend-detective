import { DATASET_BY_ID } from "@/lib/datasets";
import type {
  CrossRegionComparison,
  ETGNode,
  TrendAnalysisSummary,
} from "@/types/etg";

export interface PlainTrendDigest {
  topicLabel: string;
  headline: string;
  ratePerDecade: string;
  certaintyLabel: "Clear trend" | "Likely trend" | "Normal swings";
  isSignificant: boolean;
  summarySentence: string;
  tone: "rising" | "falling" | "steady";
}

export interface PlainComparisonDigest {
  badgeLabel: "Opposite trends" | "Moving together" | "No clear link";
  strengthLabel: "Strong link" | "Moderate link" | "Weak link";
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

function resolveTopicHeadline(summary: TrendAnalysisSummary): {
  headline: string;
  tone: "rising" | "falling" | "steady";
} {
  const { dataset, mannKendall, parameter, unit } = summary;
  const paramLower = parameter.toLowerCase();
  const isSeaIceMetric = paramLower.includes("ice") && unit.toLowerCase().includes("km");

  if (!mannKendall.significant || mannKendall.direction === "no_trend") {
    const steadyMap: Record<TrendAnalysisSummary["dataset"], string> = {
      nasa_power: "Steady temperatures",
      wildfire: "Typical peak heat",
      hydrology: "Steady rainfall",
      ocean_temp: isSeaIceMetric ? "Steady sea ice extent" : "Steady surface warmth",
      deforestation: "Steady land moisture",
      air_quality: paramLower.includes("co2") ? "Steady CO₂ levels" : "Steady air & sunlight",
      community: "Steady local readings",
    };
    return { headline: steadyMap[dataset] ?? "Steady conditions", tone: "steady" };
  }

  const rising = mannKendall.direction === "increasing";
  const tone = rising ? "rising" : "falling";

  if (dataset === "nasa_power") {
    return { headline: rising ? "Warming steadily" : "Cooling trend", tone };
  }
  if (dataset === "wildfire") {
    return { headline: rising ? "Peak heat rising" : "Peak heat easing", tone };
  }
  if (dataset === "hydrology") {
    return { headline: rising ? "Getting wetter" : "Getting drier", tone };
  }
  if (dataset === "ocean_temp") {
    if (isSeaIceMetric) {
      return { headline: rising ? "Sea ice expanding" : "Sea ice shrinking", tone };
    }
    return { headline: rising ? "Surface warming" : "Surface cooling", tone };
  }
  if (dataset === "deforestation") {
    return { headline: rising ? "Greening / moister" : "Drying / canopy stress", tone };
  }
  if (dataset === "air_quality") {
    if (paramLower.includes("co2")) {
      return { headline: rising ? "CO₂ rising" : "CO₂ declining", tone };
    }
    return { headline: rising ? "Higher sunlight / clearer" : "More haze / cloudier", tone };
  }
  return { headline: rising ? "Rising steadily" : "Declining steadily", tone };
}

/**
 * Translates technical Mann-Kendall and Theil-Sen output into plain, jargon-free English.
 */
export function describeTrendPlainly(
  summary: TrendAnalysisSummary
): PlainTrendDigest {
  const dsMeta = DATASET_BY_ID[summary.dataset];
  const topicLabel = dsMeta?.shortLabel ?? "Earth trend";
  const { headline, tone } = resolveTopicHeadline(summary);
  const p = summary.mannKendall.pValue;
  const certaintyLabel: PlainTrendDigest["certaintyLabel"] =
    p < 0.01 ? "Clear trend" : p < 0.05 ? "Likely trend" : "Normal swings";

  const ratePerDecade = formatSignedRatePerDecade(
    summary.theilSen.slope,
    summary.unit,
    summary.slopeUnit
  );

  const yearsCount = summary.points.length;
  const windowLabel =
    yearsCount >= 20 ? `${yearsCount}-year average` : "historical average";
  const diff = summary.latestValue - summary.mean;
  const absDiff = Math.abs(diff);
  const diffDir =
    absDiff < Math.max(0.01, summary.stdDev * 0.15)
      ? "close to"
      : diff > 0
        ? `${formatMagnitude(absDiff, summary.unit)} above`
        : `${formatMagnitude(absDiff, summary.unit)} below`;

  let summarySentence =
    diffDir === "close to"
      ? `Recent average (${formatMagnitude(summary.latestValue, summary.unit)}) is close to the ${windowLabel} (${formatMagnitude(summary.mean, summary.unit)}).`
      : `Recent average (${formatMagnitude(summary.latestValue, summary.unit)}) is ${diffDir} the ${windowLabel} (${formatMagnitude(summary.mean, summary.unit)}).`;

  if (!summary.mannKendall.significant) {
    summarySentence += " Year-to-year swings stay within the normal range.";
  } else if (summary.changePoint?.significant && summary.changePoint.date) {
    summarySentence += ` Shifted noticeably around ${summary.changePoint.date}.`;
  }

  return {
    topicLabel,
    headline,
    ratePerDecade,
    certaintyLabel,
    isSignificant: summary.mannKendall.significant,
    summarySentence,
    tone,
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
    absR >= 0.6 ? "Strong link" : absR >= 0.35 ? "Moderate link" : "Weak link";

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
  if (badgeLabel === "Opposite trends") {
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
