import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeDataDir } from "@/lib/runtimePaths";
import {
  classifyHttpStatusFault,
  classifyUpstreamFault,
  createTelemetryBudget,
  parseUpstreamJson,
  type TelemetryBudget,
} from "@/lib/earth/upstreamResilience";
import type { UpstreamFaultDetail } from "@/types/etg";
import {
  loadGlobalGnnSummary,
  predictLatestGlobalGnnTomorrow,
} from "./globalGnnInference";

export interface ClimateGraphNode {
  id: string;
  name: string;
  role: "target" | "upwind_neighbor";
  direction: string;
  distanceKm: number;
  lat: number;
  lng: number;
  elevationM: number;
  rationale: string;
}

export interface DailyWeatherRow {
  date: string; // YYYYMMDD
  allsky: number; // ALLSKY_SFC_SW_DWN (kWh/m^2/day)
  clrsky: number; // CLRSKY_SFC_SW_DWN (kWh/m^2/day)
  kt: number; // Clearness index = allsky / max(clrsky, 0.5)
  cloudAmt?: number; // NASA POWER CLOUD_AMT (%)
  t2m: number; // C
  rh2m: number; // %
  precip: number; // mm/day
  ws10m: number; // m/s
  wd10m: number; // degrees FROM which wind blows (0=N, 90=E, 180=S, 270=W)
  ps?: number; // surface pressure kPa
  eveCloudPct?: number; // 18:00-23:00 local solar mean cloud cover (%)
  eveCloud23Pct?: number; // 23:00 local solar cloud cover (%)
  eveRhPct?: number; // 18:00-23:00 local solar mean relative humidity (%)
  eveWsMs?: number; // 18:00-23:00 local solar mean wind speed (m/s)
  eveWdDeg?: number; // 23:00 local solar wind direction (deg)
  evePsTrendHpa?: number; // 23:00 minus 18:00 surface pressure tendency (hPa)
}

export interface ModelMetrics {
  name: string;
  rmse: number;
  mae: number;
  r2: number;
  skillVsPersistence: number; // 1 - RMSE_model / RMSE_persistence
  lowSolarPrecision: number;
  lowSolarRecall: number;
  lowSolarF1: number;
  lowSolarAccuracy: number;
  calibratedThreshold: number;
  stormBrierScore: number;
}

export interface PolicyCostBreakdown {
  policyName: string;
  thresholdKwh: number;
  totalGridPenaltyUsd: number;
  annualizedPenaltyUsd: number;
  stormShortfallDays: number;
  totalLowSolarDays: number;
  stormCaptureRecallPct: number;
  unnecessaryPrechargeDays: number;
}

export interface StormRiskAssessment {
  probStormPct: number;
  expectedShortfallKwh: number;
  prechargeCycleCostUsd: number;
  expectedFalsePrechargeCostUsd: number;
  expectedShortfallPenaltyUsd: number;
  bayesExpectedNetSavingsUsd: number;
  bayesOptimalPrecharge: boolean;
}

export interface MicrogridEconomicSummary {
  schoolSpec: string;
  tariffSpec: string;
  persistencePolicy: PolicyCostBreakdown;
  localDailyPolicy: PolicyCostBreakdown;
  localPolicy: PolicyCostBreakdown;
  graphPolicy: PolicyCostBreakdown;
  probabilisticGraphPolicy: PolicyCostBreakdown;
  annualSavingsVsPersistenceUsd: number;
  annualSavingsVsLocalUsd: number;
  bayesAnnualSavingsVsPersistenceUsd: number;
  prechargeCycleCostUsd: number;
  shortfallSpreadUsdPerKwh: number;
  disclaimer: string;
}

export interface FailureCase {
  date: string;
  isoDate: string;
  actualAllsky: number;
  persistencePred: number;
  localPred: number;
  graphPred: number;
  absErrorGraph: number;
  windFromDeg: number;
  windSpeedMs: number;
  precipMm: number;
  rhPct: number;
  prevDayAllsky: number;
  explanation: string;
}

export interface GlobalGnnTomorrowPrediction {
  modelId: string;
  variant: "denver_adapter" | "zeroshot";
  p10: number;
  q268: number;
  p50: number;
  p90: number;
  probStormPct: number;
  prechargeRecommended: boolean;
  inferenceMs: number;
}

export interface GlobalGnnBenchmarkSummary {
  modelId: string;
  paramCount: number;
  trainCities: number;
  totalStations: number;
  global5CityMeanSkillPct: number;
  global5CityCities: Array<{
    cityId: string;
    name: string;
    regime: string;
    nTest: number;
    persistenceRmse: number;
    localEveRmse: number;
    rmse: number;
    skillPct: number;
    pVsLocalEve: number;
  }>;
  denverZeroshot?: {
    rmse: number;
    skillPct: number;
    stormF1: number;
    stormRecallPct: number;
    savingsUsd: number;
  };
  denverAdapted?: {
    rmse: number;
    skillPct: number;
    stormF1: number;
    stormRecallPct: number;
    savingsUsd: number;
    pVsPersistence: number;
    pVsLocalEve: number;
    pCostVsLocalEve: number;
  };
  nTestDays: number;
}

export interface TomorrowDecision {
  forecastDate: string;
  latestObservedDate: string;
  latestAllsky: number;
  persistencePred: number;
  localDailyPred: number;
  localPred: number;
  graphPred: number;
  lowSolarThreshold: number;
  chargeBatteryOvernight: boolean;
  probStormPct: number;
  localProbStormPct: number;
  prechargeCycleCostUsd: number;
  expectedFalsePrechargeCostUsd: number;
  expectedShortfallPenaltyUsd: number;
  bayesExpectedNetSavingsUsd: number;
  bayesOptimalPrecharge: boolean;
  recommendedReservePct: number;
  dominantUpwindNode: string;
  windFromDeg: number;
  windSpeedMs: number;
  rationale: string;
  globalGnn?: GlobalGnnTomorrowPrediction;
}

export interface SolarGraphAnalysisResult {
  city: string;
  userPersona: string;
  decisionRule: string;
  dataSource: string;
  trainRange: string;
  testRange: string;
  trainDays: number;
  testDays: number;
  nodes: Array<
    ClimateGraphNode & {
      latestAllsky: number;
      latestKt: number;
      upwindWeight: number;
    }
  >;
  metrics: {
    persistence: ModelMetrics;
    localDailyOnly: ModelMetrics;
    localOnly: ModelMetrics;
    graphAware: ModelMetrics;
    clearSkyPersistenceRmse: number;
    graphVsPersistPValue: number;
    graphVsLocalPValue: number;
  };
  liveBridgeSource: string;
  tomorrow: TomorrowDecision;
  economics: MicrogridEconomicSummary;
  topFailure: FailureCase;
  globalGnnBenchmark?: GlobalGnnBenchmarkSummary;
  isDynamicLocation?: boolean;
  targetCoords?: { lat: number; lng: number };
  provenanceMode?: "live" | "cached" | "climatological_fallback";
  upstreamFault?: UpstreamFaultDetail;
  upstreamFaults?: UpstreamFaultDetail[];
  elapsedMs?: number;
  recentTestSeries: Array<{
    date: string;
    actual: number;
    persistence: number;
    local: number;
    graph: number;
    probStormPct: number;
  }>;
}

export const LOW_SOLAR_THRESHOLD_KWH = 3.5;

export const DENVER_CLIMATE_NODES: ClimateGraphNode[] = [
  {
    id: "denver-target",
    name: "Denver (Target Microgrid)",
    role: "target",
    direction: "CENTER",
    distanceKm: 0,
    lat: 39.74,
    lng: -104.99,
    elevationM: 1609,
    rationale: "Target K-12 school microgrid & battery storage decision point.",
  },
  {
    id: "silverthorne-w",
    name: "Silverthorne / Continental Divide",
    role: "upwind_neighbor",
    direction: "W",
    distanceKm: 93,
    lat: 39.63,
    lng: -106.07,
    elevationM: 2754,
    rationale: "High-altitude western pass; detects Pacific cloud decks & smoke plumes before descent.",
  },
  {
    id: "fort-collins-nnw",
    name: "Fort Collins",
    role: "upwind_neighbor",
    direction: "NNW",
    distanceKm: 95,
    lat: 40.59,
    lng: -105.08,
    elevationM: 1525,
    rationale: "Northern Front Range corridor; captures cold-front cloud bands moving south.",
  },
  {
    id: "cheyenne-n",
    name: "Cheyenne, WY",
    role: "upwind_neighbor",
    direction: "N",
    distanceKm: 156,
    lat: 41.14,
    lng: -104.82,
    elevationM: 1848,
    rationale: "Cheyenne Ridge outflow; early warning for northerly arctic stratus & surges.",
  },
  {
    id: "greeley-ne",
    name: "Greeley / Brush Plains",
    role: "upwind_neighbor",
    direction: "NE",
    distanceKm: 98,
    lat: 40.25,
    lng: -104.05,
    elevationM: 1419,
    rationale: "South Platte basin; captures northeast upslope fog and low stratus decks.",
  },
  {
    id: "limon-e",
    name: "Limon / Eastern Plains",
    role: "upwind_neighbor",
    direction: "E",
    distanceKm: 123,
    lat: 39.26,
    lng: -103.69,
    elevationM: 1635,
    rationale: "Eastern plains; detects easterly upslope moisture advection toward Denver.",
  },
  {
    id: "colorado-springs-s",
    name: "Colorado Springs",
    role: "upwind_neighbor",
    direction: "S",
    distanceKm: 102,
    lat: 38.83,
    lng: -104.82,
    elevationM: 1839,
    rationale: "Palmer Divide & southern Front Range; captures southerly convective moisture.",
  },
];

const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = lat1 * TO_RAD;
  const phi2 = lat2 * TO_RAD;
  const dLambda = (lng2 - lng1) * TO_RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * TO_DEG) + 360) % 360;
}

/**
 * NASA POWER WD10M is the meteorological direction wind blows FROM (0=N, 90=E, 180=S, 270=W).
 * A neighbor is upwind of the target when the bearing FROM target TO neighbor aligns with WD10M.
 */
export function computeUpwindWeight(
  windFromDeg: number,
  neighborLat: number,
  neighborLng: number,
  targetLat = 39.74,
  targetLng = -104.99
): number {
  const brg = bearingDeg(targetLat, targetLng, neighborLat, neighborLng);
  const diffRad = (windFromDeg - brg) * TO_RAD;
  return Math.max(0, Math.cos(diffRad));
}

function dayOfYear(yyyymmdd: string): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = Date.UTC(y, m, d);
  const start = Date.UTC(y, 0, 1);
  return Math.floor((dt - start) / 86400000) + 1;
}

export function formatIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function nextIsoDate(yyyymmdd: string): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * Solves (X^T X + lambda * I) w = X^T y via Gaussian elimination with partial pivoting.
 * Keeps column 0 (bias/intercept) unpenalized.
 */
export function fitRidgeRegression(
  X: number[][],
  y: number[],
  lambda = 5.0
): number[] {
  const n = X.length;
  const p = X[0].length;
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const b: number[] = new Array(p).fill(0);

  for (let i = 0; i < n; i++) {
    const row = X[i];
    const yi = y[i];
    for (let j = 0; j < p; j++) {
      b[j] += row[j] * yi;
      for (let k = j; k < p; k++) {
        A[j][k] += row[j] * row[k];
      }
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) {
      A[j][k] = A[k][j];
    }
    if (j > 0) {
      A[j][j] += lambda;
    } else {
      A[j][j] += 1e-6;
    }
  }

  // Augmented matrix Gaussian elimination
  const aug = A.map((row, idx) => [...row, b[idx]]);
  for (let col = 0; col < p; col++) {
    let pivot = col;
    for (let r = col + 1; r < p; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    }
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    const div = aug[col][col] || 1e-9;
    for (let k = col; k <= p; k++) aug[col][k] /= div;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let k = col; k <= p; k++) aug[r][k] -= factor * aug[col][k];
    }
  }
  return aug.map((row) => row[p]);
}

