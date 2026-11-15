"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  History,
  Link2,
  Loader2,
  Sun,
  TrendingUp,
} from "lucide-react";
import type {
  ETGNode,
  GraphPredictionResult,
  ProspectiveForecastRecord,
  ProspectiveLedgerSummary,
} from "@/types/etg";
import { BacktestChart, triggerJsonDownload } from "./workbenchShared";

export interface WorkbenchPredictTabProps {
  baseId: string;
  active: boolean;
  isLightTheme: boolean;
  selectedNode: ETGNode;
  nodeById: Map<string, ETGNode>;
  unlinkedSeriesPeers: ETGNode[];
  maxHops: number;
  localError: string | null;
  localStatus: string | null;
  onSetLocalError: (msg: string | null) => void;
  onSetLocalStatus: (msg: string | null) => void;
  onSelectNode: (node: ETGNode) => void;
  onStartQuickConnect: (sourceNode: ETGNode, targetNode?: ETGNode) => void;
  onMaterializeSolarGraph: () => Promise<void>;
}

export function WorkbenchPredictTab({
  baseId,
  active,
  isLightTheme,
  selectedNode,
  nodeById,
  unlinkedSeriesPeers,
  maxHops,
  localError,
  localStatus,
  onSetLocalError,
  onSetLocalStatus,
  onSelectNode,
  onStartQuickConnect,
  onMaterializeSolarGraph,
}: WorkbenchPredictTabProps) {
  const [prediction, setPrediction] = useState<GraphPredictionResult | null>(null);
  const [predictLoading, setPredictLoading] = useState(false);
  const [predictError, setPredictError] = useState<string | null>(null);
  const [candidatePreviewUuid, setCandidatePreviewUuid] = useState("");
  const [horizonSteps, setHorizonSteps] = useState<1 | 2 | 3>(1);
  const [exportingMl, setExportingMl] = useState(false);
  const [ledgerRecords, setLedgerRecords] = useState<ProspectiveForecastRecord[]>([]);
  const [ledgerSummary, setLedgerSummary] = useState<ProspectiveLedgerSummary | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);

  const lastNodeUuidRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastNodeUuidRef.current === selectedNode.uuid) return;
    lastNodeUuidRef.current = selectedNode.uuid;
    setCandidatePreviewUuid("");
    setHorizonSteps(1);
    setPrediction(null);
    setPredictError(null);
  }, [selectedNode.uuid]);

  const loadLedger = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/graph/predict?format=ledger&targetUuid=${encodeURIComponent(selectedNode.uuid)}`,
          { cache: "no-store", signal }
        );
        if (signal?.aborted) return;
        if (res.ok) {
          const data = (await res.json()) as {
            records?: ProspectiveForecastRecord[];
            summary?: ProspectiveLedgerSummary;
          };
          if (signal?.aborted) return;
          setLedgerRecords(Array.isArray(data.records) ? data.records : []);
          setLedgerSummary(data.summary ?? null);
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        // Non-fatal ledger fetch
      }
    },
    [selectedNode.uuid]
  );

  const loadPrediction = useCallback(
    async (signal?: AbortSignal) => {
      setPredictLoading(true);
      setPredictError(null);
      try {
        const params = new URLSearchParams({
          targetUuid: selectedNode.uuid,
          maxHops: String(Math.max(1, maxHops)),
          horizonSteps: String(horizonSteps),
        });
        if (candidatePreviewUuid) {
          params.set("candidateNeighborUuid", candidatePreviewUuid);
        }
        const res = await fetch(`/api/graph/predict?${params.toString()}`, {
          cache: "no-store",
          signal,
        });
        if (signal?.aborted) return;
        const data = await res.json();
        if (signal?.aborted) return;
        if (!res.ok) {
          setPrediction(null);
          setPredictError(data.error || "Unable to fit graph predictor on this node.");
        } else {
          setPrediction(data as GraphPredictionResult);
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        setPredictError(err instanceof Error ? err.message : "Prediction request failed");
      } finally {
        if (!signal?.aborted) {
          setPredictLoading(false);
        }
      }
      if (!signal?.aborted) {
        await loadLedger(signal);
      }
    },
    [selectedNode.uuid, maxHops, horizonSteps, candidatePreviewUuid, loadLedger]
  );

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void loadPrediction(controller.signal);
    return () => {
      controller.abort();
    };
  }, [active, loadPrediction]);

  const handleLogProspectiveForecast = async () => {
    setLedgerBusy(true);
    onSetLocalError(null);
    try {
      const res = await fetch("/api/graph/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "log_forecast",
          targetUuid: selectedNode.uuid,
          maxHops: Math.max(1, maxHops),
          horizonSteps,
          candidateNeighborUuid: candidatePreviewUuid || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to log forecast");
      if (json.ledger) {
        setLedgerRecords(Array.isArray(json.ledger.records) ? json.ledger.records : []);
        setLedgerSummary(json.ledger.summary ?? null);
      }
      onSetLocalStatus(
        `Logged prospective forecast for ${json.loggedForecast?.target_period ?? "next step"}.`
      );
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "Failed to log forecast");
    } finally {
      setLedgerBusy(false);
    }
  };

  const handleReconcileForecasts = async () => {
    setLedgerBusy(true);
    onSetLocalError(null);
    try {
      const res = await fetch("/api/graph/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reconcile_forecasts",
          targetUuid: selectedNode.uuid,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to score actuals");
      if (json.ledger) {
        setLedgerRecords(Array.isArray(json.ledger.records) ? json.ledger.records : []);
        setLedgerSummary(json.ledger.summary ?? null);
      }
      onSetLocalStatus(
        json.scoredNow > 0
          ? `Scored ${json.scoredNow} pending forecast(s) against new observations.`
          : "All pending forecasts are still awaiting future observations."
      );
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "Failed to reconcile forecasts");
    } finally {
      setLedgerBusy(false);
    }
  };

  const handleExportMlBundle = async (variant: "v1" | "v2") => {
    setExportingMl(true);
    onSetLocalError(null);
    const isV2 = variant === "v2";
    try {
      const url = isV2
        ? `/api/graph/predict?format=ml_export_v2&rootUuid=${encodeURIComponent(selectedNode.uuid)}&maxHops=${Math.max(2, maxHops)}&horizonSteps=${horizonSteps}`
        : `/api/graph/predict?format=ml_export&rootUuid=${encodeURIComponent(selectedNode.uuid)}&maxHops=${Math.max(2, maxHops)}`;
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || (isV2 ? "v2 ML export failed" : "ML export failed"));
      triggerJsonDownload(
        json,
        isV2
          ? `etg-ml-v2-${selectedNode.uuid.slice(0, 8)}.json`
          : `etg-ml-graph-${selectedNode.uuid.slice(0, 8)}.json`
      );
      onSetLocalStatus(
        isV2
          ? "Downloaded etg-ml-v2 multi-scale bundle for Colab Blackwell / L4."
          : "Downloaded PyG / Python ML tensor JSON."
      );
    } catch (err) {
      onSetLocalError(
        err instanceof Error ? err.message : isV2 ? "v2 export failed" : "Export failed"
      );
    } finally {
      setExportingMl(false);
    }
  };

  return (
    <div className="space-y-3.5 p-3.5">
      {/* What-If Neighbor Preview */}
      <div className="space-y-1">
        <label htmlFor={`${baseId}-whatif`} className="ws-eyebrow block">
          What-If Candidate Neighbor Preview
        </label>
        <select
          id={`${baseId}-whatif`}
          value={candidatePreviewUuid}
          onChange={(e) => setCandidatePreviewUuid(e.target.value)}
          className="form-input"
        >
          <option value="">Existing graph neighborhood only</option>
          {unlinkedSeriesPeers.map((peer) => (
            <option key={peer.uuid} value={peer.uuid}>
              + Preview adding: {peer.properties.name}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="ws-eyebrow">Forecast Horizon</legend>
        <div className="grid grid-cols-3 gap-1.5">
          {([1, 2, 3] as const).map((step) => {
            const radioId = `${baseId}-horizon-${step}`;
            const isSelected = horizonSteps === step;
            return (
              <div key={step} className="relative">
                <input
                  id={radioId}
                  type="radio"
                  name={`${baseId}-horizon`}
                  value={step}
                  checked={isSelected}
                  onChange={() => setHorizonSteps(step)}
                  className="visually-hidden"
                />
                <label
                  htmlFor={radioId}
                  className={`flex cursor-pointer items-center justify-center rounded-sm border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    isSelected
                      ? "border-sky-400 bg-sky-950 text-sky-300"
                      : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                  }`}
                >
                  +{step} step{step > 1 ? "s" : ""}
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      {predictLoading && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md border border-border bg-surface-inset p-3 text-text-muted"
        >
          <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
          <span>Fitting leak-free Ridge model over {maxHops}-hop neighborhood…</span>
        </div>
      )}

      {predictError && !predictLoading && (
        <div
          role="alert"
          className="space-y-2.5 rounded-md border border-amber-400 bg-amber-950 p-3 text-[11px] text-amber-300"
        >
          <p>{predictError}</p>
          <p className="text-text-muted">
            Need a multi-node continuous daily graph to benchmark? Load the 7-node Denver Front
            Range irradiance graph directly into ETG.
          </p>
          <button
            type="button"
            onClick={() => void onMaterializeSolarGraph()}
            className="inline-flex items-center gap-1.5 rounded-sm border border-amber-400 bg-surface-elevated px-2.5 py-1.5 font-semibold text-amber-300 hover:border-amber-300 cursor-pointer"
          >
            <Sun className="h-3.5 w-3.5" />
            Load 7-Node Solar Predictive Graph
          </button>
        </div>
      )}

      {prediction && !predictLoading && (
        <>
          {/* Next Forecast Highlight */}
          <div className="rounded-md border border-sky-400 bg-sky-950 p-3 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="ws-eyebrow text-sky-300">
                Next {prediction.bucket} forecast ({prediction.nextForecast.nextPeriodLabel})
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {(prediction.engineUsed === "l4_inductive_gnn" ||
                  prediction.engineUsed === "local_inductive_gnn") && (
                  <span className="rounded-sm border border-cyan-400 bg-cyan-950 px-2 py-0.5 text-[9px] font-semibold text-cyan-300">
                    {prediction.engineUsed === "l4_inductive_gnn"
                      ? "L4 Neural GNN"
                      : "Inductive Weights v2"}
                  </span>
                )}
                {prediction.activeGraphArchitecture && (
                  <span className="rounded-sm border border-purple-400 bg-purple-950 px-2 py-0.5 text-[9px] font-semibold text-purple-300">
                    {prediction.activeGraphArchitecture === "stacked_ensemble"
                      ? "Stacked Ensemble"
                      : prediction.activeGraphArchitecture === "nonlinear_interaction"
                        ? "Nonlinear Interaction"
                        : "Linear Graph Ridge"}
                  </span>
                )}
                <span
                  className={`rounded-sm border px-2 py-0.5 font-mono ws-numeric text-[10px] font-semibold ${
                    prediction.skillLiftVsSelfPct > 0
                      ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                      : "border-border bg-surface text-text-muted"
                  }`}
                >
                  Graph Lift {prediction.skillLiftVsSelfPct >= 0 ? "+" : ""}
                  {prediction.skillLiftVsSelfPct.toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono ws-numeric text-xl font-bold text-text-primary">
                {prediction.nextForecast.graphAwarePred.toFixed(2)} {prediction.unit}
              </span>
              <span className="font-mono ws-numeric text-[11px] text-text-muted">
                ± {prediction.nextForecast.ci95HalfWidth.toFixed(2)} (95% CI)
              </span>
            </div>
            {prediction.quantiles && (
              <div className="font-mono ws-numeric text-[10px] text-sky-300">
                Quantiles: P10 {prediction.quantiles.p10.toFixed(2)} · P50{" "}
                {prediction.quantiles.p50.toFixed(2)} · P90 {prediction.quantiles.p90.toFixed(2)}{" "}
                {prediction.unit}
              </div>
            )}
            <div className="font-mono ws-numeric text-[10px] text-text-muted">
              Self AR: {prediction.nextForecast.selfOnlyPred.toFixed(2)} · Persistence:{" "}
              {prediction.nextForecast.persistencePred.toFixed(2)}
              {typeof prediction.nonlinearSkillGainPct === "number" &&
              Math.abs(prediction.nonlinearSkillGainPct) >= 0.1
                ? ` · NL Gain: ${prediction.nonlinearSkillGainPct >= 0 ? "+" : ""}${prediction.nonlinearSkillGainPct.toFixed(1)}%`
                : ""}
            </div>
            {(prediction.trendForecast || (prediction.scalesUsed && prediction.scalesUsed.length > 0)) && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {prediction.trendForecast && (
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                      prediction.trendForecast.direction === "increasing"
                        ? "border-amber-400 bg-amber-950 text-amber-300"
                        : prediction.trendForecast.direction === "decreasing"
                          ? "border-sky-400 bg-sky-950 text-sky-300"
                          : "border-border bg-surface text-text-muted"
                    }`}
                  >
                    Trend: {prediction.trendForecast.direction} · Regime shift{" "}
                    {(prediction.trendForecast.regimeShiftProb * 100).toFixed(0)}%
                  </span>
                )}
                {prediction.scalesUsed?.map((sc) => (
                  <span
                    key={sc}
                    className="rounded-sm border border-border-strong bg-surface-inset px-1.5 py-0.5 font-mono text-[9px] text-text-muted"
                  >
                    scale:{sc}
                  </span>
                ))}
              </div>
            )}
          </div>

          {prediction.communityImpact &&
            (prediction.communityImpact.communityNodesActive > 0 ||
              prediction.communityImpact.trustGatedCount > 0) && (
              <div className="rounded-md border border-emerald-400 bg-emerald-950 px-2.5 py-2 text-[11px] flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-text-primary ws-numeric">
                  Community Graph: <strong>{prediction.communityImpact.communityNodesActive}</strong>{" "}
                  active · <strong>{prediction.communityImpact.trustGatedCount}</strong> trust-gated
                </span>
                <span
                  className={`font-mono ws-numeric text-[10px] font-semibold ${
                    prediction.communityImpact.marginalCommunityLiftPct > 0
                      ? "text-emerald-300"
                      : "text-text-muted"
                  }`}
                >
                  Community Lift{" "}
                  {prediction.communityImpact.marginalCommunityLiftPct >= 0 ? "+" : ""}
                  {prediction.communityImpact.marginalCommunityLiftPct.toFixed(1)}%
                </span>
              </div>
            )}

          {/* Model Recommendation & Guardrail Banner */}
          <div
            role="status"
            aria-live="polite"
            className={`rounded-md border p-2.5 text-[11px] space-y-1 ${
              prediction.reliabilityWarning
                ? "border-amber-400 bg-amber-950 text-amber-300"
                : "border-emerald-400 bg-emerald-950 text-emerald-300"
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-semibold">
              <span className="inline-flex items-center gap-1.5">
                {prediction.reliabilityWarning ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                ) : (
                  <TrendingUp className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" />
                )}
                <span>
                  Recommended:{" "}
                  {prediction.recommendedModel === "graph_aware"
                    ? "Graph Model"
                    : prediction.recommendedModel === "self_ar"
                      ? "Self-Only AR"
                      : "Persistence"}
                </span>
              </span>
              <span className="font-mono ws-numeric">
                {prediction.recommendedForecastValue.toFixed(2)} {prediction.unit}
              </span>
            </div>
            {prediction.reliabilityWarning && (
              <p className="leading-relaxed text-amber-300">{prediction.reliabilityWarning}</p>
            )}
          </div>

          {/* 3-Way Holdout Benchmark */}
          <div className="grid grid-cols-3 gap-1.5 text-center">
            <div className="ws-inset p-2">
              <div className="text-[10px] text-text-muted">Persistence</div>
              <div className="font-mono ws-numeric text-xs font-semibold text-text-primary">
                RMSE {prediction.persistence.rmse.toFixed(3)}
              </div>
              <div className="font-mono ws-numeric text-[10px] text-text-subtle">
                R² {prediction.persistence.r2.toFixed(2)}
              </div>
            </div>
            <div className="ws-inset p-2">
              <div className="text-[10px] text-text-muted">Self-Only AR</div>
              <div className="font-mono ws-numeric text-xs font-semibold text-text-primary">
                RMSE {prediction.selfOnly.rmse.toFixed(3)}
              </div>
              <div className="font-mono ws-numeric text-[10px] text-text-subtle">
                R² {prediction.selfOnly.r2.toFixed(2)}
              </div>
            </div>
            <div className="rounded-md border border-sky-400 bg-sky-950 p-2">
              <div className="text-[10px] font-semibold text-sky-300">Graph Model</div>
              <div className="font-mono ws-numeric text-xs font-bold text-text-primary">
                RMSE {prediction.graphAware.rmse.toFixed(3)}
              </div>
              <div className="font-mono ws-numeric text-[10px] text-emerald-300">
                R² {prediction.graphAware.r2.toFixed(2)}
              </div>
            </div>
          </div>

          <BacktestChart backtest={prediction.backtest} isLightTheme={isLightTheme} />

          {/* Neighbor Contributions */}
          <div className="space-y-1.5">
            <div className="ws-eyebrow">
              Graph Feature Attribution ({prediction.neighborContributions.length} signals)
            </div>
            {prediction.neighborContributions.length === 0 ? (
              <div className="rounded-sm border border-dashed border-border p-2 text-[11px] text-text-muted">
                No overlapping neighbor time series linked yet. Wire another series node above!
              </div>
            ) : (
              <div className="space-y-1.5">
                {prediction.neighborContributions.slice(0, 6).map((c) => {
                  const target = nodeById.get(c.nodeUuid);
                  return (
                    <div key={`${c.nodeUuid}-${c.lagSteps}`} className="ws-inset p-2 space-y-1">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <button
                          type="button"
                          disabled={!target}
                          onClick={() => target && onSelectNode(target)}
                          className="truncate font-medium text-text-primary hover:text-accent-fg cursor-pointer text-left"
                        >
                          {c.nodeName}
                          {c.isCandidatePreview ? " (Preview)" : ""}
                        </button>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {c.ablationLiftPct !== undefined && (
                            <span
                              className={`rounded-sm border px-1.5 py-0.5 font-mono ws-numeric text-[9px] font-semibold ${
                                c.ablationLiftPct > 0
                                  ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                                  : c.ablationLiftPct < 0
                                    ? "border-amber-400 bg-amber-950 text-amber-300"
                                    : "border-border bg-surface text-text-muted"
                              }`}
                            >
                              {c.ablationLiftPct >= 0 ? "+" : ""}
                              {c.ablationLiftPct.toFixed(1)}%{" "}
                              {c.ablationLiftPct >= 0 ? "lift" : "overfit"}
                            </span>
                          )}
                          <span className="font-mono ws-numeric text-[10px] text-sky-300">
                            {c.sharePct.toFixed(1)}% · lag {c.lagSteps}
                          </span>
                        </div>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-xs bg-surface">
                        <div
                          className={`h-full rounded-xs ${
                            c.isCandidatePreview ? "bg-purple-400" : "bg-sky-400"
                          }`}
                          style={{ width: `${Math.min(100, Math.max(4, c.sharePct))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {candidatePreviewUuid && (
            <button
              type="button"
              onClick={() => {
                const peer = nodeById.get(candidatePreviewUuid);
                if (peer) onStartQuickConnect(peer, selectedNode);
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm border border-violet-400 bg-violet-950 px-3 py-2 text-xs font-semibold text-violet-200 hover:border-violet-300 cursor-pointer"
            >
              <Link2 className="h-3.5 w-3.5" />
              Wire Previewed Neighbor into Graph
            </button>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              disabled={ledgerBusy}
              onClick={() => void handleLogProspectiveForecast()}
              className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-2.5 py-2 text-[11px] font-semibold text-sky-200 hover:border-sky-300 disabled:opacity-50 cursor-pointer"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Log Live Forecast</span>
            </button>
            <button
              type="button"
              disabled={ledgerBusy}
              onClick={() => void handleReconcileForecasts()}
              className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-2.5 py-2 text-[11px] font-medium text-text-primary hover:border-accent-fg disabled:opacity-50 cursor-pointer"
            >
              <History className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Score Actuals</span>
            </button>
          </div>

          {(localStatus || localError) && (
            <div
              role={localError ? "alert" : "status"}
              aria-live={localError ? undefined : "polite"}
              className={`rounded-sm border px-2.5 py-1.5 text-[10.5px] ${
                localError
                  ? "border-rose-400 bg-rose-950 text-rose-300"
                  : "border-emerald-400 bg-emerald-950 text-emerald-300"
              }`}
            >
              {localError ?? localStatus}
            </div>
          )}

          {/* Prospective Verification Ledger */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id={`${baseId}-ledger-heading`} className="ws-eyebrow">
                Prospective Verification Ledger ({ledgerSummary?.total_logged ?? ledgerRecords.length})
              </h4>
              {ledgerSummary && (
                <span className="ws-numeric font-mono text-[10px] text-text-muted">
                  {ledgerSummary.pending_count} pending · {ledgerSummary.scored_count} scored
                </span>
              )}
            </div>

            {ledgerSummary && ledgerSummary.scored_count > 0 && (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                  <div className="text-[9px] text-text-subtle">Graph MAE</div>
                  <div className="ws-numeric font-mono text-[11px] font-semibold text-sky-400">
                    {ledgerSummary.mean_abs_error?.toFixed(3) ?? "—"}
                  </div>
                </div>
                <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                  <div className="text-[9px] text-text-subtle">Self-AR MAE</div>
                  <div className="ws-numeric font-mono text-[11px] font-semibold text-text-muted">
                    {ledgerSummary.self_mean_abs_error?.toFixed(3) ?? "—"}
                  </div>
                </div>
                <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                  <div className="text-[9px] text-text-subtle">Skill vs Self</div>
                  <div
                    className={`ws-numeric font-mono text-[11px] font-semibold ${
                      (ledgerSummary.skill_vs_self_pct ?? 0) >= 0
                        ? "text-emerald-400"
                        : "text-amber-400"
                    }`}
                  >
                    {ledgerSummary.skill_vs_self_pct !== null
                      ? `${ledgerSummary.skill_vs_self_pct >= 0 ? "+" : ""}${ledgerSummary.skill_vs_self_pct.toFixed(1)}%`
                      : "—"}
                  </div>
                </div>
                <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
                  <div className="text-[9px] text-text-subtle">95% CI Cov</div>
                  <div className="ws-numeric font-mono text-[11px] font-semibold text-emerald-400">
                    {ledgerSummary.ci95_coverage_pct !== null
                      ? `${ledgerSummary.ci95_coverage_pct.toFixed(0)}%`
                      : "—"}
                  </div>
                </div>
              </div>
            )}

            {ledgerRecords.length === 0 ? (
              <div className="rounded-sm border border-dashed border-border p-2 text-[11px] text-text-muted">
                Log a forecast now; when new readings arrive for that period, the store automatically scores MAE, Self-AR baseline lift, and 95% CI coverage.
              </div>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby={`${baseId}-ledger-heading`}
                className="etg-table-wrapper"
              >
                <table
                  className="etg-table"
                  style={
                    {
                      "--label-1": '"Target"',
                      "--label-2": '"Forecast"',
                      "--label-3": '"Actual"',
                      "--label-4": '"Outcome"',
                    } as React.CSSProperties
                  }
                >
                  <thead>
                    <tr>
                      <th scope="col">Target</th>
                      <th scope="col">Forecast</th>
                      <th scope="col">Actual</th>
                      <th scope="col">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRecords.slice(0, 8).map((rec) => (
                      <tr key={rec.id}>
                        <th scope="row" className="font-mono ws-numeric text-text-primary">
                          {rec.target_period}
                        </th>
                        <td className="font-mono ws-numeric text-text-primary">
                          <div>
                            {rec.predicted_value.toFixed(2)} ± {rec.ci95_half_width.toFixed(2)}
                          </div>
                          <div className="text-[9px] text-text-subtle">
                            Self AR {rec.self_only_pred.toFixed(2)}
                          </div>
                        </td>
                        <td className="font-mono ws-numeric text-text-muted">
                          {rec.status === "scored" && typeof rec.actual_value === "number"
                            ? `${rec.actual_value.toFixed(2)} ${rec.unit}`
                            : "Awaiting"}
                        </td>
                        <td>
                          {rec.status === "scored" ? (
                            <div className="space-y-0.5">
                              <span
                                className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono ws-numeric text-[9px] font-semibold ${
                                  rec.covered_by_ci95
                                    ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                                    : "border-amber-400 bg-amber-950 text-amber-300"
                                }`}
                              >
                                {rec.covered_by_ci95 ? "✓ " : "Miss "}
                                MAE {rec.abs_error?.toFixed(2)}
                              </span>
                              {typeof rec.self_abs_error === "number" && (
                                <div className="font-mono ws-numeric text-[9px] text-text-subtle">
                                  Self {rec.self_abs_error.toFixed(2)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="inline-flex items-center rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[9px] font-semibold text-text-muted">
                              Pending
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-1.5">
            <button
              type="button"
              disabled={exportingMl}
              onClick={() => void handleExportMlBundle("v2")}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-3 py-2 text-xs font-medium text-sky-300 hover:border-sky-300 cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {exportingMl ? "Exporting ML Tensor…" : "Export etg-ml-v2 Multi-Scale Bundle (Colab / Blackwell)"}
            </button>
            <button
              type="button"
              disabled={exportingMl}
              onClick={() => void handleExportMlBundle("v1")}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {exportingMl ? "Exporting ML Tensor…" : "Export PyG / Python ML Dataset (.json)"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
