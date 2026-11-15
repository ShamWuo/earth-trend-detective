import { aggregateSeriesByBucket, inferSeriesBucket } from "@/lib/graph/etgStore";
import { fitRidgeRegression } from "@/lib/solar/denverClimateGraph";
import type {
  GraphPredictionEngineUsed,
  GraphPredictionResult,
  GraphPredictorModelKind,
} from "@/types/etg";
import {
  collectCandidateNeighborsAndImpulses,
  computeNeighborAndCommunityLift,
  extractCausalImpulseAndCovariates,
  selectAndTrustGateNeighbors,
} from "./neighborAlignment";
import {
  advanceDateLabel,
  buildQuantilesAndTrendForecast,
  computeEvalMetrics,
  dot,
  evalPortableInductiveV2ForNode,
  loadLocalInductiveWeightsV2,
  seasonalAngle,
  tuneAndFitRidgeWithVal,
  type EtgStoreLike,
} from "./predictorTypesAndUtils";

/**
 * General Graph-Reading Predictive Engine:
 * Reads a target node's multi-scale time-series, multivariate covariates, discrete
 * impulse events, and community/satellite neighbors in ETG, trains strict temporal
 * holdout Ridge/Ensemble regressors without future data leakage, trust-gates noisy
 * community nodes, and quantifies graph & community lift over Persistence/Self-AR.
 */