function predictRidge(weights: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < weights.length; i++) s += weights[i] * x[i];
  return Math.max(0, s);
}

const THRESHOLD_GRID = [3.35, 3.45, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0] as const;
const SCHOOL_PV_KW = 250;
const BATTERY_USABLE_KWH = 350;
const OFF_PEAK_RATE_USD = 0.075;
const ON_PEAK_DEFICIT_RATE_USD = 0.28;
const FALSE_POSITIVE_COST_USD = BATTERY_USABLE_KWH * OFF_PEAK_RATE_USD; // $26.25
const DEFICIT_SPREAD_USD_PER_KWH = ON_PEAK_DEFICIT_RATE_USD - OFF_PEAK_RATE_USD; // $0.205/kWh
export const PRECHARGE_CYCLE_COST_USD = FALSE_POSITIVE_COST_USD;
export const SHORTFALL_SPREAD_USD_PER_KWH = DEFICIT_SPREAD_USD_PER_KWH;

const SHORTFALL_SATURATION_KWH = LOW_SOLAR_THRESHOLD_KWH - BATTERY_USABLE_KWH / SCHOOL_PV_KW; // 2.1

function computePolicyCostFromDecisions(
  policyName: string,
  actuals: number[],
  prechargeDecisions: readonly boolean[],
  thresholdKwh: number
): PolicyCostBreakdown {
  let totalGridPenaltyUsd = 0;
  let stormShortfallDays = 0;
  let totalLowSolarDays = 0;
  let unnecessaryPrechargeDays = 0;

  for (let i = 0; i < actuals.length; i++) {
    const actual = actuals[i];
    const actualLow = actual < LOW_SOLAR_THRESHOLD_KWH;
    const precharge = prechargeDecisions[i] === true;

    if (actualLow) {
      totalLowSolarDays += 1;
      if (!precharge) {
        stormShortfallDays += 1;
        const unbufferedKwh = Math.min(
          BATTERY_USABLE_KWH,
          Math.max(0, (LOW_SOLAR_THRESHOLD_KWH - actual) * SCHOOL_PV_KW)
        );
        totalGridPenaltyUsd += unbufferedKwh * DEFICIT_SPREAD_USD_PER_KWH;
      }
    } else if (precharge) {
      unnecessaryPrechargeDays += 1;
      totalGridPenaltyUsd += FALSE_POSITIVE_COST_USD;
    }
  }

  const days = Math.max(1, actuals.length);
  const annualizedPenaltyUsd = totalGridPenaltyUsd * (365.25 / days);
  const stormCaptureRecallPct =
    totalLowSolarDays > 0
      ? ((totalLowSolarDays - stormShortfallDays) / totalLowSolarDays) * 100
      : 100;

  return {
    policyName,
    thresholdKwh: Number(thresholdKwh.toFixed(2)),
    totalGridPenaltyUsd: Number(totalGridPenaltyUsd.toFixed(2)),
    annualizedPenaltyUsd: Number(annualizedPenaltyUsd.toFixed(2)),
    stormShortfallDays,
    totalLowSolarDays,
    stormCaptureRecallPct: Number(stormCaptureRecallPct.toFixed(1)),
    unnecessaryPrechargeDays,
  };
}

function computePolicyCost(
  policyName: string,
  actuals: number[],
  preds: number[],
  thresholdKwh: number
): PolicyCostBreakdown {
  return computePolicyCostFromDecisions(
    policyName,
    actuals,
    preds.map((p) => p < thresholdKwh),
    thresholdKwh
  );
}

function calibrateDecisionThreshold(actuals: number[], preds: number[]): number {
  let bestTau: number = LOW_SOLAR_THRESHOLD_KWH;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const tau of THRESHOLD_GRID) {
    const cost = computePolicyCost("cal", actuals, preds, tau).totalGridPenaltyUsd;
    if (cost < bestCost - 1e-6) {
      bestCost = cost;
      bestTau = tau;
    }
  }
  return bestTau;
}

function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Calibrates a strictly monotonic probabilistic storm-day risk model
 * `P(ALLSKY < 3.5 | forecast)` and Bayes expected-cost dispatch rule using
 * strictly chronological inner-validation residuals (never touching unseen test
 * targets). Compares expected `$0.205/kWh` unbuffered daytime shortfall penalty
 * against expected `$26.25` false pre-charge cycle cost.
 */
export function calibrateStormRiskModel(
  valActuals: readonly number[],
  valPreds: readonly number[]
): {
  residualStd: number;
  breakEvenIrradianceKwh: number;
  assess: (predKwh: number) => StormRiskAssessment;
} {
  const residuals: number[] = [];
  const count = Math.min(valActuals.length, valPreds.length);
  for (let i = 0; i < count; i++) {
    const a = valActuals[i];
    const p = valPreds[i];
    if (Number.isFinite(a) && Number.isFinite(p)) {
      residuals.push(a - p);
    }
  }

  const residualStd =
    residuals.length > 0
      ? Math.max(
          0.25,
          Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length)
        )
      : 0.95;

  const evalRisk = (predKwh: number): StormRiskAssessment => {
    const mu = Number.isFinite(predKwh) ? predKwh : LOW_SOLAR_THRESHOLD_KWH;
    const zT = (LOW_SOLAR_THRESHOLD_KWH - mu) / residualStd;
    const zS = (SHORTFALL_SATURATION_KWH - mu) / residualStd;
    const cdfT = normalCdf(zT);
    const cdfS = normalCdf(zS);
    const gaussProb = cdfT;
    const gaussShortfallKwh = Math.max(
      0,
      Math.min(
        BATTERY_USABLE_KWH,
        BATTERY_USABLE_KWH * cdfS +
          SCHOOL_PV_KW *
            ((LOW_SOLAR_THRESHOLD_KWH - mu) * (cdfT - cdfS) +
              residualStd * (normalPdf(zT) - normalPdf(zS)))
      )
    );

    let probStorm = gaussProb;
    let expectedShortfallKwh = gaussShortfallKwh;

    if (residuals.length >= 10) {
      let empStormCount = 0;
      let empShortfallSum = 0;
      for (const r of residuals) {
        const yDraw = Math.max(0, mu + r);
        if (yDraw < LOW_SOLAR_THRESHOLD_KWH) {
          empStormCount += 1;
          empShortfallSum += Math.min(
            BATTERY_USABLE_KWH,
            Math.max(0, (LOW_SOLAR_THRESHOLD_KWH - yDraw) * SCHOOL_PV_KW)
          );
        }
      }
      const empProb = empStormCount / residuals.length;
      const empShortfallKwh = empShortfallSum / residuals.length;
      probStorm = 0.5 * empProb + 0.5 * gaussProb;
      expectedShortfallKwh = 0.5 * empShortfallKwh + 0.5 * gaussShortfallKwh;
    }

    const clampedProb = Math.max(0.002, Math.min(0.998, probStorm));
    const expectedFalsePrechargeCostUsd = (1 - clampedProb) * FALSE_POSITIVE_COST_USD;
    const expectedShortfallPenaltyUsd = expectedShortfallKwh * DEFICIT_SPREAD_USD_PER_KWH;
    const bayesExpectedNetSavingsUsd =
      expectedShortfallPenaltyUsd - expectedFalsePrechargeCostUsd;

    return {
      probStormPct: Number((clampedProb * 100).toFixed(1)),
      expectedShortfallKwh: Number(expectedShortfallKwh.toFixed(1)),
      prechargeCycleCostUsd: Number(FALSE_POSITIVE_COST_USD.toFixed(2)),
      expectedFalsePrechargeCostUsd: Number(expectedFalsePrechargeCostUsd.toFixed(2)),
      expectedShortfallPenaltyUsd: Number(expectedShortfallPenaltyUsd.toFixed(2)),
      bayesExpectedNetSavingsUsd: Number(bayesExpectedNetSavingsUsd.toFixed(2)),
      bayesOptimalPrecharge: expectedShortfallPenaltyUsd > expectedFalsePrechargeCostUsd,
    };
  };

  // Bisect Bayes break-even irradiance where E[Shortfall Penalty] == E[False Pre-Charge Cost]
  let lo = 2.0;
  let hi = 5.5;
  for (let iter = 0; iter < 24; iter++) {
    const mid = 0.5 * (lo + hi);
    if (evalRisk(mid).bayesExpectedNetSavingsUsd > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const breakEvenIrradianceKwh = Number((0.5 * (lo + hi)).toFixed(2));

  return {
    residualStd: Number(residualStd.toFixed(4)),
    breakEvenIrradianceKwh,
    assess: evalRisk,
  };
}

function computeMetrics(
  name: string,
  actuals: number[],
  preds: number[],
  persistenceRmse: number,
  calibratedThreshold = LOW_SOLAR_THRESHOLD_KWH,
  stormProbs?: readonly number[]
): ModelMetrics {
  const n = actuals.length;
  let sqErr = 0;
  let absErr = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const e = preds[i] - actuals[i];
    sqErr += e * e;
    absErr += Math.abs(e);
    sumY += actuals[i];
  }
  const rmse = Math.sqrt(sqErr / n);
  const mae = absErr / n;
  const meanY = sumY / n;
  let ssTot = 0;
  for (let i = 0; i < n; i++) ssTot += (actuals[i] - meanY) ** 2;
  const r2 = ssTot > 0 ? 1 - sqErr / ssTot : 0;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let brierSum = 0;
  for (let i = 0; i < n; i++) {
    const actLow = actuals[i] < LOW_SOLAR_THRESHOLD_KWH;
    const predLow = preds[i] < calibratedThreshold;
    if (actLow && predLow) tp++;
    else if (!actLow && predLow) fp++;
    else if (actLow && !predLow) fn++;
    else tn++;
    const pStorm = stormProbs
      ? stormProbs[i]
      : preds[i] < LOW_SOLAR_THRESHOLD_KWH
        ? 1
        : 0;
    brierSum += (pStorm - (actLow ? 1 : 0)) ** 2;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const acc = (tp + tn) / n;

  return {
    name,
    rmse: Number(rmse.toFixed(3)),
    mae: Number(mae.toFixed(3)),
    r2: Number(r2.toFixed(3)),
    skillVsPersistence: Number((1 - rmse / Math.max(persistenceRmse, 1e-6)).toFixed(3)),
    lowSolarPrecision: Number(precision.toFixed(3)),
    lowSolarRecall: Number(recall.toFixed(3)),
    lowSolarF1: Number(f1.toFixed(3)),
    lowSolarAccuracy: Number(acc.toFixed(3)),
    calibratedThreshold: Number(calibratedThreshold.toFixed(2)),
    stormBrierScore: Number((brierSum / Math.max(1, n)).toFixed(4)),
  };
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function pairedSquaredErrorPValue(
  actuals: number[],
  predsA: number[],
  predsB: number[]
): number {
  const n = actuals.length;
  if (n < 10) return 1;
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const sqA = (predsA[i] - actuals[i]) ** 2;
    const sqB = (predsB[i] - actuals[i]) ** 2;
    diffs.push(sqA - sqB);
  }
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const variance =
    diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);
  if (se <= 1e-9) return 1;
  const z = Math.abs(mean / se);
  return Number(Math.min(1, 2 * (1 - normalCdf(z))).toFixed(4));
}

