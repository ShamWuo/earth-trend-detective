import type {
  CouplingRegime,
  CrossRegionComparison,
  ETGDatasetId,
  LagProfilePoint,
  MannKendallResult,
  OlsRegressionResult,
  PettittChangePointResult,
  RollingCorrelationPoint,
  TheilSenResult,
  TimeSeriesPoint,
  TrendAnalysisPoint,
  TrendAnalysisSummary,
  TrendProvenanceSource,
} from "@/types/etg";

/**
 * Standard normal cumulative distribution function using
 * Abramowitz & Stegun 7.1.26 rational approximation for erf(x).
 */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function twoTailedNormalPValue(z: number): number {
  if (!Number.isFinite(z)) return 1;
  const absZ = Math.abs(z);
  const p = 2 * (1 - normalCdf(absZ));
  return Math.min(1, Math.max(0, p));
}

/**
 * Exact tie-corrected Mann-Kendall trend test with Hamed & Rao (1998)
 * autocorrelation variance adjustment for serially correlated climate series.
 */
export function mannKendallTest(values: readonly number[], alpha = 0.05): MannKendallResult {
  const n = values.length;
  if (n < 3) {
    return {
      n,
      s: 0,
      varS: 0,
      zScore: 0,
      pValue: 1,
      tau: 0,
      significant: false,
      alpha,
      direction: "no_trend",
      lag1Autocorrelation: 0,
      effectiveSampleSize: n,
      zScoreAdjusted: 0,
      pValueAdjusted: 1,
      significantAdjusted: false,
    };
  }

  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const diff = values[j] - values[i];
      if (diff > 1e-12) s += 1;
      else if (diff < -1e-12) s -= 1;
    }
  }

  // Count tied groups
  const sorted = [...values].sort((a, b) => a - b);
  const tieCounts: number[] = [];
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - sorted[i - 1]) <= 1e-12) {
      run += 1;
    } else {
      if (run > 1) tieCounts.push(run);
      run = 1;
    }
  }
  if (run > 1) tieCounts.push(run);

  let tieSum = 0;
  for (const tp of tieCounts) {
    tieSum += tp * (tp - 1) * (2 * tp + 5);
  }

  const varS = Math.max(0, (n * (n - 1) * (2 * n + 5) - tieSum) / 18);
  let zScore = 0;
  if (varS > 0) {
    if (s > 0) zScore = (s - 1) / Math.sqrt(varS);
    else if (s < 0) zScore = (s + 1) / Math.sqrt(varS);
  }

  const pValue = twoTailedNormalPValue(zScore);
  const denom = (n * (n - 1)) / 2;
  const tau = denom > 0 ? s / denom : 0;
  const significant = pValue < alpha && s !== 0;

  let direction: MannKendallResult["direction"] = "no_trend";
  if (significant) {
    direction = s > 0 ? "increasing" : "decreasing";
  }

  // Hamed & Rao (1998) modified Mann-Kendall variance correction on detrended ranks
  let lag1Autocorrelation = 0;
  let correctionFactor = 1;
  if (n >= 6) {
    const seqSlopes: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        seqSlopes.push((values[j] - values[i]) / (j - i));
      }
    }
    seqSlopes.sort((a, b) => a - b);
    const senSlopeIdx = medianOfSorted(seqSlopes);
    const residuals = values.map((v, idx) => v - senSlopeIdx * idx);
    const ranked = rankArray(residuals);
    const meanR = ranked.reduce((acc, r) => acc + r, 0) / n;
    const varR = ranked.reduce((acc, r) => acc + (r - meanR) ** 2, 0);

    if (varR > 1e-12) {
      const maxLag = Math.min(n - 3, 10);
      const critBand = 1.959963984540054 / Math.sqrt(n);
      let weightedRhoSum = 0;

      for (let k = 1; k <= maxLag; k++) {
        let cov = 0;
        for (let i = 0; i < n - k; i++) {
          cov += (ranked[i] - meanR) * (ranked[i + k] - meanR);
        }
        const rhoK = cov / varR;
        if (k === 1) lag1Autocorrelation = Number(rhoK.toFixed(4));
        if (Math.abs(rhoK) > critBand) {
          weightedRhoSum += (n - k) * (n - k - 1) * (n - k - 2) * rhoK;
        }
      }

      const rawCorrection = 1 + (2 / (n * (n - 1) * (n - 2))) * weightedRhoSum;
      // Keep variance inflation conservative (>= 1.0) so cyclic negative lag oscillations
      // never yield an effective sample size n* > n or overstate trend significance.
      correctionFactor = Math.max(1.0, Math.min(6.0, rawCorrection));
    }
  }

  const varSAdj = varS * correctionFactor;
  let zScoreAdjusted = 0;
  if (varSAdj > 0) {
    if (s > 0) zScoreAdjusted = (s - 1) / Math.sqrt(varSAdj);
    else if (s < 0) zScoreAdjusted = (s + 1) / Math.sqrt(varSAdj);
  }
  const pValueAdjusted = twoTailedNormalPValue(zScoreAdjusted);
  const significantAdjusted = pValueAdjusted < alpha && s !== 0;
  const effectiveSampleSize = Number((n / correctionFactor).toFixed(2));

  return {
    n,
    s,
    varS,
    zScore,
    pValue,
    tau,
    significant,
    alpha,
    direction,
    lag1Autocorrelation,
    effectiveSampleSize,
    zScoreAdjusted,
    pValueAdjusted,
    significantAdjusted,
  };
}

