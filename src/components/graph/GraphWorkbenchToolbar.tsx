"use client";

import { useEffect, useRef } from "react";
import { ArrowRight, Database, GitBranchPlus, Plus, Sparkles, Waypoints, X } from "lucide-react";
import type { RegionOption } from "@/lib/graph/regionalSubgraph";
import type { TraversalFilterState } from "@/components/graph/graphViewShared";

export interface GraphWorkbenchToolbarProps {
  renderMode: "3d" | "2d";
  isLightTheme?: boolean;
  selectedNodeName?: string | null;
  hasSelection: boolean;
  connectMode: boolean;
  connectSourceName?: string | null;
  discoveringLinks: boolean;
  candidateCount: number;
  traversalFilter: TraversalFilterState;
  inspectorOpen: boolean;
  regionOptions?: RegionOption[];
  selectedRegionScope?: string | null;
  onToggleConnectMode?: () => void;
  onOpenQuickAddNode?: () => void;
  onDiscoverLinks?: () => void;
  onClearCandidateLinks?: () => void;
  onChangeTraversalFilter?: (next: TraversalFilterState) => void;
  onChangeRegionScope?: (regionId: string | null) => void;
  onRefocusActiveRegion?: () => void;
}

/**
 * Floating top workbench toolbar for graph authoring, k-hop traversal filters,
 * causal flow toggle (2D), regional scope jump, and contextual Connect/Candidate banners.
 */
