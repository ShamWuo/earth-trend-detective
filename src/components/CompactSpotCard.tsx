"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  FlaskConical,
  GitBranch,
  GitCompare,
  MapPin,
  PlusCircle,
  Radio,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import {
  buildExternalExplorerLinks,
  DATASET_BY_ID,
  EARTH_TREND_DATASETS,
} from "@/lib/datasets";
import {
  describeComparisonPlainly,
  describeGeographicZone,
  describeTrendPlainly,
  findNearbyFilteredNodes,
  formatCoordShort,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  TrendAnalysisSummary,
} from "@/types/etg";

interface CompactSpotCardProps {
  selectedNode: ETGNode | null;
  selectedEdge: ETGEdge | null;
  sourceNode: ETGNode | null;
  targetNode: ETGNode | null;
  allNodes: ETGNode[];
  allEdges: ETGEdge[];
  visibleNodes: ETGNode[];
  probedCoord: { lat: number; lng: number } | null;
  primary: TrendAnalysisSummary | null;
  secondary: TrendAnalysisSummary | null;
  summaries: TrendAnalysisSummary[];
  focusedSummaryDataset: ETGDatasetId | null;
  comparison: CrossRegionComparison | null;
  compareMode: boolean;
  activeTopics: ETGDatasetId[];
  loading: boolean;
  error: string | null;
  onToggleTopic: (ds: ETGDatasetId) => void;
  onResetTopics: () => void;
  onFocusSummaryDataset: (ds: ETGDatasetId) => void;
  onSelectNode: (node: ETGNode) => void;
  onCompareOpposite: (nodeA: ETGNode, nodeB: ETGNode) => void;
  onToggleCompareMode: () => void;
  onSwapPins: () => void;
  onClearComparison: () => void;
  onCommitToGraph: (summary: TrendAnalysisSummary) => Promise<void>;
  onCommitRelation: (payload: {
    primary: TrendAnalysisSummary;
    secondary: TrendAnalysisSummary;
    comparison: CrossRegionComparison;
    sourceNodeUuid?: string;
    targetNodeUuid?: string;
  }) => Promise<void>;
  onGraphUpdated: () => Promise<void>;
  onClose: () => void;
}