export function runThreeWaySolarEvaluation(
  seriesByNode: Record<string, DailyWeatherRow[]>,
  splitYyyymmdd = "20250101",
  liveBridgeSource = "NASA POWER Daily (CERES SYN1deg & MERRA-2)",
  options?: {
    nodes?: ClimateGraphNode[];
    cityLabel?: string;
    isDenver?: boolean;
  }
): SolarGraphAnalysisResult {
  const evalNodes =
    options?.nodes && options.nodes.length === 7 ? options.nodes : DENVER_CLIMATE_NODES;
  const targetNode = evalNodes[0];
  const isDenver = options?.isDenver ?? targetNode.id === "denver-target";
  const cityLabel =
    options?.cityLabel ?? (isDenver ? "Denver, CO (Front Range)" : targetNode.name);

  const rawTargetSeries = seriesByNode[targetNode.id] ?? seriesByNode["denver-target"];
  if (!rawTargetSeries || rawTargetSeries.length < 60) {
    throw new Error(`Insufficient target observations (${targetNode.name}) for 3-way evaluation.`);
  }
  const targetSeries = [...rawTargetSeries].sort((a, b) => a.date.localeCompare(b.date));

  const neighborNodes = evalNodes.filter((n) => n.role === "upwind_neighbor");
  const neighborMaps = new Map<string, Map<string, DailyWeatherRow>>();
  for (const node of neighborNodes) {
    const m = new Map<string, DailyWeatherRow>();
    for (const row of seriesByNode[node.id] ?? []) {
      m.set(row.date, row);
    }
    neighborMaps.set(node.id, m);
  }

  interface SampleRow {
    date: string;
    nextDate: string;
    yNext: number;
    yToday: number;
    localX: number[];
    graphX: number[];
    row: DailyWeatherRow;
  }

  const resolveEvening = (row: DailyWeatherRow) => {
    const fallbackCloud = Math.max(0, Math.min(100, (1 - Math.max(0, Math.min(1, row.kt))) * 100));
    const eveCloudPct = row.eveCloudPct ?? fallbackCloud;
    const eveCloud23Pct = row.eveCloud23Pct ?? eveCloudPct;
    return {
      eveCloudPct,
      eveCloud23Pct,
      eveRhPct: row.eveRhPct ?? row.rh2m,
      eveWsMs: row.eveWsMs ?? row.ws10m,
      eveWdDeg: row.eveWdDeg ?? row.wd10m,
      evePsTrendHpa: row.evePsTrendHpa ?? 0,
    };
  };

  const buildFeatures = (
    today: DailyWeatherRow,
    yesterday: DailyWeatherRow,
    d2: DailyWeatherRow,
    clrskyNext: number,
    doyNext: number,
    getNeighborRow: (nodeId: string) => DailyWeatherRow | undefined
  ) => {
    const sinDoy = Math.sin((2 * Math.PI * doyNext) / 365.25);
    const cosDoy = Math.cos((2 * Math.PI * doyNext) / 365.25);
    const ktRoll3 = (today.kt + yesterday.kt + d2.kt) / 3;
    const psDelta = (today.ps ?? 83) - (yesterday.ps ?? 83);
    const eve = resolveEvening(today);

    const localX = [
      1, // intercept
      today.allsky,
      clrskyNext,
      today.kt,
      ktRoll3,
      today.t2m / 30,
      today.rh2m / 100,
      Math.min(today.precip, 30) / 10,
      today.ws10m / 10,
      Math.sin(today.wd10m * TO_RAD),
      Math.cos(today.wd10m * TO_RAD),
      psDelta,
      sinDoy,
      cosDoy,
      // 7 evening (18:00-23:00 local) sub-daily features
      eve.eveCloudPct / 100,
      eve.eveCloud23Pct / 100,
      eve.eveRhPct / 100,
      eve.eveWsMs / 10,
      Math.sin(eve.eveWdDeg * TO_RAD),
      Math.cos(eve.eveWdDeg * TO_RAD),
      Math.max(-2, Math.min(2, eve.evePsTrendHpa / 5)),
    ];

    // Graph message-passing features from the 6 surrounding nodes (fixed-length even if a node has a gap)
    let upwindKtNum = 0;
    let upwindKtDen = 0;
    let upwindPrecipNum = 0;
    let meanNeighborKt = 0;
    let maxNeighborPrecip = 0;
    const neighborKts: number[] = [];

    let upwindEveCloudNum = 0;
    let upwindEveRhNum = 0;
    let upwindEveDen = 0;
    let meanEveCloud = 0;
    let meanEveRh = 0;
    const neighborEveClouds23: number[] = [];

    for (const node of neighborNodes) {
      const nRow = getNeighborRow(node.id);
      const nKt = nRow ? nRow.kt : today.kt;
      const nPrecip = nRow ? nRow.precip : 0;
      const nEve = nRow ? resolveEvening(nRow) : eve;

      const w = computeUpwindWeight(
        today.wd10m,
        node.lat,
        node.lng,
        targetNode.lat,
        targetNode.lng
      );
      upwindKtNum += w * nKt;
      upwindPrecipNum += w * Math.min(nPrecip, 30);
      upwindKtDen += w;
      meanNeighborKt += nKt;
      if (nPrecip > maxNeighborPrecip) maxNeighborPrecip = nPrecip;
      neighborKts.push(nKt);

      const wEve = computeUpwindWeight(
        eve.eveWdDeg,
        node.lat,
        node.lng,
        targetNode.lat,
        targetNode.lng
      );
      upwindEveCloudNum += wEve * nEve.eveCloud23Pct;
      upwindEveRhNum += wEve * nEve.eveRhPct;
      upwindEveDen += wEve;
      meanEveCloud += nEve.eveCloud23Pct;
      meanEveRh += nEve.eveRhPct;
      neighborEveClouds23.push(nEve.eveCloud23Pct / 100);
    }

    const nCount = Math.max(1, neighborNodes.length);
    const avgNeighborKt = neighborNodes.length > 0 ? meanNeighborKt / nCount : today.kt;
    const ktVariance =
      neighborKts.reduce((acc, k) => acc + (k - avgNeighborKt) ** 2, 0) / nCount;
    const neighborKtStd = Math.sqrt(ktVariance);
    const upwindKt = upwindKtDen > 1e-4 ? upwindKtNum / upwindKtDen : avgNeighborKt;
    const upwindPrecip = upwindKtDen > 1e-4 ? upwindPrecipNum / upwindKtDen : today.precip;
    const spatialGradient = upwindKt - today.kt;

    const upwindEveCloud = upwindEveDen > 1e-4 ? upwindEveCloudNum / upwindEveDen : meanEveCloud / nCount;
    const upwindEveRh = upwindEveDen > 1e-4 ? upwindEveRhNum / upwindEveDen : meanEveRh / nCount;
    // Easterly/upslope flow pushing evening moisture into the Front Range barrier
    const upslopeMoistureIdx = Math.max(0, Math.sin(eve.eveWdDeg * TO_RAD)) * (upwindEveRh / 100);

    const graphX = [
      ...localX,
      upwindKt,
      avgNeighborKt,
      spatialGradient,
      neighborKtStd,
      upwindKt * clrskyNext,
      upwindPrecip / 10,
      Math.min(maxNeighborPrecip, 30) / 10,
      ...neighborKts,
      upwindEveCloud / 100,
      upwindEveRh / 100,
      (1 - upwindEveCloud / 100) * clrskyNext,
      upslopeMoistureIdx,
      ...neighborEveClouds23,
    ];

    return { localX, graphX };
  };

  const samples: SampleRow[] = [];
  for (let i = 3; i < targetSeries.length - 1; i++) {
    const today = targetSeries[i];
    const yesterday = targetSeries[i - 1];
    const d2 = targetSeries[i - 2];
    const next = targetSeries[i + 1];

    const { localX, graphX } = buildFeatures(
      today,
      yesterday,
      d2,
      next.clrsky,
      dayOfYear(next.date),
      (nodeId) => neighborMaps.get(nodeId)?.get(today.date)
    );

    samples.push({
      date: today.date,
      nextDate: next.date,
      yNext: next.allsky,
      yToday: today.allsky,
      localX,
      graphX,
      row: next,
    });
  }

  const trainSamples = samples.filter((s) => s.nextDate < splitYyyymmdd);
  const testSamples = samples.filter((s) => s.nextDate >= splitYyyymmdd);

  if (trainSamples.length < 30 || testSamples.length < 15) {
    throw new Error("Temporal split produced too few train or test samples.");
  }

  // Leak-free inner chronological validation split (85% / 15%) for overnight threshold & storm-risk calibration
  const valStartIdx = Math.floor(trainSamples.length * 0.85);
  const innerTrain = trainSamples.slice(0, valStartIdx);
  const innerVal = trainSamples.slice(valStartIdx);

  let tauLocalDaily: number = LOW_SOLAR_THRESHOLD_KWH;
  let tauLocal: number = LOW_SOLAR_THRESHOLD_KWH;
  let tauGraph: number = LOW_SOLAR_THRESHOLD_KWH;
  let valActuals: number[] = [];
  let valPersistPreds: number[] = [];
  let valLocalDailyPreds: number[] = [];
  let valLocalPreds: number[] = [];
  let valGraphPreds: number[] = [];

  if (innerTrain.length >= 25 && innerVal.length >= 10) {
    const valLocalDailyWeights = fitRidgeRegression(
      innerTrain.map((s) => s.localX.slice(0, 14)),
      innerTrain.map((s) => s.yNext),
      6.0
    );
    const valLocalWeights = fitRidgeRegression(
      innerTrain.map((s) => s.localX),
      innerTrain.map((s) => s.yNext),
      8.0
    );
    const valGraphWeights = fitRidgeRegression(
      innerTrain.map((s) => s.graphX),
      innerTrain.map((s) => s.yNext),
      14.0
    );
    valActuals = innerVal.map((s) => s.yNext);
    valPersistPreds = innerVal.map((s) => s.yToday);
    valLocalDailyPreds = innerVal.map((s) => predictRidge(valLocalDailyWeights, s.localX.slice(0, 14)));
    valLocalPreds = innerVal.map((s) => predictRidge(valLocalWeights, s.localX));
    valGraphPreds = innerVal.map((s) => predictRidge(valGraphWeights, s.graphX));
    tauLocalDaily = calibrateDecisionThreshold(valActuals, valLocalDailyPreds);
    tauLocal = calibrateDecisionThreshold(valActuals, valLocalPreds);
    tauGraph = calibrateDecisionThreshold(valActuals, valGraphPreds);
  }

  const localDailyWeights = fitRidgeRegression(
    trainSamples.map((s) => s.localX.slice(0, 14)),
    trainSamples.map((s) => s.yNext),
    6.0
  );
  const localWeights = fitRidgeRegression(
    trainSamples.map((s) => s.localX),
    trainSamples.map((s) => s.yNext),
    8.0
  );
  const graphWeights = fitRidgeRegression(
    trainSamples.map((s) => s.graphX),
    trainSamples.map((s) => s.yNext),
    14.0
  );

  // If innerVal had < 10 samples on a tiny synthetic series, fall back strictly to in-train residuals (still < splitYyyymmdd)
  const riskActuals =
    valActuals.length >= 10 ? valActuals : trainSamples.map((s) => s.yNext);
  const persistRiskModel = calibrateStormRiskModel(
    riskActuals,
    valActuals.length >= 10 ? valPersistPreds : trainSamples.map((s) => s.yToday)
  );
  const localDailyRiskModel = calibrateStormRiskModel(
    riskActuals,
    valActuals.length >= 10
      ? valLocalDailyPreds
      : trainSamples.map((s) => predictRidge(localDailyWeights, s.localX.slice(0, 14)))
  );
  const localRiskModel = calibrateStormRiskModel(
    riskActuals,
    valActuals.length >= 10
      ? valLocalPreds
      : trainSamples.map((s) => predictRidge(localWeights, s.localX))
  );
  const graphRiskModel = calibrateStormRiskModel(
    riskActuals,
    valActuals.length >= 10
      ? valGraphPreds
      : trainSamples.map((s) => predictRidge(graphWeights, s.graphX))
  );

  const actuals = testSamples.map((s) => s.yNext);
  const persistPreds = testSamples.map((s) => s.yToday);
  const clearSkyPersistPreds = testSamples.map(
    (s) => s.localX[3] * s.localX[2] // today.kt * next.clrsky
  );
  const localDailyPreds = testSamples.map((s) => predictRidge(localDailyWeights, s.localX.slice(0, 14)));
  const localPreds = testSamples.map((s) => predictRidge(localWeights, s.localX));
  const graphPreds = testSamples.map((s) => predictRidge(graphWeights, s.graphX));

  const persistStormRisks = persistPreds.map((p) => persistRiskModel.assess(p));
  const localDailyStormRisks = localDailyPreds.map((p) => localDailyRiskModel.assess(p));
  const localStormRisks = localPreds.map((p) => localRiskModel.assess(p));
  const graphStormRisks = graphPreds.map((p) => graphRiskModel.assess(p));

  const persistMetricsTemp = computeMetrics(
    "Persistence (Tomorrow = Today)",
    actuals,
    persistPreds,
    1,
    LOW_SOLAR_THRESHOLD_KWH
  );
  const persistRmse = persistMetricsTemp.rmse;
  const clearSkyPersistMetrics = computeMetrics(
    "Clear-Sky Persistence",
    actuals,
    clearSkyPersistPreds,
    persistRmse,
    LOW_SOLAR_THRESHOLD_KWH
  );

  const metrics = {
    persistence: computeMetrics(
      "Persistence (Tomorrow = Today)",
      actuals,
      persistPreds,
      persistRmse,
      LOW_SOLAR_THRESHOLD_KWH,
      persistStormRisks.map((r) => r.probStormPct / 100)
    ),
    localDailyOnly: computeMetrics(
      "Local-Only Daily (No Evening)",
      actuals,
      localDailyPreds,
      persistRmse,
      tauLocalDaily,
      localDailyStormRisks.map((r) => r.probStormPct / 100)
    ),
    localOnly: computeMetrics(
      "Local-Only Model (Denver + Evening)",
      actuals,
      localPreds,
      persistRmse,
      tauLocal,
      localStormRisks.map((r) => r.probStormPct / 100)
    ),
    graphAware: computeMetrics(
      "Graph-Aware Model (7-Node + Evening)",
      actuals,
      graphPreds,
      persistRmse,
      tauGraph,
      graphStormRisks.map((r) => r.probStormPct / 100)
    ),
    clearSkyPersistenceRmse: clearSkyPersistMetrics.rmse,
    graphVsPersistPValue: pairedSquaredErrorPValue(actuals, persistPreds, graphPreds),
    graphVsLocalPValue: pairedSquaredErrorPValue(actuals, localPreds, graphPreds),
  };

  const persistencePolicy = computePolicyCost(
    "Persistence (Tomorrow = Today)",
    actuals,
    persistPreds,
    LOW_SOLAR_THRESHOLD_KWH
  );
  const localDailyPolicy = computePolicyCost(
    "Local-Only Daily (Ridge)",
    actuals,
    localDailyPreds,
    tauLocalDaily
  );
  const localPolicy = computePolicyCost("Local-Only + Evening (Ridge)", actuals, localPreds, tauLocal);
  const graphPolicy = computePolicyCost("Graph-Aware + Evening (7-Node)", actuals, graphPreds, tauGraph);
  const probabilisticGraphPolicy = computePolicyCostFromDecisions(
    "Graph+Eve Bayes Expected-Cost",
    actuals,
    graphStormRisks.map((r) => r.bayesOptimalPrecharge),
    graphRiskModel.breakEvenIrradianceKwh
  );
  const economics: MicrogridEconomicSummary = {
    schoolSpec: "250 kWdc rooftop PV + 350 kWh LFP microgrid battery (Colorado K-12 campus)",
    tariffSpec:
      "Off-peak $0.075/kWh overnight charge ($26.25/cycle) vs. $0.280/kWh daytime peak shortfall ($0.205/kWh spread)",
    persistencePolicy,
    localDailyPolicy,
    localPolicy,
    graphPolicy,
    probabilisticGraphPolicy,
    annualSavingsVsPersistenceUsd: Number(
      (persistencePolicy.annualizedPenaltyUsd - graphPolicy.annualizedPenaltyUsd).toFixed(2)
    ),
    annualSavingsVsLocalUsd: Number(
      (localPolicy.annualizedPenaltyUsd - graphPolicy.annualizedPenaltyUsd).toFixed(2)
    ),
    bayesAnnualSavingsVsPersistenceUsd: Number(
      (
        persistencePolicy.annualizedPenaltyUsd -
        probabilisticGraphPolicy.annualizedPenaltyUsd
      ).toFixed(2)
    ),
    prechargeCycleCostUsd: Number(PRECHARGE_CYCLE_COST_USD.toFixed(2)),
    shortfallSpreadUsdPerKwh: Number(SHORTFALL_SPREAD_USD_PER_KWH.toFixed(3)),
    disclaimer:
      "Operational prototype estimate: tariff penalties ($0.075/$0.280 per kWh) model a representative Colorado commercial TOU schedule for research comparison; live microgrid dispatch requires utility interconnection and site telemetry.",
  };

  // Find worst error in unseen test set
  let worstIdx = 0;
  let worstErr = -1;
  for (let i = 0; i < testSamples.length; i++) {
    const err = Math.abs(graphPreds[i] - actuals[i]);
    if (err > worstErr) {
      worstErr = err;
      worstIdx = i;
    }
  }
  const wf = testSamples[worstIdx];
  const wfActual = actuals[worstIdx];
  const wfPred = graphPreds[worstIdx];
  const failureType =
    wfActual < wfPred
      ? "sudden cloud/upslope storm or smoke darkening not yet captured in evening upwind clearness"
      : "rapid clearing after an overcast day";

  const topFailure: FailureCase = {
    date: wf.nextDate,
    isoDate: formatIsoDate(wf.nextDate),
    actualAllsky: Number(wfActual.toFixed(2)),
    persistencePred: Number(persistPreds[worstIdx].toFixed(2)),
    localPred: Number(localPreds[worstIdx].toFixed(2)),
    graphPred: Number(wfPred.toFixed(2)),
    absErrorGraph: Number(worstErr.toFixed(2)),
    windFromDeg: Number(wf.row.wd10m.toFixed(0)),
    windSpeedMs: Number(wf.row.ws10m.toFixed(1)),
    precipMm: Number(wf.row.precip.toFixed(1)),
    rhPct: Number(wf.row.rh2m.toFixed(0)),
    prevDayAllsky: Number(wf.yToday.toFixed(2)),
    explanation: `On ${formatIsoDate(wf.nextDate)}, actual irradiance was ${wfActual.toFixed(2)} kWh/m²/d while the Graph-Aware model predicted ${wfPred.toFixed(2)} kWh/m²/d (|err| = ${worstErr.toFixed(2)}). Wind shifted to ${wf.row.wd10m.toFixed(0)}° at ${wf.row.ws10m.toFixed(1)} m/s with RH ${wf.row.rh2m.toFixed(0)}% and ${wf.row.precip.toFixed(1)} mm precip — a ${failureType}.`,
  };

  // Tomorrow live decision using the very latest day in targetSeries
  const latestIdx = targetSeries.length - 1;
  const latest = targetSeries[latestIdx];
  const prev1 = targetSeries[latestIdx - 1];
  const prev2 = targetSeries[latestIdx - 2];
  const nextDoy = (dayOfYear(latest.date) % 365) + 1;
  const estClrskyTomorrow = latest.clrsky;
  const latestEve = resolveEvening(latest);

  let dominantUpwindNode = "None (calm)";
  let bestWeight = -1;
  const latestNeighborMap = new Map<string, DailyWeatherRow>();
  const enrichedNodes = evalNodes.map((node) => {
    const nSeries = seriesByNode[node.id] ?? [];
    const nLatest = nSeries[nSeries.length - 1] ?? latest;
    latestNeighborMap.set(node.id, nLatest);
    const w =
      node.role === "target"
        ? 1.0
        : computeUpwindWeight(
            latestEve.eveWdDeg,
            node.lat,
            node.lng,
            targetNode.lat,
            targetNode.lng
          );
    if (node.role === "upwind_neighbor" && w > bestWeight) {
      bestWeight = w;
      dominantUpwindNode = `${node.name} (${node.direction})`;
    }
    return {
      ...node,
      latestAllsky: Number(nLatest.allsky.toFixed(2)),
      latestKt: Number(nLatest.kt.toFixed(3)),
      upwindWeight: Number(w.toFixed(2)),
    };
  });

  const { localX: latestLocalX, graphX: latestGraphX } = buildFeatures(
    latest,
    prev1,
    prev2,
    estClrskyTomorrow,
    nextDoy,
    (nodeId) => latestNeighborMap.get(nodeId)
  );

  const tmrLocalDaily = predictRidge(localDailyWeights, latestLocalX.slice(0, 14));
  const tmrLocal = predictRidge(localWeights, latestLocalX);
  const tmrGraph = predictRidge(graphWeights, latestGraphX);
  const tmrGraphRisk = graphRiskModel.assess(tmrGraph);
  const tmrLocalRisk = localRiskModel.assess(tmrLocal);
  const chargeBatteryOvernight = tmrGraph < tauGraph;
  const shouldChargeAny = chargeBatteryOvernight || tmrGraphRisk.bayesOptimalPrecharge;
  const recommendedReservePct = shouldChargeAny
    ? 90
    : tmrGraph < 5.0
      ? 60
      : 35;

  const gnnPred = predictLatestGlobalGnnTomorrow(
    evalNodes,
    seriesByNode,
    isDenver ? "denver_adapter" : "zeroshot"
  );
  const globalGnn = gnnPred
    ? {
        modelId: "etg-global-gnn-v3",
        variant: gnnPred.variant,
        p10: Number(gnnPred.p10.toFixed(2)),
        q268: Number(gnnPred.q268.toFixed(2)),
        p50: Number(gnnPred.p50.toFixed(2)),
        p90: Number(gnnPred.p90.toFixed(2)),
        probStormPct: Number((gnnPred.stormProb * 100).toFixed(1)),
        prechargeRecommended:
          gnnPred.q268 < LOW_SOLAR_THRESHOLD_KWH || gnnPred.stormProb >= 0.27,
        inferenceMs: gnnPred.inferenceMs,
      }
    : undefined;

  const summary = loadGlobalGnnSummary();
  let globalGnnBenchmark: GlobalGnnBenchmarkSummary | undefined;
  if (summary) {
    const cities = (summary.global_5city_benchmark ?? []).map((c) => ({
      cityId: c.city_id,
      name: c.name,
      regime: c.regime,
      nTest: c.n_test,
      persistenceRmse: c.persistence_rmse,
      localEveRmse: c.local_eve_rmse,
      rmse: c.global_gnn_rmse,
      skillPct: c.global_gnn_skill_pct,
      pVsLocalEve: c.p_vs_local_eve,
    }));
    const meanSkill =
      cities.length > 0
        ? Number(
            (cities.reduce((acc, c) => acc + c.skillPct, 0) / cities.length).toFixed(2)
          )
        : 0;
    const zs = summary.denver_showcase?.global_gnn_zeroshot;
    const ad = summary.denver_showcase?.global_gnn_adapted;
    globalGnnBenchmark = {
      modelId: "etg-global-gnn-v3",
      paramCount: 2_043_212,
      trainCities: summary.train_cities,
      totalStations: summary.total_stations,
      global5CityMeanSkillPct: meanSkill,
      global5CityCities: cities,
      ...(zs
        ? {
            denverZeroshot: {
              rmse: zs.rmse,
              skillPct: zs.skill_pct,
              stormF1: zs.storm_f1,
              stormRecallPct: zs.storm_capture_recall_pct,
              savingsUsd: zs.savings_usd ?? 0,
            },
          }
        : {}),
      ...(ad
        ? {
            denverAdapted: {
              rmse: ad.rmse,
              skillPct: ad.skill_pct,
              stormF1: ad.storm_f1,
              stormRecallPct: ad.storm_capture_recall_pct,
              savingsUsd: ad.savings_usd ?? 0,
              pVsPersistence: ad.p_vs_persistence ?? 1,
              pVsLocalEve: ad.p_vs_local_eve ?? 1,
              pCostVsLocalEve: ad.p_cost_vs_local_eve ?? 1,
            },
          }
        : {}),
      nTestDays: summary.denver_showcase?.n_test ?? 0,
    };
  }

  const tomorrow: TomorrowDecision = {
    forecastDate: nextIsoDate(latest.date),
    latestObservedDate: formatIsoDate(latest.date),
    latestAllsky: Number(latest.allsky.toFixed(2)),
    persistencePred: Number(latest.allsky.toFixed(2)),
    localDailyPred: Number(tmrLocalDaily.toFixed(2)),
    localPred: Number(tmrLocal.toFixed(2)),
    graphPred: Number(tmrGraph.toFixed(2)),
    lowSolarThreshold: tauGraph,
    chargeBatteryOvernight,
    probStormPct: tmrGraphRisk.probStormPct,
    localProbStormPct: tmrLocalRisk.probStormPct,
    prechargeCycleCostUsd: tmrGraphRisk.prechargeCycleCostUsd,
    expectedFalsePrechargeCostUsd: tmrGraphRisk.expectedFalsePrechargeCostUsd,
    expectedShortfallPenaltyUsd: tmrGraphRisk.expectedShortfallPenaltyUsd,
    bayesExpectedNetSavingsUsd: tmrGraphRisk.bayesExpectedNetSavingsUsd,
    bayesOptimalPrecharge: tmrGraphRisk.bayesOptimalPrecharge,
    recommendedReservePct,
    dominantUpwindNode,
    windFromDeg: Number(latest.wd10m.toFixed(0)),
    windSpeedMs: Number(latest.ws10m.toFixed(1)),
    rationale: chargeBatteryOvernight
      ? `Graph-Aware forecast (${tmrGraph.toFixed(2)} kWh/m²/d; P(ALLSKY < 3.5) = ${tmrGraphRisk.probStormPct.toFixed(1)}%) is below calibrated threshold ${tauGraph.toFixed(2)} kWh/m²/d with upwind flow from ${dominantUpwindNode}. Bayes expected shortfall penalty ($${tmrGraphRisk.expectedShortfallPenaltyUsd.toFixed(2)} at $0.205/kWh) vs. false-cycle risk ($${tmrGraphRisk.expectedFalsePrechargeCostUsd.toFixed(2)} from $26.25 cycle). Pre-charge to ${recommendedReservePct}% overnight.`
      : `Graph-Aware forecast (${tmrGraph.toFixed(2)} kWh/m²/d; P(ALLSKY < 3.5) = ${tmrGraphRisk.probStormPct.toFixed(1)}%) clears the calibrated ${tauGraph.toFixed(2)} kWh/m²/d threshold. Bayes rule (${tmrGraphRisk.bayesOptimalPrecharge ? "PRE-CHARGE" : "HOLD"}) compares $${tmrGraphRisk.expectedShortfallPenaltyUsd.toFixed(2)} expected shortfall ($0.205/kWh) vs. $${tmrGraphRisk.expectedFalsePrechargeCostUsd.toFixed(2)} false-cycle cost ($26.25 cycle). Keep overnight reserve at ${recommendedReservePct}%.`,
    ...(globalGnn ? { globalGnn } : {}),
  };

  const recentTestSeries = testSamples.slice(-45).map((s, idx) => {
    const absIdx = testSamples.length - Math.min(45, testSamples.length) + idx;
    return {
      date: formatIsoDate(s.nextDate),
      actual: Number(actuals[absIdx].toFixed(2)),
      persistence: Number(persistPreds[absIdx].toFixed(2)),
      local: Number(localPreds[absIdx].toFixed(2)),
      graph: Number(graphPreds[absIdx].toFixed(2)),
      probStormPct: graphStormRisks[absIdx].probStormPct,
    };
  });

  return {
    city: cityLabel,
    userPersona: isDenver
      ? "Denver K-12 School / Community Microgrid Operator"
      : `${cityLabel} Community / Facility Solar Microgrid Operator`,
    decisionRule: `Pre-charge backup battery overnight if Graph+Evening forecast < ${tauGraph.toFixed(2)} kWh/m²/day (calibrated for true < ${LOW_SOLAR_THRESHOLD_KWH} kWh/m²/day events)`,
    dataSource: isDenver
      ? "NASA POWER Daily (CERES/MERRA-2) + Open-Meteo Evening Hourly (18:00–23:00 MST)"
      : `NASA POWER Daily (CERES/MERRA-2) + Live 7-Node Ring Forecast (${targetNode.lat.toFixed(2)}°, ${targetNode.lng.toFixed(2)}°)`,
    trainRange: `${formatIsoDate(trainSamples[0].nextDate)} to ${formatIsoDate(trainSamples[trainSamples.length - 1].nextDate)}`,
    testRange: `${formatIsoDate(testSamples[0].nextDate)} to ${formatIsoDate(testSamples[testSamples.length - 1].nextDate)}`,
    trainDays: trainSamples.length,
    testDays: testSamples.length,
    nodes: enrichedNodes,
    metrics,
    liveBridgeSource,
    tomorrow,
    economics,
    topFailure,
    ...(globalGnnBenchmark ? { globalGnnBenchmark } : {}),
    isDynamicLocation: !isDenver,
    targetCoords: {
      lat: Number(targetNode.lat.toFixed(4)),
      lng: Number(targetNode.lng.toFixed(4)),
    },
    recentTestSeries,
  };
}