export function GraphWorkbenchToolbar({
  renderMode,
  isLightTheme: _isLightTheme,
  selectedNodeName,
  hasSelection,
  connectMode,
  connectSourceName,
  discoveringLinks,
  candidateCount,
  traversalFilter,
  inspectorOpen,
  regionOptions = [],
  selectedRegionScope = null,
  onToggleConnectMode,
  onOpenQuickAddNode,
  onDiscoverLinks,
  onClearCandidateLinks,
  onChangeTraversalFilter,
  onChangeRegionScope,
  onRefocusActiveRegion,
}: GraphWorkbenchToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // Roving tabindex fallback when native focusgroup="toolbar wrap" is unsupported
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    if (typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype) {
      return;
    }
    const selector = "button:not(:disabled), select:not(:disabled)";
    const items = Array.from(toolbar.querySelectorAll<HTMLElement>(selector));
    if (items.length === 0) return;

    items.forEach((btn, idx) => {
      if (btn.tabIndex !== 0 && idx > 0) btn.tabIndex = -1;
    });
    if (!items.some((b) => b.tabIndex === 0)) {
      items[0].tabIndex = 0;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const currentButtons = Array.from(toolbar.querySelectorAll<HTMLElement>(selector));
      const idx = currentButtons.indexOf(target);
      if (idx === -1) return;

      let nextIdx = -1;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % currentButtons.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + currentButtons.length) % currentButtons.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = currentButtons.length - 1;
      else return;

      e.preventDefault();
      currentButtons.forEach((b, i) => {
        b.tabIndex = i === nextIdx ? 0 : -1;
      });
      currentButtons[nextIdx].focus();
    };

    toolbar.addEventListener("keydown", onKeyDown);
    return () => toolbar.removeEventListener("keydown", onKeyDown);
  }, [hasSelection, renderMode, candidateCount, selectedRegionScope, regionOptions.length]);

  return (
    <div
      className={`etg-stage-hud-row pointer-events-none absolute top-2.5 left-11 z-20 flex flex-col items-center gap-1.5 transition-[right] duration-200 ${
        inspectorOpen
          ? "right-2.5 sm:right-[22.75rem] xl:right-[23.75rem]"
          : "right-2.5"
      }`}
    >
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Knowledge Graph Workbench"
        {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
        className="etg-hud-pill pointer-events-auto flex max-w-full flex-nowrap items-center gap-0.5 overflow-x-auto [scrollbar-width:none] rounded-lg bg-surface px-1.5 py-0.5 text-[10.5px] shadow-lg"
      >
        <div role="group" aria-label="Graph authoring actions" className="flex shrink-0 items-center gap-0.5">
          {onOpenQuickAddNode && (
            <button
              type="button"
              onClick={onOpenQuickAddNode}
              title="Add Node to Graph"
              aria-label="Add Node"
              className="etg-hud-btn inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-transparent px-2 font-medium text-text-primary hover:bg-surface-hover cursor-pointer"
            >
              <Plus
                className="h-3 w-3 text-amber-400"
                aria-hidden="true"
              />
              <span>Add</span>
            </button>
          )}

          {onToggleConnectMode && (
            <button
              type="button"
              aria-pressed={connectMode}
              onClick={onToggleConnectMode}
              className="etg-hud-btn inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-transparent px-2 font-medium text-text-primary transition-colors hover:bg-surface-hover aria-pressed:border-amber-400 aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
            >
              <GitBranchPlus className="h-3 w-3" aria-hidden="true" />
              <span>{connectMode ? "Connecting…" : "Connect"}</span>
            </button>
          )}

          {onDiscoverLinks && (
            <button
              type="button"
              onClick={onDiscoverLinks}
              disabled={discoveringLinks}
              title="Discover latent connections across the Earth Trend Graph"
              aria-label={discoveringLinks ? "Scanning for links" : "Find Links"}
              className="etg-hud-btn inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-transparent px-2 font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50 cursor-pointer"
            >
              <Sparkles
                className={`h-3 w-3 text-violet-400 ${discoveringLinks ? "animate-pulse" : ""}`}
                aria-hidden="true"
              />
              <span>{discoveringLinks ? "Scanning…" : "Links"}</span>
            </button>
          )}
        </div>

        {onChangeTraversalFilter && (
          <>
            {hasSelection && (
              <>
                <div role="separator" aria-orientation="vertical" className="mx-0.5 h-3.5 shrink-0 border-l border-border" />
                <div role="group" aria-label="Hop depth traversal" className="flex shrink-0 items-center gap-0.5">
                  {([null, 1, 2, 3] as const).map((h) => (
                    <button
                      key={h === null ? "all" : `hop-${h}`}
                      type="button"
                      aria-pressed={traversalFilter.maxHops === h}
                      onClick={() => onChangeTraversalFilter({ ...traversalFilter, maxHops: h })}
                      title={h === null ? "All Hops" : `${h}-Hop traversal`}
                      aria-label={h === null ? "All Hops" : `${h}-Hop`}
                      className="etg-hud-btn h-6 shrink-0 rounded-sm border border-transparent px-1.5 font-mono ws-numeric text-[10px] font-medium text-text-muted hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                    >
                      {h === null ? "All" : `${h}H`}
                    </button>
                  ))}
                </div>

                <div role="separator" aria-orientation="vertical" className="mx-0.5 h-3.5 shrink-0 border-l border-border" />
                <div role="group" aria-label="Causal traversal direction" className="flex shrink-0 items-center gap-0.5">
                  {(
                    [
                      { id: "both", label: "↔", full: "All directions (drivers and impacts)" },
                      { id: "upstream", label: "← In", full: "Upstream Drivers" },
                      { id: "downstream", label: "Out →", full: "Downstream Impacts" },
                    ] as const
                  ).map((dir) => (
                    <button
                      key={dir.id}
                      type="button"
                      aria-pressed={traversalFilter.direction === dir.id}
                      title={dir.full}
                      aria-label={dir.full}
                      onClick={() =>
                        onChangeTraversalFilter({
                          ...traversalFilter,
                          direction: dir.id,
                          maxHops: traversalFilter.maxHops ?? 2,
                        })
                      }
                      className="etg-hud-btn h-6 shrink-0 rounded-sm border border-transparent px-1.5 text-[10px] font-medium text-text-muted hover:text-text-primary aria-pressed:border-teal-400 aria-pressed:bg-teal-950 aria-pressed:text-teal-300 cursor-pointer"
                    >
                      {dir.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            {renderMode === "2d" && (
              <>
                <div role="separator" aria-orientation="vertical" className="mx-0.5 h-3.5 shrink-0 border-l border-border" />
                <div role="group" aria-label="Graph layout mode" className="flex shrink-0 items-center">
                  <button
                    type="button"
                    aria-pressed={traversalFilter.layoutMode === "causal_flow"}
                    title="Causal Flow 2D layered layout"
                    aria-label="Causal Flow layout"
                    onClick={() =>
                      onChangeTraversalFilter({
                        ...traversalFilter,
                        layoutMode:
                          traversalFilter.layoutMode === "causal_flow" ? "force" : "causal_flow",
                      })
                    }
                    className="etg-hud-btn inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-transparent px-2 text-[10px] font-medium text-text-muted hover:text-text-primary aria-pressed:border-amber-400 aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                  >
                    <Waypoints className="h-3 w-3" aria-hidden="true" />
                    <span>Flow</span>
                  </button>
                </div>
              </>
            )}

            <div role="separator" aria-orientation="vertical" className="mx-0.5 h-3.5 shrink-0 border-l border-border" />
            <div role="group" aria-label="Provenance and governance hubs" className="flex shrink-0 items-center">
              <button
                type="button"
                aria-pressed={Boolean(traversalFilter.showProvenanceHubs)}
                title="Show or hide satellite catalog Concept hubs, statistical Rule gates, and monitors/verified_by spokes"
                aria-label="Show provenance hubs"
                onClick={() =>
                  onChangeTraversalFilter({
                    ...traversalFilter,
                    showProvenanceHubs: !traversalFilter.showProvenanceHubs,
                  })
                }
                className="etg-hud-btn inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-transparent px-2 text-[10px] font-medium text-text-muted hover:text-text-primary aria-pressed:border-violet-400 aria-pressed:bg-violet-950 aria-pressed:text-violet-300 cursor-pointer"
              >
                <Database className="h-3 w-3" aria-hidden="true" />
                <span>Provenance</span>
              </button>
            </div>
          </>
        )}

        {onChangeRegionScope && regionOptions.length > 0 && (
          <>
            <div role="separator" aria-orientation="vertical" className="mx-0.5 h-3.5 shrink-0 border-l border-border" />
            <div role="group" aria-label="Move to region" className="flex shrink-0 items-center gap-0.5">
              <select
                aria-label="Move to region"
                value={selectedRegionScope ?? ""}
                onChange={(e) => onChangeRegionScope(e.target.value ? e.target.value : null)}
                className="h-6 min-w-[112px] max-w-[180px] rounded-sm border border-border bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-primary focus:border-accent-fg focus-visible:outline-2 focus-visible:outline-[var(--accent-fg)] cursor-pointer"
              >
                <option value="">All Regions</option>
                {regionOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label} ({opt.count})
                  </option>
                ))}
              </select>
              {selectedRegionScope && (
                <>
                  {onRefocusActiveRegion && (
                    <button
                      type="button"
                      onClick={onRefocusActiveRegion}
                      title="Fly camera back to selected region"
                      className="etg-hud-btn h-6 rounded-sm border border-border bg-surface-band px-1.5 text-[10px] font-medium text-text-primary hover:bg-surface-hover cursor-pointer"
                    >
                      Fly
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onChangeRegionScope(null)}
                    aria-label="Clear region focus"
                    title="Return to global overview"
                    className="etg-hud-btn inline-flex h-6 w-6 items-center justify-center rounded-sm border border-transparent text-text-muted hover:bg-surface-hover hover:text-text-primary cursor-pointer"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Contextual sub-banner for Connect Mode or Candidate Ghost Links */}
      {connectMode && (
        <div
          role="status"
          aria-live="polite"
          className="etg-hud-pill pointer-events-auto flex items-center gap-1.5 rounded-md border border-amber-400 bg-amber-950 px-2.5 py-0.5 text-[10.5px] text-amber-300 shadow"
        >
          <span
            className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse"
            aria-hidden="true"
          />
          {connectSourceName ? (
            <span>
              From <strong>{connectSourceName}</strong> <ArrowRight className="inline h-3 w-3" /> target node
            </span>
          ) : (
            <span>Connect: click Source node (or Shift+Click two)</span>
          )}
          {onToggleConnectMode && (
            <button
              type="button"
              onClick={onToggleConnectMode}
              aria-label="Exit connect mode"
              className="etg-hud-btn ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-sm text-amber-300 hover:bg-surface-hover hover:text-text-primary cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {!connectMode && candidateCount > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="etg-hud-pill pointer-events-auto flex items-center gap-1.5 rounded-md border border-violet-400 bg-violet-950 px-2.5 py-0.5 text-[10.5px] text-violet-300 shadow"
        >
          <Sparkles
            className="h-3 w-3 text-violet-400"
            aria-hidden="true"
          />
          <span>
            <span className="ws-numeric">{candidateCount}</span> latent link{candidateCount === 1 ? "" : "s"}
            {selectedNodeName ? ` · ${selectedNodeName}` : ""} — click dashed violet edge
          </span>
          {onClearCandidateLinks && (
            <button
              type="button"
              onClick={onClearCandidateLinks}
              aria-label="Hide discovered link suggestions"
              className="etg-hud-btn ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-sm text-violet-300 hover:bg-surface-hover hover:text-text-primary cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
