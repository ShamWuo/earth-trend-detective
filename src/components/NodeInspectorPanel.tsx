"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  GitBranch,
  MapPin,
  Radio,
  ShieldCheck,
} from "lucide-react";
import { buildExternalExplorerLinks } from "@/lib/datasets";
import type { ETGEdge, ETGNode } from "@/types/etg";

interface NodeInspectorPanelProps {
  node: ETGNode | null;
  allNodes: ETGNode[];
  allEdges: ETGEdge[];
  onSelectNode: (node: ETGNode) => void;
  onCompareOpposite: (nodeA: ETGNode, nodeB: ETGNode) => void;
  onGraphUpdated: () => Promise<void>;
}

export function NodeInspectorPanel({
  node,
  allNodes,
  allEdges,
  onSelectNode,
  onCompareOpposite,
  onGraphUpdated,
}: NodeInspectorPanelProps) {
  const [showReviseForm, setShowReviseForm] = useState(false);
  const [revName, setRevName] = useState("");
  const [revDesc, setRevDesc] = useState("");
  const [revRationale, setRevRationale] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [fieldUnit, setFieldUnit] = useState("");
  const [fieldDate, setFieldDate] = useState("");
  const [fieldNote, setFieldNote] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.uuid, n])), [allNodes]);

  const supportingEdges = useMemo(() => {
    if (!node) return [];
    return allEdges.filter(
      (e) =>
        e.target_uuid === node.uuid &&
        (e.type === "supports" || e.type === "corroborates")
    );
  }, [node, allEdges]);

  const oppositeEdges = useMemo(() => {
    if (!node) return [];
    return allEdges.filter(
      (e) =>
        e.type === "drives_opposite" &&
        (e.source_uuid === node.uuid || e.target_uuid === node.uuid)
    );
  }, [node, allEdges]);

  const connectedEdges = useMemo(() => {
    if (!node) return [];
    const allowed = new Set(["teleconnects", "correlates_with", "relates_to", "monitors"]);
    return allEdges.filter((e) => {
      if (!allowed.has(e.type)) return false;
      if (e.source_uuid !== node.uuid && e.target_uuid !== node.uuid) return false;
      const peerId = e.source_uuid === node.uuid ? e.target_uuid : e.source_uuid;
      return !peerId.startsWith("rule-");
    });
  }, [node, allEdges]);

  const beliefChain = useMemo(() => {
    if (!node) return [];
    // Walk upstream and downstream along `supersedes`
    let head = node.uuid;
    const guard = new Set<string>();
    while (!guard.has(head)) {
      guard.add(head);
      const newer = allEdges.find((e) => e.type === "supersedes" && e.target_uuid === head);
      if (!newer) break;
      head = newer.source_uuid;
    }
    const chain: Array<{ node: ETGNode; rationale?: string }> = [];
    const seen = new Set<string>();
    let curr: string | undefined = head;
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const n = nodeMap.get(curr);
      const edge = allEdges.find((e) => e.type === "supersedes" && e.source_uuid === curr);
      if (n) chain.push({ node: n, rationale: edge?.properties.rationale });
      curr = edge?.target_uuid;
    }
    return chain;
  }, [node, allEdges, nodeMap]);

  if (!node) {
    return (
      <div className="p-4 text-xs text-text-muted">
        Select any node on the Earth Globe or Earth Trend Graph to inspect multi-source
        corroboration, opposite-trend teleconnections, and <code className="font-mono">supersedes</code>{" "}
        belief revision lineage.
      </div>
    );
  }

  const isSuperseded = node.properties.status === "Superseded";
  const isProvisional = Boolean(node.is_provisional);

  const handleSimulateWebhook = async () => {
    if (node.properties.lat === undefined || node.properties.lng === undefined) return;
    setBusyAction("webhook");
    setActionMsg(null);
    try {
      const res = await fetch(`/api/graph/nodes/${encodeURIComponent(node.uuid)}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: node.properties.device_id || `edge-sensor-${node.uuid.slice(0, 6)}`,
          producer_type: "iot_sensor",
          dataset: node.properties.dataset || "community",
          lat: node.properties.lat,
          lng: node.properties.lng,
          value: node.properties.value,
          unit: node.properties.unit || "units",
          confidence: 0.93,
          title: `Co-located sensor verification near ${node.properties.name.slice(0, 28)}`,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          linkedInsights?: unknown[];
          linkedSignals?: unknown[];
          discoveredConnections?: unknown[];
        };
        const trendCount = data.linkedInsights?.length ?? 0;
        const localCount = data.linkedSignals?.length ?? 0;
        const globalCount = data.discoveredConnections?.length ?? 0;
        setActionMsg(
          `Sensor check-in ingested (${trendCount} trend, ${localCount} nearby, ${globalCount} global link${globalCount === 1 ? "" : "s"}).`
        );
        await onGraphUpdated();
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleFieldUpdateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fieldValue.trim() === "" && !fieldNote.trim()) return;
    setBusyAction("field-update");
    setActionMsg(null);
    try {
      const numericVal = fieldValue.trim() !== "" ? Number(fieldValue) : undefined;
      const res = await fetch(`/api/graph/nodes/${encodeURIComponent(node.uuid)}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: numericVal !== undefined && Number.isFinite(numericVal) ? numericVal : undefined,
          unit: fieldUnit.trim() || node.properties.unit || "units",
          observed_at: fieldDate.trim() || undefined,
          description: fieldNote.trim() || undefined,
          lat: node.properties.lat,
          lng: node.properties.lng,
          dataset: node.properties.dataset || "community",
          producer_type: "iot_sensor",
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          linkedInsights?: unknown[];
          linkedSignals?: unknown[];
          discoveredConnections?: unknown[];
        };
        const trendCount = data.linkedInsights?.length ?? 0;
        const localCount = data.linkedSignals?.length ?? 0;
        const globalCount = data.discoveredConnections?.length ?? 0;
        setFieldValue("");
        setFieldNote("");
        setActionMsg(
          `Field reading logged (${trendCount} trend, ${localCount} nearby, ${globalCount} global link${globalCount === 1 ? "" : "s"}).`
        );
        await onGraphUpdated();
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerifyGate = async () => {
    setBusyAction("verify");
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", nodeUuid: node.uuid }),
      });
      const data = await res.json();
      setActionMsg(
        data.audit?.corroborated
          ? "Corroborated! Promoted to verified Earth Trend."
          : `Requires ≥2 supporting sources (currently ${data.audit?.supportingSources?.length ?? 0}).`
      );
      await onGraphUpdated();
    } finally {
      setBusyAction(null);
    }
  };

  const handleReviseBelief = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!revName.trim() || !revDesc.trim() || !revRationale.trim()) return;
    setBusyAction("revise");
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorNodeUuid: node.uuid,
          newName: revName,
          newDescription: revDesc,
          rationale: revRationale,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setShowReviseForm(false);
        setRevName("");
        setRevDesc("");
        setRevRationale("");
        setActionMsg("Epistemic belief revision recorded with supersedes edge.");
        await onGraphUpdated();
        if (data.revisedNode) onSelectNode(data.revisedNode);
      }
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-7 p-7 text-sm">
      {/* Header Zone: Identity, Status & Readable Title */}
      <div className="space-y-3.5 border-b border-border pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border bg-surface-elevated px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
            {node.label}
          </span>
          {isSuperseded ? (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-amber-400">
              SUPERSEDED
            </span>
          ) : isProvisional ? (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-amber-400">
              PROVISIONAL
            </span>
          ) : (
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-400">
              CORROBORATED
            </span>
          )}
        </div>

        <h3 className="text-xl font-semibold leading-snug text-text-primary">
          {node.properties.name}
        </h3>

        <p className="text-sm leading-relaxed text-text-muted">{node.properties.description}</p>

        <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
          {node.properties.lat !== undefined && node.properties.lng !== undefined && (
            <div className="ws-numeric inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-inset px-3 py-1 font-mono text-xs text-text-subtle">
              <MapPin className="h-3.5 w-3.5 text-accent-fg" aria-hidden="true" />
              <span>
                {node.properties.lat.toFixed(2)}°, {node.properties.lng.toFixed(2)}°
              </span>
            </div>
          )}
          {node.properties.source_system && (
            <span className="rounded-full border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-subtle">
              {node.properties.source_system}
            </span>
          )}
          {typeof node.properties.source_url === "string" && (
            <a
              href={node.properties.source_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-accent-fg hover:underline"
            >
              Source Data ↗
            </a>
          )}
          {node.properties.lat !== undefined && node.properties.lng !== undefined && (
            <a
              href={
                buildExternalExplorerLinks(
                  node.properties.lat,
                  node.properties.lng,
                  node.properties.dataset
                ).giovanniUrl
              }
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-sky-400 hover:underline"
            >
              NASA Giovanni ↗
            </a>
          )}
        </div>
      </div>

      {/* Statistical Callout Tiles (when numeric trend metadata exists) */}
      {(node.properties.p_value !== undefined || node.properties.theil_sen_slope !== undefined) && (
        <div className="grid grid-cols-2 gap-4">
          {node.properties.p_value !== undefined && (
            <div className="ws-inset rounded-2xl p-4">
              <div className="ws-eyebrow">Mann-Kendall p</div>
              <div className="ws-numeric mt-2 font-mono text-xl font-semibold text-text-primary">
                {node.properties.p_value < 0.0001
                  ? "< 0.0001"
                  : node.properties.p_value.toFixed(4)}
              </div>
              <div className="ws-numeric mt-1.5 text-xs text-text-subtle">
                {node.properties.p_value_adjusted !== undefined
                  ? node.properties.p_value_adjusted < 0.0001
                    ? "Hamed-Rao p* < 0.0001"
                    : `Hamed-Rao p*=${node.properties.p_value_adjusted.toFixed(4)}`
                  : node.properties.p_value < 0.05
                    ? "Statistically significant"
                    : "Below α=0.05 threshold"}
              </div>
            </div>
          )}

          {node.properties.theil_sen_slope !== undefined && (
            <div className="ws-inset rounded-2xl p-4">
              <div className="ws-eyebrow">Theil-Sen Slope</div>
              <div className="ws-numeric mt-2 font-mono text-xl font-semibold text-text-primary">
                {node.properties.theil_sen_slope >= 0 ? "+" : ""}
                {node.properties.theil_sen_slope}
                {node.properties.slope_unit && (
                  <span className="ml-1 text-xs font-normal text-text-muted">
                    {node.properties.slope_unit}
                  </span>
                )}
              </div>
              <div className="ws-numeric mt-1.5 text-xs text-text-subtle">
                {node.properties.ols_r2 !== undefined
                  ? `OLS R²=${node.properties.ols_r2.toFixed(2)}${node.properties.regime_shift_year ? ` · Shift ${node.properties.regime_shift_year}` : ""}`
                  : "Median monotonic rate"}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Multi-Source Corroboration Gate */}
      <div className="ws-inset space-y-3.5 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-text-primary">
            <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            Corroboration Gate (≥2 Sources)
          </div>
          <button
            type="button"
            onClick={handleVerifyGate}
            disabled={busyAction === "verify"}
            className="text-xs font-medium text-accent-fg hover:underline cursor-pointer"
          >
            {busyAction === "verify" ? "Checking…" : "Re-check"}
          </button>
        </div>

        {supportingEdges.length === 0 ? (
          <div className="flex items-start gap-2 text-xs leading-relaxed text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>No incoming supporting sources yet. Push a second sensor or satellite feed.</span>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {supportingEdges.map((edge) => {
              const src = nodeMap.get(edge.source_uuid);
              if (!src) return null;
              return (
                <li key={edge.properties.uuid} className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onSelectNode(src)}
                    className="truncate text-left text-xs font-medium text-emerald-400 hover:underline cursor-pointer"
                  >
                    • {src.properties.name}
                  </button>
                  <span className="shrink-0 font-mono text-[11px] text-text-faint">
                    {src.properties.producer_type || src.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Opposite-Trend Teleconnections */}
      {oppositeEdges.length > 0 && (
        <div className="space-y-3.5 rounded-2xl border border-rose-500/35 bg-rose-500/10 p-5">
          <div className="ws-eyebrow text-rose-400">Cross-Region Opposite Trends</div>
          {oppositeEdges.map((edge) => {
            const peerId = edge.source_uuid === node.uuid ? edge.target_uuid : edge.source_uuid;
            const peer = nodeMap.get(peerId);
            if (!peer) return null;
            return (
              <div key={edge.properties.uuid} className="space-y-2.5 border-t border-border/60 pt-3.5 first:border-t-0 first:pt-0">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectNode(peer)}
                    className="text-left text-sm font-semibold text-text-primary hover:text-accent-fg hover:underline cursor-pointer"
                  >
                    {peer.properties.name}
                  </button>
                  {edge.properties.correlation_r !== undefined && (
                    <span className="ws-numeric shrink-0 font-mono text-xs font-semibold text-rose-400">
                      r = {edge.properties.correlation_r.toFixed(2)}
                    </span>
                  )}
                </div>
                {edge.properties.rationale && (
                  <p className="text-xs leading-relaxed text-text-muted">{edge.properties.rationale}</p>
                )}
                <button
                  type="button"
                  onClick={() => onCompareOpposite(node, peer)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/15 px-3.5 py-2 text-xs font-semibold text-rose-400 hover:border-rose-400 cursor-pointer"
                >
                  Overlay Opposite Time-Series <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Connected Events, Monitors & Teleconnections */}
      {connectedEdges.length > 0 && (
        <div className="ws-inset space-y-3.5 rounded-2xl p-5">
          <div className="ws-eyebrow text-sky-400">
            Connected Events &amp; Teleconnections ({connectedEdges.length})
          </div>
          <div className="space-y-3">
            {connectedEdges.map((edge) => {
              const peerId = edge.source_uuid === node.uuid ? edge.target_uuid : edge.source_uuid;
              const peer = nodeMap.get(peerId);
              if (!peer) return null;
              const canOverlay = edge.type === "teleconnects" || edge.type === "correlates_with";
              return (
                <div
                  key={edge.properties.uuid}
                  className="space-y-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectNode(peer)}
                      className="truncate text-left text-xs font-semibold text-text-primary hover:text-accent-fg hover:underline cursor-pointer"
                    >
                      {peer.properties.name}
                    </button>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="rounded-full border border-border bg-surface-elevated px-2 py-0.5 font-mono text-[10px] text-sky-400">
                        {edge.type}
                      </span>
                      {edge.properties.correlation_r !== undefined && (
                        <span className="ws-numeric font-mono text-[11px] text-text-muted">
                          r={edge.properties.correlation_r.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  {(edge.properties.rationale || edge.properties.source_snippet) && (
                    <p className="text-xs leading-relaxed text-text-muted">
                      {edge.properties.rationale || edge.properties.source_snippet}
                    </p>
                  )}
                  {canOverlay && (
                    <button
                      type="button"
                      onClick={() => onCompareOpposite(node, peer)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 px-2.5 py-1 text-[11px] font-semibold text-sky-400 hover:border-sky-400 cursor-pointer"
                    >
                      Overlay Series <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Progressive Disclosure: Epistemic Belief Lineage (`supersedes`) */}
      <details
        className="etg-details"
        open={beliefChain.length > 1 || showReviseForm}
      >
        <summary>
          <span className="inline-flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-amber-400" aria-hidden="true" />
            <span>Epistemic Belief Lineage ({beliefChain.length})</span>
          </span>
        </summary>
        <div className="space-y-3.5 p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-subtle">
              Tracks how hypotheses evolved via supersedes edges.
            </span>
            <button
              type="button"
              onClick={() => setShowReviseForm((v) => !v)}
              className="shrink-0 text-xs font-medium text-amber-400 hover:underline cursor-pointer"
            >
              {showReviseForm ? "Cancel" : "Supersede Conclusion"}
            </button>
          </div>

          {beliefChain.length > 1 ? (
            <div className="space-y-2">
              {beliefChain.map((step, idx) => (
                <div key={step.node.uuid} className="border-l-2 border-amber-400/60 pl-3">
                  <button
                    type="button"
                    onClick={() => onSelectNode(step.node)}
                    className={`text-left text-xs font-medium hover:underline cursor-pointer ${
                      step.node.uuid === node.uuid ? "text-text-primary" : "text-text-muted"
                    }`}
                  >
                    {idx === 0 ? "Current: " : "Prior: "}
                    {step.node.properties.name}
                  </button>
                  {step.rationale && (
                    <div className="mt-0.5 text-xs text-text-subtle">↳ {step.rationale}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-text-subtle">
              No superseded hypotheses yet. Revise this node if new telemetry refutes it.
            </div>
          )}

          {showReviseForm && (
            <form onSubmit={handleReviseBelief} className="space-y-2.5 border-t border-border pt-3">
              <div>
                <label htmlFor={`rev-name-${node.uuid}`} className="ws-eyebrow mb-1 block">
                  Revised Conclusion Title
                </label>
                <input
                  id={`rev-name-${node.uuid}`}
                  name="revised_name"
                  type="text"
                  required
                  placeholder="Revised scientific conclusion title"
                  value={revName}
                  onChange={(e) => setRevName(e.target.value)}
                  className="form-input"
                />
              </div>
              <div>
                <label htmlFor={`rev-desc-${node.uuid}`} className="ws-eyebrow mb-1 block">
                  Evidence Summary
                </label>
                <textarea
                  id={`rev-desc-${node.uuid}`}
                  name="revised_description"
                  required
                  rows={2}
                  placeholder="Updated description supported by new observations"
                  value={revDesc}
                  onChange={(e) => setRevDesc(e.target.value)}
                  className="form-input"
                />
              </div>
              <div>
                <label htmlFor={`rev-rationale-${node.uuid}`} className="ws-eyebrow mb-1 block">
                  Revision Rationale
                </label>
                <input
                  id={`rev-rationale-${node.uuid}`}
                  name="revised_rationale"
                  type="text"
                  required
                  placeholder="Why was the prior hypothesis superseded?"
                  value={revRationale}
                  onChange={(e) => setRevRationale(e.target.value)}
                  className="form-input"
                />
              </div>
              <button
                type="submit"
                disabled={busyAction === "revise"}
                className="w-full rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-400 cursor-pointer"
              >
                {busyAction === "revise" ? "Revising…" : "Commit Belief Revision (supersedes)"}
              </button>
            </form>
          )}
        </div>
      </details>

      {/* Progressive Disclosure: Hardware / Camera Webhook */}
      {node.properties.lat !== undefined && node.properties.lng !== undefined && (
        <details className="etg-details">
          <summary>
            <span className="inline-flex items-center gap-2">
              <Radio className="h-4 w-4 text-purple-400" aria-hidden="true" />
              <span>Hardware &amp; Sensor Webhook</span>
            </span>
          </summary>
          <div className="space-y-4 p-5">
            <code className="block overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11px] text-text-muted">
              POST /api/graph/nodes/{node.uuid}/webhook
            </code>
            <form onSubmit={handleFieldUpdateSubmit} className="space-y-2.5 border-t border-border pt-3">
              <div className="ws-eyebrow">Log Field Update / Reading</div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  step="any"
                  aria-label="Reading value"
                  placeholder="Value (e.g. 24.6)"
                  value={fieldValue}
                  onChange={(e) => setFieldValue(e.target.value)}
                  className="form-input"
                />
                <input
                  type="text"
                  aria-label="Measurement unit"
                  placeholder={node.properties.unit || "unit (e.g. °C)"}
                  value={fieldUnit}
                  onChange={(e) => setFieldUnit(e.target.value)}
                  className="form-input"
                />
              </div>
              <input
                type="text"
                aria-label="Observation date"
                placeholder="Date (optional, e.g. 2024 or 2024-07-15)"
                value={fieldDate}
                onChange={(e) => setFieldDate(e.target.value)}
                className="form-input"
              />
              <input
                type="text"
                aria-label="Field observation note"
                placeholder="Observation note / sensor context"
                value={fieldNote}
                onChange={(e) => setFieldNote(e.target.value)}
                className="form-input"
              />
              <button
                type="submit"
                disabled={busyAction === "field-update" || (fieldValue.trim() === "" && !fieldNote.trim())}
                className="w-full rounded-xl bg-accent px-3.5 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                {busyAction === "field-update" ? "Updating Event & Discovering Links…" : "Log Reading & Auto-Connect"}
              </button>
            </form>
            <button
              type="button"
              onClick={handleSimulateWebhook}
              disabled={busyAction === "webhook"}
              className="w-full rounded-xl border border-border-strong bg-surface-elevated px-3.5 py-2.5 text-xs font-semibold text-text-primary hover:border-accent-fg cursor-pointer"
            >
              {busyAction === "webhook" ? "Streaming Reading…" : "Push Co-Located Sensor Check-In"}
            </button>
          </div>
        </details>
      )}

      {actionMsg && (
        <div role="status" className="flex items-center gap-2 text-xs font-medium text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          {actionMsg}
        </div>
      )}
    </div>
  );
}
