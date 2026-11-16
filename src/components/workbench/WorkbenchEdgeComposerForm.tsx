"use client";

import React, { useEffect, useState } from "react";
import { ArrowLeftRight, ArrowRight, Check, GitBranchPlus, Unlink, X } from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import type { ETGEdge, ETGNode, ETGRelationshipType } from "@/types/etg";
import { RELATIONSHIP_OPTIONS } from "./workbenchShared";

export interface WorkbenchEdgeComposerFormProps {
  baseId: string;
  allNodes: ETGNode[];
  nodeById: Map<string, ETGNode>;
  selectedEdge: ETGEdge | null;
  pendingConnectPair: { sourceUuid: string; targetUuid: string } | null;
  busy: boolean;
  onSetBusy: (busy: boolean) => void;
  onClearPendingConnect: () => void;
  onSelectNode?: (node: ETGNode) => void;
  onSelectEdge: (edge: ETGEdge) => void;
  onDeleteEdge: (edgeUuid: string) => Promise<void>;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
  onClose: () => void;
}

export function WorkbenchEdgeComposerForm({
  baseId,
  allNodes,
  nodeById,
  selectedEdge,
  pendingConnectPair,
  busy,
  onSetBusy,
  onClearPendingConnect,
  onSelectNode,
  onSelectEdge,
  onDeleteEdge,
  onSnapshotChange,
  onClose,
}: WorkbenchEdgeComposerFormProps) {
  const [localError, setLocalError] = useState<string | null>(null);
  const [edgeSourceUuid, setEdgeSourceUuid] = useState("");
  const [edgeTargetUuid, setEdgeTargetUuid] = useState("");
  const [edgeType, setEdgeType] = useState<ETGRelationshipType>("leads");
  const [edgeCustomLabel, setEdgeCustomLabel] = useState("");
  const [edgeLagSteps, setEdgeLagSteps] = useState("1");
  const [edgeLagUnit, setEdgeLagUnit] = useState<"days" | "months" | "years">("days");
  const [edgeWeight, setEdgeWeight] = useState(0.75);
  const [edgeMechanism, setEdgeMechanism] = useState("");
  const [edgeRationale, setEdgeRationale] = useState("");

  useEffect(() => {
    if (selectedEdge) {
      setEdgeSourceUuid(selectedEdge.source_uuid);
      setEdgeTargetUuid(selectedEdge.target_uuid);
      setEdgeType(selectedEdge.type);
      setEdgeCustomLabel(selectedEdge.properties.custom_label ?? "");
      setEdgeLagSteps(String(selectedEdge.properties.optimal_lag_steps ?? 0));
      setEdgeLagUnit(selectedEdge.properties.lag_unit ?? "days");
      setEdgeWeight(selectedEdge.properties.weight ?? 0.75);
      setEdgeMechanism(selectedEdge.properties.mechanism ?? "");
      setEdgeRationale(selectedEdge.properties.rationale ?? "");
      setLocalError(null);
    } else if (pendingConnectPair) {
      setEdgeSourceUuid(pendingConnectPair.sourceUuid);
      setEdgeTargetUuid(pendingConnectPair.targetUuid);
      setEdgeType("leads");
      setEdgeCustomLabel("");
      setEdgeLagSteps("1");
      setEdgeLagUnit("days");
      setEdgeWeight(0.75);
      setEdgeMechanism("");
      setEdgeRationale("");
      setLocalError(null);
    }
  }, [selectedEdge, pendingConnectPair]);

  const handleSaveEdge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edgeSourceUuid || !edgeTargetUuid || edgeSourceUuid === edgeTargetUuid) {
      setLocalError("Choose two distinct Source and Target nodes.");
      return;
    }
    onSetBusy(true);
    setLocalError(null);
    try {
      if (selectedEdge) {
        const res = await fetch("/api/graph", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            edgeUuid: selectedEdge.properties.uuid,
            patch: {
              source_uuid: edgeSourceUuid,
              target_uuid: edgeTargetUuid,
              type: edgeType,
              custom_label: edgeCustomLabel.trim() || undefined,
              optimal_lag_steps: Number(edgeLagSteps) || 0,
              lag_unit: edgeLagUnit,
              weight: edgeWeight,
              mechanism: edgeMechanism.trim() || undefined,
              rationale: edgeRationale.trim() || undefined,
            },
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to update connection");
        onSnapshotChange(data.snapshot, "Updated causal connection.");
        if (data.edge) onSelectEdge(data.edge as ETGEdge);
      } else {
        const res = await fetch("/api/graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            source_uuid: edgeSourceUuid,
            target_uuid: edgeTargetUuid,
            type: edgeType,
            custom_label: edgeCustomLabel.trim() || undefined,
            optimal_lag_steps: Number(edgeLagSteps) || 0,
            lag_unit: edgeLagUnit,
            weight: edgeWeight,
            mechanism: edgeMechanism.trim() || undefined,
            rationale: edgeRationale.trim() || undefined,
            authored_by: "human",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to create connection");
        onSnapshotChange(data.snapshot, "Connected phenomena in Knowledge Graph.");
        onClearPendingConnect();
        if (data.edge) onSelectEdge(data.edge as ETGEdge);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to save edge");
    } finally {
      onSetBusy(false);
    }
  };

  const srcNode = nodeById.get(edgeSourceUuid);
  const tgtNode = nodeById.get(edgeTargetUuid);

  return (
    <div className="etg-hud-pill flex max-h-[calc(100dvh-5.75rem)] flex-col overflow-hidden rounded-md bg-surface shadow-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranchPlus className="h-4 w-4 text-amber-400" />
          <h2 className="text-[14px] font-semibold text-text-primary">
            {selectedEdge ? "Edit Graph Connection" : "Connect Phenomena"}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => {
            onClearPendingConnect();
            if (selectedEdge && !pendingConnectPair) onClose();
          }}
          aria-label="Close connection composer"
          className="etg-hud-btn inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-band hover:text-text-primary cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={handleSaveEdge} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain p-4 text-xs">
        {/* Directed Endpoints + Swap */}
        <div className="space-y-2.5 rounded-md border border-border bg-surface-inset p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={`${baseId}-edge-src`} className="ws-eyebrow block">
                Upstream Source
              </label>
              <select
                id={`${baseId}-edge-src`}
                value={edgeSourceUuid}
                onChange={(e) => setEdgeSourceUuid(e.target.value)}
                className="form-input mt-1"
              >
                {allNodes.map((n) => (
                  <option key={n.uuid} value={n.uuid}>
                    {n.properties.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => {
                const prevSrc = edgeSourceUuid;
                setEdgeSourceUuid(edgeTargetUuid);
                setEdgeTargetUuid(prevSrc);
              }}
              title="Swap causal direction"
              aria-label="Swap source and target direction"
              className="mt-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-surface text-text-muted hover:border-amber-400 hover:text-amber-300 cursor-pointer"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              <label htmlFor={`${baseId}-edge-tgt`} className="ws-eyebrow block">
                Downstream Target
              </label>
              <select
                id={`${baseId}-edge-tgt`}
                value={edgeTargetUuid}
                onChange={(e) => setEdgeTargetUuid(e.target.value)}
                className="form-input mt-1"
              >
                {allNodes.map((n) => (
                  <option key={n.uuid} value={n.uuid}>
                    {n.properties.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {srcNode && tgtNode && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              {onSelectNode ? (
                <button
                  type="button"
                  onClick={() => onSelectNode(srcNode)}
                  title="Inspect upstream source node"
                  className="max-w-[10.5rem] truncate font-medium text-text-primary hover:text-accent-fg hover:underline cursor-pointer"
                >
                  {srcNode.properties.name}
                </button>
              ) : (
                <span className="truncate font-medium text-text-primary">
                  {srcNode.properties.name}
                </span>
              )}
              <ArrowRight className="h-3 w-3 shrink-0 text-amber-400" />
              {onSelectNode ? (
                <button
                  type="button"
                  onClick={() => onSelectNode(tgtNode)}
                  title="Inspect downstream target node"
                  className="max-w-[10.5rem] truncate font-medium text-text-primary hover:text-accent-fg hover:underline cursor-pointer"
                >
                  {tgtNode.properties.name}
                </button>
              ) : (
                <span className="truncate font-medium text-text-primary">
                  {tgtNode.properties.name}
                </span>
              )}
            </div>
          )}
        </div>

        <div>
          <label htmlFor={`${baseId}-edge-type`} className="ws-eyebrow mb-1 block">
            Causal / Scientific Relationship
          </label>
          <select
            id={`${baseId}-edge-type`}
            value={edgeType}
            onChange={(e) => setEdgeType(e.target.value as ETGRelationshipType)}
            className="form-input"
          >
            {RELATIONSHIP_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label htmlFor={`${baseId}-edge-lag`} className="ws-eyebrow mb-1 block">
              Lead Lag
            </label>
            <input
              id={`${baseId}-edge-lag`}
              type="number"
              min={0}
              value={edgeLagSteps}
              onChange={(e) => setEdgeLagSteps(e.target.value)}
              className="form-input font-mono"
            />
          </div>
          <div>
            <label htmlFor={`${baseId}-edge-unit`} className="ws-eyebrow mb-1 block">
              Lag Unit
            </label>
            <select
              id={`${baseId}-edge-unit`}
              value={edgeLagUnit}
              onChange={(e) => setEdgeLagUnit(e.target.value as "days" | "months" | "years")}
              className="form-input"
            >
              <option value="days">days</option>
              <option value="months">months</option>
              <option value="years">years</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${baseId}-edge-weight`} className="ws-eyebrow mb-1 block">
              Weight (<span className="ws-numeric">{edgeWeight.toFixed(2)}</span>)
            </label>
            <input
              id={`${baseId}-edge-weight`}
              type="range"
              min={0.1}
              max={1.0}
              step={0.05}
              value={edgeWeight}
              onChange={(e) => setEdgeWeight(Number(e.target.value))}
              className="mt-2 w-full accent-accent"
            />
          </div>
        </div>

        <div>
          <label htmlFor={`${baseId}-edge-custom`} className="ws-eyebrow mb-1 block">
            Custom Label Override (Optional)
          </label>
          <input
            id={`${baseId}-edge-custom`}
            type="text"
            placeholder="e.g., Upwind Advection, Grid Load Spike"
            value={edgeCustomLabel}
            onChange={(e) => setEdgeCustomLabel(e.target.value)}
            className="form-input"
          />
        </div>

        <div>
          <label htmlFor={`${baseId}-edge-mech`} className="ws-eyebrow mb-1 block">
            Physical Mechanism
          </label>
          <input
            id={`${baseId}-edge-mech`}
            type="text"
            placeholder="e.g., Westerly cloud-cover transport over Front Range"
            value={edgeMechanism}
            onChange={(e) => setEdgeMechanism(e.target.value)}
            className="form-input"
          />
        </div>

        <div>
          <label htmlFor={`${baseId}-edge-rat`} className="ws-eyebrow mb-1 block">
            Hypothesis / Scientific Rationale
          </label>
          <textarea
            id={`${baseId}-edge-rat`}
            rows={2}
            placeholder="Why should a forecasting model read this link?"
            value={edgeRationale}
            onChange={(e) => setEdgeRationale(e.target.value)}
            className="form-input"
          />
        </div>

        {selectedEdge &&
          (selectedEdge.properties.correlation_r !== undefined ||
            selectedEdge.properties.detrended_r !== undefined ||
            selectedEdge.properties.partial_r !== undefined ||
            selectedEdge.properties.multivariate_partial_r !== undefined ||
            selectedEdge.properties.p_value !== undefined ||
            selectedEdge.properties.fdr_q_value !== undefined ||
            selectedEdge.properties.predictive_lift_pct !== undefined ||
            selectedEdge.properties.amplification_ratio !== undefined ||
            selectedEdge.properties.mediated_by !== undefined) &&
          (() => {
            const ep = selectedEdge.properties;
            const lift = ep.predictive_lift_pct;
            const medNode = ep.mediated_by ? nodeById.get(ep.mediated_by) : undefined;
            const stats: Array<{ label: string; value: string; cls?: string }> = [];
            if (typeof ep.correlation_r === "number") {
              stats.push({ label: "Pearson r", value: ep.correlation_r.toFixed(3) });
            }
            if (typeof ep.detrended_r === "number") {
              stats.push({ label: "Detrended r", value: ep.detrended_r.toFixed(3) });
            }
            if (typeof ep.partial_r === "number") {
              stats.push({ label: "Partial r", value: ep.partial_r.toFixed(3) });
            }
            if (typeof ep.multivariate_partial_r === "number") {
              stats.push({ label: "MV Partial r", value: ep.multivariate_partial_r.toFixed(3) });
            }
            if (typeof ep.p_value === "number") {
              stats.push({
                label: "p-value",
                value: ep.p_value < 0.0001 ? "<0.0001" : ep.p_value.toFixed(4),
              });
            }
            if (typeof ep.fdr_q_value === "number") {
              stats.push({
                label: "FDR q",
                value: ep.fdr_q_value < 0.0001 ? "<0.0001" : ep.fdr_q_value.toFixed(4),
              });
            }
            if (typeof ep.optimal_lag_steps === "number") {
              stats.push({
                label: "Optimal lag",
                value: `${ep.optimal_lag_steps} ${ep.lag_unit ?? "steps"}`,
              });
            }
            if (typeof ep.amplification_ratio === "number") {
              stats.push({ label: "Amp ratio", value: `${ep.amplification_ratio.toFixed(2)}×` });
            }
            if (typeof lift === "number" && Number.isFinite(lift)) {
              stats.push({
                label: "Out-of-sample lift",
                value: `${lift >= 0 ? "+" : ""}${lift.toFixed(1)}%`,
                cls: lift > 0 ? "text-emerald-300 font-semibold" : "text-rose-300 font-semibold",
              });
            }
            return (
              <div className="space-y-2 rounded-md border border-border bg-surface-inset p-3.5 text-xs">
                <div className="ws-eyebrow text-sky-400">
                  Empirical Coupling &amp; Confounder Audit
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono ws-numeric">
                  {stats.map((s) => (
                    <div key={s.label} className="flex items-center justify-between gap-1.5">
                      <span className="text-text-subtle">{s.label}</span>
                      <span className={s.cls ?? "font-medium text-text-primary"}>{s.value}</span>
                    </div>
                  ))}
                </div>
                {ep.mediated_by && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-1.5 text-[11px] text-amber-300">
                    <span className="font-semibold">Mediated / Confounded by:</span>
                    {medNode && onSelectNode ? (
                      <button
                        type="button"
                        onClick={() => onSelectNode(medNode)}
                        className="underline hover:text-amber-200 cursor-pointer text-left"
                      >
                        {medNode.properties.name}
                      </button>
                    ) : (
                      <span>{medNode?.properties.name ?? ep.mediated_by}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

        {localError && (
          <div
            role="alert"
            className="rounded-sm border border-rose-400 bg-rose-950 px-3 py-2 text-xs leading-relaxed text-rose-300"
          >
            {localError}
          </div>
        )}

        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-2.5">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-sm bg-accent px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            <Check className="h-3.5 w-3.5" />
            {selectedEdge ? "Save Edge Changes" : "Wire Causal Link"}
          </button>
          {selectedEdge && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onDeleteEdge(selectedEdge.properties.uuid)}
              className="inline-flex items-center gap-1 rounded-sm border border-rose-400 bg-rose-950 px-2.5 py-1.5 text-xs font-semibold text-rose-300 hover:border-rose-300 disabled:opacity-50 cursor-pointer"
            >
              <Unlink className="h-3.5 w-3.5" />
              Unlink
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
