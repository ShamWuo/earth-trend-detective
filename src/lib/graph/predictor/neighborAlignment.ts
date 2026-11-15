import {
  aggregateSeriesByBucket,
  computeEtgNodeTrustScore,
  haversineKm,
  inferNodeTemporalScale,
  inferSeriesBucket,
  isCommunityContributorNode,
  type TemporalBucket,
} from "@/lib/graph/etgStore";
import { fitRidgeRegression } from "@/lib/solar/denverClimateGraph";
import type {
  CommunityImpactSummary,
  ETGEdge,
  ETGNode,
  GraphNeighborContribution,
  GraphPredictorModelKind,
  PredictorEvalMetrics,
  TimeSeriesPoint,
} from "@/types/etg";
import {
  computeEvalMetrics,
  dot,
  parseDateKeyMs,
  pearsonTrain,
  previousCoarsePeriodKey,
  tuneAndFitRidgeWithVal,
  type EtgStoreLike,
} from "./predictorTypesAndUtils";

export interface CandidateNeighbor {
  node: ETGNode;
  edge?: ETGEdge;
  hop: number;
  isCandidatePreview: boolean;
  isCommunity: boolean;
  trustScore: number;
  values: Array<number | null>;
  coverage: number;
  rawLagSteps: number;
  edgeWeight: number;
  edgeType: string;
  sourceScale: TemporalBucket;
  isCrossScale: boolean;
}

export interface SelectedNeighbor {
  cand: CandidateNeighbor;
  offset: number;
  mean: number;
  std: number;
  trainCorr: number;
  weightScale: number;
}

export interface ImpulseEvent {
  ms: number;
  intensity: number;
  decayDays: number;
}

export interface CovarStat {
  key: string;
  mean: number;
  std: number;
}

