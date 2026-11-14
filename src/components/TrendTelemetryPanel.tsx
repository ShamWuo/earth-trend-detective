"use client";

import React, { useId, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, GitCompare, PlusCircle, TrendingDown, TrendingUp } from "lucide-react";
import { EARTH_TREND_DATASETS } from "@/lib/datasets";
import type {
  CrossRegionComparison,
  ETGDatasetId,
  TrendAnalysisSummary,
} from "@/types/etg";

interface TrendTelemetryPanelProps {
  primary: TrendAnalysisSummary | null;
  secondary?: TrendAnalysisSummary | null;
  comparison?: CrossRegionComparison | null;
  loading: boolean;
  error?: string | null;
  onChangeDataset: (ds: ETGDatasetId) => void;
  onCommitToGraph: (summary: TrendAnalysisSummary) => Promise<void>;
  onClearComparison?: () => void;
}

export function TrendTelemetryPanel({
  primary,
  secondary,
  comparison,
  loading,
  error,
  onChangeDataset,
  onCommitToGraph,
  onClearComparison,
}: TrendTelemetryPanelProps) {
  const captionId = useId();
  const [committing, setCommitting] = useState(false);
  const [committedMsg, setCommittedMsg] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="space-y-5 p-7">
        <div className="h-6 w-48 animate-pulse rounded-lg bg-surface-elevated" />
        <div className="h-28 w-full animate-pulse rounded-2xl bg-surface-elevated" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-20 animate-pulse rounded-2xl bg-surface-elevated" />
          <div className="h-20 animate-pulse rounded-2xl bg-surface-elevated" />
        </div>
        <div className="h-44 w-full animate-pulse rounded-2xl bg-surface-elevated" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-7">
        <div role="status" className="flex items-start gap-2.5 rounded-2xl border border-rose-500/35 bg-rose-500/10 p-5 text-xs leading-relaxed text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
          <div>
            <div className="font-semibold text-rose-200">Upstream Telemetry Unavailable</div>
            <p className="mt-1 text-rose-300/90">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!primary) {
    return (
      <div className="p-7 text-sm leading-relaxed text-text-muted">
        Click any coordinate on the 3D Earth Globe or select a signal node in the Knowledge Graph
        to compute live NASA/NOAA time-series and Mann-Kendall trend significance.
      </div>
    );
  }

  const isSignificant = primary.mannKendall.significant;
  const isIncreasing = primary.mannKendall.direction === "increasing";

  // Build SVG path coordinates
  const svgW = 360;
  const svgH = 184;
  const padX = 28;
  const padY = 20;
  const plotW = svgW - padX * 2;
  const plotH = svgH - padY * 2;

  const showOverlay = Boolean(comparison && comparison.alignedPoints.length >= 3);
  const pts = primary.points;

  let minY = Math.min(...pts.map((p) => Math.min(p.value, p.theilSenFit)));
  let maxY = Math.max(...pts.map((p) => Math.max(p.value, p.theilSenFit)));
  if (showOverlay && comparison) {
    const zs = comparison.alignedPoints.flatMap((p) => [p.zA, p.zB]);
    minY = Math.min(...zs, -2);
    maxY = Math.max(...zs, 2);
  }
  const spanY = Math.max(1e-6, maxY - minY);

  const mapX = (i: number, len: number) =>
    padX + (len <= 1 ? 0 : (i / (len - 1)) * plotW);
  const mapY = (v: number) => padY + plotH - ((v - minY) / spanY) * plotH;

  const rawPath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${mapX(i, pts.length).toFixed(1)} ${mapY(p.value).toFixed(1)}`)
    .join(" ");
  const senPath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${mapX(i, pts.length).toFixed(1)} ${mapY(p.theilSenFit).toFixed(1)}`)
    .join(" ");

  const overlayAPath =
    showOverlay && comparison
      ? comparison.alignedPoints
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"} ${mapX(i, comparison.alignedPoints.length).toFixed(1)} ${mapY(p.zA).toFixed(1)}`
          )
          .join(" ")
      : "";
  const overlayBPath =
    showOverlay && comparison
      ? comparison.alignedPoints
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"} ${mapX(i, comparison.alignedPoints.length).toFixed(1)} ${mapY(p.zB).toFixed(1)}`
          )
          .join(" ")
      : "";

  const handleCommit = async () => {
    setCommitting(true);
    setCommittedMsg(null);
    try {
      await onCommitToGraph(primary);
      setCommittedMsg("Recorded in communal ETG.");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="space-y-7 p-7 text-sm">
      {/* Header & Dataset Switcher */}
      <div className="space-y-3.5 border-b border-border pb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="ws-eyebrow">Coordinate Telemetry</div>
            <div className="ws-numeric mt-0.5 font-mono text-lg font-semibold text-text-primary">
              {primary.lat >= 0 ? `${primary.lat.toFixed(2)}°N` : `${Math.abs(primary.lat).toFixed(2)}°S`},{" "}
              {primary.lng >= 0 ? `${primary.lng.toFixed(2)}°E` : `${Math.abs(primary.lng).toFixed(2)}°W`}
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-border bg-surface-inset px-2.5 py-1 text-[11px] font-medium text-text-subtle">
            {primary.provenance === "NASA POWER MERRA-2 (Live)"
              ? "NASA POWER Live"
              : primary.provenance === "NASA GES DISC / POWER Hydrology (Live)"
                ? "GES DISC Hydrology"
                : primary.provenance === "NASA GISTEMP v4 (Live)"
                  ? "NASA GISTEMP v4"
                  : primary.provenance === "NOAA GML CO2 (Live)"
                    ? "NOAA GML CO₂"
                    : primary.provenance === "NOAA/NSIDC Sea Ice v4 (Live)"
                      ? "NOAA/NSIDC v4"
                      : primary.provenance === "NOAA NCEI CDO (Live)"
                        ? "NOAA NCEI CDO"
                        : primary.provenance === "KNMI Climate Explorer (Live)"
                          ? "KNMI Explorer"
                          : primary.provenance === "CSA / Geo.ca Hydrometric & AHCCD (Live)"
                            ? "CSA / Geo.ca"
                            : primary.provenance === "USGS / NASA SeaWiFS Coastal Plume (Live)"
                              ? "USGS / SeaWiFS"
                              : "Imported Dataset"}
          </span>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="telemetry-ds-select" className="block text-xs font-medium text-text-subtle">
            Earth Variable
          </label>
          <select
            id="telemetry-ds-select"
            value={primary.dataset}
            onChange={(e) => onChangeDataset(e.target.value as ETGDatasetId)}
            className="w-full rounded-xl border border-border bg-surface-inset px-3 py-2 text-sm text-text-primary focus:border-accent-fg focus:outline-none"
          >
            {EARTH_TREND_DATASETS.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Hero Statistical Verdict Card */}
      <div
        className={`rounded-2xl border p-5 ${
          isSignificant
            ? isIncreasing
              ? "border-rose-500/35 bg-rose-500/10"
              : "border-sky-500/35 bg-sky-500/10"
            : "border-border bg-surface-inset"
        }`}
      >
        <div className="flex items-center gap-2.5 text-base font-semibold text-text-primary">
          {isSignificant ? (
            isIncreasing ? (
              <TrendingUp className="h-5 w-5 shrink-0 text-rose-400" aria-hidden="true" />
            ) : (
              <TrendingDown className="h-5 w-5 shrink-0 text-sky-400" aria-hidden="true" />
            )
          ) : (
            <Activity className="h-5 w-5 shrink-0 text-text-subtle" aria-hidden="true" />
          )}
          <span>{primary.verdict}</span>
        </div>
        <p className="mt-2.5 text-sm leading-relaxed text-text-muted">
          {isSignificant
            ? `Mann-Kendall rejects the null hypothesis of stationarity (p = ${primary.mannKendall.pValue.toFixed(4)} < 0.05).`
            : `No monotonic directional shift exceeds α = 0.05 (p = ${primary.mannKendall.pValue.toFixed(4)}). Fluctuations remain within expected environmental variability.`}
        </p>
      </div>

      {/* Mann-Kendall & Theil-Sen Callouts */}
      <div className="grid grid-cols-2 gap-4">
        <div className="ws-inset rounded-2xl p-4">
          <div className="ws-eyebrow">Mann-Kendall p-value</div>
          <div className="ws-numeric mt-2 font-mono text-xl font-semibold text-text-primary">
            {primary.mannKendall.pValue < 0.0001
              ? "< 0.0001"
              : primary.mannKendall.pValue.toFixed(4)}
          </div>
          <div className="ws-numeric mt-1.5 font-mono text-xs text-text-subtle">
            Z = {primary.mannKendall.zScore.toFixed(2)} · τ = {primary.mannKendall.tau.toFixed(2)}
          </div>
        </div>

        <div className="ws-inset rounded-2xl p-4">
          <div className="ws-eyebrow">Theil-Sen Slope</div>
          <div className="ws-numeric mt-2 font-mono text-xl font-semibold text-text-primary">
            {primary.theilSen.slope >= 0 ? "+" : ""}
            {primary.theilSen.slope.toFixed(3)}
            <span className="ml-1 text-xs font-normal text-text-muted">{primary.slopeUnit}</span>
          </div>
          <div className="ws-numeric mt-1.5 font-mono text-xs text-text-subtle">
            95% CI [{primary.theilSen.slopeLow95.toFixed(2)}, {primary.theilSen.slopeHigh95.toFixed(2)}]
          </div>
        </div>
      </div>

      {/* Cross-Region Comparison Banner */}
      {showOverlay && comparison && secondary && (
        <div className="space-y-2.5 rounded-2xl border border-rose-500/35 bg-rose-500/10 p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-rose-400">
              <GitCompare className="h-4 w-4" aria-hidden="true" />
              {comparison.classification === "opposite_teleconnection"
                ? "Opposite-Trend Dipole Confirmed"
                : comparison.classification === "co_trending"
                  ? "Co-Trending Teleconnection"
                  : "Weakly Coupled Regions"}
            </div>
            {onClearComparison && (
              <button
                type="button"
                onClick={onClearComparison}
                className="text-xs font-medium text-text-subtle hover:text-text-primary cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
          <div className="ws-numeric font-mono text-xs text-text-primary">
            Pearson r = {comparison.pearsonR.toFixed(2)} · Spearman ρ ={" "}
            {comparison.spearmanRho.toFixed(2)} · p = {comparison.pValue.toFixed(4)}
          </div>
          <p className="text-xs leading-relaxed text-text-muted">
            Comparing primary ({primary.lat.toFixed(1)}°, {primary.lng.toFixed(1)}°) vs.{" "}
            ({secondary.lat.toFixed(1)}°, {secondary.lng.toFixed(1)}°) in normalized Z-score units.
          </p>
        </div>
      )}

      {/* Time-Series SVG Chart */}
      <div className="ws-inset rounded-2xl p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="ws-eyebrow">
            {showOverlay
              ? "Dual-Region Normalized Z-Score"
              : `${primary.parameter} (${pts[0]?.date ?? ""}–${pts[pts.length - 1]?.date ?? ""})`}
          </span>
          <span className="ws-numeric font-mono text-[11px] text-text-subtle">
            {showOverlay ? "Sky: Region A · Rose: Region B" : "Dashed: Theil-Sen Fit"}
          </span>
        </div>

        <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full overflow-visible" role="img" aria-label="Time-series chart">
          <line x1={padX} y1={padY} x2={padX} y2={svgH - padY} stroke="currentColor" className="text-border" strokeWidth="1" />
          <line x1={padX} y1={svgH - padY} x2={svgW - padX} y2={svgH - padY} stroke="currentColor" className="text-border" strokeWidth="1" />

          {showOverlay ? (
            <>
              <path d={overlayAPath} fill="none" stroke="#38bdf8" strokeWidth="2.2" />
              <path d={overlayBPath} fill="none" stroke="#f43f5e" strokeWidth="2.2" />
            </>
          ) : (
            <>
              <path d={senPath} fill="none" stroke="#f59e0b" strokeWidth="1.75" strokeDasharray="4 3" />
              <path d={rawPath} fill="none" stroke="#38bdf8" strokeWidth="2.2" />
              {pts.map((p, i) => {
                if (pts.length > 22 && i !== 0 && i !== pts.length - 1 && i % 4 !== 0) {
                  return null;
                }
                return (
                  <circle
                    key={p.date}
                    cx={mapX(i, pts.length)}
                    cy={mapY(p.value)}
                    r={pts.length > 22 ? "2.5" : "3"}
                    fill="#38bdf8"
                  />
                );
              })}
            </>
          )}

          <text x={padX} y={svgH - 2} fontSize="9.5" className="fill-text-subtle font-mono">
            {pts[0]?.date}
          </text>
          <text x={svgW - padX} y={svgH - 2} textAnchor="end" fontSize="9.5" className="fill-text-subtle font-mono">
            {pts[pts.length - 1]?.date}
          </text>
          <text x={padX - 5} y={padY + 4} textAnchor="end" fontSize="9" className="fill-text-subtle font-mono">
            {maxY.toFixed(1)}
          </text>
          <text x={padX - 5} y={svgH - padY} textAnchor="end" fontSize="9" className="fill-text-subtle font-mono">
            {minY.toFixed(1)}
          </text>
        </svg>
      </div>

      {/* Primary Commit CTA */}
      <div className="space-y-2.5">
        <button
          type="button"
          onClick={handleCommit}
          disabled={committing}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-60 cursor-pointer"
        >
          <PlusCircle className="h-4 w-4" aria-hidden="true" />
          {committing
            ? "Recording in ETG…"
            : `Record ${isSignificant ? "Insight" : "Signal"} at (${primary.lat.toFixed(1)}°, ${primary.lng.toFixed(1)}°)`}
        </button>

        {committedMsg && (
          <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {committedMsg}
          </div>
        )}
      </div>

      {/* Progressive Disclosure: Autocorrelation, OLS & Pettitt Change-Point */}
      <details className="etg-details">
        <summary>Autocorrelation, OLS &amp; Regime-Shift Diagnostics</summary>
        <div className="p-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="ws-inset rounded-2xl p-4">
              <div className="ws-eyebrow">Hamed-Rao Adj. MK</div>
              <div className="ws-numeric mt-1.5 font-mono text-sm font-semibold text-text-primary">
                {primary.mannKendall.pValueAdjusted < 0.0001
                  ? "p* < 0.0001"
                  : `p* = ${primary.mannKendall.pValueAdjusted.toFixed(4)}`}
              </div>
              <div className="ws-numeric mt-1 font-mono text-[11px] text-text-subtle">
                ρ₁ = {primary.mannKendall.lag1Autocorrelation.toFixed(2)} · n* ={" "}
                {primary.mannKendall.effectiveSampleSize.toFixed(1)}/{primary.mannKendall.n}
              </div>
            </div>

            <div className="ws-inset rounded-2xl p-4">
              <div className="ws-eyebrow">OLS &amp; Regime Shift</div>
              <div className="ws-numeric mt-1.5 font-mono text-sm font-semibold text-text-primary">
                R² = {primary.ols.rSquared.toFixed(2)} ·{" "}
                {primary.ols.pValue < 0.0001 ? "p < .0001" : `p = ${primary.ols.pValue.toFixed(3)}`}
              </div>
              <div className="ws-numeric mt-1 font-mono text-[11px] text-text-subtle">
                {primary.changePoint?.significant
                  ? `Pettitt shift: ${primary.changePoint.date} (p=${primary.changePoint.pValue.toFixed(3)})`
                  : "No abrupt regime shift"}
              </div>
            </div>
          </div>
        </div>
      </details>

      {/* Progressive Disclosure: Annual Telemetry Ledger */}
      <details className="etg-details">
        <summary id={captionId}>
          Annual Telemetry Ledger ({primary.points.length} yrs)
        </summary>
        <div className="p-4">
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={captionId}
            className="etg-table-region"
            style={
              {
                "--col-2": `"Value (${primary.unit})"`,
                "--col-3": '"Theil-Sen Fit"',
                "--col-4": '"Z-Score"',
              } as React.CSSProperties
            }
          >
            <table>
              <caption className="sr-only">Annual Earth observation telemetry and trend fit</caption>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  <th scope="col">Value ({primary.unit})</th>
                  <th scope="col">Theil-Sen Fit</th>
                  <th scope="col">Anomaly Z</th>
                </tr>
              </thead>
              <tbody>
                {[...primary.points].reverse().map((pt) => (
                  <tr key={pt.date}>
                    <th scope="row" className="ws-numeric font-mono">
                      {pt.date}
                    </th>
                    <td className="ws-numeric font-mono">{pt.value.toFixed(2)}</td>
                    <td className="ws-numeric font-mono">{pt.theilSenFit.toFixed(2)}</td>
                    <td
                      className={`ws-numeric font-mono ${
                        pt.zScore > 1.2
                          ? "text-rose-400"
                          : pt.zScore < -1.2
                            ? "text-sky-400"
                            : "text-text-muted"
                      }`}
                    >
                      {pt.zScore >= 0 ? "+" : ""}
                      {pt.zScore.toFixed(2)}σ
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}
