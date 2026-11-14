import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import {
  ETG_NODE_LABELS,
  FORBIDDEN_SAAS_LABELS,
  type CorroborationAudit,
  type ETGDatasetId,
  type ETGEdge,
  type ETGNode,
  type ETGNodeLabel,
  type ETGProducerType,
  type ETGRelationshipType,
  type EtgActivityEntry,
  type OppositeTrendPair,
  type ProvenanceHop,
  type TimeSeriesPoint,
} from "@/types/etg";

const CACHE_DIR = path.join(process.cwd(), ".etg-cache");
const CACHE_FILE = path.join(CACHE_DIR, "etg-state.json");
const SERIES_FILE = path.join(CACHE_DIR, "etg-series.json");
const MAX_PATH_DEPTH = 12;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

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

function aggregateByBucket(
  series: readonly TimeSeriesPoint[],
  getKey: (date: string) => string | null
): Map<string, TimeSeriesPoint> {
  const buckets = new Map<string, { sumVal: number; sumT: number; count: number }>();
  for (const pt of series) {
    const key = getKey(pt.date);
    if (!key) continue;
    const prev = buckets.get(key);
    if (prev) {
      prev.sumVal += pt.value;
      prev.sumT += pt.t;
      prev.count += 1;
    } else {
      buckets.set(key, { sumVal: pt.value, sumT: pt.t, count: 1 });
    }
  }
  const out = new Map<string, TimeSeriesPoint>();
  for (const [key, acc] of buckets.entries()) {
    out.set(key, {
      date: key,
      t: acc.sumT / acc.count,
      value: acc.sumVal / acc.count,
    });
  }
  return out;
}

function alignCompatibleSeries(
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
      sharedKeys.sort((ka, kb) => mapA.get(ka)!.t - mapA.get(kb)!.t);
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

class EtgStore {
  private nodes: Map<string, ETGNode> = new Map();
  private edges: Map<string, ETGEdge> = new Map();
  private seriesByNode: Map<string, TimeSeriesPoint[]> = new Map();
  private activity: EtgActivityEntry[] = [];
  private listeners: Set<EtgListener> = new Set();

  constructor() {
    this.loadInitialState();
  }

  private offloadNodeSeries(uuid: string, props: ETGNode["properties"]): ETGNode["properties"] {
    const { series, ...rest } = props;
    if (Array.isArray(series) && series.length > 0) {
      this.seriesByNode.set(uuid, series);
      return {
        ...rest,
        series_count: series.length,
      };
    }
    if (this.seriesByNode.has(uuid)) {
      return {
        ...rest,
        series_count: this.seriesByNode.get(uuid)!.length,
      };
    }
    return rest;
  }

  private loadInitialState() {
    if (process.env.NODE_ENV !== "test" && fs.existsSync(CACHE_FILE)) {
      try {
        if (fs.existsSync(SERIES_FILE)) {
          try {
            const rawSeries = fs.readFileSync(SERIES_FILE, "utf8");
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

        const raw = fs.readFileSync(CACHE_FILE, "utf8");
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
          if (migratedLegacySeries) {
            this.persistState();
          }
          return;
        }
      } catch {
        // Fall through to empty unseeded state
      }
    }
    this.nodes = new Map();
    this.edges = new Map();
    this.seriesByNode = new Map();
    this.activity = [];
  }

  private persistState() {
    if (process.env.NODE_ENV === "test") return;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const tmpPath = `${CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({
          nodes: Array.from(this.nodes.values()),
          edges: Array.from(this.edges.values()),
          activity: this.activity.slice(0, 40),
        }),
        "utf8"
      );
      fs.renameSync(tmpPath, CACHE_FILE);

      if (this.seriesByNode.size > 0) {
        const seriesTmpPath = `${SERIES_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(
          seriesTmpPath,
          JSON.stringify(Object.fromEntries(this.seriesByNode.entries())),
          "utf8"
        );
        fs.renameSync(seriesTmpPath, SERIES_FILE);
      } else if (fs.existsSync(SERIES_FILE)) {
        fs.unlinkSync(SERIES_FILE);
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
    this.activity = [];
    if (process.env.NODE_ENV !== "test") {
      try {
        if (fs.existsSync(CACHE_FILE)) {
          fs.unlinkSync(CACHE_FILE);
        }
        if (fs.existsSync(SERIES_FILE)) {
          fs.unlinkSync(SERIES_FILE);
        }
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
      const oppIds = new Set<string>();
      for (const e of this.edges.values()) {
        if (e.type === "drives_opposite") {
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

    const node: ETGNode = {
      uuid,
      label: validLabel,
      is_provisional: isProvisional,
      properties: this.offloadNodeSeries(uuid, {
        ...input.properties,
        name: input.properties.name.trim(),
        concept_name: input.properties.concept_name || input.properties.name.trim(),
        description: input.properties.description.trim(),
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
    silent?: boolean;
  }): ETGEdge {
    if (!this.nodes.has(input.source_uuid)) {
      throw new Error(`Source ETG node "${input.source_uuid}" not found.`);
    }
    if (!this.nodes.has(input.target_uuid)) {
      throw new Error(`Target ETG node "${input.target_uuid}" not found.`);
    }

    const uuid = input.uuid?.trim() || `edge-${crypto.randomUUID().slice(0, 8)}`;
    const edge: ETGEdge = {
      source_uuid: input.source_uuid,
      target_uuid: input.target_uuid,
      type: input.type,
      properties: {
        uuid,
        is_provisional: input.is_provisional ?? false,
        source_snippet: input.source_snippet || input.type,
        rationale: input.rationale,
        correlation_r: input.correlation_r,
        detrended_r: input.detrended_r,
        lag_days: input.lag_days,
        optimal_lag_steps: input.optimal_lag_steps,
        lag_unit: input.lag_unit,
        mechanism: input.mechanism,
        amplification_ratio: input.amplification_ratio,
        shared_shift_year: input.shared_shift_year,
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
        summary: `Linked ${input.source_uuid} —[${input.type}]→ ${input.target_uuid}`,
      });
      this.emitUpdate(act);
    }
    return edge;
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

    const scored: Array<{
      other: ETGNode;
      distKm: number;
      comp: ReturnType<typeof compareRegionalSeries>;
      effectiveR: number;
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
      const significant = comp.pValue < 0.05 || comp.detrendedPValue < 0.05;
      if (significant && Math.abs(effectiveR) >= 0.45) {
        scored.push({ other: cand.node, distKm: cand.distKm, comp, effectiveR });
      }
    }

    scored.sort((a, b) => Math.abs(b.effectiveR) - Math.abs(a.effectiveR));
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

    const latRaw = payload.lat ?? payload.latitude ?? existingTarget?.properties.lat;
    const lngRaw = payload.lng ?? payload.longitude ?? existingTarget?.properties.lng;
    const lat = typeof latRaw === "number" ? latRaw : Number(latRaw);
    const lng = typeof lngRaw === "number" ? lngRaw : Number(lngRaw);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

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
