import type {
  CorroborationAudit,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  EtgActivityEntry,
  OppositeTrendPair,
  ProspectiveForecastRecord,
  SubgraphTraversalOptions,
  SubgraphTraversalResult,
  TimeSeriesPoint,
} from "@/types/etg";
import type {
  EtgGraphSnapshot,
  EtgListener,
  TemporalBucket,
} from "./etgSeriesAndTrustUtils";

export interface EtgPersistencePaths {
  dir: string;
  stateFile: string;
  seriesFile: string;
  multiscaleFile: string;
  forecastsFile: string;
}

export interface EtgStoreContext {
  persistDir: string | null;
  loadingState: boolean;
  nodes: Map<string, ETGNode>;
  edges: Map<string, ETGEdge>;
  seriesByNode: Map<string, TimeSeriesPoint[]>;
  multiScaleSeriesByNode: Map<
    string,
    Partial<Record<TemporalBucket, TimeSeriesPoint[]>>
  >;
  forecasts: Map<string, ProspectiveForecastRecord>;
  activity: EtgActivityEntry[];
  listeners: Set<EtgListener>;

  getPersistencePaths(baseDir?: string | null): EtgPersistencePaths | null;
  reconcileSeriesForTarget(targetUuid: string, series: readonly TimeSeriesPoint[]): number;
  offloadNodeSeries(uuid: string, props: ETGNode["properties"]): ETGNode["properties"];
  persistState(): void;
  pushActivity(entry: Omit<EtgActivityEntry, "id" | "timestamp">): EtgActivityEntry;
  emitUpdate(activity?: EtgActivityEntry): void;
  computeStats(): EtgGraphSnapshot["stats"];
  getSnapshot(): EtgGraphSnapshot;
  getNodeSeries(uuid: string): TimeSeriesPoint[] | undefined;
  setNodeMultiScaleSeries(
    uuid: string,
    scale: TemporalBucket,
    series: readonly TimeSeriesPoint[],
    silent?: boolean
  ): boolean;
  getNodeMultiScaleSeries(
    uuid: string,
    requestedScale?: TemporalBucket
  ): TimeSeriesPoint[] | undefined;
  computeNodeTrustScore(node: ETGNode): number;
  ensureGovernanceRules(): { mkRule: ETGNode; corrRule: ETGNode };
  evaluateCorroboration(nodeUuid: string, emit?: boolean): CorroborationAudit;
  wouldCreateSupersedesCycle(
    sourceUuid: string,
    targetUuid: string,
    ignoreEdgeUuid?: string
  ): boolean;
  hasEdgeBetween(
    uuidA: string,
    uuidB: string,
    directed?: boolean,
    allowedTypes?: ReadonlySet<ETGRelationshipType>
  ): boolean;
  getEdgeWeight(edge: ETGEdge): number;
  traverseSubgraph(options: SubgraphTraversalOptions): SubgraphTraversalResult;
  getOppositeTrendPairs(nodeSubset?: Set<string>): OppositeTrendPair[];
  linkNearbyNodes(
    sourceNode: ETGNode,
    radiusKm?: number
  ): {
    linkedInsights: ETGNode[];
    linkedSignals: ETGNode[];
    corroborationAudits: CorroborationAudit[];
  };
  discoverConnectionsForSeriesNode(anchorNode: ETGNode): {
    discoveredEdges: ETGEdge[];
  };
}
