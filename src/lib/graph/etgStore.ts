import crypto from "node:crypto";
import { compareRegionalSeries } from "@/lib/stats/trendEngine";
import type {
  CandidateLinkSuggestion,
  CausalPathSummary,
  CorroborationAudit,
  ETGAuthorType,
  ETGDatasetId,
  ETGEdge,
  ETGEdgeProperties,
  ETGNode,
  ETGNodeLabel,
  ETGRelationshipType,
  ETGWorkspaceBundle,
  EtgActivityEntry,
  GraphMlDatasetExport,
  GraphMlDatasetExportV2,
  GraphPredictionResult,
  OppositeTrendPair,
  ProspectiveForecastRecord,
  ProspectiveLedgerSummary,
  ProvenanceHop,
  SubgraphTraversalOptions,
  SubgraphTraversalResult,
  TimeSeriesPoint,
} from "@/types/etg";
import {
  DEFAULT_DATA_DIR,
  FORBIDDEN_PATH_SEGMENTS,
  aggregateSeriesByBucket,
  alignCompatibleSeries,
  assertValidEtgLabel,
  computeEtgNodeTrustScore,
  computeSparklinePreview,
  extractBucketKey,
  extractValueByPath,
  haversineKm,
  inferNodeTemporalScale,
  inferSeriesBucket,
  isCommunityContributorNode,
  mergeSeriesPoints,
  resolveDefaultAuthor,
  type EtgGraphSnapshot,
  type EtgListener,
  type EtgQueryFilter,
  type TemporalBucket,
} from "./store/etgSeriesAndTrustUtils";
import type { EtgPersistencePaths, EtgStoreContext } from "./store/etgStoreContext";
import {
  clearGraphOp,
  exportWorkspaceBundleOp,
  getPersistencePathsOp,
  importWorkspaceBundleOp,
  loadInitialStateOp,
  offloadNodeSeriesOp,
  persistStateOp,
  reconcileSeriesForTargetOp,
} from "./store/etgPersistence";
import {
  ensureGovernanceRulesOp,
  evaluateCorroborationOp,
  getBeliefLineageOp,
  reviseBeliefOp,
  wouldCreateSupersedesCycleOp,
} from "./store/etgCorroborationAndBelief";
import {
  autoConnectNodeOp,
  discoverConnectionsForSeriesNodeOp,
  ingestEonetSignalsOp,
  ingestHardwareWebhookOp,
  linkNearbyNodesOp,
} from "./store/etgIngestionAndAutoWire";
import {
  assembleRegionalContextSubgraphOp,
  discoverCandidateLinksOp,
  findAllPathsOp,
  getOppositeTrendPairsOp,
  queryGraphOp,
  traceShortestPathOp,
  traverseSubgraphOp,
} from "./store/etgTraversalAndDiscovery";
import {
  exportMlGraphDatasetOp,
  exportMlGraphDatasetV2Op,
  getProspectiveLedgerOp,
  logProspectiveForecastOp,
  reconcileProspectiveForecastsOp,
} from "./store/etgMlExportAndLedger";

