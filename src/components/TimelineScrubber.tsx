"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import type { ETGNode } from "@/types/etg";

interface TimelineScrubberProps {
  nodes: ETGNode[];
  cutoffMs: number;
  minMs: number;
  maxMs: number;
  onChangeCutoff: (nextMs: number) => void;
  visibleCount: number;
}

export const TIMELINE_SLIDER_STEPS = 1000;

/**
 * Converts a timestamp cutoff into a normalized integer slider step in [0, totalSteps].
 */
export function cutoffMsToSliderStep(
  cutoffMs: number,
  safeMin: number,
  safeMax: number,
  totalSteps = TIMELINE_SLIDER_STEPS
): number {
  const span = Math.max(1, safeMax - safeMin);
  const clamped = Math.max(safeMin, Math.min(safeMax, cutoffMs));
  return Math.round(((clamped - safeMin) / span) * totalSteps);
}

/**
 * Maps a normalized slider step back to an exact timestamp cutoff, preserving exact min/max bounds.
 */
export function sliderStepToCutoffMs(
  step: number,
  safeMin: number,
  safeMax: number,
  totalSteps = TIMELINE_SLIDER_STEPS
): number {
  if (!Number.isFinite(step) || step <= 0) return safeMin;
  if (step >= totalSteps) return safeMax;
  return Math.round(safeMin + (step / totalSteps) * (safeMax - safeMin));
}

