"use client";

import React from "react";
import { GitCompare, Plus, RefreshCw, Sun, X } from "lucide-react";
import {
  GUIDED_DIPOLE_CASES,
  type GuidedDipoleCase,
  type WorkspaceViewMode,
} from "./workspaceDipolesAndUtils";

export function WorkspaceStageBanner({
  statusMessage,
  compareMode,
  viewMode,
  aiStudioOpen,
  inspectorOpen,
  onDismissStatus,
  onCancelCompare,
}: {
  statusMessage: string | null;
  compareMode: boolean;
  viewMode: WorkspaceViewMode;
  aiStudioOpen: boolean;
  inspectorOpen: boolean;
  onDismissStatus: () => void;
  onCancelCompare: () => void;
}) {
  if (!statusMessage && !(compareMode && viewMode === "globe")) {
    return null;
  }

  return (
    <div
      className={`pointer-events-none absolute z-30 flex justify-center max-sm:inset-x-2.5 max-sm:top-16 ${
        viewMode === "globe"
          ? aiStudioOpen
            ? "sm:bottom-20 sm:left-4 sm:right-auto sm:top-auto sm:justify-start"
            : inspectorOpen
              ? "sm:top-16 sm:inset-x-4 min-[1160px]:top-3 min-[1160px]:left-[428px] min-[1160px]:right-[418px]"
              : "sm:top-3 sm:left-[428px] sm:right-4"
          : inspectorOpen
            ? "sm:top-3 sm:left-4 sm:right-[426px]"
            : "sm:top-3 sm:inset-x-4"
      }`}
    >
      {statusMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="etg-hud-pill pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-2 rounded-md bg-surface px-3.5 py-1.5 text-xs font-medium text-text-primary shadow-lg"
        >
          <span className="truncate">{statusMessage}</span>
          <button
            type="button"
            onClick={onDismissStatus}
            aria-label="Dismiss notification"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-subtle hover:bg-surface-hover hover:text-text-primary cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className="etg-hud-pill pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-2 rounded-md border border-amber-400 bg-surface px-3.5 py-1.5 text-xs font-medium text-text-primary shadow-lg"
        >
          <GitCompare className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          <span className="truncate">
            Compare mode active — click a second point or pin on the 3D Earth
          </span>
          <button
            type="button"
            onClick={onCancelCompare}
            className="shrink-0 rounded-xs border border-border bg-surface-elevated px-1.5 py-0.5 text-[11px] font-semibold text-text-muted hover:text-text-primary cursor-pointer"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceGlobeEmptyPrompt({
  discoverBusy,
  onDiscoverGlobalTrends,
  onRunCaseStudy,
}: {
  discoverBusy: boolean;
  onDiscoverGlobalTrends: () => void;
  onRunCaseStudy: (preset: GuidedDipoleCase) => void;
}) {
  return (
    <div className="pointer-events-none absolute top-3 inset-x-0 z-20 flex justify-center px-4">
      <div className="etg-hud-pill pointer-events-auto flex max-w-4xl flex-wrap items-center justify-center gap-2 rounded-md bg-surface px-4 py-1.5 text-xs shadow-lg">
        <span className="text-text-muted">Click Earth to probe, or try:</span>
        <button
          type="button"
          onClick={onDiscoverGlobalTrends}
          disabled={discoverBusy}
          className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1 font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw
            className={`h-3 w-3 ${discoverBusy ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span>{discoverBusy ? "Loading Live Data…" : "Load Live Global Pins"}</span>
        </button>
        {GUIDED_DIPOLE_CASES.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.subtitle}
            onClick={() => onRunCaseStudy(preset)}
            className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-rose-400 cursor-pointer"
          >
            {preset.shortLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceGraphEmptyPrompt({
  discoverBusy,
  onDiscoverGlobalTrends,
  onMaterializeSolarGraph,
  onOpenQuickAddNode,
  onOpenAgencyHub,
}: {
  discoverBusy: boolean;
  onDiscoverGlobalTrends: () => void;
  onMaterializeSolarGraph: () => void;
  onOpenQuickAddNode: () => void;
  onOpenAgencyHub: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
      <div className="etg-hud-pill pointer-events-auto max-w-lg space-y-4 rounded-md bg-surface p-6 text-center shadow-2xl">
        <div className="mx-auto inline-flex items-center gap-2 rounded-sm border border-teal-400 bg-teal-950 px-3 py-1 font-mono text-[11px] font-semibold text-teal-300">
          Zero Seeded Data · Live Scientific Observatory
        </div>
        <h3 className="font-outfit text-lg font-semibold text-text-primary">
          Build &amp; Connect the Earth Trend Knowledge Graph
        </h3>
        <p className="text-xs leading-relaxed text-text-muted">
          Ingest live NASA/NOAA/CSA streams, load the 7-node Front Range solar microgrid graph
          to benchmark graph-aware prediction, or create your own phenomenon nodes and link
          causes across the world.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={onDiscoverGlobalTrends}
            disabled={discoverBusy}
            className="inline-flex items-center gap-2 rounded-sm bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
            {discoverBusy ? "Loading Live Data…" : "Load Live NASA / NOAA / CSA Trends"}
          </button>
          <button
            type="button"
            disabled={discoverBusy}
            onClick={onMaterializeSolarGraph}
            className="inline-flex items-center gap-1.5 rounded-sm border border-amber-400 bg-amber-950 px-4 py-2 text-xs font-semibold text-amber-300 hover:border-accent-fg disabled:opacity-50 cursor-pointer"
          >
            <Sun className="h-3.5 w-3.5" />
            Load 7-Node Solar Predictive Graph
          </button>
          <button
            type="button"
            onClick={onOpenQuickAddNode}
            className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-4 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            Create Phenomenon Node
          </button>
          <button
            type="button"
            onClick={onOpenAgencyHub}
            className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-4 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            Space Agency Hub (12)
          </button>
        </div>
      </div>
    </div>
  );
}
