"use client";

import { useRef, useState } from "react";
import { Crosshair, Minus, Pause, Plus, Rotate3d, RotateCw } from "lucide-react";

interface GraphCameraDockProps {
  showOrbitControls?: boolean;
  isOrbiting?: boolean;
  onToggleOrbit?: () => void;
  onStepRotate?: () => void;
  onRecenter: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export function GraphCameraDock({
  showOrbitControls = true,
  isOrbiting = false,
  onToggleOrbit,
  onStepRotate,
  onRecenter,
  onZoomIn,
  onZoomOut,
  orientation = "horizontal",
  className = "",
}: GraphCameraDockProps) {
  const isVertical = orientation === "vertical";
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const btnBase = isVertical
    ? "inline-flex min-h-8 min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-sm border border-transparent px-1 py-1 text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
    : "inline-flex min-h-7 min-w-7 items-center justify-center rounded-sm border border-transparent text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer";

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const prevKey = isVertical ? "ArrowUp" : "ArrowLeft";
    const nextKey = isVertical ? "ArrowDown" : "ArrowRight";
    if (![prevKey, nextKey, "Home", "End"].includes(e.key)) return;
    const buttons = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    if (buttons.length === 0) return;
    const current = buttons.findIndex((b) => b === document.activeElement);
    const idx = current >= 0 ? current : activeIndex;
    let next = idx;
    if (e.key === prevKey) next = (idx - 1 + buttons.length) % buttons.length;
    if (e.key === nextKey) next = (idx + 1) % buttons.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = buttons.length - 1;
    e.preventDefault();
    setActiveIndex(next);
    buttons[next]?.focus();
  };

  let tabCounter = 0;
  const nextTabIndex = () => {
    const idx = tabCounter++;
    return idx === activeIndex ? 0 : -1;
  };

  return (
    <div
      ref={toolbarRef}
      {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
      onKeyDown={handleKeyDown}
      className={`etg-hud-pill inline-flex items-center rounded-md bg-surface ${
        isVertical ? "flex-col gap-1 p-1.5" : "gap-0.5 p-1"
      } ${className}`}
      role="toolbar"
      aria-orientation={orientation}
      aria-label="Camera controls"
    >
      {showOrbitControls && onToggleOrbit && (
        <button
          type="button"
          tabIndex={nextTabIndex()}
          onClick={onToggleOrbit}
          title={
            isOrbiting
              ? "Slow camera orbit (active — click to pause)"
              : "Slow camera orbit (paused — click to resume)"
          }
          aria-label="Slow camera orbit"
          aria-pressed={isOrbiting}
          className={`${btnBase} aria-pressed:border-accent-fg aria-pressed:bg-amber-100 aria-pressed:text-amber-900 dark:aria-pressed:bg-amber-950 dark:aria-pressed:text-amber-300`}
        >
          {isOrbiting ? (
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isVertical && (
            <span className="font-mono text-[9px] leading-none">Orbit</span>
          )}
        </button>
      )}

      {showOrbitControls && onStepRotate && (
        <button
          type="button"
          tabIndex={nextTabIndex()}
          onClick={onStepRotate}
          title="Rotate 35°"
          aria-label="Rotate 35 degrees"
          className={btnBase}
        >
          <Rotate3d className="h-3.5 w-3.5" aria-hidden="true" />
          {isVertical && <span className="font-mono text-[9px] leading-none">35°</span>}
        </button>
      )}

      <button
        type="button"
        tabIndex={nextTabIndex()}
        onClick={onRecenter}
        title="Recenter view"
        aria-label="Recenter view"
        className={btnBase}
      >
        <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
        {isVertical && <span className="font-mono text-[9px] leading-none">Reset</span>}
      </button>

      <div
        role="separator"
        aria-orientation={isVertical ? "horizontal" : "vertical"}
        className={
          isVertical
            ? "my-0.5 w-full border-t border-border"
            : "mx-0.5 h-4 border-l border-border"
        }
      />

      <button
        type="button"
        tabIndex={nextTabIndex()}
        onClick={onZoomIn}
        title="Zoom in"
        aria-label="Zoom in"
        className={btnBase}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        {isVertical && <span className="font-mono text-[9px] leading-none">+</span>}
      </button>

      <button
        type="button"
        tabIndex={nextTabIndex()}
        onClick={onZoomOut}
        title="Zoom out"
        aria-label="Zoom out"
        className={btnBase}
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        {isVertical && <span className="font-mono text-[9px] leading-none">-</span>}
      </button>
    </div>
  );
}
