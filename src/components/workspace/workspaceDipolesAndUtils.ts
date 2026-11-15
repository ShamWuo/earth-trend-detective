import type {
  CrossRegionComparison,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  RelationCategory,
  SubgraphTraversalResult,
  TrendAnalysisSummary,
} from "@/types/etg";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import { inferEmbeddedSeriesUnits } from "@/lib/earth/currentConditionsClient";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  RELATION_CATEGORY_META,
  classifyRelationCategory,
  formatRelationForDisplay,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type { ComparisonArcVisualMeta } from "@/components/EarthGlobe3D";
import type { GuidedCaseStudyItem } from "@/components/CompactSpotCard";

export type WorkspaceViewMode = "graph" | "globe";
export type GraphRenderMode = "3d" | "2d";
export type RelationPopoverFilter =
  | "all"
  | "opposite"
  | "causal"
  | "coupled"
  | "chains";

export interface FormattedRelationItem {
  edge: ETGEdge;
  src: ETGNode;
  tgt: ETGNode;
  formatted: ReturnType<typeof formatRelationForDisplay>;
  isGeoPair: boolean;
}

export const DEFAULT_MULTI_TOPICS: ETGDatasetId[] = [
  "nasa_power",
  "wildfire",
  "hydrology",
  "ocean_temp",
  "deforestation",
];

export const GRIDDED_TOPIC_SET = new Set<ETGDatasetId>([
  "nasa_power",
  "wildfire",
  "hydrology",
  "ocean_temp",
  "deforestation",
  "air_quality",
]);

export const EMPTY_ROLE_BY_NODE: SubgraphTraversalResult["roleByNode"] = {};
export const EMPTY_HOP_BY_NODE: SubgraphTraversalResult["hopByNode"] = {};
export const EMPTY_CASCADE_EDGE_UUIDS: string[] = [];

