"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  History,
  Link2,
  Pencil,
  Route,
  Sparkles,
  Unlink,
  Waypoints,
} from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { formatEdgeRelationLabel, resolveEtgEdgeColor } from "@/lib/graph/graphVisuals";
import {
  formatMicroscopeLinkSummary,
  formatMicroscopeNodeSummary,
  humanizeNodeText,
} from "@/lib/plainLanguage";

function formatEdgeAriaTarget(name: string): string {
  return humanizeNodeText(name).replace(/</g, "under ");
}
import type {
  CandidateLinkSuggestion,
  CausalPathSummary,
  ETGEdge,
  ETGNode,
  ETGRelationshipType,
  LinkTrendMicroscopeCue,
  NodeTrendMicroscopeCue,
  TrendMicroscopeRadarBadge,
  TrendMicroscopeScanResult,
} from "@/types/etg";

const GOVERNANCE_PROVENANCE_TYPES = new Set<ETGRelationshipType>([
  "monitors",
  "verified_by",
  "supports",
  "corroborates",
  "contradicts",
  "supersedes",
]);

const PROPAGABLE_PHYSICAL_TYPES = new Set<ETGRelationshipType>([
  "leads",
  "amplifies",
  "drives_opposite",
  "correlates_with",
  "dampens",
]);

