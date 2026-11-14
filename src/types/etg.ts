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
  | "relates_to";

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
  parameter?: string;
  provenance_source?: TrendAnalysisSummary["provenance"];
  source_url?: string;
  source_system?: string;
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

export interface TrendAnalysisPoint {
  date: string;
  t: number;
  value: number;
  movingAverage: number;
  theilSenFit: number;
  zScore: number;
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
  | "Empirical Dataset (Imported)";

export interface TrendAnalysisSummary {
  lat: number;
  lng: number;
  dataset: ETGDatasetId;
  parameter: string;
  unit: string;
  slopeUnit: string;
  provenance: TrendProvenanceSource;
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
  verdict:
    | "Statistically Significant Increasing Trend"
    | "Statistically Significant Decreasing Trend"
    | "Normal Environmental Variability";
  points: TrendAnalysisPoint[];
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
  kind: "webhook" | "mcp" | "eonet" | "revision" | "corroboration" | "probe" | "discovery" | "dataset";
  summary: string;
  nodeUuid?: string;
}
