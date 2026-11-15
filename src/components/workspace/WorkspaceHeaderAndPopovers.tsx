"use client";

import React from "react";
import {
  Download,
  GitCompare,
  Globe2,
  MoreVertical,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Upload,
} from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { ETG_LABEL_PALETTE } from "@/lib/graph/graphVisuals";
import {
  ALL_RELATION_CATEGORIES,
  RELATION_CATEGORY_META,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type {
  EarthCascadeChain,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGNodeLabel,
  RelationCategory,
  TemperatureUnit,
} from "@/types/etg";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DatasetSelector } from "@/components/DatasetSelector";
import type { IngestionTabId } from "@/components/IngestionModal";
import {
  GUIDED_DIPOLE_CASES,
  hidePopoverById,
  type FormattedRelationItem,
  type GraphRenderMode,
  type GuidedDipoleCase,
  type RelationPopoverFilter,
  type WorkspaceViewMode,
} from "./workspaceDipolesAndUtils";

export interface WorkspaceHeaderProps {
  topicButtonLabel: string;
  activeFilterCount: number;
  relationsCount: number;
  viewMode: WorkspaceViewMode;
  graphRenderMode: GraphRenderMode;
  searchQuery: string;
  aiStudioOpen: boolean;
  onSwitchView: (nextMode: WorkspaceViewMode) => void;
  onChangeGraphRenderMode: (mode: GraphRenderMode) => void;
  onChangeSearchQuery: (q: string) => void;
  onOpenSolarGraph: () => void;
  onToggleAiStudio: () => void;
  onOpenAddData: () => void;
}

