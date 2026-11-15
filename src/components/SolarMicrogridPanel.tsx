"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  BatteryCharging,
  BatteryFull,
  Compass,
  GitBranchPlus,
  Loader2,
  Network,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import type { SolarGraphAnalysisResult } from "@/lib/solar/denverClimateGraph";

interface SolarMicrogridPanelProps {
  open: boolean;
  onClose: () => void;
  onFocusDenver?: () => void;
  onMaterializeInGraph?: () => Promise<void> | void;
}

export function SolarMicrogridPanel({
  open,
  onClose,
  onFocusDenver,
  onMaterializeInGraph,
}: SolarMicrogridPanelProps) {
  const titleId = useId();
  const comparisonTableHeadingId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [data, setData] = useState<SolarGraphAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Mandatory closedby="any" bounding-box fallback for browsers without HTMLDialogElement.prototype.closedBy
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) dialog.close("backdrop");
      pressedOutside = false;
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  const handleNativeClose = () => {
    const dialog = dialogRef.current;
    if (dialog) dialog.returnValue = "";
    onClose();
  };

  const loadAnalysis = async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/earth/solar-graph?startYear=2019${forceRefresh ? "&refresh=1" : ""}`;
      const res = await fetch(url);
      const json = (await res.json().catch(() => null)) as
        | (SolarGraphAnalysisResult & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      if (!json || !("nodes" in json)) {
        throw new Error("Unexpected response from solar graph endpoint");
      }
      setData(json as SolarGraphAnalysisResult);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : "Failed to load solar graph";
      const friendlyMsg = /failed to fetch|networkerror|load failed/i.test(rawMsg)
        ? "Could not reach the local Earth Trend server (/api/earth/solar-graph). Make sure the Next.js server for this tab is running and click Retry."
        : rawMsg;
      setError(friendlyMsg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && !data && !loading) {
      void loadAnalysis();
    }
  }, [open, data, loading]);

  const renderClimateGraphSvg = (d: SolarGraphAnalysisResult) => {
    const w = 360;
    const h = 230;
    const cx = w / 2;
    const cy = h / 2;
    const target = d.nodes.find((n) => n.role === "target") ?? d.nodes[0];

    const posFor = (lat: number, lng: number) => {
      const dx = (lng - target.lng) * 65; // ~scale to fit 360x230
      const dy = -(lat - target.lat) * 72;
      return {
        x: Math.max(36, Math.min(w - 36, cx + dx)),
        y: Math.max(26, Math.min(h - 26, cy + dy)),
      };
    };

    const windRad = ((d.tomorrow.windFromDeg - 90) * Math.PI) / 180;
    const arrowLen = 38;
    const wx1 = cx + Math.cos(windRad) * arrowLen;
    const wy1 = cy + Math.sin(windRad) * arrowLen;

    return (
      <svg
        role="img"
        aria-label={`7-node Front Range solar irradiance and wind graph showing wind from ${d.tomorrow.windFromDeg} degrees at ${d.tomorrow.windSpeedMs} meters per second`}
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-56 rounded-md bg-zinc-950 border border-zinc-800"
      >
        <defs>
          <marker
            id="wind-arrow"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill="#f59e0b" />
          </marker>
        </defs>
        <circle cx={cx} cy={cy} r={88} fill="none" stroke="#27272a" strokeDasharray="3 3" />
        <text x={10} y={16} fill="#fbbf24" fontSize="9" fontFamily="monospace">
          Wind FROM {d.tomorrow.windFromDeg}° @ {d.tomorrow.windSpeedMs} m/s
        </text>
        {/* Edges from neighbors to Denver */}
        {d.nodes
          .filter((n) => n.role === "upwind_neighbor")
          .map((n) => {
            const p = posFor(n.lat, n.lng);
            const isUpwind = n.upwindWeight > 0.15;
            return (
              <line
                key={`edge-${n.id}`}
                x1={p.x}
                y1={p.y}
                x2={cx}
                y2={cy}
                stroke={isUpwind ? (n.upwindWeight > 0.55 ? "#38bdf8" : "#0284c7") : "#334155"}
                strokeWidth={isUpwind ? 1.5 + n.upwindWeight * 2.5 : 1}
                strokeDasharray={isUpwind ? undefined : "3 3"}
              />
            );
          })}
        {/* Wind vector pointing INTO Denver from upwind */}
        <line
          x1={wx1}
          y1={wy1}
          x2={cx}
          y2={cy}
          stroke="#f59e0b"
          strokeWidth={2}
          markerEnd="url(#wind-arrow)"
        />
        {/* Neighbor nodes */}
        {d.nodes
          .filter((n) => n.role === "upwind_neighbor")
          .map((n) => {
            const p = posFor(n.lat, n.lng);
            const active = n.upwindWeight > 0.15;
            return (
              <g key={n.id}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={active ? 11 : 8}
                  fill={active ? "#082f49" : "#1e293b"}
                  stroke={active ? "#38bdf8" : "#64748b"}
                  strokeWidth={1.5}
                />
                <text
                  x={p.x}
                  y={p.y + 3}
                  textAnchor="middle"
                  fill="#f8fafc"
                  fontSize="8"
                  fontFamily="monospace"
                >
                  {n.direction}
                </text>
                <text
                  x={p.x}
                  y={p.y + 18}
                  textAnchor="middle"
                  fill="#cbd5e1"
                  fontSize="7.5"
                  fontFamily="monospace"
                >
                  {n.latestAllsky} ({n.upwindWeight.toFixed(1)})
                </text>
              </g>
            );
          })}
        {/* Target Denver node */}
        <circle cx={cx} cy={cy} r={13} fill="#78350f" stroke="#fbbf24" strokeWidth={2} />
        <text x={cx} y={cy + 3} textAnchor="middle" fill="#fef3c7" fontSize="8" fontWeight="bold">
          DEN
        </text>
      </svg>
    );
  };

  const renderSparkline = (series: SolarGraphAnalysisResult["recentTestSeries"]) => {
    if (series.length < 2) return null;
    const w = 620;
    const h = 130;
    const pad = 12;
    const maxVal = Math.max(8, ...series.map((d) => Math.max(d.actual, d.graph, d.persistence)));
    const xAt = (idx: number) =>
      pad + (idx / Math.max(1, series.length - 1)) * (w - pad * 2);
    const yAt = (val: number) =>
      h - pad - (Math.max(0, val) / maxVal) * (h - pad * 2);

    const pathFor = (vals: number[]) =>
      vals.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

    const threshY = yAt(3.5);

    return (
      <svg
        role="img"
        aria-label="Recent 45 unseen test days comparing actual solar irradiance against Graph-Aware and Persistence forecasts"
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-32 rounded-sm bg-zinc-950 border border-zinc-800"
      >
        <line
          x1={pad}
          y1={threshY}
          x2={w - pad}
          y2={threshY}
          stroke="#d97706"
          strokeDasharray="4 4"
          strokeWidth={1}
        />
        <text x={pad + 4} y={threshY - 4} fill="#fbbf24" fontSize="9">
          3.5 kWh/m²/d Battery Pre-Charge Threshold
        </text>
        <path
          d={pathFor(series.map((d) => d.persistence))}
          fill="none"
          stroke="#64748b"
          strokeWidth={1.25}
          strokeDasharray="3 3"
        />
        <path
          d={pathFor(series.map((d) => d.actual))}
          fill="none"
          stroke="#f8fafc"
          strokeWidth={2}
        />
        <path
          d={pathFor(series.map((d) => d.graph))}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={2}
        />
      </svg>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={handleNativeClose}
      style={{ maxInlineSize: "min(94vw, 900px)", maxBlockSize: "90dvh" }}
      className="etg-dialog bg-[#0c0d10] text-[#f5f3ee]"
      {...({ closedby: "any" } as Record<string, unknown>)}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-[#0c0d10] px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-950 border border-amber-400 text-amber-300">
            <Sun className="h-5 w-5" />
          </div>
          <div>
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              Denver Solar Microgrid — Local Climate Graph
            </h2>
            <p className="text-xs text-zinc-400">
              7-Node Front Range Upwind Graph · NASA POWER Daily (
              <code className="rounded-xs border border-zinc-800 bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-200">
                ALLSKY_SFC_SW_DWN
              </code>
              ) + Open-Meteo 18:00–23:00 Evening Advection · Strict Temporal Split
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onMaterializeInGraph && (
            <button
              type="button"
              disabled={materializing}
              onClick={async () => {
                setMaterializing(true);
                try {
                  await onMaterializeInGraph();
                  dialogRef.current?.close();
                } finally {
                  setMaterializing(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-sm border border-amber-400 bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:border-amber-300 disabled:opacity-50 cursor-pointer"
            >
              <GitBranchPlus className="h-3.5 w-3.5" />
              {materializing ? "Materializing…" : "Materialize in Knowledge Graph"}
            </button>
          )}
          {onFocusDenver && (
            <button
              type="button"
              onClick={() => {
                onFocusDenver();
                dialogRef.current?.close();
              }}
              className="inline-flex items-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-3 py-1.5 text-xs font-medium text-sky-300 hover:border-sky-300 cursor-pointer"
            >
              <Network className="h-3.5 w-3.5" />
              Focus Denver on Globe
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadAnalysis(true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-sm border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => dialogRef.current?.close("close-button")}
            className="rounded-sm p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white cursor-pointer"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading && !data && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-zinc-300">
              <Loader2 className="h-7 w-7 animate-spin text-amber-400" />
              <p className="text-sm">
                Fetching 2019–2026 NASA POWER daily irradiance &amp; Open-Meteo 18:00–23:00 evening advection across 7 Front Range nodes...
              </p>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-400 bg-rose-950 p-4 text-sm text-rose-200"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void loadAnalysis(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-rose-300 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-zinc-800 cursor-pointer"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          )}

          {data && (
            <>
              {/* Decision Banner */}
              <div
                className={`rounded-md border p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4 ${
                  data.tomorrow.chargeBatteryOvernight || data.tomorrow.bayesOptimalPrecharge
                    ? "border-amber-400 bg-amber-950"
                    : "border-emerald-400 bg-emerald-950"
                }`}
              >
                <div className="flex items-start gap-3">
                  {data.tomorrow.chargeBatteryOvernight || data.tomorrow.bayesOptimalPrecharge ? (
                    <BatteryCharging className="h-6 w-6 text-amber-300 shrink-0 mt-0.5" />
                  ) : (
                    <BatteryFull className="h-6 w-6 text-emerald-300 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                        Microgrid Decision ({data.tomorrow.forecastDate})
                      </span>
                      <span
                        className={`rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${
                          data.tomorrow.chargeBatteryOvernight
                            ? "border-amber-400 bg-zinc-900 text-amber-300"
                            : "border-emerald-400 bg-zinc-900 text-emerald-300"
                        }`}
                      >
                        {data.tomorrow.chargeBatteryOvernight
                          ? `PRE-CHARGE OVERNIGHT (${data.tomorrow.recommendedReservePct}% Reserve)`
                          : `SOLAR SUFFICIENT (${data.tomorrow.recommendedReservePct}% Reserve)`}
                      </span>
                      <span className="rounded-sm border border-sky-400 bg-zinc-900 px-2 py-0.5 text-[11px] font-mono text-sky-200">
                        Storm Risk P(ALLSKY &lt; 3.5): {data.tomorrow.probStormPct.toFixed(1)}%
                      </span>
                      <span
                        className={`rounded-sm border px-2 py-0.5 text-[11px] font-semibold font-mono ${
                          data.tomorrow.bayesOptimalPrecharge
                            ? "border-amber-300 bg-zinc-900 text-amber-200"
                            : "border-emerald-300 bg-zinc-900 text-emerald-200"
                        }`}
                      >
                        Bayes Optimal: {data.tomorrow.bayesOptimalPrecharge ? "PRE-CHARGE" : "HOLD"}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-200 mt-1.5 leading-relaxed">
                      {data.tomorrow.rationale}
                    </p>
                    <p className="mt-1.5 text-[11px] font-mono text-zinc-300">
                      Expected Shortfall Penalty (@ $0.205/kWh):{" "}
                      <span className="text-amber-200">
                        ${data.tomorrow.expectedShortfallPenaltyUsd.toFixed(2)}
                      </span>{" "}
                      vs. False-Precharge Risk (from ${data.tomorrow.prechargeCycleCostUsd.toFixed(2)} cycle):{" "}
                      <span className="text-sky-200">
                        ${data.tomorrow.expectedFalsePrechargeCostUsd.toFixed(2)}
                      </span>{" "}
                      (Net Bayes benefit:{" "}
                      <span className="text-emerald-200">
                        {data.tomorrow.bayesExpectedNetSavingsUsd >= 0 ? "+" : "-"}$
                        {Math.abs(data.tomorrow.bayesExpectedNetSavingsUsd).toFixed(2)}
                      </span>
                      )
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 shrink-0 text-center">
                  <div className="rounded-sm bg-zinc-950 px-3 py-2 border border-zinc-800">
                    <div className="text-[10px] text-zinc-400">Persistence</div>
                    <div className="text-sm font-semibold">{data.tomorrow.persistencePred}</div>
                  </div>
                  <div className="rounded-sm bg-zinc-950 px-3 py-2 border border-zinc-800">
                    <div className="text-[10px] text-zinc-400">Local Daily</div>
                    <div className="text-sm font-semibold">{data.tomorrow.localDailyPred}</div>
                  </div>
                  <div className="rounded-sm bg-zinc-950 px-3 py-2 border border-zinc-800">
                    <div className="text-[10px] text-zinc-400">Local+Eve</div>
                    <div className="text-sm font-semibold">{data.tomorrow.localPred}</div>
                  </div>
                  <div className="rounded-sm bg-sky-950 px-3 py-2 border border-sky-400">
                    <div className="text-[10px] text-sky-300">Graph+Eve</div>
                    <div className="text-sm font-semibold text-sky-200">{data.tomorrow.graphPred}</div>
                  </div>
                </div>
              </div>

              {/* K-12 Microgrid Economic & Storm-Shortfall Impact */}
              {data.economics && (
                <section
                  aria-label="K-12 Microgrid Economic and Storm-Shortfall Impact"
                  className="rounded-md border border-emerald-500/40 bg-emerald-950/25 p-4 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                      K-12 Microgrid Economic &amp; Bayes Probabilistic Dispatch Impact
                    </div>
                    <span className="text-[11px] font-mono text-zinc-300">
                      Threshold τ = {data.economics.graphPolicy.thresholdKwh.toFixed(2)} · Bayes break-even τ* ≈ {data.economics.probabilisticGraphPolicy.thresholdKwh.toFixed(2)} kWh/m²/d
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                    <div className="rounded-sm border border-zinc-800 bg-zinc-950 px-3 py-2">
                      <div className="text-[10px] text-zinc-400">Threshold Net Savings</div>
                      <div className="text-sm font-semibold font-mono text-emerald-300">
                        {data.economics.annualSavingsVsPersistenceUsd >= 0 ? "+" : "-"}$
                        {Math.abs(data.economics.annualSavingsVsPersistenceUsd).toFixed(0)}/yr
                      </div>
                    </div>
                    <div className="rounded-sm border border-sky-700/60 bg-zinc-950 px-3 py-2">
                      <div className="text-[10px] text-sky-300">Bayes Net Savings</div>
                      <div className="text-sm font-semibold font-mono text-sky-200">
                        {data.economics.bayesAnnualSavingsVsPersistenceUsd >= 0 ? "+" : "-"}$
                        {Math.abs(data.economics.bayesAnnualSavingsVsPersistenceUsd).toFixed(0)}/yr
                      </div>
                    </div>
                    <div className="rounded-sm border border-zinc-800 bg-zinc-950 px-3 py-2">
                      <div className="text-[10px] text-zinc-400">Bayes Storm Recall</div>
                      <div className="text-sm font-semibold font-mono text-sky-300">
                        {data.economics.probabilisticGraphPolicy.stormCaptureRecallPct.toFixed(1)}%
                      </div>
                    </div>
                    <div className="rounded-sm border border-zinc-800 bg-zinc-950 px-3 py-2">
                      <div className="text-[10px] text-zinc-400">Annual Penalty (Bayes)</div>
                      <div className="text-sm font-semibold font-mono text-zinc-100">
                        ${data.economics.probabilisticGraphPolicy.annualizedPenaltyUsd.toFixed(0)}/yr
                      </div>
                    </div>
                    <div className="rounded-sm border border-zinc-800 bg-zinc-950 px-3 py-2">
                      <div className="text-[10px] text-zinc-400">Annual Penalty (Persist)</div>
                      <div className="text-sm font-semibold font-mono text-zinc-400">
                        ${data.economics.persistencePolicy.annualizedPenaltyUsd.toFixed(0)}/yr
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] text-zinc-300">
                    <span className="font-medium text-zinc-100">{data.economics.schoolSpec}</span> —{" "}
                    {data.economics.tariffSpec}. Single-threshold τ misses{" "}
                    <span className="font-mono text-emerald-300">
                      {data.economics.graphPolicy.stormShortfallDays} / {data.economics.graphPolicy.totalLowSolarDays}
                    </span>{" "}
                    events (${data.economics.graphPolicy.annualizedPenaltyUsd.toFixed(0)}/yr), whereas leak-free Bayes expected-cost dispatch ($26.25 cycle vs. $0.205/kWh shortfall) misses{" "}
                    <span className="font-mono text-sky-300">
                      {data.economics.probabilisticGraphPolicy.stormShortfallDays} / {data.economics.probabilisticGraphPolicy.totalLowSolarDays}
                    </span>{" "}
                    events (vs. {data.economics.persistencePolicy.stormShortfallDays} with Persistence).
                  </p>
                </section>
              )}

              {/* 4-Way Comparison Table */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <h3 id={comparisonTableHeadingId} className="text-sm font-semibold">
                    4-Way Ablation Comparison on Unseen Test Dates ({data.testRange}, n={data.testDays} days)
                  </h3>
                  <span className="text-[11px] text-zinc-400">
                    Train: {data.trainRange} ({data.trainDays} days)
                  </span>
                </div>
                <div
                  tabIndex={0}
                  role="region"
                  aria-labelledby={comparisonTableHeadingId}
                  className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 focus-visible:outline-2 focus-visible:outline-sky-400"
                >
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">
                      4-way forecasting, calibrated storm risk Brier score, and overnight charge threshold evaluation on unseen test dates
                    </caption>
                    <thead className="bg-zinc-900 text-zinc-300">
                      <tr>
                        <th scope="col" className="px-3 py-2.5">Model</th>
                        <th scope="col" className="px-3 py-2.5">RMSE (kWh/m²/d)</th>
                        <th scope="col" className="px-3 py-2.5">MAE</th>
                        <th scope="col" className="px-3 py-2.5">R²</th>
                        <th scope="col" className="px-3 py-2.5">Skill vs Persist</th>
                        <th scope="col" className="px-3 py-2.5">Low-Solar F1 (&lt;3.5)</th>
                        <th scope="col" className="px-3 py-2.5">Storm Brier</th>
                        <th scope="col" className="px-3 py-2.5">Calibrated τ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {[
                        data.metrics.persistence,
                        data.metrics.localDailyOnly,
                        data.metrics.localOnly,
                        data.metrics.graphAware,
                      ].map((m, idx) => (
                        <tr
                          key={m.name}
                          className={idx === 3 ? "bg-sky-950 text-sky-100" : "text-zinc-200"}
                        >
                          <th scope="row" className="px-3 py-2.5 font-medium">{m.name}</th>
                          <td className="px-3 py-2.5 font-mono">{m.rmse.toFixed(3)}</td>
                          <td className="px-3 py-2.5 font-mono">{m.mae.toFixed(3)}</td>
                          <td className="px-3 py-2.5 font-mono">{m.r2.toFixed(3)}</td>
                          <td className="px-3 py-2.5 font-mono">
                            {(m.skillVsPersistence * 100).toFixed(1)}%
                          </td>
                          <td className="px-3 py-2.5 font-mono">{m.lowSolarF1.toFixed(3)}</td>
                          <td className="px-3 py-2.5 font-mono">{m.stormBrierScore.toFixed(3)}</td>
                          <td className="px-3 py-2.5 font-mono">
                            {(m.calibratedThreshold ?? 3.5).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] text-zinc-400">
                  Clear-Sky-Adjusted Persistence RMSE:{" "}
                  <span className="font-mono text-zinc-200">{data.metrics.clearSkyPersistenceRmse.toFixed(3)}</span> ·{" "}
                  Paired Error Significance (Graph vs. Persistence:{" "}
                  <span className="font-mono text-emerald-300">p={data.metrics.graphVsPersistPValue}</span>, Graph vs. Local-Only:{" "}
                  <span className="font-mono text-sky-300">p={data.metrics.graphVsLocalPValue}</span>)
                </p>
              </div>

              {/* Sparkline */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">
                    Recent 45 Unseen Test Days — Actual vs. Graph-Aware vs. Persistence
                  </h3>
                  <div className="flex items-center gap-3 text-[11px] text-zinc-400">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-white inline-block" /> Actual
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-sky-400 inline-block" /> Graph-Aware
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-slate-400 inline-block" /> Persistence
                    </span>
                  </div>
                </div>
                {renderSparkline(data.recentTestSeries)}
              </div>

              {/* 7-Node Local Climate Graph */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5">
                    <Compass className="h-4 w-4 text-sky-400" />
                    7-Node Front Range Climate Graph (Latest Wind: {data.tomorrow.windFromDeg}° @{" "}
                    {data.tomorrow.windSpeedMs} m/s)
                  </h3>
                </div>
                <div className="mb-3">{renderClimateGraphSvg(data)}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {data.nodes.map((node) => (
                    <div
                      key={node.id}
                      className={`rounded-md border p-3 text-xs ${
                        node.role === "target"
                          ? "border-amber-400 bg-amber-950"
                          : "border-zinc-800 bg-zinc-900"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-zinc-100">{node.name}</span>
                        <span className="rounded-xs border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                          {node.direction} · {node.distanceKm} km
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 mt-1">{node.rationale}</p>
                      <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-zinc-200">
                        <span>Irrad: {node.latestAllsky} kWh/m²/d</span>
                        <span>k_t: {node.latestKt}</span>
                        <span className="text-sky-300">
                          Upwind w: {node.upwindWeight.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Concrete Failure Case */}
              <div className="rounded-md border border-rose-400 bg-rose-950 p-4">
                <div className="flex items-center gap-2 text-rose-200 text-xs font-semibold uppercase tracking-wider mb-1.5">
                  <AlertTriangle className="h-4 w-4 text-rose-400" />
                  Worst Unseen Test Failure ({data.topFailure.isoDate})
                </div>
                <p className="text-xs text-zinc-200 leading-relaxed">
                  {data.topFailure.explanation}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-[11px] font-mono text-zinc-300">
                  <span>Actual: {data.topFailure.actualAllsky}</span>
                  <span>Graph Pred: {data.topFailure.graphPred}</span>
                  <span>Local Pred: {data.topFailure.localPred}</span>
                  <span>Prev Day: {data.topFailure.prevDayAllsky}</span>
                </div>
              </div>

              {data.economics?.disclaimer && (
                <p className="rounded-sm border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-[11px] text-zinc-400 leading-relaxed">
                  {data.economics.disclaimer}
                </p>
              )}
            </>
          )}
      </div>
    </dialog>
  );
}