export function collectCandidateNeighborsAndImpulses(args: {
  store: EtgStoreLike;
  targetNode: ETGNode;
  targetEntries: readonly TimeSeriesPoint[];
  bucket: TemporalBucket;
  maxHops: number;
  candidateNeighborUuid?: string;
}): {
  neighborMap: Map<string, CandidateNeighbor>;
  impulseEvents: ImpulseEvent[];
  scalesUsedSet: Set<"day" | "month" | "year" | "impulse">;
} {
  const { store, targetNode, targetEntries, bucket, maxHops, candidateNeighborUuid } = args;

  const upstreamSub = store.traverseSubgraph({
    rootUuid: targetNode.uuid,
    maxHops,
    direction: "upstream",
  });
  const bothSub = store.traverseSubgraph({
    rootUuid: targetNode.uuid,
    maxHops,
    direction: "both",
  });

  const regionalSub = store.assembleRegionalContextSubgraph
    ? store.assembleRegionalContextSubgraph({
        targetUuid: targetNode.uuid,
        radiusKm: 1600,
        maxHops,
        includeGlobalModes: true,
      })
    : null;

  const incidentEdgeByNeighbor = new Map<string, ETGEdge>();
  for (const e of [...upstreamSub.edges, ...bothSub.edges, ...(regionalSub?.edges ?? [])]) {
    if (e.target_uuid === targetNode.uuid && !incidentEdgeByNeighbor.has(e.source_uuid)) {
      incidentEdgeByNeighbor.set(e.source_uuid, e);
    } else if (e.source_uuid === targetNode.uuid && !incidentEdgeByNeighbor.has(e.target_uuid)) {
      incidentEdgeByNeighbor.set(e.target_uuid, e);
    }
  }

  const neighborMap = new Map<string, CandidateNeighbor>();
  const impulseEvents: ImpulseEvent[] = [];
  const scalesUsedSet = new Set<"day" | "month" | "year" | "impulse">([bucket]);
  for (const av of targetNode.properties.available_scales ?? []) {
    scalesUsedSet.add(av);
  }

  const seenConnected = new Set<string>();
  const connectedNodes = [...upstreamSub.nodes, ...bothSub.nodes];
  for (const cn of connectedNodes) seenConnected.add(cn.uuid);

  const orderedNodes: ETGNode[] = [...connectedNodes];
  if (regionalSub) {
    for (const rn of regionalSub.nodes) {
      if (!seenConnected.has(rn.uuid)) orderedNodes.push(rn);
    }
  }

  const considerNode = (n: ETGNode, hop: number, isPreview: boolean, connectedOnly: boolean) => {
    if (n.uuid === targetNode.uuid) return;
    if (n.properties.status === "Superseded") return;

    const multiScaled = store.getNodeMultiScaleSeries?.(n.uuid, bucket);
    const rawS = multiScaled && multiScaled.length > 0 ? multiScaled : store.getNodeSeries(n.uuid);
    const scaleKind = inferNodeTemporalScale(n, rawS);

    // Record discrete impulse events (connected OR within 1600 km regional radius)
    if (
      scaleKind === "impulse" ||
      typeof n.properties.event_intensity === "number" ||
      ((!rawS || rawS.length < 8) && (n.uuid.includes("eonet") || Boolean(n.properties.observed_at)))
    ) {
      let withinRange = seenConnected.has(n.uuid);
      if (
        !withinRange &&
        targetNode.properties.lat !== undefined &&
        targetNode.properties.lng !== undefined &&
        n.properties.lat !== undefined &&
        n.properties.lng !== undefined
      ) {
        withinRange =
          haversineKm(
            targetNode.properties.lat,
            targetNode.properties.lng,
            n.properties.lat,
            n.properties.lng
          ) <= 1600;
      }
      if (withinRange) {
        const intensity = n.properties.event_intensity ?? 1.0;
        const decayDays = n.properties.event_decay_days ?? (n.properties.event_ended_at ? 10 : 18);
        if (n.properties.observed_at) {
          const ms = parseDateKeyMs(n.properties.observed_at);
          if (ms !== null) impulseEvents.push({ ms, intensity, decayDays });
        }
        if (rawS) {
          for (const pt of rawS) {
            const ms = parseDateKeyMs(pt.date);
            if (ms !== null) impulseEvents.push({ ms, intensity, decayDays });
          }
        }
      }
      if (!rawS || rawS.length < 8) return;
    }

    if (connectedOnly && !seenConnected.has(n.uuid) && !isPreview) return;
    if (neighborMap.has(n.uuid)) return;
    if (!rawS || rawS.length < 8) return;

    const nbNativeBucket = inferSeriesBucket(rawS);
    const isCoarserToFiner =
      (nbNativeBucket === "year" && (bucket === "month" || bucket === "day")) ||
      (nbNativeBucket === "month" && bucket === "day");

    let hits = 0;
    let alignedVals: Array<number | null>;
    if (!isCoarserToFiner) {
      const bucketMap = aggregateSeriesByBucket(rawS, bucket);
      alignedVals = targetEntries.map((tp) => {
        const pt = bucketMap.get(tp.date);
        if (pt && Number.isFinite(pt.value)) {
          hits++;
          return pt.value;
        }
        return null;
      });
    } else {
      const coarseBucket: "month" | "year" = nbNativeBucket === "year" ? "year" : "month";
      const coarseMap = aggregateSeriesByBucket(rawS, coarseBucket);
      alignedVals = targetEntries.map((tp) => {
        const prevKey = previousCoarsePeriodKey(tp.date, coarseBucket);
        const pt = prevKey ? coarseMap.get(prevKey) : undefined;
        if (pt && Number.isFinite(pt.value)) {
          hits++;
          return pt.value;
        }
        return null;
      });
    }

    // Fallback: backfill single missing gap via previous observation only (causal LOCF)
    const filledVals: Array<number | null> = [];
    for (let i = 0; i < alignedVals.length; i++) {
      if (alignedVals[i] !== null) {
        filledVals.push(alignedVals[i]);
      } else if (i > 0 && filledVals[i - 1] !== null && alignedVals[i - 1] !== null) {
        filledVals.push(filledVals[i - 1]);
      } else {
        filledVals.push(null);
      }
    }

    const coverage = hits / targetEntries.length;
    if (hits < 8 || coverage < 0.55) return;

    const edge = incidentEdgeByNeighbor.get(n.uuid);
    if (edge && (edge.type === "contradicts" || edge.type === "supersedes")) {
      return;
    }
    const hopDecay = hop > 1 ? Math.pow(0.75, hop - 1) : 1;
    const directSignal =
      edge?.properties.multivariate_partial_r ??
      edge?.properties.partial_r ??
      edge?.properties.correlation_r;
    let baseWeight =
      edge?.properties.weight ??
      (directSignal !== undefined
        ? Math.max(0.35, Math.min(1, Math.abs(directSignal)))
        : 0.72);
    if (edge?.properties.mediated_by) {
      baseWeight *= 0.45;
    } else if (
      typeof (edge?.properties.multivariate_partial_r ?? edge?.properties.partial_r) === "number" &&
      Math.abs((edge?.properties.multivariate_partial_r ?? edge?.properties.partial_r) as number) < 0.15
    ) {
      baseWeight *= 0.7;
    }
    const qVal = edge?.properties.fdr_q_value;
    if (typeof qVal === "number" && Number.isFinite(qVal)) {
      if (qVal <= 0.05) {
        baseWeight *= 1.12;
      } else if (qVal > 0.15) {
        baseWeight *= 0.65;
      }
    }
    const edgeLift = edge?.properties.predictive_lift_pct;
    if (typeof edgeLift === "number" && Number.isFinite(edgeLift)) {
      if (edgeLift < 0) {
        baseWeight *= Math.max(0.35, 1 + edgeLift / 25);
      } else if (edgeLift > 0) {
        baseWeight *= 1 + Math.min(0.2, edgeLift / 50);
      }
    }
    const isCommunity = isCommunityContributorNode(n);
    const trustScore = store.computeNodeTrustScore
      ? store.computeNodeTrustScore(n)
      : computeEtgNodeTrustScore(n);
    const trustMultiplier = isCommunity ? Math.max(0.25, trustScore) : 1;
    const lagRaw = edge?.properties.optimal_lag_steps ?? 1;

    neighborMap.set(n.uuid, {
      node: n,
      edge,
      hop,
      isCandidatePreview: isPreview,
      isCommunity,
      trustScore,
      values: filledVals,
      coverage,
      rawLagSteps: Math.max(1, Math.min(3, Math.abs(lagRaw) || 1)),
      edgeWeight: Math.max(0.15, Math.min(1, baseWeight * hopDecay * trustMultiplier)),
      edgeType: edge ? edge.properties.custom_label || edge.type : "candidate_preview",
      sourceScale: nbNativeBucket,
      isCrossScale: Boolean(edge?.properties.cross_scale) || isCoarserToFiner,
    });
  };

  for (const n of orderedNodes) {
    const hop = upstreamSub.hopByNode[n.uuid] ?? bothSub.hopByNode[n.uuid] ?? 1;
    considerNode(n, hop, false, true);
  }
  if (candidateNeighborUuid) {
    const previewNode = store.getNode(candidateNeighborUuid);
    if (previewNode) {
      considerNode(previewNode, 1, !incidentEdgeByNeighbor.has(previewNode.uuid), false);
    }
  }

  return { neighborMap, impulseEvents, scalesUsedSet };
}