export function predictFromGraph(
  store: EtgStoreLike,
  options: {
    targetUuid: string;
    maxHops?: number;
    horizonSteps?: number;
    candidateNeighborUuid?: string;
    preferredBucket?: "day" | "month" | "year";
    cutoffIndex?: number;
  }
): GraphPredictionResult {
  const targetNode = store.getNodeWithSeries(options.targetUuid);
  if (!targetNode) {
    throw new Error(`Target node "${options.targetUuid}" not found.`);
  }
  const preferredSeries =
    options.preferredBucket && store.getNodeMultiScaleSeries
      ? store.getNodeMultiScaleSeries(options.targetUuid, options.preferredBucket)
      : undefined;
  const rawSeries =
    preferredSeries && preferredSeries.length >= 8
      ? preferredSeries
      : targetNode.series ?? store.getNodeSeries(options.targetUuid);
  if (!rawSeries || rawSeries.length < 8) {
    throw new Error(
      `Need at least 8 time-series observations on "${targetNode.properties.name}" to run graph prediction.`
    );
  }

  const nativeBucket = inferSeriesBucket(rawSeries);
  const bucket: "day" | "month" | "year" =
    options.preferredBucket &&
    (options.preferredBucket === nativeBucket ||
      (nativeBucket === "day" &&
        (options.preferredBucket === "month" || options.preferredBucket === "year")) ||
      (nativeBucket === "month" && options.preferredBucket === "year"))
      ? options.preferredBucket
      : nativeBucket;
  const targetMap = aggregateSeriesByBucket(rawSeries, bucket);
  const fullTargetEntries = Array.from(targetMap.values()).sort(
    (a, b) => a.t - b.t || a.date.localeCompare(b.date)
  );
  const effectiveCutoff =
    typeof options.cutoffIndex === "number" &&
    Number.isFinite(options.cutoffIndex) &&
    options.cutoffIndex > 0
      ? Math.min(fullTargetEntries.length, Math.floor(options.cutoffIndex))
      : fullTargetEntries.length;
  const targetEntries = fullTargetEntries.slice(0, effectiveCutoff);
  if (targetEntries.length < 10) {
    throw new Error(
      `Target node "${targetNode.properties.name}" has only ${targetEntries.length} bucketed observations (need >= 10).`
    );
  }

  const horizonSteps = Math.max(1, Math.min(3, Math.round(options.horizonSteps ?? 1)));
  const maxHops = Math.max(1, Math.min(4, Math.round(options.maxHops ?? 2)));

  const { neighborMap, impulseEvents, scalesUsedSet } = collectCandidateNeighborsAndImpulses({
    store,
    targetNode,
    targetEntries,
    bucket,
    maxHops,
    candidateNeighborUuid: options.candidateNeighborUuid,
  });

  // Strict temporal origin indices `t` predicting `t + horizonSteps`
  const maxHistoryLag = 3;
  const originIndices: number[] = [];
  for (let t = maxHistoryLag; t < targetEntries.length - horizonSteps; t++) {
    originIndices.push(t);
  }
  if (originIndices.length < 8) {
    throw new Error(
      `Insufficient aligned prediction origins (${originIndices.length}) on "${targetNode.properties.name}".`
    );
  }

  const sampleCount = originIndices.length;
  const trainCount = Math.max(6, Math.min(sampleCount - 2, Math.floor(sampleCount * 0.72)));
  const testCount = sampleCount - trainCount;

  // Target standardization computed strictly on training target values
  const trainYs = originIndices.slice(0, trainCount).map((t) => targetEntries[t + horizonSteps].value);
  const yMean = trainYs.reduce((s, v) => s + v, 0) / trainCount;
  const yVar =
    trainYs.reduce((s, v) => s + (v - yMean) ** 2, 0) / Math.max(1, trainCount - 1);
  const yStd = Math.max(1e-6, Math.sqrt(yVar));

  const yNorm = (val: number) => (val - yMean) / yStd;
  const yUnnorm = (z: number) => z * yStd + yMean;

  const { rawImpulseSeries, impMean, impStd, hasCausalImpulseFeature, activeCovarStats } =
    extractCausalImpulseAndCovariates({
      targetEntries,
      originIndices,
      trainCount,
      impulseEvents,
      scalesUsedSet,
    });

  const includeSeasonal = bucket !== "year" && trainCount >= 18;
  const yTrainZ = originIndices.slice(0, trainCount).map((t) => yNorm(targetEntries[t + horizonSteps].value));

  const buildLocalFeatures = (t: number): number[] => {
    const y0 = yNorm(targetEntries[t].value);
    const y1 = yNorm(targetEntries[t - 1].value);
    const trendNorm = (t - originIndices[Math.floor(trainCount / 2)]) / Math.max(1, trainCount);
    const base = [1, y0, y0 - y1, trendNorm];
    if (includeSeasonal) {
      const ang = seasonalAngle(targetEntries[t + horizonSteps]?.date ?? targetEntries[t].date, bucket);
      if (ang !== null) {
        base.push(Math.sin(ang), Math.cos(ang));
      } else {
        base.push(0, 0);
      }
    }
    return base;
  };

  const localXAll = originIndices.map((t) => buildLocalFeatures(t));

  const { activeNeighbors, trustGatedCount, communityNodesEvaluated } = selectAndTrustGateNeighbors({
    store,
    neighborMap,
    targetEntries,
    originIndices,
    trainCount,
    horizonSteps,
    localXAll,
    yTrainZ,
    scalesUsedSet,
  });

  const buildGraphExtraFeatures = (t: number): number[] => {
    const extra: number[] = [];
    if (hasCausalImpulseFeature) {
      extra.push((rawImpulseSeries[t] - impMean) / impStd);
    }
    for (const cov of activeCovarStats) {
      const v = targetEntries[t].channels?.[cov.key];
      const z = typeof v === "number" && Number.isFinite(v) ? (v - cov.mean) / cov.std : 0;
      extra.push(Math.max(-4, Math.min(4, z)));
    }
    return extra;
  };

  const buildGraphFeatures = (t: number, localX: number[]): number[] => {
    const neighborFeats = activeNeighbors.map((nb) => {
      const raw = nb.cand.values[t - nb.offset];
      const z = raw !== null && Number.isFinite(raw) ? (raw - nb.mean) / nb.std : 0;
      const prevRaw = t - nb.offset - 1 >= 0 ? nb.cand.values[t - nb.offset - 1] : raw;
      const prevZ = prevRaw !== null && Number.isFinite(prevRaw) ? (prevRaw - nb.mean) / nb.std : z;
      return [z * nb.weightScale, (z - prevZ) * nb.weightScale];
    });
    return [...localX, ...neighborFeats.flat(), ...buildGraphExtraFeatures(t)];
  };

  const buildNonlinearGraphFeatures = (t: number, linearGraphX: number[]): number[] => {
    if (activeNeighbors.length === 0) return linearGraphX;
    const y0 = linearGraphX[1] ?? 0;
    const extraFeats = activeNeighbors.flatMap((nb, idx) => {
      const zScaled = linearGraphX[localXAll[0].length + idx * 2] ?? 0;
      const raw = nb.cand.values[t - nb.offset];
      const z = raw !== null && Number.isFinite(raw) ? (raw - nb.mean) / nb.std : 0;
      const interaction = Math.max(-4, Math.min(4, y0 * zScaled));
      const upperHinge = Math.max(0, z - 0.5) * nb.weightScale;
      const lowerHinge = Math.max(0, -0.5 - z) * nb.weightScale;
      return [interaction, upperHinge, lowerHinge];
    });
    return [...linearGraphX, ...extraFeats];
  };

  const linearXAll = originIndices.map((t, idx) => buildGraphFeatures(t, localXAll[idx]));
  const nonlinearXAll =
    activeNeighbors.length > 0 && trainCount >= 18
      ? originIndices.map((t, idx) => buildNonlinearGraphFeatures(t, linearXAll[idx]))
      : linearXAll;
  const yAllActual = originIndices.map((t) => targetEntries[t + horizonSteps].value);
  const yAllPersist = originIndices.map((t) => targetEntries[t].value);

  const lambdaSelf = Math.max(1.5, localXAll[0].length * 0.65);
  const selfWeights = fitRidgeRegression(localXAll.slice(0, trainCount), yTrainZ, lambdaSelf);

  const hasGraphFeatures =
    activeNeighbors.length > 0 || hasCausalImpulseFeature || activeCovarStats.length > 0;
  const linearFit = hasGraphFeatures
    ? tuneAndFitRidgeWithVal(linearXAll, yTrainZ, trainCount, Math.max(2.0, linearXAll[0].length * 0.85))
    : { weights: selfWeights, valRmse: Infinity, innerWeights: selfWeights };

  let activeGraphArchitecture: GraphPredictorModelKind = "linear_ridge";
  let nonlinFit = linearFit;

  if (activeNeighbors.length > 0 && trainCount >= 18) {
    nonlinFit = tuneAndFitRidgeWithVal(
      nonlinearXAll,
      yTrainZ,
      trainCount,
      Math.max(3.5, nonlinearXAll[0].length * 1.1)
    );
    const innerValSize = Math.max(4, Math.floor(trainCount * 0.25));
    const innerTrainEnd = trainCount - innerValSize;
    let ensValRmse = Infinity;
    if (innerTrainEnd >= 8) {
      let ensSq = 0;
      for (let i = innerTrainEnd; i < trainCount; i++) {
        const pLin = dot(linearFit.innerWeights, linearXAll[i]);
        const pNonlin = dot(nonlinFit.innerWeights, nonlinearXAll[i]);
        const err = 0.5 * (pLin + pNonlin) - yTrainZ[i];
        ensSq += err * err;
      }
      ensValRmse = Math.sqrt(ensSq / innerValSize);
    }

    if (ensValRmse < Math.min(linearFit.valRmse, nonlinFit.valRmse) * 0.99) {
      activeGraphArchitecture = "stacked_ensemble";
    } else if (nonlinFit.valRmse < linearFit.valRmse * 0.985) {
      activeGraphArchitecture = "nonlinear_interaction";
    }
  }

  const predictGraphRow = (linearRow: number[], nonlinearRow: number[]): number => {
    if (!hasGraphFeatures) {
      return yUnnorm(dot(selfWeights, linearRow.slice(0, localXAll[0].length)));
    }
    if (activeGraphArchitecture === "nonlinear_interaction") {
      return yUnnorm(dot(nonlinFit.weights, nonlinearRow));
    }
    if (activeGraphArchitecture === "stacked_ensemble") {
      return yUnnorm(
        0.5 * dot(linearFit.weights, linearRow) + 0.5 * dot(nonlinFit.weights, nonlinearRow)
      );
    }
    return yUnnorm(dot(linearFit.weights, linearRow));
  };

  const testActuals = yAllActual.slice(trainCount);
  const testPersist = yAllPersist.slice(trainCount);
  const testSelf = localXAll.slice(trainCount).map((x) => yUnnorm(dot(selfWeights, x)));
  const testLinearGraph = linearXAll
    .slice(trainCount)
    .map((x) => yUnnorm(dot(linearFit.weights, x)));
  let testGraph = linearXAll
    .slice(trainCount)
    .map((linRow, i) => predictGraphRow(linRow, nonlinearXAll[trainCount + i]));

  const persistTemp = computeEvalMetrics(testActuals, testPersist, 1);
  const persistRmse = Math.max(1e-9, persistTemp.rmse);
  const persistence = computeEvalMetrics(testActuals, testPersist, persistRmse);
  const selfOnly = computeEvalMetrics(testActuals, testSelf, persistRmse);
  const linearGraphMetrics = computeEvalMetrics(testActuals, testLinearGraph, persistRmse);
  let graphAware = computeEvalMetrics(testActuals, testGraph, persistRmse);

  // Next-step forecast from latest timestamp index `lastT = targetEntries.length - 1`
  const lastT = targetEntries.length - 1;
  const lastActual = targetEntries[lastT].value;
  const latestLocalX = [
    1,
    yNorm(targetEntries[lastT].value),
    yNorm(targetEntries[lastT].value) - yNorm(targetEntries[lastT - 1].value),
    (lastT - originIndices[Math.floor(trainCount / 2)]) / Math.max(1, trainCount),
    ...(includeSeasonal
      ? (() => {
          const nextLbl = advanceDateLabel(targetEntries[lastT].date, bucket, horizonSteps);
          const ang = seasonalAngle(nextLbl, bucket);
          return ang !== null ? [Math.sin(ang), Math.cos(ang)] : [0, 0];
        })()
      : []),
  ];
  const latestLinearX = buildGraphFeatures(lastT, latestLocalX);
  const latestNonlinearX =
    activeNeighbors.length > 0 && trainCount >= 18
      ? buildNonlinearGraphFeatures(lastT, latestLinearX)
      : latestLinearX;
  const selfPredNext = yUnnorm(dot(selfWeights, latestLocalX));
  let graphPredNext = hasGraphFeatures
    ? predictGraphRow(latestLinearX, latestNonlinearX)
    : selfPredNext;

  // Optional portable inductive GNN v2 weights check (only when inner chronological validation is available)
  let usedLocalInductiveGnn = false;
  const localWeightsV2 = loadLocalInductiveWeightsV2();
  const activeInnerZ = Math.min(linearFit.valRmse, nonlinFit.valRmse) * yStd;
  if (
    localWeightsV2 &&
    store.exportMlGraphDatasetV2 &&
    activeNeighbors.length > 0 &&
    trainCount >= 16 &&
    Number.isFinite(activeInnerZ)
  ) {
    try {
      const firstTestTargetDate = targetEntries[originIndices[trainCount] + horizonSteps]?.date;
      const mlV2 = store.exportMlGraphDatasetV2({
        rootUuid: targetNode.uuid,
        maxHops,
        bucket,
        horizonSteps,
        trainCutoffDate: firstTestTargetDate,
      });
      const nodeIdx = mlV2.node_ids.indexOf(targetNode.uuid);
      if (nodeIdx >= 0 && mlV2.time_index.length >= 10) {
        const idxByDate = new Map(mlV2.time_index.map((d, i) => [d, i]));
        const innerValSize = Math.max(4, Math.floor(trainCount * 0.25));
        const valStart = Math.max(0, trainCount - innerValSize);
        let innerSqGnn = 0;
        let innerSqBlend = 0;
        let innerCount = 0;
        for (let i = valStart; i < trainCount; i++) {
          const tKey = targetEntries[originIndices[i]].date;
          const mlT = idxByDate.get(tKey);
          if (mlT === undefined) continue;
          const gnnPred = evalPortableInductiveV2ForNode(localWeightsV2, mlV2, nodeIdx, mlT);
          if (gnnPred !== null && Number.isFinite(gnnPred)) {
            const innerRidgePred =
              activeGraphArchitecture === "nonlinear_interaction"
                ? yUnnorm(dot(nonlinFit.innerWeights, nonlinearXAll[i]))
                : activeGraphArchitecture === "stacked_ensemble"
                  ? yUnnorm(
                      0.5 * dot(linearFit.innerWeights, linearXAll[i]) +
                        0.5 * dot(nonlinFit.innerWeights, nonlinearXAll[i])
                    )
                  : yUnnorm(dot(linearFit.innerWeights, linearXAll[i]));
            const err = gnnPred - yAllActual[i];
            const blendErr = 0.5 * gnnPred + 0.5 * innerRidgePred - yAllActual[i];
            innerSqGnn += err * err;
            innerSqBlend += blendErr * blendErr;
            innerCount++;
          }
        }
        const gnnInnerRmse = innerCount >= 3 ? Math.sqrt(innerSqGnn / innerCount) : Infinity;
        const blendInnerRmse = innerCount >= 3 ? Math.sqrt(innerSqBlend / innerCount) : Infinity;
        if (gnnInnerRmse < activeInnerZ * 0.99 && blendInnerRmse < activeInnerZ * 0.99) {
          const gnnNext = evalPortableInductiveV2ForNode(
            localWeightsV2,
            mlV2,
            nodeIdx,
            mlV2.time_index.length - 1
          );
          if (gnnNext !== null && Number.isFinite(gnnNext)) {
            const gnnTest = originIndices.slice(trainCount).map((origT, idx) => {
              const mlT = idxByDate.get(targetEntries[origT].date);
              const gp =
                mlT !== undefined
                  ? evalPortableInductiveV2ForNode(localWeightsV2, mlV2, nodeIdx, mlT)
                  : null;
              return gp !== null && Number.isFinite(gp) ? 0.5 * gp + 0.5 * testGraph[idx] : testGraph[idx];
            });
            testGraph = gnnTest;
            graphAware = computeEvalMetrics(testActuals, testGraph, persistRmse);
            graphPredNext = 0.5 * gnnNext + 0.5 * graphPredNext;
            usedLocalInductiveGnn = true;
          }
        }
      }
    } catch {
      // Fall back silently to Ridge/Ensemble fit
    }
  }

  const nonlinearSkillGainPct =
    activeNeighbors.length > 0 && linearGraphMetrics.rmse > 1e-9
      ? Number(
          (((linearGraphMetrics.rmse - graphAware.rmse) / linearGraphMetrics.rmse) * 100).toFixed(2)
        )
      : 0;

  const skillLiftVsSelfPct =
    selfOnly.rmse > 1e-9
      ? Number((((selfOnly.rmse - graphAware.rmse) / selfOnly.rmse) * 100).toFixed(2))
      : 0;

  const { neighborContributions, communityImpact } = computeNeighborAndCommunityLift({
    store,
    activeNeighbors,
    activeGraphArchitecture,
    localFeatureLen: localXAll[0].length,
    linearXAll,
    nonlinearXAll,
    linearWeights: linearFit.weights,
    nonlinWeights: nonlinFit.weights,
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
  });

  // Honest out-of-sample model selection & overfit guardrail
  let recommendedModel: GraphPredictionResult["recommendedModel"] = "graph_aware";
  let recommendedForecastValue = graphPredNext;
  if (!hasGraphFeatures || graphAware.rmse > Math.min(selfOnly.rmse, persistence.rmse) + 1e-9) {
    if (selfOnly.rmse <= persistence.rmse + 1e-9) {
      recommendedModel = "self_ar";
      recommendedForecastValue = selfPredNext;
    } else {
      recommendedModel = "persistence";
      recommendedForecastValue = lastActual;
    }
  }

  const engineUsed: GraphPredictionEngineUsed = usedLocalInductiveGnn
    ? "local_inductive_gnn"
    : recommendedModel === "graph_aware"
      ? activeGraphArchitecture
      : recommendedModel;

  const warnings: string[] = [];
  if (testActuals.length < 8) {
    warnings.push(`Small holdout window (n=${testActuals.length} steps); interpret skill percentages cautiously.`);
  }
  if (activeNeighbors.length > 0 && recommendedModel !== "graph_aware") {
    const winnerLabel = recommendedModel === "self_ar" ? "Self-AR" : "Persistence";
    warnings.push(
      `Connected neighbors did not beat ${winnerLabel} out-of-sample (${skillLiftVsSelfPct >= 0 ? "+" : ""}${skillLiftVsSelfPct.toFixed(1)}% vs Self-AR). Prune negative-lift edges to reduce overfitting.`
    );
  }
  if (trustGatedCount > 0) {
    warnings.push(
      `Trust gate filtered ${trustGatedCount} noisy/uncorroborated community contributor(s) from the fit.`
    );
  }
  const reliabilityWarning = warnings.length > 0 ? warnings.join(" ") : undefined;

  const backtest = testActuals.slice(-36).map((act, i) => {
    const startOffset = Math.max(0, testActuals.length - 36);
    const idx = startOffset + i;
    const originIdx = trainCount + idx;
    const targetEntryIdx = originIndices[originIdx] + horizonSteps;
    return {
      date: targetEntries[targetEntryIdx]?.date ?? String(idx),
      actual: Number(act.toFixed(3)),
      persistence: Number(testPersist[idx].toFixed(3)),
      selfOnly: Number(testSelf[idx].toFixed(3)),
      graphAware: Number(testGraph[idx].toFixed(3)),
    };
  });

  const nextPeriodLabel = advanceDateLabel(targetEntries[lastT].date, bucket, horizonSteps);
  const unit = targetNode.properties.unit || "units";

  const winningPreds =
    recommendedModel === "graph_aware"
      ? testGraph
      : recommendedModel === "self_ar"
        ? testSelf
        : testPersist;
  const winningRmse =
    recommendedModel === "graph_aware"
      ? graphAware.rmse
      : recommendedModel === "self_ar"
        ? selfOnly.rmse
        : persistence.rmse;
  const signedResiduals = testActuals.map((act, idx) => act - (winningPreds[idx] ?? act));
  const absResiduals = signedResiduals.map((r) => Math.abs(r)).sort((a, b) => a - b);
  const q95Idx = Math.min(
    Math.max(0, absResiduals.length - 1),
    Math.max(0, Math.ceil(0.95 * absResiduals.length) - 1)
  );
  const empiricalQ95 = absResiduals.length >= 6 ? absResiduals[q95Idx] : 0;
  const ci95HalfWidth = Number(
    Math.max(1.96 * winningRmse, empiricalQ95).toFixed(3)
  );

  const recentTail = targetEntries.slice(Math.max(0, lastT - 3), lastT + 1);
  const rollingMean4 =
    recentTail.reduce((s, p) => s + p.value, 0) / Math.max(1, recentTail.length);
  const { quantiles, trendForecast } = buildQuantilesAndTrendForecast({
    recommendedForecastValue,
    lastActual,
    horizonSteps,
    winningRmse,
    yStd,
    rollingMean4,
    signedResiduals,
  });

  const archLabel = usedLocalInductiveGnn
    ? "Local Inductive GNN + Ensemble"
    : activeGraphArchitecture === "stacked_ensemble"
      ? "Stacked Interaction+Linear Ensemble"
      : activeGraphArchitecture === "nonlinear_interaction"
        ? "Nonlinear Interaction+Hinge Ridge"
        : "Graph-Aware Ridge";

  const summary =
    activeNeighbors.length === 0 && !hasCausalImpulseFeature
      ? `No overlapping upstream/connected time-series neighbors were available for "${targetNode.properties.name}". Running Self-Only AR baseline (${selfOnly.rmse.toFixed(3)} ${unit} RMSE). Connect overlapping drivers to unlock graph lift.`
      : skillLiftVsSelfPct > 0
        ? `${archLabel} reading ${activeNeighbors.length} ETG neighbor(s) reduced unseen ${testCount}-step RMSE by ${skillLiftVsSelfPct.toFixed(1)}% (${selfOnly.rmse.toFixed(3)} → ${graphAware.rmse.toFixed(3)} ${unit}) and achieved ${graphAware.skillVsPersistencePct.toFixed(1)}% skill over persistence.`
        : `Evaluated ${activeNeighbors.length} connected ETG neighbor(s) with ${archLabel} on ${testCount} unseen ${bucket} steps (Graph RMSE ${graphAware.rmse.toFixed(3)} vs Self RMSE ${selfOnly.rmse.toFixed(3)} ${unit}). Connect stronger lead-lag drivers or discover candidate links to raise skill.`;

  return {
    targetUuid: targetNode.uuid,
    targetName: targetNode.properties.name,
    unit,
    bucket,
    sampleCount,
    trainCount,
    testCount,
    horizonSteps,
    persistence,
    selfOnly,
    graphAware,
    skillLiftVsSelfPct,
    recommendedModel,
    activeGraphArchitecture:
      activeNeighbors.length > 0 ? activeGraphArchitecture : undefined,
    engineUsed,
    nonlinearSkillGainPct:
      activeNeighbors.length > 0 ? nonlinearSkillGainPct : undefined,
    recommendedForecastValue: Number(recommendedForecastValue.toFixed(3)),
    quantiles,
    scalesUsed: Array.from(scalesUsedSet),
    trendForecast,
    ...(communityImpact ? { communityImpact } : {}),
    reliabilityWarning,
    nextForecast: {
      nextPeriodLabel,
      lastActual: Number(lastActual.toFixed(3)),
      persistencePred: Number(lastActual.toFixed(3)),
      selfOnlyPred: Number(selfPredNext.toFixed(3)),
      graphAwarePred: Number(graphPredNext.toFixed(3)),
      ci95HalfWidth,
    },
    backtest,
    neighborContributions,
    summary,
  };
}