const SOLAR_CACHE = new Map<string, { expiresAt: number; result: SolarGraphAnalysisResult }>();
const SOLAR_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const BUNDLED_DENVER_SEED_FILE = path.join(
  process.cwd(),
  "ml",
  "weights",
  "denver-solar-seed-v4.json"
);

function getSolarCacheFilePath(): string {
  return path.join(resolveRuntimeDataDir(), "solar-graph-cache.json");
}

function isFileCacheEnabled(): boolean {
  return process.env.NODE_ENV !== "test" && !process.env.VITEST;
}

export function clearDenverSolarCache(): void {
  SOLAR_CACHE.clear();
}

export function readBundledDenverSeed(
  startYear = 2019,
  endYear = new Date().getUTCFullYear()
): SolarGraphAnalysisResult | null {
  if (!isFileCacheEnabled() || startYear !== 2019 || endYear < 2025) return null;
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ BUNDLED_DENVER_SEED_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ BUNDLED_DENVER_SEED_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SolarGraphAnalysisResult> | null;
    if (
      parsed &&
      parsed.metrics?.graphAware &&
      parsed.tomorrow &&
      Array.isArray(parsed.nodes)
    ) {
      return parsed as SolarGraphAnalysisResult;
    }
  } catch {
    // Optional seed artifact missing or unreadable
  }
  return null;
}