function medianOfSorted(sorted: readonly number[]): number {
  const len = sorted.length;
  if (len === 0) return 0;
  const mid = Math.floor(len / 2);
  if (len % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Non-parametric Theil-Sen robust slope estimator with 95% confidence interval.
 */
export function theilSenEstimator(
  points: readonly { t: number; value: number }[],
  varSOverride?: number
): TheilSenResult {
  const n = points.length;
  if (n < 2) {
    return {
      slope: 0,
      intercept: points[0]?.value ?? 0,
      slopeLow95: 0,
      slopeHigh95: 0,
      pairCount: 0,
    };
  }

  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dt = points[j].t - points[i].t;
      if (Math.abs(dt) > 1e-12) {
        slopes.push((points[j].value - points[i].value) / dt);
      }
    }
  }

  slopes.sort((a, b) => a - b);
  const slope = medianOfSorted(slopes);

  const intercepts = points.map((p) => p.value - slope * p.t).sort((a, b) => a - b);
  const intercept = medianOfSorted(intercepts);

  const pairCount = slopes.length;
  const varS =
    varSOverride !== undefined
      ? varSOverride
      : (n * (n - 1) * (2 * n + 5)) / 18;
  const cAlpha = 1.959963984540054 * Math.sqrt(Math.max(0, varS));
  const m1 = Math.max(0, Math.floor((pairCount - cAlpha) / 2));
  const m2 = Math.min(pairCount - 1, Math.ceil((pairCount + cAlpha) / 2));

  return {
    slope,
    intercept,
    slopeLow95: slopes[m1] ?? slope,
    slopeHigh95: slopes[m2] ?? slope,
    pairCount,
  };
}

function logGamma(z: number): number {
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (zz + i);
  const t = zz + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const fpmin = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 120; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-10) break;
  }
  return h;
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function studentTTwoTailedPValue(tStat: number, df: number): number {
  if (!Number.isFinite(tStat) || df < 1) return 1;
  if (Math.abs(tStat) < 1e-12) return 1;
  const x = df / (df + tStat * tStat);
  return Math.min(1, Math.max(0, regularizedIncompleteBeta(df / 2, 0.5, x)));
}

/**
 * Parametric Ordinary Least Squares (OLS) regression matching NASA SeaWiFS
 * river-influenced coastal time-series significance methodology (Acker et al. 2009).
 */
