"use client";

import React from "react";
import type {
  ETGPhenomenonType,
  ETGRelationshipType,
  GraphPredictionResult,
  TimeSeriesPoint,
} from "@/types/etg";

export type WorkbenchTab = "traverse" | "predict" | "evidence";

export const PHENOMENON_OPTIONS: ReadonlyArray<{ value: ETGPhenomenonType; label: string }> = [
  { value: "climate_trend", label: "Climate Trend" },
  { value: "discrete_event", label: "Discrete Event" },
  { value: "climate_index", label: "Climate Mode / Index" },
  { value: "physical_impact", label: "Physical Impact" },
  { value: "sensor_station", label: "Sensor / Hardware Station" },
  { value: "earth_system", label: "Earth System / Domain" },
];

export const RELATIONSHIP_OPTIONS: ReadonlyArray<{ value: ETGRelationshipType; label: string }> = [
  { value: "leads", label: "LEADS (Upstream driver with lag)" },
  { value: "amplifies", label: "AMPLIFIES (Strengthens target trend)" },
  { value: "dampens", label: "DAMPENS (Suppresses / buffers target)" },
  { value: "advects_to", label: "ADVECTS TO (Weather / smoke / heat transport)" },
  { value: "triggers", label: "TRIGGERS (Initiates discrete event / regime)" },
  { value: "impacts", label: "IMPACTS (Physical or ecological consequence)" },
  { value: "drives_opposite", label: "OPPOSITE TELECONNECTION" },
  { value: "correlates_with", label: "CORRELATES WITH (Coupled series)" },
  { value: "supports", label: "SUPPORTS (Observational evidence)" },
  { value: "corroborates", label: "CORROBORATES (Independent confirmation)" },
  { value: "hypothesized_link", label: "HYPOTHESIS (Exploratory test edge)" },
  { value: "relates_to", label: "RELATES TO (General conceptual link)" },
  { value: "monitors", label: "MONITORS (Sensor observes target)" },
  { value: "verified_by", label: "VERIFIED BY (Rule / gate check)" },
];

export function parseDateToFractionalYear(dateStr: string, fallbackIndex: number): number {
  const trimmed = dateStr.trim();
  const isoMatch = trimmed.match(
    /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?Z?)?)?)?$/i
  );
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Math.min(12, Math.max(1, Number(isoMatch[2] ?? 1)));
    const day = Math.min(31, Math.max(1, Number(isoMatch[3] ?? 1)));
    const hh = Math.min(23, Math.max(0, Number(isoMatch[4] ?? 0)));
    const mm = Math.min(59, Math.max(0, Number(isoMatch[5] ?? 0)));
    const ss = Math.min(59, Math.max(0, Number(isoMatch[6] ?? 0)));
    const yearStart = Date.UTC(year, 0, 1);
    const nextYearStart = Date.UTC(year + 1, 0, 1);
    const pointMs = Date.UTC(year, month - 1, day, hh, mm, ss);
    return year + (pointMs - yearStart) / Math.max(1, nextYearStart - yearStart);
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsedMs = Date.parse(trimmed);
  if (Number.isFinite(parsedMs)) {
    const dt = new Date(parsedMs);
    const year = dt.getUTCFullYear();
    const yearStart = Date.UTC(year, 0, 1);
    const nextYearStart = Date.UTC(year + 1, 0, 1);
    return year + (parsedMs - yearStart) / Math.max(1, nextYearStart - yearStart);
  }
  return fallbackIndex;
}

export function parseSeriesText(raw: string): TimeSeriesPoint[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  // Single-line comma-separated plain numbers fallback (only when all tokens are numbers)
  if (lines.length === 1 && !lines[0].includes(":") && lines[0].includes(",")) {
    const rawTokens = lines[0].split(",").map((s) => s.trim()).filter(Boolean);
    const nums = rawTokens.map((s) => Number(s)).filter((n) => Number.isFinite(n));
    if (nums.length >= 2 && nums.length === rawTokens.length) {
      const startYear = new Date().getUTCFullYear() - nums.length + 1;
      return nums.map((value, idx) => ({
        date: String(startYear + idx),
        t: startYear + idx,
        value,
      }));
    }
  }

  const parsed: Array<{ point: TimeSeriesPoint; idx: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const delimParts = line.split(/[\t,;]+/).map((p) => p.trim()).filter(Boolean);
    let dateStr: string | null = null;
    let val: number | null = null;

    if (delimParts.length >= 2) {
      dateStr = delimParts[0];
      const n = Number(delimParts[delimParts.length - 1]);
      if (Number.isFinite(n)) val = n;
    } else {
      const colonSpace = line.match(/^(.+?):\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
      const whitespacePair = line.match(/^(\S+)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
      if (colonSpace) {
        dateStr = colonSpace[1].trim();
        val = Number(colonSpace[2]);
      } else if (whitespacePair) {
        dateStr = whitespacePair[1].trim();
        val = Number(whitespacePair[2]);
      } else {
        const single = Number(line);
        if (Number.isFinite(single)) {
          const y = 2015 + i;
          parsed.push({ point: { date: String(y), t: y, value: single }, idx: i });
          continue;
        }
      }
    }

    if (dateStr && val !== null && Number.isFinite(val)) {
      const t = parseDateToFractionalYear(dateStr, i);
      parsed.push({ point: { date: dateStr, t, value: val }, idx: i });
    }
  }

  parsed.sort((a, b) => (a.point.t !== b.point.t ? a.point.t - b.point.t : a.idx - b.idx));
  return parsed.map((entry) => entry.point);
}

export function triggerJsonDownload(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BacktestChart({
  backtest,
  isLightTheme,
}: {
  backtest: GraphPredictionResult["backtest"];
  isLightTheme: boolean;
}) {
  if (backtest.length < 2) return null;
  const w = 340;
  const h = 112;
  const pad = 10;
  const allVals = backtest.flatMap((b) => [b.actual, b.selfOnly, b.graphAware]);
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const span = Math.max(1e-6, maxV - minV);
  const xAt = (i: number) => pad + (i / (backtest.length - 1)) * (w - pad * 2);
  const yAt = (v: number) => h - pad - ((v - minV) / span) * (h - pad * 2);
  const line = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

  return (
    <div className="space-y-1.5">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-28 rounded-lg border border-border bg-surface-inset"
        aria-label="Out-of-sample holdout prediction comparison chart"
      >
        <path
          d={line(backtest.map((b) => b.selfOnly))}
          fill="none"
          stroke={isLightTheme ? "#52525b" : "#94a3b8"}
          strokeWidth={1.3}
          strokeDasharray="3 3"
        />
        <path
          d={line(backtest.map((b) => b.actual))}
          fill="none"
          stroke={isLightTheme ? "#18181b" : "#f8fafc"}
          strokeWidth={1.75}
        />
        <path
          d={line(backtest.map((b) => b.graphAware))}
          fill="none"
          stroke={isLightTheme ? "#0284c7" : "#38bdf8"}
          strokeWidth={2}
        />
      </svg>
      <div className="flex items-center justify-between text-[10px] text-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 bg-text-primary inline-block" /> Actual
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 bg-sky-400 inline-block" /> Graph Model
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 border-b border-dashed border-text-muted inline-block" /> Self AR
        </span>
      </div>
    </div>
  );
}