function readPersistentSolarCache(
  key: string,
  options?: { allowStale?: boolean }
): SolarGraphAnalysisResult | null {
  if (!isFileCacheEnabled()) return null;
  try {
    const cacheFile = getSolarCacheFilePath();
    if (!fs.existsSync(cacheFile)) return null;
    const raw = fs.readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      { expiresAt?: number; result?: SolarGraphAnalysisResult }
    >;
    const entry = parsed?.[key];
    const isFresh =
      typeof entry?.expiresAt === "number" && entry.expiresAt > Date.now();
    if (entry?.result && (isFresh || options?.allowStale)) {
      return entry.result;
    }
  } catch {
    // Ignore corrupt or unreadable cache files
  }
  return null;
}

function writePersistentSolarCache(
  key: string,
  expiresAt: number,
  result: SolarGraphAnalysisResult
): void {
  if (!isFileCacheEnabled()) return;
  try {
    const cacheFile = getSolarCacheFilePath();
    const dir = path.dirname(cacheFile);
    fs.mkdirSync(dir, { recursive: true });
    let existing: Record<string, { expiresAt: number; result: SolarGraphAnalysisResult }> = {};
    if (fs.existsSync(cacheFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as typeof existing;
      } catch {
        existing = {};
      }
    }
    existing[key] = { expiresAt, result };
    fs.writeFileSync(cacheFile, JSON.stringify(existing), "utf8");
  } catch {
    // Non-fatal if cache cannot be written
  }
}

async function fetchWithRetry(
  url: string,
  timeoutMs = 1100,
  headers?: Record<string, string>,
  attempts = 2,
  budget?: TelemetryBudget,
  sourceLabel = "Solar Telemetry Upstream"
): Promise<Response> {
  const cappedTimeout = Math.max(250, timeoutMs);
  let lastError: unknown;
  const retryDelayMs = process.env.NODE_ENV === "test" ? 10 : 40;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (budget && budget.remainingMs() < 120) {
      throw (
        lastError instanceof Error
          ? lastError
          : new Error(`${sourceLabel} chaos deadline exceeded`)
      );
    }
    const startedAttemptAt = Date.now();
    try {
      const res = await fetch(url, {
        signal: budget ? budget.signal(cappedTimeout) : AbortSignal.timeout(cappedTimeout),
        ...(headers ? { headers } : {}),
      });
      if (!res.ok) {
        const httpFault = classifyHttpStatusFault(sourceLabel, res.status);
        budget?.recordFault(httpFault);
        const attemptElapsed = Date.now() - startedAttemptAt;
        if (
          httpFault.retryable &&
          attempt < attempts &&
          attemptElapsed < 250 &&
          (!budget || budget.remainingMs() > 450)
        ) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
      }
      return res;
    } catch (err) {
      const fault = classifyUpstreamFault(err, sourceLabel);
      budget?.recordFault(fault);
      lastError = err;
      const attemptElapsed = Date.now() - startedAttemptAt;
      if (
        fault.retryable &&
        attempt < attempts &&
        attemptElapsed < 250 &&
        (!budget || budget.remainingMs() > 450)
      ) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw lastError instanceof Error ? lastError : new Error(fault.message);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Network request failed");
}

function computeClearSkyFallbackKwh(latDeg: number, doy: number): number {
  const phi = latDeg * TO_RAD;
  const delta = 0.409 * Math.sin(((2 * Math.PI) / 365) * (doy - 80));
  const dr = 1 + 0.033 * Math.cos(((2 * Math.PI) / 365) * doy);
  const cosWs = Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta)));
  const ws = Math.acos(cosWs);
  const raMj =
    ((24 * 60) / Math.PI) *
    0.082 *
    dr *
    (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
  return Math.max(1.2, (raMj / 3.6) * 0.76);
}

interface OpenMeteoDailyPayload {
  daily?: {
    time?: string[];
    shortwave_radiation_sum?: Array<number | null>;
    temperature_2m_mean?: Array<number | null>;
    relative_humidity_2m_mean?: Array<number | null>;
    precipitation_sum?: Array<number | null>;
    wind_speed_10m_max?: Array<number | null>;
    wind_direction_10m_dominant?: Array<number | null>;
  };
}

function parseOpenMeteoDailyRows(
  json: OpenMeteoDailyPayload,
  lat: number,
  fixedClrsky?: number
): DailyWeatherRow[] {
  const d = json.daily;
  if (!d?.time || !d.shortwave_radiation_sum) return [];
  const out: DailyWeatherRow[] = [];
  for (let i = 0; i < d.time.length; i++) {
    const mj = d.shortwave_radiation_sum[i];
    if (mj === null || mj === undefined || !Number.isFinite(mj)) continue;
    const allsky = mj / 3.6; // MJ/m^2/day -> kWh/m^2/day
    const yyyymmdd = d.time[i].replace(/-/g, "");
    const clrsky = fixedClrsky ?? computeClearSkyFallbackKwh(lat, dayOfYear(yyyymmdd));
    out.push({
      date: yyyymmdd,
      allsky,
      clrsky,
      kt: allsky / Math.max(clrsky, 0.5),
      t2m: d.temperature_2m_mean?.[i] ?? 8,
      rh2m: d.relative_humidity_2m_mean?.[i] ?? 50,
      precip: d.precipitation_sum?.[i] ?? 0,
      ws10m: (d.wind_speed_10m_max?.[i] ?? 10) / 3.6,
      wd10m: d.wind_direction_10m_dominant?.[i] ?? 270,
      ps: 83,
    });
  }
  return out;
}

