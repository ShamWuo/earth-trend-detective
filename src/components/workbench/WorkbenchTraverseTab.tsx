"use client";

import React, { useState } from "react";
import { History, Link2, Pencil, Sparkles, Unlink, Waypoints } from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { formatEdgeRelationLabel, resolveEtgEdgeColor } from "@/lib/graph/graphVisuals";
import type {
  CandidateLinkSuggestion,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  LinkTrendMicroscopeCue,
  NodeTrendMicroscopeCue,
  TrendMicroscopeRadarBadge,
  TrendMicroscopeScanResult,
} from "@/types/etg";

const BADGE_STYLES: Record<TrendMicroscopeRadarBadge, { label: string; cls: string }> = {
  EARLY_ONSET: {
    label: "Early Onset",
    cls: "border-amber-400 bg-amber-950 text-amber-300",
  },
  SECULAR_ACCELERATION: {
    label: "Secular Accel",
    cls: "border-emerald-400 bg-emerald-950 text-emerald-300",
  },
  FALSE_TREND_CYCLE: {
    label: "Cycle Alias",
    cls: "border-purple-400 bg-purple-950 text-purple-300",
  },
  SENSOR_GLITCH_RISK: {
    label: "Sensor Glitch Risk",
    cls: "border-rose-400 bg-rose-950 text-rose-300",
  },
  NOMINAL: {
    label: "Nominal",
    cls: "border-border bg-surface text-text-muted",
  },
};