export function getNodeTimestampMs(node: ETGNode): number {
  const raw = node.properties.observed_at || node.properties.created_at;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function isSameSpotCoord(
  a: { lat: number; lng: number } | null | undefined,
  lat: number,
  lng: number
): boolean {
  return Boolean(
    a &&
      Number.isFinite(a.lat) &&
      Number.isFinite(a.lng) &&
      Math.hypot(a.lat - lat, a.lng - lng) <= 0.25
  );
}

export function computeClientEmbeddedSummary(
  node: ETGNode | null | undefined
): TrendAnalysisSummary | null {
  if (!node) return null;
  if (
    typeof node.properties.lat !== "number" ||
    typeof node.properties.lng !== "number"
  ) {
    return null;
  }
  const rawSeries = node.properties.series;
  if (!Array.isArray(rawSeries) || rawSeries.length < 5) return null;

  const cleanSeries = rawSeries.filter(
    (pt) =>
      pt &&
      typeof pt.date === "string" &&
      typeof pt.t === "number" &&
      Number.isFinite(pt.t) &&
      typeof pt.value === "number" &&
      Number.isFinite(pt.value)
  );
  if (cleanSeries.length < 5) return null;

  const { unit, slopeUnit } = inferEmbeddedSeriesUnits(node.properties);
  return analyzeTimeSeries(cleanSeries, {
    lat: node.properties.lat,
    lng: node.properties.lng,
    dataset: node.properties.dataset || "nasa_power",
    parameter: node.properties.parameter || node.properties.name,
    unit,
    slopeUnit,
    provenance: node.properties.provenance_source || "Empirical Dataset (Imported)",
  });
}

export function hidePopoverById(id: string) {
  const el = document.getElementById(id) as
    | (HTMLElement & { hidePopover?: () => void })
    | null;
  if (el && typeof el.hidePopover === "function") {
    try {
      el.hidePopover();
    } catch {
      // Safe no-op if popover is already closed
    }
  }
}

export interface GuidedDipoleCase {
  id: string;
  shortLabel: string;
  title: string;
  subtitle: string;
  spotA: { lat: number; lng: number; dataset: ETGDatasetId; name: string };
  spotB: { lat: number; lng: number; dataset: ETGDatasetId; name: string };
}

export const GUIDED_DIPOLE_CASES: readonly GuidedDipoleCase[] = [
  {
    id: "enso-pacific-dipole",
    shortLabel: "Indo-Pacific vs. Madagascar",
    title: "Walker / ENSO Warm Pool vs. Madagascar Drying",
    subtitle:
      "Western Pacific warm-pool ocean warming contrasted with SW Indian Ocean / Madagascar canopy & moisture decline",
    spotA: { lat: 2.0, lng: 145.0, dataset: "ocean_temp", name: "Indo-Pacific Warm Pool" },
    spotB: { lat: -20.513, lng: 45.91, dataset: "deforestation", name: "SW Indian Ocean / Madagascar" },
  },
  {
    id: "arctic-north-atlantic",
    shortLabel: "Arctic vs. Subpolar Gyre",
    title: "Arctic Amplification vs. Subpolar Gyre",
    subtitle:
      "Rapid high-Arctic surface warming contrasted against North Atlantic subpolar ocean temperature shifts",
    spotA: { lat: 78.22, lng: 15.63, dataset: "nasa_power", name: "Svalbard / Barents Sea" },
    spotB: { lat: 53.0, lng: -35.0, dataset: "ocean_temp", name: "Subpolar North Atlantic" },
  },
  {
    id: "western-us-aridity-east-hydro",
    shortLabel: "West VPD vs. Plains River",
    title: "Western Fire Aridity vs. Northern Plains Discharge",
    subtitle:
      "Rising Vapor Pressure Deficit fuel aridity in Northern California contrasted against Northern Plains river discharge shifts",
    spotA: { lat: 39.73, lng: -121.61, dataset: "wildfire", name: "Northern California Foothills" },
    spotB: { lat: 49.9, lng: -97.1, dataset: "hydrology", name: "Red River / Northern Plains" },
  },
  {
    id: "boulder-front-range-aridity",
    shortLabel: "Boulder VPD vs. Divide Moisture",
    title: "Boulder Front Range Aridity vs. Continental Divide Moisture",
    subtitle:
      "Boulder foothills warming & Vapor Pressure Deficit shifts contrasted with high-elevation Continental Divide snow/moisture",
    spotA: { lat: 40.015, lng: -105.2705, dataset: "wildfire", name: "Boulder, CO (Front Range)" },
    spotB: { lat: 40.055, lng: -105.588, dataset: "hydrology", name: "Niwot Ridge / Continental Divide" },
  },
];

const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

/**
 * Computes a framing center and camera radius that keeps both dipole endpoints
 * in view while avoiding polar pull on wide trans-oceanic pairs (e.g., Peru ↔ Australia).
 */
export function computeDipoleFramingTarget(
  spotA: { lat: number; lng: number },
  spotB: { lat: number; lng: number }
): { lat: number; lng: number; radius: number } {
  const phi1 = spotA.lat * TO_RAD;
  const lam1 = spotA.lng * TO_RAD;
  const phi2 = spotB.lat * TO_RAD;
  const lam2 = spotB.lng * TO_RAD;

  const u1x = Math.cos(phi1) * Math.cos(lam1);
  const u1y = Math.sin(phi1);
  const u1z = Math.cos(phi1) * Math.sin(lam1);

  const u2x = Math.cos(phi2) * Math.cos(lam2);
  const u2y = Math.sin(phi2);
  const u2z = Math.cos(phi2) * Math.sin(lam2);

  const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y + u1z * u2z));
  const omega = Math.acos(dot);

  let mx = u1x + u2x;
  let my = u1y + u2y;
  let mz = u1z + u2z;
  let mLenSq = mx * mx + my * my + mz * mz;

  if (mLenSq < 1e-6) {
    // Nearly antipodal: cross u1 with an orthogonal reference axis
    const ax = Math.abs(u1y) < 0.9 ? 0 : 1;
    const ay = Math.abs(u1y) < 0.9 ? 1 : 0;
    const az = 0;
    mx = u1y * az - u1z * ay;
    my = u1z * ax - u1x * az;
    mz = u1x * ay - u1y * ax;
    mLenSq = mx * mx + my * my + mz * mz || 1;
  }

  const mLen = Math.sqrt(mLenSq);
  mx /= mLen;
  my /= mLen;
  mz /= mLen;

  const midLat = Math.asin(Math.max(-1, Math.min(1, my))) * TO_DEG;
  const midLng = Math.atan2(mz, mx) * TO_DEG;
  const lat = omega > 1.8 ? (spotA.lat + spotB.lat) / 2 : midLat;
  const radius = Math.min(295, Math.max(248, Math.round(238 + omega * 22)));

  return { lat, lng: midLng, radius };
}

