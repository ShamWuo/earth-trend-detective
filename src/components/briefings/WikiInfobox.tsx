"use client";

import React from "react";
import { DATASET_BY_ID } from "@/lib/datasets";
import { resolveNamedEarthRegion } from "@/lib/research/curatedTrendDossiers";
import { describeGeographicZone, formatCoordShort } from "@/lib/plainLanguage";
import type { ETGNode, ETGResearchDossier } from "@/types/etg";
import { extractInfoboxSeries } from "./wikiArticleUtils";

export interface PaperFigureBlockProps {
  node: ETGNode;
  title: string;
  dossier: ETGResearchDossier;
  figureNumber?: number;
}

function formatIsoShort(iso?: string): string {
  if (!iso) return "Unspecified";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatPValueShort(p?: number): string {
  if (typeof p !== "number" || !Number.isFinite(p)) return "—";
  if (p < 0.0001) return "< 0.0001";
  return `${p.toFixed(4)}${p < 0.05 ? " (sig.)" : " (n.s.)"}`;
}

export function PaperFigureBlock({
  node,
  title,
  dossier,
  figureNumber = 1,
}: PaperFigureBlockProps) {
  const p = node.properties;
  const datasetMeta = p.dataset ? DATASET_BY_ID[p.dataset] : undefined;

  const hasGeo =
    typeof p.lat === "number" &&
    Number.isFinite(p.lat) &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lng);

  const markerX = hasGeo ? ((p.lng! + 180) / 360) * 300 : null;
  const markerY = hasGeo ? ((90 - p.lat!) / 180) * 150 : null;

  const regionText = hasGeo
    ? p.region?.trim() || resolveNamedEarthRegion(p.lat!, p.lng!, title)
    : p.region?.trim() || "Planetary / multi-basin domain";

  const zoneText = hasGeo ? describeGeographicZone(p.lat!, p.lng!) : null;
  const infoboxSeries = extractInfoboxSeries(node);

  // Build Panel (b): Empirical Trajectory SVG
  let seriesPanel: React.ReactNode = null;
  if (infoboxSeries && infoboxSeries.points.length >= 2) {
    const W = 300;
    const H = 128;
    const padX = 10;
    const padY = 12;
    const spanY = Math.max(1e-6, infoboxSeries.maxVal - infoboxSeries.minVal);
    const pts = infoboxSeries.points;

    const coords = pts.map((pt, idx) => {
      const x = padX + (idx / (pts.length - 1)) * (W - padX * 2);
      const y = padY + (1 - (pt.value - infoboxSeries.minVal) / spanY) * (H - padY * 2);
      return { x, y };
    });

    const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const first = coords[0];
    const last = coords[coords.length - 1];
    const areaPoints = `${first.x.toFixed(1)},${H - padY} ${polylinePoints} ${last.x.toFixed(1)},${H - padY}`;
    const latestVal = pts[pts.length - 1].value;

    seriesPanel = (
      <div className="min-w-0">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11px] font-medium text-[var(--paper-ink-muted)]">
          <span>
            <strong className="font-semibold text-[var(--paper-ink)]">(b)</strong> Observed trajectory
          </span>
          <span className="font-mono text-[10.5px] tabular-nums">
            Latest {latestVal.toFixed(2)} {infoboxSeries.unit}
          </span>
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Observed time series from ${infoboxSeries.startLabel} to ${infoboxSeries.endLabel}`}
          className="h-auto w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)]"
        >
          <polygon points={areaPoints} fill="var(--paper-accent)" fillOpacity="0.1" />
          <line
            x1={first.x}
            y1={first.y}
            x2={last.x}
            y2={last.y}
            stroke="var(--paper-ink-muted)"
            strokeWidth="1"
            strokeDasharray="3 3"
            strokeOpacity="0.55"
          />
          <polyline
            fill="none"
            stroke="var(--paper-accent)"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polylinePoints}
          />
          <circle cx={last.x} cy={last.y} r="3" fill="var(--paper-accent)" />
        </svg>
        <div className="mt-1 flex items-center justify-between text-[10.5px] font-mono text-[var(--paper-ink-muted)] tabular-nums">
          <span>{infoboxSeries.startLabel}</span>
          <span>
            Range {infoboxSeries.minVal.toFixed(1)}–{infoboxSeries.maxVal.toFixed(1)}{" "}
            {infoboxSeries.unit}
          </span>
          <span>{infoboxSeries.endLabel}</span>
        </div>
      </div>
    );
  }

  const slopeVal = typeof p.theil_sen_slope === "number" ? p.theil_sen_slope : undefined;
  const slopeSign = slopeVal !== undefined && slopeVal > 0 ? "+" : "";
  const effectiveP = typeof p.p_value_adjusted === "number" ? p.p_value_adjusted : p.p_value;

  const corroborationSummary =
    p.status === "Superseded"
      ? "Superseded revision"
      : p.contested
        ? `Contested (${p.contradicting_sources_count ?? 1} opposing check${(p.contradicting_sources_count ?? 1) === 1 ? "" : "s"})`
        : p.corroborated
          ? `Corroborated (${Math.max(2, Math.round(p.independent_sources_count ?? 2))} sources)`
          : "Single-source telemetry";

  const primarySource =
    p.provenance_source || datasetMeta?.sourceName || p.source_system || "NASA / NOAA Telemetry";

  const showTwoColumns = Boolean(seriesPanel);

  return (
    <figure className="my-6 border-y border-[var(--paper-rule)] bg-[var(--paper-surface)]/55 px-4 py-4 font-sans">
      <div
        className={`grid grid-cols-1 gap-4 ${showTwoColumns ? "md:grid-cols-2" : ""}`}
      >
        {/* Panel (a): Spatial Domain Locator */}
        <div className="min-w-0">
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11px] font-medium text-[var(--paper-ink-muted)]">
            <span>
              <strong className="font-semibold text-[var(--paper-ink)]">(a)</strong> Spatial domain
            </span>
            <span className="truncate font-mono text-[10.5px]">
              {hasGeo ? formatCoordShort(p.lat!, p.lng!) : zoneText ?? "Global"}
            </span>
          </div>
          <svg
            viewBox="0 0 300 150"
            role="img"
            aria-label={
              hasGeo
                ? `Spatial domain map centered on ${formatCoordShort(p.lat!, p.lng!)}`
                : "Global Earth-system spatial domain"
            }
            className="h-auto w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)]"
          >
            <line
              x1="0"
              y1="25"
              x2="300"
              y2="25"
              stroke="var(--paper-rule)"
              strokeWidth="0.6"
              strokeDasharray="2 2"
            />
            <line
              x1="0"
              y1="75"
              x2="300"
              y2="75"
              stroke="var(--paper-rule)"
              strokeWidth="0.7"
              strokeDasharray="3 2"
            />
            <line
              x1="0"
              y1="125"
              x2="300"
              y2="125"
              stroke="var(--paper-rule)"
              strokeWidth="0.6"
              strokeDasharray="2 2"
            />
            <line
              x1="150"
              y1="0"
              x2="150"
              y2="150"
              stroke="var(--paper-rule)"
              strokeWidth="0.5"
              strokeDasharray="2 2"
            />

            <g fill="var(--paper-surface)" stroke="var(--paper-ink-muted)" strokeOpacity="0.45" strokeWidth="0.55">
              <path d="M 12 22 L 50 15 L 95 18 L 106 34 L 96 47 L 82 54 L 74 63 L 64 56 L 52 46 L 28 32 Z" />
              <path d="M 96 8 L 132 7 L 128 24 L 104 24 Z" />
              <path d="M 84 67 L 104 67 L 121 82 L 108 106 L 94 121 L 88 104 L 82 78 Z" />
              <path d="M 142 36 L 154 22 L 176 17 L 184 34 L 170 43 L 144 43 Z" />
              <path d="M 137 46 L 168 46 L 188 60 L 191 74 L 174 103 L 159 101 L 153 76 L 136 62 Z" />
              <path d="M 183 22 L 225 14 L 288 18 L 286 35 L 264 52 L 246 70 L 222 68 L 204 56 L 184 48 Z" />
              <path d="M 244 86 L 274 85 L 278 102 L 264 110 L 244 104 Z" />
              <path d="M 0 138 L 300 138 L 300 150 L 0 150 Z" />
            </g>

            {markerX !== null && markerY !== null && (
              <g>
                <line
                  x1={markerX}
                  y1="0"
                  x2={markerX}
                  y2="150"
                  stroke="var(--paper-accent)"
                  strokeWidth="0.65"
                  strokeOpacity="0.5"
                />
                <line
                  x1="0"
                  y1={markerY}
                  x2="300"
                  y2={markerY}
                  stroke="var(--paper-accent)"
                  strokeWidth="0.65"
                  strokeOpacity="0.5"
                />
                <circle
                  cx={markerX}
                  cy={markerY}
                  r="7"
                  fill="var(--paper-accent)"
                  fillOpacity="0.22"
                  stroke="var(--paper-accent)"
                  strokeWidth="1"
                />
                <circle
                  cx={markerX}
                  cy={markerY}
                  r="3"
                  fill="var(--paper-accent)"
                  stroke="#ffffff"
                  strokeWidth="1"
                />
              </g>
            )}
          </svg>
        </div>

        {seriesPanel}
      </div>

      {/* Horizontal Empirical Parameter Strip */}
      <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--paper-rule)] pt-3 text-[11.5px] sm:grid-cols-4">
        <div>
          <dt className="text-[10.5px] uppercase tracking-wide text-[var(--paper-ink-muted)]">
            Theil–Sen slope
          </dt>
          <dd className="mt-0.5 font-mono font-medium tabular-nums text-[var(--paper-ink)]">
            {slopeVal !== undefined
              ? `${slopeSign}${slopeVal.toFixed(3)} ${p.slope_unit || datasetMeta?.slopeUnit || "unit/yr"}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[10.5px] uppercase tracking-wide text-[var(--paper-ink-muted)]">
            Mann–Kendall <i>p</i>
          </dt>
          <dd className="mt-0.5 font-mono font-medium tabular-nums text-[var(--paper-ink)]">
            {formatPValueShort(effectiveP)}
          </dd>
        </div>
        <div>
          <dt className="text-[10.5px] uppercase tracking-wide text-[var(--paper-ink-muted)]">
            Corroboration
          </dt>
          <dd className="mt-0.5 font-medium text-[var(--paper-ink)]">{corroborationSummary}</dd>
        </div>
        <div>
          <dt className="text-[10.5px] uppercase tracking-wide text-[var(--paper-ink-muted)]">
            Primary source
          </dt>
          <dd className="mt-0.5 truncate font-medium text-[var(--paper-ink)]" title={primarySource}>
            {primarySource}
          </dd>
        </div>
      </dl>

      <figcaption className="mt-2.5 text-[12px] leading-relaxed text-[var(--paper-ink-muted)]">
        <strong className="font-semibold text-[var(--paper-ink)]">Figure {figureNumber}.</strong>{" "}
        Spatial domain and empirical telemetry summary for {regionText}
        {hasGeo ? ` (${formatCoordShort(p.lat!, p.lng!)})` : ""}
        {zoneText ? ` in ${zoneText}` : ""}.{" "}
        {typeof p.confidence === "number" ? `Confidence: ${Math.round(p.confidence * 100)}%. ` : ""}
        {p.observed_at ? `Observed window: ${formatIsoShort(p.observed_at)}; ` : ""}
        last revised {formatIsoShort(dossier.updated_at)}.
      </figcaption>
    </figure>
  );
}