function NeighborLinkList({
  direction,
  links,
  onSelectNode,
  onSelectEdge,
  onDeleteEdge,
}: {
  direction: "incoming" | "outgoing";
  links: Array<{ edge: ETGEdge; node: ETGNode }>;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge: (edge: ETGEdge) => void;
  onDeleteEdge: (edgeUuid: string) => Promise<void>;
}) {
  const isIncoming = direction === "incoming";
  return (
    <div className="space-y-1.5">
      {isIncoming ? (
        <div className="flex items-center justify-between">
          <span className="ws-eyebrow text-sky-400">
            Upstream Drivers ({links.length})
          </span>
        </div>
      ) : (
        <span className="ws-eyebrow block text-amber-400">
          Downstream Effects ({links.length})
        </span>
      )}
      {links.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-text-muted">
          {isIncoming
            ? "No incoming driver edges yet. Wire one or click Discover Links."
            : "No outgoing downstream edges yet."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {links.map(({ edge, node }) => (
            <div
              key={edge.properties.uuid}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-inset px-2.5 py-2"
            >
              <button
                type="button"
                onClick={() => onSelectNode(node)}
                className="min-w-0 flex-1 text-left cursor-pointer group"
              >
                <div className="truncate font-medium text-text-primary group-hover:text-accent-fg">
                  {isIncoming ? node.properties.name : `→ ${node.properties.name}`}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-muted">
                  <span style={{ color: resolveEtgEdgeColor(edge.type) }}>
                    {formatEdgeRelationLabel(edge.type, edge.properties.custom_label)}
                  </span>
                  {isIncoming &&
                    typeof edge.properties.optimal_lag_steps === "number" &&
                    edge.properties.optimal_lag_steps > 0 && (
                      <span>
                        · Δt={edge.properties.optimal_lag_steps} {edge.properties.lag_unit}
                      </span>
                    )}
                  {edge.properties.correlation_r !== undefined && (
                    <span>· r={edge.properties.correlation_r.toFixed(2)}</span>
                  )}
                </div>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => onSelectEdge(edge)}
                  title={isIncoming ? "Edit connection" : undefined}
                  aria-label={`Edit edge ${isIncoming ? "from" : "to"} ${node.properties.name}`}
                  className="rounded p-1 text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteEdge(edge.properties.uuid)}
                  title={isIncoming ? "Unlink" : undefined}
                  aria-label={`Unlink ${node.properties.name}`}
                  className="rounded p-1 text-text-muted hover:text-rose-400 cursor-pointer"
                >
                  <Unlink className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface WorkbenchTraverseTabProps {
  baseId: string;
  selectedNode: ETGNode;
  allNodes: ETGNode[];
  allEdges: ETGEdge[];
  nodeById: Map<string, ETGNode>;
  microscopeCue?: NodeTrendMicroscopeCue;
  microscopeScan: TrendMicroscopeScanResult | null;
  supersededByItems: Array<{ node: ETGNode; rationale?: string }>;
  supersedesPriorItems: Array<{ node: ETGNode; rationale?: string }>;
  traversalHistory: Array<{ uuid: string; name: string }>;
  incomingLinks: Array<{ edge: ETGEdge; node: ETGNode }>;
  outgoingLinks: Array<{ edge: ETGEdge; node: ETGNode }>;
  nodeCandidates: CandidateLinkSuggestion[];
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge: (edge: ETGEdge) => void;
  onDeleteEdge: (edgeUuid: string) => Promise<void>;
  onStartQuickConnect: (sourceNode: ETGNode, targetNode?: ETGNode) => void;
  onAcceptCandidateLink: (suggestion: CandidateLinkSuggestion) => Promise<void>;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
  onSetLocalError: (msg: string | null) => void;
  onSetLocalStatus: (msg: string | null) => void;
}

export function WorkbenchTraverseTab({
  baseId,
  selectedNode,
  allNodes,
  allEdges,
  nodeById,
  microscopeCue,
  microscopeScan,
  supersededByItems,
  supersedesPriorItems,
  traversalHistory,
  incomingLinks,
  outgoingLinks,
  nodeCandidates,
  onSelectNode,
  onSelectEdge,
  onDeleteEdge,
  onStartQuickConnect,
  onAcceptCandidateLink,
  onSnapshotChange,
  onSetLocalError,
  onSetLocalStatus,
}: WorkbenchTraverseTabProps) {
  const [wiringMicroscopeKey, setWiringMicroscopeKey] = useState<string | null>(null);
  const [quickWireTargetUuid, setQuickWireTargetUuid] = useState("");

  const handleWireMicroscopeCoupling = async (coupling: LinkTrendMicroscopeCue) => {
    const key = `${coupling.sourceUuid}->${coupling.targetUuid}`;
    setWiringMicroscopeKey(key);
    onSetLocalError(null);
    try {
      const relType: ETGRelationshipType =
        coupling.polarity === "drives_opposite"
          ? "drives_opposite"
          : coupling.optimalLagSteps > 0
            ? "leads"
            : "correlates_with";
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          source_uuid: coupling.sourceUuid,
          target_uuid: coupling.targetUuid,
          type: relType,
          optimal_lag_steps: coupling.optimalLagSteps,
          lag_unit: "years",
          weight: Number(coupling.trueCouplingProb.toFixed(3)),
          correlation_r: Number(coupling.cleanPeakR.toFixed(3)),
          mechanism: coupling.aiCue,
          rationale: `Wired from ETG Trend Microscope (${microscopeScan?.engineUsed ?? "calibrated"}, lag=${coupling.optimalLagSteps}, clean r=${coupling.cleanPeakR.toFixed(2)}, P=${Math.round(coupling.trueCouplingProb * 100)}%).`,
          authored_by: "ai",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to wire microscope coupling");
      onSnapshotChange(
        data.snapshot,
        `Wired ${coupling.sourceName} → ${coupling.targetName} via Trend Microscope.`
      );
      onSetLocalStatus(
        `Wired ${relType} link (${coupling.sourceName} → ${coupling.targetName}).`
      );
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "Failed to wire coupling");
    } finally {
      setWiringMicroscopeKey(null);
    }
  };

  return (
    <div className="space-y-3.5 p-3.5">
      {microscopeCue &&
        (() => {
          const secPct = Math.round(microscopeCue.dealiasing.secularShare * 100);
          const cycPct = Math.round(microscopeCue.dealiasing.oscillationShare * 100);
          const artPct = Math.max(0, 100 - secPct - cycPct);
          const engineLabel =
            microscopeScan?.engineUsed === "l4_microscope"
              ? "L4 Microscope"
              : microscopeScan?.engineUsed === "local_microscope_weights"
                ? "Local Weights"
                : "Calibrated";
          const anchoredCouplings = (microscopeScan?.verifiedCouplings ?? [])
            .filter(
              (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
            )
            .slice(0, 3);
          const anchoredIllusions = (microscopeScan?.suppressedIllusions ?? [])
            .filter(
              (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
            )
            .slice(0, 2);
          const dirLabel =
            microscopeCue.emergingDirection === "increasing"
              ? "↑ rising"
              : microscopeCue.emergingDirection === "decreasing"
                ? "↓ falling"
                : "→ stable";

          return (
            <div className="space-y-2 rounded-md border border-border bg-surface-inset p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="ws-eyebrow flex items-center gap-1 text-sky-400">
                    <Sparkles className="h-3 w-3" />
                    ETG Trend Microscope
                  </span>
                  <span className="rounded-xs border border-border bg-surface px-1 py-0.5 font-mono text-[9px] text-text-subtle">
                    {engineLabel}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {microscopeCue.preMannKendallAlert && (
                    <span className="rounded-xs border border-sky-400 bg-sky-950 px-1.5 py-0.5 font-mono text-[9px] font-bold text-sky-300">
                      PRE-MK
                    </span>
                  )}
                  <span
                    className={`rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${BADGE_STYLES[microscopeCue.radarBadge].cls}`}
                  >
                    {BADGE_STYLES[microscopeCue.radarBadge].label}
                  </span>
                </div>
              </div>

              {/* Head 1: Early Inflection Radar */}
              <div className="ws-numeric flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-text-muted">
                <span>Onset {Math.round(microscopeCue.onsetProb * 100)}%</span>
                <span>{dirLabel}</span>
                {microscopeCue.leadStepsAhead > 0 && (
                  <span>Lead +{microscopeCue.leadStepsAhead.toFixed(1)} steps</span>
                )}
                <span>|Z| {microscopeCue.mkAbsZ.toFixed(2)}</span>
                <span>Trust {Math.round(microscopeCue.trustGate * 100)}%</span>
              </div>

              {/* Head 3: 3-Simplex Cycle / Artifact De-Aliasing */}
              <div className="space-y-1">
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface">
                  <div className="bg-emerald-400" style={{ width: `${secPct}%` }} />
                  <div className="bg-purple-400" style={{ width: `${cycPct}%` }} />
                  <div className="bg-rose-400" style={{ width: `${artPct}%` }} />
                </div>
                <div className="ws-numeric flex flex-wrap justify-between gap-x-2 font-mono text-[9.5px] text-text-subtle">
                  <span>Secular {secPct}%</span>
                  <span>Cycle {cycPct}%</span>
                  <span>Artifact {artPct}%</span>
                  <span>
                    False Risk {Math.round(microscopeCue.dealiasing.falseTrendProb * 100)}%
                  </span>
                </div>
                {microscopeCue.aiCue && (
                  <p className="text-[10.5px] leading-snug text-text-muted">
                    {microscopeCue.aiCue}
                  </p>
                )}
              </div>

              {/* Head 2: Verified Lead-Lag Couplings vs Suppressed Illusions */}
              {anchoredCouplings.length > 0 && (
                <div className="space-y-1 border-t border-border/70 pt-1.5">
                  <div className="font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-400">
                    Verified Lead-Lag Couplings ({anchoredCouplings.length})
                  </div>
                  {anchoredCouplings.map((c) => {
                    const peerUuid =
                      c.sourceUuid === selectedNode.uuid ? c.targetUuid : c.sourceUuid;
                    const peerNode = nodeById.get(peerUuid);
                    const isWired =
                      c.alreadyWired ||
                      allEdges.some(
                        (e) =>
                          (e.source_uuid === c.sourceUuid && e.target_uuid === c.targetUuid) ||
                          (e.source_uuid === c.targetUuid && e.target_uuid === c.sourceUuid)
                      );
                    const key = `${c.sourceUuid}->${c.targetUuid}`;
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-2 rounded-sm border border-border/80 bg-surface px-2 py-1"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1 text-[10px]">
                            <span
                              className={`font-semibold ${
                                c.polarity === "drives_opposite"
                                  ? "text-rose-400"
                                  : "text-emerald-400"
                              }`}
                            >
                              {c.polarity === "drives_opposite" ? "⇄ Opposite" : "→ Co-trend"}
                            </span>
                            {peerNode ? (
                              <button
                                type="button"
                                onClick={() => onSelectNode(peerNode)}
                                className="truncate font-medium text-text-primary hover:text-accent-fg hover:underline cursor-pointer text-left"
                              >
                                {peerNode.properties.name}
                              </button>
                            ) : (
                              <span className="truncate text-text-primary">
                                {c.sourceUuid === selectedNode.uuid ? c.targetName : c.sourceName}
                              </span>
                            )}
                          </div>
                          <div className="ws-numeric font-mono text-[9px] text-text-subtle">
                            lag={c.optimalLagSteps} · P={Math.round(c.trueCouplingProb * 100)}% · r=
                            {c.rawPeakR.toFixed(2)}→{c.cleanPeakR.toFixed(2)}
                          </div>
                        </div>
                        {isWired ? (
                          <span className="shrink-0 rounded-xs border border-emerald-400 bg-emerald-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-300">
                            Wired
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={wiringMicroscopeKey === key}
                            onClick={() => void handleWireMicroscopeCoupling(c)}
                            className="shrink-0 rounded-xs border border-amber-400 bg-amber-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-300 hover:border-amber-300 disabled:opacity-50 cursor-pointer"
                          >
                            {wiringMicroscopeKey === key ? "Wiring…" : "+ Wire"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {anchoredIllusions.length > 0 && (
                <div className="space-y-1 border-t border-border/70 pt-1.5">
                  <div className="font-mono text-[9px] font-semibold uppercase tracking-wide text-amber-400">
                    Suppressed Seasonal / Drift Illusions ({anchoredIllusions.length})
                  </div>
                  {anchoredIllusions.map((ill) => (
                    <div
                      key={`${ill.sourceUuid}--${ill.targetUuid}`}
                      className="rounded-sm border border-dashed border-amber-400/50 bg-amber-950/35 px-2 py-1 text-[10px]"
                    >
                      <div className="font-medium text-amber-300">
                        {ill.sourceName} ↔ {ill.targetName}
                      </div>
                      <div className="ws-numeric font-mono text-[9px] text-text-muted">
                        raw r={ill.rawPeakR.toFixed(2)} → clean r={ill.cleanPeakR.toFixed(2)} ·
                        P_illusion={Math.round(ill.confounderProb * 100)}%
                      </div>
                      {ill.aiCue && <div className="text-[9.5px] text-text-subtle">{ill.aiCue}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

      {(supersededByItems.length > 0 || supersedesPriorItems.length > 0) && (
        <div className="space-y-1.5 rounded-md border border-purple-400/50 bg-purple-950/30 p-2.5">
          <div className="ws-eyebrow flex items-center gap-1 text-purple-300">
            <Waypoints className="h-3 w-3" />
            Epistemic Belief-Revision Lineage (supersedes)
          </div>
          {supersededByItems.map(({ node: newerNode, rationale }) => (
            <div key={`by-${newerNode.uuid}`} className="space-y-0.5 text-[10.5px]">
              <div className="flex flex-wrap items-center gap-1 text-text-muted">
                <span className="font-semibold text-amber-300">Superseded by →</span>
                <button
                  type="button"
                  onClick={() => onSelectNode(newerNode)}
                  className="font-medium text-text-primary underline decoration-purple-400/60 hover:text-accent-fg cursor-pointer text-left"
                >
                  {newerNode.properties.name}
                </button>
              </div>
              {rationale && <div className="text-[10px] text-text-subtle">{rationale}</div>}
            </div>
          ))}
          {supersedesPriorItems.map(({ node: priorNode, rationale }) => (
            <div key={`prior-${priorNode.uuid}`} className="space-y-0.5 text-[10.5px]">
              <div className="flex flex-wrap items-center gap-1 text-text-muted">
                <span className="font-semibold text-emerald-300">Supersedes prior →</span>
                <button
                  type="button"
                  onClick={() => onSelectNode(priorNode)}
                  className="font-medium text-text-primary underline decoration-purple-400/60 hover:text-accent-fg cursor-pointer text-left"
                >
                  {priorNode.properties.name}
                </button>
              </div>
              {rationale && <div className="text-[10px] text-text-subtle">{rationale}</div>}
            </div>
          ))}
        </div>
      )}

      {traversalHistory.length > 1 && (
        <div className="space-y-1">
          <div className="ws-eyebrow flex items-center gap-1">
            <History className="h-3 w-3" />
            Traversal Trail
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {traversalHistory.slice(-5).map((crumb, idx, arr) => {
              const target = nodeById.get(crumb.uuid);
              const isCurrent = crumb.uuid === selectedNode.uuid;
              return (
                <React.Fragment key={`${crumb.uuid}-${idx}`}>
                  <button
                    type="button"
                    disabled={!target || isCurrent}
                    onClick={() => target && onSelectNode(target)}
                    className={`rounded-xs px-1.5 py-0.5 text-[10px] ${
                      isCurrent
                        ? "border border-accent-fg bg-amber-950 font-semibold text-amber-300"
                        : "bg-surface-inset text-text-muted hover:text-text-primary cursor-pointer"
                    }`}
                  >
                    {crumb.name.slice(0, 16)}
                  </button>
                  {idx < arr.length - 1 && (
                    <span className="text-[10px] text-text-subtle">→</span>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      <NeighborLinkList
        direction="incoming"
        links={incomingLinks}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onDeleteEdge={onDeleteEdge}
      />

      <NeighborLinkList
        direction="outgoing"
        links={outgoingLinks}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onDeleteEdge={onDeleteEdge}
      />

      {/* Quick Inline Wire */}
      {allNodes.length > 1 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <label htmlFor={`${baseId}-quick-wire`} className="ws-eyebrow block">
            Quick Wire To Another Node
          </label>
          <div className="flex gap-1.5">
            <select
              id={`${baseId}-quick-wire`}
              value={quickWireTargetUuid}
              onChange={(e) => setQuickWireTargetUuid(e.target.value)}
              className="form-input flex-1"
            >
              <option value="">Choose target node…</option>
              {allNodes
                .filter((n) => n.uuid !== selectedNode.uuid)
                .map((n) => (
                  <option key={n.uuid} value={n.uuid}>
                    {n.properties.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={!quickWireTargetUuid}
              onClick={() => {
                const target = nodeById.get(quickWireTargetUuid);
                if (target) {
                  onStartQuickConnect(selectedNode, target);
                  setQuickWireTargetUuid("");
                }
              }}
              className="rounded-sm bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-45 cursor-pointer"
            >
              Wire
            </button>
          </div>
        </div>
      )}

      {/* Latent Candidate Links */}
      {nodeCandidates.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="ws-eyebrow flex items-center gap-1 text-purple-300">
            <Sparkles className="h-3 w-3" />
            Latent Connection Suggestions ({nodeCandidates.length})
          </div>
          <div className="space-y-1.5">
            {nodeCandidates.slice(0, 5).map((cand) => (
              <div
                key={cand.id}
                className="rounded-md border border-purple-400 bg-purple-950 p-2.5 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text-primary truncate">
                    {cand.sourceName} → {cand.targetName}
                  </span>
                  <button
                    type="button"
                    onClick={() => void onAcceptCandidateLink(cand)}
                    className="shrink-0 inline-flex items-center gap-1 rounded-sm border border-violet-400 bg-violet-950 px-2 py-0.5 text-[10px] font-semibold text-violet-200 hover:border-violet-300 cursor-pointer"
                  >
                    <Link2 className="h-2.5 w-2.5" />
                    Wire
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-purple-300">
                  <span>
                    {cand.suggestedType.toUpperCase()} · {cand.mechanism}
                    {cand.pearsonR !== undefined ? ` (r=${cand.pearsonR.toFixed(2)})` : ""}
                    {cand.fdrQValue !== undefined ? ` · q=${cand.fdrQValue.toFixed(3)}` : ""}
                  </span>
                  {cand.isSecularDriftOnly && (
                    <span className="rounded-sm border border-amber-400 bg-amber-950 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">
                      Shared secular drift
                    </span>
                  )}
                  {cand.microscopeCouplingProb !== undefined && (
                    <span
                      className={`rounded-sm border px-1.5 py-0.5 text-[9px] font-semibold ${
                        (cand.confounderProb ?? 0) >= 0.55
                          ? "border-amber-400 bg-amber-950 text-amber-300"
                          : "border-emerald-400 bg-emerald-950 text-emerald-300"
                      }`}
                    >
                      {(cand.confounderProb ?? 0) >= 0.55
                        ? `Illusion Risk ${Math.round((cand.confounderProb ?? 0) * 100)}%`
                        : `Microscope ${Math.round(cand.microscopeCouplingProb * 100)}%`}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
