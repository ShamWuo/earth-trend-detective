"use client";

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

  return (
    <div
      className={`etg-hud-pill inline-flex items-center rounded-full ${
        isVertical ? "flex-col gap-1 p-1.5" : "gap-0.5 p-1"
      } ${className}`}
      role="toolbar"
      aria-label="Camera controls"
    >
      {showOrbitControls && onToggleOrbit && (
        <button
          type="button"
          onClick={onToggleOrbit}
          title={isOrbiting ? "Pause slow orbit" : "Resume slow orbit"}
          aria-label={isOrbiting ? "Pause slow orbit" : "Resume slow orbit"}
          aria-pressed={isOrbiting}
          className={`inline-flex min-h-8 min-w-8 items-center justify-center rounded-full transition-colors cursor-pointer ${
            isOrbiting
              ? "bg-accent/18 text-accent-fg"
              : "text-text-muted hover:bg-surface-band hover:text-text-primary"
          }`}
        >
          {isOrbiting ? (
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      )}

      {showOrbitControls && onStepRotate && (
        <button
          type="button"
          onClick={onStepRotate}
          title="Rotate 35°"
          aria-label="Rotate 35 degrees"
          className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
        >
          <Rotate3d className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}

      <button
        type="button"
        onClick={onRecenter}
        title="Recenter view"
        aria-label="Recenter view"
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
      >
        <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <div
        className={isVertical ? "my-0.5 h-px w-4 bg-border" : "mx-0.5 h-4 w-px bg-border"}
        aria-hidden="true"
      />

      <button
        type="button"
        onClick={onZoomIn}
        title="Zoom in"
        aria-label="Zoom in"
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onZoomOut}
        title="Zoom out"
        aria-label="Zoom out"
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
