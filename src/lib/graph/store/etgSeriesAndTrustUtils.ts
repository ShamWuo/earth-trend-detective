import path from "node:path";
import { inferEarthSphere } from "@/lib/graph/cascadeTracer";
import { resolveRuntimeDataDir } from "@/lib/runtimePaths";
import {
  ETG_NODE_LABELS,
  FORBIDDEN_SAAS_LABELS,
  type ETGAuthorType,
  type ETGDatasetId,
  type ETGEdge,
  type ETGNode,
  type ETGNodeLabel,
  type ETGProducerType,
  type ETGRelationshipType,
  type EtgActivityEntry,
  type OppositeTrendPair,
  type TimeSeriesPoint,
} from "@/types/etg";

export const DEFAULT_DATA_DIR = resolveRuntimeDataDir();
export const LEGACY_CACHE_DIR = path.join(process.cwd(), ".etg-cache");
export const STATE_FILENAME = "etg-state.json";
export const SERIES_FILENAME = "etg-series.json";
export const MULTISCALE_FILENAME = "etg-multiscale.json";
export const FORECASTS_FILENAME = "etg-forecasts.json";
export const MAX_PATH_DEPTH = 12;
export const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function normalizeBucketPeriodKey(
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

export function toTimeSeriesPoint(rawDate: string, value: number): TimeSeriesPoint | null {
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

export function mergeSeriesPoints(
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

export function parseSeriesDateMs(raw: string): number | null {
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

export function resolveDefaultAuthor(props: Partial<ETGNode["properties"]>): ETGAuthorType {
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

export const SYMMETRIC_EDGE_TYPES = new Set<ETGRelationshipType>([
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

export function inferProducerType(node: ETGNode): ETGProducerType {
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
  const contraCount =
    typeof node.properties.contradicting_sources_count === "number"
      ? node.properties.contradicting_sources_count
      : node.properties.contested
        ? 1
        : 0;
  const contestedPenalty =
    contraCount > 0 ? Math.min(0.18, contraCount * 0.06) : 0;

  if (
    typeof node.properties.trust_score === "number" &&
    Number.isFinite(node.properties.trust_score)
  ) {
    const corrBonus = node.properties.corroborated ? 0.05 : 0;
    return Number(
      Math.max(
        0.15,
        Math.min(1, node.properties.trust_score + corrBonus + liftAdj - contestedPenalty)
      ).toFixed(4)
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
  score += liftAdj - contestedPenalty;
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

export function computeCausalPearsonAndLag(
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

export interface CausalImpulseEvent {
  ms: number;
  intensity: number;
  decayDays: number;
}

export function buildCausalScaleBlock(args: {
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

export { inferEarthSphere };