async function fetchOpenMeteoBridgeRows(
  node: ClimateGraphNode,
  fallbackClrsky: number,
  budget?: TelemetryBudget
): Promise<DailyWeatherRow[]> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${node.lat}&longitude=${node.lng}` +
      `&daily=shortwave_radiation_sum,temperature_2m_mean,relative_humidity_2m_mean,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant` +
      `&past_days=7&forecast_days=1&timezone=America%2FDenver`;
    const res = await fetchWithRetry(
      url,
      1000,
      undefined,
      1,
      budget,
      `Open-Meteo Bridge (${node.name})`
    );
    const json = await parseUpstreamJson<OpenMeteoDailyPayload>(
      res,
      `Open-Meteo Bridge (${node.name})`
    );
    return parseOpenMeteoDailyRows(json, node.lat, fallbackClrsky);
  } catch (err) {
    budget?.recordFault(classifyUpstreamFault(err, `Open-Meteo Bridge (${node.name})`));
    return [];
  }
}

async function fetchOpenMeteoArchiveRows(
  node: ClimateGraphNode,
  startYear: number,
  endIsoDate = "2025-12-31",
  budget?: TelemetryBudget
): Promise<DailyWeatherRow[]> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${node.lat}&longitude=${node.lng}` +
    `&start_date=${startYear}-01-01&end_date=${endIsoDate}` +
    `&daily=shortwave_radiation_sum,temperature_2m_mean,relative_humidity_2m_mean,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant` +
    `&timezone=America%2FDenver`;
  const res = await fetchWithRetry(
    url,
    1100,
    undefined,
    2,
    budget,
    `Open-Meteo Archive (${node.name})`
  );
  const json = await parseUpstreamJson<OpenMeteoDailyPayload>(
    res,
    `Open-Meteo Archive (${node.name})`
  );
  if (!json || typeof json !== "object") {
    throw new Error(`Malformed Open-Meteo Archive payload for ${node.name}`);
  }
  return parseOpenMeteoDailyRows(json, node.lat);
}

function parseNasaPowerDailyPayload(
  json: {
    geometry?: { coordinates?: number[] };
    properties?: { parameter?: Record<string, Record<string, number>> };
  },
  nodeName: string,
  nodeToUpdate?: ClimateGraphNode
): DailyWeatherRow[] {
  const elevCoord = Number(json.geometry?.coordinates?.[2]);
  if (
    nodeToUpdate &&
    nodeToUpdate.elevationM <= 0 &&
    Number.isFinite(elevCoord) &&
    elevCoord > -900
  ) {
    nodeToUpdate.elevationM = Math.max(0, Math.round(elevCoord));
  }

  const p = json.properties?.parameter;
  if (!p?.ALLSKY_SFC_SW_DWN || !p?.CLRSKY_SFC_SW_DWN) {
    throw new Error(`Missing solar parameters from NASA POWER for ${nodeName}`);
  }
  const dates = Object.keys(p.ALLSKY_SFC_SW_DWN).sort();
  const rows: DailyWeatherRow[] = [];
  for (const date of dates) {
    const allsky = Number(p.ALLSKY_SFC_SW_DWN[date]);
    const clrsky = Number(p.CLRSKY_SFC_SW_DWN[date]);
    const t2m = Number(p.T2M?.[date] ?? 10);
    const rh2m = Number(p.RH2M?.[date] ?? 50);
    const precip = Number(p.PRECTOTCORR?.[date] ?? 0);
    const ws10m = Number(p.WS10M?.[date] ?? 3);
    const wd10m = Number(p.WD10M?.[date] ?? 270);
    const ps = Number(p.PS?.[date] ?? 83);
    const cloudAmtRaw = p.CLOUD_AMT?.[date];
    const cloudAmt =
      typeof cloudAmtRaw === "number" && Number.isFinite(cloudAmtRaw) && cloudAmtRaw > -900
        ? Math.max(0, Math.min(100, cloudAmtRaw))
        : undefined;
    if (allsky <= -900 || clrsky <= -900 || !Number.isFinite(allsky)) continue;
    rows.push({
      date,
      allsky,
      clrsky,
      kt: allsky / Math.max(clrsky, 0.5),
      ...(cloudAmt !== undefined ? { cloudAmt } : {}),
      t2m: t2m <= -900 ? 10 : t2m,
      rh2m: rh2m <= -900 ? 50 : rh2m,
      precip: precip <= -900 ? 0 : precip,
      ws10m: ws10m <= -900 ? 3 : ws10m,
      wd10m: wd10m <= -900 ? 270 : wd10m,
      ps: ps <= -900 ? 83 : ps,
    });
  }
  return rows;
}

async function fetchNodeNasaPowerRows(
  node: ClimateGraphNode,
  start: string,
  primaryEnd: string,
  budget?: TelemetryBudget,
  perRequestTimeoutMs = 1100
): Promise<DailyWeatherRow[]> {
  const params = "ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN,CLOUD_AMT,T2M,RH2M,PRECTOTCORR,WS10M,WD10M,PS";
  const headers = {
    Accept: "application/json",
    "User-Agent": "EarthTrendDetective/1.0 (NASA-Space-Apps)",
  };
  const buildUrl = (endDate: string) =>
    `https://power.larc.nasa.gov/api/temporal/daily/point` +
    `?parameters=${params}&community=RE&longitude=${node.lng}&latitude=${node.lat}` +
    `&start=${start}&end=${endDate}&format=JSON`;

  let res = await fetchWithRetry(
    buildUrl(primaryEnd),
    perRequestTimeoutMs,
    headers,
    2,
    budget,
    `NASA POWER Daily (${node.name})`
  );
  if ((res.status === 400 || res.status === 422) && primaryEnd > "20251231") {
    res = await fetchWithRetry(
      buildUrl("20251231"),
      perRequestTimeoutMs,
      headers,
      2,
      budget,
      `NASA POWER Daily (${node.name})`
    );
  }
  const json = await parseUpstreamJson<{
    geometry?: { coordinates?: number[] };
    properties?: { parameter?: Record<string, Record<string, number>> };
  }>(res, `NASA POWER Daily (${node.name})`);
  if (!json || typeof json !== "object") {
    throw new Error(`Malformed NASA POWER payload for ${node.name}`);
  }
  return parseNasaPowerDailyPayload(json, node.name, node);
}

interface EveningHourlyFields {
  eveCloudPct: number;
  eveCloud23Pct: number;
  eveRhPct: number;
  eveWsMs: number;
  eveWdDeg: number;
  evePsTrendHpa: number;
}

interface OpenMeteoHourlyNodePayload {
  hourly?: {
    time?: string[];
    cloud_cover?: Array<number | null>;
    surface_pressure?: Array<number | null>;
    relative_humidity_2m?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    wind_direction_10m?: Array<number | null>;
  };
}

function aggregateEveningHours(
  payload: OpenMeteoHourlyNodePayload,
  utcOffsetHours?: number
): Map<string, EveningHourlyFields> {
  const out = new Map<string, EveningHourlyFields>();
  const h = payload.hourly;
  if (!h?.time || h.time.length === 0) return out;

  const grouped = new Map<
    string,
    {
      clouds: number[];
      cloud23?: number;
      rhs: number[];
      wss: number[];
      wd23?: number;
      psStart?: number;
      psEnd?: number;
    }
  >();

  for (let i = 0; i < h.time.length; i++) {
    const ts = h.time[i];
    const sep = ts.indexOf("T");
    if (sep < 0) continue;
    let hour = Number(ts.slice(sep + 1, sep + 3));
    let yyyymmdd = ts.slice(0, sep).replace(/-/g, "");
    if (utcOffsetHours !== undefined) {
      const utcMs = Date.parse(`${ts.slice(0, 13)}:00:00Z`);
      if (!Number.isFinite(utcMs)) continue;
      const localDt = new Date(utcMs + utcOffsetHours * 3_600_000);
      hour = localDt.getUTCHours();
      yyyymmdd = localDt.toISOString().slice(0, 10).replace(/-/g, "");
    }
    if (!Number.isFinite(hour) || hour < 18 || hour > 23) continue;
    let bucket = grouped.get(yyyymmdd);
    if (!bucket) {
      bucket = { clouds: [], rhs: [], wss: [] };
      grouped.set(yyyymmdd, bucket);
    }

    const cl = h.cloud_cover?.[i];
    if (cl !== null && cl !== undefined && Number.isFinite(cl)) {
      bucket.clouds.push(cl);
      if (hour === 23 || bucket.cloud23 === undefined) bucket.cloud23 = cl;
      else bucket.cloud23 = cl; // keeps latest evening hour if 23:00 missing
    }
    const rh = h.relative_humidity_2m?.[i];
    if (rh !== null && rh !== undefined && Number.isFinite(rh)) {
      bucket.rhs.push(rh);
    }
    const ws = h.wind_speed_10m?.[i];
    if (ws !== null && ws !== undefined && Number.isFinite(ws)) {
      bucket.wss.push(ws);
    }
    const wd = h.wind_direction_10m?.[i];
    if (wd !== null && wd !== undefined && Number.isFinite(wd)) {
      bucket.wd23 = wd;
    }
    const ps = h.surface_pressure?.[i];
    if (ps !== null && ps !== undefined && Number.isFinite(ps)) {
      if (bucket.psStart === undefined) bucket.psStart = ps;
      bucket.psEnd = ps;
    }
  }

  for (const [date, b] of grouped.entries()) {
    if (b.clouds.length === 0 && b.rhs.length === 0 && b.wss.length === 0) continue;
    const avg = (arr: number[], fb: number) =>
      arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : fb;
    const eveCloudPct = avg(b.clouds, 30);
    const eveCloud23Pct = b.cloud23 ?? eveCloudPct;
    const eveRhPct = avg(b.rhs, 50);
    const eveWsMs = avg(b.wss, 3);
    const eveWdDeg = b.wd23 ?? 270;
    const evePsTrendHpa =
      b.psStart !== undefined && b.psEnd !== undefined ? b.psEnd - b.psStart : 0;
    out.set(date, {
      eveCloudPct,
      eveCloud23Pct,
      eveRhPct,
      eveWsMs,
      eveWdDeg,
      evePsTrendHpa,
    });
  }

  return out;
}