export function WorkspaceHeader({
  topicButtonLabel,
  activeFilterCount,
  relationsCount,
  viewMode,
  graphRenderMode,
  searchQuery,
  aiStudioOpen,
  onSwitchView,
  onChangeGraphRenderMode,
  onChangeSearchQuery,
  onOpenSolarGraph,
  onToggleAiStudio,
  onOpenAddData,
}: WorkspaceHeaderProps) {
  return (
    <header className="z-30 flex h-12 shrink-0 flex-nowrap items-center justify-between gap-1.5 border-b border-border bg-header px-2.5 sm:gap-2 sm:px-4">
      {/* Left Group: Brand + Dataset Filter + Relations */}
      <div className="flex min-w-0 shrink items-center gap-1 sm:gap-1.5">
        <div className="flex items-center gap-2 pr-0.5 sm:pr-1" title="Earth Trend Detective">
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent-fg" aria-hidden="true" />
          <h1 className="whitespace-nowrap font-outfit text-sm font-semibold tracking-tight text-text-primary">
            <span className="sr-only sm:not-sr-only">Earth Trend Detective</span>
          </h1>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          className="mx-1 hidden h-4 border-l border-border sm:block"
        />

        <button
          type="button"
          popoverTarget="etg-filter-popover"
          title={topicButtonLabel}
          aria-label={topicButtonLabel}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-1 text-xs font-medium transition-colors cursor-pointer sm:px-2.5 ${
            activeFilterCount > 0
              ? "border-accent-fg bg-amber-950 text-amber-300"
              : "border-border bg-surface-elevated text-text-muted hover:border-border-strong hover:text-text-primary"
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden lg:inline">{topicButtonLabel}</span>
          {activeFilterCount > 0 && (
            <span className="ws-numeric rounded-xs bg-accent px-1.5 text-[10px] font-semibold text-white">
              {activeFilterCount}
            </span>
          )}
        </button>

        <button
          type="button"
          popoverTarget="etg-dipoles-popover"
          title="View opposite trends, causal chains, teleconnections, and corroboration relations"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-border bg-rose-950 px-2 py-1 text-xs font-medium text-rose-300 transition-colors hover:border-rose-400 cursor-pointer sm:gap-1.5 sm:px-2.5"
        >
          <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Relations</span>
          <span className="ws-numeric font-mono text-[11px] font-semibold">
            {relationsCount}
          </span>
        </button>
      </div>

      {/* Center Segmented Switcher: 3D Earth vs Knowledge Graph (3D/2D) */}
      <nav
        aria-label="Workspace View Switcher"
        className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface-inset p-0.5 sm:gap-1"
      >
        <button
          type="button"
          onClick={() => onSwitchView("globe")}
          aria-pressed={viewMode === "globe"}
          className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium transition-colors cursor-pointer sm:gap-1.5 sm:px-3 ${
            viewMode === "globe"
              ? "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] font-semibold"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="sm:hidden">Earth</span>
          <span className="hidden sm:inline">3D Earth</span>
        </button>

        <button
          type="button"
          onClick={() => onSwitchView("graph")}
          aria-pressed={viewMode === "graph"}
          className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium transition-colors cursor-pointer sm:gap-1.5 sm:px-3 ${
            viewMode === "graph"
              ? "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] font-semibold"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <Network className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="sm:hidden">Graph</span>
          <span className="hidden sm:inline">Knowledge Graph</span>
        </button>

        {viewMode === "graph" && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              className="mx-0.5 h-4 border-l border-border"
            />
            {(["3d", "2d"] as const).map((mode) => {
              const active = graphRenderMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChangeGraphRenderMode(mode)}
                  aria-pressed={active}
                  className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase transition-colors cursor-pointer sm:px-2 ${
                    active
                      ? "border border-border-strong bg-surface-elevated text-text-primary"
                      : "text-text-subtle hover:text-text-primary"
                  }`}
                >
                  {mode}
                </button>
              );
            })}
          </>
        )}
      </nav>

      {/* Right Group: Search + Solar Graph + Ask AI + Add Data + Tools + Theme */}
      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        <search className="relative hidden items-center xl:flex">
          <Search
            className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-text-subtle"
            aria-hidden="true"
          />
          <label htmlFor="etg-search" className="sr-only">
            Search places or trends
          </label>
          <input
            id="etg-search"
            name="q"
            type="search"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => onChangeSearchQuery(e.target.value)}
            placeholder="Search pins or trends…"
            className="h-7 w-36 rounded-sm border border-border bg-surface-inset pr-2.5 pl-7 text-xs text-text-primary placeholder:text-text-subtle transition-all focus:w-48 focus:border-accent-fg focus:outline-none"
          />
        </search>

        <button
          type="button"
          onClick={onOpenSolarGraph}
          title="Denver Solar Microgrid — 7-Node Local Climate Graph & 3-Way Forecast"
          aria-label="Denver Solar Graph"
          className="hidden items-center gap-1.5 whitespace-nowrap rounded-sm border border-amber-400 bg-amber-950 px-2 py-1 text-xs font-medium text-amber-300 transition-colors hover:border-accent-fg cursor-pointer md:inline-flex xl:px-2.5"
        >
          <Sun className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden xl:inline">Solar Graph</span>
        </button>

        <button
          type="button"
          onClick={onToggleAiStudio}
          aria-expanded={aiStudioOpen}
          title="Toggle AI Graph Chat Studio"
          aria-label="Toggle AI Graph Chat Studio"
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-1 text-xs font-medium transition-colors cursor-pointer xl:px-2.5 ${
            aiStudioOpen
              ? "border-accent-fg bg-accent/15 text-accent-fg"
              : "border-border bg-surface-elevated text-accent-fg hover:border-accent-fg"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden xl:inline">AI Studio</span>
        </button>

        <button
          type="button"
          onClick={onOpenAddData}
          title="Add Data"
          aria-label="Add Data"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-accent px-2 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent-hover cursor-pointer sm:px-2.5"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Add Data</span>
        </button>

        <button
          type="button"
          popoverTarget="etg-more-popover"
          title="Live global discovery, NASA EONET sync & export tools"
          aria-label="Observatory tools"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-border bg-surface-elevated px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
        >
          <MoreVertical className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden xl:inline">Tools</span>
        </button>

        <ThemeToggle />
      </div>
    </header>
  );
}

export interface WorkspacePopoversProps {
  bundleInputId: string;
  activeFilterCount: number;
  activeTopics: ETGDatasetId[];
  nodes: ETGNode[];
  searchQuery: string;
  enabledRelationCategories: RelationCategory[];
  onlyOpposite: boolean;
  showSuperseded: boolean;
  tempUnit: TemperatureUnit;
  relationPopoverFilter: RelationPopoverFilter;
  formattedAllRelations: FormattedRelationItem[];
  cascades: EarthCascadeChain[];
  discoverBusy: boolean;
  eonetBusy: boolean;
  activity: EtgGraphSnapshot["activity"];
  onResetAllFilters: () => void;
  onToggleTopic: (ds: ETGDatasetId) => void;
  onResetTopics: () => void;
  onChangeSearchQuery: (q: string) => void;
  onToggleRelationCategoryFilter: (cat: RelationCategory) => void;
  onChangeOnlyOpposite: (v: boolean) => void;
  onChangeShowSuperseded: (v: boolean) => void;
  onChangeTempUnit: (u: TemperatureUnit) => void;
  onChangeRelationPopoverFilter: (f: RelationPopoverFilter) => void;
  onRunCaseStudy: (preset: GuidedDipoleCase) => void;
  onSelectEdge: (edge: ETGEdge) => void;
  onSelectCascade: (chain: EarthCascadeChain) => void;
  onOpenSolarGraph: () => void;
  onDiscoverGlobalTrends: () => void;
  onSyncEonet: () => void;
  onOpenIngestModal: (tab: IngestionTabId) => void;
  onExportWorkspaceBundle: () => void;
  onImportWorkspaceBundle: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClearGraph: () => void;
}

export function WorkspacePopovers({
  bundleInputId,
  activeFilterCount,
  activeTopics,
  nodes,
  searchQuery,
  enabledRelationCategories,
  onlyOpposite,
  showSuperseded,
  tempUnit,
  relationPopoverFilter,
  formattedAllRelations,
  cascades,
  discoverBusy,
  eonetBusy,
  activity,
  onResetAllFilters,
  onToggleTopic,
  onResetTopics,
  onChangeSearchQuery,
  onToggleRelationCategoryFilter,
  onChangeOnlyOpposite,
  onChangeShowSuperseded,
  onChangeTempUnit,
  onChangeRelationPopoverFilter,
  onRunCaseStudy,
  onSelectEdge,
  onSelectCascade,
  onOpenSolarGraph,
  onDiscoverGlobalTrends,
  onSyncEonet,
  onOpenIngestModal,
  onExportWorkspaceBundle,
  onImportWorkspaceBundle,
  onClearGraph,
}: WorkspacePopoversProps) {
  return (
    <>
      {/* 1. Topic Filters & View Options Popover */}
      <div id="etg-filter-popover" popover="auto" className="etg-popover space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
            Choose What You See
          </h3>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={onResetAllFilters}
              className="text-xs font-medium text-accent-fg hover:underline cursor-pointer"
            >
              Reset filters
            </button>
          )}
        </div>

        {/* Multi-Select Topic Filters */}
        <div>
          <DatasetSelector
            activeTopics={activeTopics}
            onToggleTopic={onToggleTopic}
            onResetTopics={onResetTopics}
            nodes={nodes}
          />
        </div>

        {/* Tablet/Mobile Search Input (shown whenever header search is collapsed < xl) */}
        <div className="xl:hidden">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onChangeSearchQuery(e.target.value)}
            placeholder="Search places or trends…"
            className="form-input"
          />
        </div>

        {/* Relation Categories Checkboxes */}
        <div className="space-y-1 border-t border-border pt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Relation Categories
          </div>
          {ALL_RELATION_CATEGORIES.map((cat) => {
            const dotColor =
              cat === "opposite"
                ? "#fb7185"
                : cat === "causal"
                  ? "#34d399"
                  : cat === "coupled"
                    ? "#38bdf8"
                    : "#a78bfa";
            return (
              <label key={cat} className="etg-check-label text-xs text-text-primary">
                <input
                  type="checkbox"
                  checked={enabledRelationCategories.includes(cat)}
                  onChange={() => onToggleRelationCategoryFilter(cat)}
                  className="checkbox-native"
                />
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                  aria-hidden="true"
                />
                <span>{RELATION_CATEGORY_META[cat].label}</span>
              </label>
            );
          })}
        </div>

        {/* Graph Toggles + Temperature Unit */}
        <div className="space-y-2 border-y border-border py-3">
          <label className="etg-check-label text-xs text-text-primary">
            <input
              type="checkbox"
              checked={onlyOpposite}
              onChange={(e) => onChangeOnlyOpposite(e.target.checked)}
              className="checkbox-native"
            />
            <span>Only opposite trends</span>
          </label>
          <label className="etg-check-label text-xs text-text-primary">
            <input
              type="checkbox"
              checked={showSuperseded}
              onChange={(e) => onChangeShowSuperseded(e.target.checked)}
              className="checkbox-native"
            />
            <span>Show updated findings</span>
          </label>
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-medium text-text-muted">Temperature unit</span>
            <div className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5">
              {(["C", "F"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={tempUnit === u}
                  onClick={() => onChangeTempUnit(u)}
                  className="rounded-xs px-2 py-0.5 text-[11px] font-semibold text-text-muted aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                >
                  °{u}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Graph Node Key */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-text-subtle">Map &amp; Graph Key</div>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-surface-inset p-2.5">
            {(["Concept", "Signal", "Insight", "Rule"] as ETGNodeLabel[]).map((label) => {
              const palette = ETG_LABEL_PALETTE[label];
              return (
                <div key={label} className="flex items-center gap-2 text-xs text-text-primary">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: palette.color }}
                  />
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 2. Earth Trend Relations & Causal Chains Popover */}
      <div id="etg-dipoles-popover" popover="auto" className="etg-popover space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-primary">
            Earth Relations &amp; Chains
          </h3>
          <span className="ws-numeric font-mono text-[11px] text-text-subtle">
            {formattedAllRelations.length} links · {cascades.length} chains
          </span>
        </div>

        {/* Guided Opposite-Trend Case Studies */}
        <div className="space-y-1.5 rounded-sm border border-border bg-surface-inset p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
            Guided Opposite-Trend Case Studies (Live NASA/NOAA)
          </div>
          <div className="grid gap-1">
            {GUIDED_DIPOLE_CASES.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onRunCaseStudy(preset)}
                className="flex flex-col items-start rounded-sm border border-border bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-rose-400 cursor-pointer"
              >
                <span className="text-[11px] font-semibold text-text-primary">
                  {preset.title}
                </span>
                <span className="text-[10px] text-text-muted leading-snug">
                  {preset.spotA.name} vs. {preset.spotB.name} — {preset.subtitle}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              { id: "all", label: `All (${formattedAllRelations.length})` },
              {
                id: "opposite",
                label: `Opposite (${formattedAllRelations.filter((i) => i.formatted.category === "opposite").length})`,
              },
              {
                id: "causal",
                label: `Causal → (${formattedAllRelations.filter((i) => i.formatted.category === "causal").length})`,
              },
              {
                id: "coupled",
                label: `Coupled (${formattedAllRelations.filter((i) => i.formatted.category === "coupled").length})`,
              },
              { id: "chains", label: `Chains (${cascades.length})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={relationPopoverFilter === tab.id}
              onClick={() => onChangeRelationPopoverFilter(tab.id)}
              className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-200 cursor-pointer"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {relationPopoverFilter !== "chains" && (
          <div className="space-y-2">
            {formattedAllRelations
              .filter(
                (item) =>
                  relationPopoverFilter === "all" ||
                  item.formatted.category === relationPopoverFilter
              )
              .slice(0, 14)
              .map(({ edge, src, tgt, formatted }) => {
                const srcLabel = humanizeNodeText(src.properties.region || src.properties.name);
                const tgtLabel = humanizeNodeText(tgt.properties.region || tgt.properties.name);
                const badgeClass =
                  formatted.category === "opposite"
                    ? "border-rose-400 bg-rose-950 text-rose-300"
                    : formatted.category === "causal"
                      ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                      : formatted.category === "coupled"
                        ? "border-sky-400 bg-sky-950 text-sky-300"
                        : "border-violet-400 bg-violet-950 text-violet-300";
                const sep = formatted.direction === "undirected" ? "↔" : "→";
                return (
                  <button
                    key={edge.properties.uuid}
                    type="button"
                    onClick={() => {
                      onSelectEdge(edge);
                      hidePopoverById("etg-dipoles-popover");
                    }}
                    className="w-full space-y-1 rounded-md border border-border bg-surface-inset p-2.5 text-left transition-colors hover:border-accent-fg cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-text-primary">
                      <span className="truncate">
                        {srcLabel} {sep} {tgtLabel}
                      </span>
                      <span
                        className={`shrink-0 rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${badgeClass}`}
                      >
                        {formatted.badgeText}
                      </span>
                    </div>
                    <div className="ws-numeric flex flex-wrap items-center gap-x-2 text-[10px] text-text-subtle">
                      {formatted.correlationText && (
                        <span className="font-mono text-text-muted">
                          {formatted.correlationText}
                        </span>
                      )}
                      {formatted.lagText && (
                        <span className="font-mono text-text-muted">{formatted.lagText}</span>
                      )}
                      {formatted.distanceKm !== null && (
                        <span className="font-mono">{formatted.distanceKm} km</span>
                      )}
                    </div>
                    <div className="line-clamp-2 text-[11px] text-text-muted">
                      {formatted.summaryLine}
                    </div>
                  </button>
                );
              })}
            {formattedAllRelations.filter(
              (item) =>
                relationPopoverFilter === "all" ||
                item.formatted.category === relationPopoverFilter
            ).length === 0 && (
              <div className="rounded-sm border border-border-subtle bg-surface-inset p-3 text-xs text-text-subtle">
                No relations match this category yet.
              </div>
            )}
          </div>
        )}

        {(relationPopoverFilter === "all" || relationPopoverFilter === "chains") &&
          cascades.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                  Connected Earth Chains
                </h3>
                <span className="ws-numeric font-mono text-[11px] text-text-subtle">
                  {cascades.length} chains
                </span>
              </div>

              <div className="space-y-1.5">
                {cascades.slice(0, 5).map((chain) => (
                  <button
                    key={chain.id}
                    type="button"
                    onClick={() => onSelectCascade(chain)}
                    className="w-full space-y-1 rounded-md border border-border bg-amber-950 p-2.5 text-left transition-colors hover:border-amber-400 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-text-primary">
                      <span className="truncate">{chain.title}</span>
                      <span className="ws-numeric shrink-0 font-mono text-amber-300">
                        {chain.spheres.length} steps
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-text-muted">{chain.summary}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
      </div>

      {/* 4. More Observatory Tools Popover */}
      <div id="etg-more-popover" popover="auto" className="etg-popover etg-popover-end space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Observatory Tools
        </h3>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              hidePopoverById("etg-more-popover");
              onOpenSolarGraph();
            }}
            className="flex w-full items-center justify-between rounded-sm border border-amber-400 bg-amber-950 px-3 py-2 text-xs font-semibold text-amber-300 hover:border-amber-300 cursor-pointer md:hidden"
          >
            <span>Denver Solar Microgrid Graph</span>
            <Sun className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onDiscoverGlobalTrends}
            disabled={discoverBusy}
            className="flex w-full items-center justify-between rounded-sm border border-teal-400 bg-teal-950 px-3 py-2 text-xs font-semibold text-teal-300 hover:border-teal-300 disabled:opacity-50 cursor-pointer"
          >
            <span>{discoverBusy ? "Discovering Trends…" : "Re-run Live Global Discovery"}</span>
            <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={onSyncEonet}
            disabled={eonetBusy}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-border-strong disabled:opacity-50 cursor-pointer"
          >
            <span>{eonetBusy ? "Syncing NASA EONET…" : "Sync NASA EONET Live Events"}</span>
            <RefreshCw className={`h-3.5 w-3.5 ${eonetBusy ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={() => {
              hidePopoverById("etg-more-popover");
              onOpenIngestModal("agencies");
            }}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            <span>Challenge Space-Agency Hub (12)</span>
            <Globe2 className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onExportWorkspaceBundle}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            <span>Export Workspace Bundle (.json)</span>
            <Download className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
          </button>

          <div className="relative">
            <input
              id={`${bundleInputId}-import`}
              name="etg_workspace_bundle"
              type="file"
              accept=".json,application/json"
              onChange={onImportWorkspaceBundle}
              className="visually-hidden"
            />
            <label
              htmlFor={`${bundleInputId}-import`}
              className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
            >
              <span>Import / Merge Bundle (.json)</span>
              <Upload className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            </label>
          </div>

          <button
            type="button"
            onClick={onClearGraph}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-rose-950 px-3 py-2 text-xs font-medium text-rose-300 hover:border-rose-400 cursor-pointer"
          >
            <span>Clear Graph (0 Nodes)</span>
            <RotateCcw className="h-3.5 w-3.5 text-rose-300" />
          </button>
        </div>

        <div className="border-t border-border pt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Recent Provenance Activity
          </div>
          <div className="max-h-40 space-y-1.5 overflow-y-auto text-xs text-text-muted">
            {activity.slice(0, 6).map((act) => (
              <div key={act.id} className="truncate font-mono text-[11px]">
                <span className="text-text-faint">{act.kind}:</span> {act.summary}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