export function computeOlsRegression(
  points: readonly { t: number; value: number }[]
): OlsRegressionResult {
  const n = points.length;
  if (n < 3) {
    return {
      slope: 0,
      intercept: points[0]?.value ?? 0,
      rSquared: 0,
      tStat: 0,
      pValue: 1,
    };
  }

  let meanT = 0;
  let meanY = 0;
  for (const p of points) {
    meanT += p.t;
    meanY += p.value;
  }
  meanT /= n;
  meanY /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dt = p.t - meanT;
    const dy = p.value - meanY;
    sxx += dt * dt;
    syy += dy * dy;
    sxy += dt * dy;
  }

  if (sxx <= 1e-12) {
    return { slope: 0, intercept: meanY, rSquared: 0, tStat: 0, pValue: 1 };
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanT;
  const rSquared = syy > 1e-12 ? Math.min(1, Math.max(0, (sxy * sxy) / (sxx * syy))) : 0;
  const sse = Math.max(0, syy - slope * sxy);
  const residualVar = sse / (n - 2);
  const seSlope = Math.sqrt(residualVar / sxx);
  const tStat = seSlope > 1e-12 ? slope / seSlope : Math.abs(slope) > 1e-12 ? 999 * Math.sign(slope) : 0;
  const pValue = seSlope > 1e-12 ? studentTTwoTailedPValue(tStat, n - 2) : Math.abs(slope) > 1e-12 ? 0 : 1;

  return {
    slope,
    intercept,
    rSquared: Number(rSquared.toFixed(4)),
    tStat: Number(tStat.toFixed(3)),
    pValue,
  };
}

/**
 * Pettitt (1979) non-parametric single change-point detection on ranked observations.
 */
export function computePettittChangePoint(
  points: readonly { date: string; t: number; value: number }[]
): PettittChangePointResult | null {
  const n = points.length;
  if (n < 8) return null;

  let bestT = 0;
  let kStat = 0;
  for (let t = 0; t < n - 1; t++) {
    let u = 0;
    for (let i = 0; i <= t; i++) {
      for (let j = t + 1; j < n; j++) {
        const diff = points[i].value - points[j].value;
        if (diff > 1e-12) u += 1;
        else if (diff < -1e-12) u -= 1;
      }
    }
    const absU = Math.abs(u);
    if (absU > kStat) {
      kStat = absU;
      bestT = t;
    }
  }

  const pValue = Math.min(1, Math.max(0, 2 * Math.exp((-6 * kStat * kStat) / (n ** 3 + n ** 2))));
  const shiftIdx = Math.min(n - 1, bestT + 1);
  return {
    index: shiftIdx,
    date: points[shiftIdx].date,
    kStat,
    pValue,
    significant: pValue < 0.05,
  };
}

/**
 * Full statistical trend analysis on a coordinate time-series.
 */
export function analyzeTimeSeries(
  rawPoints: readonly TimeSeriesPoint[],
  options: {
    lat: number;
    lng: number;
    dataset: ETGDatasetId;
    parameter: string;
    unit: string;
    slopeUnit: string;
    provenance: TrendProvenanceSource;
    alpha?: number;
  }
): TrendAnalysisSummary {
  const sorted = [...rawPoints].sort((a, b) => a.t - b.t);
  const values = sorted.map((p) => p.value);
  const n = values.length;

  const mean = n > 0 ? values.reduce((acc, v) => acc + v, 0) / n : 0;
  const variance =
    n > 1 ? values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const min = n > 0 ? Math.min(...values) : 0;
  const max = n > 0 ? Math.max(...values) : 0;

  const mk = mannKendallTest(values, options.alpha ?? 0.05);
  const ts = theilSenEstimator(sorted, mk.varS);
  const ols = computeOlsRegression(sorted);
  const changePoint = computePettittChangePoint(sorted);

  const points: TrendAnalysisPoint[] = sorted.map((p, idx) => {
    const start = Math.max(0, idx - 2);
    const windowSlice = values.slice(start, idx + 1);
    const movingAverage =
      windowSlice.reduce((acc, v) => acc + v, 0) / Math.max(1, windowSlice.length);
    const theilSenFit = ts.slope * p.t + ts.intercept;
    const zScore = stdDev > 1e-12 ? (p.value - mean) / stdDev : 0;
    return {
      date: p.date,
      t: p.t,
      value: p.value,
      movingAverage,
      theilSenFit,
      zScore,
    };
  });

  const latestValue = values[n - 1] ?? 0;
  const latestAnomalyZ = stdDev > 1e-12 ? (latestValue - mean) / stdDev : 0;

  let verdict: TrendAnalysisSummary["verdict"] = "Normal Environmental Variability";
  if (mk.significant && Math.abs(ts.slope) > 1e-9) {
    verdict =
      mk.direction === "increasing"
        ? "Statistically Significant Increasing Trend"
        : "Statistically Significant Decreasing Trend";
  }

  return {
    lat: options.lat,
    lng: options.lng,
    dataset: options.dataset,
    parameter: options.parameter,
    unit: options.unit,
    slopeUnit: options.slopeUnit,
    provenance: options.provenance,
    mean,
    stdDev,
    min,
    max,
    latestValue,
    latestAnomalyZ,
    mannKendall: mk,
    theilSen: ts,
    ols,
    changePoint,
    verdict,
    points,
  };
}