export {
  alignCompatibleSeries,
  aggregateSeriesByBucket,
  assertValidEtgLabel,
  computeEtgNodeTrustScore,
  computeSparklinePreview,
  extractBucketKey,
  extractValueByPath,
  haversineKm,
  inferNodeTemporalScale,
  inferSeriesBucket,
  isCommunityContributorNode,
  type EtgGraphSnapshot,
  type EtgListener,
  type EtgQueryFilter,
  type TemporalBucket,
};

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
  private ctx: EtgStoreContext;

  constructor(options?: { persistDir?: string | null }) {
    if (options && options.persistDir !== undefined) {
      this.persistDir = options.persistDir;
    } else {
      const isTestEnv =
        process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
      this.persistDir = isTestEnv ? null : DEFAULT_DATA_DIR;
    }
    this.ctx = this.createContext();
    loadInitialStateOp(this.ctx);
  }

  private createContext(): EtgStoreContext {
    // Live getters/setters mirror instance properties so sub-operations and tests inspecting private state remain consistent.
    const self = this;
    return {
      get persistDir() {
        return self.persistDir;
      },
      set persistDir(v) {
        self.persistDir = v;
      },
      get loadingState() {
        return self.loadingState;
      },
      set loadingState(v) {
        self.loadingState = v;
      },
      get nodes() {
        return self.nodes;
      },
      set nodes(v) {
        self.nodes = v;
      },
      get edges() {
        return self.edges;
      },
      set edges(v) {
        self.edges = v;
      },
      get seriesByNode() {
        return self.seriesByNode;
      },
      set seriesByNode(v) {
        self.seriesByNode = v;
      },
      get multiScaleSeriesByNode() {
        return self.multiScaleSeriesByNode;
      },
      set multiScaleSeriesByNode(v) {
        self.multiScaleSeriesByNode = v;
      },
      get forecasts() {
        return self.forecasts;
      },
      set forecasts(v) {
        self.forecasts = v;
      },
      get activity() {
        return self.activity;
      },
      set activity(v) {
        self.activity = v;
      },
      get listeners() {
        return self.listeners;
      },
      getPersistencePaths: (baseDir) => self.getPersistencePaths(baseDir),
      reconcileSeriesForTarget: (targetUuid, series) =>
        self.reconcileSeriesForTarget(targetUuid, series),
      offloadNodeSeries: (uuid, props) => self.offloadNodeSeries(uuid, props),
      persistState: () => self.persistState(),
      pushActivity: (entry) => self.pushActivity(entry),
      emitUpdate: (activity) => self.emitUpdate(activity),
      computeStats: () => self.computeStats(),
      getSnapshot: () => self.getSnapshot(),
      getNodeSeries: (uuid) => self.getNodeSeries(uuid),
      setNodeMultiScaleSeries: (uuid, scale, series, silent) =>
        self.setNodeMultiScaleSeries(uuid, scale, series, silent),
      getNodeMultiScaleSeries: (uuid, requestedScale) =>
        self.getNodeMultiScaleSeries(uuid, requestedScale),
      computeNodeTrustScore: (node) => self.computeNodeTrustScore(node),
      ensureGovernanceRules: () => self.ensureGovernanceRules(),
      evaluateCorroboration: (nodeUuid, emit) => self.evaluateCorroboration(nodeUuid, emit),
      wouldCreateSupersedesCycle: (sourceUuid, targetUuid, ignoreEdgeUuid) =>
        self.wouldCreateSupersedesCycle(sourceUuid, targetUuid, ignoreEdgeUuid),
      hasEdgeBetween: (uuidA, uuidB, directed, allowedTypes) =>
        self.hasEdgeBetween(uuidA, uuidB, directed, allowedTypes),
      getEdgeWeight: (edge) => self.getEdgeWeight(edge),
      traverseSubgraph: (options) => self.traverseSubgraph(options),
      getOppositeTrendPairs: (nodeSubset) => self.getOppositeTrendPairs(nodeSubset),
      linkNearbyNodes: (sourceNode, radiusKm) => self.linkNearbyNodes(sourceNode, radiusKm),
      discoverConnectionsForSeriesNode: (anchorNode) =>
        self.discoverConnectionsForSeriesNode(anchorNode),
    };
  }

  private getPersistencePaths(baseDir?: string | null): EtgPersistencePaths | null {
    return getPersistencePathsOp(this.persistDir, baseDir);
  }

  private reconcileSeriesForTarget(
    targetUuid: string,
    series: readonly TimeSeriesPoint[]
  ): number {
    return reconcileSeriesForTargetOp(this.ctx, targetUuid, series);
  }

  private offloadNodeSeries(uuid: string, props: ETGNode["properties"]): ETGNode["properties"] {
    return offloadNodeSeriesOp(this.ctx, uuid, props);
  }

  private persistState() {
    persistStateOp(this.ctx);
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
    return clearGraphOp(this.ctx, notify);
  }

  ensureGovernanceRules(): { mkRule: ETGNode; corrRule: ETGNode } {
    return ensureGovernanceRulesOp(this.ctx);
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
  }) {
    return assembleRegionalContextSubgraphOp(this.ctx, options);
  }

  getOppositeTrendPairs(nodeSubset?: Set<string>): OppositeTrendPair[] {
    return getOppositeTrendPairsOp(this.ctx, nodeSubset);
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
    return queryGraphOp(this.ctx, filter);
  }

  createNode(input: {
    uuid?: string;
    label: string;
    is_provisional?: boolean;
    properties: Partial<ETGNode["properties"]> & { name: string; description: string };
    silent?: boolean;
  }): ETGNode {
    const validLabel = assertValidEtgLabel(input.label);
    const requestedUuid = input.uuid?.trim();
    if (requestedUuid && (FORBIDDEN_PATH_SEGMENTS.has(requestedUuid) || requestedUuid.length > 200)) {
      throw new Error(`Invalid node UUID "${requestedUuid}".`);
    }
    const uuid =
      requestedUuid ||
      `${validLabel.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
    const rawName = typeof input.properties?.name === "string" ? input.properties.name.trim() : "";
    const rawDesc = typeof input.properties?.description === "string" ? input.properties.description.trim() : "";
    if (!rawName || rawName.length > 240) {
      throw new Error("Node name must be 1..240 characters.");
    }
    if (rawDesc.length > 4000) {
      throw new Error("Node description must not exceed 4000 characters.");
    }
    if (
      input.properties?.lat !== undefined &&
      (typeof input.properties.lat !== "number" ||
        !Number.isFinite(input.properties.lat) ||
        input.properties.lat < -90 ||
        input.properties.lat > 90)
    ) {
      throw new Error(`Invalid node latitude ${String(input.properties.lat)}.`);
    }
    if (
      input.properties?.lng !== undefined &&
      (typeof input.properties.lng !== "number" ||
        !Number.isFinite(input.properties.lng) ||
        input.properties.lng < -180 ||
        input.properties.lng > 180)
    ) {
      throw new Error(`Invalid node longitude ${String(input.properties.lng)}.`);
    }
    const now = new Date().toISOString();
    const isProvisional = input.is_provisional ?? (validLabel === "Signal" ? false : true);

    const authoredBy = resolveDefaultAuthor(input.properties);
    const node: ETGNode = {
      uuid,
      label: validLabel,
      is_provisional: isProvisional,
      properties: this.offloadNodeSeries(uuid, {
        ...input.properties,
        name: rawName,
        concept_name: input.properties.concept_name || rawName,
        description: rawDesc,
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

  private wouldCreateSupersedesCycle(
    sourceUuid: string,
    targetUuid: string,
    ignoreEdgeUuid?: string
  ): boolean {
    return wouldCreateSupersedesCycleOp(this.ctx, sourceUuid, targetUuid, ignoreEdgeUuid);
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
    if (input.source_uuid === input.target_uuid) {
      throw new Error("Self-loop connections (source === target) are disallowed.");
    }
    const requestedEdgeUuid = input.uuid?.trim();
    if (requestedEdgeUuid && (FORBIDDEN_PATH_SEGMENTS.has(requestedEdgeUuid) || requestedEdgeUuid.length > 200)) {
      throw new Error(`Invalid edge UUID "${requestedEdgeUuid}".`);
    }
    const srcNode = this.nodes.get(input.source_uuid);
    if (!srcNode) {
      throw new Error(`Source ETG node "${input.source_uuid}" not found.`);
    }
    const dstNode = this.nodes.get(input.target_uuid);
    if (!dstNode) {
      throw new Error(`Target ETG node "${input.target_uuid}" not found.`);
    }
    if (
      input.type === "supersedes" &&
      this.wouldCreateSupersedesCycle(input.source_uuid, input.target_uuid)
    ) {
      throw new Error(
        `Supersedes cycle rejected: ${input.source_uuid} -[supersedes]-> ${input.target_uuid} would create a cyclic belief-revision loop.`
      );
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
    if (nextSource === nextTarget) {
      throw new Error("Self-loop connections (source === target) are disallowed.");
    }
    if (!this.nodes.has(nextSource) || !this.nodes.has(nextTarget)) {
      throw new Error("Updated edge endpoint node not found.");
    }

    const { type: typePatch, source_uuid: _s, target_uuid: _t, ...propPatch } = patch;
    const nextType = typePatch ?? existing.type;
    if (
      nextType === "supersedes" &&
      this.wouldCreateSupersedesCycle(nextSource, nextTarget, edgeUuid)
    ) {
      throw new Error(
        `Supersedes cycle rejected: ${nextSource} -[supersedes]-> ${nextTarget} would create a cyclic belief-revision loop.`
      );
    }
    const updated: ETGEdge = {
      source_uuid: nextSource,
      target_uuid: nextTarget,
      type: nextType,
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
    return evaluateCorroborationOp(this.ctx, nodeUuid, emit);
  }

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
    return reviseBeliefOp(this.ctx, params);
  }

  getBeliefLineage(nodeUuid: string): ETGNode[] {
    return getBeliefLineageOp(this.ctx, nodeUuid);
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

  private linkNearbyNodes(
    sourceNode: ETGNode,
    radiusKm = 450
  ) {
    return linkNearbyNodesOp(this.ctx, sourceNode, radiusKm);
  }

  private discoverConnectionsForSeriesNode(anchorNode: ETGNode): {
    discoveredEdges: ETGEdge[];
  } {
    return discoverConnectionsForSeriesNodeOp(this.ctx, anchorNode);
  }

  autoConnectNode(
    nodeUuid: string,
    emit = false
  ): {
    linkedInsights: ETGNode[];
    linkedSignals: ETGNode[];
    corroborationAudits: CorroborationAudit[];
    discoveredConnections: ETGEdge[];
  } {
    return autoConnectNodeOp(this.ctx, nodeUuid, emit);
  }

  ingestHardwareWebhook(
    nodeId: string,
    payload: Record<string, unknown>,
    queryParams: Record<string, string | undefined> = {}
  ) {
    return ingestHardwareWebhookOp(this.ctx, nodeId, payload, queryParams);
  }

  ingestEonetSignals(signals: ETGNode[]): { added: number; updated: number; linkedEdges: number } {
    return ingestEonetSignalsOp(this.ctx, signals);
  }

  traceShortestPath(fromUuid: string, toUuid: string, maxHops = 6): ProvenanceHop[] | null {
    return traceShortestPathOp(this.ctx, fromUuid, toUuid, maxHops);
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

  traverseSubgraph(options: SubgraphTraversalOptions): SubgraphTraversalResult {
    return traverseSubgraphOp(this.ctx, options);
  }

  findAllPaths(fromUuid: string, toUuid: string, maxHops = 5): CausalPathSummary[] {
    return findAllPathsOp(this.ctx, fromUuid, toUuid, maxHops);
  }

  discoverCandidateLinks(options?: {
    anchorUuid?: string;
    minAbsR?: number;
    limit?: number;
  }): CandidateLinkSuggestion[] {
    return discoverCandidateLinksOp(this.ctx, options);
  }

  exportMlGraphDataset(options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
  }): GraphMlDatasetExport {
    return exportMlGraphDatasetOp(this.ctx, options);
  }

  exportMlGraphDatasetV2(options?: {
    rootUuid?: string;
    maxHops?: number;
    bucket?: TemporalBucket;
    trainFraction?: number;
    trainCutoffDate?: string;
    horizonSteps?: number;
  }): GraphMlDatasetExportV2 {
    return exportMlGraphDatasetV2Op(this.ctx, options);
  }

  logProspectiveForecast(prediction: GraphPredictionResult): ProspectiveForecastRecord {
    return logProspectiveForecastOp(this.ctx, prediction);
  }

  reconcileProspectiveForecasts(targetUuid?: string): {
    scoredNow: number;
    ledger: {
      records: ProspectiveForecastRecord[];
      summary: ProspectiveLedgerSummary;
    };
  } {
    return reconcileProspectiveForecastsOp(this.ctx, targetUuid);
  }

  getProspectiveLedger(targetUuid?: string): {
    records: ProspectiveForecastRecord[];
    summary: ProspectiveLedgerSummary;
  } {
    return getProspectiveLedgerOp(this.ctx, targetUuid);
  }

  exportWorkspaceBundle(): ETGWorkspaceBundle {
    return exportWorkspaceBundleOp(this.ctx);
  }

  importWorkspaceBundle(
    rawBundle: Partial<ETGWorkspaceBundle>,
    options?: { merge?: boolean }
  ): {
    importedNodes: number;
    importedEdges: number;
    snapshot: EtgGraphSnapshot;
  } {
    return importWorkspaceBundleOp(this.ctx, rawBundle, options);
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