function resolveSignedStepTransfer(edge: ETGEdge): number {
  const rawStat =
    edge.properties.multivariate_partial_r ??
    edge.properties.detrended_r ??
    edge.properties.correlation_r;
  const mag = Math.min(0.95, Math.abs(rawStat ?? edge.properties.weight ?? 0.5));
  if (edge.type === "drives_opposite" || edge.type === "dampens") {
    return -mag;
  }
  if (typeof rawStat === "number" && Number.isFinite(rawStat) && rawStat < 0) {
    return -mag;
  }
  return mag;
}

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
  CONTESTED: {
    label: "Contested",
    cls: "border-orange-400 bg-orange-950 text-orange-300",
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
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-inset px-2 py-1.5"
            >
              <button
                type="button"
                onClick={() => onSelectNode(node)}
                className="min-w-0 flex-1 text-left cursor-pointer group"
              >
                <div className="ws-numeric truncate font-medium text-text-primary group-hover:text-accent-fg">
                  {isIncoming ? node.properties.name : `→ ${node.properties.name}`}
                </div>
                <div className="ws-numeric flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-muted">
                  <span style={{ color: resolveEtgEdgeColor(edge.type) }}>
                    {formatEdgeRelationLabel(edge.type, edge.properties.custom_label)}
                  </span>
                  {typeof edge.properties.optimal_lag_steps === "number" &&
                    edge.properties.optimal_lag_steps > 0 && (
                      <span>
                        · Δt={edge.properties.optimal_lag_steps} {edge.properties.lag_unit ?? "steps"}
                      </span>
                    )}
                  {typeof edge.properties.correlation_r === "number" && (
                    <span>· r={edge.properties.correlation_r.toFixed(2)}</span>
                  )}
                  {typeof edge.properties.multivariate_partial_r === "number" && (
                    <span>· mv_r={edge.properties.multivariate_partial_r.toFixed(2)}</span>
                  )}
                  {typeof edge.properties.fdr_q_value === "number" && (
                    <span>· q={edge.properties.fdr_q_value.toFixed(3)}</span>
                  )}
                  {typeof edge.properties.predictive_lift_pct === "number" &&
                    Number.isFinite(edge.properties.predictive_lift_pct) && (
                      <span
                        className={
                          edge.properties.predictive_lift_pct > 0
                            ? "text-emerald-300"
                            : "text-rose-300"
                        }
                      >
                        · Lift {edge.properties.predictive_lift_pct >= 0 ? "+" : ""}
                        {edge.properties.predictive_lift_pct.toFixed(1)}%
                      </span>
                    )}
                </div>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => onSelectEdge(edge)}
                  title={isIncoming ? "Edit connection" : undefined}
                  aria-label={`Edit edge ${isIncoming ? "from" : "to"} ${formatEdgeAriaTarget(node.properties.name)}`}
                  className="rounded p-1 text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteEdge(edge.properties.uuid)}
                  title={isIncoming ? "Unlink" : undefined}
                  aria-label={`Unlink ${formatEdgeAriaTarget(node.properties.name)}`}
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
  onHighlightCascadeEdges?: (edgeUuids: string[]) => void;
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
  onHighlightCascadeEdges,
  onSnapshotChange,
  onSetLocalError,
  onSetLocalStatus,
}: WorkbenchTraverseTabProps) {
  const [wiringMicroscopeKey, setWiringMicroscopeKey] = useState<string | null>(null);
  const [quickWireTargetUuid, setQuickWireTargetUuid] = useState("");
  const [pathTargetUuid, setPathTargetUuid] = useState("");
  const [pathTracing, setPathTracing] = useState(false);
  const [pathTraceRan, setPathTraceRan] = useState(false);
  const [pathTraceError, setPathTraceError] = useState<string | null>(null);
  const [tracedPaths, setTracedPaths] = useState<CausalPathSummary[]>([]);
  const [highlightedPathIdx, setHighlightedPathIdx] = useState<number | null>(null);

  useEffect(() => {
    setPathTargetUuid("");
    setTracedPaths([]);
    setPathTraceRan(false);
    setPathTraceError(null);
    setHighlightedPathIdx(null);
  }, [selectedNode.uuid]);

  const physicalIncomingLinks = useMemo(
    () => incomingLinks.filter(({ edge }) => !GOVERNANCE_PROVENANCE_TYPES.has(edge.type)),
    [incomingLinks]
  );

  const physicalOutgoingLinks = useMemo(
    () => outgoingLinks.filter(({ edge }) => !GOVERNANCE_PROVENANCE_TYPES.has(edge.type)),
    [outgoingLinks]
  );

  const governanceLinks = useMemo(
    () => [
      ...incomingLinks
        .filter(({ edge }) => GOVERNANCE_PROVENANCE_TYPES.has(edge.type))
        .map((item) => ({ ...item, dir: "incoming" as const })),
      ...outgoingLinks
        .filter(({ edge }) => GOVERNANCE_PROVENANCE_TYPES.has(edge.type))
        .map((item) => ({ ...item, dir: "outgoing" as const })),
    ],
    [incomingLinks, outgoingLinks]
  );

  const physicalPathTargetOptions = useMemo(() => {
    const rank = (n: ETGNode) => (n.label === "Insight" ? 0 : n.label === "Signal" ? 1 : 2);
    return allNodes
      .filter(
        (n) =>
          n.uuid !== selectedNode.uuid &&
          n.properties.status !== "Superseded" &&
          (n.label === "Insight" || n.label === "Signal")
      )
      .sort((a, b) => rank(a) - rank(b) || a.properties.name.localeCompare(b.properties.name));
  }, [allNodes, selectedNode.uuid]);

  const downstreamPerturbations = useMemo(() => {
    const activeEdges = allEdges.filter(
      (e) =>
        PROPAGABLE_PHYSICAL_TYPES.has(e.type) &&
        !e.properties.superseded_at &&
        nodeById.get(e.target_uuid)?.properties.status !== "Superseded"
    );
    const outgoingBySource = new Map<string, ETGEdge[]>();
    for (const e of activeEdges) {
      const list = outgoingBySource.get(e.source_uuid) ?? [];
      list.push(e);
      outgoingBySource.set(e.source_uuid, list);
    }

    const bestByTarget = new Map<
      string,
      {
        node: ETGNode;
        effectZ: number;
        hops: number;
        lagSteps: number;
        lagUnit: string;
        viaName?: string;
      }
    >();

    const firstHopEdges = outgoingBySource.get(selectedNode.uuid) ?? [];
    for (const e1 of firstHopEdges) {
      const n1 = nodeById.get(e1.target_uuid);
      if (!n1 || n1.uuid === selectedNode.uuid) continue;
      const g1 = resolveSignedStepTransfer(e1);
      const l1 = e1.properties.optimal_lag_steps ?? 0;
      const prev1 = bestByTarget.get(n1.uuid);
      if (!prev1 || Math.abs(g1) > Math.abs(prev1.effectZ)) {
        bestByTarget.set(n1.uuid, {
          node: n1,
          effectZ: g1,
          hops: 1,
          lagSteps: l1,
          lagUnit: e1.properties.lag_unit ?? "steps",
        });
      }

      const secondHopEdges = outgoingBySource.get(n1.uuid) ?? [];
      for (const e2 of secondHopEdges) {
        const n2 = nodeById.get(e2.target_uuid);
        if (!n2 || n2.uuid === selectedNode.uuid || n2.uuid === n1.uuid) continue;
        const g2 = g1 * resolveSignedStepTransfer(e2);
        const l2 = l1 + (e2.properties.optimal_lag_steps ?? 0);
        const prev2 = bestByTarget.get(n2.uuid);
        if (!prev2 || Math.abs(g2) > Math.abs(prev2.effectZ)) {
          bestByTarget.set(n2.uuid, {
            node: n2,
            effectZ: g2,
            hops: 2,
            lagSteps: l2,
            lagUnit: e2.properties.lag_unit ?? e1.properties.lag_unit ?? "steps",
            viaName: n1.properties.name,
          });
        }
      }
    }

    return Array.from(bestByTarget.values())
      .sort((a, b) => Math.abs(b.effectZ) - Math.abs(a.effectZ))
      .slice(0, 6);
  }, [allEdges, nodeById, selectedNode.uuid]);

  const handleTraceScientificPaths = async () => {
    if (!pathTargetUuid || pathTargetUuid === selectedNode.uuid) return;
    setPathTracing(true);
    setPathTraceError(null);
    setPathTraceRan(false);
    setHighlightedPathIdx(null);
    try {
      const res = await fetch(
        `/api/graph/traverse?mode=paths&fromUuid=${encodeURIComponent(selectedNode.uuid)}&toUuid=${encodeURIComponent(pathTargetUuid)}&maxHops=4`
      );
      const data = (await res.json()) as { paths?: CausalPathSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error || "Path trace failed");
      const found = Array.isArray(data.paths) ? data.paths : [];
      setTracedPaths(found);
      setPathTraceRan(true);
      if (found.length > 0 && onHighlightCascadeEdges) {
        onHighlightCascadeEdges(found[0].edgeUuids);
        setHighlightedPathIdx(0);
      }
    } catch (err) {
      setPathTraceError(err instanceof Error ? err.message : "Failed to trace paths");
    } finally {
      setPathTracing(false);
    }
  };

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
          mechanism: formatMicroscopeLinkSummary(coupling),
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
    <div className="space-y-2.5 p-2.5">
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
            <div className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2">
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
                <p className="text-[11px] leading-snug text-text-muted">
                  {formatMicroscopeNodeSummary(microscopeCue)}
                </p>
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
                      <div className="ws-numeric font-mono text-[9.5px] text-text-muted">
                        De-trended r={ill.cleanPeakR.toFixed(2)} (raw r={ill.rawPeakR.toFixed(2)}) ·{" "}
                        {Math.round(ill.confounderProb * 100)}% confounder risk
                      </div>
                      <div className="text-[10px] leading-snug text-text-subtle">
                        {formatMicroscopeLinkSummary(ill)}
                      </div>
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
                    title={humanizeNodeText(crumb.name)}
                    className={`rounded-xs px-1.5 py-0.5 text-[10px] ${
                      isCurrent
                        ? "border border-accent-fg bg-amber-950 font-semibold text-amber-300"
                        : "bg-surface-inset text-text-muted hover:text-text-primary cursor-pointer"
                    }`}
                  >
                    <span className="block max-w-[9.5rem] truncate">
                      {humanizeNodeText(crumb.name)}
                    </span>
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
        links={physicalIncomingLinks}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onDeleteEdge={onDeleteEdge}
      />

      <NeighborLinkList
        direction="outgoing"
        links={physicalOutgoingLinks}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onDeleteEdge={onDeleteEdge}
      />

      {governanceLinks.length > 0 && (
        <details className="rounded-md border border-border bg-surface-inset p-2">
          <summary className="cursor-pointer select-none text-[11px] font-semibold text-text-muted">
            Observational Corroboration &amp; Governance ({governanceLinks.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {governanceLinks.map(({ edge, node, dir }) => (
              <div
                key={edge.properties.uuid}
                className="flex items-center justify-between gap-2 rounded-sm border border-border/80 bg-surface px-2 py-1"
              >
                <button
                  type="button"
                  onClick={() => onSelectNode(node)}
                  className="min-w-0 flex-1 text-left cursor-pointer group"
                >
                  <div className="ws-numeric truncate text-[11px] font-medium text-text-primary group-hover:text-accent-fg">
                    {dir === "incoming" ? `← ${node.properties.name}` : `→ ${node.properties.name}`}
                  </div>
                  <div className="ws-numeric flex flex-wrap items-center gap-x-2 text-[10px] text-text-muted">
                    <span style={{ color: resolveEtgEdgeColor(edge.type) }}>
                      {formatEdgeRelationLabel(edge.type, edge.properties.custom_label)}
                    </span>
                    {typeof edge.properties.correlation_r === "number" && (
                      <span>· r={edge.properties.correlation_r.toFixed(2)}</span>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onSelectEdge(edge)}
                    aria-label={`Edit edge ${dir === "incoming" ? "from" : "to"} ${formatEdgeAriaTarget(node.properties.name)}`}
                    className="rounded p-1 text-text-muted hover:text-text-primary cursor-pointer"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDeleteEdge(edge.properties.uuid)}
                    aria-label={`Unlink ${formatEdgeAriaTarget(node.properties.name)}`}
                    className="rounded p-1 text-text-muted hover:text-rose-400 cursor-pointer"
                  >
                    <Unlink className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Multi-Hop Scientific Path Tracer */}
      {physicalPathTargetOptions.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="ws-eyebrow flex items-center gap-1 text-sky-400">
              <Route className="h-3 w-3" />
              Multi-Hop Scientific Path Tracer
            </span>
            {onHighlightCascadeEdges && (highlightedPathIdx !== null || tracedPaths.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  onHighlightCascadeEdges([]);
                  setHighlightedPathIdx(null);
                }}
                className="rounded-xs border border-border bg-surface px-1.5 py-0.5 text-[9.5px] font-medium text-text-muted hover:text-text-primary cursor-pointer"
              >
                Clear Highlight
              </button>
            )}
          </div>
          <div className="flex gap-1.5">
            <label htmlFor={`${baseId}-path-target`} className="sr-only">
              Target phenomenon node for multi-hop path trace
            </label>
            <select
              id={`${baseId}-path-target`}
              value={pathTargetUuid}
              onChange={(e) => setPathTargetUuid(e.target.value)}
              className="form-input flex-1 text-[11px]"
            >
              <option value="">Trace mechanism to node…</option>
              {physicalPathTargetOptions.map((n) => (
                <option key={n.uuid} value={n.uuid}>
                  [{n.label}] {n.properties.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!pathTargetUuid || pathTracing}
              onClick={() => void handleTraceScientificPaths()}
              className="rounded-sm border border-sky-400 bg-sky-950 px-2.5 py-1 text-[10.5px] font-semibold text-sky-300 hover:border-sky-300 disabled:opacity-45 cursor-pointer"
            >
              {pathTracing ? "Tracing…" : "Trace Path"}
            </button>
          </div>
          {pathTraceError && (
            <div className="rounded-xs border border-rose-400/60 bg-rose-950/60 px-2 py-1 text-[10px] text-rose-300">
              {pathTraceError}
            </div>
          )}
          {pathTraceRan && tracedPaths.length === 0 && !pathTraceError && (
            <div className="rounded-xs border border-dashed border-border px-2 py-1 text-[10px] text-text-subtle">
              No hub-free physical path found within 4 hops between these endpoints.
            </div>
          )}
          {tracedPaths.length > 0 && (
            <div className="space-y-1.5 pt-1">
              {tracedPaths.slice(0, 3).map((path, idx) => {
                const negCount = (path.edgeTypes ?? []).filter(
                  (t) => t === "drives_opposite" || t === "dampens"
                ).length;
                const isOpposite = negCount % 2 === 1;
                const isHighlighted = highlightedPathIdx === idx;
                return (
                  <div
                    key={`${path.edgeUuids.join(",")}-${idx}`}
                    className={`rounded-sm border px-2 py-1.5 space-y-1 ${
                      isHighlighted
                        ? "border-sky-400 bg-sky-950/40"
                        : "border-border/80 bg-surface"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1 text-[10px]">
                      <div className="flex items-center gap-1.5 font-mono ws-numeric">
                        <span
                          className={`rounded-xs border px-1 py-0.5 text-[9px] font-bold ${
                            isOpposite
                              ? "border-rose-400 bg-rose-950 text-rose-300"
                              : "border-emerald-400 bg-emerald-950 text-emerald-300"
                          }`}
                        >
                          {isOpposite ? "OPPOSITE" : "IN-PHASE"}
                        </span>
                        <span className="text-text-muted">
                          {path.edgeUuids.length} hop{path.edgeUuids.length === 1 ? "" : "s"}
                        </span>
                        <span className="text-text-subtle">· ΣΔt={path.cumulativeLagSteps}</span>
                        {typeof path.meanAbsR === "number" && (
                          <span className="text-text-subtle">
                            · |r̄|={path.meanAbsR.toFixed(2)}
                          </span>
                        )}
                      </div>
                      {onHighlightCascadeEdges && (
                        <button
                          type="button"
                          onClick={() => {
                            if (isHighlighted) {
                              onHighlightCascadeEdges([]);
                              setHighlightedPathIdx(null);
                            } else {
                              onHighlightCascadeEdges(path.edgeUuids);
                              setHighlightedPathIdx(idx);
                            }
                          }}
                          className="rounded-xs border border-sky-400/70 bg-sky-950/70 px-1.5 py-0.5 text-[9.5px] font-semibold text-sky-300 hover:border-sky-300 cursor-pointer"
                        >
                          {isHighlighted ? "Highlighted" : "Highlight on Canvas"}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1 text-[10px] text-text-primary">
                      {path.nodeUuids.map((uid, nIdx) => {
                        const n = nodeById.get(uid);
                        return (
                          <React.Fragment key={`${uid}-${nIdx}`}>
                            {n ? (
                              <button
                                type="button"
                                onClick={() => onSelectNode(n)}
                                className="max-w-[9rem] truncate underline decoration-border hover:text-accent-fg cursor-pointer text-left"
                              >
                                {n.properties.name}
                              </button>
                            ) : (
                              <span className="truncate">{uid}</span>
                            )}
                            {nIdx < path.nodeUuids.length - 1 && (
                              <span className="text-text-subtle font-mono text-[9px]">
                                →[{path.edgeTypes?.[nIdx] ?? "link"}]→
                              </span>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Downstream +1sigma Perturbation Preview */}
      {downstreamPerturbations.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2">
          <div className="ws-eyebrow flex items-center gap-1 text-amber-400">
            <Activity className="h-3 w-3" />
            Downstream +1σ Perturbation Preview
          </div>
          <div className="space-y-1">
            {downstreamPerturbations.map((item) => {
              const positive = item.effectZ >= 0;
              return (
                <div
                  key={item.node.uuid}
                  className="flex items-center justify-between gap-2 rounded-sm border border-border/70 bg-surface px-2 py-1 text-[10.5px]"
                >
                  <button
                    type="button"
                    onClick={() => onSelectNode(item.node)}
                    className="min-w-0 flex-1 text-left cursor-pointer group"
                  >
                    <div className="truncate font-medium text-text-primary group-hover:text-accent-fg">
                      {item.node.properties.name}
                    </div>
                    <div className="ws-numeric truncate font-mono text-[9.5px] text-text-subtle">
                      {item.hops}-hop · Δt={item.lagSteps} {item.lagUnit}
                      {item.viaName ? ` · via ${item.viaName}` : ""}
                    </div>
                  </button>
                  <span
                    className={`shrink-0 rounded-xs border px-1.5 py-0.5 font-mono ws-numeric text-[10px] font-semibold ${
                      positive
                        ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                        : "border-rose-400 bg-rose-950 text-rose-300"
                    }`}
                  >
                    {positive ? "+" : ""}
                    {item.effectZ.toFixed(2)}σ
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Quick Inline Wire */}
      {allNodes.length > 1 && (
        <div className="space-y-1 border-t border-border pt-2">
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
        <div className="space-y-1.5 border-t border-border pt-2">
          <div className="ws-eyebrow flex items-center gap-1 text-purple-300">
            <Sparkles className="h-3 w-3" />
            Latent Connection Suggestions ({nodeCandidates.length})
          </div>
          <div className="space-y-1.5">
            {nodeCandidates.slice(0, 5).map((cand) => (
              <div
                key={cand.id}
                className="rounded-md border border-purple-400 bg-purple-950 p-2 space-y-1"
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
