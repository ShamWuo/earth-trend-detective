export const ETG_NODE_LABELS = ["Concept", "Signal", "Insight", "Rule"] as const;
export type ETGNodeLabel = (typeof ETG_NODE_LABELS)[number];

export const FORBIDDEN_SAAS_LABELS = new Set([
  "Variable",
  "Logic",
  "Task",
  "Goal",
  "Doc",
  "Note",
  "Project",
  "Calendar",
  "Billing",
]);

export type ETGDatasetId =
  | "nasa_power"
  | "wildfire"
  | "ocean_temp"
  | "air_quality"
  | "deforestation"
  | "hydrology"
  | "community";

export type ETGRelationshipType =
  | "supports"
  | "corroborates"
  | "drives_opposite"
  | "correlates_with"
  | "teleconnects"
  | "verified_by"
  | "supersedes"
  | "monitors"
  | "relates_to"
  | "leads"
  | "amplifies"
  | "dampens"
  | "advects_to"
  | "triggers"
  | "impacts"
  | "hypothesized_link";

export type ETGPhenomenonType =
  | "climate_trend"
  | "discrete_event"
  | "climate_index"
  | "physical_impact"
  | "sensor_station"
  | "earth_system";

export type ETGAuthorType =
  | "human"
  | "ai"
  | "satellite_pipeline"
  | "iot_sensor";

export type ETGProducerType =
  | "nasa_satellite"
  | "community_camera"
  | "iot_sensor"
  | "ai_synthesis"
  | "research_station";

export interface ETGDatasetMeta {
  id: ETGDatasetId;
  label: string;
  shortLabel: string;
  color: string;
  unit: string;
  slopeUnit: string;
  sourceName: string;
  description: string;
  studentPlainSummary: string;
  whyItMatters: string;
}