function MiniSparkline({
  points,
  color,
  width = 56,
  height = 18,
}: {
  points: TrendAnalysisSummary["points"];
  color: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const span = Math.max(1e-6, max - min);
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const d = points
    .map((p, idx) => {
      const x = pad + (idx / Math.max(1, points.length - 1)) * innerW;
      const y = pad + innerH - ((p.value - min) / span) * innerH;
      return `${idx === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpotTrendChart({
  summary,
  comparison,
  labelA,
  labelB,
}: {
  summary: TrendAnalysisSummary | null;
  comparison: CrossRegionComparison | null;
  labelA: string;
  labelB: string;
}) {
  const chartDescId = useId();
  const showOverlay = Boolean(comparison && comparison.alignedPoints.length >= 3);
  const w = 320;
  const h = 132;
  const padX = 16;
  const padY = 14;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;

  if (showOverlay && comparison) {
    const pts = comparison.alignedPoints;
    const allZ = pts.flatMap((p) => [p.zA, p.zB]);
    const minY = Math.min(-2, ...allZ);
    const maxY = Math.max(2, ...allZ);
    const span = Math.max(1e-6, maxY - minY);
    const xAt = (i: number) => padX + (i / Math.max(1, pts.length - 1)) * plotW;
    const yAt = (v: number) => padY + plotH - ((v - minY) / span) * plotH;

    const pathA = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zA).toFixed(1)}`)
      .join(" ");
    const pathB = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zB).toFixed(1)}`)
      .join(" ");

    return (
      <div className="ws-inset space-y-2 rounded-xl p-3">
        <div className="flex items-center justify-between text-[11px] text-text-subtle">
          <span className="font-medium text-text-primary">How the two spots move over time</span>
          <span className="ws-numeric">
            {pts[0]?.date}–{pts[pts.length - 1]?.date}
          </span>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="h-[118px] w-full" aria-describedby={chartDescId}>
          <line
            x1={padX}
            y1={yAt(0)}
            x2={w - padX}
            y2={yAt(0)}
            stroke="var(--border-strong)"
            strokeDasharray="3 3"
          />
          <path d={pathA} fill="none" stroke="#facc15" strokeWidth={2} strokeLinecap="round" />
          <path d={pathB} fill="none" stroke="#38bdf8" strokeWidth={2} strokeLinecap="round" />
        </svg>
        <p id={chartDescId} className="sr-only">
          Comparison chart showing normalized changes over time for {labelA} and {labelB}.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
            <span className="truncate max-w-[120px]">{labelA}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-sky-400" aria-hidden="true" />
            <span className="truncate max-w-[120px]">{labelB}</span>
          </span>
        </div>
      </div>
    );
  }

  if (!summary || summary.points.length < 2) return null;

  const pts = summary.points;
  const minY = Math.min(...pts.map((p) => Math.min(p.value, p.theilSenFit)));
  const maxY = Math.max(...pts.map((p) => Math.max(p.value, p.theilSenFit)));
  const span = Math.max(1e-6, maxY - minY);
  const xAt = (i: number) => padX + (i / Math.max(1, pts.length - 1)) * plotW;
  const yAt = (v: number) => padY + plotH - ((v - minY) / span) * plotH;

  const rawPath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.value).toFixed(1)}`)
    .join(" ");
  const trendPath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.theilSenFit).toFixed(1)}`)
    .join(" ");

  const dsMeta = DATASET_BY_ID[summary.dataset];
  const lineColor = dsMeta?.color ?? "#e2a856";
  const digest = describeTrendPlainly(summary);

  return (
    <div className="ws-inset space-y-2 rounded-xl p-3">
      <div className="flex items-center justify-between text-[11px] text-text-subtle">
        <span className="font-medium text-text-primary">{digest.topicLabel} history</span>
        <span className="ws-numeric">
          {pts[0]?.date}–{pts[pts.length - 1]?.date}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[118px] w-full" aria-describedby={chartDescId}>
        <path d={rawPath} fill="none" stroke={lineColor} strokeWidth={2} strokeLinecap="round" />
        <path
          d={trendPath}
          fill="none"
          stroke="var(--text-primary)"
          strokeOpacity={0.75}
          strokeDasharray="4 4"
          strokeWidth={1.6}
        />
      </svg>
      <p id={chartDescId} className="sr-only">
        {digest.topicLabel} yearly values from {pts[0]?.date} to {pts[pts.length - 1]?.date} showing{" "}
        {digest.headline}.
      </p>
      <div className="flex items-center justify-between text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ backgroundColor: lineColor }}
            aria-hidden="true"
          />
          <span>Yearly average ({summary.unit})</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-3 border-t border-dashed border-text-primary/80"
            aria-hidden="true"
          />
          <span>Long-term trend</span>
        </span>
      </div>
    </div>
  );
}

export function CompactSpotCard({
  selectedNode,
  selectedEdge,
  sourceNode,
  targetNode,
  allNodes,
  allEdges,
  visibleNodes,
  probedCoord,
  primary,
  secondary,
  summaries,
  focusedSummaryDataset,
  comparison,
  compareMode,
  activeTopics,
  loading,
  error,
  onToggleTopic,
  onResetTopics,
  onFocusSummaryDataset,
  onSelectNode,
  onCompareOpposite,
  onToggleCompareMode,
  onSwapPins,
  onClearComparison,
  onCommitToGraph,
  onCommitRelation,
  onGraphUpdated,
  onClose,
}: CompactSpotCardProps) {
  const [showChart, setShowChart] = useState(false);
  const [showLinked, setShowLinked] = useState(false);
  const [showScience, setShowScience] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Hypothesis revision state (inside Science & sources)
  const [showReviseForm, setShowReviseForm] = useState(false);
  const [revName, setRevName] = useState("");
  const [revDesc, setRevDesc] = useState("");
  const [revRationale, setRevRationale] = useState("");

  const selectionKey =
    selectedEdge?.properties.uuid ??
    selectedNode?.uuid ??
    (probedCoord ? `${probedCoord.lat.toFixed(2)}:${probedCoord.lng.toFixed(2)}` : "empty");

  // Reset opt-in sections to collapsed whenever a different spot/node/link is opened
  useEffect(() => {
    setShowChart(false);
    setShowLinked(false);
    setShowScience(false);
    setActionMsg(null);
    setShowReviseForm(false);
  }, [selectionKey]);

  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.uuid, n])), [allNodes]);

  const coord = useMemo(() => {
    if (probedCoord) return probedCoord;
    if (
      selectedNode &&
      typeof selectedNode.properties.lat === "number" &&
      typeof selectedNode.properties.lng === "number"
    ) {
      return { lat: selectedNode.properties.lat, lng: selectedNode.properties.lng };
    }
    if (primary) return { lat: primary.lat, lng: primary.lng };
    return null;
  }, [probedCoord, selectedNode, primary]);

  // Nearby matching pins within 950 km filtered by the user's active topic filters & timeline
  const nearbyMatching = useMemo(() => {
    if (!coord) return [];
    const candidates = visibleNodes.filter((n) => n.uuid !== selectedNode?.uuid);
    return findNearbyFilteredNodes(coord.lat, coord.lng, candidates, 950, 3);
  }, [coord, visibleNodes, selectedNode]);

  // Filter multi-topic coordinate summaries strictly to active filters
  const visibleSummaries = useMemo(() => {
    if (activeTopics.length === 0) return summaries;
    return summaries.filter((s) => activeTopics.includes(s.dataset));
  }, [summaries, activeTopics]);

  const activeSummary = useMemo(() => {
    if (selectedNode && primary) return primary;
    if (comparison && primary) return primary;
    if (visibleSummaries.length === 0) {
      // Only show fallback primary when active filter allows it or a pin wasn't strictly empty local sensor
      return activeTopics.length === 1 && activeTopics[0] === "community" ? null : primary;
    }
    if (focusedSummaryDataset) {
      const hit = visibleSummaries.find((s) => s.dataset === focusedSummaryDataset);
      if (hit) return hit;
    }
    return visibleSummaries[0];
  }, [selectedNode, primary, comparison, visibleSummaries, activeTopics, focusedSummaryDataset]);

  // Linked trend pairs related to the selected pin or closest pin within 350 km
  const anchorNode = useMemo(() => {
    if (selectedNode) return selectedNode;
    if (nearbyMatching[0] && nearbyMatching[0].distanceKm <= 350) {
      return nearbyMatching[0].node;
    }
    return null;
  }, [selectedNode, nearbyMatching]);

  const linkedPairs = useMemo(() => {
    if (!anchorNode) return [];
    return allEdges
      .filter(
        (e) =>
          (e.type === "drives_opposite" ||
            e.type === "correlates_with" ||
            e.type === "teleconnects") &&
          (e.source_uuid === anchorNode.uuid || e.target_uuid === anchorNode.uuid)
      )
      .map((edge) => {
        const peerId =
          edge.source_uuid === anchorNode.uuid ? edge.target_uuid : edge.source_uuid;
        const peer = nodeMap.get(peerId);
        return peer ? { edge, peer } : null;
      })
      .filter((item): item is { edge: ETGEdge; peer: ETGNode } => item !== null)
      .slice(0, 4);
  }, [anchorNode, allEdges, nodeMap]);

  // Corroboration & belief revision details for Science & sources drawer
  const supportingEdges = useMemo(() => {
    if (!selectedNode) return [];
    return allEdges.filter(
      (e) =>
        e.target_uuid === selectedNode.uuid &&
        (e.type === "supports" || e.type === "corroborates")
    );
  }, [selectedNode, allEdges]);

  const beliefChain = useMemo(() => {
    if (!selectedNode) return [];
    let head = selectedNode.uuid;
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
  }, [selectedNode, allEdges, nodeMap]);

  // Header title & labels
  const isComparingTwoSpots = Boolean(comparison && primary && secondary);
  const labelA =
    (sourceNode?.properties.region && !sourceNode.properties.region.includes("°")
      ? sourceNode.properties.region
      : sourceNode ? humanizeNodeText(sourceNode.properties.name) : null) ||
    (primary ? describeGeographicZone(primary.lat, primary.lng, nearbyMatching[0]?.node) : "Spot A");
  const labelB =
    (targetNode?.properties.region && !targetNode.properties.region.includes("°")
      ? targetNode.properties.region
      : targetNode ? humanizeNodeText(targetNode.properties.name) : null) ||
    (secondary ? describeGeographicZone(secondary.lat, secondary.lng, null) : "Spot B");

  const cardTitle = isComparingTwoSpots
    ? `${labelA} ↔ ${labelB}`
    : selectedNode
      ? humanizeNodeText(selectedNode.properties.name)
      : coord
        ? describeGeographicZone(coord.lat, coord.lng, nearbyMatching[0]?.node)
        : "Selected Spot";

  const activeDigest = activeSummary ? describeTrendPlainly(activeSummary) : null;
  const comparisonDigest =
    comparison && primary && secondary
      ? describeComparisonPlainly(comparison, labelA, labelB)
      : null;

  const onlyCommunityFilterAtEmptySpot =
    !selectedNode &&
    !isComparingTwoSpots &&
    activeTopics.length === 1 &&
    activeTopics[0] === "community" &&
    nearbyMatching.length === 0;

  const handleSaveToGraph = async () => {
    setCommitting(true);
    setActionMsg(null);
    try {
      if (isComparingTwoSpots && primary && secondary && comparison) {
        await onCommitRelation({
          primary,
          secondary,
          comparison,
          sourceNodeUuid: sourceNode?.uuid,
          targetNodeUuid: targetNode?.uuid,
        });
        setActionMsg("Saved linked places to the Knowledge Graph.");
      } else if (activeSummary) {
        await onCommitToGraph(activeSummary);
        setActionMsg("Saved spot to the Knowledge Graph.");
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleVerifyGate = async () => {
    if (!selectedNode) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", nodeUuid: selectedNode.uuid }),
      });
      const data = await res.json();
      setActionMsg(
        data.audit?.corroborated
          ? "Confirmed by multiple independent sources."
          : `Needs ≥2 independent sources (${data.audit?.supportingSources?.length ?? 0} so far).`
      );
      await onGraphUpdated();
    } finally {
      setCommitting(false);
    }
  };

  const handleSimulateWebhook = async () => {
    if (!selectedNode || selectedNode.properties.lat === undefined || selectedNode.properties.lng === undefined) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch(
        `/api/graph/nodes/${encodeURIComponent(selectedNode.uuid)}/webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id: selectedNode.properties.device_id || `edge-sensor-${selectedNode.uuid.slice(0, 6)}`,
            producer_type: "iot_sensor",
            dataset: selectedNode.properties.dataset || "community",
            lat: selectedNode.properties.lat,
            lng: selectedNode.properties.lng,
            value: selectedNode.properties.value,
            unit: selectedNode.properties.unit || "units",
            confidence: 0.93,
            title: `Local sensor check-in near ${humanizeNodeText(selectedNode.properties.name).slice(0, 28)}`,
          }),
        }
      );
      if (res.ok) {
        setActionMsg("Recorded local sensor check-in.");
        await onGraphUpdated();
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleReviseBelief = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !revName.trim() || !revDesc.trim() || !revRationale.trim()) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorNodeUuid: selectedNode.uuid,
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
        setActionMsg("Saved updated finding.");
        await onGraphUpdated();
        if (data.revisedNode) onSelectNode(data.revisedNode);
      }
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="flex max-h-[calc(100dvh-11.5rem)] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-2xl backdrop-blur-xl">
      {/* 1. Compact Header + Active Filter Strip */}
      <div className="shrink-0 space-y-2 border-b border-border px-4 pt-3.5 pb-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-snug text-text-primary">
              {cardTitle}
            </h2>
            {coord && !isComparingTwoSpots && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-subtle">
                <MapPin className="h-3 w-3 shrink-0 text-accent-fg" aria-hidden="true" />
                <span className="ws-numeric font-mono">{formatCoordShort(coord.lat, coord.lng)}</span>
                {selectedNode?.properties.dataset && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {DATASET_BY_ID[selectedNode.properties.dataset]?.shortLabel ?? "Observation"}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close spot card"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Filter Chips Strip (user controls what shows here and on Earth) */}
        {!isComparingTwoSpots && (
          <div
            className="etg-chip-scroller"
            role="region"
            aria-label="Filter topics for this spot"
          >
            <button
              type="button"
              aria-pressed={activeTopics.length === 0}
              onClick={onResetTopics}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors cursor-pointer ${
                activeTopics.length === 0
                  ? "border-accent-fg/60 bg-accent/20 font-semibold text-text-primary"
                  : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
              }`}
            >
              All
            </button>
            {EARTH_TREND_DATASETS.map((ds) => {
              const active = activeTopics.includes(ds.id);
              return (
                <button
                  key={ds.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onToggleTopic(ds.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors cursor-pointer ${
                    active
                      ? "border-accent-fg/60 bg-accent/20 font-semibold text-text-primary"
                      : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                  }`}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: ds.color }}
                    aria-hidden="true"
                  />
                  <span>{ds.shortLabel}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Scrollable Compact Body */}
      <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 text-xs">
        {loading && (
          <div className="space-y-2 py-1" role="status" aria-label="Loading spot information">
            <div className="h-10 w-full animate-pulse rounded-xl bg-surface-elevated" />
            <div className="h-10 w-full animate-pulse rounded-xl bg-surface-elevated" />
          </div>
        )}

        {!loading && error && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-rose-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
            <span>Could not load live readings for this spot right now ({error}).</span>
          </div>
        )}

        {/* Compare Waiting Prompt */}
        {compareMode && !isComparingTwoSpots && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-3 py-2 text-cyan-100">
            <span>Click a second spot on Earth to compare how they change together.</span>
            <button
              type="button"
              onClick={onToggleCompareMode}
              className="shrink-0 font-semibold text-cyan-300 hover:underline cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Mode A: Comparing Two Spots / Linked Trend */}
        {!loading && isComparingTwoSpots && comparisonDigest && primary && secondary && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                  comparisonDigest.badgeLabel === "Opposite trends"
                    ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                    : comparisonDigest.badgeLabel === "Moving together"
                      ? "border-sky-500/40 bg-sky-500/15 text-sky-300"
                      : "border-border bg-surface-inset text-text-muted"
                }`}
              >
                {comparisonDigest.badgeLabel} · {comparisonDigest.strengthLabel}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onSwapPins}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-inset px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                  <span>Swap</span>
                </button>
                <button
                  type="button"
                  onClick={onClearComparison}
                  className="rounded-full border border-border bg-surface-inset px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
                >
                  1 spot
                </button>
              </div>
            </div>

            <p className="text-[13px] font-medium leading-snug text-text-primary">
              {comparisonDigest.headline}
            </p>
            <p className="leading-relaxed text-text-muted">
              {comparisonDigest.explanation} {comparisonDigest.timingNote}
            </p>

            <div className="grid grid-cols-2 gap-2">
              {[
                { id: "a", label: labelA, summary: primary, dot: "bg-amber-400" },
                { id: "b", label: labelB, summary: secondary, dot: "bg-sky-400" },
              ].map((side) => {
                const d = describeTrendPlainly(side.summary);
                return (
                  <div
                    key={side.id}
                    className="ws-inset rounded-xl p-2.5"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-primary">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${side.dot}`} aria-hidden="true" />
                      <span className="truncate">{side.label}</span>
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-text-secondary">
                      {d.headline}
                    </div>
                    <div className="ws-numeric mt-0.5 text-[11px] text-text-subtle">
                      {d.ratePerDecade}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Mode B: Empty Local Sensors Notice */}
        {!loading && onlyCommunityFilterAtEmptySpot && (
          <div className="rounded-xl border border-border bg-surface-inset p-3 text-text-muted">
            No local sensors recorded near this spot yet. Switch to{" "}
            <button
              type="button"
              onClick={onResetTopics}
              className="font-semibold text-accent-fg hover:underline cursor-pointer"
            >
              All topics
            </button>{" "}
            or pick another filter above.
          </div>
        )}

        {/* Mode C: Multi-Topic Digest on Coordinate Click */}
        {!loading &&
          !isComparingTwoSpots &&
          !selectedNode &&
          !onlyCommunityFilterAtEmptySpot &&
          visibleSummaries.length > 1 && (
            <div className="space-y-1.5">
              {visibleSummaries.map((item) => {
                const d = describeTrendPlainly(item);
                const meta = DATASET_BY_ID[item.dataset];
                const isFocused = activeSummary?.dataset === item.dataset;
                return (
                  <button
                    key={item.dataset}
                    type="button"
                    onClick={() => onFocusSummaryDataset(item.dataset)}
                    className={`flex w-full items-center justify-between gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors cursor-pointer ${
                      isFocused
                        ? "border-accent-fg/45 bg-surface-elevated"
                        : "border-border bg-surface-inset hover:border-border-strong"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: meta?.color ?? "#e2a856" }}
                          aria-hidden="true"
                        />
                        <span className="font-medium text-text-subtle">{d.topicLabel}</span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                            d.isSignificant
                              ? d.tone === "rising"
                                ? "bg-rose-500/15 text-rose-300"
                                : "bg-sky-500/15 text-sky-300"
                              : "bg-surface-band text-text-subtle"
                          }`}
                        >
                          {d.certaintyLabel}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                        <span className="font-semibold text-text-primary">{d.headline}</span>
                        <span className="ws-numeric shrink-0 whitespace-nowrap text-[11px] text-text-muted">
                          · {d.ratePerDecade}
                        </span>
                      </div>
                    </div>

                    <MiniSparkline
                      points={item.points}
                      color={meta?.color ?? "#e2a856"}
                    />
                  </button>
                );
              })}

              {activeDigest && (
                <p className="px-0.5 pt-0.5 text-[11px] leading-relaxed text-text-muted">
                  <strong className="font-semibold text-text-primary">
                    {activeDigest.topicLabel}:
                  </strong>{" "}
                  {activeDigest.summarySentence}
                </p>
              )}
            </div>
          )}

        {/* Mode D: Single Topic or Selected Pin */}
        {!loading &&
          !isComparingTwoSpots &&
          !onlyCommunityFilterAtEmptySpot &&
          (selectedNode || visibleSummaries.length <= 1) && (
            <div className="space-y-2.5">
              {activeDigest && activeSummary && (
                <div
                  className={`rounded-xl border p-3 ${
                    activeDigest.isSignificant
                      ? activeDigest.tone === "rising"
                        ? "border-rose-500/30 bg-rose-500/8"
                        : "border-sky-500/30 bg-sky-500/8"
                      : "border-border bg-surface-inset"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {activeDigest.isSignificant ? (
                          activeDigest.tone === "rising" ? (
                            <TrendingUp className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                          ) : (
                            <TrendingDown className="h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
                          )
                        ) : (
                          <Activity className="h-4 w-4 shrink-0 text-text-subtle" aria-hidden="true" />
                        )}
                        <span className="text-[13px] font-semibold text-text-primary">
                          {activeDigest.headline}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="ws-numeric font-medium text-text-secondary">
                          {activeDigest.ratePerDecade}
                        </span>
                        <span aria-hidden="true" className="text-text-faint">·</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            activeDigest.isSignificant
                              ? "bg-surface-elevated text-text-primary"
                              : "bg-surface-band text-text-subtle"
                          }`}
                        >
                          {activeDigest.certaintyLabel}
                        </span>
                      </div>
                    </div>

                    <MiniSparkline
                      points={activeSummary.points}
                      color={DATASET_BY_ID[activeSummary.dataset]?.color ?? "#e2a856"}
                      width={68}
                      height={24}
                    />
                  </div>

                  <p className="mt-2 leading-relaxed text-text-muted">
                    {activeDigest.summarySentence}
                  </p>
                </div>
              )}

              {selectedNode && (
                <div className="space-y-1.5 px-0.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span
                      className={`rounded-full border px-2 py-0.5 font-medium ${
                        selectedNode.properties.status === "Superseded"
                          ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
                          : selectedNode.is_provisional
                            ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
                            : "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                      }`}
                    >
                      {selectedNode.properties.status === "Superseded"
                        ? "Updated earlier finding"
                        : selectedNode.is_provisional
                          ? "Single-source reading"
                          : "Verified across sources"}
                    </span>
                  </div>
                  {!activeDigest && (
                    <p className="leading-relaxed text-text-muted">
                      {humanizeNodeText(selectedNode.properties.description)}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

        {/* Nearby Active Pins Matching Current Filters */}
        {!loading && nearbyMatching.length > 0 && !isComparingTwoSpots && (
          <div className="space-y-1.5 border-t border-border/70 pt-2.5">
            <div className="text-[11px] font-medium text-text-subtle">
              Nearby matching observations
            </div>
            <div className="space-y-1">
              {nearbyMatching.map(({ node, distanceKm }) => {
                const dsColor = node.properties.dataset
                  ? DATASET_BY_ID[node.properties.dataset]?.color ?? "#e2a856"
                  : "#e2a856";
                return (
                  <button
                    key={node.uuid}
                    type="button"
                    onClick={() => onSelectNode(node)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/80 bg-surface-inset px-2.5 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface-elevated cursor-pointer"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: dsColor }}
                        aria-hidden="true"
                      />
                      <span className="truncate font-medium text-text-primary">
                        {humanizeNodeText(node.properties.name)}
                      </span>
                    </span>
                    <span className="ws-numeric shrink-0 text-[11px] text-text-subtle">
                      {distanceKm} km
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Opt-in Section 1: Chart ── */}
        {showChart && (
          <div className="border-t border-border/70 pt-2.5">
            <SpotTrendChart
              summary={activeSummary}
              comparison={comparison}
              labelA={labelA}
              labelB={labelB}
            />
          </div>
        )}

        {/* ── Opt-in Section 2: Linked Places / Compare ── */}
        {showLinked && (
          <div className="space-y-2.5 border-t border-border/70 pt-2.5">
            {linkedPairs.length > 0 && anchorNode && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-text-subtle">
                  Connected places around Earth
                </div>
                {linkedPairs.map(({ edge, peer }) => {
                  const isOpposite = edge.type === "drives_opposite";
                  const peerTitle =
                    peer.properties.region && !peer.properties.region.includes("°")
                      ? `${peer.properties.region} · ${humanizeNodeText(peer.properties.name)}`
                      : humanizeNodeText(peer.properties.name);
                  return (
                    <button
                      key={edge.properties.uuid}
                      type="button"
                      onClick={() => onCompareOpposite(anchorNode, peer)}
                      className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-surface-inset px-3 py-2 text-left transition-colors hover:border-accent-fg/50 cursor-pointer"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-text-primary">
                          {peerTitle}
                        </div>
                        <div className="truncate text-[11px] text-text-subtle">
                          {edge.properties.mechanism || "Connected Earth shift"}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          isOpposite
                            ? "bg-rose-500/15 text-rose-300"
                            : "bg-sky-500/15 text-sky-300"
                        }`}
                      >
                        {isOpposite ? "Opposite" : "Together"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={onToggleCompareMode}
              className={`flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                compareMode
                  ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200"
                  : "border-border-strong bg-surface-elevated text-text-primary hover:border-accent-fg"
              }`}
            >
              <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {compareMode
                  ? "Click another spot on Earth…"
                  : "Compare this spot with another point on Earth"}
              </span>
            </button>
          </div>
        )}

        {/* ── Opt-in Section 3: Science & Sources ── */}
        {showScience && (
          <div className="space-y-2.5 border-t border-border/70 pt-2.5">
            {/* Data Provenance & Quick Links */}
            <div className="flex flex-wrap items-center gap-1.5">
              {(activeSummary?.provenance || selectedNode?.properties.source_system) && (
                <span className="rounded-full border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-subtle">
                  {activeSummary?.provenance ?? selectedNode?.properties.source_system}
                </span>
              )}
              {typeof selectedNode?.properties.source_url === "string" && (
                <a
                  href={selectedNode.properties.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-accent-fg hover:underline"
                >
                  Source Data ↗
                </a>
              )}
              {coord && (
                <a
                  href={
                    buildExternalExplorerLinks(
                      coord.lat,
                      coord.lng,
                      activeSummary?.dataset ?? selectedNode?.properties.dataset ?? "nasa_power"
                    ).giovanniUrl
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-sky-400 hover:underline"
                >
                  NASA Giovanni ↗
                </a>
              )}
            </div>

            {/* Save to Graph / Verify / Sensor Ping */}
            <div className="flex flex-wrap gap-1.5">
              {(activeSummary || isComparingTwoSpots) && (
                <button
                  type="button"
                  disabled={committing}
                  onClick={() => void handleSaveToGraph()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                >
                  <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{committing ? "Saving…" : "Save to Graph"}</span>
                </button>
              )}

              {selectedNode && (
                <>
                  <button
                    type="button"
                    disabled={committing}
                    onClick={() => void handleVerifyGate()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span>Verify sources ({supportingEdges.length})</span>
                  </button>

                  {selectedNode.properties.lat !== undefined && (
                    <button
                      type="button"
                      disabled={committing}
                      onClick={() => void handleSimulateWebhook()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                    >
                      <Radio className="h-3.5 w-3.5 text-purple-400" aria-hidden="true" />
                      <span>Ping local sensor</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowReviseForm((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-amber-300 hover:border-amber-400 cursor-pointer"
                  >
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{showReviseForm ? "Cancel update" : "Update finding"}</span>
                  </button>
                </>
              )}
            </div>

            {showReviseForm && selectedNode && (
              <form onSubmit={handleReviseBelief} className="space-y-2 rounded-xl border border-border bg-surface-inset p-3">
                <input
                  type="text"
                  required
                  placeholder="Updated conclusion title"
                  value={revName}
                  onChange={(e) => setRevName(e.target.value)}
                  className="form-input"
                />
                <input
                  type="text"
                  required
                  placeholder="Evidence summary"
                  value={revDesc}
                  onChange={(e) => setRevDesc(e.target.value)}
                  className="form-input"
                />
                <input
                  type="text"
                  required
                  placeholder="Why was the earlier finding revised?"
                  value={revRationale}
                  onChange={(e) => setRevRationale(e.target.value)}
                  className="form-input"
                />
                <button
                  type="submit"
                  disabled={committing}
                  className="w-full rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 cursor-pointer"
                >
                  Save revision
                </button>
              </form>
            )}

            {beliefChain.length > 1 && (
              <div className="space-y-1 rounded-xl border border-border bg-surface-inset p-2.5">
                <div className="text-[11px] font-semibold text-amber-300">
                  Revision history ({beliefChain.length})
                </div>
                {beliefChain.map((step, idx) => (
                  <button
                    key={step.node.uuid}
                    type="button"
                    onClick={() => onSelectNode(step.node)}
                    className="block w-full truncate text-left text-[11px] text-text-muted hover:text-text-primary hover:underline cursor-pointer"
                  >
                    {idx === 0 ? "Current: " : "Prior: "}
                    {humanizeNodeText(step.node.properties.name)}
                  </button>
                ))}
              </div>
            )}

            {/* Collapsible Raw Statistical Engine Metrics (closed by default; semantic summary without headings or nested controls) */}
            {(activeSummary ||
              selectedNode?.properties.p_value !== undefined ||
              comparison) && (
              <details className="etg-details">
                <summary>Statistical test details (Mann-Kendall &amp; Theil-Sen)</summary>
                <div className="space-y-2 p-3 font-mono text-[11px] text-text-muted">
                  {activeSummary && (
                    <>
                      <div className="flex justify-between gap-2">
                        <span>Mann-Kendall p-value</span>
                        <span className="ws-numeric text-text-primary">
                          {activeSummary.mannKendall.pValue < 0.0001
                            ? "< 0.0001"
                            : activeSummary.mannKendall.pValue.toFixed(4)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Hamed-Rao p* / τ / Z</span>
                        <span className="ws-numeric text-text-primary">
                          {activeSummary.mannKendall.pValueAdjusted.toFixed(4)} · τ=
                          {activeSummary.mannKendall.tau.toFixed(2)} · Z=
                          {activeSummary.mannKendall.zScore.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Theil-Sen slope (95% CI)</span>
                        <span className="ws-numeric text-text-primary">
                          {activeSummary.theilSen.slope >= 0 ? "+" : ""}
                          {activeSummary.theilSen.slope.toFixed(4)} {activeSummary.slopeUnit} [
                          {activeSummary.theilSen.slopeLow95.toFixed(3)},{" "}
                          {activeSummary.theilSen.slopeHigh95.toFixed(3)}]
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>OLS R² / Pettitt shift</span>
                        <span className="ws-numeric text-text-primary">
                          {activeSummary.ols.rSquared.toFixed(2)}
                          {activeSummary.changePoint?.significant
                            ? ` · Shift ${activeSummary.changePoint.date}`
                            : " · No shift break"}
                        </span>
                      </div>
                    </>
                  )}
                  {!activeSummary && selectedNode?.properties.p_value !== undefined && (
                    <div className="flex justify-between gap-2">
                      <span>Mann-Kendall p / Theil-Sen</span>
                      <span className="ws-numeric text-text-primary">
                        p={selectedNode.properties.p_value.toFixed(4)} ·{" "}
                        {selectedNode.properties.theil_sen_slope ?? "—"}
                      </span>
                    </div>
                  )}
                  {comparison && (
                    <div className="flex justify-between gap-2 border-t border-border/60 pt-2">
                      <span>Pearson r / Detrended r*</span>
                      <span className="ws-numeric text-text-primary">
                        r={comparison.pearsonR.toFixed(2)} · r*={comparison.detrendedR.toFixed(2)} (Δt=
                        {comparison.optimalLagSteps} {comparison.lagUnit})
                      </span>
                    </div>
                  )}
                </div>
              </details>
            )}

            {actionMsg && (
              <div role="status" className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{actionMsg}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3. Opt-In Toggle Bar ("Choose What You See") */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-t border-border bg-surface-inset/60 px-3 py-2">
        <button
          type="button"
          aria-pressed={showChart}
          onClick={() => setShowChart((v) => !v)}
          className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
            showChart
              ? "border-accent-fg/60 bg-accent/18 text-accent-fg"
              : "border-border bg-surface text-text-muted hover:text-text-primary"
          }`}
        >
          <BarChart3 className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Chart</span>
        </button>

        <button
          type="button"
          aria-pressed={showLinked}
          onClick={() => setShowLinked((v) => !v)}
          className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
            showLinked
              ? "border-accent-fg/60 bg-accent/18 text-accent-fg"
              : "border-border bg-surface text-text-muted hover:text-text-primary"
          }`}
        >
          <GitCompare className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {linkedPairs.length > 0 ? `Linked places (${linkedPairs.length})` : "Compare"}
          </span>
        </button>

        <button
          type="button"
          aria-pressed={showScience}
          onClick={() => setShowScience((v) => !v)}
          className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
            showScience
              ? "border-accent-fg/60 bg-accent/18 text-accent-fg"
              : "border-border bg-surface text-text-muted hover:text-text-primary"
          }`}
        >
          <FlaskConical className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Science &amp; sources</span>
        </button>
      </div>
    </div>
  );
}