async function fetchEveningHourlyByNode(
  nodes: ClimateGraphNode[],
  startIso: string,
  archiveEndIso: string,
  includeForecastBridge: boolean,
  budget?: TelemetryBudget,
  options?: { utcOffsetHours?: number; skipArchive?: boolean; timeoutMs?: number }
): Promise<{ byNode: Map<string, Map<string, EveningHourlyFields>>; hasData: boolean }> {
  const byNode = new Map<string, Map<string, EveningHourlyFields>>();
  for (const n of nodes) byNode.set(n.id, new Map());

  const lats = nodes.map((n) => n.lat).join(",");
  const lngs = nodes.map((n) => n.lng).join(",");
  const vars = "cloud_cover,surface_pressure,relative_humidity_2m,wind_speed_10m,wind_direction_10m";
  const requestTimeoutMs = options?.timeoutMs ?? 1100;
  let hasData = false;

  const mergeResponse = (json: unknown) => {
    const items = (Array.isArray(json) ? json : [json]) as OpenMeteoHourlyNodePayload[];
    for (let idx = 0; idx < Math.min(items.length, nodes.length); idx++) {
      const nodeMap = byNode.get(nodes[idx].id);
      const parsed = aggregateEveningHours(items[idx] ?? {}, options?.utcOffsetHours);
      if (nodeMap && parsed.size > 0) {
        hasData = true;
        for (const [date, vals] of parsed.entries()) {
          nodeMap.set(date, vals);
        }
      }
    }
  };

  const fetchArchiveHourly = async () => {
    if (options?.skipArchive || archiveEndIso < startIso) return;
    try {
      const archiveUrl =
        `https://archive-api.open-meteo.com/v1/archive?latitude=${lats}&longitude=${lngs}` +
        `&start_date=${startIso}&end_date=${archiveEndIso}&hourly=${vars}` +
        `&wind_speed_unit=ms&timezone=America%2FDenver`;
      const res = await fetchWithRetry(
        archiveUrl,
        requestTimeoutMs,
        undefined,
        1,
        budget,
        "Open-Meteo Evening Archive"
      );
      mergeResponse(await parseUpstreamJson(res, "Open-Meteo Evening Archive"));
    } catch (err) {
      budget?.recordFault(classifyUpstreamFault(err, "Open-Meteo Evening Archive"));
    }
  };

  const fetchForecastHourly = async () => {
    if (!includeForecastBridge) return;
    try {
      const tz = options?.utcOffsetHours !== undefined ? "UTC" : "America%2FDenver";
      const forecastUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
        `&hourly=${vars}&past_days=7&forecast_days=1&wind_speed_unit=ms&timezone=${tz}`;
      const res = await fetchWithRetry(
        forecastUrl,
        requestTimeoutMs,
        undefined,
        1,
        budget,
        "Open-Meteo Evening Forecast"
      );
      mergeResponse(await parseUpstreamJson(res, "Open-Meteo Evening Forecast"));
    } catch (err) {
      budget?.recordFault(classifyUpstreamFault(err, "Open-Meteo Evening Forecast"));
    }
  };

  await Promise.all([fetchArchiveHourly(), fetchForecastHourly()]);

  return { byNode, hasData };
}

function buildClimatologicalFallbackForNodes(
  nodes: ClimateGraphNode[],
  cityLabel: string,
  startYear = 2022,
  endYear = 2025,
  isDenver = true
): SolarGraphAnalysisResult {
  const safeStart = Math.max(2015, Math.min(2023, Math.trunc(startYear)));
  const safeEnd = Math.max(safeStart + 2, Math.min(2026, Math.trunc(endYear)));
  const totalDays = Math.min(1460, Math.max(420, (safeEnd - safeStart + 1) * 365));
  const endMs = Date.UTC(Math.min(2025, safeEnd), 11, 31);
  const startMs = endMs - (totalDays - 1) * 86_400_000;

  const seriesByNode: Record<string, DailyWeatherRow[]> = {};
  for (const [nodeIdx, node] of nodes.entries()) {
    const rows: DailyWeatherRow[] = [];
    const leadDays = nodeIdx === 1 ? 1 : nodeIdx === 0 ? 0 : 0.5;

    for (let i = 0; i < totalDays; i++) {
      const dt = new Date(startMs + i * 86_400_000);
      const iso = dt.toISOString().slice(0, 10);
      const date = iso.replace(/-/g, "");
      const doy = dayOfYear(date);
      const clrsky = computeClearSkyFallbackKwh(node.lat, doy);
      const tStormIndex = i + leadDays;
      // Periodic synoptic wave troughs (deterministic, reproducible)
      const inStorm =
        (Math.floor(tStormIndex) % 13 === 0 || Math.floor(tStormIndex) % 19 === 0) &&
        Math.sin(tStormIndex * 0.45 + nodeIdx * 0.15) > -0.25;
      const kt = inStorm
        ? Math.max(0.28, 0.42 + Math.sin(i * 0.7) * 0.08)
        : Math.min(0.84, 0.68 + Math.sin(i * 0.31 + nodeIdx * 0.2) * 0.09);
      const allsky = Number((clrsky * kt).toFixed(3));
      const baseTemp = 26 - Math.abs(node.lat) * 0.42;
      const seasonalPhase = node.lat >= 0 ? doy - 105 : doy + 77;
      const seasonalTemp =
        baseTemp -
        Math.max(0, node.elevationM - 500) * 0.0055 +
        Math.sin((seasonalPhase / 365) * Math.PI * 2) * 12.5;

      rows.push({
        date,
        allsky,
        clrsky: Number(clrsky.toFixed(3)),
        kt: Number(kt.toFixed(4)),
        t2m: Number((seasonalTemp + (inStorm ? -5.4 : 1.1)).toFixed(2)),
        rh2m: inStorm ? 78 : 42,
        precip: inStorm ? 5.6 : 0,
        ws10m: inStorm ? 6.8 : 3.2,
        wd10m: inStorm && nodeIdx === 1 ? 275 : inStorm ? 290 : 255,
        ps: 101.3 * Math.exp(-Math.max(0, node.elevationM) / 8434.5),
        eveCloudPct: inStorm ? 82 : 24,
        eveCloud23Pct: inStorm ? 86 : 21,
        eveRhPct: inStorm ? 76 : 38,
        eveWsMs: inStorm ? 6.4 : 2.9,
        eveWdDeg: inStorm ? 278 : 252,
        evePsTrendHpa: inStorm ? -3.4 : 0.6,
      });
    }
    seriesByNode[node.id] = rows;
  }

  const targetSeries = seriesByNode[nodes[0].id] ?? [];
  const splitIdx = Math.floor(totalDays * 0.72);
  const splitDate = targetSeries[splitIdx]?.date ?? `${safeEnd}0101`;
  const result = runThreeWaySolarEvaluation(
    seriesByNode,
    splitDate,
    `${cityLabel} Climatological Baseline (Offline/Outage Fallback)`,
    { nodes, cityLabel, isDenver }
  );
  result.dataSource = isDenver
    ? "Colorado Front Range Physical Climatological Baseline (NASA POWER + Open-Meteo Offline Fallback)"
    : `${cityLabel} Physical Climatological Baseline (NASA POWER Offline Fallback)`;
  result.provenanceMode = "climatological_fallback";
  return result;
}

/**
 * Deterministic Colorado Front Range 7-node synthetic solar & synoptic advection baseline
 * used when both NASA POWER and Open-Meteo upstream services fail or time out.
 */
export function buildDenverSolarClimatologicalFallback(
  startYear = 2022,
  endYear = 2025
): SolarGraphAnalysisResult {
  return buildClimatologicalFallbackForNodes(
    DENVER_CLIMATE_NODES,
    "Denver, CO (Front Range)",
    startYear,
    endYear,
    true
  );
}

export async function fetchDenverSolarClimateGraph(
  startYear = 2019,
  endYear = new Date().getUTCFullYear(),
  options?: { forceRefresh?: boolean; timeoutMs?: number }
): Promise<SolarGraphAnalysisResult> {
  const key = `v4:${startYear}:${endYear}`;
  if (!options?.forceRefresh) {
    const cached = SOLAR_CACHE.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, provenanceMode: "cached" };
    }
    const persisted = readPersistentSolarCache(key);
    if (persisted) {
      SOLAR_CACHE.set(key, { expiresAt: Date.now() + SOLAR_CACHE_TTL_MS, result: persisted });
      return { ...persisted, provenanceMode: "cached" };
    }
  }

  const now = new Date();
  const todayYyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
  // Respect NASA POWER's 3-5 day processing lag so queries never request unpublished dates
  const laggedYyyymmdd = new Date(now.getTime() - 5 * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const start = `${startYear}0101`;
  const includeCurrentYear = endYear >= now.getUTCFullYear();
  const primaryEnd = includeCurrentYear ? laggedYyyymmdd : `${endYear}1231`;
  const archiveEndIso = formatIsoDate(primaryEnd);

  let usedOpenMeteoBridge = false;
  let usedOpenMeteoArchiveFallback = false;

  const routeBudgetMs =
    options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 1500;
  const perRequestTimeoutMs =
    routeBudgetMs > 2000
      ? Math.min(12000, Math.floor(routeBudgetMs * 0.7))
      : 1100;
  const budget = createTelemetryBudget(routeBudgetMs);
  const eveningPromise = fetchEveningHourlyByNode(
    DENVER_CLIMATE_NODES,
    `${startYear}-01-01`,
    archiveEndIso,
    includeCurrentYear,
    budget,
    { timeoutMs: perRequestTimeoutMs }
  );

  const buildDegradedResult = (): SolarGraphAnalysisResult => {
    const staleMem = SOLAR_CACHE.get(key);
    const faults = budget.faults;
    if (staleMem) {
      return {
        ...staleMem.result,
        provenanceMode: "cached",
        ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
        elapsedMs: budget.elapsedMs(),
      };
    }
    const staleDisk = readPersistentSolarCache(key, { allowStale: true });
    if (staleDisk) {
      return {
        ...staleDisk,
        provenanceMode: "cached",
        ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
        elapsedMs: budget.elapsedMs(),
      };
    }
    if (!options?.forceRefresh) {
      const bundledSeed = readBundledDenverSeed(startYear, endYear);
      if (bundledSeed) {
        SOLAR_CACHE.set(key, {
          expiresAt: Date.now() + 1000 * 60 * 15,
          result: bundledSeed,
        });
        return {
          ...bundledSeed,
          provenanceMode: "cached",
          elapsedMs: budget.elapsedMs(),
        };
      }
    }
    const fallback = buildDenverSolarClimatologicalFallback(startYear, endYear);
    return {
      ...fallback,
      ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
      elapsedMs: budget.elapsedMs(),
    };
  };

  const runLivePipeline = async (): Promise<SolarGraphAnalysisResult> => {
    const entries: Array<readonly [string, DailyWeatherRow[]]> = [];
    const batchSize = DENVER_CLIMATE_NODES.length;
    for (let i = 0; i < DENVER_CLIMATE_NODES.length; i += batchSize) {
      const batch = DENVER_CLIMATE_NODES.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (node) => {
          let rows: DailyWeatherRow[];
          try {
            rows = await fetchNodeNasaPowerRows(
              node,
              start,
              primaryEnd,
              budget,
              perRequestTimeoutMs
            );
            if (rows.length === 0) {
              throw new Error(`NASA POWER returned 0 valid rows for ${node.name}`);
            }
          } catch (nasaErr) {
            budget.recordFault(
              classifyUpstreamFault(nasaErr, `NASA POWER Daily (${node.name})`)
            );
            try {
              const archiveRows = await fetchOpenMeteoArchiveRows(
                node,
                startYear,
                archiveEndIso,
                budget
              );
              if (archiveRows.length === 0) {
                throw nasaErr;
              }
              rows = archiveRows;
              usedOpenMeteoArchiveFallback = true;
            } catch (archiveErr) {
              budget.recordFault(
                classifyUpstreamFault(archiveErr, `Open-Meteo Archive (${node.name})`)
              );
              throw nasaErr;
            }
          }

          // Bridge recent latency with real-time Open-Meteo observations
          if (includeCurrentYear && rows.length > 0 && budget.remainingMs() > 200) {
            const lastObsDate = rows[rows.length - 1].date;
            const lastClrsky = rows[rows.length - 1].clrsky;
            const bridgeRows = await fetchOpenMeteoBridgeRows(node, lastClrsky, budget);
            for (const br of bridgeRows) {
              if (br.date > lastObsDate && br.date <= todayYyyymmdd) {
                rows.push(br);
                usedOpenMeteoBridge = true;
              }
            }
          }

          return [node.id, rows] as const;
        })
      );
      entries.push(...batchResults);
    }

    const eveningHourly = await eveningPromise;
    for (const [nodeId, rows] of entries) {
      const eveMap = eveningHourly.byNode.get(nodeId);
      if (!eveMap || eveMap.size === 0) continue;
      for (const row of rows) {
        const eve = eveMap.get(row.date);
        if (eve) {
          row.eveCloudPct = eve.eveCloudPct;
          row.eveCloud23Pct = eve.eveCloud23Pct;
          row.eveRhPct = eve.eveRhPct;
          row.eveWsMs = eve.eveWsMs;
          row.eveWdDeg = eve.eveWdDeg;
          row.evePsTrendHpa = eve.evePsTrendHpa;
        }
      }
    }

    const seriesByNode = Object.fromEntries(entries);
    const targetSeries = seriesByNode["denver-target"] ?? [];
    const latestTargetDate = targetSeries[targetSeries.length - 1]?.date ?? "";
    const splitYyyymmdd =
      latestTargetDate >= "20250301"
        ? "20250101"
        : targetSeries.length >= 60
          ? targetSeries[Math.floor(targetSeries.length * 0.8)].date
          : `${endYear}0101`;

    const eveSuffix = eveningHourly.hasData ? " + 18:00–23:00 Hourly Advection" : "";
    const bridgeLabel = usedOpenMeteoArchiveFallback
      ? usedOpenMeteoBridge
        ? `Open-Meteo ERA5 Archive + Real-Time Bridge${eveSuffix}`
        : `Open-Meteo ERA5 Historical Archive${eveSuffix}`
      : usedOpenMeteoBridge
        ? `NASA POWER Daily + Open-Meteo Real-Time Bridge${eveSuffix}`
        : `NASA POWER Daily (CERES SYN1deg & MERRA-2)${eveSuffix}`;

    const result = runThreeWaySolarEvaluation(seriesByNode, splitYyyymmdd, bridgeLabel);
    if (usedOpenMeteoArchiveFallback) {
      result.dataSource = eveningHourly.hasData
        ? "Open-Meteo ERA5 Archive Daily + Evening Hourly (NASA POWER fallback)"
        : "Open-Meteo Historical Archive (ERA5 / Satellite Radiation Fallback)";
    } else if (!eveningHourly.hasData) {
      result.dataSource = "NASA POWER Daily API (CERES SYN1deg & MERRA-2)";
    }
    result.provenanceMode = "live";
    if (budget.faults.length > 0) {
      result.upstreamFault = budget.faults[0];
      result.upstreamFaults = budget.faults;
    }
    result.elapsedMs = budget.elapsedMs();

    const expiresAt = Date.now() + SOLAR_CACHE_TTL_MS;
    SOLAR_CACHE.set(key, { expiresAt, result });
    writePersistentSolarCache(key, expiresAt, result);
    return result;
  };

  try {
    return await budget.raceWithFallback(runLivePipeline(), buildDegradedResult);
  } catch (err) {
    budget.recordFault(classifyUpstreamFault(err, "Solar Microgrid Pipeline"));
    await eveningPromise.catch(() => null);
    return buildDegradedResult();
  }
}