export interface ETGNodeProperties {
  name: string;
  concept_name?: string;
  description: string;
  status?: "Active" | "Provisional" | "Superseded" | "Monitoring";
  importance?: number;
  lat?: number;
  lng?: number;
  region?: string;
  dataset?: ETGDatasetId;
  phenomenon_type?: ETGPhenomenonType;
  domain_tags?: string[];
  authored_by?: ETGAuthorType;
  producer_type?: ETGProducerType;
  device_id?: string;
  confidence?: number;
  value?: number;
  unit?: string;
  p_value?: number;
  p_value_adjusted?: number;
  ols_r2?: number;
  regime_shift_year?: string;
  theil_sen_slope?: number;
  slope_unit?: string;
  superseded_by?: string;
  observed_at?: string;
  created_at: string;
  series?: TimeSeriesPoint[];
  series_count?: number;
  sparkline_preview?: number[];
  temporal_scale?: "day" | "month" | "year" | "impulse";
  available_scales?: Array<"day" | "month" | "year">;
  channel_names?: string[];
  elevation_m?: number;
  event_intensity?: number;
  event_decay_days?: number;
  event_ended_at?: string;
  trust_score?: number;
  community_lift_pct?: number;
  parameter?: string;
  provenance_source?: TrendAnalysisSummary["provenance"];
  source_url?: string;
  source_system?: string;
  corroborated?: boolean;
  independent_sources_count?: number;
  tags?: string[];
  custom_metadata?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export interface ETGNode {
  uuid: string;
  label: ETGNodeLabel;
  is_provisional?: boolean;
  properties: ETGNodeProperties;
}

export interface ETGEdgeProperties {
  uuid: string;
  is_provisional: boolean;
  source_snippet: string;
  rationale?: string;
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
  causal_polarity?: "positive" | "negative" | "complex";
  custom_label?: string;
  predictive_lift_pct?: number;
  cross_scale?: boolean;
  valid_from?: string;
  superseded_at?: string;
  rolling_corr_tail?: number;
  community_verified?: boolean;
  created_at?: string;
  [key: string]: unknown;
}

export interface ETGEdge {
  source_uuid: string;
  target_uuid: string;
  type: ETGRelationshipType;
  properties: ETGEdgeProperties;
}

export interface TimeSeriesPoint {
  date: string; // ISO or YYYY-MM
  t: number; // Fractional year or sequential step
  value: number;
  channels?: Record<string, number>;
}

export interface MannKendallResult {
  n: number;
  s: number;
  varS: number;
  zScore: number;
  pValue: number;
  tau: number;
  significant: boolean;
  alpha: number;
  direction: "increasing" | "decreasing" | "no_trend";
  /** Hamed & Rao (1998) lag-1 residual autocorrelation coefficient */
  lag1Autocorrelation: number;
  /** Hamed & Rao (1998) effective sample size n* adjusted for serial correlation */
  effectiveSampleSize: number;
  /** Hamed & Rao (1998) autocorrelation-corrected Z statistic */
  zScoreAdjusted: number;
  /** Hamed & Rao (1998) autocorrelation-corrected two-tailed p-value */
  pValueAdjusted: number;
  /** Whether trend remains statistically significant after serial correlation adjustment */
  significantAdjusted: boolean;
}

export interface OlsRegressionResult {
  slope: number;
  intercept: number;
  rSquared: number;
  tStat: number;
  pValue: number;
}

export interface PettittChangePointResult {
  index: number;
  date: string;
  kStat: number;
  pValue: number;
  significant: boolean;
}

export interface TheilSenResult {
  slope: number;
  intercept: number;
  slopeLow95: number;
  slopeHigh95: number;
  pairCount: number;
}

export interface SeasonalMannKendallResult {
  seasonsDetected: number;
  totalPairs: number;
  s: number;
  varS: number;
  zScore: number;
  pValue: number;
  significant: boolean;
  direction: "increasing" | "decreasing" | "no_trend";
  seasonalTheilSenSlope: number;
  deseasonalizedValues: number[];
}

export interface TrendAnalysisPoint {
  date: string;
  t: number;
  value: number;
  movingAverage: number;
  theilSenFit: number;
  zScore: number;
  anomalyValue?: number;
}

export type TrendProvenanceSource =
  | "NASA POWER MERRA-2 (Live)"
  | "NASA GES DISC / POWER Hydrology (Live)"
  | "NASA GISTEMP v4 (Live)"
  | "NOAA GML CO2 (Live)"
  | "NOAA/NSIDC Sea Ice v4 (Live)"
  | "NOAA NCEI CDO (Live)"
  | "KNMI Climate Explorer (Live)"
  | "CSA / Geo.ca Hydrometric & AHCCD (Live)"
  | "USGS / NASA SeaWiFS Coastal Plume (Live)"
  | "USGS NWIS River Gauge (Live)"
  | "Copernicus GloFAS v4 (Live)"
  | "NASA POWER AOD_55 (Live)"
  | "Copernicus CAMS PM2.5 (Live)"
  | "NASA POWER Evapotranspiration (Live)"
  | "Empirical Dataset (Imported)";

export interface TrendAnalysisSummary {
  lat: number;
  lng: number;
  dataset: ETGDatasetId;
  parameter: string;
  unit: string;
  slopeUnit: string;
  provenance: TrendProvenanceSource;
  measurementKind?: "direct_observation" | "reanalysis_physical" | "meteorological_proxy";
  proxyNote?: string;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  latestValue: number;
  latestAnomalyZ: number;
  mannKendall: MannKendallResult;
  theilSen: TheilSenResult;
  ols: OlsRegressionResult;
  changePoint: PettittChangePointResult | null;
  seasonalAnalysis?: SeasonalMannKendallResult | null;
  seasonalPoints?: Array<{
    date: string;
    t: number;
    value: number;
    anomalyValue: number;
  }>;
  verdict:
    | "Statistically Significant Increasing Trend"
    | "Statistically Significant Decreasing Trend"
    | "Normal Environmental Variability";
  points: TrendAnalysisPoint[];
}

export type TemperatureUnit = "C" | "F";

export type RelationCategory =
  | "opposite"
  | "causal"
  | "coupled"
  | "corroboration";

export interface CurrentEarthConditions {
  lat: number;
  lng: number;
  observedAt: string;
  timezone: string | null;
  elevationM: number | null;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  todayMaxC: number | null;
  todayMinC: number | null;
  relativeHumidityPct: number | null;
  precipitationMm: number | null;
  windSpeedKmh: number | null;
  windGustsKmh: number | null;
  windDirectionDeg: number | null;
  windCardinal: string | null;
  cloudCoverPct: number | null;
  surfacePressureHpa: number | null;
  shortwaveRadiationWm2: number | null;
  weatherCode: number | null;
  weatherLabel: string;
  isDay: boolean | null;
  pm25: number | null;
  pm10: number | null;
  usAqi: number | null;
  aqiCategory: string | null;
  uvIndex: number | null;
  source: string;
}

export type TelemetryFeedStatus = "ok" | "unavailable" | "failed_to_fetch";

export type TelemetryFailureKind = "failed_to_fetch" | "unavailable";

export interface CurrentFeedDiagnostics {
  weatherStatus: TelemetryFeedStatus;
  weatherReason?: string;
  airQualityStatus: TelemetryFeedStatus;
  airQualityReason?: string;
}

export interface DatasetTelemetryDiagnostic {
  dataset: ETGDatasetId;
  status: TelemetryFailureKind;
  reason: string;
}

export interface TelemetryQueryDiagnostics {
  current?: CurrentFeedDiagnostics;
  datasets?: DatasetTelemetryDiagnostic[];
}

export type EarthSphere =
  | "Atmosphere"
  | "Ocean"
  | "Cryosphere"
  | "Hydrosphere"
  | "Biosphere";

export interface LagProfilePoint {
  lagSteps: number;
  r: number;
  pValue: number;
  n: number;
}

export interface RollingCorrelationPoint {
  date: string;
  r: number;
  detrendedR: number;
}

export type CouplingRegime =
  | "Synchronized Regime Shift"
  | "Year-to-Year Teleconnection"
  | "Compound Trend & Variability"
  | "Secular Co-Drift (Weak Short-Term)"
  | "Decoupled";

export interface CrossRegionComparison {
  pearsonR: number;
  spearmanRho: number;
  pValue: number;
  detrendedR: number;
  detrendedPValue: number;
  optimalLagSteps: number;
  optimalLagR: number;
  optimalLagPValue: number;
  lagUnit: "months" | "years" | "days";
  lagProfile: LagProfilePoint[];
  rollingCorrelations: RollingCorrelationPoint[];
  slopeRatio: number;
  slopeA?: number;
  slopeB?: number;
  sharedRegimeShiftYear: number | null;
  mechanism: string;
  couplingRegime: CouplingRegime;
  classification: "opposite_teleconnection" | "co_trending" | "decoupled";
  isSecularDriftOnly?: boolean;
  fdrQValue?: number;
  alignedPoints: Array<{
    date: string;
    zA: number;
    zB: number;
    detrendedZA: number;
    detrendedZB: number;
    rawA: number;
    rawB: number;
  }>;
}

export interface EarthCascadeStep {
  nodeUuid: string;
  nodeName: string;
  sphere: EarthSphere;
  dataset?: ETGDatasetId;
  edgeUuid?: string;
  edgeType?: ETGRelationshipType;
  correlationR?: number;
  detrendedR?: number;
  lagSteps?: number;
  lagUnit?: "months" | "years" | "days";
  mechanism?: string;
}

export interface EarthCascadeChain {
  id: string;
  title: string;
  summary: string;
  spheres: EarthSphere[];
  nodeUuids: string[];
  edgeUuids: string[];
  steps: EarthCascadeStep[];
  meanAbsR: number;
  score: number;
}

export interface ProvenanceHop {
  nodeUuid: string;
  name: string;
  label: ETGNodeLabel;
  edgeType?: ETGRelationshipType;
  depth: number;
}

export interface CorroborationAudit {
  nodeUuid: string;
  supportingSources: Array<{
    uuid: string;
    name: string;
    label: ETGNodeLabel;
    producerType: ETGProducerType;
  }>;
  distinctProducerTypes: ETGProducerType[];
  corroborated: boolean;
  requiredSources: number;
  gateRuleUuid: string;
}

export interface OppositeTrendPair {
  edgeUuid: string;
  source: ETGNode;
  target: ETGNode;
  correlationR?: number;
  detrendedR?: number;
  lagDays?: number;
  optimalLagSteps?: number;
  mechanism?: string;
  rationale: string;
}

export interface EtgActivityEntry {
  id: string;
  timestamp: string;
  kind:
    | "webhook"
    | "mcp"
    | "eonet"
    | "revision"
    | "corroboration"
    | "probe"
    | "discovery"
    | "dataset"
    | "prediction";
  summary: string;
  nodeUuid?: string;
}

export type TraversalDirection = "upstream" | "downstream" | "both";
export type SubgraphNodeRole = "root" | "upstream" | "downstream" | "bidirectional";

export interface SubgraphTraversalOptions {
  rootUuid: string;
  maxHops?: number;
  direction?: TraversalDirection;
  edgeTypes?: ETGRelationshipType[];
  minWeight?: number;
  includeSuperseded?: boolean;
}

export interface CausalPathSummary {
  nodeUuids: string[];
  edgeUuids: string[];
  cumulativeLagSteps: number;
  score: number;
  summary: string;
}

export interface SubgraphTraversalResult {
  rootUuid: string;
  maxHops: number;
  direction: TraversalDirection;
  nodes: ETGNode[];
  edges: ETGEdge[];
  hopByNode: Record<string, number>;
  roleByNode: Record<string, SubgraphNodeRole>;
  causalPaths: CausalPathSummary[];
}

export interface CandidateLinkSuggestion {
  id: string;
  sourceUuid: string;
  targetUuid: string;
  sourceName: string;
  targetName: string;
  suggestedType: ETGRelationshipType;
  pearsonR?: number;
  detrendedR?: number;
  pValue?: number;
  fdrQValue?: number;
  isSecularDriftOnly?: boolean;
  optimalLagSteps?: number;
  lagUnit?: "days" | "months" | "years";
  distanceKm?: number;
  bearingDeg?: number;
  microscopeCouplingProb?: number;
  confounderProb?: number;
  score: number;
  mechanism: string;
  rationale: string;
}

export interface PredictorEvalMetrics {
  rmse: number;
  mae: number;
  r2: number;
  skillVsPersistencePct: number;
}

export interface GraphNeighborContribution {
  nodeUuid: string;
  nodeName: string;
  edgeUuid?: string;
  edgeType: string;
  lagSteps: number;
  correlationR: number;
  standardizedWeight: number;
  sharePct: number;
  ablationLiftPct?: number;
  isCandidatePreview?: boolean;
}

export type GraphPredictorModelKind =
  | "linear_ridge"
  | "nonlinear_interaction"
  | "stacked_ensemble";

export type GraphPredictionEngineUsed =
  | "l4_inductive_gnn"
  | "local_inductive_gnn"
  | "stacked_ensemble"
  | "nonlinear_interaction"
  | "linear_ridge"
  | "self_ar"
  | "persistence";

export interface TrendEmergenceForecast {
  direction: "increasing" | "decreasing" | "stable";
  probabilities: {
    increasing: number;
    decreasing: number;
    stable: number;
  };
  regimeShiftProb: number;
  predictedSlopePerStep: number;
}

export interface CommunityImpactSummary {
  communityNodesEvaluated: number;
  communityNodesActive: number;
  trustGatedCount: number;
  marginalCommunityLiftPct: number;
  topContributors: Array<{
    uuid: string;
    name: string;
    liftPct: number;
    trustScore: number;
  }>;
}

export interface GraphPredictionResult {
  targetUuid: string;
  targetName: string;
  unit: string;
  bucket: "day" | "month" | "year";
  sampleCount: number;
  trainCount: number;
  testCount: number;
  horizonSteps: number;
  persistence: PredictorEvalMetrics;
  selfOnly: PredictorEvalMetrics;
  graphAware: PredictorEvalMetrics;
  skillLiftVsSelfPct: number;
  recommendedModel: "graph_aware" | "self_ar" | "persistence";
  activeGraphArchitecture?: GraphPredictorModelKind;
  engineUsed?: GraphPredictionEngineUsed;
  nonlinearSkillGainPct?: number;
  recommendedForecastValue: number;
  quantiles?: {
    p10: number;
    p50: number;
    p90: number;
  };
  scalesUsed?: Array<"day" | "month" | "year" | "impulse">;
  trendForecast?: TrendEmergenceForecast;
  communityImpact?: CommunityImpactSummary;
  regionQuery?: {
    lat: number;
    lng: number;
    dataset: ETGDatasetId;
    synthesizedAnchor: boolean;
  };
  reliabilityWarning?: string;
  nextForecast: {
    nextPeriodLabel: string;
    lastActual: number;
    persistencePred: number;
    selfOnlyPred: number;
    graphAwarePred: number;
    ci95HalfWidth: number;
  };
  backtest: Array<{
    date: string;
    actual: number;
    persistence: number;
    selfOnly: number;
    graphAware: number;
  }>;
  neighborContributions: GraphNeighborContribution[];
  summary: string;
}

export type ProspectiveForecastStatus = "pending" | "scored";

export interface ProspectiveForecastRecord {
  id: string;
  target_uuid: string;
  target_name: string;
  unit: string;
  bucket: "day" | "month" | "year";
  issued_at: string;
  issued_from_period: string;
  target_period: string;
  last_actual: number;
  predicted_value: number;
  self_only_pred: number;
  persistence_pred: number;
  ci95_half_width: number;
  recommended_model: "graph_aware" | "self_ar" | "persistence";
  architecture?: GraphPredictorModelKind;
  driver_uuids: string[];
  status: ProspectiveForecastStatus;
  actual_value?: number;
  reconciled_at?: string;
  abs_error?: number;
  self_abs_error?: number;
  persistence_abs_error?: number;
  covered_by_ci95?: boolean;
}

export interface ProspectiveLedgerSummary {
  total_logged: number;
  pending_count: number;
  scored_count: number;
  mean_abs_error: number | null;
  self_mean_abs_error: number | null;
  persistence_mean_abs_error: number | null;
  ci95_coverage_pct: number | null;
  skill_vs_self_pct: number | null;
}

export interface GraphMlDatasetExport {
  schema_version: "etg-ml-v1";
  bucket: "day" | "month" | "year";
  node_ids: string[];
  node_metadata: Array<{
    index: number;
    uuid: string;
    label: ETGNodeLabel;
    name: string;
    dataset?: string;
    phenomenon_type?: string;
    lat?: number;
    lng?: number;
    slope_per_decade?: number;
    p_value?: number;
  }>;
  edge_index: [number[], number[]];
  edge_types: ETGRelationshipType[];
  edge_attr_names: string[];
  edge_attr: number[][];
  time_index: string[];
  feature_names: string[];
  feature_tensor: number[][][];
  mask_tensor: number[][];
}

export interface GraphMlDatasetExportV2 {
  schema_version: "etg-ml-v2";
  primary_bucket: "day" | "month" | "year";
  train_cutoff_index: number;
  node_ids: string[];
  node_metadata: Array<{
    index: number;
    uuid: string;
    label: ETGNodeLabel;
    name: string;
    dataset?: string;
    sphere: EarthSphere;
    temporal_scale: "day" | "month" | "year" | "impulse";
    phenomenon_type?: string;
    lat?: number;
    lng?: number;
    elevation_m?: number;
    trust_score: number;
    is_community: boolean;
    corroborated: boolean;
    slope_per_decade?: number;
    p_value?: number;
  }>;
  node_static_feature_names: string[];
  node_static_features: number[][];
  edge_index: [number[], number[]];
  edge_types: ETGRelationshipType[];
  edge_attr_names: string[];
  edge_attr: number[][];
  time_index: string[];
  feature_names: string[];
  feature_tensor: number[][][];
  mask_tensor: number[][];
  multi_scale_blocks: Partial<
    Record<
      "day" | "month" | "year",
      {
        time_index: string[];
        node_indices: number[];
        feature_tensor: number[][][];
        mask_tensor: number[][];
      }
    >
  >;
  labels: {
    horizon_steps: number;
    next_value_targets: Array<Array<number | null>>;
    trend_class_targets: Array<Array<number | null>>;
    regime_shift_targets: Array<Array<number | null>>;
  };
  normalization?: Array<{
    mean: number;
    std: number;
  }>;
}

export interface ETGWorkspaceBundle {
  schema_version: "etg-workspace-v1";
  exported_at: string;
  nodes: ETGNode[];
  edges: ETGEdge[];
  series_by_node: Record<string, TimeSeriesPoint[]>;
  multi_scale_series_by_node?: Record<
    string,
    Partial<Record<"day" | "month" | "year", TimeSeriesPoint[]>>
  >;
  activity?: EtgActivityEntry[];
  prospective_forecasts?: ProspectiveForecastRecord[];
}

export type TrendMicroscopeRadarBadge =
  | "EARLY_ONSET"
  | "SECULAR_ACCELERATION"
  | "FALSE_TREND_CYCLE"
  | "SENSOR_GLITCH_RISK"
  | "NOMINAL";

export interface NodeTrendMicroscopeCue {
  uuid: string;
  name: string;
  radarBadge: TrendMicroscopeRadarBadge;
  onsetProb: number;
  preMannKendallAlert: boolean;
  mkAbsZ: number;
  emergingDirection: "increasing" | "decreasing" | "stable";
  leadStepsAhead: number;
  dealiasing: {
    secularShare: number;
    oscillationShare: number;
    artifactShare: number;
    falseTrendProb: number;
  };
  trustGate: number;
  aiCue: string;
}

export interface LinkTrendMicroscopeCue {
  sourceUuid: string;
  targetUuid: string;
  sourceName: string;
  targetName: string;
  alreadyWired: boolean;
  trueCouplingProb: number;
  confounderProb: number;
  polarity: "drives_opposite" | "co_trending" | "none";
  optimalLagSteps: number;
  rawPeakR: number;
  cleanPeakR: number;
  aiCue: string;
}

export interface TrendMicroscopeScanResult {
  schemaVersion: "etg-trend-microscope-v1";
  engineUsed: "l4_microscope" | "local_microscope_weights" | "fallback_calibrated";
  nodeCount: number;
  nodes: NodeTrendMicroscopeCue[];
  verifiedCouplings: LinkTrendMicroscopeCue[];
  suppressedIllusions: LinkTrendMicroscopeCue[];
  aiPerceptionBrief: string;
}
