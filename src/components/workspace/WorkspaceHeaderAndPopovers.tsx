"use client";

import React, { useId, useMemo, useRef, useState } from "react";
import {
  BookOpenText,
  Download,
  GitCompare,
  Globe2,
  HelpCircle,
  MapPin,
  MoreVertical,
  Navigation,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { searchObservatoryTargets, type EarthPlaceTarget } from "@/lib/earth/placeSearch";
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
  briefingsCount: number;
  viewMode: WorkspaceViewMode;
  graphRenderMode: GraphRenderMode;
  searchQuery: string;
  nodes: readonly ETGNode[];
  missionOpen?: boolean;
  aiStudioOpen: boolean;
  onSwitchView: (nextMode: WorkspaceViewMode) => void;
  onChangeGraphRenderMode: (mode: GraphRenderMode) => void;
  onChangeSearchQuery: (q: string) => void;
  onSelectSearchTarget: (target: EarthPlaceTarget) => void;
  onOpenMissionGuide: () => void;
  onOpenSolarGraph?: () => void;
  onOpenBriefings?: () => void;
  onToggleAiStudio: () => void;
  onOpenAddData: () => void;
}

export function WorkspaceHeader({
  topicButtonLabel,
  activeFilterCount,
  relationsCount,
  briefingsCount,
  viewMode,
  graphRenderMode,
  searchQuery,
  nodes,
  missionOpen = false,
  aiStudioOpen,
  onSwitchView,
  onChangeGraphRenderMode,
  onChangeSearchQuery,
  onSelectSearchTarget,
  onOpenMissionGuide,
  onToggleAiStudio,
  onOpenAddData,
}: WorkspaceHeaderProps) {
  const listboxId = useId();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const searchMatches = useMemo(
    () => searchObservatoryTargets(searchQuery, nodes, 8),
    [searchQuery, nodes]
  );

  const showDropdown = dropdownOpen && searchMatches.length > 0;
  const highlightedIndex =
    activeIndex >= 0 && activeIndex < searchMatches.length ? activeIndex : -1;
  const activeDescendantId =
    showDropdown && highlightedIndex >= 0
      ? `${listboxId}-opt-${highlightedIndex}`
      : undefined;

  const pickTarget = (target: EarthPlaceTarget) => {
    onSelectSearchTarget(target);
    setDropdownOpen(false);
    setActiveIndex(-1);
    searchInputRef.current?.blur();
  };

  const compactTopicLabel = topicButtonLabel.startsWith("Datasets: ")
    ? topicButtonLabel.slice("Datasets: ".length) === "All"
      ? "Topics"
      : topicButtonLabel.slice("Datasets: ".length)
    : topicButtonLabel;

  return (
    <header className="z-30 flex min-h-11 shrink-0 flex-nowrap items-center justify-between gap-1.5 border-b border-border bg-header px-2.5 py-1 sm:gap-2 sm:px-3.5">
      {/* Left Group: Brand + Dataset Filter + Relations */}
      <div className="flex min-w-0 shrink items-center gap-1 sm:gap-1.5">
        <div className="flex items-center gap-1.5 pr-0.5" title="Earth Trend Detective">
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent-fg" aria-hidden="true" />
          {viewMode === "briefings" ? (
            <span className="whitespace-nowrap font-outfit text-[13.5px] font-semibold tracking-tight text-text-primary">
              <span className="sr-only sm:not-sr-only">Earth Trend Detective</span>
            </span>
          ) : (
            <h1 className="whitespace-nowrap font-outfit text-[13.5px] font-semibold tracking-tight text-text-primary">
              <span className="sr-only sm:not-sr-only">Earth Trend Detective</span>
            </h1>
          )}
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          className="mx-0.5 hidden h-3.5 border-l border-border xl:block"
        />

        <button
          type="button"
          popoverTarget="etg-filter-popover"
          title={topicButtonLabel}
          aria-label={topicButtonLabel}
          className={`etg-hud-btn inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-colors cursor-pointer ${
            activeFilterCount > 0
              ? "border-amber-400/50 bg-amber-950/50 text-amber-200"
              : "border-border bg-surface-elevated/70 text-text-muted hover:border-border-strong hover:text-text-primary"
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden md:inline">{compactTopicLabel}</span>
          {activeFilterCount > 0 && (
            <span className="ws-numeric rounded-xs bg-accent px-1 text-[10px] font-semibold text-white">
              {activeFilterCount}
            </span>
          )}
        </button>

        <button
          type="button"
          popoverTarget="etg-dipoles-popover"
          aria-label={`View Earth relations (${relationsCount})`}
          title="View opposite trends, causal chains, teleconnections, and corroboration relations"
          className="etg-hud-btn inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface-elevated/70 px-2 py-0.5 text-[11.5px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400" aria-hidden="true" />
          <span className="hidden xl:inline">Relations</span>
          <span className="ws-numeric font-mono text-[10.5px] text-text-subtle">
            {relationsCount}
          </span>
        </button>
      </div>

      {/* Center Segmented Switcher: Earth vs Graph (3D/2D) */}
      <nav
        aria-label="Workspace View Switcher"
        className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface-inset p-0.5"
      >
        <button
          type="button"
          onClick={() => onSwitchView("globe")}
          aria-pressed={viewMode === "globe"}
          title="Interactive 3D Earth Globe"
          className={`inline-flex min-h-6.5 items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-[11.5px] font-medium transition-colors cursor-pointer sm:px-2.5 ${
            viewMode === "globe"
              ? "bg-surface-elevated text-text-primary font-semibold shadow-xs"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Earth</span>
        </button>

        <button
          type="button"
          onClick={() => onSwitchView("graph")}
          aria-pressed={viewMode === "graph"}
          title="Knowledge Graph"
          className={`inline-flex min-h-6.5 items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-[11.5px] font-medium transition-colors cursor-pointer sm:px-2.5 ${
            viewMode === "graph"
              ? "bg-surface-elevated text-text-primary font-semibold shadow-xs"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <Network className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Graph</span>
        </button>

        {viewMode === "graph" && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              className="mx-0.5 h-3.5 border-l border-border"
            />
            {(["3d", "2d"] as const).map((mode) => {
              const active = graphRenderMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChangeGraphRenderMode(mode)}
                  aria-pressed={active}
                  className={`rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase transition-colors cursor-pointer ${
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

      {/* Right Group: Search + Briefings + AI + Add + Tools + Guide + Theme */}
      <div className="flex shrink-0 items-center gap-1">
        <search className="relative hidden items-center md:flex">
          <Search
            className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-text-subtle"
            aria-hidden="true"
          />
          <label htmlFor="etg-search" className="sr-only">
            Search places, coordinates, or trends
          </label>
          <input
            ref={searchInputRef}
            id="etg-search"
            name="q"
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showDropdown}
            aria-controls={listboxId}
            aria-activedescendant={activeDescendantId}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={searchQuery}
            onFocus={() => setDropdownOpen(true)}
            onBlur={() => {
              setDropdownOpen(false);
              setActiveIndex(-1);
            }}
            onChange={(e) => {
              onChangeSearchQuery(e.target.value);
              setDropdownOpen(true);
              setActiveIndex(-1);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" && searchMatches.length > 0) {
                e.preventDefault();
                setDropdownOpen(true);
                setActiveIndex((prev) => (prev + 1) % searchMatches.length);
              } else if (e.key === "ArrowUp" && searchMatches.length > 0) {
                e.preventDefault();
                setDropdownOpen(true);
                setActiveIndex((prev) =>
                  prev <= 0 ? searchMatches.length - 1 : prev - 1
                );
              } else if (e.key === "Enter" && searchMatches.length > 0) {
                e.preventDefault();
                const chosen =
                  highlightedIndex >= 0
                    ? searchMatches[highlightedIndex]
                    : searchMatches[0];
                if (chosen) pickTarget(chosen);
              } else if (e.key === "Escape") {
                setDropdownOpen(false);
                setActiveIndex(-1);
              }
            }}
            placeholder="Search places or coords…"
            className="h-7 w-32 sm:w-40 md:w-44 lg:w-48 xl:w-56 rounded-md border border-border bg-surface-inset pr-6 pl-7 text-[11.5px] text-text-primary placeholder:text-text-subtle transition-[width,border-color] focus:w-48 lg:focus:w-60 focus:border-accent-fg focus-visible:outline-2 focus-visible:outline-[var(--accent-fg)] [&::-webkit-search-cancel-button]:hidden"
          />
          {searchQuery && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChangeSearchQuery("");
                setActiveIndex(-1);
                searchInputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-xs text-text-subtle hover:bg-surface-hover hover:text-text-primary cursor-pointer"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
          {showDropdown && (
            <div
              id={listboxId}
              role="listbox"
              aria-label="Earth observatory places, coordinates, and graph pins"
              className="etg-hud-pill absolute top-full right-0 z-50 mt-1.5 w-80 max-w-[calc(100dvw-2rem)] overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
            >
              <div className="border-b border-border bg-surface-inset px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                Jump to location, coordinates, or graph pin
              </div>
              <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
                {searchMatches.map((item, idx) => {
                  const isActive = idx === highlightedIndex;
                  const kindBadge =
                    item.kind === "coordinate"
                      ? "Coords"
                      : item.kind === "node"
                        ? "Pin"
                        : "Place";
                  const kindCls =
                    item.kind === "coordinate"
                      ? "border-amber-400/40 bg-amber-950/60 text-amber-300"
                      : item.kind === "node"
                        ? "border-emerald-400/40 bg-emerald-950/60 text-emerald-300"
                        : "border-sky-400/40 bg-sky-950/60 text-sky-300";
                  return (
                    <button
                      key={item.id}
                      id={`${listboxId}-opt-${idx}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => pickTarget(item)}
                      className={`flex w-full items-start gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer ${
                        isActive
                          ? "bg-surface-elevated text-text-primary"
                          : "text-text-muted hover:bg-surface-band hover:text-text-primary"
                      }`}
                    >
                      {item.kind === "coordinate" ? (
                        <Navigation
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <MapPin
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-fg"
                          aria-hidden="true"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-text-primary">
                            {item.label}
                          </span>
                          <span
                            className={`shrink-0 rounded-xs border px-1.5 py-px font-mono text-[9px] font-semibold uppercase ${kindCls}`}
                          >
                            {kindBadge}
                          </span>
                        </div>
                        <div className="truncate text-[10.5px] text-text-subtle">
                          {item.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </search>

        <button
          type="button"
          onClick={onToggleAiStudio}
          aria-expanded={aiStudioOpen}
          title="Toggle AI Graph Chat Studio"
          aria-label="Toggle AI Graph Chat Studio"
          className={`etg-hud-btn inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-colors cursor-pointer ${
            aiStudioOpen
              ? "border-accent-fg/60 bg-accent/15 text-accent-fg"
              : "border-border bg-surface-elevated/70 text-text-muted hover:border-border-strong hover:text-text-primary"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden lg:inline">AI</span>
        </button>

        <button
          type="button"
          onClick={onOpenAddData}
          title="Import dataset, connect agency feed, or push sensor webhook"
          aria-label="Add Data"
          className="etg-hud-btn inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-md bg-accent px-2 py-0.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-accent-hover cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Add</span>
        </button>

        <button
          type="button"
          popoverTarget="etg-more-popover"
          title="Denver Solar Microgrid, global discovery, NASA EONET sync & export tools"
          aria-label="Observatory tools"
          className="etg-hud-btn inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface-elevated/70 px-2 py-0.5 text-[11.5px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
        >
          <MoreVertical className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden 2xl:inline">Tools</span>
        </button>

        <button
          type="button"
          onClick={onOpenMissionGuide}
          title="Show Observatory Guide & Color Key"
          aria-label="Show observatory guide and color key"
          aria-pressed={missionOpen}
          className={`etg-hud-btn inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-medium transition-colors cursor-pointer ${
            missionOpen
              ? "border-accent-fg/60 bg-accent/15 text-accent-fg"
              : "border-border bg-surface-elevated/70 text-text-muted hover:border-border-strong hover:text-text-primary"
          }`}
        >
          <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
  briefingsCount?: number;
  onResetAllFilters: () => void;
  onToggleTopic: (ds: ETGDatasetId) => void;
  onResetTopics: () => void;
  onChangeSearchQuery: (q: string) => void;
  onSelectSearchTarget: (target: EarthPlaceTarget) => void;
  onToggleRelationCategoryFilter: (cat: RelationCategory) => void;
  onChangeOnlyOpposite: (v: boolean) => void;
  onChangeShowSuperseded: (v: boolean) => void;
  onChangeTempUnit: (u: TemperatureUnit) => void;
  onChangeRelationPopoverFilter: (f: RelationPopoverFilter) => void;
  onRunCaseStudy: (preset: GuidedDipoleCase) => void;
  onSelectEdge: (edge: ETGEdge) => void;
  onSelectCascade: (chain: EarthCascadeChain) => void;
  onOpenSolarGraph: () => void;
  onOpenBriefings?: () => void;
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
  briefingsCount = 0,
  onResetAllFilters,
  onToggleTopic,
  onResetTopics,
  onChangeSearchQuery,
  onSelectSearchTarget,
  onToggleRelationCategoryFilter,
  onChangeOnlyOpposite,
  onChangeShowSuperseded,
  onChangeTempUnit,
  onChangeRelationPopoverFilter,
  onRunCaseStudy,
  onSelectEdge,
  onSelectCascade,
  onOpenSolarGraph,
  onOpenBriefings,
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
      <div id="etg-filter-popover" popover="auto" className="etg-popover space-y-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Choose What You See
          </h3>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={onResetAllFilters}
              className="text-[11px] font-medium text-accent-fg hover:underline cursor-pointer"
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

        {/* Mobile Search Input + Quick Picks (shown whenever header search is collapsed < md) */}
        <div className="md:hidden space-y-1.5">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onChangeSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key !== "Enter") return;
              const matches = searchObservatoryTargets(searchQuery, nodes, 4);
              if (matches[0]) {
                e.preventDefault();
                onSelectSearchTarget(matches[0]);
                hidePopoverById("etg-filter-popover");
              }
            }}
            placeholder="Search Boulder, ENSO, 40,-105…"
            className="form-input"
          />
          <div className="flex flex-wrap gap-1">
            {searchObservatoryTargets(searchQuery, nodes, 4).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectSearchTarget(item);
                  hidePopoverById("etg-filter-popover");
                }}
                className="rounded-xs border border-border bg-surface-inset px-2 py-0.5 text-[10.5px] text-text-muted hover:border-accent-fg hover:text-text-primary cursor-pointer"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Relation Categories Checkboxes (Compact 2-Col Grid) */}
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
            Relation Categories
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            {ALL_RELATION_CATEGORIES.map((cat) => {
              const dotColor =
                cat === "opposite"
                  ? "#fb7185"
                  : cat === "causal"
                    ? "#34d399"
                    : cat === "coupled"
                      ? "#38bdf8"
                      : "#a78bfa";
              const shortCatLabel =
                cat === "opposite"
                  ? "Opposite (⇄)"
                  : cat === "causal"
                    ? "Causal (→)"
                    : cat === "coupled"
                      ? "Evidence"
                      : "Lineage";
              return (
                <label
                  key={cat}
                  title={RELATION_CATEGORY_META[cat].label}
                  className="etg-check-label text-[11.5px] text-text-primary"
                >
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
                  <span className="truncate">{shortCatLabel}</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Graph Toggles + Temperature Unit */}
        <div className="space-y-1.5 border-y border-border py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-2 gap-y-0.5">
            <label className="etg-check-label text-[11.5px] text-text-primary">
              <input
                type="checkbox"
                checked={onlyOpposite}
                onChange={(e) => onChangeOnlyOpposite(e.target.checked)}
                className="checkbox-native"
              />
              <span>Only opposite</span>
            </label>
            <label className="etg-check-label text-[11.5px] text-text-primary">
              <input
                type="checkbox"
                checked={showSuperseded}
                onChange={(e) => onChangeShowSuperseded(e.target.checked)}
                className="checkbox-native"
              />
              <span>Updated findings</span>
            </label>
          </div>
          <div className="flex items-center justify-between pt-0.5">
            <span className="text-[11.5px] font-medium text-text-muted">Temperature unit</span>
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
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-inset px-2.5 py-1.5">
          {(["Concept", "Signal", "Insight", "Rule"] as ETGNodeLabel[]).map((label) => {
            const palette = ETG_LABEL_PALETTE[label];
            return (
              <div key={label} className="flex items-center gap-1.5 text-[11px] text-text-primary">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: palette.color }}
                />
                <span>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Earth Trend Relations & Causal Chains Popover */}
      <div id="etg-dipoles-popover" popover="auto" className="etg-popover space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-primary">
            Earth Relations &amp; Chains
          </h3>
          <span className="ws-numeric font-mono text-[10.5px] text-text-subtle">
            {formattedAllRelations.length} links · {cascades.length} chains
          </span>
        </div>

        {/* Guided Opposite-Trend Case Studies (Progressive Disclosure) */}
        <details className="etg-details">
          <summary>
            <span>Guided Case Studies ({GUIDED_DIPOLE_CASES.length})</span>
          </summary>
          <div className="grid gap-1 p-2">
            {GUIDED_DIPOLE_CASES.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onRunCaseStudy(preset)}
                className="flex flex-col items-start rounded-sm border border-border bg-surface px-2 py-1 text-left transition-colors hover:border-rose-400 cursor-pointer"
              >
                <span className="text-[11px] font-semibold text-text-primary">
                  {preset.title}
                </span>
                <span className="line-clamp-1 text-[10px] text-text-muted">
                  {preset.spotA.name} vs. {preset.spotB.name}
                </span>
              </button>
            ))}
          </div>
        </details>

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
              className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[10.5px] font-medium text-text-muted transition-colors hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-200 cursor-pointer"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {relationPopoverFilter !== "chains" && (
          <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
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
                    className="w-full space-y-0.5 rounded-md border border-border bg-surface-inset p-2 text-left transition-colors hover:border-accent-fg cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11.5px] font-semibold text-text-primary">
                      <span className="truncate">
                        {srcLabel} {sep} {tgtLabel}
                      </span>
                      <span
                        className={`shrink-0 rounded-xs border px-1.5 py-px text-[9.5px] font-semibold ${badgeClass}`}
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
                    <div className="line-clamp-1 text-[10.5px] text-text-muted">
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
              <div className="rounded-sm border border-border-subtle bg-surface-inset p-2.5 text-xs text-text-subtle">
                No relations match this category yet.
              </div>
            )}
          </div>
        )}

        {(relationPopoverFilter === "all" || relationPopoverFilter === "chains") &&
          cascades.length > 0 && (
            <div className="space-y-1.5 border-t border-border pt-2">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                  Connected Earth Chains
                </h3>
                <span className="ws-numeric font-mono text-[10.5px] text-text-subtle">
                  {cascades.length} chains
                </span>
              </div>

              <div className="space-y-1">
                {cascades.slice(0, 5).map((chain) => (
                  <button
                    key={chain.id}
                    type="button"
                    onClick={() => onSelectCascade(chain)}
                    className="w-full space-y-0.5 rounded-md border border-border bg-amber-950 p-2 text-left transition-colors hover:border-amber-400 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11.5px] font-semibold text-text-primary">
                      <span className="truncate">{chain.title}</span>
                      <span className="ws-numeric shrink-0 font-mono text-amber-300">
                        {chain.spheres.length} steps
                      </span>
                    </div>
                    <div className="truncate text-[10.5px] text-text-muted">{chain.summary}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
      </div>

      {/* 4. More Observatory Tools Popover */}
      <div id="etg-more-popover" popover="auto" className="etg-popover etg-popover-end space-y-2.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          Observatory Tools
        </h3>

        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => {
              hidePopoverById("etg-more-popover");
              onOpenSolarGraph();
            }}
            className="flex w-full items-center justify-between rounded-md border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11.5px] font-medium text-text-primary hover:border-amber-400/60 cursor-pointer"
          >
            <span>Denver Solar Microgrid Graph</span>
            <Sun className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onDiscoverGlobalTrends}
            disabled={discoverBusy}
            className="flex w-full items-center justify-between rounded-sm border border-teal-400 bg-teal-950 px-2.5 py-1.5 text-[11.5px] font-semibold text-teal-300 hover:border-teal-300 disabled:opacity-50 cursor-pointer"
          >
            <span>{discoverBusy ? "Discovering Trends…" : "Re-run Live Global Discovery"}</span>
            <RefreshCw className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={onSyncEonet}
            disabled={eonetBusy}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 text-[11.5px] font-medium text-text-primary hover:border-border-strong disabled:opacity-50 cursor-pointer"
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
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 text-[11.5px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
          >
            <span>Agency Hub (12), Citations &amp; AI Disclosure</span>
            <Globe2 className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
          </button>

          {onOpenBriefings && (
            <button
              type="button"
              onClick={() => {
                hidePopoverById("etg-more-popover");
                onOpenBriefings();
              }}
              className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 text-[11.5px] font-medium text-text-muted hover:border-border-strong hover:text-text-primary cursor-pointer"
            >
              <span>
                Research Papers &amp; Briefings
                {briefingsCount > 0 ? ` (${briefingsCount})` : ""}
              </span>
              <BookOpenText className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            onClick={onExportWorkspaceBundle}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 text-[11.5px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
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
              className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 text-[11.5px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
            >
              <span>Import / Merge Bundle (.json)</span>
              <Upload className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            </label>
          </div>

          <button
            type="button"
            disabled={nodes.length === 0}
            onClick={onClearGraph}
            className="flex w-full items-center justify-between rounded-sm border border-border bg-rose-950 px-2.5 py-1.5 text-[11.5px] font-medium text-rose-300 hover:border-rose-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <span>
              Clear Graph ({nodes.length} {nodes.length === 1 ? "Node" : "Nodes"})
            </span>
            <RotateCcw className="h-3.5 w-3.5 text-rose-300" />
          </button>
        </div>

        <div className="border-t border-border pt-2">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
            Recent Provenance Activity
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto text-[11px] text-text-muted">
            {activity.slice(0, 5).map((act) => (
              <div key={act.id} className="truncate font-mono text-[10.5px]">
                <span className="text-text-faint">{act.kind}:</span> {act.summary}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
