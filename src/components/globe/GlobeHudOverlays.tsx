"use client";

import React, { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Cloud,
  GitBranch,
  GitCompare,
  Layers,
  Loader2,
  RotateCcw,
  Satellite,
  ScanSearch,
  Sun,
  X,
} from "lucide-react";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import {
  GIBS_LAYERS,
  getGibsLayerColorbar,
  resolveGlobalFilterLayer,
  type RegionalSatelliteMode,
} from "@/lib/earth/nasaGibsRegional";
import {
  ALL_RELATION_CATEGORIES,
  RELATION_CATEGORY_META,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import {
  formatGibsColorbarForUnit,
  type GlobalHudState,
  type GlobeArcMode,
  type HoveredGlobeInfo,
  type ProjectedArcLabel,
  type ProjectedProbeLabel,
  type ProjectedRegionalNodeLabel,
  type RegionalHudState,
  type SunPreset,
} from "@/components/globe/globeGeometryAndArcs";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  NodeTrendMicroscopeCue,
  RelationCategory,
  TemperatureUnit,
  TrendMicroscopeScanResult,
} from "@/types/etg";

interface GlobeHudOverlaysProps {
  nodes: ETGNode[];
  microscopeScan: TrendMicroscopeScanResult | null;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  probedCoord: { lat: number; lng: number } | null;
  compareMode: boolean;
  inspectorOpen: boolean;
  mobileSheetExpanded: boolean;
  enabledCategories?: ReadonlyArray<RelationCategory>;
  onChangeEnabledCategories?: (cats: RelationCategory[]) => void;
  tempUnit: TemperatureUnit;
  onChangeTempUnit?: (unit: TemperatureUnit) => void;
  activeTopics?: ReadonlyArray<ETGDatasetId>;
  timelineSlot?: React.ReactNode;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onToggleCompareMode?: () => void;
  autoRotate: boolean;
  setAutoRotate: React.Dispatch<React.SetStateAction<boolean>>;
  sunPreset: SunPreset;
  setSunPreset: React.Dispatch<React.SetStateAction<SunPreset>>;
  liveUtcTime: string;
  showClouds: boolean;
  setShowClouds: React.Dispatch<React.SetStateAction<boolean>>;
  arcMode: GlobeArcMode;
  setArcMode: React.Dispatch<React.SetStateAction<GlobeArcMode>>;
  showArcLabels: boolean;
  setShowArcLabels: React.Dispatch<React.SetStateAction<boolean>>;
  showPins: boolean;
  setShowPins: React.Dispatch<React.SetStateAction<boolean>>;
  satelliteMode: RegionalSatelliteMode;
  setSatelliteMode: React.Dispatch<React.SetStateAction<RegionalSatelliteMode>>;
  filterSmooth: boolean;
  setFilterSmooth: React.Dispatch<React.SetStateAction<boolean>>;
  isRegionalZoom: boolean;
  globalHud: GlobalHudState;
  regionalHud: RegionalHudState;
  mobileHudExpanded: boolean;
  setMobileHudExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  projectedArcLabels: ProjectedArcLabel[];
  projectedProbeLabel: ProjectedProbeLabel | null;
  projectedNodeLabels: ProjectedRegionalNodeLabel[];
  hoveredInfo: HoveredGlobeInfo | null;
  containerWidth: number;
  resetCamera: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToRegion: () => void;
  onRetryRegionalTile: () => void;
  onFocusSunPresetCamera: (preset: SunPreset) => void;
}

const ARC_MODE_CYCLE: GlobeArcMode[] = [
  "all",
  "focus",
  "opposite",
  "causal",
  "dipoles",
  "off",
];

const REGIONAL_SATELLITE_OPTIONS: Array<{
  id: RegionalSatelliteMode;
  label: string;
  detail: string;
}> = [
  { id: "auto", label: "Auto", detail: "Matches topic" },
  { id: "multi_slice", label: "4-Slice Split", detail: "NASA SVS Showcase" },
  { id: "winds", label: "Winds", detail: "MERRA-2 Winds" },
  { id: "precip", label: "Water / Rain", detail: "Water Vapor + Rain" },
  { id: "sst_anomaly", label: "Ocean Anomaly", detail: "1 km MUR SST" },
  { id: "thermal", label: "Thermal", detail: "SST & Land Temp" },
  { id: "air_temp", label: "Air Temp", detail: "MERRA-2 2m T" },
  { id: "aerosols", label: "Aerosols", detail: "MERRA-2 Smoke/Dust" },
  { id: "ndvi", label: "NDVI", detail: "250 m Canopy" },
  { id: "true_color", label: "True Color", detail: "MODIS + Borders" },
  { id: "night_viirs", label: "Night", detail: "500 m VIIRS" },
  { id: "off", label: "Off", detail: "Blue Marble" },
];

