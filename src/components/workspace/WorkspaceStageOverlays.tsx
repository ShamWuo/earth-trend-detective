"use client";

import React from "react";
import { Compass, GitCompare, MapPin, RefreshCw, Sun, X } from "lucide-react";
import {
  GUIDED_DIPOLE_CASES,
  type GuidedDipoleCase,
  type WorkspaceViewMode,
} from "./workspaceDipolesAndUtils";

export function WorkspaceStageBanner({
  statusMessage,
  compareMode,
  compareStep = 1,
  viewMode,
  aiStudioOpen,
  inspectorOpen,
  inspectorWide = false,
  onDismissStatus,
  onCancelCompare,
}: {
  statusMessage: string | null;
  compareMode: boolean;
  compareStep?: 1 | 2;
  viewMode: WorkspaceViewMode;
  aiStudioOpen: boolean;
  inspectorOpen: boolean;
  inspectorWide?: boolean;
  onDismissStatus: () => void;
  onCancelCompare: () => void;
}) {
  if (!statusMessage && !(compareMode && viewMode === "globe")) {
    return null;
  }

  const rightOffsetClass = inspectorOpen
    ? inspectorWide
      ? "sm:right-[26rem] lg:right-[33.5rem] xl:right-[36rem]"
      : "sm:right-[26rem] lg:right-[28.5rem] xl:right-[30.5rem]"
    : "sm:right-2.5";

  return (
    <div
      className={`pointer-events-none absolute z-30 flex justify-center max-sm:inset-x-2.5 ${
        viewMode === "globe"
          ? inspectorOpen
            ? "max-sm:top-[8.75rem]"
            : "max-sm:bottom-16"
          : "max-sm:top-14"
      } ${
        !statusMessage && compareMode && inspectorOpen ? "max-lg:hidden" : ""
      } ${
        viewMode === "globe"
          ? `${aiStudioOpen ? "sm:max-lg:left-[316px] lg:left-12" : "sm:left-12"} ${rightOffsetClass} sm:bottom-20`
          : `${aiStudioOpen ? "sm:max-lg:left-[316px] lg:left-4" : "sm:left-4"} ${rightOffsetClass} sm:top-12`
      }`}
    >
      {statusMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="etg-hud-pill pointer-events-auto flex max-w-[min(500px,100%)] items-center gap-2 rounded-md bg-surface px-2.5 py-1 text-[11px] font-medium text-text-primary shadow-lg"
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
          className="etg-hud-pill pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-2 rounded-md border border-amber-400 bg-surface px-2.5 py-1 text-[11px] font-medium text-text-primary shadow-lg"
        >
          <GitCompare className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          <span className="truncate">
            {compareStep === 2
              ? "Compare (Step 2/2): click a second point on Earth"
              : "Compare (Step 1/2): click your first location on Earth"}
          </span>
          <button
            type="button"
            onClick={onCancelCompare}
            className="shrink-0 rounded-xs border border-border bg-surface-elevated px-1.5 py-0.5 text-[10.5px] font-semibold text-text-muted hover:text-text-primary cursor-pointer"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceMissionCard({
  nodeCount,
  edgeCount,
  onInspectBoulder,
  onRunCaseStudy,
  onDismiss,
}: {
  nodeCount: number;
  edgeCount: number;
  onInspectBoulder: () => void;
  onRunCaseStudy: (preset: GuidedDipoleCase) => void;
  onDismiss: () => void;
}) {
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <aside
      aria-label="Observatory quick guide and color key"
      className="etg-hud-pill pointer-events-auto absolute top-2.5 right-2.5 z-20 hidden w-[min(284px,calc(100dvw-2rem))] space-y-2 rounded-lg border border-border bg-surface/95 p-2.5 text-xs shadow-2xl backdrop-blur-md sm:block"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="inline-flex items-center gap-1 font-mono text-[9.5px] font-semibold uppercase tracking-wider text-accent-fg">
            <Compass className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>Observatory Guide</span>
          </div>
          <h3 className="font-outfit text-[13px] font-semibold leading-snug text-text-primary">
            Verify shifts &amp; opposite-trend links
          </h3>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss observatory guide"
          title="Dismiss guide (re-open anytime from ? in header)"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-subtle hover:bg-surface-hover hover:text-text-primary cursor-pointer"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <p className="text-[11px] leading-snug text-text-muted">
        Click Earth for 30-yr Mann-Kendall stats &amp; NASA imagery ({nodeCount} sites, {edgeCount}{" "}
        links).
      </p>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-sm border border-border bg-surface-inset px-2 py-1 text-[10px] text-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-rose-400" aria-hidden="true" />
          Opposite
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
          Causal
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
          Site pin
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-sky-400" aria-hidden="true" />
          A↔B
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={onInspectBoulder}
          className="inline-flex items-center gap-1 rounded-sm bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-white transition-colors hover:bg-accent-hover cursor-pointer"
        >
          <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Boulder, CO</span>
        </button>
        {GUIDED_DIPOLE_CASES.slice(0, 2).map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.subtitle}
            onClick={() => onRunCaseStudy(preset)}
            className="rounded-sm border border-border bg-surface-elevated px-2 py-0.5 text-[10.5px] font-medium text-text-primary transition-colors hover:border-rose-400 cursor-pointer"
          >
            {preset.shortLabel}
          </button>
        ))}
      </div>
    </aside>
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
  onOpenAgencyHub,
}: {
  discoverBusy: boolean;
  onDiscoverGlobalTrends: () => void;
  onMaterializeSolarGraph: () => void;
  onOpenAgencyHub: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
      <div className="etg-hud-pill pointer-events-auto max-w-md space-y-2.5 rounded-md bg-surface p-4 text-center shadow-2xl">
        <div className="mx-auto inline-flex items-center gap-1.5 rounded-sm border border-amber-400/50 bg-amber-950/60 px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-amber-300">
          Local-Only Graph · No Database Configured
        </div>
        <h3 className="font-outfit text-base font-semibold text-text-primary">
          Build &amp; Connect the Earth Trend Knowledge Graph
        </h3>
        <p className="text-[11.5px] leading-relaxed text-text-muted">
          Ingest live NASA/NOAA/CSA streams or load the 7-node Front Range solar microgrid graph.
          Graph state is stored locally on this instance only (no shared database is set up yet).
        </p>
        <div className="flex flex-wrap items-center justify-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={onDiscoverGlobalTrends}
            disabled={discoverBusy}
            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
            {discoverBusy ? "Loading Live Data…" : "Load Live NASA / NOAA / CSA Trends"}
          </button>
          <button
            type="button"
            disabled={discoverBusy}
            onClick={onMaterializeSolarGraph}
            className="inline-flex items-center gap-1.5 rounded-sm border border-amber-400 bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:border-accent-fg disabled:opacity-50 cursor-pointer"
          >
            <Sun className="h-3.5 w-3.5" />
            Load 7-Node Solar Predictive Graph
          </button>
          <button
            type="button"
            onClick={onOpenAgencyHub}
            className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            Space Agency Hub (12)
          </button>
        </div>
      </div>
    </div>
  );
}