const DYNAMIC_RING_DIRECTIONS: ReadonlyArray<readonly [string, number]> = [
  ["W", 270],
  ["NNW", 330],
  ["NNE", 30],
  ["E", 90],
  ["SSE", 150],
  ["SSW", 210],
];

function offsetRingCoordinate(
  latDeg: number,
  lngDeg: number,
  bearingDegVal: number,
  distKm = 115
): { lat: number; lng: number } {
  const R = 6371;
  const lat1 = latDeg * TO_RAD;
  const lng1 = lngDeg * TO_RAD;
  const brg = bearingDegVal * TO_RAD;
  const ang = distKm / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brg)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
    );
  const normalizedLng = (((lng2 * TO_DEG + 540) % 360) - 180);
  return {
    lat: Number((lat2 * TO_DEG).toFixed(4)),
    lng: Number(normalizedLng.toFixed(4)),
  };
}

export function buildDynamicSolarRingNodes(
  lat: number,
  lng: number,
  label?: string
): ClimateGraphNode[] {
  const safeLat = Math.max(-65, Math.min(65, Number(lat.toFixed(4))));
  const safeLng = Number((((lng + 540) % 360) - 180).toFixed(4));
  const cleanLabel =
    label?.trim() || `${safeLat.toFixed(2)}°, ${safeLng.toFixed(2)}°`;

  const nodes: ClimateGraphNode[] = [
    {
      id: "target-center",
      name: `${cleanLabel} (Target)`,
      role: "target",
      direction: "CENTER",
      distanceKm: 0,
      lat: safeLat,
      lng: safeLng,
      elevationM: 0,
      rationale: "Selected global microgrid & solar forecasting point.",
    },
  ];

  for (const [dir, brg] of DYNAMIC_RING_DIRECTIONS) {
    const pos = offsetRingCoordinate(safeLat, safeLng, brg, 115);
    nodes.push({
      id: `ring-${dir.toLowerCase()}`,
      name: `${cleanLabel} (${dir})`,
      role: "upwind_neighbor",
      direction: dir,
      distanceKm: 115,
      lat: pos.lat,
      lng: pos.lng,
      elevationM: 0,
      rationale: `115 km upwind/surrounding synoptic ring station (${dir}).`,
    });
  }

  return nodes;
}

export async function fetchSolarClimateGraphForLocation(params: {
  lat?: number;
  lng?: number;
  name?: string;
  startYear?: number;
  endYear?: number;
  forceRefresh?: boolean;
}): Promise<SolarGraphAnalysisResult> {
  const rawLat = params.lat;
  const rawLng = params.lng;
  const hasCustomCoords =
    typeof rawLat === "number" &&
    Number.isFinite(rawLat) &&
    typeof rawLng === "number" &&
    Number.isFinite(rawLng);

  if (
    !hasCustomCoords ||
    (Math.abs(rawLat - 39.74) < 0.15 && Math.abs(rawLng + 104.99) < 0.15)
  ) {
    return fetchDenverSolarClimateGraph(
      params.startYear,
      params.endYear,
      params.forceRefresh !== undefined ? { forceRefresh: params.forceRefresh } : undefined
    );
  }

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const dynStartYear = Math.max(2023, params.startYear ?? 2023);
  const dynEndYear = Math.min(currentYear, params.endYear ?? currentYear);
  const safeLat = Math.max(-65, Math.min(65, rawLat));
  const safeLng = ((rawLng + 540) % 360) - 180;
  const cityLabel =
    params.name?.trim() || `${safeLat.toFixed(2)}°, ${safeLng.toFixed(2)}°`;

  const cacheKey = `v4:dyn:${safeLat.toFixed(2)}:${safeLng.toFixed(2)}:${dynStartYear}:${dynEndYear}`;
  if (!params.forceRefresh) {
    const cached = SOLAR_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, provenanceMode: "cached" };
    }
    const persisted = readPersistentSolarCache(cacheKey);
    if (persisted) {
      SOLAR_CACHE.set(cacheKey, {
        expiresAt: Date.now() + SOLAR_CACHE_TTL_MS,
        result: persisted,
      });
      return { ...persisted, provenanceMode: "cached" };
    }
  }

  const ringNodes = buildDynamicSolarRingNodes(safeLat, safeLng, cityLabel);
  const todayYyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const laggedYyyymmdd = new Date(now.getTime() - 5 * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const start = `${dynStartYear}0101`;
  const includeCurrentYear = dynEndYear >= currentYear;
  const primaryEnd = includeCurrentYear ? laggedYyyymmdd : `${dynEndYear}1231`;
  const archiveEndIso = formatIsoDate(primaryEnd);
  const utcOffsetHours = Math.round(safeLng / 15);

  const budget = createTelemetryBudget(1500);
  const eveningPromise = fetchEveningHourlyByNode(
    ringNodes,
    `${dynStartYear}-01-01`,
    archiveEndIso,
    includeCurrentYear,
    budget,
    { utcOffsetHours, skipArchive: true }
  );

  const buildDynamicDegraded = (): SolarGraphAnalysisResult => {
    const staleMem = SOLAR_CACHE.get(cacheKey);
    const faults = budget.faults;
    if (staleMem) {
      return {
        ...staleMem.result,
        provenanceMode: "cached",
        ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
        elapsedMs: budget.elapsedMs(),
      };
    }
    const staleDisk = readPersistentSolarCache(cacheKey, { allowStale: true });
    if (staleDisk) {
      return {
        ...staleDisk,
        provenanceMode: "cached",
        ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
        elapsedMs: budget.elapsedMs(),
      };
    }
    const fallback = buildClimatologicalFallbackForNodes(
      ringNodes,
      cityLabel,
      dynStartYear,
      dynEndYear,
      false
    );
    return {
      ...fallback,
      ...(faults[0] ? { upstreamFault: faults[0], upstreamFaults: faults } : {}),
      elapsedMs: budget.elapsedMs(),
    };
  };

  let usedBridge = false;
  const runDynamicPipeline = async (): Promise<SolarGraphAnalysisResult> => {
    const entries = await Promise.all(
      ringNodes.map(async (node) => {
        let rows: DailyWeatherRow[];
        try {
          rows = await fetchNodeNasaPowerRows(node, start, primaryEnd, budget);
          if (rows.length === 0) {
            throw new Error(`NASA POWER returned 0 valid rows for ${node.name}`);
          }
        } catch (err) {
          budget.recordFault(classifyUpstreamFault(err, `NASA POWER Daily (${node.name})`));
          throw err;
        }

        if (includeCurrentYear && rows.length > 0 && budget.remainingMs() > 200) {
          const lastObsDate = rows[rows.length - 1].date;
          const lastClrsky = rows[rows.length - 1].clrsky;
          const bridgeRows = await fetchOpenMeteoBridgeRows(node, lastClrsky, budget);
          for (const br of bridgeRows) {
            if (br.date > lastObsDate && br.date <= todayYyyymmdd) {
              rows.push(br);
              usedBridge = true;
            }
          }
        }
        return [node.id, rows] as const;
      })
    );

    const eveningHourly = await eveningPromise;
    for (const [nodeId, rows] of entries) {
      const eveMap = eveningHourly.byNode.get(nodeId);
      if (!eveMap || eveMap.size === 0) continue;
      for (const row of rows) {
        const eve = eveMap.get(row.date);
        if (eve) {
          row.eveCloudPct = eve.eveCloudPct;
          row.eveCloud23Pct = eve.eveCloud23Pct;
          row.eveRhPct = eve.eveRhPct;
          row.eveWsMs = eve.eveWsMs;
          row.eveWdDeg = eve.eveWdDeg;
          row.evePsTrendHpa = eve.evePsTrendHpa;
        }
      }
    }

    const seriesByNode = Object.fromEntries(entries);
    const targetSeries = seriesByNode["target-center"] ?? [];
    const latestTargetDate = targetSeries[targetSeries.length - 1]?.date ?? "";
    const splitYyyymmdd =
      latestTargetDate >= "20250301"
        ? "20250101"
        : targetSeries.length >= 60
          ? targetSeries[Math.floor(targetSeries.length * 0.72)].date
          : `${dynEndYear}0101`;

    const eveSuffix = eveningHourly.hasData ? " + 18:00–23:00 Hourly Advection" : "";
    const bridgeLabel = usedBridge
      ? `NASA POWER Daily + Open-Meteo Real-Time Bridge${eveSuffix}`
      : `NASA POWER Daily (CERES SYN1deg & MERRA-2)${eveSuffix}`;

    const result = runThreeWaySolarEvaluation(seriesByNode, splitYyyymmdd, bridgeLabel, {
      nodes: ringNodes,
      cityLabel,
      isDenver: false,
    });
    result.provenanceMode = "live";
    if (budget.faults.length > 0) {
      result.upstreamFault = budget.faults[0];
      result.upstreamFaults = budget.faults;
    }
    result.elapsedMs = budget.elapsedMs();

    const expiresAt = Date.now() + SOLAR_CACHE_TTL_MS;
    SOLAR_CACHE.set(cacheKey, { expiresAt, result });
    writePersistentSolarCache(cacheKey, expiresAt, result);
    return result;
  };

  try {
    return await budget.raceWithFallback(runDynamicPipeline(), buildDynamicDegraded);
  } catch (err) {
    budget.recordFault(classifyUpstreamFault(err, "Dynamic Solar Ring Pipeline"));
    await eveningPromise.catch(() => null);
    return buildDynamicDegraded();
  }
}