const SUN_LABELS: Record<SunPreset, string> = {
  live: "Sun: Live",
  daylight: "Full Daylight",
  americas: "Sun: Americas",
  eurasia: "Sun: Eurasia",
  night: "Sun: Night",
};

const ARC_LABELS: Record<GlobeArcMode, string> = {
  all: "Links: All",
  focus: "Links: Selected",
  opposite: "Links: Opposite",
  causal: "Links: Causal →",
  dipoles: "Links: Top 6",
  off: "Links: Hidden",
};

const QUICK_GLOBAL_FILTER_PILLS: Array<{ id: RegionalSatelliteMode; label: string }> = [
  { id: "multi_slice", label: "4-Slice" },
  { id: "winds", label: "Winds" },
  { id: "precip", label: "Water / Rain" },
  { id: "sst_anomaly", label: "Ocean Anomaly" },
  { id: "thermal", label: "Thermal" },
  { id: "air_temp", label: "Air Temp" },
  { id: "aerosols", label: "Aerosols" },
  { id: "ndvi", label: "NDVI" },
  { id: "true_color", label: "True Color" },
  { id: "night_viirs", label: "Night" },
];

function ColorbarLegend({
  colorbar,
  tempUnit,
}: {
  colorbar: NonNullable<ReturnType<typeof getGibsLayerColorbar>>;
  tempUnit: TemperatureUnit;
}) {
  const cb = formatGibsColorbarForUnit(colorbar, tempUnit);
  return (
    <div className="space-y-1 rounded-xs border border-border bg-surface-inset px-2 py-1.5">
      <div
        className="etg-colorbar-track h-2 w-full rounded-xs"
        style={{ background: cb.gradientCss }}
      />
      <div className="ws-numeric flex items-center justify-between gap-2 font-mono text-[10px] text-text-muted">
        <span>{cb.minLabel}</span>
        {cb.midLabel && (
          <span className="text-text-subtle">{cb.midLabel}</span>
        )}
        <span>
          {cb.maxLabel}{" "}
          <span className="text-text-subtle">({cb.unitLabel})</span>
        </span>
      </div>
    </div>
  );
}

/**
 * Interactive 3D Earth HUD overlays: projected arc/station labels, NASA GIBS legends,
 * camera dock, toolbar, native popovers, timeline slot wrapper, and hover tooltip.
 */
