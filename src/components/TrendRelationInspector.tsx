"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  CheckCircle2,
  GitBranch,
  GitMerge,
  Layers,
  MapPin,
} from "lucide-react";
import { EARTH_TREND_DATASETS } from "@/lib/datasets";
import { inferEarthSphere } from "@/lib/graph/cascadeTracer";
import type {
  CrossRegionComparison,
  EarthCascadeChain,
  EarthSphere,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  TrendAnalysisSummary,
} from "@/types/etg";

interface TrendRelationInspectorProps {
  primary: TrendAnalysisSummary | null;
  secondary: TrendAnalysisSummary | null;
  comparison: CrossRegionComparison | null;
  selectedEdge: ETGEdge | null;
  sourceNode: ETGNode | null;
  targetNode: ETGNode | null;
  cascades: EarthCascadeChain[];
  activeCascadeId: string | null;
  loading: boolean;
  compareModeActive: boolean;
  onToggleCompareMode: () => void;
  onSwapPins: () => void;
  onChangePrimaryDataset?: (ds: ETGDatasetId) => void;
  onChangeSecondaryDataset?: (ds: ETGDatasetId) => void;
  onSelectCascade: (cascade: EarthCascadeChain | null) => void;
  onFocusNodeUuid: (uuid: string) => void;
  onFocusEdgeUuid: (uuid: string) => void;
  onCommitRelation: (payload: {
    primary: TrendAnalysisSummary;
    secondary: TrendAnalysisSummary;
    comparison: CrossRegionComparison;
    sourceNodeUuid?: string;
    targetNodeUuid?: string;
  }) => Promise<void>;
}

const SPHERE_BADGE_CLASSES: Record<EarthSphere, string> = {
  Atmosphere: "border-amber-400/35 bg-amber-400/12 text-amber-300",
  Ocean: "border-sky-400/35 bg-sky-400/12 text-sky-300",
  Cryosphere: "border-cyan-300/40 bg-cyan-300/12 text-cyan-200",
  Hydrosphere: "border-teal-400/35 bg-teal-400/12 text-teal-300",
  Biosphere: "border-emerald-400/35 bg-emerald-400/12 text-emerald-300",
};

function inferSphereFromDataset(dataset?: ETGDatasetId, parameter?: string): EarthSphere {
  const p = (parameter ?? "").toLowerCase();
  if (p.includes("sea ice") || p.includes("cryo") || p.includes("albedo")) return "Cryosphere";
  if (p.includes("rh2m") || p.includes("humidity") || p.includes("co2")) return "Atmosphere";
  if (dataset === "ocean_temp") return "Ocean";
  if (dataset === "hydrology") return "Hydrosphere";
  if (dataset === "deforestation" || dataset === "wildfire") return "Biosphere";
  return "Atmosphere";
}

function formatLagDirection(
  lagSteps: number,
  lagUnit: string,
  labelA: string,
  labelB: string
): string {
  if (lagSteps === 0) return `Synchronous (Δt = 0 ${lagUnit})`;
  if (lagSteps > 0) return `${labelA} leads ${labelB} (+${lagSteps} ${lagUnit})`;
  return `${labelB} leads ${labelA} (+${Math.abs(lagSteps)} ${lagUnit})`;
}

