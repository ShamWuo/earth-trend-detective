import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { bearingDeg } from "@/lib/solar/denverClimateGraph";
import { inferEarthSphere } from "@/lib/graph/cascadeTracer";
import { scorePairWithTrendMicroscope } from "@/lib/graph/trendMicroscope";
import {
  analyzeTimeSeries,
  benjaminiHochbergAdjust,
  compareRegionalSeries,
} from "@/lib/stats/trendEngine";
import {
  ETG_NODE_LABELS,
  FORBIDDEN_SAAS_LABELS,
  type CandidateLinkSuggestion,
  type CausalPathSummary,
  type CorroborationAudit,
  type EarthSphere,
  type ETGAuthorType,
  type ETGDatasetId,
  type ETGEdge,
  type ETGEdgeProperties,
  type ETGNode,
  type ETGNodeLabel,
  type ETGProducerType,
  type ETGRelationshipType,
  type ETGWorkspaceBundle,
  type EtgActivityEntry,
  type GraphMlDatasetExport,
  type GraphMlDatasetExportV2,
  type GraphPredictionResult,
  type OppositeTrendPair,
  type ProspectiveForecastRecord,
  type ProspectiveLedgerSummary,
  type ProvenanceHop,
  type SubgraphNodeRole,
  type SubgraphTraversalOptions,
  type SubgraphTraversalResult,
  type TimeSeriesPoint,
  type TraversalDirection,
} from "@/types/etg";

const DEFAULT_DATA_DIR = path.join(process.cwd(), ".data");
const LEGACY_CACHE_DIR = path.join(process.cwd(), ".etg-cache");
const STATE_FILENAME = "etg-state.json";
const SERIES_FILENAME = "etg-series.json";
const MULTISCALE_FILENAME = "etg-multiscale.json";
const FORECASTS_FILENAME = "etg-forecasts.json";
const MAX_PATH_DEPTH = 12;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeBucketPeriodKey(
  rawDate: string,
  bucket: "day" | "month" | "year"
): string | null {
  const trimmed = rawDate.trim();
  if (!trimmed) return null;
  if (bucket === "year") {
    const y = trimmed.match(/^(\d{4})/);
    return y ? y[1] : null;
  }
  if (bucket === "month") {
    const m = trimmed.match(/^(\d{4})[-/](\d{1,2})/);
    if (m) {
      const month = Number(m[2]);
      if (month >= 1 && month <= 12) {
        return `${m[1]}-${String(month).padStart(2, "0")}`;
      }
    }
    return null;
  }
  const d = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (d) return `${d[1]}-${d[2]}-${d[3]}`;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function toTimeSeriesPoint(rawDate: string, value: number): TimeSeriesPoint | null {
  if (!Number.isFinite(value)) return null;
  const trimmed = rawDate.trim();
  if (!trimmed) return null;
  if (/^\d{4}$/.test(trimmed)) {
    return { date: trimmed, t: Number(trimmed), value };
  }
  const ym = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) {
    const y = Number(ym[1]);
    const m = Number(ym[2]);
    if (m >= 1 && m <= 12) {
      return {
        date: `${y}-${String(m).padStart(2, "0")}`,
        t: Number((y + (m - 1) / 12).toFixed(6)),
        value,
      };
    }
  }
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) {
    const d = new Date(ms);
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const t = Number(
      (d.getUTCFullYear() + (ms - yearStart) / (365.25 * 86_400_000)).toFixed(6)
    );
    return { date: trimmed, t, value };
  }
  return null;
}

function mergeSeriesPoints(
  existing: readonly TimeSeriesPoint[],
  incoming: readonly TimeSeriesPoint[],
  maxPoints = 500
): TimeSeriesPoint[] {
  const byDate = new Map<string, TimeSeriesPoint>();
  for (const pt of existing) {
    if (pt && typeof pt.date === "string" && Number.isFinite(pt.value) && Number.isFinite(pt.t)) {
      byDate.set(pt.date, pt);
    }
  }
  for (const pt of incoming) {
    if (pt && typeof pt.date === "string" && Number.isFinite(pt.value) && Number.isFinite(pt.t)) {
      byDate.set(pt.date, pt);
    }
  }
  return Array.from(byDate.values())
    .sort((a, b) => a.t - b.t)
    .slice(-maxPoints);
}

export type TemporalBucket = "day" | "month" | "year";

export function computeSparklinePreview(
  series: readonly TimeSeriesPoint[] | undefined,
  maxPoints = 16
): number[] | undefined {
  if (!series || series.length < 3) return undefined;
  const finite = series.filter((pt) => Number.isFinite(pt.value));
  if (finite.length < 3) return undefined;
  if (finite.length <= maxPoints) {
    return finite.map((pt) => Number(pt.value.toFixed(4)));
  }
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * (finite.length - 1)) / (maxPoints - 1));
    out.push(Number(finite[idx].value.toFixed(4)));
  }
  return out;
}

function parseSeriesDateMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{4}$/.test(trimmed)) {
    return Date.UTC(Number(trimmed), 0, 1);
  }
  const ym = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) {
    const y = Number(ym[1]);
    const m = Number(ym[2]);
    if (m >= 1 && m <= 12) return Date.UTC(y, m - 1, 1);
  }
  const ymdCompact = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymdCompact) {
    return Date.UTC(Number(ymdCompact[1]), Number(ymdCompact[2]) - 1, Number(ymdCompact[3]));
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

export function inferSeriesBucket(series: readonly TimeSeriesPoint[]): TemporalBucket {
  if (series.length < 2) return "year";

  const parsedMs: number[] = [];
  for (let i = 0; i < Math.min(series.length, 48); i++) {
    const ms = parseSeriesDateMs(series[i].date);
    if (ms !== null) parsedMs.push(ms);
  }

  if (parsedMs.length >= 2) {
    parsedMs.sort((a, b) => a - b);
    const deltaDays: number[] = [];
    for (let i = 1; i < parsedMs.length; i++) {
      const dd = (parsedMs[i] - parsedMs[i - 1]) / 86_400_000;
      if (dd > 0.05) deltaDays.push(dd);
    }
    if (deltaDays.length > 0) {
      deltaDays.sort((a, b) => a - b);
      const medianDays = deltaDays[Math.floor(deltaDays.length / 2)];
      if (medianDays <= 10) return "day";
      if (medianDays <= 95) return "month";
      return "year";
    }
  }

  const deltas: number[] = [];
  for (let i = 1; i < Math.min(series.length, 40); i++) {
    const d = Math.abs(series[i].t - series[i - 1].t);
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) {
    const sample = series[0]?.date ?? "";
    if (/^\d{4}-\d{2}-\d{2}/.test(sample)) return "day";
    if (/^\d{4}-\d{2}/.test(sample)) return "month";
    return "year";
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  if (median < 0.04) return "day";
  if (median < 0.45) return "month";
  return "year";
}

export function extractBucketKey(date: string, bucket: TemporalBucket): string | null {
  const trimmed = date.trim();
  if (!trimmed) return null;
  if (bucket === "day") {
    if (/^\d{8}$/.test(trimmed)) {
      return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
  }
  if (bucket === "month") {
    if (/^\d{8}$/.test(trimmed)) return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}`;
    if (/^\d{4}-\d{2}/.test(trimmed)) return trimmed.slice(0, 7);
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 7) : null;
  }
  if (/^\d{4}/.test(trimmed)) return trimmed.slice(0, 4);
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? String(new Date(ms).getUTCFullYear()) : null;
}

export function aggregateSeriesByBucket(
  series: readonly TimeSeriesPoint[],
  bucket: TemporalBucket
): Map<string, TimeSeriesPoint> {
  return aggregateByBucket(series, (date) => extractBucketKey(date, bucket));
}

function resolveDefaultAuthor(props: Partial<ETGNode["properties"]>): ETGAuthorType {
  if (props.authored_by) return props.authored_by;
  if (props.producer_type === "iot_sensor" || props.producer_type === "community_camera") {
    return "iot_sensor";
  }
  if (props.producer_type === "ai_synthesis") return "ai";
  const src = `${props.provenance_source ?? ""} ${props.source_system ?? ""}`.toLowerCase();
  if (
    props.producer_type === "nasa_satellite" ||
    props.producer_type === "research_station" ||
    /\b(nasa|noaa|nsidc|knmi|csa|usgs|eonet|gistemp|power)\b/.test(src)
  ) {
    return "satellite_pipeline";
  }
  return "human";
}

const SYMMETRIC_EDGE_TYPES = new Set<ETGRelationshipType>([
  "correlates_with",
  "teleconnects",
  "corroborates",
  "relates_to",
]);

function aggregateByBucket(
  series: readonly TimeSeriesPoint[],
  getKey: (date: string) => string | null
): Map<string, TimeSeriesPoint> {
  const buckets = new Map<
    string,
    {
      sumVal: number;
      sumT: number;
      count: number;
      channelSums: Record<string, { sum: number; count: number }> | null;
    }
  >();
  for (const pt of series) {
    const key = getKey(pt.date);
    if (!key) continue;
    let prev = buckets.get(key);
    if (prev) {
      prev.sumVal += pt.value;
      prev.sumT += pt.t;
      prev.count += 1;
    } else {
      prev = {
        sumVal: pt.value,
        sumT: pt.t,
        count: 1,
        channelSums: null,
      };
      buckets.set(key, prev);
    }
    if (pt.channels) {
      if (!prev.channelSums) prev.channelSums = {};
      for (const [chKey, chVal] of Object.entries(pt.channels)) {
        if (typeof chVal !== "number" || !Number.isFinite(chVal)) continue;
        const acc = prev.channelSums[chKey];
        if (acc) {
          acc.sum += chVal;
          acc.count += 1;
        } else {
          prev.channelSums[chKey] = { sum: chVal, count: 1 };
        }
      }
    }
  }
  const out = new Map<string, TimeSeriesPoint>();
  for (const [key, acc] of buckets.entries()) {
    let channels: Record<string, number> | undefined;
    if (acc.channelSums) {
      channels = {};
      for (const [chKey, chAcc] of Object.entries(acc.channelSums)) {
        channels[chKey] = Number((chAcc.sum / chAcc.count).toFixed(4));
      }
    }
    out.set(key, {
      date: key,
      t: acc.sumT / acc.count,
      value: acc.sumVal / acc.count,
      ...(channels ? { channels } : {}),
    });
  }
  return out;
}

export function alignCompatibleSeries(
  seriesA: readonly TimeSeriesPoint[],
  seriesB: readonly TimeSeriesPoint[]
): { alignedA: TimeSeriesPoint[]; alignedB: TimeSeriesPoint[] } | null {
  const extractors: Array<(date: string) => string | null> = [
    (d) => d.trim() || null,
    (d) => (/^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null),
    (d) => (/^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : null),
    (d) => (/^\d{4}/.test(d) ? d.slice(0, 4) : null),
  ];

  for (const getKey of extractors) {
    const mapA = aggregateByBucket(seriesA, getKey);
    const mapB = aggregateByBucket(seriesB, getKey);
    const sharedKeys: string[] = [];
    for (const k of mapA.keys()) {
      if (mapB.has(k)) sharedKeys.push(k);
    }
    if (sharedKeys.length >= 5) {
      sharedKeys.sort(
        (ka, kb) =>
          mapA.get(ka)!.t - mapA.get(kb)!.t || ka.localeCompare(kb)
      );
      return {
        alignedA: sharedKeys.map((k) => mapA.get(k)!),
        alignedB: sharedKeys.map((k) => mapB.get(k)!),
      };
    }
  }

  return null;
}

export interface EtgQueryFilter {
  dataset?: ETGDatasetId | "all";
  label?: ETGNodeLabel | "all";
  since?: string;
  until?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  search?: string;
  includeSuperseded?: boolean;
  onlyOppositeTrends?: boolean;
}

export interface EtgGraphSnapshot {
  nodes: ETGNode[];
  edges: ETGEdge[];
  oppositeTrendPairs: OppositeTrendPair[];
  activity: EtgActivityEntry[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    corroboratedTrends: number;
    provisionalCount: number;
    supersededCount: number;
    oppositeTrendPairsCount: number;
  };
}

export type EtgListener = (event: {
  type: "graph_updated";
  activity?: EtgActivityEntry;
  snapshotStats: EtgGraphSnapshot["stats"];
}) => void;

export function assertValidEtgLabel(label: string): ETGNodeLabel {
  if (FORBIDDEN_SAAS_LABELS.has(label)) {
    throw new Error(
      `Invalid ETG node label "${label}": Earth Trend Detective forbids SaaS/productivity labels (${Array.from(
        FORBIDDEN_SAAS_LABELS
      ).join(", ")}). Allowed labels: ${ETG_NODE_LABELS.join(", ")}.`
    );
  }
  if (!(ETG_NODE_LABELS as readonly string[]).includes(label)) {
    throw new Error(
      `Invalid ETG node label "${label}". Must be one of: ${ETG_NODE_LABELS.join(", ")}.`
    );
  }
  return label as ETGNodeLabel;
}

/**
 * Safe dot/bracket path extractor without eval() or prototype traversal.
 */
export function extractValueByPath(source: unknown, rawPath?: string | null): unknown {
  if (!rawPath || typeof rawPath !== "string" || !source || typeof source !== "object") {
    return undefined;
  }
  const trimmed = rawPath.trim().replace(/^\$\.?/, "");
  if (!trimmed) return undefined;

  const segments = trimmed
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\["([^"]+)"\]/g, ".$1")
    .replace(/\['([^']+)'\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  if (segments.length === 0 || segments.length > MAX_PATH_DEPTH) {
    return undefined;
  }

  let current: unknown = source;
  for (const seg of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) return undefined;
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, seg)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inferProducerType(node: ETGNode): ETGProducerType {
  if (node.properties.producer_type) return node.properties.producer_type;
  const id = node.uuid.toLowerCase();
  const name = (node.properties.name || "").toLowerCase();
  if (id.includes("cam") || name.includes("camera")) return "community_camera";
  if (id.includes("firms") || id.includes("modis") || id.includes("eonet") || name.includes("nasa")) {
    return "nasa_satellite";
  }
  if (id.includes("buoy") || id.includes("sensor") || id.includes("pm25") || id.includes("flux")) {
    return "iot_sensor";
  }
  return "ai_synthesis";
}

const PRODUCER_TRUST_BASE: Record<ETGProducerType, number> = {
  nasa_satellite: 0.9,
  research_station: 0.89,
  ai_synthesis: 0.72,
  iot_sensor: 0.62,
  community_camera: 0.58,
};

export function isCommunityContributorNode(node: ETGNode): boolean {
  const producer = node.properties.producer_type;
  const author = node.properties.authored_by;
  const src = `${node.properties.provenance_source ?? ""} ${node.properties.source_system ?? ""}`.toLowerCase();
  if (producer === "iot_sensor" || producer === "community_camera") return true;
  if (author === "iot_sensor") return true;
  if (node.properties.dataset === "community") return true;
  if (typeof node.properties.device_id === "string" && node.properties.device_id.length > 0) {
    return true;
  }
  if (
    typeof node.properties.trust_score === "number" &&
    author === "human" &&
    !/\b(nasa|noaa|nsidc|knmi|usgs|csa|eonet|gistemp|power)\b/.test(src)
  ) {
    return true;
  }
  return false;
}

/**
 * Computes bounded inductive trust weight [0.15, 1.0] from producer provenance,
 * multi-source corroboration status, Mann-Kendall certainty, and observed
 * leave-one-out community lift feedback.
 */
export function computeEtgNodeTrustScore(node: ETGNode): number {
  const producer = inferProducerType(node);
  const author = resolveDefaultAuthor(node.properties);
  const lift = node.properties.community_lift_pct;
  const liftAdj =
    typeof lift === "number" && Number.isFinite(lift)
      ? lift >= 0
        ? Math.min(0.14, (lift / 25) * 0.14)
        : Math.max(-0.32, Math.min(0, (lift + 2) * 0.03))
      : 0;

  if (
    typeof node.properties.trust_score === "number" &&
    Number.isFinite(node.properties.trust_score)
  ) {
    const corrBonus = node.properties.corroborated ? 0.05 : 0;
    return Number(
      Math.max(0.15, Math.min(1, node.properties.trust_score + corrBonus + liftAdj)).toFixed(4)
    );
  }

  let score =
    author === "satellite_pipeline"
      ? 0.88
      : author === "human"
      ? 0.56
      : PRODUCER_TRUST_BASE[producer] ?? 0.65;

  const indepCount =
    typeof node.properties.independent_sources_count === "number"
      ? node.properties.independent_sources_count
      : 1;
  if (node.properties.corroborated && indepCount >= 2) {
    score += 0.08;
  }
  if (node.is_provisional) {
    score -= 0.12;
  }
  if (typeof node.properties.confidence === "number" && Number.isFinite(node.properties.confidence)) {
    score += (Math.max(0, Math.min(1, node.properties.confidence)) - 0.5) * 0.08;
  }
  if (typeof node.properties.p_value === "number" && node.properties.p_value < 0.05) {
    score += 0.04;
  }
  score += liftAdj;
  return Number(Math.max(0.15, Math.min(1, score)).toFixed(4));
}

export function inferNodeTemporalScale(
  node: ETGNode,
  series?: readonly TimeSeriesPoint[]
): "day" | "month" | "year" | "impulse" {
  if (node.properties.temporal_scale) return node.properties.temporal_scale;
  if (
    typeof node.properties.event_intensity === "number" ||
    (node.uuid.includes("eonet") && (!series || series.length < 4))
  ) {
    return "impulse";
  }
  if (series && series.length >= 2) {
    return inferSeriesBucket(series);
  }
  if (node.properties.observed_at && (!series || series.length <= 1)) {
    return "impulse";
  }
  return "year";
}

const COVAR_CHANNEL_PRIORITY = [
  "vpd",
  "rh2m",
  "precip",
  "ws10m",
  "glofas",
  "pm25",
  "allsky",
  "clrsky",
  "kt",
  "t2m_max",
];

function computeCausalPearsonAndLag(
  srcMap: Map<string, TimeSeriesPoint>,
  dstMap: Map<string, TimeSeriesPoint>,
  trainKeys: readonly string[]
): { corrR: number; optimalLag: number } {
  const maxLag = 3;
  let bestR = 0;
  let bestAbsR = 0;
  let bestLag = 0;

  for (let lag = -1; lag <= maxLag; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = Math.max(0, lag); i < trainKeys.length; i++) {
      const srcIdx = i - lag;
      if (srcIdx < 0 || srcIdx >= trainKeys.length) continue;
      const a = srcMap.get(trainKeys[srcIdx])?.value;
      const b = dstMap.get(trainKeys[i])?.value;
      if (
        a !== undefined &&
        b !== undefined &&
        Number.isFinite(a) &&
        Number.isFinite(b)
      ) {
        xs.push(a);
        ys.push(b);
      }
    }
    if (xs.length < 4) continue;
    const n = xs.length;
    const meanX = xs.reduce((s, v) => s + v, 0) / n;
    const meanY = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let denX = 0;
    let denY = 0;
    for (let k = 0; k < n; k++) {
      const dx = xs[k] - meanX;
      const dy = ys[k] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    if (denX > 1e-12 && denY > 1e-12) {
      const r = Math.max(-1, Math.min(1, num / Math.sqrt(denX * denY)));
      if (Math.abs(r) > bestAbsR) {
        bestAbsR = Math.abs(r);
        bestR = r;
        bestLag = lag;
      }
    }
  }
  return {
    corrR: Number(bestR.toFixed(4)),
    optimalLag: bestLag,
  };
}

interface CausalImpulseEvent {
  ms: number;
  intensity: number;
  decayDays: number;
}

function buildCausalScaleBlock(args: {
  nodeCount: number;
  scaleMaps: Array<Map<string, TimeSeriesPoint>>;
  impulseEventsByNode: Map<number, CausalImpulseEvent[]>;
  incidentImpulsesByNode: Map<number, number[]>;
  trainFraction: number;
  trainCutoffDate?: string;
}) {
  const {
    nodeCount,
    scaleMaps,
    impulseEventsByNode,
    incidentImpulsesByNode,
    trainFraction,
    trainCutoffDate,
  } = args;
  const timeKeyToT = new Map<string, number>();
  for (const m of scaleMaps) {
    for (const [k, pt] of m.entries()) {
      if (!timeKeyToT.has(k)) timeKeyToT.set(k, pt.t);
    }
  }
  const timeIndex = Array.from(timeKeyToT.keys()).sort(
    (a, b) => (timeKeyToT.get(a) ?? 0) - (timeKeyToT.get(b) ?? 0) || a.localeCompare(b)
  );
  const T = timeIndex.length;
  const frac = Math.max(0.4, Math.min(0.9, trainFraction));
  const timeIndexMs = timeIndex.map((k) => parseSeriesDateMs(k) ?? 0);
  const cutoffMs = trainCutoffDate ? parseSeriesDateMs(trainCutoffDate) : null;
  let trainCutoffIndex = T >= 4 ? Math.max(2, Math.min(T - 1, Math.floor(T * frac))) : T;
  if (trainCutoffDate) {
    let strictBeforeCount = 0;
    for (let i = 0; i < T; i++) {
      const ms = timeIndexMs[i];
      if (cutoffMs !== null && ms > 0) {
        if (ms < cutoffMs) strictBeforeCount++;
      } else if (timeIndex[i].localeCompare(trainCutoffDate) < 0) {
        strictBeforeCount++;
      }
    }
    trainCutoffIndex = Math.max(0, Math.min(T, strictBeforeCount));
  }

  const normStats: Array<{ mean: number; std: number }> = [];
  const monthMeans: Array<Map<string, number>> = [];
  const covarKeys: Array<string | null> = [];
  const covarStats: Array<{ mean: number; std: number }> = [];

  for (let j = 0; j < nodeCount; j++) {
    const m = scaleMaps[j];
    const trainVals: number[] = [];
    const perMonth = new Map<string, { sum: number; count: number }>();
    let chosenCovarKey: string | null = null;

    for (let t = 0; t < trainCutoffIndex; t++) {
      const key = timeIndex[t];
      const pt = m.get(key);
      if (!pt || !Number.isFinite(pt.value)) continue;
      trainVals.push(pt.value);
      const ym = key.match(/^\d{4}-(\d{2})/);
      if (ym) {
        const prev = perMonth.get(ym[1]);
        if (prev) {
          prev.sum += pt.value;
          prev.count += 1;
        } else {
          perMonth.set(ym[1], { sum: pt.value, count: 1 });
        }
      }
      if (!chosenCovarKey && pt.channels) {
        for (const pref of COVAR_CHANNEL_PRIORITY) {
          if (typeof pt.channels[pref] === "number" && Number.isFinite(pt.channels[pref])) {
            chosenCovarKey = pref;
            break;
          }
        }
        if (!chosenCovarKey) {
          const fallbackKey = Object.keys(pt.channels).find(
            (k) => typeof pt.channels?.[k] === "number" && Number.isFinite(pt.channels[k])
          );
          if (fallbackKey) chosenCovarKey = fallbackKey;
        }
      }
    }

    const mean =
      trainVals.length > 0 ? trainVals.reduce((s, v) => s + v, 0) / trainVals.length : 0;
    const variance =
      trainVals.length > 1
        ? trainVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (trainVals.length - 1)
        : 1;
    normStats.push({ mean, std: Math.max(1e-6, Math.sqrt(variance)) });

    const monthMap = new Map<string, number>();
    for (const [mm, acc] of perMonth.entries()) {
      monthMap.set(mm, acc.sum / acc.count);
    }
    monthMeans.push(monthMap);

    covarKeys.push(chosenCovarKey);
    if (chosenCovarKey) {
      const cVals: number[] = [];
      for (let t = 0; t < trainCutoffIndex; t++) {
        const c = m.get(timeIndex[t])?.channels?.[chosenCovarKey];
        if (typeof c === "number" && Number.isFinite(c)) cVals.push(c);
      }
      const cMean = cVals.length > 0 ? cVals.reduce((s, v) => s + v, 0) / cVals.length : 0;
      const cVar =
        cVals.length > 1
          ? cVals.reduce((s, v) => s + (v - cMean) ** 2, 0) / (cVals.length - 1)
          : 1;
      covarStats.push({ mean: cMean, std: Math.max(1e-6, Math.sqrt(cVar)) });
    } else {
      covarStats.push({ mean: 0, std: 1 });
    }
  }

  const featureTensor: number[][][] = [];
  const maskTensor: number[][] = [];
  const prevObserved: Array<number | null> = Array.from({ length: nodeCount }, () => null);
  const recentZWindows: number[][] = Array.from({ length: nodeCount }, () => []);

  for (let t = 0; t < T; t++) {
    const tKey = timeIndex[t];
    const tMs = timeIndexMs[t];
    const monthToken = tKey.match(/^\d{4}-(\d{2})/)?.[1];
    const rowFeat: number[][] = [];
    const rowMask: number[] = [];

    for (let j = 0; j < nodeCount; j++) {
      let impulseVal = 0;
      const sourceNodes = [j, ...(incidentImpulsesByNode.get(j) ?? [])];
      for (const sIdx of sourceNodes) {
        const events = impulseEventsByNode.get(sIdx);
        if (!events) continue;
        const atten = sIdx === j ? 1 : 0.6;
        for (const ev of events) {
          if (ev.ms <= tMs) {
            const deltaDays = (tMs - ev.ms) / 86_400_000;
            if (deltaDays <= ev.decayDays * 4) {
              impulseVal += atten * ev.intensity * Math.exp(-deltaDays / Math.max(1, ev.decayDays));
            }
          }
        }
      }
      impulseVal = Number(Math.min(2.5, impulseVal).toFixed(4));

      const pt = scaleMaps[j].get(tKey);
      if (pt && Number.isFinite(pt.value)) {
        const { mean, std } = normStats[j];
        const z = (pt.value - mean) / std;
        const prev = prevObserved[j];
        const diff1 = prev !== null ? (pt.value - prev) / std : 0;
        prevObserved[j] = pt.value;

        const win = recentZWindows[j];
        win.push(z);
        if (win.length > 4) win.shift();
        const rMean = win.reduce((s, v) => s + v, 0) / win.length;
        const rVar =
          win.length > 1
            ? win.reduce((s, v) => s + (v - rMean) ** 2, 0) / (win.length - 1)
            : 0;
        const rStd = Math.sqrt(rVar);

        const climMean =
          monthToken && monthMeans[j].has(monthToken) ? monthMeans[j].get(monthToken)! : mean;
        const seasonalAnom = monthToken ? (pt.value - climMean) / std : 0;

        let covarNorm = 0;
        const ck = covarKeys[j];
        if (ck && pt.channels && typeof pt.channels[ck] === "number" && Number.isFinite(pt.channels[ck])) {
          covarNorm = (pt.channels[ck] - covarStats[j].mean) / covarStats[j].std;
        }

        rowFeat.push([
          Number(pt.value.toFixed(4)),
          Number(z.toFixed(4)),
          Number(diff1.toFixed(4)),
          Number(rMean.toFixed(4)),
          Number(rStd.toFixed(4)),
          Number(seasonalAnom.toFixed(4)),
          impulseVal,
          Number(covarNorm.toFixed(4)),
        ]);
        rowMask.push(1);
      } else {
        rowFeat.push([0, 0, 0, 0, 0, 0, impulseVal, 0]);
        rowMask.push(0);
      }
    }
    featureTensor.push(rowFeat);
    maskTensor.push(rowMask);
  }

  return {
    timeIndex,
    trainCutoffIndex,
    normStats,
    featureTensor,
    maskTensor,
  };
}

export class EtgStore {
  private persistDir: string | null;
  private loadingState = false;
  private nodes: Map<string, ETGNode> = new Map();
  private edges: Map<string, ETGEdge> = new Map();
  private seriesByNode: Map<string, TimeSeriesPoint[]> = new Map();
  private multiScaleSeriesByNode: Map<
    string,
    Partial<Record<TemporalBucket, TimeSeriesPoint[]>>
  > = new Map();
  private forecasts: Map<string, ProspectiveForecastRecord> = new Map();
  private activity: EtgActivityEntry[] = [];
  private listeners: Set<EtgListener> = new Set();

  constructor(options?: { persistDir?: string | null }) {
    if (options && options.persistDir !== undefined) {
      this.persistDir = options.persistDir;
    } else {
      const isTestEnv =
        process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
      this.persistDir = isTestEnv ? null : DEFAULT_DATA_DIR;
    }
    this.loadInitialState();
  }

  private getPersistencePaths(baseDir?: string | null): {
    dir: string;
    stateFile: string;
    seriesFile: string;
    multiscaleFile: string;
    forecastsFile: string;
  } | null {
    const dir = baseDir ?? this.persistDir;
    if (!dir) return null;
    return {
      dir,
      stateFile: path.join(dir, STATE_FILENAME),
      seriesFile: path.join(dir, SERIES_FILENAME),
      multiscaleFile: path.join(dir, MULTISCALE_FILENAME),
      forecastsFile: path.join(dir, FORECASTS_FILENAME),
    };
  }

  private reconcileSeriesForTarget(
    targetUuid: string,
    series: readonly TimeSeriesPoint[]
  ): number {
    if (this.forecasts.size === 0 || series.length === 0) return 0;

    const pendingForTarget = Array.from(this.forecasts.values()).filter(
      (f) => f.target_uuid === targetUuid && f.status === "pending"
    );
    if (pendingForTarget.length === 0) return 0;

    let scoredNow = 0;
    const nowIso = new Date().toISOString();

    for (const forecast of pendingForTarget) {
      const matchingVals: number[] = [];
      for (const pt of series) {
        if (!pt || !Number.isFinite(pt.value)) continue;
        const key = normalizeBucketPeriodKey(pt.date, forecast.bucket);
        if (key === forecast.target_period) {
          matchingVals.push(pt.value);
        }
      }
      if (matchingVals.length === 0) continue;

      const actualRaw =
        matchingVals.reduce((sum, v) => sum + v, 0) / matchingVals.length;
      const actual = Number(actualRaw.toFixed(4));
      const absError = Number(Math.abs(actual - forecast.predicted_value).toFixed(4));
      const selfAbsError = Number(
        Math.abs(actual - forecast.self_only_pred).toFixed(4)
      );
      const persistAbsError = Number(
        Math.abs(actual - forecast.persistence_pred).toFixed(4)
      );
      const covered =
        Math.abs(actual - forecast.predicted_value) <=
        forecast.ci95_half_width + 1e-9;

      this.forecasts.set(forecast.id, {
        ...forecast,
        status: "scored",
        actual_value: actual,
        reconciled_at: nowIso,
        abs_error: absError,
        self_abs_error: selfAbsError,
        persistence_abs_error: persistAbsError,
        covered_by_ci95: covered,
      });
      scoredNow += 1;
    }

    return scoredNow;
  }

  private offloadNodeSeries(uuid: string, props: ETGNode["properties"]): ETGNode["properties"] {
    const { series, ...rest } = props;
    if (Array.isArray(series) && series.length > 0) {
      this.seriesByNode.set(uuid, series);
      if (!this.loadingState && this.forecasts.size > 0) {
        this.reconcileSeriesForTarget(uuid, series);
      }
      const preview = computeSparklinePreview(series, 16);
      return {
        ...rest,
        series_count: series.length,
        sparkline_preview: preview ?? rest.sparkline_preview,
      };
    }
    if (this.seriesByNode.has(uuid)) {
      const existing = this.seriesByNode.get(uuid)!;
      const preview = computeSparklinePreview(existing, 16);
      return {
        ...rest,
        series_count: existing.length,
        sparkline_preview: preview ?? rest.sparkline_preview,
      };
    }
    return rest;
  }

  private loadInitialState() {
    this.nodes = new Map();
    this.edges = new Map();
    this.seriesByNode = new Map();
    this.multiScaleSeriesByNode = new Map();
    this.forecasts = new Map();
    this.activity = [];

    const primaryPaths = this.getPersistencePaths();
    if (!primaryPaths) return;

    let readPaths = primaryPaths;
    let shouldMigrateLegacy = false;
    if (!fs.existsSync(primaryPaths.stateFile)) {
      const legacyPaths = this.getPersistencePaths(LEGACY_CACHE_DIR);
      if (
        this.persistDir === DEFAULT_DATA_DIR &&
        legacyPaths &&
        fs.existsSync(legacyPaths.stateFile)
      ) {
        readPaths = legacyPaths;
        shouldMigrateLegacy = true;
      }
    }

    if (!fs.existsSync(readPaths.stateFile)) {
      return;
    }

    this.loadingState = true;
    try {
      if (fs.existsSync(readPaths.forecastsFile)) {
        try {
          const rawForecasts = fs.readFileSync(readPaths.forecastsFile, "utf8");
          const parsedForecasts = JSON.parse(rawForecasts) as ProspectiveForecastRecord[];
          if (Array.isArray(parsedForecasts)) {
            this.forecasts = new Map(
              parsedForecasts
                .filter((f) => f && typeof f.id === "string")
                .map((f) => [f.id, f])
            );
          }
        } catch {
          this.forecasts = new Map();
        }
      }

      if (fs.existsSync(readPaths.seriesFile)) {
        try {
          const rawSeries = fs.readFileSync(readPaths.seriesFile, "utf8");
          const parsedSeries = JSON.parse(rawSeries) as Record<string, TimeSeriesPoint[]>;
          if (parsedSeries && typeof parsedSeries === "object") {
            this.seriesByNode = new Map(
              Object.entries(parsedSeries).filter(([, v]) => Array.isArray(v) && v.length > 0)
            );
          }
        } catch {
          this.seriesByNode = new Map();
        }
      }

      if (fs.existsSync(readPaths.multiscaleFile)) {
        try {
          const rawMs = fs.readFileSync(readPaths.multiscaleFile, "utf8");
          const parsedMs = JSON.parse(rawMs) as Record<
            string,
            Partial<Record<TemporalBucket, TimeSeriesPoint[]>>
          >;
          if (parsedMs && typeof parsedMs === "object") {
            const cleaned = new Map<
              string,
              Partial<Record<TemporalBucket, TimeSeriesPoint[]>>
            >();
            for (const [uuid, scalesObj] of Object.entries(parsedMs)) {
              if (!scalesObj || typeof scalesObj !== "object" || FORBIDDEN_PATH_SEGMENTS.has(uuid)) {
                continue;
              }
              const entry: Partial<Record<TemporalBucket, TimeSeriesPoint[]>> = {};
              for (const bucket of ["day", "month", "year"] as const) {
                const arr = scalesObj[bucket];
                if (Array.isArray(arr) && arr.length > 0) {
                  entry[bucket] = arr;
                }
              }
              if (Object.keys(entry).length > 0) {
                cleaned.set(uuid, entry);
              }
            }
            this.multiScaleSeriesByNode = cleaned;
          }
        } catch {
          this.multiScaleSeriesByNode = new Map();
        }
      }

      const raw = fs.readFileSync(readPaths.stateFile, "utf8");
      const parsed = JSON.parse(raw) as {
        nodes?: ETGNode[];
        edges?: ETGEdge[];
        activity?: EtgActivityEntry[];
      };
      if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        let migratedLegacySeries = false;
        this.nodes = new Map(
          parsed.nodes.map((n) => {
            if (Array.isArray(n.properties?.series) && n.properties.series.length > 0) {
              migratedLegacySeries = true;
            }
            return [
              n.uuid,
              {
                ...n,
                properties: this.offloadNodeSeries(n.uuid, n.properties),
              },
            ];
          })
        );
        this.edges = new Map(parsed.edges.map((e) => [e.properties.uuid, e]));
        this.activity = Array.isArray(parsed.activity) ? parsed.activity.slice(0, 40) : [];
        if (migratedLegacySeries || shouldMigrateLegacy) {
          this.persistState();
        }
        return;
      }
    } catch {
      this.nodes = new Map();
      this.edges = new Map();
      this.seriesByNode = new Map();
      this.multiScaleSeriesByNode = new Map();
      this.forecasts = new Map();
      this.activity = [];
    } finally {
      this.loadingState = false;
    }
  }

  private persistState() {
    const paths = this.getPersistencePaths();
    if (!paths) return;
    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      const tmpPath = `${paths.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({
          nodes: Array.from(this.nodes.values()),
          edges: Array.from(this.edges.values()),
          activity: this.activity.slice(0, 40),
        }),
        "utf8"
      );
      fs.renameSync(tmpPath, paths.stateFile);

      if (this.seriesByNode.size > 0) {
        const seriesTmpPath = `${paths.seriesFile}.${process.pid}.tmp`;
        fs.writeFileSync(
          seriesTmpPath,
          JSON.stringify(Object.fromEntries(this.seriesByNode.entries())),
          "utf8"
        );
        fs.renameSync(seriesTmpPath, paths.seriesFile);
      } else if (fs.existsSync(paths.seriesFile)) {
        fs.unlinkSync(paths.seriesFile);
      }

      if (this.multiScaleSeriesByNode.size > 0) {
        const msTmpPath = `${paths.multiscaleFile}.${process.pid}.tmp`;
        fs.writeFileSync(
          msTmpPath,
          JSON.stringify(Object.fromEntries(this.multiScaleSeriesByNode.entries())),
          "utf8"
        );
        fs.renameSync(msTmpPath, paths.multiscaleFile);
      } else if (fs.existsSync(paths.multiscaleFile)) {
        fs.unlinkSync(paths.multiscaleFile);
      }

      if (this.forecasts.size > 0) {
        const forecastTmpPath = `${paths.forecastsFile}.${process.pid}.tmp`;
        fs.writeFileSync(
          forecastTmpPath,
          JSON.stringify(Array.from(this.forecasts.values())),
          "utf8"
        );
        fs.renameSync(forecastTmpPath, paths.forecastsFile);
      } else if (fs.existsSync(paths.forecastsFile)) {
        fs.unlinkSync(paths.forecastsFile);
      }
    } catch {
      // Non-fatal in read-only filesystems
    }
  }

  private pushActivity(entry: Omit<EtgActivityEntry, "id" | "timestamp">): EtgActivityEntry {
    const full: EtgActivityEntry = {
      id: `act-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.activity = [full, ...this.activity].slice(0, 40);
    return full;
  }

  private emitUpdate(activity?: EtgActivityEntry) {
    this.persistState();
    const snapshotStats = this.computeStats();
    for (const listener of this.listeners) {
      try {
        listener({ type: "graph_updated", activity, snapshotStats });
      } catch {
        // Ignore disconnected listeners
      }
    }
  }

  subscribe(listener: EtgListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearGraph(notify = true): EtgGraphSnapshot {
    this.nodes = new Map();
    this.edges = new Map();
    this.seriesByNode = new Map();
    this.multiScaleSeriesByNode = new Map();
    this.forecasts = new Map();
    this.activity = [];
    const paths = this.getPersistencePaths();
    if (paths) {
      try {
        if (fs.existsSync(paths.stateFile)) fs.unlinkSync(paths.stateFile);
        if (fs.existsSync(paths.seriesFile)) fs.unlinkSync(paths.seriesFile);
        if (fs.existsSync(paths.multiscaleFile)) fs.unlinkSync(paths.multiscaleFile);
        if (fs.existsSync(paths.forecastsFile)) fs.unlinkSync(paths.forecastsFile);
      } catch {
        // Ignore cleanup errors
      }
    }
    if (notify) {
      const act = this.pushActivity({
        kind: "discovery",
        summary: "Cleared Earth Trend Graph to 0 nodes (empty unseeded state).",
      });
      this.emitUpdate(act);
    }
    return this.getSnapshot();
  }

  ensureGovernanceRules(): { mkRule: ETGNode; corrRule: ETGNode } {
    const now = new Date().toISOString();
    let mkRule = this.nodes.get("rule-mann-kendall");
    if (!mkRule) {
      mkRule = {
        uuid: "rule-mann-kendall",
        label: "Rule",
        is_provisional: false,
        properties: {
          name: "Mann-Kendall Trend Significance Gate (p < 0.05)",
          concept_name: "Mann-Kendall Significance Gate",
          description:
            "Mathematical gate verifying that monotonic time-series slopes via Theil-Sen exceed natural variability using two-sided Mann-Kendall (α = 0.05).",
          status: "Active",
          importance: 9,
          producer_type: "ai_synthesis",
          confidence: 0.99,
          created_at: now,
          observed_at: now,
        },
      };
      this.nodes.set(mkRule.uuid, mkRule);
    }

    let corrRule = this.nodes.get("rule-corroboration");
    if (!corrRule) {
      corrRule = {
        uuid: "rule-corroboration",
        label: "Rule",
        is_provisional: false,
        properties: {
          name: "Multi-Source Corroboration Gate (≥2 Sources)",
          concept_name: "Multi-Source Corroboration Gate",
          description:
            "Scientific epistemology gate requiring at least two independent observational instruments or datasets before promoting a trend Insight to Corroborated.",
          status: "Active",
          importance: 9,
          producer_type: "ai_synthesis",
          confidence: 0.99,
          created_at: now,
          observed_at: now,
        },
      };
      this.nodes.set(corrRule.uuid, corrRule);
    }

    return { mkRule, corrRule };
  }

  recordActivity(entry: Omit<EtgActivityEntry, "id" | "timestamp">): EtgGraphSnapshot {
    const act = this.pushActivity(entry);
    this.emitUpdate(act);
    return this.getSnapshot();
  }

  private computeStats(): EtgGraphSnapshot["stats"] {
    const allNodes = Array.from(this.nodes.values());
    const allEdges = Array.from(this.edges.values());
    const oppositeCount = allEdges.filter((e) => e.type === "drives_opposite").length;
    return {
      totalNodes: allNodes.length,
      totalEdges: allEdges.length,
      corroboratedTrends: allNodes.filter(
        (n) => n.label === "Insight" && !n.is_provisional && n.properties.status !== "Superseded"
      ).length,
      provisionalCount: allNodes.filter((n) => Boolean(n.is_provisional)).length,
      supersededCount: allNodes.filter((n) => n.properties.status === "Superseded").length,
      oppositeTrendPairsCount: oppositeCount,
    };
  }

  getNode(uuid: string): ETGNode | undefined {
    return this.nodes.get(uuid);
  }

  getNodeSeries(uuid: string): TimeSeriesPoint[] | undefined {
    return this.seriesByNode.get(uuid) ?? this.nodes.get(uuid)?.properties.series;
  }

  getNodeWithSeries(uuid: string): (ETGNode & { series?: TimeSeriesPoint[] }) | undefined {
    const node = this.nodes.get(uuid);
    if (!node) return undefined;
    return {
      ...node,
      series: this.getNodeSeries(uuid),
    };
  }

  setNodeMultiScaleSeries(
    uuid: string,
    scale: TemporalBucket,
    series: readonly TimeSeriesPoint[],
    silent = false
  ): boolean {
    const node = this.nodes.get(uuid);
    if (!node) return false;
    const valid = series
      .filter(
        (pt) =>
          pt &&
          typeof pt.date === "string" &&
          Number.isFinite(pt.value) &&
          Number.isFinite(pt.t)
      )
      .sort((a, b) => a.t - b.t || a.date.localeCompare(b.date));
    if (valid.length === 0) return false;

    const existingScales = this.multiScaleSeriesByNode.get(uuid) ?? {};
    const prevArr = existingScales[scale] ?? [];
    const merged = mergeSeriesPoints(prevArr, valid, scale === "day" ? 4000 : 1200);
    existingScales[scale] = merged;
    this.multiScaleSeriesByNode.set(uuid, existingScales);

    const availableScales = new Set<"day" | "month" | "year">(
      node.properties.available_scales ?? []
    );
    availableScales.add(scale);

    const channelSet = new Set<string>(node.properties.channel_names ?? []);
    for (let i = 0; i < Math.min(merged.length, 16); i++) {
      const ch = merged[i].channels;
      if (ch) {
        for (const k of Object.keys(ch)) channelSet.add(k);
      }
    }

    node.properties = {
      ...node.properties,
      available_scales: Array.from(availableScales),
      ...(channelSet.size > 0 ? { channel_names: Array.from(channelSet) } : {}),
    };

    if (!this.seriesByNode.has(uuid)) {
      this.seriesByNode.set(uuid, merged);
      node.properties = {
        ...node.properties,
        series_count: merged.length,
        sparkline_preview: computeSparklinePreview(merged, 16) ?? node.properties.sparkline_preview,
      };
    }

    if (!silent) {
      this.persistState();
    }
    return true;
  }

  getNodeMultiScaleSeries(
    uuid: string,
    requestedScale?: TemporalBucket
  ): TimeSeriesPoint[] | undefined {
    const node = this.nodes.get(uuid);
    if (!node) return undefined;
    const primary = this.getNodeSeries(uuid);
    const msEntry = this.multiScaleSeriesByNode.get(uuid);

    if (!requestedScale) {
      if (primary && primary.length > 0) return primary;
      return msEntry?.month ?? msEntry?.year ?? msEntry?.day;
    }

    const exact = msEntry?.[requestedScale];
    if (exact && exact.length > 0) return exact;

    const sortByT = (pts: TimeSeriesPoint[]) =>
      pts.sort((a, b) => a.t - b.t || a.date.localeCompare(b.date));

    if (primary && primary.length > 0) {
      const primaryBucket = inferSeriesBucket(primary);
      if (primaryBucket === requestedScale) return primary;
      if (
        (primaryBucket === "day" && (requestedScale === "month" || requestedScale === "year")) ||
        (primaryBucket === "month" && requestedScale === "year")
      ) {
        return sortByT(Array.from(aggregateSeriesByBucket(primary, requestedScale).values()));
      }
    }

    const finerCandidates: TemporalBucket[] =
      requestedScale === "year"
        ? ["month", "day"]
        : requestedScale === "month"
        ? ["day"]
        : [];
    for (const finer of finerCandidates) {
      const finerSeries = msEntry?.[finer];
      if (finerSeries && finerSeries.length > 0) {
        return sortByT(
          Array.from(aggregateSeriesByBucket(finerSeries, requestedScale).values())
        );
      }
    }

    return undefined;
  }

  computeNodeTrustScore(node: ETGNode): number {
    return computeEtgNodeTrustScore(node);
  }

  assembleRegionalContextSubgraph(options: {
    targetUuid?: string;
    lat?: number;
    lng?: number;
    dataset?: ETGDatasetId;
    radiusKm?: number;
    maxHops?: number;
    includeGlobalModes?: boolean;
  }): {
    targetNode?: ETGNode;
    nodes: ETGNode[];
    edges: ETGEdge[];
    scalesUsed: Array<"day" | "month" | "year" | "impulse">;
    distancesByUuid: Record<string, number>;
  } {
    const radiusKm = Math.max(100, Math.min(8000, options.radiusKm ?? 1800));
    let targetNode = options.targetUuid ? this.nodes.get(options.targetUuid) : undefined;
    if (targetNode?.properties.status === "Superseded") {
      targetNode = undefined;
    }

    const anchorLat = options.lat ?? targetNode?.properties.lat;
    const anchorLng = options.lng ?? targetNode?.properties.lng;

    if (!targetNode && anchorLat !== undefined && anchorLng !== undefined) {
      let bestDist = Infinity;
      for (const n of this.nodes.values()) {
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
      for (const n of this.nodes.values()) {
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
      const trav = this.traverseSubgraph({
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
      for (const n of this.nodes.values()) {
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
    const edges = Array.from(this.edges.values()).filter(
      (e) =>
        nodeMap.has(e.source_uuid) &&
        nodeMap.has(e.target_uuid) &&
        !e.properties.superseded_at
    );

    const scalesSet = new Set<"day" | "month" | "year" | "impulse">();
    for (const n of nodes) {
      const s = this.getNodeSeries(n.uuid);
      scalesSet.add(inferNodeTemporalScale(n, s));
      for (const av of n.properties.available_scales ?? []) {
        scalesSet.add(av);
      }
      const ms = this.multiScaleSeriesByNode.get(n.uuid);
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

  getOppositeTrendPairs(nodeSubset?: Set<string>): OppositeTrendPair[] {
    const pairs: OppositeTrendPair[] = [];
    for (const edge of this.edges.values()) {
      if (edge.type !== "drives_opposite") continue;
      if (nodeSubset && (!nodeSubset.has(edge.source_uuid) || !nodeSubset.has(edge.target_uuid))) {
        continue;
      }
      const source = this.nodes.get(edge.source_uuid);
      const target = this.nodes.get(edge.target_uuid);
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

  getSnapshot(): EtgGraphSnapshot {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      oppositeTrendPairs: this.getOppositeTrendPairs(),
      activity: this.activity,
      stats: this.computeStats(),
    };
  }

  queryGraph(filter: EtgQueryFilter = {}): EtgGraphSnapshot {
    const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
    const untilMs = filter.until ? Date.parse(filter.until) : NaN;
    const searchLower = filter.search?.trim().toLowerCase() || "";
    const includeSuperseded = filter.includeSuperseded ?? true;

    let filteredNodes = Array.from(this.nodes.values()).filter((node) => {
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
      for (const e of this.edges.values()) {
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
    const filteredEdges = Array.from(this.edges.values()).filter(
      (e) => nodeSet.has(e.source_uuid) && nodeSet.has(e.target_uuid)
    );

    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      oppositeTrendPairs: this.getOppositeTrendPairs(nodeSet),
      activity: this.activity,
      stats: this.computeStats(),
    };
  }

  createNode(input: {
    uuid?: string;
    label: string;
    is_provisional?: boolean;
    properties: Partial<ETGNode["properties"]> & { name: string; description: string };
    silent?: boolean;
  }): ETGNode {
    const validLabel = assertValidEtgLabel(input.label);
    const uuid =
      input.uuid?.trim() ||
      `${validLabel.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const isProvisional = input.is_provisional ?? (validLabel === "Signal" ? false : true);

    const authoredBy = resolveDefaultAuthor(input.properties);
    const node: ETGNode = {
      uuid,
      label: validLabel,
      is_provisional: isProvisional,
      properties: this.offloadNodeSeries(uuid, {
        ...input.properties,
        name: input.properties.name.trim(),
        concept_name: input.properties.concept_name || input.properties.name.trim(),
        description: input.properties.description.trim(),
        authored_by: authoredBy,
        status:
          input.properties.status ??
          (isProvisional ? "Provisional" : "Active"),
        importance: input.properties.importance ?? (validLabel === "Insight" ? 8 : 6),
        observed_at: input.properties.observed_at || now,
        created_at: input.properties.created_at || now,
      }),
    };

    this.nodes.set(node.uuid, node);
    if (!input.silent) {
      const act = this.pushActivity({
        kind: "probe",
        nodeUuid: node.uuid,
        summary: `Recorded ${node.label} "${node.properties.name}"`,
      });
      this.emitUpdate(act);
    }
    return node;
  }

  updateNode(
    uuid: string,
    patch: Partial<ETGNode["properties"]> & { label?: string; is_provisional?: boolean },
    silent = false
  ): ETGNode | null {
    const existing = this.nodes.get(uuid);
    if (!existing) return null;

    const nextLabel = patch.label ? assertValidEtgLabel(patch.label) : existing.label;
    const { label: _lbl, is_provisional: provPatch, ...propPatch } = patch;
    const rawRegionPatch = (propPatch as { region?: string | null }).region;
    const resolvedRegion =
      rawRegionPatch === null || (typeof rawRegionPatch === "string" && rawRegionPatch.trim() === "")
        ? undefined
        : typeof rawRegionPatch === "string"
          ? rawRegionPatch.trim()
          : existing.properties.region;

    const mergedProps: ETGNode["properties"] = this.offloadNodeSeries(uuid, {
      ...existing.properties,
      ...propPatch,
      region: resolvedRegion,
      name:
        typeof propPatch.name === "string" && propPatch.name.trim()
          ? propPatch.name.trim()
          : existing.properties.name,
      concept_name:
        typeof propPatch.name === "string" && propPatch.name.trim()
          ? propPatch.name.trim()
          : existing.properties.concept_name,
      description:
        typeof propPatch.description === "string"
          ? propPatch.description.trim()
          : existing.properties.description,
    });

    const updated: ETGNode = {
      uuid,
      label: nextLabel,
      is_provisional: provPatch ?? existing.is_provisional,
      properties: mergedProps,
    };
    this.nodes.set(uuid, updated);

    if (!silent) {
      const act = this.pushActivity({
        kind: "revision",
        nodeUuid: uuid,
        summary: `Updated ${updated.label} "${updated.properties.name}"`,
      });
      this.emitUpdate(act);
    }
    return updated;
  }

  deleteNode(uuid: string, silent = false): boolean {
    const existing = this.nodes.get(uuid);
    if (!existing) return false;

    this.nodes.delete(uuid);
    this.seriesByNode.delete(uuid);
    this.multiScaleSeriesByNode.delete(uuid);
    let removedEdges = 0;
    for (const [eid, edge] of this.edges.entries()) {
      if (edge.source_uuid === uuid || edge.target_uuid === uuid) {
        this.edges.delete(eid);
        removedEdges++;
      }
    }

    if (!silent) {
      const act = this.pushActivity({
        kind: "revision",
        summary: `Removed ${existing.label} "${existing.properties.name}" and ${removedEdges} incident link(s)`,
      });
      this.emitUpdate(act);
    }
    return true;
  }

  createEdge(input: {
    uuid?: string;
    source_uuid: string;
    target_uuid: string;
    type: ETGRelationshipType;
    source_snippet?: string;
    rationale?: string;
    is_provisional?: boolean;
    correlation_r?: number;
    detrended_r?: number;
    lag_days?: number;
    optimal_lag_steps?: number;
    lag_unit?: "months" | "years" | "days";
    mechanism?: string;
    amplification_ratio?: number;
    shared_shift_year?: number;
    weight?: number;
    authored_by?: ETGAuthorType;
    causal_polarity?: ETGEdgeProperties["causal_polarity"];
    custom_label?: string;
    cross_scale?: boolean;
    autoEnrichSeries?: boolean;
    silent?: boolean;
  }): ETGEdge {
    const srcNode = this.nodes.get(input.source_uuid);
    if (!srcNode) {
      throw new Error(`Source ETG node "${input.source_uuid}" not found.`);
    }
    const dstNode = this.nodes.get(input.target_uuid);
    if (!dstNode) {
      throw new Error(`Target ETG node "${input.target_uuid}" not found.`);
    }

    let corrR = input.correlation_r;
    let detR = input.detrended_r;
    let optLag = input.optimal_lag_steps;
    let lagUnit = input.lag_unit;
    let mechanism = input.mechanism;

    if (input.autoEnrichSeries !== false && corrR === undefined) {
      const seriesA = this.getNodeSeries(srcNode.uuid);
      const seriesB = this.getNodeSeries(dstNode.uuid);
      if (seriesA && seriesB && seriesA.length >= 6 && seriesB.length >= 6) {
        const aligned = alignCompatibleSeries(seriesA, seriesB);
        if (aligned) {
          const comp = compareRegionalSeries(aligned.alignedA, aligned.alignedB, {
            latA: srcNode.properties.lat,
            lngA: srcNode.properties.lng,
            datasetA: srcNode.properties.dataset,
            latB: dstNode.properties.lat,
            lngB: dstNode.properties.lng,
            datasetB: dstNode.properties.dataset,
          });
          corrR = comp.pearsonR;
          detR = comp.detrendedR;
          if (optLag === undefined) optLag = comp.optimalLagSteps;
          if (!lagUnit) lagUnit = comp.lagUnit;
          if (!mechanism) mechanism = comp.mechanism;
        }
      }
    }

    const derivedWeight =
      typeof input.weight === "number" && Number.isFinite(input.weight)
        ? Math.max(0.05, Math.min(1, input.weight))
        : corrR !== undefined && Number.isFinite(corrR)
          ? Math.max(0.25, Math.min(1, Math.abs(corrR)))
          : 0.72;

    const polarity: ETGEdgeProperties["causal_polarity"] =
      input.causal_polarity ??
      (input.type === "drives_opposite" || input.type === "dampens"
        ? "negative"
        : corrR !== undefined && corrR < -0.2
          ? "negative"
          : "positive");

    const uuid = input.uuid?.trim() || `edge-${crypto.randomUUID().slice(0, 8)}`;
    const edge: ETGEdge = {
      source_uuid: input.source_uuid,
      target_uuid: input.target_uuid,
      type: input.type,
      properties: {
        uuid,
        is_provisional: input.is_provisional ?? false,
        source_snippet: input.source_snippet || input.custom_label || input.type,
        rationale: input.rationale,
        correlation_r: corrR,
        detrended_r: detR,
        lag_days: input.lag_days,
        optimal_lag_steps: optLag,
        lag_unit: lagUnit,
        mechanism,
        amplification_ratio: input.amplification_ratio,
        shared_shift_year: input.shared_shift_year,
        weight: Number(derivedWeight.toFixed(3)),
        authored_by: input.authored_by ?? "human",
        causal_polarity: polarity,
        custom_label: input.custom_label,
        ...(input.cross_scale !== undefined ? { cross_scale: input.cross_scale } : {}),
        created_at: new Date().toISOString(),
      },
    };

    this.edges.set(uuid, edge);

    if (input.type === "supports" || input.type === "corroborates") {
      this.evaluateCorroboration(input.target_uuid, false);
    }

    if (!input.silent) {
      const act = this.pushActivity({
        kind: "corroboration",
        nodeUuid: input.target_uuid,
        summary: `Linked "${srcNode.properties.name}" —[${input.custom_label || input.type}]→ "${dstNode.properties.name}"`,
      });
      this.emitUpdate(act);
    }
    return edge;
  }

  updateEdge(
    edgeUuid: string,
    patch: Partial<ETGEdgeProperties> & {
      type?: ETGRelationshipType;
      source_uuid?: string;
      target_uuid?: string;
    },
    silent = false
  ): ETGEdge | null {
    const existing = this.edges.get(edgeUuid);
    if (!existing) return null;

    const nextSource = patch.source_uuid ?? existing.source_uuid;
    const nextTarget = patch.target_uuid ?? existing.target_uuid;
    if (!this.nodes.has(nextSource) || !this.nodes.has(nextTarget)) {
      throw new Error("Updated edge endpoint node not found.");
    }

    const { type: typePatch, source_uuid: _s, target_uuid: _t, ...propPatch } = patch;
    const updated: ETGEdge = {
      source_uuid: nextSource,
      target_uuid: nextTarget,
      type: typePatch ?? existing.type,
      properties: {
        ...existing.properties,
        ...propPatch,
        uuid: edgeUuid,
      },
    };
    this.edges.set(edgeUuid, updated);

    if (!silent) {
      const act = this.pushActivity({
        kind: "corroboration",
        nodeUuid: updated.target_uuid,
        summary: `Updated connection ${edgeUuid} (${updated.type})`,
      });
      this.emitUpdate(act);
    }
    return updated;
  }

  deleteEdge(edgeUuid: string, silent = false): boolean {
    const existing = this.edges.get(edgeUuid);
    if (!existing) return false;
    this.edges.delete(edgeUuid);
    if (!silent) {
      const act = this.pushActivity({
        kind: "revision",
        nodeUuid: existing.target_uuid,
        summary: `Unlinked edge ${edgeUuid} (${existing.type})`,
      });
      this.emitUpdate(act);
    }
    return true;
  }

  unlinkNodes(
    sourceUuid: string,
    targetUuid: string,
    type?: ETGRelationshipType,
    silent = false
  ): number {
    let removed = 0;
    for (const [eid, edge] of this.edges.entries()) {
      const matchesPair =
        (edge.source_uuid === sourceUuid && edge.target_uuid === targetUuid) ||
        (edge.source_uuid === targetUuid && edge.target_uuid === sourceUuid);
      if (!matchesPair) continue;
      if (type && edge.type !== type) continue;
      this.edges.delete(eid);
      removed++;
    }
    if (removed > 0 && !silent) {
      const act = this.pushActivity({
        kind: "revision",
        summary: `Removed ${removed} link(s) between ${sourceUuid} and ${targetUuid}`,
      });
      this.emitUpdate(act);
    }
    return removed;
  }

  evaluateCorroboration(nodeUuid: string, emit = true): CorroborationAudit {
    const node = this.nodes.get(nodeUuid);
    if (!node) {
      throw new Error(`Node "${nodeUuid}" not found.`);
    }

    this.ensureGovernanceRules();

    const supportingSources: CorroborationAudit["supportingSources"] = [];
    const producerSet = new Set<ETGProducerType>();
    const sourceSystemSet = new Set<string>();

    for (const edge of this.edges.values()) {
      if (
        edge.target_uuid === nodeUuid &&
        (edge.type === "supports" || edge.type === "corroborates")
      ) {
        const src = this.nodes.get(edge.source_uuid);
        if (!src) continue;
        const pType = inferProducerType(src);
        producerSet.add(pType);
        sourceSystemSet.add(
          String(
            src.properties.source_system ||
              `${pType}:${src.properties.dataset || src.uuid}`
          )
        );
        supportingSources.push({
          uuid: src.uuid,
          name: src.properties.name,
          label: src.label,
          producerType: pType,
        });
      }
    }

    const distinctProducerTypes = Array.from(producerSet);
    const corroborated =
      supportingSources.length >= 2 &&
      (sourceSystemSet.size >= 2 || distinctProducerTypes.length >= 2);

    if (corroborated && (node.is_provisional || node.properties.status === "Provisional")) {
      node.is_provisional = false;
      node.properties.status = "Active";
      node.properties.confidence = Math.max(node.properties.confidence ?? 0.85, 0.9);
      this.nodes.set(node.uuid, node);

      // Attach rule-corroboration verified_by edge if absent
      const hasRuleEdge = Array.from(this.edges.values()).some(
        (e) =>
          e.source_uuid === "rule-corroboration" &&
          e.target_uuid === nodeUuid &&
          e.type === "verified_by"
      );
      if (!hasRuleEdge && this.nodes.has("rule-corroboration")) {
        const ruleEdgeId = `edge-rule-${nodeUuid}`;
        this.edges.set(ruleEdgeId, {
          source_uuid: "rule-corroboration",
          target_uuid: nodeUuid,
          type: "verified_by",
          properties: {
            uuid: ruleEdgeId,
            is_provisional: false,
            source_snippet: `${supportingSources.length} independent sources (${distinctProducerTypes.join(", ")})`,
            rationale: "Automatically promoted after satisfying multi-source corroboration gate.",
            created_at: new Date().toISOString(),
          },
        });
      }

      if (emit) {
        const act = this.pushActivity({
          kind: "corroboration",
          nodeUuid,
          summary: `Corroborated "${node.properties.name}" via ${supportingSources.length} independent sources.`,
        });
        this.emitUpdate(act);
      }
    }

    return {
      nodeUuid,
      supportingSources,
      distinctProducerTypes,
      corroborated: corroborated || (!node.is_provisional && node.label === "Insight"),
      requiredSources: 2,
      gateRuleUuid: "rule-corroboration",
    };
  }

  /**
   * Epistemic Belief Revision: creates a revised Insight/Signal and links it to the
   * prior hypothesis via a `supersedes` edge, marking the prior node as `Superseded`.
   */
  reviseBelief(params: {
    priorNodeUuid: string;
    newName: string;
    newDescription: string;
    rationale: string;
    label?: ETGNodeLabel;
    dataset?: ETGDatasetId;
    confidence?: number;
    p_value?: number;
    theil_sen_slope?: number;
    series?: ETGNode["properties"]["series"];
    observed_at?: string;
    silent?: boolean;
  }): {
    priorNode: ETGNode;
    revisedNode: ETGNode;
    supersedesEdge: ETGEdge;
    lineage: ETGNode[];
  } {
    const prior = this.nodes.get(params.priorNodeUuid);
    if (!prior) {
      throw new Error(`Prior node "${params.priorNodeUuid}" not found.`);
    }

    const revisedLabel = assertValidEtgLabel(params.label || prior.label);
    const now = new Date().toISOString();
    const revisedUuid = `revised-${crypto.randomUUID().slice(0, 8)}`;

    const revisedNode: ETGNode = {
      uuid: revisedUuid,
      label: revisedLabel,
      is_provisional: false,
      properties: this.offloadNodeSeries(revisedUuid, {
        ...prior.properties,
        name: params.newName.trim(),
        concept_name: params.newName.trim(),
        description: params.newDescription.trim(),
        status: "Active",
        superseded_by: undefined,
        dataset: params.dataset || prior.properties.dataset,
        confidence: params.confidence ?? 0.94,
        p_value: params.p_value ?? prior.properties.p_value,
        theil_sen_slope: params.theil_sen_slope ?? prior.properties.theil_sen_slope,
        series: params.series ?? this.getNodeSeries(prior.uuid),
        observed_at: params.observed_at ?? now,
        created_at: now,
      }),
    };

    prior.is_provisional = false;
    prior.properties.status = "Superseded";
    prior.properties.superseded_by = revisedUuid;

    const edgeUuid = `edge-supersedes-${crypto.randomUUID().slice(0, 8)}`;
    const supersedesEdge: ETGEdge = {
      source_uuid: revisedUuid,
      target_uuid: prior.uuid,
      type: "supersedes",
      properties: {
        uuid: edgeUuid,
        is_provisional: false,
        source_snippet: "Epistemic belief revision",
        rationale: params.rationale.trim(),
        created_at: now,
      },
    };

    this.nodes.set(prior.uuid, prior);
    this.nodes.set(revisedNode.uuid, revisedNode);
    this.edges.set(edgeUuid, supersedesEdge);

    // Carry forward active incoming/outgoing corroboration and causal links so the revised
    // conclusion remains connected in the graph when Superseded nodes are hidden.
    for (const existingEdge of Array.from(this.edges.values())) {
      if (
        existingEdge.type === "supersedes" ||
        existingEdge.type === "verified_by" ||
        existingEdge.properties.superseded_at
      ) {
        continue;
      }
      if (existingEdge.target_uuid === prior.uuid && existingEdge.source_uuid !== revisedUuid) {
        const peer = this.nodes.get(existingEdge.source_uuid);
        if (
          peer &&
          peer.properties.status !== "Superseded" &&
          !this.hasEdgeBetween(peer.uuid, revisedUuid, true, new Set([existingEdge.type]))
        ) {
          const carriedUuid = `edge-rev-${crypto.randomUUID().slice(0, 8)}`;
          this.edges.set(carriedUuid, {
            source_uuid: peer.uuid,
            target_uuid: revisedUuid,
            type: existingEdge.type,
            properties: {
              ...existingEdge.properties,
              uuid: carriedUuid,
              created_at: now,
            },
          });
        }
      } else if (existingEdge.source_uuid === prior.uuid && existingEdge.target_uuid !== revisedUuid) {
        const peer = this.nodes.get(existingEdge.target_uuid);
        if (
          peer &&
          peer.properties.status !== "Superseded" &&
          !this.hasEdgeBetween(revisedUuid, peer.uuid, true, new Set([existingEdge.type]))
        ) {
          const carriedUuid = `edge-rev-${crypto.randomUUID().slice(0, 8)}`;
          this.edges.set(carriedUuid, {
            source_uuid: revisedUuid,
            target_uuid: peer.uuid,
            type: existingEdge.type,
            properties: {
              ...existingEdge.properties,
              uuid: carriedUuid,
              created_at: now,
            },
          });
        }
      }
    }
    this.evaluateCorroboration(revisedUuid, false);

    if (!params.silent) {
      const act = this.pushActivity({
        kind: "revision",
        nodeUuid: revisedNode.uuid,
        summary: `Belief Revision: "${revisedNode.properties.name}" supersedes "${prior.properties.name}"`,
      });
      this.emitUpdate(act);
    }

    return {
      priorNode: prior,
      revisedNode,
      supersedesEdge,
      lineage: this.getBeliefLineage(revisedNode.uuid),
    };
  }

  getBeliefLineage(nodeUuid: string): ETGNode[] {
    // Walk upstream to find newest node, then downstream along `supersedes`
    let head = nodeUuid;
    const guard = new Set<string>();
    while (!guard.has(head)) {
      guard.add(head);
      const newer = Array.from(this.edges.values()).find(
        (e) => e.type === "supersedes" && e.target_uuid === head
      );
      if (!newer) break;
      head = newer.source_uuid;
    }

    const chain: ETGNode[] = [];
    const seen = new Set<string>();
    let curr: string | undefined = head;
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const n = this.nodes.get(curr);
      if (n) chain.push(n);
      const older = Array.from(this.edges.values()).find(
        (e) => e.type === "supersedes" && e.source_uuid === curr
      );
      curr = older?.target_uuid;
    }
    return chain;
  }

  private hasEdgeBetween(
    uuidA: string,
    uuidB: string,
    directed = false,
    allowedTypes?: ReadonlySet<ETGRelationshipType>
  ): boolean {
    for (const e of this.edges.values()) {
      if (allowedTypes && !allowedTypes.has(e.type)) continue;
      if (e.source_uuid === uuidA && e.target_uuid === uuidB) return true;
      if (!directed && e.source_uuid === uuidB && e.target_uuid === uuidA) return true;
    }
    return false;
  }

  /**
   * Links a geo-pinned observation to nearby Insights (`corroborates`) and Signals (`relates_to`).
   */
  private linkNearbyNodes(
    sourceNode: ETGNode,
    radiusKm = 450
  ): {
    linkedInsights: ETGNode[];
    linkedSignals: ETGNode[];
    corroborationAudits: CorroborationAudit[];
  } {
    const linkedInsights: ETGNode[] = [];
    const linkedSignals: ETGNode[] = [];
    const corroborationAudits: CorroborationAudit[] = [];

    const srcLat = sourceNode.properties.lat;
    const srcLng = sourceNode.properties.lng;
    if (srcLat === undefined || srcLng === undefined || !Number.isFinite(srcLat) || !Number.isFinite(srcLng)) {
      return { linkedInsights, linkedSignals, corroborationAudits };
    }

    const now = new Date().toISOString();
    const nearbySignals: Array<{ candidate: ETGNode; dist: number }> = [];
    const srcDevice = sourceNode.properties.device_id;
    const supportEdgeTypes = new Set<ETGRelationshipType>(["supports", "corroborates"]);

    for (const candidate of this.nodes.values()) {
      if (candidate.uuid === sourceNode.uuid) continue;
      if (candidate.properties.status === "Superseded") continue;
      const cLat = candidate.properties.lat;
      const cLng = candidate.properties.lng;
      if (cLat === undefined || cLng === undefined || !Number.isFinite(cLat) || !Number.isFinite(cLng)) {
        continue;
      }

      const dist = haversineKm(srcLat, srcLng, cLat, cLng);
      if (dist > radiusKm) continue;

      if (candidate.label === "Insight") {
        if (!this.hasEdgeBetween(sourceNode.uuid, candidate.uuid, true, supportEdgeTypes)) {
          const edgeId = `edge-corr-${crypto.randomUUID().slice(0, 8)}`;
          const unitStr = sourceNode.properties.unit ? ` ${sourceNode.properties.unit}` : "";
          const valLabel =
            sourceNode.properties.value !== undefined
              ? `${sourceNode.properties.value}${unitStr}`
              : "telemetry";
          this.edges.set(edgeId, {
            source_uuid: sourceNode.uuid,
            target_uuid: candidate.uuid,
            type: "corroborates",
            properties: {
              uuid: edgeId,
              is_provisional: false,
              source_snippet: `${sourceNode.properties.device_id || sourceNode.properties.source_system || sourceNode.label} within ${Math.round(dist)} km`,
              rationale: `Observation "${sourceNode.properties.name}" (${valLabel}) corroborates nearby Earth trend within ${Math.round(dist)} km.`,
              created_at: now,
            },
          });
        }
        linkedInsights.push(candidate);
        corroborationAudits.push(this.evaluateCorroboration(candidate.uuid, false));
      } else if (candidate.label === "Signal") {
        if (srcDevice && candidate.properties.device_id === srcDevice) continue;
        nearbySignals.push({ candidate, dist });
      }
    }

    nearbySignals.sort((a, b) => a.dist - b.dist);
    for (const { candidate, dist } of nearbySignals.slice(0, 4)) {
      if (this.hasEdgeBetween(sourceNode.uuid, candidate.uuid, false)) continue;
      const edgeId = `edge-near-${crypto.randomUUID().slice(0, 8)}`;
      this.edges.set(edgeId, {
        source_uuid: sourceNode.uuid,
        target_uuid: candidate.uuid,
        type: "relates_to",
        properties: {
          uuid: edgeId,
          is_provisional: false,
          source_snippet: `Co-located Earth observation (${Math.round(dist)} km)`,
          rationale: `Spatial proximity (${Math.round(dist)} km) between active Earth observations.`,
          created_at: now,
        },
      });
      linkedSignals.push(candidate);
    }

    return { linkedInsights, linkedSignals, corroborationAudits };
  }

  /**
   * Runs Mann-Kendall / Theil-Sen on a node's accumulated series and discovers statistically
   * significant cross-region couplings (`drives_opposite`, `teleconnects`, `correlates_with`).
   */
  private discoverConnectionsForSeriesNode(anchorNode: ETGNode): {
    discoveredEdges: ETGEdge[];
  } {
    const discoveredEdges: ETGEdge[] = [];
    const series = this.getNodeSeries(anchorNode.uuid);
    const lat = anchorNode.properties.lat;
    const lng = anchorNode.properties.lng;
    if (!series || series.length < 5 || lat === undefined || lng === undefined) {
      return { discoveredEdges };
    }

    const dataset = anchorNode.properties.dataset || "community";
    const unit = anchorNode.properties.unit || "units";
    const slopeUnit = anchorNode.properties.slope_unit || `${unit}/yr`;
    const summary = analyzeTimeSeries(series, {
      lat,
      lng,
      dataset,
      parameter: anchorNode.properties.parameter || anchorNode.properties.name,
      unit,
      slopeUnit,
      provenance: anchorNode.properties.provenance_source || "Empirical Dataset (Imported)",
    });

    const updatedAnchor: ETGNode = {
      ...anchorNode,
      properties: {
        ...anchorNode.properties,
        p_value: summary.mannKendall.pValue,
        p_value_adjusted: summary.mannKendall.pValueAdjusted,
        theil_sen_slope: summary.theilSen.slope,
        slope_unit: slopeUnit,
        ols_r2: summary.ols.rSquared,
        regime_shift_year: summary.changePoint?.date ?? anchorNode.properties.regime_shift_year,
        series_count: series.length,
      },
    };
    this.nodes.set(anchorNode.uuid, updatedAnchor);

    // Deduplicate remote candidates by rounded coordinate + dataset, preferring Insight over Signal
    const dedupedCandidates = new Map<string, { node: ETGNode; distKm: number; series: TimeSeriesPoint[] }>();
    for (const other of this.nodes.values()) {
      if (other.uuid === anchorNode.uuid) continue;
      if (other.properties.status === "Superseded") continue;
      if (other.label !== "Insight" && other.label !== "Signal") continue;
      const oLat = other.properties.lat;
      const oLng = other.properties.lng;
      if (oLat === undefined || oLng === undefined || !Number.isFinite(oLat) || !Number.isFinite(oLng)) {
        continue;
      }

      const distKm = haversineKm(lat, lng, oLat, oLng);
      if (distKm < 800) continue;
      if (this.hasEdgeBetween(anchorNode.uuid, other.uuid, false)) continue;

      const otherSeries = this.getNodeSeries(other.uuid);
      if (!otherSeries || otherSeries.length < 5) continue;

      const siteKey = `${oLat.toFixed(1)}:${oLng.toFixed(1)}:${other.properties.dataset || "community"}`;
      const existing = dedupedCandidates.get(siteKey);
      if (!existing || (existing.node.label !== "Insight" && other.label === "Insight")) {
        dedupedCandidates.set(siteKey, { node: other, distKm, series: otherSeries });
      }
    }

    const rawScored: Array<{
      other: ETGNode;
      distKm: number;
      comp: ReturnType<typeof compareRegionalSeries>;
      effectiveR: number;
      rawP: number;
    }> = [];

    for (const cand of dedupedCandidates.values()) {
      const aligned = alignCompatibleSeries(series, cand.series);
      if (!aligned) continue;

      const comp = compareRegionalSeries(aligned.alignedA, aligned.alignedB, {
        latA: lat,
        lngA: lng,
        datasetA: dataset,
        latB: cand.node.properties.lat,
        lngB: cand.node.properties.lng,
        datasetB: cand.node.properties.dataset || "community",
      });

      const effectiveR =
        Math.abs(comp.detrendedR) >= Math.abs(comp.pearsonR) ? comp.detrendedR : comp.pearsonR;
      const rawP = comp.isSecularDriftOnly
        ? Math.min(comp.detrendedPValue, comp.optimalLagPValue)
        : Math.min(comp.pValue, comp.detrendedPValue, comp.optimalLagPValue);
      const significant = comp.pValue < 0.05 || comp.detrendedPValue < 0.05;
      if (significant && Math.abs(effectiveR) >= 0.45) {
        rawScored.push({ other: cand.node, distKm: cand.distKm, comp, effectiveR, rawP });
      }
    }

    const qValues = benjaminiHochbergAdjust(rawScored.map((s) => s.rawP));
    const scored = rawScored
      .map((item, idx) => ({ ...item, fdrQ: qValues[idx] ?? 1 }))
      .filter((item) => {
        if (!item.comp.isSecularDriftOnly) return rawScored.length <= 2 || item.fdrQ < 0.1;
        return rawScored.every((r) => r.comp.isSecularDriftOnly) && Math.abs(item.comp.pearsonR) >= 0.65;
      })
      .sort((a, b) => {
        const scoreA = itemCouplingPriority(a.comp, a.effectiveR);
        const scoreB = itemCouplingPriority(b.comp, b.effectiveR);
        return scoreB - scoreA;
      });
    function itemCouplingPriority(comp: ReturnType<typeof compareRegionalSeries>, effR: number): number {
      return (comp.isSecularDriftOnly ? -0.35 : 0) + Math.max(Math.abs(comp.detrendedR), Math.abs(comp.optimalLagR), Math.abs(effR));
    }
    const now = new Date().toISOString();

    for (const item of scored.slice(0, 4)) {
      const { other, distKm, comp } = item;
      const otherDataset = other.properties.dataset || "community";
      const otherSlope = other.properties.theil_sen_slope ?? comp.slopeB ?? 0;

      let edgeType: ETGRelationshipType = "correlates_with";
      if (
        (summary.theilSen.slope * otherSlope < 0 && comp.pearsonR <= -0.45) ||
        comp.detrendedR <= -0.5
      ) {
        edgeType = "drives_opposite";
      } else if (
        distKm >= 2500 &&
        (dataset === "ocean_temp" || otherDataset === "ocean_temp" || Math.abs(comp.optimalLagSteps) >= 1)
      ) {
        edgeType = "teleconnects";
      }

      const edgeId = `edge-auto-${edgeType}-${crypto.randomUUID().slice(0, 8)}`;
      const edge: ETGEdge = {
        source_uuid: anchorNode.uuid,
        target_uuid: other.uuid,
        type: edgeType,
        properties: {
          uuid: edgeId,
          is_provisional: false,
          correlation_r: comp.pearsonR,
          detrended_r: comp.detrendedR,
          optimal_lag_steps: comp.optimalLagSteps,
          lag_unit: comp.lagUnit,
          mechanism: comp.mechanism,
          amplification_ratio: comp.slopeRatio,
          shared_shift_year: comp.sharedRegimeShiftYear ?? undefined,
          source_snippet: `${edgeType} r=${comp.pearsonR.toFixed(2)} (detrended ${comp.detrendedR.toFixed(2)}, ${Math.round(distKm)} km)`,
          rationale: `Auto-discovered ${comp.couplingRegime} across ${Math.round(distKm)} km: ${updatedAnchor.properties.name} vs ${other.properties.name} (r=${comp.pearsonR.toFixed(2)}, detrended r=${comp.detrendedR.toFixed(2)}, lag=${comp.optimalLagSteps} ${comp.lagUnit}; ${comp.mechanism}).`,
          created_at: now,
        },
      };
      this.edges.set(edgeId, edge);
      discoveredEdges.push(edge);
    }

    return { discoveredEdges };
  }

  /**
   * Automatically wires local corroboration/proximity links and cross-region series connections for a node.
   */
  autoConnectNode(
    nodeUuid: string,
    emit = false
  ): {
    linkedInsights: ETGNode[];
    linkedSignals: ETGNode[];
    corroborationAudits: CorroborationAudit[];
    discoveredConnections: ETGEdge[];
  } {
    const node = this.nodes.get(nodeUuid);
    if (!node || node.properties.status === "Superseded") {
      return {
        linkedInsights: [],
        linkedSignals: [],
        corroborationAudits: [],
        discoveredConnections: [],
      };
    }

    const nearby = this.linkNearbyNodes(node, 450);
    const { discoveredEdges } = this.discoverConnectionsForSeriesNode(this.nodes.get(nodeUuid) ?? node);
    const totalAdded =
      nearby.linkedInsights.length + nearby.linkedSignals.length + discoveredEdges.length;

    if (totalAdded > 0) {
      if (emit) {
        const act = this.pushActivity({
          kind: "corroboration",
          nodeUuid,
          summary: `Auto-connected "${node.properties.name}": ${nearby.linkedInsights.length} trend link(s), ${nearby.linkedSignals.length} nearby event(s), ${discoveredEdges.length} global coupling(s).`,
        });
        this.emitUpdate(act);
      } else {
        this.persistState();
      }
    }

    return {
      linkedInsights: nearby.linkedInsights,
      linkedSignals: nearby.linkedSignals,
      corroborationAudits: nearby.corroborationAudits,
      discoveredConnections: discoveredEdges,
    };
  }

  /**
   * Hardware-Agnostic Node Webhook Ingestion & Live Event Updater.
   * Updates existing Signal events or hardware endpoints, accumulates a rolling time-series,
   * links nearby observations/trends, and discovers cross-region statistical connections.
   */
  ingestHardwareWebhook(
    nodeId: string,
    payload: Record<string, unknown>,
    queryParams: Record<string, string | undefined> = {}
  ): {
    hardwareNode: ETGNode;
    signalNode: ETGNode;
    linkedInsights: ETGNode[];
    linkedSignals: ETGNode[];
    corroborationAudits: CorroborationAudit[];
    discoveredConnections: ETGEdge[];
  } {
    const existingTarget = this.nodes.get(nodeId);
    const now = new Date().toISOString();

    const valuePath = queryParams.value_path;
    const rawValue =
      (valuePath ? extractValueByPath(payload, valuePath) : undefined) ??
      extractValueByPath(payload, "value") ??
      extractValueByPath(payload, "reading.value") ??
      extractValueByPath(payload, "metrics.pm25") ??
      extractValueByPath(payload, "data.value");

    const numericValue =
      typeof rawValue === "number" && Number.isFinite(rawValue)
        ? rawValue
        : typeof rawValue === "string" && rawValue.trim() !== "" && Number.isFinite(Number(rawValue))
          ? Number(rawValue)
          : undefined;

    const parseExplicitCoord = (raw: unknown, min: number, max: number, label: string): number | undefined => {
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw === "string" && raw.trim() === "") return undefined;
      const num =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Number(raw.trim())
            : NaN;
      if (!Number.isFinite(num) || num < min || num > max) {
        throw new Error(`Invalid webhook ${label}: must be a finite number within [${min}, ${max}].`);
      }
      return num;
    };

    const explicitLat = parseExplicitCoord(payload.lat ?? payload.latitude, -90, 90, "latitude");
    const explicitLng = parseExplicitCoord(payload.lng ?? payload.longitude, -180, 180, "longitude");
    const lat = explicitLat ?? existingTarget?.properties.lat;
    const lng = explicitLng ?? existingTarget?.properties.lng;
    const hasCoords =
      typeof lat === "number" &&
      typeof lng === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180;

    const dataset = (
      typeof payload.dataset === "string"
        ? payload.dataset
        : existingTarget?.properties.dataset || "community"
    ) as ETGDatasetId;

    const deviceId =
      (typeof payload.device_id === "string" && payload.device_id.trim()) ||
      existingTarget?.properties.device_id ||
      nodeId;

    const producerType = (
      typeof payload.producer_type === "string"
        ? payload.producer_type
        : existingTarget?.properties.producer_type ||
          (nodeId.includes("cam") ? "community_camera" : "iot_sensor")
    ) as ETGProducerType;

    const unit =
      (typeof payload.unit === "string" && payload.unit.trim()) ||
      existingTarget?.properties.unit ||
      "units";

    const observedAt =
      typeof payload.observed_at === "string" && !Number.isNaN(Date.parse(payload.observed_at))
        ? payload.observed_at
        : now;

    const confidence =
      typeof payload.confidence === "number" && payload.confidence >= 0 && payload.confidence <= 1
        ? payload.confidence
        : existingTarget?.properties.confidence ?? 0.88;

    const distinctSignal = payload.distinct_signal === true;
    const isUpdatingExistingSignal = existingTarget?.label === "Signal";
    const isTargetingInsight = existingTarget?.label === "Insight";

    const hardwareUuid = isUpdatingExistingSignal
      ? typeof payload.device_id === "string" && payload.device_id.trim()
        ? `sensor-${payload.device_id.trim()}`
        : `sensor-${nodeId.slice(0, 12)}`
      : isTargetingInsight
        ? `sensor-${deviceId}`
        : nodeId;

    const existingHardware = this.nodes.get(hardwareUuid);
    const hardwareName =
      (typeof payload.device_name === "string" && payload.device_name.trim()) ||
      existingHardware?.properties.name ||
      `Community Node (${deviceId})`;

    let hardwareNode: ETGNode = {
      uuid: hardwareUuid,
      label: "Concept",
      is_provisional: false,
      properties: {
        ...(existingHardware?.properties ?? {}),
        name: hardwareName,
        concept_name: hardwareName,
        description:
          existingHardware?.properties.description ||
          `Hardware-agnostic Earth observation webhook endpoint (${producerType}).`,
        status: "Active",
        importance: existingHardware?.properties.importance ?? 7,
        lat: hasCoords ? lat : existingHardware?.properties.lat,
        lng: hasCoords ? lng : existingHardware?.properties.lng,
        dataset,
        producer_type: producerType,
        device_id: deviceId,
        value: numericValue ?? existingHardware?.properties.value,
        unit,
        observed_at: observedAt,
        created_at: existingHardware?.properties.created_at || now,
      },
    };

    const signalUuid = isUpdatingExistingSignal
      ? existingTarget.uuid
      : distinctSignal
        ? `signal-wh-${crypto.randomUUID().slice(0, 8)}`
        : isTargetingInsight
          ? `signal-wh-${deviceId}`
          : `signal-wh-${nodeId}`;

    const existingSignal = this.nodes.get(signalUuid);
    const defaultSignalTitle = `${hardwareNode.properties.name} Reading${numericValue !== undefined ? ` (${numericValue} ${unit})` : ""}`;
    const titleFromPayload =
      (typeof payload.title === "string" && payload.title.trim()) ||
      (typeof payload.summary === "string" && payload.summary.trim()) ||
      (isUpdatingExistingSignal ? existingSignal?.properties.name : undefined) ||
      defaultSignalTitle;

    const descriptionFromPayload =
      typeof payload.description === "string" && payload.description.trim()
        ? payload.description.trim()
        : existingSignal?.properties.description ||
          `Live webhook telemetry pushed from ${deviceId} (${producerType}).`;

    let signalNode: ETGNode = {
      uuid: signalUuid,
      label: "Signal",
      is_provisional: false,
      properties: {
        ...(existingSignal?.properties ?? {}),
        name: titleFromPayload,
        concept_name: titleFromPayload,
        description: descriptionFromPayload,
        status: "Active",
        importance: existingSignal?.properties.importance ?? 8,
        lat: hasCoords ? lat : existingSignal?.properties.lat ?? hardwareNode.properties.lat,
        lng: hasCoords ? lng : existingSignal?.properties.lng ?? hardwareNode.properties.lng,
        dataset,
        producer_type: producerType,
        device_id: deviceId,
        value: numericValue ?? existingSignal?.properties.value,
        unit,
        confidence,
        observed_at: observedAt,
        created_at: existingSignal?.properties.created_at || now,
      },
    };

    // Accumulate incoming series array + numeric point into rolling series for both nodes
    const incomingPoints: TimeSeriesPoint[] = [];
    if (Array.isArray(payload.series)) {
      for (const item of payload.series) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const val = typeof rec.value === "number" ? rec.value : Number(rec.value);
        if (!Number.isFinite(val)) continue;
        const dateStr = typeof rec.date === "string" ? rec.date : String(rec.date ?? "");
        const parsed = toTimeSeriesPoint(dateStr, val);
        if (parsed) {
          if (typeof rec.t === "number" && Number.isFinite(rec.t)) {
            parsed.t = rec.t;
          }
          incomingPoints.push(parsed);
        }
      }
    }
    if (numericValue !== undefined) {
      const point = toTimeSeriesPoint(observedAt, numericValue);
      if (point) incomingPoints.push(point);
    }

    if (incomingPoints.length > 0) {
      const priorSeries =
        this.getNodeSeries(signalNode.uuid) ?? this.getNodeSeries(hardwareNode.uuid) ?? [];
      const merged = mergeSeriesPoints(priorSeries, incomingPoints);
      signalNode = {
        ...signalNode,
        properties: this.offloadNodeSeries(signalNode.uuid, {
          ...signalNode.properties,
          series: merged,
        }),
      };
      hardwareNode = {
        ...hardwareNode,
        properties: this.offloadNodeSeries(hardwareNode.uuid, {
          ...hardwareNode.properties,
          series: merged,
        }),
      };
    } else {
      signalNode = {
        ...signalNode,
        properties: this.offloadNodeSeries(signalNode.uuid, signalNode.properties),
      };
      hardwareNode = {
        ...hardwareNode,
        properties: this.offloadNodeSeries(hardwareNode.uuid, hardwareNode.properties),
      };
    }

    this.nodes.set(hardwareNode.uuid, hardwareNode);
    this.nodes.set(signalNode.uuid, signalNode);

    const monitorTypes = new Set<ETGRelationshipType>(["monitors"]);
    if (!this.hasEdgeBetween(hardwareNode.uuid, signalNode.uuid, true, monitorTypes)) {
      const monitorEdgeId = `edge-mon-${crypto.randomUUID().slice(0, 8)}`;
      this.edges.set(monitorEdgeId, {
        source_uuid: hardwareNode.uuid,
        target_uuid: signalNode.uuid,
        type: "monitors",
        properties: {
          uuid: monitorEdgeId,
          is_provisional: false,
          source_snippet: `Webhook reading from ${deviceId}`,
          created_at: now,
        },
      });
    }

    const { linkedInsights, linkedSignals, corroborationAudits } = this.linkNearbyNodes(signalNode, 450);
    const { discoveredEdges: discoveredConnections } = this.discoverConnectionsForSeriesNode(
      this.nodes.get(signalNode.uuid) ?? signalNode
    );

    const refreshedSignal = this.nodes.get(signalNode.uuid) ?? signalNode;
    if (refreshedSignal.properties.theil_sen_slope !== undefined) {
      const refreshedHw = this.nodes.get(hardwareNode.uuid) ?? hardwareNode;
      hardwareNode = {
        ...refreshedHw,
        properties: {
          ...refreshedHw.properties,
          p_value: refreshedSignal.properties.p_value,
          p_value_adjusted: refreshedSignal.properties.p_value_adjusted,
          theil_sen_slope: refreshedSignal.properties.theil_sen_slope,
          slope_unit: refreshedSignal.properties.slope_unit,
          ols_r2: refreshedSignal.properties.ols_r2,
          regime_shift_year: refreshedSignal.properties.regime_shift_year,
        },
      };
      this.nodes.set(hardwareNode.uuid, hardwareNode);
    }

    const act = this.pushActivity({
      kind: "webhook",
      nodeUuid: refreshedSignal.uuid,
      summary: `Webhook [${deviceId}] ingested "${refreshedSignal.properties.name}" (${linkedInsights.length} trend link${linkedInsights.length === 1 ? "" : "s"}, ${linkedSignals.length} nearby event${linkedSignals.length === 1 ? "" : "s"}, ${discoveredConnections.length} global link${discoveredConnections.length === 1 ? "" : "s"})`,
    });
    this.emitUpdate(act);

    return {
      hardwareNode,
      signalNode: refreshedSignal,
      linkedInsights,
      linkedSignals,
      corroborationAudits,
      discoveredConnections,
    };
  }

  ingestEonetSignals(signals: ETGNode[]): { added: number; updated: number; linkedEdges: number } {
    let added = 0;
    let updated = 0;
    let linkedEdges = 0;
    const now = new Date().toISOString();

    if (!this.nodes.has("source-nasa-eonet")) {
      this.nodes.set("source-nasa-eonet", {
        uuid: "source-nasa-eonet",
        label: "Concept",
        is_provisional: false,
        properties: {
          name: "NASA EONET v3 Event Feed",
          concept_name: "NASA EONET v3 Event Feed",
          description: "Earth Observatory Natural Event Tracker streaming active wildfires, ice anomalies, storms, and dust events.",
          status: "Active",
          importance: 9,
          dataset: "nasa_power",
          producer_type: "nasa_satellite",
          created_at: now,
        },
      });
    }

    for (const sig of signals) {
      const existed = this.nodes.has(sig.uuid);
      const preparedSig: ETGNode = {
        ...sig,
        properties: this.offloadNodeSeries(sig.uuid, sig.properties),
      };
      this.nodes.set(preparedSig.uuid, preparedSig);
      if (existed) updated += 1;
      else added += 1;

      const monitorId = `edge-eonet-${preparedSig.uuid}`;
      if (!this.edges.has(monitorId)) {
        this.edges.set(monitorId, {
          source_uuid: "source-nasa-eonet",
          target_uuid: preparedSig.uuid,
          type: "monitors",
          properties: {
            uuid: monitorId,
            is_provisional: false,
            source_snippet: "NASA EONET v3 telemetry",
            created_at: now,
          },
        });
      }

      const nearby = this.linkNearbyNodes(preparedSig, 450);
      linkedEdges += nearby.linkedInsights.length + nearby.linkedSignals.length;
    }

    const act = this.pushActivity({
      kind: "eonet",
      summary: `Synced ${signals.length} NASA EONET orbital events (${added} new, ${updated} updated, ${linkedEdges} local links).`,
    });
    this.emitUpdate(act);

    return { added, updated, linkedEdges };
  }

  traceShortestPath(fromUuid: string, toUuid: string, maxHops = 6): ProvenanceHop[] | null {
    if (!this.nodes.has(fromUuid) || !this.nodes.has(toUuid)) return null;
    if (fromUuid === toUuid) {
      const n = this.nodes.get(fromUuid)!;
      return [{ nodeUuid: n.uuid, name: n.properties.name, label: n.label, depth: 0 }];
    }

    const adj = new Map<string, Array<{ next: string; type: ETGRelationshipType }>>();
    for (const e of this.edges.values()) {
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
              const node = this.nodes.get(item.id)!;
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

  private getEdgeWeight(edge: ETGEdge): number {
    if (typeof edge.properties.weight === "number" && Number.isFinite(edge.properties.weight)) {
      return Math.max(0.05, Math.min(1, edge.properties.weight));
    }
    if (typeof edge.properties.correlation_r === "number" && Number.isFinite(edge.properties.correlation_r)) {
      return Math.max(0.2, Math.min(1, Math.abs(edge.properties.correlation_r)));
    }
    return 0.72;
  }

  private isBidirectionalTraversalEdge(edge: ETGEdge): boolean {
    if (!SYMMETRIC_EDGE_TYPES.has(edge.type)) return false;
    const lag = edge.properties.optimal_lag_steps;
    return lag === undefined || lag === 0;
  }

  /**
   * Traverses a k-hop neighborhood from `rootUuid` respecting causal direction (`upstream`, `downstream`, or `both`).
   */
  traverseSubgraph(options: SubgraphTraversalOptions): SubgraphTraversalResult {
    const maxHops = Math.max(1, Math.min(6, Math.round(options.maxHops ?? 2)));
    const direction: TraversalDirection = options.direction ?? "both";
    const includeSuperseded = options.includeSuperseded ?? false;
    const allowedTypes =
      options.edgeTypes && options.edgeTypes.length > 0 ? new Set(options.edgeTypes) : null;
    const minWeight = options.minWeight ?? 0;

    const rootNode = this.nodes.get(options.rootUuid);
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
      if (this.getEdgeWeight(edge) < minWeight) return false;
      const src = this.nodes.get(edge.source_uuid);
      const dst = this.nodes.get(edge.target_uuid);
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

        for (const edge of this.edges.values()) {
          if (!canTraverseEdge(edge)) continue;
          const isSym = this.isBidirectionalTraversalEdge(edge);
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
      .map((id) => this.nodes.get(id))
      .filter((n): n is ETGNode => Boolean(n))
      .sort((a, b) => (hopByNode[a.uuid] ?? 99) - (hopByNode[b.uuid] ?? 99));

    const inducedEdges = Array.from(this.edges.values()).filter(
      (e) => allIds.has(e.source_uuid) && allIds.has(e.target_uuid) && canTraverseEdge(e)
    );

    // Rank top causal paths radiating up/down from root
    const causalPaths: CausalPathSummary[] = [];
    const buildPathsFromRoot = (mode: "upstream" | "downstream") => {
      const dfs = (curr: string, pathNodes: string[], pathEdges: string[], lagSum: number, scoreProd: number) => {
        if (pathEdges.length >= 1) {
          const orderedNodes = mode === "upstream" ? [...pathNodes].reverse() : pathNodes;
          const orderedEdges = mode === "upstream" ? [...pathEdges].reverse() : pathEdges;
          const labels = orderedNodes.map((id) => this.nodes.get(id)?.properties.name ?? id);
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
          const w = this.getEdgeWeight(edge);
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
  findAllPaths(fromUuid: string, toUuid: string, maxHops = 5): CausalPathSummary[] {
    if (!this.nodes.has(fromUuid) || !this.nodes.has(toUuid)) return [];
    const results: CausalPathSummary[] = [];
    const clampedHops = Math.max(1, Math.min(6, maxHops));

    const dfs = (curr: string, visited: string[], viaEdges: string[], lagSum: number, scoreProd: number) => {
      if (results.length >= 24) return;
      if (curr === toUuid && viaEdges.length > 0) {
        const names = visited.map((id) => this.nodes.get(id)?.properties.name ?? id);
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

      for (const edge of this.edges.values()) {
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
          scoreProd * this.getEdgeWeight(edge)
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
  discoverCandidateLinks(options?: {
    anchorUuid?: string;
    minAbsR?: number;
    limit?: number;
  }): CandidateLinkSuggestion[] {
    const minAbsR = options?.minAbsR ?? 0.42;
    const limit = Math.max(1, Math.min(30, options?.limit ?? 12));
    const anchorUuid = options?.anchorUuid;

    const candidates = Array.from(this.nodes.values()).filter(
      (n) => n.properties.status !== "Superseded" && n.label !== "Rule"
    );
    if (candidates.length < 2) return [];

    const pairQueue: Array<[ETGNode, ETGNode]> = [];
    if (anchorUuid) {
      const anchor = this.nodes.get(anchorUuid);
      if (!anchor) return [];
      for (const other of candidates) {
        if (other.uuid === anchorUuid) continue;
        if (this.hasEdgeBetween(anchor.uuid, other.uuid, false)) continue;
        pairQueue.push([anchor, other]);
      }
    } else {
      const capped = candidates.slice(0, 60);
      for (let i = 0; i < capped.length; i++) {
        for (let j = i + 1; j < capped.length; j++) {
          if (this.hasEdgeBetween(capped[i].uuid, capped[j].uuid, false)) continue;
          pairQueue.push([capped[i], capped[j]]);
        }
      }
    }

    const suggestions: CandidateLinkSuggestion[] = [];

    for (const [nodeA, nodeB] of pairQueue) {
      const seriesA = this.getNodeSeries(nodeA.uuid);
      const seriesB = this.getNodeSeries(nodeB.uuid);
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

  /**
   * Exports a PyTorch Geometric / NetworkX-compatible node-feature & edge-index tensor bundle.
   */
  exportMlGraphDataset(options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
  }): GraphMlDatasetExport {
    const sub =
      options?.rootUuid && this.nodes.has(options.rootUuid)
        ? this.traverseSubgraph({
            rootUuid: options.rootUuid,
            maxHops: options.maxHops ?? 2,
            direction: "both",
          })
        : null;

    const nodes = (sub ? sub.nodes : Array.from(this.nodes.values())).filter(
      (n) => n.properties.status !== "Superseded"
    );
    const nodeIndex = new Map<string, number>();
    nodes.forEach((n, idx) => nodeIndex.set(n.uuid, idx));

    const edges = (sub ? sub.edges : Array.from(this.edges.values())).filter(
      (e) => nodeIndex.has(e.source_uuid) && nodeIndex.has(e.target_uuid)
    );

    let bucket: TemporalBucket = options?.bucket ?? "year";
    if (!options?.bucket) {
      const rootSeries = options?.rootUuid ? this.getNodeSeries(options.rootUuid) : undefined;
      if (rootSeries && rootSeries.length >= 3) {
        bucket = inferSeriesBucket(rootSeries);
      } else {
        const counts: Record<TemporalBucket, number> = { day: 0, month: 0, year: 0 };
        for (const n of nodes) {
          const s = this.getNodeSeries(n.uuid);
          if (s && s.length >= 3) counts[inferSeriesBucket(s)] += 1;
        }
        if (counts.day >= counts.month && counts.day >= counts.year && counts.day > 0) bucket = "day";
        else if (counts.month >= counts.year && counts.month > 0) bucket = "month";
      }
    }

    const bucketedMaps = nodes.map((n) => {
      const s = this.getNodeSeries(n.uuid);
      return s && s.length > 0 ? aggregateSeriesByBucket(s, bucket) : new Map<string, TimeSeriesPoint>();
    });

    const timeKeyToT = new Map<string, number>();
    for (const m of bucketedMaps) {
      for (const [k, pt] of m.entries()) {
        if (!timeKeyToT.has(k)) timeKeyToT.set(k, pt.t);
      }
    }
    const timeIndex = Array.from(timeKeyToT.keys()).sort(
      (a, b) => (timeKeyToT.get(a) ?? 0) - (timeKeyToT.get(b) ?? 0)
    );

    const nodeStats = bucketedMaps.map((m) => {
      const vals = timeIndex
        .map((k) => m.get(k)?.value)
        .filter((v): v is number => v !== undefined && Number.isFinite(v));
      const mean = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
      const variance =
        vals.length > 1
          ? vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1)
          : 1;
      return { mean, std: Math.max(1e-6, Math.sqrt(variance)) };
    });

    const featureTensor: number[][][] = [];
    const maskTensor: number[][] = [];
    const prevObserved: Array<number | null> = nodes.map(() => null);

    for (const tKey of timeIndex) {
      const rowFeat: number[][] = [];
      const rowMask: number[] = [];
      for (let j = 0; j < nodes.length; j++) {
        const pt = bucketedMaps[j].get(tKey);
        if (pt && Number.isFinite(pt.value)) {
          const z = (pt.value - nodeStats[j].mean) / nodeStats[j].std;
          const prev = prevObserved[j];
          const diff = prev !== null ? (pt.value - prev) / nodeStats[j].std : 0;
          prevObserved[j] = pt.value;
          rowFeat.push([
            Number(pt.value.toFixed(4)),
            Number(z.toFixed(4)),
            Number(diff.toFixed(4)),
          ]);
          rowMask.push(1);
        } else {
          rowFeat.push([0, 0, 0]);
          rowMask.push(0);
        }
      }
      featureTensor.push(rowFeat);
      maskTensor.push(rowMask);
    }

    const srcIdx: number[] = [];
    const dstIdx: number[] = [];
    const edgeTypes: ETGRelationshipType[] = [];
    const edgeAttr: number[][] = [];

    for (const e of edges) {
      const s = nodeIndex.get(e.source_uuid);
      const d = nodeIndex.get(e.target_uuid);
      if (s === undefined || d === undefined) continue;
      srcIdx.push(s);
      dstIdx.push(d);
      edgeTypes.push(e.type);

      const srcNode = nodes[s];
      const dstNode = nodes[d];
      let distKm = 0;
      let brgRad = 0;
      if (
        srcNode.properties.lat !== undefined &&
        srcNode.properties.lng !== undefined &&
        dstNode.properties.lat !== undefined &&
        dstNode.properties.lng !== undefined
      ) {
        distKm = haversineKm(
          srcNode.properties.lat,
          srcNode.properties.lng,
          dstNode.properties.lat,
          dstNode.properties.lng
        );
        brgRad =
          (bearingDeg(
            srcNode.properties.lat,
            srcNode.properties.lng,
            dstNode.properties.lat,
            dstNode.properties.lng
          ) *
            Math.PI) /
          180;
      }

      edgeAttr.push([
        Number((e.properties.correlation_r ?? 0).toFixed(4)),
        Number((e.properties.detrended_r ?? 0).toFixed(4)),
        e.properties.optimal_lag_steps ?? 0,
        Number(this.getEdgeWeight(e).toFixed(4)),
        Number(Math.min(1, distKm / 20000).toFixed(4)),
        Number(Math.sin(brgRad).toFixed(4)),
        Number(Math.cos(brgRad).toFixed(4)),
        e.type === "drives_opposite" ? 1 : 0,
      ]);
    }

    return {
      schema_version: "etg-ml-v1",
      bucket,
      node_ids: nodes.map((n) => n.uuid),
      node_metadata: nodes.map((n, index) => ({
        index,
        uuid: n.uuid,
        label: n.label,
        name: n.properties.name,
        dataset: n.properties.dataset,
        phenomenon_type: n.properties.phenomenon_type,
        lat: n.properties.lat,
        lng: n.properties.lng,
        slope_per_decade: n.properties.theil_sen_slope,
        p_value: n.properties.p_value,
      })),
      edge_index: [srcIdx, dstIdx],
      edge_types: edgeTypes,
      edge_attr_names: [
        "correlation_r",
        "detrended_r",
        "optimal_lag_steps",
        "weight",
        "distance_km_norm",
        "sin_bearing",
        "cos_bearing",
        "is_opposite",
      ],
      edge_attr: edgeAttr,
      time_index: timeIndex,
      feature_names: ["value", "z_score", "diff_1"],
      feature_tensor: featureTensor,
      mask_tensor: maskTensor,
    };
  }

  /**
   * Exports a zero-leakage multi-scale spatio-temporal graph tensor bundle
   * (`etg-ml-v2`) suitable for inductive PyTorch Graph Transformer training
   * on Blackwell/L4 GPUs as well as offline cross-validation.
   */
  exportMlGraphDatasetV2(options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
    trainFraction?: number;
    trainCutoffDate?: string;
    horizonSteps?: number;
  }): GraphMlDatasetExportV2 {
    const sub =
      options?.rootUuid && this.nodes.has(options.rootUuid)
        ? this.traverseSubgraph({
            rootUuid: options.rootUuid,
            maxHops: options.maxHops ?? 2,
            direction: "both",
          })
        : null;

    const nodes = (sub ? sub.nodes : Array.from(this.nodes.values())).filter(
      (n) => n.properties.status !== "Superseded"
    );
    const nodeIndex = new Map<string, number>();
    nodes.forEach((n, idx) => nodeIndex.set(n.uuid, idx));

    const edges = (sub ? sub.edges : Array.from(this.edges.values())).filter(
      (e) =>
        nodeIndex.has(e.source_uuid) &&
        nodeIndex.has(e.target_uuid) &&
        !e.properties.superseded_at
    );

    let bucket: TemporalBucket = options?.bucket ?? "month";
    if (!options?.bucket) {
      const rootSeries = options?.rootUuid ? this.getNodeMultiScaleSeries(options.rootUuid) : undefined;
      if (rootSeries && rootSeries.length >= 3) {
        bucket = inferSeriesBucket(rootSeries);
      } else {
        const counts: Record<TemporalBucket, number> = { day: 0, month: 0, year: 0 };
        for (const n of nodes) {
          if (this.multiScaleSeriesByNode.get(n.uuid)?.month?.length) {
            counts.month += 1;
            continue;
          }
          const s = this.getNodeSeries(n.uuid);
          if (s && s.length >= 3) counts[inferSeriesBucket(s)] += 1;
        }
        if (counts.day > counts.month && counts.day >= counts.year && counts.day > 0) {
          bucket = "day";
        } else if (counts.month >= counts.year && counts.month > 0) {
          bucket = "month";
        } else if (counts.year > 0) {
          bucket = "year";
        }
      }
    }

    const impulseEventsByNode = new Map<number, CausalImpulseEvent[]>();
    for (let j = 0; j < nodes.length; j++) {
      const n = nodes[j];
      const s = this.getNodeSeries(n.uuid);
      const scale = inferNodeTemporalScale(n, s);
      const events: CausalImpulseEvent[] = [];
      const intensity = n.properties.event_intensity ?? 1;
      const decayDays = n.properties.event_decay_days ?? (n.properties.event_ended_at ? 10 : 18);

      if (scale === "impulse" || typeof n.properties.event_intensity === "number") {
        if (n.properties.observed_at) {
          const ms = parseSeriesDateMs(n.properties.observed_at);
          if (ms !== null) events.push({ ms, intensity, decayDays });
        }
        if (s) {
          for (const pt of s) {
            const ms = parseSeriesDateMs(pt.date);
            if (ms !== null) {
              events.push({
                ms,
                intensity: Number.isFinite(pt.value) && pt.value > 0 ? Math.min(2.5, Math.max(0.4, intensity)) : intensity,
                decayDays,
              });
            }
          }
        }
      }
      if (events.length > 0) {
        impulseEventsByNode.set(j, events);
      }
    }

    const incidentImpulsesByNode = new Map<number, number[]>();
    for (const e of edges) {
      const s = nodeIndex.get(e.source_uuid);
      const d = nodeIndex.get(e.target_uuid);
      if (s === undefined || d === undefined) continue;
      if (impulseEventsByNode.has(s)) {
        const list = incidentImpulsesByNode.get(d) ?? [];
        if (!list.includes(s)) list.push(s);
        incidentImpulsesByNode.set(d, list);
      }
    }

    const primaryMaps = nodes.map((n) => {
      const s = this.getNodeMultiScaleSeries(n.uuid, bucket) ?? this.getNodeSeries(n.uuid);
      return s && s.length > 0
        ? aggregateSeriesByBucket(s, bucket)
        : new Map<string, TimeSeriesPoint>();
    });

    const trainFraction = options?.trainFraction ?? 0.75;
    const trainCutoffDate = options?.trainCutoffDate;
    const primaryBlock = buildCausalScaleBlock({
      nodeCount: nodes.length,
      scaleMaps: primaryMaps,
      impulseEventsByNode,
      incidentImpulsesByNode,
      trainFraction,
      trainCutoffDate,
    });

    const trainKeys = primaryBlock.timeIndex.slice(0, primaryBlock.trainCutoffIndex);

    const srcIdx: number[] = [];
    const dstIdx: number[] = [];
    const edgeTypes: ETGRelationshipType[] = [];
    const edgeAttr: number[][] = [];

    for (const e of edges) {
      const s = nodeIndex.get(e.source_uuid);
      const d = nodeIndex.get(e.target_uuid);
      if (s === undefined || d === undefined) continue;
      srcIdx.push(s);
      dstIdx.push(d);
      edgeTypes.push(e.type);

      const srcNode = nodes[s];
      const dstNode = nodes[d];
      const { corrR, optimalLag } = computeCausalPearsonAndLag(
        primaryMaps[s],
        primaryMaps[d],
        trainKeys
      );

      let distKm = 0;
      let brgRad = 0;
      if (
        srcNode.properties.lat !== undefined &&
        srcNode.properties.lng !== undefined &&
        dstNode.properties.lat !== undefined &&
        dstNode.properties.lng !== undefined
      ) {
        distKm = haversineKm(
          srcNode.properties.lat,
          srcNode.properties.lng,
          dstNode.properties.lat,
          dstNode.properties.lng
        );
        brgRad =
          (bearingDeg(
            srcNode.properties.lat,
            srcNode.properties.lng,
            dstNode.properties.lat,
            dstNode.properties.lng
          ) *
            Math.PI) /
          180;
      }

      const structuralWeight =
        typeof e.properties.weight === "number" && Number.isFinite(e.properties.weight)
          ? Math.max(0.05, Math.min(1, e.properties.weight))
          : Math.abs(corrR) > 0.05
          ? Math.max(0.2, Math.abs(corrR))
          : 0.72;

      edgeAttr.push([
        corrR,
        Number(Math.max(-1, Math.min(1, optimalLag / 6)).toFixed(4)),
        Number(structuralWeight.toFixed(4)),
        Number(Math.min(1, distKm / 20000).toFixed(4)),
        Number(Math.sin(brgRad).toFixed(4)),
        Number(Math.cos(brgRad).toFixed(4)),
        e.type === "drives_opposite" ? 1 : 0,
        e.properties.cross_scale ? 1 : 0,
      ]);
    }

    const nodeMetadata: GraphMlDatasetExportV2["node_metadata"] = [];
    const nodeStaticFeatures: number[][] = [];

    for (let index = 0; index < nodes.length; index++) {
      const n = nodes[index];
      const s = this.getNodeSeries(n.uuid);
      const scale = inferNodeTemporalScale(n, s);
      const sphere: EarthSphere = inferEarthSphere(n);
      const trustScore = this.computeNodeTrustScore(n);
      const isCommunity = isCommunityContributorNode(n);
      const corroborated = Boolean(n.properties.corroborated);

      nodeMetadata.push({
        index,
        uuid: n.uuid,
        label: n.label,
        name: n.properties.name,
        dataset: n.properties.dataset,
        sphere,
        temporal_scale: scale,
        phenomenon_type: n.properties.phenomenon_type,
        lat: n.properties.lat,
        lng: n.properties.lng,
        elevation_m: n.properties.elevation_m,
        trust_score: trustScore,
        is_community: isCommunity,
        corroborated,
        slope_per_decade: n.properties.theil_sen_slope,
        p_value: n.properties.p_value,
      });

      const latRad = ((n.properties.lat ?? 0) * Math.PI) / 180;
      const lngRad = ((n.properties.lng ?? 0) * Math.PI) / 180;
      const elevNorm = Math.max(-1, Math.min(1, (n.properties.elevation_m ?? 0) / 5000));
      const msEntry = this.multiScaleSeriesByNode.get(n.uuid);
      const avail = new Set<string>(n.properties.available_scales ?? []);
      const hasDay = scale === "day" || avail.has("day") || Boolean(msEntry?.day?.length) ? 1 : 0;
      const hasMonth =
        scale === "month" || avail.has("month") || Boolean(msEntry?.month?.length) ? 1 : 0;
      const hasYear = scale === "year" || avail.has("year") || Boolean(msEntry?.year?.length) ? 1 : 0;
      const hasImpulse = scale === "impulse" ? 1 : 0;

      nodeStaticFeatures.push([
        Number(Math.sin(latRad).toFixed(4)),
        Number(Math.cos(latRad).toFixed(4)),
        Number(Math.sin(lngRad).toFixed(4)),
        Number(Math.cos(lngRad).toFixed(4)),
        Number(elevNorm.toFixed(4)),
        trustScore,
        isCommunity ? 1 : 0,
        corroborated ? 1 : 0,
        hasDay,
        hasMonth,
        hasYear,
        hasImpulse,
        sphere === "Atmosphere" ? 1 : 0,
        sphere === "Ocean" ? 1 : 0,
        sphere === "Hydrosphere" ? 1 : 0,
        sphere === "Biosphere" || sphere === "Cryosphere" ? 1 : 0,
      ]);
    }

    const multiScaleBlocks: GraphMlDatasetExportV2["multi_scale_blocks"] = {};
    for (const scale of ["day", "month", "year"] as const) {
      const scaleNodeIndices: number[] = [];
      const scaleMaps: Array<Map<string, TimeSeriesPoint>> = [];
      for (let j = 0; j < nodes.length; j++) {
        const msSeries = this.multiScaleSeriesByNode.get(nodes[j].uuid)?.[scale];
        const primary = this.getNodeSeries(nodes[j].uuid);
        const matchesPrimary =
          primary && primary.length >= 2 && inferSeriesBucket(primary) === scale;
        const chosen =
          msSeries && msSeries.length >= 2 ? msSeries : matchesPrimary ? primary : undefined;
        if (chosen && chosen.length >= 2) {
          scaleNodeIndices.push(j);
          scaleMaps.push(aggregateSeriesByBucket(chosen, scale));
        }
      }

      if (scaleNodeIndices.length === 0) continue;
      const subIndexMap = new Map<number, number>();
      scaleNodeIndices.forEach((origIdx, subIdx) => subIndexMap.set(origIdx, subIdx));

      const subImpulseEvents = new Map<number, CausalImpulseEvent[]>();
      const subIncidentImpulses = new Map<number, number[]>();
      for (const [origIdx, evs] of impulseEventsByNode.entries()) {
        const subIdx = subIndexMap.get(origIdx);
        if (subIdx !== undefined) subImpulseEvents.set(subIdx, evs);
      }
      for (const [origDst, origSrcList] of incidentImpulsesByNode.entries()) {
        const subDst = subIndexMap.get(origDst);
        if (subDst === undefined) continue;
        const mapped = origSrcList
          .map((src) => subIndexMap.get(src))
          .filter((v): v is number => v !== undefined);
        if (mapped.length > 0) subIncidentImpulses.set(subDst, mapped);
      }

      const block = buildCausalScaleBlock({
        nodeCount: scaleNodeIndices.length,
        scaleMaps,
        impulseEventsByNode: subImpulseEvents,
        incidentImpulsesByNode: subIncidentImpulses,
        trainFraction,
        trainCutoffDate,
      });

      multiScaleBlocks[scale] = {
        time_index: block.timeIndex,
        node_indices: scaleNodeIndices,
        feature_tensor: block.featureTensor,
        mask_tensor: block.maskTensor,
      };
    }

    const horizonSteps = Math.max(1, Math.min(6, options?.horizonSteps ?? 1));
    const T = primaryBlock.timeIndex.length;
    const N = nodes.length;
    const nextValueTargets: Array<Array<number | null>> = [];
    const trendClassTargets: Array<Array<number | null>> = [];
    const regimeShiftTargets: Array<Array<number | null>> = [];

    for (let t = 0; t < T; t++) {
      const nvRow: Array<number | null> = [];
      const tcRow: Array<number | null> = [];
      const rsRow: Array<number | null> = [];
      const fIdx = t + horizonSteps;

      for (let j = 0; j < N; j++) {
        if (fIdx < T && primaryBlock.maskTensor[fIdx][j] === 1) {
          const futureZ = primaryBlock.featureTensor[fIdx][j][1];
          nvRow.push(futureZ);

          if (primaryBlock.maskTensor[t][j] === 1) {
            const curZ = primaryBlock.featureTensor[t][j][1];
            const deltaZ = futureZ - curZ;
            tcRow.push(deltaZ <= -0.35 ? 0 : deltaZ >= 0.35 ? 2 : 1);

            const rollMeanZ = primaryBlock.featureTensor[t][j][3];
            const signFlip = futureZ * rollMeanZ < -0.5 && Math.abs(futureZ) >= 1.1;
            const jump = Math.abs(futureZ - rollMeanZ) >= 1.5;
            rsRow.push(jump || signFlip ? 1 : 0);
          } else {
            tcRow.push(null);
            rsRow.push(null);
          }
        } else {
          nvRow.push(null);
          tcRow.push(null);
          rsRow.push(null);
        }
      }
      nextValueTargets.push(nvRow);
      trendClassTargets.push(tcRow);
      regimeShiftTargets.push(rsRow);
    }

    return {
      schema_version: "etg-ml-v2",
      primary_bucket: bucket,
      train_cutoff_index: primaryBlock.trainCutoffIndex,
      node_ids: nodes.map((n) => n.uuid),
      node_metadata: nodeMetadata,
      node_static_feature_names: [
        "lat_sin",
        "lat_cos",
        "lng_sin",
        "lng_cos",
        "elevation_norm",
        "trust_score",
        "is_community",
        "corroborated",
        "scale_day",
        "scale_month",
        "scale_year",
        "scale_impulse",
        "sphere_atmosphere",
        "sphere_ocean",
        "sphere_hydrosphere",
        "sphere_biosphere_cryo",
      ],
      node_static_features: nodeStaticFeatures,
      edge_index: [srcIdx, dstIdx],
      edge_types: edgeTypes,
      edge_attr_names: [
        "causal_corr_r",
        "causal_optimal_lag_norm",
        "weight",
        "distance_km_norm",
        "sin_bearing",
        "cos_bearing",
        "is_opposite",
        "is_cross_scale",
      ],
      edge_attr: edgeAttr,
      time_index: primaryBlock.timeIndex,
      feature_names: [
        "value",
        "z_score",
        "diff_1",
        "rolling_mean_4",
        "rolling_std_4",
        "seasonal_anom",
        "event_impulse",
        "covar_primary",
      ],
      feature_tensor: primaryBlock.featureTensor,
      mask_tensor: primaryBlock.maskTensor,
      multi_scale_blocks: multiScaleBlocks,
      labels: {
        horizon_steps: horizonSteps,
        next_value_targets: nextValueTargets,
        trend_class_targets: trendClassTargets,
        regime_shift_targets: regimeShiftTargets,
      },
      normalization: primaryBlock.normStats.map((s) => ({
        mean: Number(s.mean.toFixed(6)),
        std: Number(s.std.toFixed(6)),
      })),
    };
  }

  /**
   * Logs an ex-ante live forecast onto the prospective verification ledger.
   * When matching future observations arrive on `targetUuid`, `reconcileProspectiveForecasts`
   * scores actual vs predicted error and 95% CI coverage without hindsight bias.
   */
  logProspectiveForecast(prediction: GraphPredictionResult): ProspectiveForecastRecord {
    const targetNode = this.nodes.get(prediction.targetUuid);
    const series = this.getNodeSeries(prediction.targetUuid) ?? [];
    const issuedFromRaw =
      series[series.length - 1]?.date ??
      targetNode?.properties.observed_at ??
      new Date().toISOString().slice(0, 10);
    const issuedFromPeriod =
      normalizeBucketPeriodKey(issuedFromRaw, prediction.bucket) ?? issuedFromRaw;
    const normalizedTargetPeriod =
      normalizeBucketPeriodKey(
        prediction.nextForecast.nextPeriodLabel,
        prediction.bucket
      ) ?? prediction.nextForecast.nextPeriodLabel;

    const existingPending = Array.from(this.forecasts.values()).find(
      (f) =>
        f.target_uuid === prediction.targetUuid &&
        f.bucket === prediction.bucket &&
        f.target_period === normalizedTargetPeriod &&
        f.status === "pending"
    );

    const record: ProspectiveForecastRecord = {
      id: existingPending?.id ?? `fc-${crypto.randomUUID().slice(0, 8)}`,
      target_uuid: prediction.targetUuid,
      target_name: prediction.targetName,
      unit: prediction.unit,
      bucket: prediction.bucket,
      issued_at: new Date().toISOString(),
      issued_from_period: issuedFromPeriod,
      target_period: normalizedTargetPeriod,
      last_actual: prediction.nextForecast.lastActual,
      predicted_value: prediction.recommendedForecastValue,
      self_only_pred: prediction.nextForecast.selfOnlyPred,
      persistence_pred: prediction.nextForecast.persistencePred,
      ci95_half_width: prediction.nextForecast.ci95HalfWidth,
      recommended_model: prediction.recommendedModel,
      architecture: prediction.activeGraphArchitecture,
      driver_uuids: prediction.neighborContributions.map((n) => n.nodeUuid),
      status: "pending",
    };

    this.forecasts.set(record.id, record);
    // Immediately check if target node already contains an observation for `target_period`
    if (series.length > 0) {
      this.reconcileSeriesForTarget(prediction.targetUuid, series);
    }

    const stored = this.forecasts.get(record.id) ?? record;
    const act = this.pushActivity({
      kind: "prediction",
      nodeUuid: prediction.targetUuid,
      summary: `Logged prospective forecast for "${prediction.targetName}" (${stored.target_period}: ${stored.predicted_value} ± ${stored.ci95_half_width} ${prediction.unit}, status=${stored.status}).`,
    });
    this.emitUpdate(act);
    return stored;
  }

  /**
   * Reconciles pending prospective forecasts against newly arrived observations.
   */
  reconcileProspectiveForecasts(targetUuid?: string): {
    scoredNow: number;
    ledger: {
      records: ProspectiveForecastRecord[];
      summary: ProspectiveLedgerSummary;
    };
  } {
    const pendingTargets = new Set<string>();
    for (const f of this.forecasts.values()) {
      if (f.status !== "pending") continue;
      if (targetUuid && f.target_uuid !== targetUuid) continue;
      pendingTargets.add(f.target_uuid);
    }

    let scoredNow = 0;
    for (const uuid of pendingTargets) {
      const series = this.getNodeSeries(uuid) ?? [];
      if (series.length > 0) {
        scoredNow += this.reconcileSeriesForTarget(uuid, series);
      } else {
        const node = this.nodes.get(uuid);
        if (
          node &&
          typeof node.properties.value === "number" &&
          node.properties.observed_at
        ) {
          const singlePt = toTimeSeriesPoint(
            node.properties.observed_at,
            node.properties.value
          );
          if (singlePt) {
            scoredNow += this.reconcileSeriesForTarget(uuid, [singlePt]);
          }
        }
      }
    }

    if (scoredNow > 0) {
      const act = this.pushActivity({
        kind: "prediction",
        nodeUuid: targetUuid,
        summary: `Reconciled ${scoredNow} prospective forecast${scoredNow === 1 ? "" : "s"} against new ground-truth observations.`,
      });
      this.emitUpdate(act);
    }

    return {
      scoredNow,
      ledger: this.getProspectiveLedger(targetUuid),
    };
  }

  /**
   * Returns all prospective forecasts and aggregate out-of-sample calibration statistics.
   */
  getProspectiveLedger(targetUuid?: string): {
    records: ProspectiveForecastRecord[];
    summary: ProspectiveLedgerSummary;
  } {
    const records = Array.from(this.forecasts.values())
      .filter((r) => !targetUuid || r.target_uuid === targetUuid)
      .sort((a, b) => Date.parse(b.issued_at) - Date.parse(a.issued_at));

    const scored = records.filter((r) => r.status === "scored");
    const pendingCount = records.length - scored.length;

    let meanAbsError: number | null = null;
    let selfMeanAbsError: number | null = null;
    let persistenceMeanAbsError: number | null = null;
    let ci95CoveragePct: number | null = null;
    let skillVsSelfPct: number | null = null;

    if (scored.length > 0) {
      const sumErr = scored.reduce((s, r) => s + (r.abs_error ?? 0), 0);
      const sumSelfErr = scored.reduce((s, r) => s + (r.self_abs_error ?? 0), 0);
      const sumPersistErr = scored.reduce(
        (s, r) => s + (r.persistence_abs_error ?? 0),
        0
      );
      const coveredCount = scored.filter((r) => r.covered_by_ci95).length;

      meanAbsError = Number((sumErr / scored.length).toFixed(4));
      selfMeanAbsError = Number((sumSelfErr / scored.length).toFixed(4));
      persistenceMeanAbsError = Number((sumPersistErr / scored.length).toFixed(4));
      ci95CoveragePct = Number(((coveredCount / scored.length) * 100).toFixed(1));
      if (selfMeanAbsError > 1e-9) {
        skillVsSelfPct = Number(
          (((selfMeanAbsError - meanAbsError) / selfMeanAbsError) * 100).toFixed(2)
        );
      }
    }

    return {
      records,
      summary: {
        total_logged: records.length,
        pending_count: pendingCount,
        scored_count: scored.length,
        mean_abs_error: meanAbsError,
        self_mean_abs_error: selfMeanAbsError,
        persistence_mean_abs_error: persistenceMeanAbsError,
        ci95_coverage_pct: ci95CoveragePct,
        skill_vs_self_pct: skillVsSelfPct,
      },
    };
  }

  /**
   * Exports a full portable JSON workspace snapshot including nodes, edges, offloaded series, forecasts, and activity.
   */
  exportWorkspaceBundle(): ETGWorkspaceBundle {
    return {
      schema_version: "etg-workspace-v1",
      exported_at: new Date().toISOString(),
      nodes: Array.from(this.nodes.values()).map((n) => ({
        ...n,
        properties: { ...n.properties },
      })),
      edges: Array.from(this.edges.values()).map((e) => ({
        ...e,
        properties: { ...e.properties },
      })),
      series_by_node: Object.fromEntries(
        Array.from(this.seriesByNode.entries()).map(([k, v]) => [k, [...v]])
      ),
      ...(this.multiScaleSeriesByNode.size > 0
        ? {
            multi_scale_series_by_node: Object.fromEntries(
              Array.from(this.multiScaleSeriesByNode.entries()).map(([uuid, scalesObj]) => [
                uuid,
                {
                  ...(scalesObj.day ? { day: [...scalesObj.day] } : {}),
                  ...(scalesObj.month ? { month: [...scalesObj.month] } : {}),
                  ...(scalesObj.year ? { year: [...scalesObj.year] } : {}),
                },
              ])
            ),
          }
        : {}),
      activity: [...this.activity],
      prospective_forecasts: Array.from(this.forecasts.values()),
    };
  }

  /**
   * Imports a portable ETG workspace bundle, validating against forbidden SaaS labels
   * and rehydrating offloaded node time-series, forecasts, and corroboration status.
   */
  importWorkspaceBundle(
    rawBundle: Partial<ETGWorkspaceBundle>,
    options?: { merge?: boolean }
  ): {
    importedNodes: number;
    importedEdges: number;
    snapshot: EtgGraphSnapshot;
  } {
    if (!rawBundle || typeof rawBundle !== "object" || !Array.isArray(rawBundle.nodes) || !Array.isArray(rawBundle.edges)) {
      throw new Error("Invalid workspace bundle: expected nodes[] and edges[] arrays.");
    }

    // Validate all labels before mutating store state
    for (const rawNode of rawBundle.nodes) {
      if (!rawNode || typeof rawNode !== "object" || typeof rawNode.uuid !== "string" || !rawNode.uuid.trim()) {
        throw new Error("Invalid node in workspace bundle: missing uuid.");
      }
      assertValidEtgLabel(String(rawNode.label ?? ""));
      if (!rawNode.properties || typeof rawNode.properties.name !== "string") {
        throw new Error(`Invalid node "${rawNode.uuid}" properties in workspace bundle.`);
      }
    }

    if (!options?.merge) {
      this.nodes = new Map();
      this.edges = new Map();
      this.seriesByNode = new Map();
      this.multiScaleSeriesByNode = new Map();
      this.forecasts = new Map();
      this.activity = [];
    }

    if (Array.isArray(rawBundle.prospective_forecasts)) {
      for (const f of rawBundle.prospective_forecasts) {
        if (f && typeof f.id === "string" && !FORBIDDEN_PATH_SEGMENTS.has(f.id)) {
          this.forecasts.set(f.id, f);
        }
      }
    }

    const bundleSeries =
      rawBundle.series_by_node && typeof rawBundle.series_by_node === "object"
        ? rawBundle.series_by_node
        : {};

    let importedNodes = 0;
    for (const rawNode of rawBundle.nodes) {
      const cleanUuid = rawNode.uuid.trim();
      if (FORBIDDEN_PATH_SEGMENTS.has(cleanUuid)) continue;
      const inlineSeries = Array.isArray(rawNode.properties.series) ? rawNode.properties.series : undefined;
      const offloadedSeries = Array.isArray(bundleSeries[cleanUuid]) ? bundleSeries[cleanUuid] : undefined;
      const combinedSeries = offloadedSeries && offloadedSeries.length > 0 ? offloadedSeries : inlineSeries;

      const nodeProps = this.offloadNodeSeries(cleanUuid, {
        ...rawNode.properties,
        series: combinedSeries,
      });

      this.nodes.set(cleanUuid, {
        uuid: cleanUuid,
        label: assertValidEtgLabel(rawNode.label),
        is_provisional: rawNode.is_provisional,
        properties: nodeProps,
      });
      importedNodes += 1;
    }

    if (
      rawBundle.multi_scale_series_by_node &&
      typeof rawBundle.multi_scale_series_by_node === "object"
    ) {
      for (const [uuid, scalesObj] of Object.entries(rawBundle.multi_scale_series_by_node)) {
        if (!scalesObj || typeof scalesObj !== "object" || FORBIDDEN_PATH_SEGMENTS.has(uuid)) {
          continue;
        }
        if (!this.nodes.has(uuid)) continue;
        for (const scale of ["day", "month", "year"] as const) {
          const arr = scalesObj[scale];
          if (Array.isArray(arr) && arr.length > 0) {
            this.setNodeMultiScaleSeries(uuid, scale, arr, true);
          }
        }
      }
    }

    let importedEdges = 0;
    for (const rawEdge of rawBundle.edges) {
      if (
        !rawEdge ||
        typeof rawEdge !== "object" ||
        typeof rawEdge.source_uuid !== "string" ||
        typeof rawEdge.target_uuid !== "string" ||
        !rawEdge.properties ||
        typeof rawEdge.properties.uuid !== "string"
      ) {
        continue;
      }
      if (!this.nodes.has(rawEdge.source_uuid) || !this.nodes.has(rawEdge.target_uuid)) {
        continue;
      }
      const edgeUuid = rawEdge.properties.uuid.trim();
      if (!edgeUuid || FORBIDDEN_PATH_SEGMENTS.has(edgeUuid)) continue;

      this.edges.set(edgeUuid, {
        source_uuid: rawEdge.source_uuid,
        target_uuid: rawEdge.target_uuid,
        type: rawEdge.type,
        properties: {
          ...rawEdge.properties,
          uuid: edgeUuid,
        },
      });
      importedEdges += 1;
    }

    // Re-evaluate multi-source corroboration for Insight nodes when corroboration rules exist
    if (this.nodes.has("rule-corroboration")) {
      for (const n of this.nodes.values()) {
        if (n.label === "Insight") {
          this.evaluateCorroboration(n.uuid, false);
        }
      }
    }

    const act = this.pushActivity({
      kind: "dataset",
      summary: `Imported ETG workspace bundle (${importedNodes} node${importedNodes === 1 ? "" : "s"}, ${importedEdges} connection${importedEdges === 1 ? "" : "s"}, mode=${options?.merge ? "merge" : "replace"}).`,
    });
    this.emitUpdate(act);

    return {
      importedNodes,
      importedEdges,
      snapshot: this.getSnapshot(),
    };
  }
}

declare global {
  var __ETG_STORE__: EtgStore | undefined;
}

export function getEtgStore(): EtgStore {
  if (!globalThis.__ETG_STORE__) {
    globalThis.__ETG_STORE__ = new EtgStore();
  }
  return globalThis.__ETG_STORE__;
}