export function extractCausalImpulseAndCovariates(args: {
  targetEntries: readonly TimeSeriesPoint[];
  originIndices: readonly number[];
  trainCount: number;
  impulseEvents: readonly ImpulseEvent[];
  scalesUsedSet: Set<"day" | "month" | "year" | "impulse">;
}): {
  rawImpulseSeries: number[];
  impMean: number;
  impStd: number;
  hasCausalImpulseFeature: boolean;
  activeCovarStats: CovarStat[];
} {
  const { targetEntries, originIndices, trainCount, impulseEvents, scalesUsedSet } = args;

  const targetMsArr = targetEntries.map((tp) => parseDateKeyMs(tp.date) ?? 0);
  const rawImpulseSeries = targetMsArr.map((tMs) => {
    if (impulseEvents.length === 0 || tMs === 0) return 0;
    let sum = 0;
    for (const ev of impulseEvents) {
      if (ev.ms <= tMs) {
        const deltaDays = (tMs - ev.ms) / 86_400_000;
        if (deltaDays <= ev.decayDays * 4) {
          sum += ev.intensity * Math.exp(-deltaDays / Math.max(1, ev.decayDays));
        }
      }
    }
    return Math.min(2.5, sum);
  });

  const trainImpulses = originIndices.slice(0, trainCount).map((t) => rawImpulseSeries[t]);
  const impMean = trainImpulses.reduce((s, v) => s + v, 0) / trainCount;
  const impVar =
    trainImpulses.reduce((s, v) => s + (v - impMean) ** 2, 0) / Math.max(1, trainCount - 1);
  const hasCausalImpulseFeature = impulseEvents.length > 0 && impVar > 1e-8;
  const impStd = Math.max(1e-6, Math.sqrt(impVar));
  if (hasCausalImpulseFeature) scalesUsedSet.add("impulse");

  const covarPrefOrder = ["vpd", "rh2m", "precip", "ws10m", "clrsky", "kt", "t2m_max", "glofas", "pm25"];
  const candidateCovarKeys = new Set<string>();
  for (let i = 0; i < trainCount; i++) {
    const ch = targetEntries[originIndices[i]].channels;
    if (ch) {
      for (const k of Object.keys(ch)) candidateCovarKeys.add(k);
    }
  }
  const activeCovarStats: CovarStat[] = [];
  const orderedCovarKeys = [
    ...covarPrefOrder.filter((k) => candidateCovarKeys.has(k)),
    ...Array.from(candidateCovarKeys).filter((k) => !covarPrefOrder.includes(k)),
  ];
  for (const ck of orderedCovarKeys) {
    if (activeCovarStats.length >= 2) break;
    const vals: number[] = [];
    for (let i = 0; i < trainCount; i++) {
      const v = targetEntries[originIndices[i]].channels?.[ck];
      if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < Math.max(6, Math.floor(trainCount * 0.75))) continue;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1);
    if (variance > 1e-8) {
      activeCovarStats.push({ key: ck, mean, std: Math.sqrt(variance) });
    }
  }

  return { rawImpulseSeries, impMean, impStd, hasCausalImpulseFeature, activeCovarStats };
}