export function TrendRelationInspector({
  primary,
  secondary,
  comparison,
  selectedEdge,
  sourceNode,
  targetNode,
  cascades,
  activeCascadeId,
  loading,
  compareModeActive,
  onToggleCompareMode,
  onSwapPins,
  onChangePrimaryDataset,
  onChangeSecondaryDataset,
  onSelectCascade,
  onFocusNodeUuid,
  onFocusEdgeUuid,
  onCommitRelation,
}: TrendRelationInspectorProps) {
  const [committing, setCommitting] = useState(false);
  const [committedMessage, setCommittedMessage] = useState<string | null>(null);
  const [cascadesOpen, setCascadesOpen] = useState(Boolean(activeCascadeId));

  useEffect(() => {
    if (activeCascadeId) {
      setCascadesOpen(true);
    }
  }, [activeCascadeId]);

  const sameRegionNodes =
    Boolean(sourceNode?.properties.region) &&
    sourceNode?.properties.region === targetNode?.properties.region;

  const labelA =
    (sameRegionNodes
      ? sourceNode?.properties.name
      : sourceNode?.properties.region || sourceNode?.properties.name) ||
    (primary ? `${primary.lat.toFixed(1)}°, ${primary.lng.toFixed(1)}°` : "Pin A");
  const labelB =
    (sameRegionNodes
      ? targetNode?.properties.name
      : targetNode?.properties.region || targetNode?.properties.name) ||
    (secondary ? `${secondary.lat.toFixed(1)}°, ${secondary.lng.toFixed(1)}°` : "Pin B");

  const sphereA: EarthSphere = sourceNode
    ? inferEarthSphere(sourceNode)
    : inferSphereFromDataset(primary?.dataset, primary?.parameter);
  const sphereB: EarthSphere = targetNode
    ? inferEarthSphere(targetNode)
    : inferSphereFromDataset(secondary?.dataset, secondary?.parameter);

  // Derived SVG coordinates for Z-score overlay
  const zChart = useMemo(() => {
    const pts = comparison?.alignedPoints ?? [];
    if (pts.length < 3) return null;
    const w = 360;
    const h = 152;
    const padX = 28;
    const padY = 18;
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const allZ = pts.flatMap((p) => [p.zA, p.zB]);
    const maxAbsZ = Math.max(2.0, ...allZ.map((v) => Math.abs(v)));
    const xAt = (i: number) => padX + (i / Math.max(1, pts.length - 1)) * innerW;
    const yAt = (z: number) => padY + ((maxAbsZ - z) / (2 * maxAbsZ)) * innerH;

    const pathA = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zA).toFixed(1)}`)
      .join(" ");
    const pathB = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.zB).toFixed(1)}`)
      .join(" ");

    let shiftX: number | null = null;
    if (comparison?.sharedRegimeShiftYear) {
      const idx = pts.findIndex((p) => p.date.startsWith(String(comparison.sharedRegimeShiftYear)));
      if (idx >= 0) shiftX = xAt(idx);
    }

    return {
      w,
      h,
      zeroY: yAt(0),
      pathA,
      pathB,
      shiftX,
      firstDate: pts[0].date,
      lastDate: pts[pts.length - 1].date,
    };
  }, [comparison]);

  // Derived SVG coordinates for detrended residual scatter
  const scatterChart = useMemo(() => {
    const pts = comparison?.alignedPoints ?? [];
    if (pts.length < 3) return null;
    const size = 152;
    const pad = 18;
    const inner = size - pad * 2;
    const maxAbs = Math.max(
      2.2,
      ...pts.flatMap((p) => [Math.abs(p.detrendedZA), Math.abs(p.detrendedZB)])
    );
    const toX = (v: number) => pad + ((v + maxAbs) / (2 * maxAbs)) * inner;
    const toY = (v: number) => pad + ((maxAbs - v) / (2 * maxAbs)) * inner;

    const slope = comparison?.detrendedR ?? 0;
    const x1 = -maxAbs * 0.85;
    const x2 = maxAbs * 0.85;
    const y1 = Math.max(-maxAbs, Math.min(maxAbs, slope * x1));
    const y2 = Math.max(-maxAbs, Math.min(maxAbs, slope * x2));

    return {
      size,
      pad,
      mid: size / 2,
      dots: pts.map((p, i) => ({
        key: `${p.date}-${i}`,
        cx: toX(p.detrendedZA),
        cy: toY(p.detrendedZB),
      })),
      fitLine: {
        x1: toX(x1),
        y1: toY(y1),
        x2: toX(x2),
        y2: toY(y2),
      },
    };
  }, [comparison]);

  // Derived SVG coordinates for Rolling Correlation Sparkline
  const rollingChart = useMemo(() => {
    const rows = comparison?.rollingCorrelations ?? [];
    if (rows.length < 3) return null;
    const w = 360;
    const h = 88;
    const padX = 24;
    const padY = 12;
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const xAt = (i: number) => padX + (i / Math.max(1, rows.length - 1)) * innerW;
    const yAt = (r: number) => padY + ((1 - r) / 2) * innerH;

    const rawPath = rows
      .map((pt, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(pt.r).toFixed(1)}`)
      .join(" ");
    const detrendedPath = rows
      .map(
        (pt, i) =>
          `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(pt.detrendedR).toFixed(1)}`
      )
      .join(" ");

    return {
      w,
      h,
      zeroY: yAt(0),
      rawPath,
      detrendedPath,
      startDate: rows[0].date,
      endDate: rows[rows.length - 1].date,
    };
  }, [comparison]);

  const handleCommitClick = async () => {
    if (!primary || !secondary || !comparison) return;
    setCommitting(true);
    setCommittedMessage(null);
    try {
      await onCommitRelation({
        primary,
        secondary,
        comparison,
        sourceNodeUuid: sourceNode?.uuid,
        targetNodeUuid: targetNode?.uuid,
      });
      setCommittedMessage("Relation wired into live Earth Trend Graph.");
    } finally {
      setCommitting(false);
    }
  };

  const activePearsonR = comparison?.pearsonR ?? selectedEdge?.properties.correlation_r;
  const activeDetrendedR = comparison?.detrendedR ?? selectedEdge?.properties.detrended_r;
  const activeLagSteps =
    comparison?.optimalLagSteps ?? selectedEdge?.properties.optimal_lag_steps ?? 0;
  const activeLagUnit = comparison?.lagUnit ?? selectedEdge?.properties.lag_unit ?? "months";
  const activeMechanism = comparison?.mechanism ?? selectedEdge?.properties.mechanism;
  const activeAmpRatio =
    comparison?.slopeRatio ?? selectedEdge?.properties.amplification_ratio;
  const activeShiftYear =
    comparison?.sharedRegimeShiftYear ?? selectedEdge?.properties.shared_shift_year ?? null;

  const isOpposite =
    comparison?.classification === "opposite_teleconnection" ||
    selectedEdge?.type === "drives_opposite" ||
    (activePearsonR !== undefined && activePearsonR <= -0.35);

  const hasEdgeOrComparison = Boolean(comparison || selectedEdge);

  return (
    <div className="space-y-7 p-7 text-sm">
      {loading && (
        <div className="rounded-2xl border border-border bg-surface-elevated p-5 text-xs text-text-muted">
          Computing detrended anomalies &amp; lead-lag cross-correlogram…
        </div>
      )}

      {!loading && !hasEdgeOrComparison && (
        <div className="space-y-4 rounded-2xl border border-border bg-surface-elevated p-5">
          <div className="flex items-start gap-3">
            <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-accent-fg" aria-hidden="true" />
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold text-text-primary">
                Analyze Two-Region Relations &amp; Leads
              </h3>
              <p className="text-xs leading-relaxed text-text-muted">
                Click any colored arc on the 3D Earth or Knowledge Graph edge, or pick two coordinates
                to run detrended anomaly coupling, lead-lag Δt correlogram, and mechanism classification.
              </p>
            </div>
          </div>

          <button
            type="button"
            aria-pressed={compareModeActive}
            onClick={onToggleCompareMode}
            className={`inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer ${
              compareModeActive
                ? "border-cyan-400/55 bg-cyan-400/18 text-cyan-200"
                : "border-border-strong bg-surface hover:border-accent-fg text-text-primary"
            }`}
          >
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {compareModeActive
                ? "Click a 2nd point on 3D Earth for Pin B…"
                : primary
                  ? "Pick 2nd Location on Earth (Pin B)"
                  : "Enable 2-Pin Earth Compare"}
            </span>
          </button>
        </div>
      )}

      {!loading && hasEdgeOrComparison && (
        <div className="space-y-7">
          {/* Editorial Two-Region Endpoints & Causal Direction */}
          <div className="space-y-4 border-b border-border/70 pb-6">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                    isOpposite
                      ? "border-rose-400/40 bg-rose-500/14 text-rose-300"
                      : comparison?.classification === "co_trending" ||
                          selectedEdge?.type === "correlates_with" ||
                          selectedEdge?.type === "teleconnects" ||
                          selectedEdge?.type === "corroborates"
                        ? "border-sky-400/40 bg-sky-500/14 text-sky-300"
                        : "border-border-strong bg-surface text-text-muted"
                  }`}
                >
                  {selectedEdge
                    ? selectedEdge.type.replaceAll("_", " ")
                    : comparison?.classification === "opposite_teleconnection"
                      ? "Opposite Dipole"
                      : comparison?.classification === "co_trending"
                        ? "Co-Trending Bridge"
                        : "Uncoupled"}
                </span>

                {activeMechanism && (
                  <span className="rounded-full border border-amber-400/35 bg-amber-400/10 px-2.5 py-0.5 text-[10px] font-medium text-amber-300">
                    {activeMechanism}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {primary && secondary && (
                  <button
                    type="button"
                    onClick={onSwapPins}
                    title="Swap Driver (A) and Response (B)"
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-text-muted hover:border-border-strong hover:text-text-primary cursor-pointer"
                  >
                    <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                    <span>Swap</span>
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={compareModeActive}
                  onClick={onToggleCompareMode}
                  className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                    compareModeActive
                      ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-200"
                      : "border-border bg-surface text-text-muted hover:border-accent-fg hover:text-text-primary"
                  }`}
                >
                  <MapPin className="h-3 w-3" aria-hidden="true" />
                  <span>Pick B</span>
                </button>
              </div>
            </div>

            <div className="space-y-3.5 pt-1">
              {/* Endpoint A */}
              <div className="space-y-1.5 border-l-2 border-amber-400/60 pl-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                    <span className="text-[15px] font-semibold leading-snug text-text-primary">
                      {labelA}
                    </span>
                  </div>
                  <span
                    className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${SPHERE_BADGE_CLASSES[sphereA]}`}
                  >
                    {sphereA}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pl-4 text-xs text-text-muted">
                  <span className="ws-numeric font-mono">
                    {primary
                      ? `Slope ${primary.theilSen.slope >= 0 ? "+" : ""}${primary.theilSen.slope.toFixed(3)} ${primary.slopeUnit}`
                      : sourceNode?.properties.theil_sen_slope !== undefined
                        ? `Slope ${sourceNode.properties.theil_sen_slope >= 0 ? "+" : ""}${sourceNode.properties.theil_sen_slope} ${sourceNode.properties.slope_unit ?? ""}`
                        : "Stored ETG endpoint"}
                  </span>

                  {primary && onChangePrimaryDataset && !sourceNode && (
                    <label className="flex items-center gap-1 text-[11px]">
                      <span className="sr-only">Pin A Dataset</span>
                      <select
                        value={primary.dataset}
                        onChange={(e) => onChangePrimaryDataset(e.target.value as ETGDatasetId)}
                        className="rounded-lg border border-border bg-surface-inset px-2 py-1 text-[11px] text-text-primary focus:outline-none"
                      >
                        {EARTH_TREND_DATASETS.map((ds) => (
                          <option key={ds.id} value={ds.id}>
                            {ds.shortLabel}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>

              {/* Lead-Lag Direction Connector */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-l border-dashed border-border pl-4 py-1 text-xs text-text-muted">
                <span className="font-mono text-[11px] text-text-subtle">
                  {formatLagDirection(activeLagSteps, activeLagUnit, "Pin A", "Pin B")}
                </span>
                {comparison?.couplingRegime && (
                  <span className="text-[11px] font-medium text-accent-fg">
                    {comparison.couplingRegime}
                  </span>
                )}
              </div>

              {/* Endpoint B */}
              <div
                className={`space-y-1.5 border-l-2 pl-4 ${
                  isOpposite ? "border-rose-400/60" : "border-sky-400/60"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isOpposite ? "bg-rose-400" : "bg-sky-400"}`}
                      aria-hidden="true"
                    />
                    <span className="text-[15px] font-semibold leading-snug text-text-primary">
                      {labelB}
                    </span>
                  </div>
                  <span
                    className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${SPHERE_BADGE_CLASSES[sphereB]}`}
                  >
                    {sphereB}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pl-4 text-xs text-text-muted">
                  <span className="ws-numeric font-mono">
                    {secondary
                      ? `Slope ${secondary.theilSen.slope >= 0 ? "+" : ""}${secondary.theilSen.slope.toFixed(3)} ${secondary.slopeUnit}`
                      : targetNode?.properties.theil_sen_slope !== undefined
                        ? `Slope ${targetNode.properties.theil_sen_slope >= 0 ? "+" : ""}${targetNode.properties.theil_sen_slope} ${targetNode.properties.slope_unit ?? ""}`
                        : "Stored ETG endpoint"}
                  </span>

                  {secondary && onChangeSecondaryDataset && !targetNode && (
                    <label className="flex items-center gap-1 text-[11px]">
                      <span className="sr-only">Pin B Dataset</span>
                      <select
                        value={secondary.dataset}
                        onChange={(e) => onChangeSecondaryDataset(e.target.value as ETGDatasetId)}
                        className="rounded-lg border border-border bg-surface-inset px-2 py-1 text-[11px] text-text-primary focus:outline-none"
                      >
                        {EARTH_TREND_DATASETS.map((ds) => (
                          <option key={ds.id} value={ds.id}>
                            {ds.shortLabel}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
            </div>

            {selectedEdge?.properties.rationale && (
              <p className="pt-1 text-[13px] leading-relaxed text-text-muted">
                {selectedEdge.properties.rationale}
              </p>
            )}
          </div>

          {/* 2x2 Statistical Coupling Matrix */}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl border border-border bg-surface-elevated p-4">
              <div className="text-[10px] font-medium uppercase tracking-wider text-text-subtle">
                Level Coupling
              </div>
              <div className="ws-numeric mt-1.5 font-mono text-lg font-bold text-text-primary">
                r = {activePearsonR !== undefined ? activePearsonR.toFixed(2) : "—"}
              </div>
              <div className="ws-numeric mt-1 font-mono text-[11px] text-text-muted">
                {comparison
                  ? `ρ = ${comparison.spearmanRho.toFixed(2)} · p = ${comparison.pValue < 0.001 ? comparison.pValue.toExponential(1) : comparison.pValue.toFixed(3)}`
                  : "Stored edge coefficient"}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface-elevated p-4">
              <div className="text-[10px] font-medium uppercase tracking-wider text-text-subtle">
                Detrended Variability
              </div>
              <div className="ws-numeric mt-1.5 font-mono text-lg font-bold text-cyan-300">
                r* = {activeDetrendedR !== undefined ? activeDetrendedR.toFixed(2) : "—"}
              </div>
              <div className="mt-1 text-[11px] leading-snug text-text-muted">
                {activeDetrendedR === undefined
                  ? "No residual metric saved"
                  : Math.abs(activeDetrendedR) >= 0.45
                    ? "Genuine interannual link"
                    : "Driven by shared secular drift"}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface-elevated p-4">
              <div className="text-[10px] font-medium uppercase tracking-wider text-text-subtle">
                Optimal Lead-Lag (Δt)
              </div>
              <div className="ws-numeric mt-1.5 font-mono text-lg font-bold text-amber-300">
                {activeLagSteps > 0 ? `+${activeLagSteps}` : activeLagSteps} {activeLagUnit}
              </div>
              <div className="ws-numeric mt-1 font-mono text-[11px] text-text-muted">
                {comparison
                  ? `Peak r = ${comparison.optimalLagR.toFixed(2)}`
                  : activeLagSteps === 0
                    ? "Coincident response"
                    : "Lag-shifted coupling"}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface-elevated p-4">
              <div className="text-[10px] font-medium uppercase tracking-wider text-text-subtle">
                Amplification &amp; Shift
              </div>
              <div className="ws-numeric mt-1.5 font-mono text-lg font-bold text-text-primary">
                {activeAmpRatio !== undefined ? `${activeAmpRatio.toFixed(2)}×` : "—"}
              </div>
              <div className="ws-numeric mt-1 font-mono text-[11px] text-text-muted">
                {activeShiftYear ? `Co-shifted ~${activeShiftYear}` : "No shared shift break"}
              </div>
            </div>
          </div>

          {/* Chart 1: Dual Z-Score Overlay */}
          {zChart && (
            <div className="space-y-3 rounded-2xl border border-border bg-surface-elevated p-5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-text-primary">
                  Standardized Z-Score Trajectory
                </span>
                <div className="flex items-center gap-3 font-mono text-[11px] text-text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />A
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={`h-2 w-2 rounded-full ${isOpposite ? "bg-rose-400" : "bg-sky-400"}`}
                      aria-hidden="true"
                    />
                    B
                  </span>
                </div>
              </div>

              <svg
                viewBox={`0 0 ${zChart.w} ${zChart.h}`}
                className="h-40 w-full overflow-visible"
                role="img"
                aria-label={`Standardized Z-score comparison between ${labelA} and ${labelB}`}
              >
                <title>Dual standardized Z-score overlay chart</title>
                <line
                  x1={28}
                  y1={zChart.zeroY}
                  x2={zChart.w - 28}
                  y2={zChart.zeroY}
                  stroke="currentColor"
                  strokeOpacity={0.2}
                  strokeDasharray="3 3"
                />
                {zChart.shiftX !== null && (
                  <line
                    x1={zChart.shiftX}
                    y1={12}
                    x2={zChart.shiftX}
                    y2={zChart.h - 14}
                    stroke="#f59e0b"
                    strokeOpacity={0.45}
                    strokeDasharray="3 2"
                  />
                )}
                <path d={zChart.pathA} fill="none" stroke="#fbbf24" strokeWidth={2.2} />
                <path
                  d={zChart.pathB}
                  fill="none"
                  stroke={isOpposite ? "#fb7185" : "#38bdf8"}
                  strokeWidth={2.2}
                />
                <text x={28} y={zChart.h - 2} fontSize={9.5} fill="currentColor" opacity={0.55}>
                  {zChart.firstDate}
                </text>
                <text
                  x={zChart.w - 28}
                  y={zChart.h - 2}
                  textAnchor="end"
                  fontSize={9.5}
                  fill="currentColor"
                  opacity={0.55}
                >
                  {zChart.lastDate}
                </text>
              </svg>
            </div>
          )}

          {/* Progressive Disclosure: Lead-Lag, Scatter & Rolling Stability */}
          {((comparison && scatterChart) || rollingChart) && (
            <details className="etg-details">
              <summary>Lead-Lag Δt, Residual Scatter &amp; Rolling Stability</summary>
              <div className="space-y-5 p-5">
                {comparison && (
                  <div className="space-y-2.5 rounded-2xl border border-border bg-surface-inset p-4">
                    <div className="text-xs font-semibold text-text-primary">
                      Lead-Lag Δt (r) Cross-Correlogram
                    </div>
                    <svg
                      viewBox="0 0 340 128"
                      className="h-32 w-full"
                      role="img"
                      aria-label={`Lead-lag cross-correlogram peaking at ${comparison.optimalLagSteps} ${comparison.lagUnit}`}
                    >
                      <title>Lead-lag cross-correlogram</title>
                      <line x1={16} y1={64} x2={324} y2={64} stroke="currentColor" strokeOpacity={0.22} />
                      {comparison.lagProfile.map((pt, idx) => {
                        const count = Math.max(1, comparison.lagProfile.length);
                        const barW = Math.max(8, Math.min(20, (300 / count) * 0.7));
                        const stepW = 300 / count;
                        const x = 20 + idx * stepW + (stepW - barW) / 2;
                        const h = Math.abs(pt.r) * 46;
                        const y = pt.r >= 0 ? 64 - h : 64;
                        const isPeak = pt.lagSteps === comparison.optimalLagSteps;
                        const fill = isPeak
                          ? "#fbbf24"
                          : pt.r < 0
                            ? "#fb7185"
                            : "#38bdf8";
                        return (
                          <g key={pt.lagSteps}>
                            <rect
                              x={x}
                              y={y}
                              width={barW}
                              height={Math.max(2, h)}
                              rx={2}
                              fill={fill}
                              fillOpacity={isPeak ? 1 : 0.65}
                            />
                            {(pt.lagSteps === 0 || isPeak || count <= 9) && (
                              <text
                                x={x + barW / 2}
                                y={121}
                                textAnchor="middle"
                                fontSize={10}
                                fill={isPeak ? "#fbbf24" : "currentColor"}
                                opacity={isPeak ? 1 : 0.65}
                              >
                                {pt.lagSteps > 0 ? `+${pt.lagSteps}` : pt.lagSteps}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                )}

                {comparison && scatterChart && (
                  <div className="space-y-2.5 rounded-2xl border border-border bg-surface-inset p-4">
                    <div className="text-xs font-semibold text-text-primary">
                      Detrended Residual Scatter
                    </div>
                    <svg
                      viewBox={`0 0 ${scatterChart.size} ${scatterChart.size}`}
                      className="mx-auto block h-44 w-44"
                      role="img"
                      aria-label={`Detrended residual scatter plot with correlation r star equals ${comparison.detrendedR.toFixed(2)}`}
                    >
                      <title>Detrended residual scatter plot</title>
                      <line
                        x1={scatterChart.pad}
                        y1={scatterChart.mid}
                        x2={scatterChart.size - scatterChart.pad}
                        y2={scatterChart.mid}
                        stroke="currentColor"
                        strokeOpacity={0.18}
                      />
                      <line
                        x1={scatterChart.mid}
                        y1={scatterChart.pad}
                        x2={scatterChart.mid}
                        y2={scatterChart.size - scatterChart.pad}
                        stroke="currentColor"
                        strokeOpacity={0.18}
                      />
                      <line
                        x1={scatterChart.fitLine.x1}
                        y1={scatterChart.fitLine.y1}
                        x2={scatterChart.fitLine.x2}
                        y2={scatterChart.fitLine.y2}
                        stroke="#22d3ee"
                        strokeWidth={1.5}
                        strokeDasharray="3 2"
                      />
                      {scatterChart.dots.map((dot) => (
                        <circle
                          key={dot.key}
                          cx={dot.cx}
                          cy={dot.cy}
                          r={3}
                          fill="#fbbf24"
                          fillOpacity={0.85}
                        />
                      ))}
                    </svg>
                  </div>
                )}

                {rollingChart && (
                  <div className="space-y-2 rounded-2xl border border-border bg-surface-inset p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-text-primary">
                        Rolling Coupling Stability
                      </span>
                      <span className="font-mono text-[10px] text-text-muted">
                        Level r (solid) · Detrended r* (dashed)
                      </span>
                    </div>
                    <svg
                      viewBox={`0 0 ${rollingChart.w} ${rollingChart.h}`}
                      className="h-24 w-full overflow-visible"
                      role="img"
                      aria-label="Rolling window correlation trajectory over time"
                    >
                      <title>Rolling window correlation sparkline</title>
                      <line
                        x1={24}
                        y1={rollingChart.zeroY}
                        x2={rollingChart.w - 24}
                        y2={rollingChart.zeroY}
                        stroke="currentColor"
                        strokeOpacity={0.22}
                        strokeDasharray="3 3"
                      />
                      <path d={rollingChart.rawPath} fill="none" stroke="#fbbf24" strokeWidth={1.85} />
                      <path
                        d={rollingChart.detrendedPath}
                        fill="none"
                        stroke="#22d3ee"
                        strokeWidth={1.6}
                        strokeDasharray="4 3"
                      />
                      <text x={24} y={rollingChart.h - 1} fontSize={9} fill="currentColor" opacity={0.55}>
                        {rollingChart.startDate}
                      </text>
                      <text
                        x={rollingChart.w - 24}
                        y={rollingChart.h - 1}
                        textAnchor="end"
                        fontSize={9}
                        fill="currentColor"
                        opacity={0.55}
                      >
                        {rollingChart.endDate}
                      </text>
                    </svg>
                  </div>
                )}
              </div>
            </details>
          )}

          {/* Commit 2-Pin Live Relation into ETG */}
          {primary && secondary && comparison && !selectedEdge && (
            <div className="space-y-2.5">
              <button
                type="button"
                disabled={committing}
                onClick={() => void handleCommitClick()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-60 cursor-pointer"
              >
                <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {committing
                    ? "Wiring Relation into Graph…"
                    : "Wire Relation into Earth Trend Graph"}
                </span>
              </button>

              {committedMessage && (
                <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{committedMessage}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Multi-Hop Cross-Sphere Earth Cascades */}
      <details
        className="etg-details"
        open={cascadesOpen}
        onToggle={(e) => setCascadesOpen(e.currentTarget.open)}
      >
        <summary>
          <span className="inline-flex items-center gap-2">
            <Layers className="h-3.5 w-3.5 text-teal-400" aria-hidden="true" />
            <span>Multi-Sphere Earth Cascades ({cascades.length})</span>
          </span>
        </summary>

        <div className="space-y-3 p-5">
          {cascades.length === 0 ? (
            <p className="text-xs leading-relaxed text-text-muted">
              Run Live NASA/NOAA/CSA Discovery or wire cross-region links to trace multi-sphere
              Atmosphere → Cryosphere → Hydrosphere domino pathways.
            </p>
          ) : (
            cascades.map((chain) => {
              const isActive = chain.id === activeCascadeId;
              return (
                <div
                  key={chain.id}
                  className={`rounded-2xl border p-4 transition-colors ${
                    isActive
                      ? "border-amber-400/55 bg-amber-400/10"
                      : "border-border bg-surface-elevated hover:border-border-strong"
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => onSelectCascade(isActive ? null : chain)}
                    className="w-full space-y-2 text-left cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-text-primary">
                        {chain.title}
                      </span>
                      <span className="ws-numeric shrink-0 font-mono text-[11px] text-amber-300">
                        |r| {chain.meanAbsR.toFixed(2)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {chain.spheres.map((sp) => (
                        <span
                          key={sp}
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${SPHERE_BADGE_CLASSES[sp]}`}
                        >
                          {sp}
                        </span>
                      ))}
                    </div>

                    <p className="text-[11px] leading-relaxed text-text-muted">{chain.summary}</p>
                  </button>

                  {isActive && (
                    <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                      {chain.steps.map((step, sIdx) => (
                        <div key={`${step.nodeUuid}-${sIdx}`} className="flex items-center gap-2.5">
                          <span className="ws-numeric flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/20 font-mono text-[10px] font-bold text-amber-300">
                            {sIdx + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => onFocusNodeUuid(step.nodeUuid)}
                            className="min-w-0 flex-1 text-left text-xs font-medium leading-snug text-text-primary hover:text-accent-fg cursor-pointer"
                          >
                            {step.nodeName}
                          </button>
                          {step.edgeUuid && (
                            <button
                              type="button"
                              onClick={() => onFocusEdgeUuid(step.edgeUuid!)}
                              className="ws-numeric shrink-0 rounded-md border border-border px-2 py-0.5 font-mono text-[10px] text-text-muted hover:border-amber-400/50 hover:text-amber-300 cursor-pointer"
                            >
                              {step.correlationR !== undefined
                                ? `r=${step.correlationR.toFixed(2)}`
                                : "link"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </details>
    </div>
  );
}