function rankArray(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && Math.abs(indexed[j].v - indexed[i].v) <= 1e-12) {
      j++;
    }
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denom = Math.sqrt(denA * denB);
  return denom > 1e-12 ? num / denom : 0;
}

export interface CompareSeriesContext {
  latA?: number;
  lngA?: number;
  datasetA?: ETGDatasetId | string;
  latB?: number;
  lngB?: number;
  datasetB?: ETGDatasetId | string;
  maxLag?: number;
}

function fisherPValue(r: number, n: number): number {
  if (n <= 3 || !Number.isFinite(r)) return 1;
  const clampedR = Math.max(-0.9999, Math.min(0.9999, r));
  const fisherZ = 0.5 * Math.log((1 + clampedR) / (1 - clampedR)) * Math.sqrt(n - 3);
  return twoTailedNormalPValue(fisherZ);
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function inferLagUnit(paired: readonly { date: string; tA: number }[]): "months" | "years" | "days" {
  if (paired.length < 2) return "months";
  const sample = paired[0].date;
  if (/^\d{4}$/.test(sample)) return "years";
  if (/^\d{4}-\d{2}$/.test(sample)) return "months";

  const d0 = Date.parse(paired[0].date);
  const d1 = Date.parse(paired[1].date);
  if (Number.isFinite(d0) && Number.isFinite(d1)) {
    const days = Math.abs(d1 - d0) / 86_400_000;
    if (days >= 300) return "years";
    if (days >= 24 && days <= 36) return "months";
    if (days > 0) return "days";
  }

  const avgDt = Math.abs(paired[1].tA - paired[0].tA);
  if (avgDt >= 0.8 && avgDt <= 1.2) return "years";
  if (avgDt >= 0.06 && avgDt <= 0.11) return "months";
  return "months";
}

function extractYearFromDate(dateStr: string): number | null {
  const match = dateStr.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

/**
 * Classifies the likely physical Earth-system mechanism linking two regional series
 * using geographic separation, dataset types, detrended variability, and lead-lag structure.
 */
export function classifyEarthMechanism(
  context: CompareSeriesContext | undefined,
  metrics: {
    pearsonR: number;
    detrendedR: number;
    optimalLagSteps: number;
    optimalLagR: number;
    classification: CrossRegionComparison["classification"];
  }
): string {
  const { pearsonR, detrendedR, optimalLagSteps, optimalLagR, classification } = metrics;
  const maxSignal = Math.max(Math.abs(pearsonR), Math.abs(detrendedR), Math.abs(optimalLagR));
  if (classification === "decoupled" && maxSignal < 0.45) {
    return "Independent / Decoupled";
  }

  const distKm =
    context?.latA !== undefined &&
    context?.lngA !== undefined &&
    context?.latB !== undefined &&
    context?.lngB !== undefined
      ? haversineKm(context.latA, context.lngA, context.latB, context.lngB)
      : null;

  const dA = context?.datasetA ?? "";
  const dB = context?.datasetB ?? "";
  const dsPair = new Set([dA, dB]);
  const hasThermal =
    dsPair.has("nasa_power") ||
    dsPair.has("wildfire") ||
    dsPair.has("temperature");
  const hasHydroOrBio =
    dsPair.has("hydrology") ||
    dsPair.has("deforestation") ||
    dsPair.has("precipitation") ||
    dsPair.has("humidity");

  if (distKm !== null && distKm < 350) {
    if (hasThermal && hasHydroOrBio) {
      return "Compound Hydro-Thermal Feedback";
    }
    return "Compound Local Coupling";
  }

  const polarRegion =
    Math.abs(context?.latA ?? 0) >= 60 ||
    Math.abs(context?.latB ?? 0) >= 60 ||
    dsPair.has("cryosphere");
  if (polarRegion && (dsPair.has("temperature") || dsPair.has("hydrology") || dsPair.has("ocean_temp") || dsPair.has("co2"))) {
    return "Polar Amplification Cascade";
  }

  const absLatA = Math.abs(context?.latA ?? 0);
  const absLatB = Math.abs(context?.latB ?? 0);
  const tropicalToMidLat =
    context?.latA !== undefined &&
    context?.latB !== undefined &&
    ((absLatA <= 25 && absLatB >= 30) || (absLatB <= 25 && absLatA >= 30));

  if (dsPair.has("ocean_temp") && pearsonR <= -0.35) {
    return "ENSO / Zonal Wave Dipole";
  }

  if (tropicalToMidLat && Math.max(Math.abs(detrendedR), Math.abs(optimalLagR)) >= 0.35) {
    return "Tropical-Extratropical Rossby Bridge";
  }

  if (pearsonR <= -0.45) {
    return "Planetary Dipole See-Saw";
  }

  if (Math.abs(optimalLagSteps) >= 1 && Math.abs(optimalLagR) >= 0.45) {
    return "Lead-Lag Atmospheric Bridge";
  }

  if (Math.abs(detrendedR) < 0.3 && Math.abs(pearsonR) >= 0.5) {
    return "Shared External Forcing (Secular)";
  }

  return "Cross-Sphere Teleconnection";
}

/**
 * Compares two regional time-series using Pearson/Spearman level correlation,
 * Theil-Sen detrended residual coupling, lead-lag cross-correlogram (Δt),
 * rolling coupling stability, amplification slope ratio, and Earth-system mechanism tagging.
 */
export function compareRegionalSeries(
  seriesA: readonly TimeSeriesPoint[],
  seriesB: readonly TimeSeriesPoint[],
  context?: CompareSeriesContext
): CrossRegionComparison {
  const mapB = new Map(seriesB.map((p) => [p.date, p]));
  const paired: Array<{ date: string; tA: number; tB: number; rawA: number; rawB: number }> = [];

  for (const ptA of seriesA) {
    const ptB = mapB.get(ptA.date);
    if (ptB !== undefined) {
      paired.push({
        date: ptA.date,
        tA: ptA.t,
        tB: ptB.t,
        rawA: ptA.value,
        rawB: ptB.value,
      });
    }
  }

  // Fallback to positional alignment if date labels differ
  if (paired.length < 3) {
    paired.length = 0;
    const len = Math.min(seriesA.length, seriesB.length);
    for (let i = 0; i < len; i++) {
      paired.push({
        date: seriesA[i].date,
        tA: seriesA[i].t,
        tB: seriesB[i].t,
        rawA: seriesA[i].value,
        rawB: seriesB[i].value,
      });
    }
  }

  const valsA = paired.map((p) => p.rawA);
  const valsB = paired.map((p) => p.rawB);
  const n = paired.length;

  const pearsonR = pearsonCorrelation(valsA, valsB);
  const spearmanRho =
    n >= 3 ? pearsonCorrelation(rankArray(valsA), rankArray(valsB)) : 0;
  const pValue = fisherPValue(pearsonR, n);

  const ptsA = paired.map((p, idx) => ({
    date: p.date,
    t: Number.isFinite(p.tA) ? p.tA : idx,
    value: p.rawA,
  }));
  const ptsB = paired.map((p, idx) => ({
    date: p.date,
    t: Number.isFinite(p.tB) ? p.tB : idx,
    value: p.rawB,
  }));

  const senA = theilSenEstimator(ptsA);
  const senB = theilSenEstimator(ptsB);
  const resA = ptsA.map((p) => p.value - (senA.slope * p.t + senA.intercept));
  const resB = ptsB.map((p) => p.value - (senB.slope * p.t + senB.intercept));

  const meanA = n > 0 ? valsA.reduce((s, v) => s + v, 0) / n : 0;
  const meanB = n > 0 ? valsB.reduce((s, v) => s + v, 0) / n : 0;
  const stdA =
    n > 1 ? Math.sqrt(valsA.reduce((s, v) => s + (v - meanA) ** 2, 0) / (n - 1)) : 1;
  const stdB =
    n > 1 ? Math.sqrt(valsB.reduce((s, v) => s + (v - meanB) ** 2, 0) / (n - 1)) : 1;

  const meanResA = n > 0 ? resA.reduce((s, v) => s + v, 0) / n : 0;
  const meanResB = n > 0 ? resB.reduce((s, v) => s + v, 0) / n : 0;
  const stdResA =
    n > 1 ? Math.sqrt(resA.reduce((s, v) => s + (v - meanResA) ** 2, 0) / (n - 1)) : 0;
  const stdResB =
    n > 1 ? Math.sqrt(resB.reduce((s, v) => s + (v - meanResB) ** 2, 0) / (n - 1)) : 0;

  const hasResidualVariance = stdResA > 1e-9 && stdResB > 1e-9;
  const detrendedR = hasResidualVariance ? pearsonCorrelation(resA, resB) : 0;
  const detrendedPValue = hasResidualVariance ? fisherPValue(detrendedR, n) : 1;

  const alignedPoints = paired.map((p, i) => ({
    date: p.date,
    rawA: p.rawA,
    rawB: p.rawB,
    zA: stdA > 1e-12 ? (p.rawA - meanA) / stdA : 0,
    zB: stdB > 1e-12 ? (p.rawB - meanB) / stdB : 0,
    detrendedZA: stdResA > 1e-9 ? (resA[i] - meanResA) / stdResA : 0,
    detrendedZB: stdResB > 1e-9 ? (resB[i] - meanResB) / stdResB : 0,
  }));

  // Lead-Lag Cross-Correlogram: k > 0 compares A[i] with B[i + k] (A leads B by k steps)
  const lagUnit = inferLagUnit(paired);
  const activeA = stdResA > 1e-9 ? resA : valsA;
  const activeB = stdResB > 1e-9 ? resB : valsB;
  const maxLag = n >= 8 ? Math.min(context?.maxLag ?? 6, Math.max(1, Math.floor((n - 4) / 2))) : 0;
  const lagProfile: LagProfilePoint[] = [];

  for (let k = -maxLag; k <= maxLag; k++) {
    const startI = Math.max(0, -k);
    const endI = Math.min(n - 1, n - 1 - k);
    const sliceA: number[] = [];
    const sliceB: number[] = [];
    for (let i = startI; i <= endI; i++) {
      sliceA.push(activeA[i]);
      sliceB.push(activeB[i + k]);
    }
    const r = sliceA.length >= 4 ? pearsonCorrelation(sliceA, sliceB) : 0;
    lagProfile.push({
      lagSteps: k,
      r,
      pValue: fisherPValue(r, sliceA.length),
      n: sliceA.length,
    });
  }

  const zeroLagPt = lagProfile.find((p) => p.lagSteps === 0) ?? {
    lagSteps: 0,
    r: hasResidualVariance ? detrendedR : pearsonR,
    pValue: hasResidualVariance ? detrendedPValue : pValue,
    n,
  };
  let bestLagPt = zeroLagPt;
  for (const pt of lagProfile) {
    if (pt.n < 6) continue;
    const absBest = Math.abs(bestLagPt.r);
    const absCurr = Math.abs(pt.r);
    if (absCurr > absBest + 0.03) {
      bestLagPt = pt;
    } else if (Math.abs(absCurr - absBest) <= 0.03 && Math.abs(pt.lagSteps) < Math.abs(bestLagPt.lagSteps)) {
      bestLagPt = pt;
    }
  }

  const optimalLagSteps = bestLagPt.lagSteps;
  const optimalLagR = bestLagPt.r;
  const optimalLagPValue = bestLagPt.pValue;

  // Rolling window coupling stability
  const rollingCorrelations: RollingCorrelationPoint[] = [];
  if (n >= 8) {
    const w = Math.min(12, Math.max(6, Math.floor(n / 3)));
    for (let i = w - 1; i < n; i++) {
      const sliceRawA = valsA.slice(i - w + 1, i + 1);
      const sliceRawB = valsB.slice(i - w + 1, i + 1);
      const sliceResA = resA.slice(i - w + 1, i + 1);
      const sliceResB = resB.slice(i - w + 1, i + 1);
      rollingCorrelations.push({
        date: paired[i].date,
        r: pearsonCorrelation(sliceRawA, sliceRawB),
        detrendedR: hasResidualVariance ? pearsonCorrelation(sliceResA, sliceResB) : 0,
      });
    }
  }

  // Slope amplification ratio (normalized by sign & magnitude, clamped against tiny denominators)
  const rawRatio = Math.abs(senA.slope) > 1e-12 ? senB.slope / senA.slope : 0;
  const slopeRatio = Math.max(-100, Math.min(100, Number.isFinite(rawRatio) ? rawRatio : 0));

  // Shared Pettitt regime shift alignment
  const pettittA = computePettittChangePoint(ptsA);
  const pettittB = computePettittChangePoint(ptsB);
  let sharedRegimeShiftYear: number | null = null;
  if (pettittA?.significant && pettittB?.significant) {
    const yearA = extractYearFromDate(pettittA.date);
    const yearB = extractYearFromDate(pettittB.date);
    if (yearA !== null && yearB !== null && Math.abs(yearA - yearB) <= 3) {
      sharedRegimeShiftYear = Math.round((yearA + yearB) / 2);
    }
  }

  let classification: CrossRegionComparison["classification"] = "decoupled";
  const effectiveR =
    Math.abs(optimalLagR) >= 0.45 &&
    optimalLagPValue < 0.05 &&
    Math.abs(optimalLagR) > Math.abs(pearsonR) + 0.15
      ? optimalLagR
      : pearsonR;
  const effectiveP = effectiveR === optimalLagR ? optimalLagPValue : pValue;

  if (effectiveR <= -0.45 && effectiveP < 0.05) {
    classification = "opposite_teleconnection";
  } else if (effectiveR >= 0.45 && effectiveP < 0.05) {
    classification = "co_trending";
  }

  let couplingRegime: CouplingRegime = "Decoupled";
  if (Math.abs(pearsonR) < 0.4 && Math.abs(detrendedR) < 0.35 && Math.abs(optimalLagR) < 0.45) {
    couplingRegime = "Decoupled";
  } else if (sharedRegimeShiftYear !== null && Math.abs(pearsonR) >= 0.45) {
    couplingRegime = "Synchronized Regime Shift";
  } else if (Math.abs(detrendedR) >= 0.45 && Math.abs(pearsonR) >= 0.45) {
    couplingRegime = "Compound Trend & Variability";
  } else if (Math.abs(detrendedR) >= 0.45 || Math.abs(optimalLagR) >= 0.45) {
    couplingRegime = "Year-to-Year Teleconnection";
  } else {
    couplingRegime = "Secular Co-Drift (Weak Short-Term)";
  }

  const mechanism = classifyEarthMechanism(context, {
    pearsonR,
    detrendedR,
    optimalLagSteps,
    optimalLagR,
    classification,
  });

  return {
    pearsonR,
    spearmanRho,
    pValue,
    detrendedR,
    detrendedPValue,
    optimalLagSteps,
    optimalLagR,
    optimalLagPValue,
    lagUnit,
    lagProfile,
    rollingCorrelations,
    slopeRatio,
    slopeA: senA.slope,
    slopeB: senB.slope,
    sharedRegimeShiftYear,
    mechanism,
    couplingRegime,
    classification,
    alignedPoints,
  };
}
