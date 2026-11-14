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

  // Sync CSS custom properties on the range input for WebKit/Blink & fallback browsers
  useEffect(() => {
    const el = rangeRef.current;
    if (!el) return;
    el.style.setProperty("--attr-min", String(safeMin));
    el.style.setProperty("--attr-max", String(safeMax));
    el.style.setProperty("--control-value", String(clampedCutoff));
  }, [safeMin, safeMax, clampedCutoff]);

  useEffect(() => {
    if (!isPlaying) return;
    const span = safeMax - safeMin;
    const stepMs = (span / 65) * speedMultiplier;
    const timer = window.setInterval(() => {
      onChangeCutoff(
        clampedCutoff + stepMs >= safeMax ? safeMax : clampedCutoff + stepMs
      );
      if (clampedCutoff + stepMs >= safeMax) {
        setIsPlaying(false);
      }
    }, 110);
    return () => window.clearInterval(timer);
  }, [isPlaying, clampedCutoff, safeMin, safeMax, speedMultiplier, onChangeCutoff]);

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
    <div className="etg-scrubber-cq etg-hud-pill rounded-full px-3 py-1.5 shadow-xl">
      <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause timeline replay" : "Play timeline replay"}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-2 text-xs font-semibold text-text-primary hover:border-border-strong cursor-pointer"
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span className="etg-scrubber-play-label">{isPlaying ? "Pause" : "Replay"}</span>
          </button>

          <button
            type="button"
            onClick={() => setSpeedMultiplier((s) => (s === 1 ? 2 : 1))}
            className="ws-numeric h-8 rounded-full border border-border bg-surface-inset px-2 text-[11px] font-medium text-text-muted hover:text-text-primary cursor-pointer"
            title="Toggle replay speed"
          >
            {speedMultiplier}×
          </button>
        </div>

        <div className="min-w-[68px] flex-1">
          <div className="relative h-1.5 w-full" aria-hidden="true">
            {ticks.map((t) => (
              <span
                key={t.uuid}
                style={{ left: `${t.pct}%` }}
                className={`absolute top-0 h-1.5 w-0.5 -translate-x-1/2 ${
                  t.status === "Superseded"
                    ? "bg-amber-400/70"
                    : t.label === "Insight"
                      ? "bg-accent-fg"
                      : "bg-text-faint/60"
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
            min={safeMin}
            max={safeMax}
            step={86_400_000}
            value={clampedCutoff}
            aria-valuetext={`Cutoff date: ${formattedDate} — ${visibleCount} of ${nodes.length} nodes active`}
            onChange={(e) => {
              setIsPlaying(false);
              onChangeCutoff(Number(e.target.value));
            }}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs">
          <span className="ws-numeric font-mono font-semibold text-accent-fg">
            {formattedDate}
          </span>
          <span className="etg-scrubber-count ws-numeric text-[11px] text-text-subtle">
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
            className="inline-flex h-8 items-center gap-1 rounded-full border border-border px-2.5 text-[11px] font-medium text-text-muted hover:bg-surface-hover hover:text-text-primary cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="etg-scrubber-latest-label">Latest</span>
          </button>
        </div>
      </div>
    </div>
  );
}