export function GlobeHudOverlays({
  nodes,
  microscopeScan,
  microscopeByNode,
  probedCoord,
  compareMode,
  inspectorOpen,
  mobileSheetExpanded,
  enabledCategories,
  onChangeEnabledCategories,
  tempUnit,
  onChangeTempUnit,
  activeTopics,
  timelineSlot,
  onSelectNode,
  onSelectEdge,
  onToggleCompareMode,
  autoRotate,
  setAutoRotate,
  sunPreset,
  setSunPreset,
  liveUtcTime,
  showClouds,
  setShowClouds,
  arcMode,
  setArcMode,
  showArcLabels,
  setShowArcLabels,
  showPins,
  setShowPins,
  satelliteMode,
  setSatelliteMode,
  filterSmooth,
  setFilterSmooth,
  isRegionalZoom,
  globalHud,
  regionalHud,
  mobileHudExpanded,
  setMobileHudExpanded,
  projectedArcLabels,
  projectedProbeLabel,
  projectedNodeLabels,
  hoveredInfo,
  containerWidth,
  resetCamera,
  zoomIn,
  zoomOut,
  zoomToRegion,
  onRetryRegionalTile,
  onFocusSunPresetCamera,
}: GlobeHudOverlaysProps) {
  const globeToolbarRef = useRef<HTMLDivElement | null>(null);
  const [globeToolbarIdx, setGlobeToolbarIdx] = useState(0);

  const hideGibsPopover = () => {
    const pop = document.getElementById("etg-gibs-popover") as
      | (HTMLElement & { hidePopover?: () => void })
      | null;
    pop?.hidePopover?.();
  };

  const activeGlobalFilter = resolveGlobalFilterLayer(satelliteMode, activeTopics);

  const cycleArcMode = () => {
    setArcMode((prev) => {
      const idx = ARC_MODE_CYCLE.indexOf(prev);
      return ARC_MODE_CYCLE[(idx + 1) % ARC_MODE_CYCLE.length] ?? "all";
    });
  };

  const activeCategorySet = new Set<RelationCategory>(
    enabledCategories ?? ALL_RELATION_CATEGORIES
  );

  const toggleRelationCategory = (cat: RelationCategory) => {
    if (!onChangeEnabledCategories) return;
    const next = activeCategorySet.has(cat)
      ? Array.from(activeCategorySet).filter((c) => c !== cat)
      : [...Array.from(activeCategorySet), cat];
    onChangeEnabledCategories(next);
  };

  const handleGlobeToolbarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = Array.from(
      globeToolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    if (buttons.length === 0) return;
    const current = buttons.findIndex((b) => b === document.activeElement);
    const idx = current >= 0 ? current : globeToolbarIdx;
    let next = idx;
    if (e.key === "ArrowLeft") next = (idx - 1 + buttons.length) % buttons.length;
    if (e.key === "ArrowRight") next = (idx + 1) % buttons.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = buttons.length - 1;
    e.preventDefault();
    setGlobeToolbarIdx(next);
    buttons[next]?.focus();
  };

  const handleGlobeToolbarFocusCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    const targetBtn =
      e.target instanceof Element ? e.target.closest("button") : null;
    if (!targetBtn) return;
    const buttons = Array.from(
      globeToolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    const idx = buttons.findIndex((b) => b === targetBtn);
    if (idx >= 0) {
      setGlobeToolbarIdx(idx);
    }
  };

  const activeGibsMeta = regionalHud.layerId ? GIBS_LAYERS[regionalHud.layerId] : null;
  const activeRegionalColorbar = getGibsLayerColorbar(regionalHud.layerId);
  const isMultiSliceFilter = satelliteMode === "multi_slice";
  const activeGlobalMeta = activeGlobalFilter ? GIBS_LAYERS[activeGlobalFilter] : null;
  const earthFilterButtonLabel = isMultiSliceFilter
    ? "Filter: 4-Slice Split"
    : activeGlobalMeta
      ? `Filter: ${activeGlobalMeta.shortLabel}`
      : "Earth Filter";

  return (
    <>
      {/* Front-Hemisphere Interactive Arc Relation & Active Comparison Labels */}
      {((showArcLabels && projectedArcLabels.length > 0) || projectedProbeLabel !== null) && (
        <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
          {projectedProbeLabel && (
            <div
              style={{ left: `${projectedProbeLabel.x}px`, top: `${projectedProbeLabel.y}px` }}
              className="pointer-events-none -translate-x-1/2 -translate-y-1/2 absolute inline-flex items-center gap-1.5 rounded-sm border border-rose-400 bg-rose-950/95 px-2.5 py-1 text-[11px] font-medium text-rose-100 shadow-lg backdrop-blur-sm"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: projectedProbeLabel.colorCss }}
                aria-hidden="true"
              />
              <span className="font-semibold whitespace-nowrap">{projectedProbeLabel.badgeText}</span>
              <span className="max-w-[160px] truncate text-rose-200 hidden sm:inline">
                {projectedProbeLabel.pairLabel}
              </span>
              {projectedProbeLabel.statText && (
                <span className="font-mono text-[10px] font-semibold ws-numeric whitespace-nowrap text-amber-300">
                  {projectedProbeLabel.statText}
                </span>
              )}
            </div>
          )}
          {showArcLabels &&
            projectedArcLabels.map((lbl) => (
              <button
                key={lbl.uuid}
                type="button"
                onClick={() => onSelectEdge?.(lbl.edge)}
                style={{ left: `${lbl.x}px`, top: `${lbl.y}px` }}
                className={`pointer-events-auto -translate-x-1/2 -translate-y-1/2 absolute inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-medium shadow-md transition-colors cursor-pointer ${
                  lbl.isSelected
                    ? "border-amber-300 bg-amber-950 text-amber-300 ring-1 ring-amber-400"
                    : "border-border bg-surface text-text-primary hover:border-text-muted hover:bg-surface-elevated"
                }`}
                title={`${lbl.badgeText}: ${lbl.pairLabel}${lbl.statText ? ` (${lbl.statText})` : ""}`}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: lbl.colorCss }}
                  aria-hidden="true"
                />
                <span className="font-semibold whitespace-nowrap">{lbl.badgeText}</span>
                <span className="max-w-[130px] truncate text-text-muted hidden sm:inline">
                  {lbl.pairLabel}
                </span>
                {lbl.statText && (
                  <span
                    className={`font-mono text-[9px] ws-numeric whitespace-nowrap ${
                      lbl.isSelected ? "text-amber-300" : "etg-tone-warm"
                    }`}
                  >
                    {lbl.statText}
                  </span>
                )}
              </button>
            ))}
        </div>
      )}

      {/* Regional Zoom Station & Node Badges */}
      {showPins && isRegionalZoom && projectedNodeLabels.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-[6] overflow-hidden">
          {projectedNodeLabels.map((lbl) => (
            <button
              key={lbl.uuid}
              type="button"
              onClick={() => onSelectNode(lbl.node)}
              style={{ left: `${lbl.x}px`, top: `${lbl.y}px` }}
              className={`pointer-events-auto -translate-x-1/2 -translate-y-1/2 absolute inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-medium shadow-md transition-colors cursor-pointer ${
                lbl.isSelected
                  ? "border-amber-300 bg-amber-950 text-amber-300 ring-1 ring-amber-400"
                  : "border-border-strong bg-surface text-text-primary hover:border-accent-fg hover:bg-surface-elevated"
              }`}
              title={lbl.name}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: lbl.colorCss }}
                aria-hidden="true"
              />
              <span className="max-w-[140px] truncate font-semibold whitespace-nowrap">
                {lbl.name}
              </span>
              {lbl.metricText && (
                <span
                  className={`font-mono text-[9px] ws-numeric whitespace-nowrap ${
                    lbl.isSelected ? "text-amber-300" : "etg-tone-warm"
                  }`}
                >
                  {lbl.metricText}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Top-Left Global Earth Filter Legend HUD Card */}
      {!isRegionalZoom && (isMultiSliceFilter || activeGlobalMeta !== null) && (
        <section
          aria-label="Global NASA GIBS scientific Earth filter"
          className="etg-hud-pill pointer-events-auto absolute top-3 left-14 z-10 max-sm:left-[4.75rem] max-sm:w-[calc(100dvw-5.5rem)] sm:top-3 sm:w-[min(368px,calc(100dvw-5rem))] space-y-2 rounded-md border border-border bg-surface/95 p-2.5 text-xs shadow-lg backdrop-blur-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  globalHud.error ? "bg-rose-400" : "bg-sky-400"
                }`}
                aria-hidden="true"
              />
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="truncate font-semibold text-text-primary">
                {isMultiSliceFilter
                  ? "NASA SVS 4-Slice Earth Composite"
                  : activeGlobalMeta?.label}
              </span>
              {globalHud.loading && (
                <Loader2
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400"
                  aria-label="Loading NASA GIBS Earth filter"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-pressed={filterSmooth}
                onClick={() => setFilterSmooth((v) => !v)}
                title="Smooth quantized satellite contours and 1 km speckles"
                className="hidden sm:inline-flex items-center rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[10px] font-semibold text-text-muted transition-colors hover:border-text-muted hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                Smooth
              </button>
              <button
                type="button"
                onClick={() => setSatelliteMode("off")}
                aria-label="Clear global Earth filter"
                className="inline-flex items-center gap-1 rounded-sm border border-border-strong bg-surface-elevated px-2 py-0.5 text-[10px] font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
              >
                <X className="h-3 w-3" aria-hidden="true" />
                <span>Clear</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileHudExpanded((v) => !v)}
                aria-expanded={mobileHudExpanded}
                aria-label={mobileHudExpanded ? "Collapse Earth filter legend" : "Expand Earth filter legend"}
                className="inline-flex sm:hidden items-center justify-center rounded-sm border border-border bg-surface-inset p-1 text-text-muted hover:text-text-primary cursor-pointer"
              >
                {mobileHudExpanded ? (
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div className="ws-numeric flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-text-muted">
            <span className="truncate">
              {isMultiSliceFilter
                ? "MERRA-2 · IMERG · MODIS (Global + Borders)"
                : activeGlobalMeta?.resolutionLabel}
            </span>
            {globalHud.dateIso && (
              <>
                <span aria-hidden="true">·</span>
                <span>{globalHud.dateIso}</span>
              </>
            )}
            {globalHud.resBadge && (
              <>
                <span aria-hidden="true">·</span>
                <span className="rounded-xs border border-sky-400/50 bg-sky-950/80 px-1 py-px text-[9px] font-semibold text-sky-300">
                  {globalHud.resBadge}
                </span>
              </>
            )}
            {globalHud.error && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-rose-300">Archive fallback active</span>
              </>
            )}
          </div>

          {isMultiSliceFilter ? (
            <div className={`grid grid-cols-4 gap-1 rounded-xs border border-border bg-surface-inset p-1.5 text-[10px] ${mobileHudExpanded ? "" : "max-sm:hidden"}`}>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-emerald-800 to-lime-500" />
                <div className="truncate font-medium text-text-primary">1. Canopy</div>
              </div>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-blue-900 via-cyan-400 to-amber-300" />
                <div className="truncate font-medium text-text-primary">2. Winds</div>
              </div>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-lime-400 via-amber-400 to-red-600" />
                <div className="truncate font-medium text-text-primary">3. Precip. Water</div>
              </div>
              <div className="space-y-1">
                <div className="etg-colorbar-track h-1.5 rounded-xs bg-gradient-to-r from-slate-600 to-slate-100" />
                <div className="truncate font-medium text-text-primary">4. Clouds</div>
              </div>
            </div>
          ) : (
            activeGlobalMeta?.colorbar && (
              <ColorbarLegend colorbar={activeGlobalMeta.colorbar} tempUnit={tempUnit} />
            )
          )}

          <div className={`flex flex-wrap gap-1 border-t border-border pt-1.5 ${mobileHudExpanded ? "" : "max-sm:hidden"}`}>
            {QUICK_GLOBAL_FILTER_PILLS.map((pill) => {
              const pressed =
                pill.id === "multi_slice"
                  ? isMultiSliceFilter
                  : !isMultiSliceFilter && activeGlobalFilter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setSatelliteMode(pill.id)}
                  className="rounded-xs border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-text-muted hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                >
                  {pill.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Top-Left Regional Satellite HUD Card */}
      {isRegionalZoom && (
        <section
          aria-label="Regional NASA GIBS satellite overlay"
          className="etg-hud-pill pointer-events-auto absolute top-3 left-14 z-10 max-sm:left-[4.75rem] max-sm:w-[calc(100dvw-5.5rem)] sm:top-3 sm:w-[min(368px,calc(100dvw-5rem))] space-y-2 rounded-md border border-border bg-surface/95 p-2.5 text-xs shadow-lg backdrop-blur-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  regionalHud.error
                    ? "bg-rose-400"
                    : regionalHud.layerId
                      ? "bg-sky-400"
                      : "bg-slate-400"
                }`}
                aria-hidden="true"
              />
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="truncate font-semibold text-text-primary">
                {activeGibsMeta
                  ? activeGibsMeta.label
                  : "Regional Vector View (Basemap Only)"}
              </span>
              {regionalHud.loading && (
                <Loader2
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400"
                  aria-label="Loading NASA GIBS satellite swath"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={resetCamera}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-strong bg-surface-elevated px-2 py-0.5 text-[10px] font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                <span>Global View</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileHudExpanded((v) => !v)}
                aria-expanded={mobileHudExpanded}
                aria-label={mobileHudExpanded ? "Collapse regional satellite legend" : "Expand regional satellite legend"}
                className="inline-flex sm:hidden items-center justify-center rounded-sm border border-border bg-surface-inset p-1 text-text-muted hover:text-text-primary cursor-pointer"
              >
                {mobileHudExpanded ? (
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div className="ws-numeric flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-text-muted">
            <span className="truncate">
              {activeGibsMeta ? activeGibsMeta.resolutionLabel : "50 / 150 km vector grid"}
            </span>
            <span aria-hidden="true">·</span>
            <span>~{regionalHud.swathKm} km swath</span>
            <span aria-hidden="true">·</span>
            <span>{regionalHud.dateIso}</span>
          </div>

          {activeRegionalColorbar && (
            <ColorbarLegend colorbar={activeRegionalColorbar} tempUnit={tempUnit} />
          )}

          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-subtle ${mobileHudExpanded ? "" : "max-sm:hidden"}`}>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
              <span>50 km MERRA-2</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
              <span>150 km mesoscale</span>
            </span>
          </div>

          {regionalHud.error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 rounded-xs border border-rose-400 bg-rose-950 px-2 py-1.5 text-[11px] text-rose-300"
            >
              <span>
                Failed to fetch NASA GIBS satellite tile — showing Blue Marble + geodesic rings.
              </span>
              <button
                type="button"
                onClick={onRetryRegionalTile}
                aria-label="Retry satellite tile"
                className="shrink-0 cursor-pointer rounded-xs border border-rose-400 bg-rose-900 px-2 py-0.5 text-[10px] font-semibold text-rose-100 hover:bg-rose-800"
              >
                Retry
              </button>
            </div>
          )}

          {!regionalHud.error &&
            satelliteMode !== "off" &&
            !regionalHud.layerId &&
            Math.abs(regionalHud.centerLat) > 85 && (
              <div className="rounded-xs border border-border-subtle bg-surface-inset px-2 py-1 text-[11px] text-text-muted">
                NASA GIBS tile unavailable poleward of 85° (Web Mercator limit).
              </div>
            )}

          <div
            className={`grid grid-cols-3 gap-1 ${mobileHudExpanded ? "" : "max-sm:hidden"}`}
            role="group"
            aria-label="Satellite spectral band"
          >
            {REGIONAL_SATELLITE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={satelliteMode === opt.id}
                onClick={() => setSatelliteMode(opt.id)}
                className="rounded-sm border border-border bg-surface-inset px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Left-Edge Vertical Camera Dock */}
      <div className="absolute left-2.5 top-3 z-10 sm:left-3.5 sm:top-1/2 sm:-translate-y-1/2">
        <GraphCameraDock
          orientation="vertical"
          showOrbitControls
          isOrbiting={autoRotate}
          onToggleOrbit={() => setAutoRotate((v) => !v)}
          onRecenter={resetCamera}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
        />
      </div>

      {/* Coordinated Bottom HUD Bar: Globe Display Controls (Left) + Timeline Scrubber (Right) */}
      <div
        className={`pointer-events-none absolute bottom-2 left-2 right-2 z-10 flex flex-wrap items-end justify-between gap-2 sm:bottom-3 sm:left-14 sm:right-4 ${
          inspectorOpen ? "sm:right-[25.75rem] lg:right-[26.25rem]" : ""
        } ${
          mobileSheetExpanded
            ? "max-sm:hidden"
            : inspectorOpen
              ? "max-sm:bottom-[7.75rem]"
              : ""
        }`}
      >
        <div className="pointer-events-auto relative flex flex-col items-start gap-1.5">
          {(() => {
            const flagged = nodes
              .map((node) => ({
                node,
                cue: microscopeByNode?.[node.uuid],
              }))
              .filter(
                (
                  item
                ): item is { node: ETGNode; cue: NodeTrendMicroscopeCue } =>
                  Boolean(
                    item.cue &&
                      (item.cue.radarBadge === "EARLY_ONSET" ||
                        item.cue.radarBadge === "FALSE_TREND_CYCLE" ||
                        item.cue.radarBadge === "SENSOR_GLITCH_RISK")
                  )
              )
              .sort(
                (a, b) =>
                  Math.max(b.cue.onsetProb, b.cue.dealiasing.falseTrendProb) -
                  Math.max(a.cue.onsetProb, a.cue.dealiasing.falseTrendProb)
              );
            if (flagged.length === 0) return null;
            const top = flagged[0];
            const isGlitch = top.cue.radarBadge === "SENSOR_GLITCH_RISK";
            const isCycle = top.cue.radarBadge === "FALSE_TREND_CYCLE";
            return (
              <button
                type="button"
                onClick={() => onSelectNode(top.node)}
                title={microscopeScan?.aiPerceptionBrief || top.cue.aiCue}
                className={`etg-hud-pill ws-numeric inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                  isGlitch
                    ? "border-rose-400 bg-rose-950 text-rose-300 hover:border-rose-300"
                    : isCycle
                      ? "border-violet-400 bg-purple-950 text-violet-300 hover:border-violet-300"
                      : "border-amber-400 bg-amber-950 text-amber-300 hover:border-amber-300"
                }`}
              >
                <ScanSearch className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  Microscope ({flagged.length}): {humanizeNodeText(top.node.properties.name)} ·{" "}
                  {isGlitch
                    ? "Sensor Glitch Risk"
                    : isCycle
                      ? `Cycle Alias ${Math.round(top.cue.dealiasing.oscillationShare * 100)}%`
                      : `Early Onset ${Math.round(top.cue.onsetProb * 100)}%${top.cue.preMannKendallAlert ? " (Pre-MK)" : ""}`}
                </span>
              </button>
            );
          })()}

          {probedCoord && !inspectorOpen && (
            <div className="etg-hud-pill ws-numeric inline-flex items-center gap-2 rounded-sm border-amber-400 bg-amber-950 px-2.5 py-1 font-mono text-[11px] text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
              <span>
                Probe{" "}
                {probedCoord.lat >= 0
                  ? `${probedCoord.lat.toFixed(2)}°N`
                  : `${Math.abs(probedCoord.lat).toFixed(2)}°S`}
                ,{" "}
                {probedCoord.lng >= 0
                  ? `${probedCoord.lng.toFixed(2)}°E`
                  : `${Math.abs(probedCoord.lng).toFixed(2)}°W`}
              </span>
            </div>
          )}

          <div
            ref={globeToolbarRef}
            {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
            onKeyDown={handleGlobeToolbarKeyDown}
            onFocusCapture={handleGlobeToolbarFocusCapture}
            role="toolbar"
            aria-orientation="horizontal"
            aria-label="Globe display controls"
            className="etg-hud-pill inline-flex flex-wrap items-center gap-1 rounded-md bg-surface p-1 text-[11px]"
          >
            <button
              type="button"
              tabIndex={globeToolbarIdx === 0 ? 0 : -1}
              popoverTarget="etg-globe-layers-popover"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
              title="Customize visible globe arcs, pins, labels, clouds, and relation types"
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span>Layers</span>
            </button>

            <button
              type="button"
              tabIndex={globeToolbarIdx === 1 ? 0 : -1}
              onClick={cycleArcMode}
              aria-label={ARC_LABELS[arcMode]}
              title="Cycle globe relation arcs: All, Selected spot, Opposite, Causal, Top 6, or Hidden"
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                arcMode === "opposite"
                  ? "border-rose-400 bg-rose-950 text-rose-300"
                  : arcMode === "causal"
                    ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                    : arcMode === "dipoles" || arcMode === "all"
                      ? "border-sky-400 bg-sky-950 text-sky-300"
                      : arcMode === "off"
                        ? "border-transparent text-text-subtle hover:bg-surface-band hover:text-text-primary"
                        : "border-transparent text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{ARC_LABELS[arcMode]}</span>
            </button>

            <button
              type="button"
              tabIndex={globeToolbarIdx === 2 ? 0 : -1}
              aria-pressed={showClouds}
              aria-label="Toggle 3D clouds"
              onClick={() => setShowClouds((v) => !v)}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-accent-fg aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
            >
              <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Clouds</span>
            </button>

            {onToggleCompareMode && (
              <button
                type="button"
                tabIndex={globeToolbarIdx === 3 ? 0 : -1}
                aria-pressed={Boolean(compareMode)}
                aria-label="Compare 2 spots on Earth"
                onClick={onToggleCompareMode}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-cyan-400 aria-pressed:bg-cyan-950 aria-pressed:text-cyan-300 cursor-pointer"
              >
                <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">Compare 2 Spots</span>
              </button>
            )}

            <div role="separator" aria-orientation="vertical" className="mx-0.5 h-4 border-l border-border" />

            <button
              type="button"
              tabIndex={globeToolbarIdx === (onToggleCompareMode ? 4 : 3) ? 0 : -1}
              popoverTarget="etg-sun-popover"
              aria-label={SUN_LABELS[sunPreset]}
              title="Solar illumination preset"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
            >
              <Sun className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
              <span className="hidden md:inline">{SUN_LABELS[sunPreset]}</span>
            </button>

            <button
              type="button"
              tabIndex={globeToolbarIdx === (onToggleCompareMode ? 5 : 4) ? 0 : -1}
              popoverTarget="etg-gibs-popover"
              aria-label={earthFilterButtonLabel}
              title="Global & regional NASA GIBS scientific Earth filters"
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                isRegionalZoom || isMultiSliceFilter || activeGlobalFilter !== null
                  ? "border-sky-400 bg-sky-950 text-sky-300"
                  : "border-transparent text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="hidden sm:inline">{earthFilterButtonLabel}</span>
            </button>
          </div>

          {/* Upward Layers & Relations Customization Popover */}
          <div
            id="etg-globe-layers-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-72 space-y-3 p-3 text-xs"
          >
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                Globe Arc Links
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: "all", label: "All Links" },
                    { id: "focus", label: "Selected" },
                    { id: "opposite", label: "Opposite" },
                    { id: "causal", label: "Causal →" },
                    { id: "dipoles", label: "Top 6" },
                    { id: "off", label: "Hidden" },
                  ] as Array<{ id: GlobeArcMode; label: string }>
                ).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={arcMode === mode.id}
                    onClick={() => setArcMode(mode.id)}
                    className="rounded-sm border border-border bg-surface-inset px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            {onChangeEnabledCategories && (
              <div className="border-t border-border pt-2.5">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                  Relation Categories
                </div>
                <div className="space-y-0.5">
                  {ALL_RELATION_CATEGORIES.map((cat) => {
                    const checked = activeCategorySet.has(cat);
                    const dotColor =
                      cat === "opposite"
                        ? "#fb7185"
                        : cat === "causal"
                          ? "#34d399"
                          : cat === "coupled"
                            ? "#38bdf8"
                            : "#a78bfa";
                    return (
                      <label key={cat} className="etg-check-label">
                        <input
                          type="checkbox"
                          className="checkbox-native"
                          checked={checked}
                          onChange={() => toggleRelationCategory(cat)}
                        />
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: dotColor }}
                          aria-hidden="true"
                        />
                        <span className="text-xs text-text-primary">
                          {RELATION_CATEGORY_META[cat].label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t border-border pt-2.5">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                Globe Overlays
              </div>
              <div className="space-y-0.5">
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={showArcLabels}
                    onChange={(e) => setShowArcLabels(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">Arc callout labels</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={showPins}
                    onChange={(e) => setShowPins(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">Station & trend pins</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={showClouds}
                    onChange={(e) => setShowClouds(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">3D cloud deck</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={autoRotate}
                    onChange={(e) => setAutoRotate(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">Auto-orbit globe</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={sunPreset !== "daylight"}
                    onChange={(e) => setSunPreset(e.target.checked ? "live" : "daylight")}
                  />
                  <span className="text-xs text-text-primary">Day / night terminator</span>
                </label>
              </div>
            </div>

            {onChangeTempUnit && (
              <div className="flex items-center justify-between border-t border-border pt-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                  Temperature Unit
                </span>
                <div className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5">
                  {(["C", "F"] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      aria-pressed={tempUnit === u}
                      onClick={() => onChangeTempUnit(u)}
                      className="rounded-sm px-2 py-0.5 text-[11px] font-semibold text-text-muted aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                    >
                      °{u}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Upward Lighting Popover */}
          <div
            id="etg-sun-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-56 space-y-1.5 p-2.5"
          >
            <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              <span>Solar Lighting</span>
              {sunPreset === "live" && (
                <span className="font-mono text-[10px] text-amber-400">{liveUtcTime}</span>
              )}
            </div>
            {(
              [
                { id: "live", label: "Live Time (Dynamic)" },
                { id: "daylight", label: "Full Daylight (Off)" },
                { id: "americas", label: "Americas" },
                { id: "eurasia", label: "Eurasia" },
                { id: "night", label: "Night Lights" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={sunPreset === opt.id}
                onClick={() => {
                  setSunPreset(opt.id);
                  onFocusSunPresetCamera(opt.id);
                  const pop = document.getElementById("etg-sun-popover") as
                    | (HTMLElement & { hidePopover?: () => void })
                    | null;
                  pop?.hidePopover?.();
                }}
                className="flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-accent-fg aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
              >
                <span>{opt.label}</span>
                {sunPreset === opt.id && (
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-fg" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>

          {/* Upward Regional NASA GIBS Satellite Popover */}
          <div
            id="etg-gibs-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-64 space-y-2.5 p-2.5 text-xs"
          >
            <div className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              <span>NASA GIBS Earth Filters</span>
              <span className="font-mono text-[10px] text-sky-400">
                {isMultiSliceFilter
                  ? "4-slice"
                  : isRegionalZoom
                    ? regionalHud.tier
                    : activeGlobalFilter
                      ? "global"
                      : "base"}
              </span>
            </div>

            {isRegionalZoom ? (
              <button
                type="button"
                onClick={() => {
                  resetCamera();
                  hideGibsPopover();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reset to Global View</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  zoomToRegion();
                  hideGibsPopover();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-2.5 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-900 cursor-pointer"
              >
                <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Zoom into Region</span>
              </button>
            )}

            <div className="space-y-1 border-t border-border pt-2">
              {REGIONAL_SATELLITE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={satelliteMode === opt.id}
                  onClick={() => setSatelliteMode(opt.id)}
                  className="flex w-full items-center justify-between rounded-sm border border-transparent px-2.5 py-1 text-left text-xs font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                >
                  <span>{opt.label}</span>
                  <span className="font-mono text-[10px] text-text-faint">{opt.detail}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {timelineSlot && (
          <div className="pointer-events-auto min-w-0 w-full flex-1 basis-[220px] sm:min-w-[260px] sm:basis-[340px] sm:max-w-[460px]">
            {timelineSlot}
          </div>
        )}
      </div>

      {/* Hover Tooltip */}
      {hoveredInfo && (
        <div
          className="etg-hud-pill pointer-events-none absolute z-20 max-w-xs rounded-md bg-surface px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(hoveredInfo.x + 14, containerWidth - 240),
            top: Math.max(12, hoveredInfo.y - 46),
          }}
        >
          <div className="font-medium text-text-primary">{hoveredInfo.name}</div>
          <div className="mt-0.5 text-[11px] text-text-muted">{hoveredInfo.subtitle}</div>
          {hoveredInfo.radarDetail && hoveredInfo.radarBadge && (
            <div
              className={`mt-1 inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${
                hoveredInfo.radarBadge === "SENSOR_GLITCH_RISK"
                  ? "border-rose-400 bg-rose-950 text-rose-300"
                  : hoveredInfo.radarBadge === "FALSE_TREND_CYCLE"
                    ? "border-violet-400 bg-purple-950 text-violet-300"
                    : hoveredInfo.radarBadge === "EARLY_ONSET"
                      ? "border-amber-400 bg-amber-950 text-amber-300"
                      : "border-emerald-400 bg-emerald-950 text-emerald-300"
              }`}
            >
              <span>Microscope: {hoveredInfo.radarDetail}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