export function selectAndTrustGateNeighbors(args: {
  store: EtgStoreLike;
  neighborMap: Map<string, CandidateNeighbor>;
  targetEntries: readonly TimeSeriesPoint[];
  originIndices: readonly number[];
  trainCount: number;
  horizonSteps: number;
  localXAll: number[][];
  yTrainZ: readonly number[];
  scalesUsedSet: Set<"day" | "month" | "year" | "impulse">;
}): {
  activeNeighbors: SelectedNeighbor[];
  trustGatedCount: number;
  communityNodesEvaluated: number;
} {
  const {
    store,
    neighborMap,
    targetEntries,
    originIndices,
    trainCount,
    horizonSteps,
    localXAll,
    yTrainZ,
    scalesUsedSet,
  } = args;

  const trainTargetSeries = originIndices
    .slice(0, trainCount)
    .map((t) => targetEntries[t + horizonSteps].value);
  const evaluatedNeighbors: SelectedNeighbor[] = [];

  for (const cand of neighborMap.values()) {
    let bestOffset = Math.max(0, Math.min(2, cand.rawLagSteps - horizonSteps));
    let bestAbsR = -1;
    let bestMean = 0;
    let bestStd = 1;
    let bestCorr = 0;

    for (const offset of [0, 1, 2]) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < trainCount; i++) {
        const t = originIndices[i];
        const xv = cand.values[t - offset];
        if (xv !== null && Number.isFinite(xv)) {
          xs.push(xv);
          ys.push(trainTargetSeries[i]);
        }
      }
      if (xs.length < Math.max(6, Math.floor(trainCount * 0.75))) continue;
      const r = pearsonTrain(xs, ys);
      if (Math.abs(r) > bestAbsR) {
        bestAbsR = Math.abs(r);
        bestCorr = r;
        bestOffset = offset;
        bestMean = xs.reduce((s, v) => s + v, 0) / xs.length;
        const xVar = xs.reduce((s, v) => s + (v - bestMean) ** 2, 0) / Math.max(1, xs.length - 1);
        bestStd = Math.max(1e-6, Math.sqrt(xVar));
      }
    }

    if (bestAbsR >= 0) {
      evaluatedNeighbors.push({
        cand,
        offset: bestOffset,
        mean: bestMean,
        std: bestStd,
        trainCorr: bestCorr,
        weightScale: cand.edgeWeight,
      });
    }
  }

  evaluatedNeighbors.sort(
    (a, b) => Math.abs(b.trainCorr) * b.weightScale - Math.abs(a.trainCorr) * a.weightScale
  );
  const maxNeighborsAllowed = Math.max(1, Math.min(6, Math.floor(trainCount / 4)));
  const poolNeighbors = evaluatedNeighbors.slice(0, maxNeighborsAllowed);

  const activeNeighbors: SelectedNeighbor[] = [];
  let trustGatedCount = 0;
  let communityNodesEvaluated = 0;
  for (const nb of poolNeighbors) {
    if (nb.cand.isCommunity) {
      communityNodesEvaluated++;
    }
    if (nb.cand.isCommunity && nb.cand.trustScore < 0.72 && !nb.cand.isCandidatePreview) {
      let rejectNoise = nb.cand.trustScore < 0.5 && Math.abs(nb.trainCorr) < 0.25;
      if (!rejectNoise && trainCount >= 12) {
        const innerValSize = Math.max(3, Math.floor(trainCount * 0.25));
        const innerTrainEnd = trainCount - innerValSize;
        if (innerTrainEnd >= 6) {
          const buildNbPair = (t: number) => {
            const raw = nb.cand.values[t - nb.offset];
            const z = raw !== null && Number.isFinite(raw) ? (raw - nb.mean) / nb.std : 0;
            const prevRaw = t - nb.offset - 1 >= 0 ? nb.cand.values[t - nb.offset - 1] : raw;
            const prevZ =
              prevRaw !== null && Number.isFinite(prevRaw) ? (prevRaw - nb.mean) / nb.std : z;
            return [z * nb.weightScale, (z - prevZ) * nb.weightScale];
          };
          const baseTrainX = localXAll.slice(0, trainCount);
          const withNbX = originIndices
            .slice(0, trainCount)
            .map((t, i) => [...baseTrainX[i], ...buildNbPair(t)]);
          const wBase = fitRidgeRegression(
            baseTrainX.slice(0, innerTrainEnd),
            yTrainZ.slice(0, innerTrainEnd),
            Math.max(1.5, baseTrainX[0].length * 0.65)
          );
          const wWith = fitRidgeRegression(
            withNbX.slice(0, innerTrainEnd),
            yTrainZ.slice(0, innerTrainEnd),
            Math.max(2.0, withNbX[0].length * 0.85)
          );
          let sqBase = 0;
          let sqWith = 0;
          for (let i = innerTrainEnd; i < trainCount; i++) {
            const eb = dot(wBase, baseTrainX[i]) - yTrainZ[i];
            const ew = dot(wWith, withNbX[i]) - yTrainZ[i];
            sqBase += eb * eb;
            sqWith += ew * ew;
          }
          if (Math.sqrt(sqWith / innerValSize) > Math.sqrt(sqBase / innerValSize) * 1.005) {
            rejectNoise = true;
          }
        }
      }
      if (rejectNoise) {
        trustGatedCount++;
        store.updateNode?.(nb.cand.node.uuid, { community_lift_pct: -1 }, true);
        continue;
      }
    }
    activeNeighbors.push(nb);
    scalesUsedSet.add(nb.cand.sourceScale);
  }

  return { activeNeighbors, trustGatedCount, communityNodesEvaluated };
}