export function buildNodePayloadFromSummary(summary: TrendAnalysisSummary) {
  const dsMeta = DATASET_BY_ID[summary.dataset];
  const statisticallyAdjusted =
    summary.mannKendall.significant && summary.mannKendall.significantAdjusted;
  const verdictShort =
    summary.verdict === "Normal Environmental Variability"
      ? "Baseline"
      : summary.verdict.replace("Statistically Significant ", "");
  const name = `${dsMeta.shortLabel} ${verdictShort} (${summary.lat.toFixed(1)}°, ${summary.lng.toFixed(1)}°)`;
  return {
    label: "Signal",
    // Single-source interactive globe queries remain provisional until corroborated by a second independent observation.
    is_provisional: true,
    properties: {
      name,
      description: `${summary.parameter} time-series analyzed via Mann-Kendall (raw p=${summary.mannKendall.pValue.toFixed(4)}, Hamed-Rao adj p=${summary.mannKendall.pValueAdjusted.toFixed(4)}) and Theil-Sen slope (${summary.theilSen.slope >= 0 ? "+" : ""}${summary.theilSen.slope.toFixed(3)} ${summary.slopeUnit}). Provenance: ${summary.provenance}.`,
      status: "Provisional",
      importance: statisticallyAdjusted ? 0.82 : 0.62,
      lat: summary.lat,
      lng: summary.lng,
      region: `${summary.lat.toFixed(2)}°, ${summary.lng.toFixed(2)}°`,
      dataset: summary.dataset,
      producer_type: "nasa_satellite",
      confidence: statisticallyAdjusted ? 0.78 : 0.62,
      value: Number(summary.latestValue.toFixed(2)),
      unit: summary.unit,
      p_value: Number(summary.mannKendall.pValue.toFixed(5)),
      p_value_adjusted: Number(summary.mannKendall.pValueAdjusted.toFixed(5)),
      ols_r2: summary.ols.rSquared,
      regime_shift_year: summary.changePoint?.significant ? summary.changePoint.date : undefined,
      theil_sen_slope: Number(summary.theilSen.slope.toFixed(4)),
      slope_unit: summary.slopeUnit,
      series: summary.points.map((p) => ({ date: p.date, t: p.t, value: p.value })),
      observed_at: new Date().toISOString(),
    },
  };
}

export function buildGuidedCaseItems(): GuidedCaseStudyItem[] {
  return GUIDED_DIPOLE_CASES.map((c) => ({
    id: c.id,
    badge: c.shortLabel,
    title: c.title,
    subtitle: c.subtitle,
    dataset: c.spotA.dataset,
    spotAName: c.spotA.name,
    spotBName: c.spotB.name,
    spotACoord: { lat: c.spotA.lat, lng: c.spotA.lng },
    spotBCoord: { lat: c.spotB.lat, lng: c.spotB.lng },
  }));
}

export function resolveCommitRelationEdgeType(
  comparison: CrossRegionComparison
): ETGRelationshipType {
  if (comparison.classification === "opposite_teleconnection") {
    return "drives_opposite";
  }
  if (comparison.classification === "co_trending") {
    return "correlates_with";
  }
  return "relates_to";
}