export function TimelineScrubber({
  nodes,
  cutoffMs,
  minMs,
  maxMs,
  onChangeCutoff,
  visibleCount,
}: TimelineScrubberProps) {
  const sliderId = useId();
  const rangeRef = useRef<HTMLInputElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState<1 | 2>(1);

  const safeMin = Math.min(minMs, maxMs - 86_400_000);
  const safeMax = Math.max(maxMs, safeMin + 86_400_000);
  const clampedCutoff = Math.max(safeMin, Math.min(safeMax, cutoffMs));
  const sliderStep = cutoffMsToSliderStep(clampedCutoff, safeMin, safeMax);

  const cutoffRef = useRef(clampedCutoff);
  cutoffRef.current = clampedCutoff;
  const onChangeCutoffRef = useRef(onChangeCutoff);
  onChangeCutoffRef.current = onChangeCutoff;

  // Sync normalized CSS custom properties on the range input to avoid 13-digit epoch float precision loss
  useEffect(() => {
    const el = rangeRef.current;
    if (!el) return;
    el.style.setProperty("--attr-min", "0");
    el.style.setProperty("--attr-max", String(TIMELINE_SLIDER_STEPS));
    el.style.setProperty("--control-value", String(sliderStep));
    el.style.setProperty(
      "--slider-progress",
      `${((sliderStep / TIMELINE_SLIDER_STEPS) * 100).toFixed(1)}%`
    );
  }, [sliderStep]);

  useEffect(() => {
    if (!isPlaying) return;
    const span = safeMax - safeMin;
    const stepMs = (span / 90) * speedMultiplier;
    const timer = window.setInterval(() => {
      const next = cutoffRef.current + stepMs;
      if (next >= safeMax) {
        cutoffRef.current = safeMax;
        onChangeCutoffRef.current(safeMax);
        setIsPlaying(false);
      } else {
        cutoffRef.current = next;
        onChangeCutoffRef.current(next);
      }
    }, 140);
    return () => window.clearInterval(timer);
  }, [isPlaying, safeMin, safeMax, speedMultiplier]);

  const togglePlay = () => {
    if (!isPlaying && clampedCutoff >= safeMax - 3_600_000) {
      onChangeCutoff(safeMin);
    }
    setIsPlaying((prev) => !prev);
  };

  const formattedDate = new Date(clampedCutoff).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  const compactFormattedDate = new Date(clampedCutoff).toLocaleDateString("en-US", {
    year: "2-digit",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  // Compute observation ticks along the timeline (downsampled above 36 for clarity)
  const ticks = React.useMemo(() => {
    const span = Math.max(1, safeMax - safeMin);
    const raw = nodes
      .map((n) => {
        const ts = Date.parse(n.properties.observed_at || n.properties.created_at);
        if (Number.isNaN(ts)) return null;
        const pct = Math.max(0, Math.min(100, ((ts - safeMin) / span) * 100));
        return { uuid: n.uuid, pct, label: n.label, status: n.properties.status };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (raw.length <= 36) return raw;
    const stride = Math.ceil(raw.length / 36);
    return raw.filter((_, idx) => idx % stride === 0 || idx === raw.length - 1);
  }, [nodes, safeMin, safeMax]);

  return (
    <div
      className="etg-scrubber-cq etg-hud-pill rounded-md bg-surface px-2 py-0.5 shadow-xl"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-nowrap items-center gap-1.5 whitespace-nowrap">
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause timeline replay" : "Play timeline replay"}
            title={isPlaying ? "Pause timeline replay" : "Replay observations over time"}
            className="etg-hud-btn inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-surface-elevated px-1.5 text-[11px] font-medium text-text-primary hover:border-border-strong cursor-pointer"
          >
            {isPlaying ? (
              <Pause className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Play className="h-3 w-3" aria-hidden="true" />
            )}
            <span className="etg-scrubber-play-label">{isPlaying ? "Pause" : "Play"}</span>
          </button>

          <button
            type="button"
            onClick={() => setSpeedMultiplier((s) => (s === 1 ? 2 : 1))}
            className="etg-hud-btn ws-numeric h-6 rounded-sm border border-border bg-surface-inset px-1.5 text-[10.5px] font-medium text-text-muted hover:text-text-primary cursor-pointer"
            title="Toggle replay speed"
          >
            {speedMultiplier}×
          </button>
        </div>

        <div className="min-w-[44px] flex-1">
          <div className="relative h-1 w-full" aria-hidden="true">
            {ticks.map((t) => (
              <span
                key={t.uuid}
                style={{ left: `${t.pct}%` }}
                className={`absolute top-0 h-1 w-0.5 -translate-x-1/2 ${
                  t.status === "Superseded"
                    ? "bg-amber-400"
                    : t.label === "Insight"
                      ? "bg-accent-fg"
                      : "bg-text-faint"
                }`}
              />
            ))}
          </div>
          <input
            ref={rangeRef}
            id={sliderId}
            type="range"
            aria-label="Observed At cutoff date"
            className="etg-slider"
            min={0}
            max={TIMELINE_SLIDER_STEPS}
            step={1}
            value={sliderStep}
            aria-valuetext={`Cutoff date: ${formattedDate} — ${visibleCount} of ${nodes.length} nodes active`}
            onInput={(e) => {
              const inputEl = e.currentTarget;
              const step = Number(inputEl.value);
              inputEl.style.setProperty("--control-value", inputEl.value);
              inputEl.style.setProperty(
                "--slider-progress",
                `${((step / TIMELINE_SLIDER_STEPS) * 100).toFixed(1)}%`
              );
            }}
            onChange={(e) => {
              setIsPlaying(false);
              onChangeCutoff(
                sliderStepToCutoffMs(Number(e.target.value), safeMin, safeMax)
              );
            }}
          />
        </div>

        <div className="flex shrink-0 items-center gap-1.5 text-[10.5px]">
          <span
            className="ws-numeric whitespace-nowrap font-mono font-medium text-text-primary"
            title={formattedDate}
          >
            {compactFormattedDate}
          </span>
          <span className="etg-scrubber-count ws-numeric text-[9.5px] text-text-subtle">
            ({visibleCount}/{nodes.length})
          </span>
          <button
            type="button"
            onClick={() => {
              setIsPlaying(false);
              onChangeCutoff(safeMax);
            }}
            aria-label="Latest observations"
            title="Reset timeline to latest observations"
            className="etg-hud-btn inline-flex h-6 w-6 items-center justify-center rounded-sm border border-border bg-surface-inset text-text-muted hover:bg-surface-hover hover:text-text-primary cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