export function computeNeighborAndCommunityLift(args: {
  store: EtgStoreLike;
  activeNeighbors: readonly SelectedNeighbor[];
  activeGraphArchitecture: GraphPredictorModelKind;
  localFeatureLen: number;
  linearXAll: number[][];
  nonlinearXAll: number[][];
  linearWeights: readonly number[];
  nonlinWeights: readonly number[];
  yTrainZ: number[];
  trainCount: number;
  horizonSteps: number;
  testActuals: readonly number[];
  selfOnly: PredictorEvalMetrics;
  graphAware: PredictorEvalMetrics;
  persistRmse: number;
  yUnnorm: (z: number) => number;
  communityNodesEvaluated: number;
  trustGatedCount: number;
}): {
  neighborContributions: GraphNeighborContribution[];
  communityImpact?: CommunityImpactSummary;
} {
  const {
    store,
    activeNeighbors,
    activeGraphArchitecture,
    localFeatureLen,
    linearXAll,
    nonlinearXAll,
    linearWeights,
    nonlinWeights,
    yTrainZ,
    trainCount,
    horizonSteps,
    testActuals,
    selfOnly,
    graphAware,
    persistRmse,
    yUnnorm,
    communityNodesEvaluated,
    trustGatedCount,
  } = args;

  const linearBaseLen = linearXAll[0].length;
  const rawContribs = activeNeighbors.map((nb, idx) => {
    const activeW =
      activeGraphArchitecture === "nonlinear_interaction" ? nonlinWeights : linearWeights;
    const wLevel = activeW[localFeatureLen + idx * 2] ?? 0;
    const wDiff = activeW[localFeatureLen + idx * 2 + 1] ?? 0;
    const wInter =
      activeGraphArchitecture !== "linear_ridge"
        ? nonlinWeights[linearBaseLen + idx * 3] ?? 0
        : 0;
    const wHingeHi =
      activeGraphArchitecture !== "linear_ridge"
        ? nonlinWeights[linearBaseLen + idx * 3 + 1] ?? 0
        : 0;
    const wHingeLo =
      activeGraphArchitecture !== "linear_ridge"
        ? nonlinWeights[linearBaseLen + idx * 3 + 2] ?? 0
        : 0;
    const importance = Math.hypot(wLevel, wDiff, wInter, wHingeHi, wHingeLo) * nb.weightScale;

    let ablationLiftPct: number | undefined;
    if (testActuals.length >= 3) {
      let rmseWithout = selfOnly.rmse;
      if (activeNeighbors.length > 1) {
        const dropA = localFeatureLen + idx * 2;
        const dropB = dropA + 1;
        if (activeGraphArchitecture === "linear_ridge") {
          const keepCols = Array.from(
            { length: linearXAll[0].length },
            (_, col) => col
          ).filter((col) => col !== dropA && col !== dropB);
          const reducedX = linearXAll.map((row) => keepCols.map((c) => row[c]));
          const reducedFit = tuneAndFitRidgeWithVal(
            reducedX,
            yTrainZ,
            trainCount,
            Math.max(2.0, keepCols.length * 0.85)
          );
          const predWithout = reducedX
            .slice(trainCount)
            .map((x) => yUnnorm(dot(reducedFit.weights, x)));
          rmseWithout = computeEvalMetrics(testActuals, predWithout, persistRmse).rmse;
        } else {
          const nlBase = linearBaseLen + idx * 3;
          const dropSet = new Set([dropA, dropB, nlBase, nlBase + 1, nlBase + 2]);
          const keepCols = Array.from(
            { length: nonlinearXAll[0].length },
            (_, col) => col
          ).filter((col) => !dropSet.has(col));
          const reducedX = nonlinearXAll.map((row) => keepCols.map((c) => row[c]));
          const reducedFit = tuneAndFitRidgeWithVal(
            reducedX,
            yTrainZ,
            trainCount,
            Math.max(3.0, keepCols.length * 1.0)
          );
          const predWithout = reducedX
            .slice(trainCount)
            .map((x) => yUnnorm(dot(reducedFit.weights, x)));
          rmseWithout = computeEvalMetrics(testActuals, predWithout, persistRmse).rmse;
        }
      }
      ablationLiftPct =
        rmseWithout > 1e-9
          ? Number((((rmseWithout - graphAware.rmse) / rmseWithout) * 100).toFixed(2))
          : 0;

      const edgeUuid = nb.cand.edge?.properties.uuid;
      if (!nb.cand.isCandidatePreview && edgeUuid && store.updateEdge) {
        store.updateEdge(edgeUuid, { predictive_lift_pct: ablationLiftPct }, true);
      }
      if (nb.cand.isCommunity && !nb.cand.isCandidatePreview) {
        store.updateNode?.(nb.cand.node.uuid, { community_lift_pct: ablationLiftPct }, true);
      }
    }

    return { nb, wLevel, importance, ablationLiftPct };
  });
  const totalImp = rawContribs.reduce((s, c) => s + c.importance, 0);

  const neighborContributions: GraphNeighborContribution[] = rawContribs
    .map((c) => ({
      nodeUuid: c.nb.cand.node.uuid,
      nodeName: c.nb.cand.node.properties.name,
      edgeUuid: c.nb.cand.edge?.properties.uuid,
      edgeType: c.nb.cand.edgeType,
      lagSteps: c.nb.offset + horizonSteps,
      correlationR: Number(c.nb.trainCorr.toFixed(3)),
      standardizedWeight: Number((c.wLevel * c.nb.weightScale).toFixed(3)),
      sharePct:
        totalImp > 1e-9
          ? Number(((c.importance / totalImp) * 100).toFixed(1))
          : Number((100 / Math.max(1, rawContribs.length)).toFixed(1)),
      ablationLiftPct: c.ablationLiftPct,
      isCandidatePreview: c.nb.cand.isCandidatePreview || undefined,
    }))
    .sort((a, b) => b.sharePct - a.sharePct);

  let communityImpact: CommunityImpactSummary | undefined;
  if (communityNodesEvaluated > 0) {
    const activeCommIndices = activeNeighbors
      .map((nb, i) => (nb.cand.isCommunity ? i : -1))
      .filter((i) => i >= 0);

    let marginalCommunityLiftPct = 0;
    if (activeCommIndices.length > 0 && testActuals.length >= 3) {
      let rmseNoComm = selfOnly.rmse;
      if (activeCommIndices.length < activeNeighbors.length) {
        const dropSet = new Set<number>();
        for (const ci of activeCommIndices) {
          dropSet.add(localFeatureLen + ci * 2);
          dropSet.add(localFeatureLen + ci * 2 + 1);
          if (activeGraphArchitecture !== "linear_ridge") {
            dropSet.add(linearBaseLen + ci * 3);
            dropSet.add(linearBaseLen + ci * 3 + 1);
            dropSet.add(linearBaseLen + ci * 3 + 2);
          }
        }
        const sourceX =
          activeGraphArchitecture === "linear_ridge" ? linearXAll : nonlinearXAll;
        const keepCols = Array.from({ length: sourceX[0].length }, (_, col) => col).filter(
          (col) => !dropSet.has(col)
        );
        const reducedX = sourceX.map((row) => keepCols.map((c) => row[c]));
        const reducedFit = tuneAndFitRidgeWithVal(
          reducedX,
          yTrainZ,
          trainCount,
          Math.max(2.0, keepCols.length * 0.85)
        );
        const predNoComm = reducedX
          .slice(trainCount)
          .map((x) => yUnnorm(dot(reducedFit.weights, x)));
        rmseNoComm = computeEvalMetrics(testActuals, predNoComm, persistRmse).rmse;
      }
      if (rmseNoComm > 1e-9) {
        marginalCommunityLiftPct = Number(
          (((rmseNoComm - graphAware.rmse) / rmseNoComm) * 100).toFixed(2)
        );
      }
    }

    const topContributors = rawContribs
      .filter((c) => c.nb.cand.isCommunity)
      .map((c) => ({
        uuid: c.nb.cand.node.uuid,
        name: c.nb.cand.node.properties.name,
        liftPct: c.ablationLiftPct ?? 0,
        trustScore: c.nb.cand.trustScore,
      }))
      .sort((a, b) => b.liftPct - a.liftPct)
      .slice(0, 5);

    communityImpact = {
      communityNodesEvaluated,
      communityNodesActive: activeCommIndices.length,
      trustGatedCount,
      marginalCommunityLiftPct,
      topContributors,
    };
  }

  return { neighborContributions, communityImpact };
}