export function buildComparisonArcVisualMeta(args: {
  viewMode: WorkspaceViewMode;
  probedCoord: { lat: number; lng: number } | null;
  comparePinB: { lat: number; lng: number } | null;
  activeCaseStudyId: string | null;
  relationSourceNode: ETGNode | null;
  relationTargetNode: ETGNode | null;
  comparison: CrossRegionComparison | null;
  telemetryLoading: boolean;
  selectedEdge: ETGEdge | null;
}): ComparisonArcVisualMeta | null {
  const {
    viewMode,
    probedCoord,
    comparePinB,
    activeCaseStudyId,
    relationSourceNode,
    relationTargetNode,
    comparison,
    telemetryLoading,
    selectedEdge,
  } = args;
  if (viewMode !== "globe" || !probedCoord || !comparePinB) return null;

  const activeCase = activeCaseStudyId
    ? (GUIDED_DIPOLE_CASES.find((c) => c.id === activeCaseStudyId) ?? null)
    : null;

  const pairLabel =
    relationSourceNode && relationTargetNode
      ? `${humanizeNodeText(relationSourceNode.properties.name)} ↔ ${humanizeNodeText(relationTargetNode.properties.name)}`
      : activeCase
        ? `${activeCase.spotA.name} ↔ ${activeCase.spotB.name}`
        : `${probedCoord.lat.toFixed(1)}°, ${probedCoord.lng.toFixed(1)}° ↔ ${comparePinB.lat.toFixed(1)}°, ${comparePinB.lng.toFixed(1)}°`;

  const statText = comparison
    ? `r = ${comparison.pearsonR >= 0 ? "+" : ""}${comparison.pearsonR.toFixed(2)} · p = ${
        comparison.pValue < 0.001 ? "<0.001" : comparison.pValue.toFixed(3)
      }`
    : activeCase
      ? telemetryLoading
        ? "Querying live NASA / NOAA series…"
        : activeCase.title
      : telemetryLoading
        ? "Querying live NASA / NOAA series…"
        : null;

  const isSignificant = comparison
    ? comparison.pValue < 0.05 || comparison.detrendedPValue < 0.05
    : Boolean(activeCase);

  if (selectedEdge) {
    const category = classifyRelationCategory(selectedEdge.type);
    const badgeText = relationTargetNode
      ? formatRelationForDisplay(selectedEdge, relationSourceNode, relationTargetNode)
          .badgeText
      : RELATION_CATEGORY_META[category].shortLabel;
    return { category, badgeText, pairLabel, statText, isSignificant };
  }

  if (comparison) {
    if (comparison.classification === "opposite_teleconnection") {
      return {
        category: "opposite",
        badgeText: "Drives Opposite",
        pairLabel,
        statText,
        isSignificant,
      };
    }
    if (comparison.classification === "co_trending") {
      return {
        category: "coupled",
        badgeText: "Co-Trending",
        pairLabel,
        statText,
        isSignificant,
      };
    }
    return {
      category: activeCase ? "opposite" : "corroboration",
      badgeText: activeCase ? activeCase.shortLabel : "Cross-Region Check",
      pairLabel,
      statText,
      isSignificant,
    };
  }

  if (activeCase) {
    return {
      category: "opposite",
      badgeText: activeCase.shortLabel,
      pairLabel,
      statText,
      isSignificant: true,
    };
  }

  return {
    category: "coupled",
    badgeText: "2-Pin Comparison",
    pairLabel,
    statText,
    isSignificant: false,
  };
}

export function buildFormattedAllRelations(
  nodes: ETGNode[],
  edges: ETGEdge[],
  enabledRelationCategories: RelationCategory[]
): FormattedRelationItem[] {
  const nodeById = new Map(nodes.map((n) => [n.uuid, n]));
  const allowedSet = new Set(enabledRelationCategories);
  const items: FormattedRelationItem[] = [];

  for (const edge of edges) {
    const cat = classifyRelationCategory(edge.type);
    if (!allowedSet.has(cat)) continue;
    const src = nodeById.get(edge.source_uuid);
    const tgt = nodeById.get(edge.target_uuid);
    if (!src || !tgt) continue;
    const isGeoPair =
      src.properties.lat !== undefined &&
      src.properties.lng !== undefined &&
      tgt.properties.lat !== undefined &&
      tgt.properties.lng !== undefined;
    items.push({
      edge,
      src,
      tgt,
      formatted: formatRelationForDisplay(edge, src, tgt),
      isGeoPair,
    });
  }

  const catPrio: Record<RelationCategory, number> = {
    opposite: 4,
    causal: 3,
    coupled: 2,
    corroboration: 1,
  };

  return items.sort((a, b) => {
    if (a.isGeoPair !== b.isGeoPair) return a.isGeoPair ? -1 : 1;
    const cDiff = catPrio[b.formatted.category] - catPrio[a.formatted.category];
    if (cDiff !== 0) return cDiff;
    return (
      Math.abs(b.edge.properties.correlation_r ?? 0) -
      Math.abs(a.edge.properties.correlation_r ?? 0)
    );
  });
}
