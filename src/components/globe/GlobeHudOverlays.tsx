"use client";

import React, { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  GitCompare,
  Layers,
  Loader2,
  RotateCcw,
  Satellite,
  ScanSearch,
  X,
} from "lucide-react";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import {
  DEFAULT_REGIONAL_FOCUS_RADIUS,
  DEFAULT_SATELLITE_CITY_RADIUS,
  DEFAULT_SATELLITE_METRO_RADIUS,
  DEFAULT_SATELLITE_STREET_RADIUS,
  GIBS_LAYERS,
  getGibsLayerColorbar,
  resolveGlobalFilterLayer,
  type RegionalSatelliteMode,
} from "@/lib/earth/nasaGibsRegional";
import {
  ALL_RELATION_CATEGORIES,
  RELATION_CATEGORY_META,
  formatMicroscopeNodeSummary,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import { hasTerrestrialSurface, isMarineOrCoastalSurface } from "@/lib/earth/surfaceMask";
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
  onProbeCoordinate?: (lat: number, lng: number) => void;
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
  showPlaceLabels: boolean;
  setShowPlaceLabels: React.Dispatch<React.SetStateAction<boolean>>;
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
  zoomToDepth: (targetRadius: number) => void;
  cycleSatelliteZoom: () => void;
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
  { id: "aerial", label: "Aerial HD", detail: "Cloud-free sat" },
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

const ARC_LABELS: Record<GlobeArcMode, string> = {
  all: "All",
  focus: "Focus",
  opposite: "Opp.",
  causal: "Causal",
  dipoles: "Top 6",
  off: "Off",
};

const ARC_FULL_LABELS: Record<GlobeArcMode, string> = {
  all: "Links: All",
  focus: "Links: Focus",
  opposite: "Links: Opposite",
  causal: "Links: Causal",
  dipoles: "Links: Top 6",
  off: "Links: Off",
};

function ColorbarLegend({
  colorbar,
  tempUnit,
}: {
  colorbar: NonNullable<ReturnType<typeof getGibsLayerColorbar>>;
  tempUnit: TemperatureUnit;
}) {
  const cb = formatGibsColorbarForUnit(colorbar, tempUnit);
  return (
    <div className="space-y-0.5 rounded-xs border border-border bg-surface-inset px-2 py-1">
      <div
        className="etg-colorbar-track h-1.5 w-full rounded-xs"
        style={{ background: cb.gradientCss }}
      />
      <div className="ws-numeric flex items-center justify-between gap-2 font-mono text-[9.5px] text-text-muted">
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
  onProbeCoordinate,
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
  showPlaceLabels,
  setShowPlaceLabels,
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
  zoomToDepth,
  cycleSatelliteZoom,
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
    ? "4-Slice"
    : satelliteMode === "aerial"
      ? "Aerial HD"
      : activeGlobalMeta
        ? activeGlobalMeta.shortLabel
        : "Satellite";
  const canShowAerialLabels =
    satelliteMode !== "off" &&
    satelliteMode !== "true_color" &&
    satelliteMode !== "night_viirs";
  const depthRingLabels =
    regionalHud.depthTier === "ground"
      ? { inner: "250 m block", outer: "1 km local" }
      : regionalHud.depthTier === "city"
        ? { inner: "2 km local", outer: "10 km urban" }
        : regionalHud.depthTier === "metro"
          ? { inner: "10 km urban", outer: "50 km MERRA-2" }
          : { inner: "50 km MERRA-2", outer: "150 km mesoscale" };

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
                className={`${
                  compareMode ? "pointer-events-none opacity-60" : "pointer-events-auto"
                } -translate-x-1/2 -translate-y-1/2 absolute inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-medium shadow-md transition-colors cursor-pointer ${
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
              onClick={() => {
                if (
                  compareMode &&
                  onProbeCoordinate &&
                  typeof lbl.node.properties.lat === "number" &&
                  typeof lbl.node.properties.lng === "number" &&
                  Number.isFinite(lbl.node.properties.lat) &&
                  Number.isFinite(lbl.node.properties.lng)
                ) {
                  onProbeCoordinate(lbl.node.properties.lat, lbl.node.properties.lng);
                  return;
                }
                onSelectNode(lbl.node);
              }}
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
          className="etg-hud-pill pointer-events-auto absolute top-2.5 left-12 z-10 max-sm:left-[3.25rem] max-sm:w-[calc(100dvw-4rem)] sm:w-[min(256px,calc(100dvw-4rem))] space-y-1.5 rounded-lg border border-border bg-surface/95 p-2 text-xs shadow-lg backdrop-blur-md"
        >
          <div className="flex items-start justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  globalHud.error ? "bg-rose-400" : "bg-sky-400"
                }`}
                aria-hidden="true"
              />
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="truncate font-semibold text-text-primary leading-tight">
                {isMultiSliceFilter
                  ? "NASA SVS 4-Slice"
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
                popoverTarget="etg-gibs-popover"
                title="Switch NASA GIBS satellite layer"
                className="hidden sm:inline-flex items-center rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
              >
                Layers…
              </button>
              <button
                type="button"
                onClick={() => setSatelliteMode("off")}
                aria-label="Clear global Earth filter"
                className="inline-flex items-center gap-0.5 rounded-sm border border-border-strong bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
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

          <div className="ws-numeric flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[9.5px] text-text-muted">
            <span className="truncate">
              {isMultiSliceFilter
                ? "MERRA-2 · IMERG · MODIS"
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
                <span className="text-rose-300">Archive fallback</span>
              </>
            )}
          </div>

          {isMultiSliceFilter ? (
            <div className={`grid grid-cols-4 gap-1 rounded-xs border border-border bg-surface-inset p-1 text-[9.5px] ${mobileHudExpanded ? "" : "max-sm:hidden"}`}>
              <div className="space-y-0.5">
                <div className="etg-colorbar-track h-1 rounded-xs bg-gradient-to-r from-emerald-800 to-lime-500" />
                <div className="truncate font-medium text-text-primary">Canopy</div>
              </div>
              <div className="space-y-0.5">
                <div className="etg-colorbar-track h-1 rounded-xs bg-gradient-to-r from-blue-900 via-cyan-400 to-amber-300" />
                <div className="truncate font-medium text-text-primary">Winds</div>
              </div>
              <div className="space-y-0.5">
                <div className="etg-colorbar-track h-1 rounded-xs bg-gradient-to-r from-lime-400 via-amber-400 to-red-600" />
                <div className="truncate font-medium text-text-primary">Precip.</div>
              </div>
              <div className="space-y-0.5">
                <div className="etg-colorbar-track h-1 rounded-xs bg-gradient-to-r from-slate-600 to-slate-100" />
                <div className="truncate font-medium text-text-primary">Clouds</div>
              </div>
            </div>
          ) : (
            activeGlobalMeta?.colorbar && (
              <ColorbarLegend colorbar={activeGlobalMeta.colorbar} tempUnit={tempUnit} />
            )
          )}
        </section>
      )}

      {/* Top-Left Regional Satellite HUD Card */}
      {isRegionalZoom && (
        <section
          aria-label="Regional NASA GIBS satellite overlay"
          className="etg-hud-pill pointer-events-auto absolute top-2.5 left-12 z-10 max-sm:left-[3.25rem] max-sm:w-[calc(100dvw-4rem)] sm:w-[min(256px,calc(100dvw-4rem))] space-y-1.5 rounded-lg border border-border bg-surface/95 p-2 text-xs shadow-lg backdrop-blur-md"
        >
          <div className="flex items-start justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  regionalHud.error
                    ? "bg-rose-400"
                    : regionalHud.aerialActive
                      ? "bg-emerald-400"
                      : regionalHud.layerId
                        ? "bg-sky-400"
                        : "bg-text-subtle"
                }`}
                aria-hidden="true"
              />
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="truncate font-semibold text-text-primary leading-tight">
                {regionalHud.aerialActive
                  ? "Cloud-Free Sat"
                  : activeGibsMeta
                    ? activeGibsMeta.shortLabel
                    : "Regional Vector"}
              </span>
              {!regionalHud.aerialActive &&
                activeGibsMeta?.isDataLayer &&
                satelliteMode !== "off" && (
                  <span className="shrink-0 rounded-xs border border-emerald-500/40 bg-emerald-950/70 px-1 py-0 text-[9px] font-semibold text-emerald-300">
                    + Aerial
                  </span>
                )}
              {regionalHud.loading && (
                <Loader2
                  className="h-3 w-3 shrink-0 animate-spin text-sky-400"
                  aria-label="Loading high-resolution satellite imagery"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {canShowAerialLabels && (
                <button
                  type="button"
                  aria-pressed={showPlaceLabels}
                  onClick={() => setShowPlaceLabels((v) => !v)}
                  className="inline-flex shrink-0 items-center rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-emerald-400/70 aria-pressed:bg-emerald-950/70 aria-pressed:text-emerald-200 cursor-pointer"
                  title="Toggle geographic places and borders on satellite imagery"
                >
                  Labels
                </button>
              )}
              <button
                type="button"
                onClick={resetCamera}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-strong bg-surface-elevated px-1.5 py-0.5 text-[10px] font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
                title="Reset camera to global Earth view"
              >
                <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
                <span>Global</span>
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

          <div className="ws-numeric flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[9.5px] text-text-muted">
            {regionalHud.aerialActive ? (
              <>
                <span className="truncate">
                  z{regionalHud.aerialZoom} · {regionalHud.aerialResolutionLabel}
                </span>
                <span aria-hidden="true">·</span>
                <span>Alt {regionalHud.altitudeKm} km</span>
                <span aria-hidden="true">·</span>
                <span>~{regionalHud.swathKm} km</span>
              </>
            ) : (
              <>
                <span className="truncate">
                  {activeGibsMeta ? activeGibsMeta.resolutionLabel : "Vector grid"}
                </span>
                <span aria-hidden="true">·</span>
                <span>Alt {regionalHud.altitudeKm} km</span>
                <span aria-hidden="true">·</span>
                <span>{regionalHud.dateIso}</span>
              </>
            )}
          </div>

          {activeRegionalColorbar && (
            <ColorbarLegend colorbar={activeRegionalColorbar} tempUnit={tempUnit} />
          )}

          <div
            className={`space-y-1.5 ${mobileHudExpanded ? "" : "max-sm:hidden"}`}
          >
            <div className="flex items-center justify-between gap-2 text-[9.5px] text-text-subtle">
              <div className="flex items-center gap-2 truncate">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
                  <span>{depthRingLabels.inner}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
                  <span>{depthRingLabels.outer}</span>
                </span>
              </div>
              <button
                type="button"
                popoverTarget="etg-gibs-popover"
                title="Open NASA GIBS layer & spectral band picker"
                className="shrink-0 rounded-xs border border-border bg-surface-inset px-1.5 py-px font-medium text-text-primary hover:border-sky-400 cursor-pointer"
              >
                {REGIONAL_SATELLITE_OPTIONS.find((o) => o.id === satelliteMode)?.label ?? earthFilterButtonLabel} ▾
              </button>
            </div>

            <div className="grid grid-cols-4 gap-1" role="group" aria-label="Satellite zoom depth">
              <button
                type="button"
                aria-pressed={
                  regionalHud.depthTier === "corridor" || regionalHud.depthTier === "mesoscale"
                }
                onClick={() => zoomToDepth(DEFAULT_REGIONAL_FOCUS_RADIUS)}
                className="rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                Region
              </button>
              <button
                type="button"
                aria-pressed={regionalHud.depthTier === "metro"}
                onClick={() => zoomToDepth(DEFAULT_SATELLITE_METRO_RADIUS)}
                className="rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                Metro
              </button>
              <button
                type="button"
                aria-pressed={regionalHud.depthTier === "city"}
                onClick={() => zoomToDepth(DEFAULT_SATELLITE_CITY_RADIUS)}
                className="rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                City
              </button>
              <button
                type="button"
                aria-pressed={regionalHud.depthTier === "ground"}
                onClick={() => zoomToDepth(DEFAULT_SATELLITE_STREET_RADIUS)}
                className="rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
              >
                Street
              </button>
            </div>
          </div>

          {regionalHud.error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 rounded-xs border border-rose-400 bg-rose-950 px-2 py-1 text-[10.5px] text-rose-300"
            >
              <span>
                {regionalHud.aerialActive
                  ? "Failed to fetch high-res satellite tiles — showing base globe + geodesic rings."
                  : "Failed to fetch NASA GIBS satellite tile — showing Blue Marble + geodesic rings."}
              </span>
              <button
                type="button"
                onClick={onRetryRegionalTile}
                aria-label="Retry satellite tile"
                className="shrink-0 cursor-pointer rounded-xs border border-rose-400 bg-rose-900 px-1.5 py-0.5 text-[10px] font-semibold text-rose-100 hover:bg-rose-800"
              >
                Retry
              </button>
            </div>
          )}

          {!regionalHud.error &&
            satelliteMode !== "off" &&
            !regionalHud.layerId &&
            !regionalHud.aerialActive &&
            Math.abs(regionalHud.centerLat) > 85 && (
              <div className="rounded-xs border border-border-subtle bg-surface-inset px-2 py-1 text-[10.5px] text-text-muted">
                High-res satellite &amp; GIBS Web Mercator tiles unavailable poleward of 85°.
              </div>
            )}
        </section>
      )}

      {/* Left-Edge Vertical Camera Dock */}
      <div className="absolute left-2.5 top-2.5 z-10 sm:left-2.5 sm:top-1/2 sm:-translate-y-1/2">
        <GraphCameraDock
          orientation="vertical"
          showOrbitControls
          isOrbiting={autoRotate}
          onToggleOrbit={() => setAutoRotate((v) => !v)}
          onRecenter={resetCamera}
          onSatelliteZoom={cycleSatelliteZoom}
          isSatelliteZoom={isRegionalZoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
        />
      </div>

      {/* Coordinated Single-Row Bottom HUD Bar */}
      <div
        className={`etg-stage-hud-row pointer-events-none absolute bottom-2.5 left-2.5 right-2.5 z-10 flex flex-wrap items-center justify-between gap-1.5 sm:left-12 ${
          inspectorOpen ? "sm:right-[22.75rem] xl:right-[23.75rem]" : "sm:right-2.5"
        } ${
          mobileSheetExpanded
            ? "max-sm:hidden"
            : inspectorOpen
              ? "max-sm:bottom-[7.5rem]"
              : ""
        }`}
      >
        <div className="pointer-events-auto relative flex flex-wrap items-center gap-1.5">
          <div
            ref={globeToolbarRef}
            {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
            onKeyDown={handleGlobeToolbarKeyDown}
            onFocusCapture={handleGlobeToolbarFocusCapture}
            role="toolbar"
            aria-orientation="horizontal"
            aria-label="Globe display controls"
            className="etg-hud-pill inline-flex items-center gap-0.5 rounded-md bg-surface p-0.5 text-[11px]"
          >
            <button
              type="button"
              tabIndex={globeToolbarIdx === 0 ? 0 : -1}
              popoverTarget="etg-globe-layers-popover"
              aria-label="Globe layers and relation options"
              className="etg-hud-btn inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
              title="Customize globe overlays, lighting, arcs, pins, clouds, and relation categories"
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="etg-cq-hide-narrow">Layers</span>
            </button>

            <button
              type="button"
              tabIndex={globeToolbarIdx === 1 ? 0 : -1}
              onClick={cycleArcMode}
              aria-label={ARC_FULL_LABELS[arcMode]}
              title="Cycle globe relation arcs: Focus (selected spot), Opposite, Causal, Top 6, All, or Off"
              className={`etg-hud-btn inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
                arcMode === "opposite"
                  ? "border-rose-400/50 bg-rose-950/60 text-rose-200"
                  : arcMode === "causal"
                    ? "border-emerald-400/50 bg-emerald-950/60 text-emerald-200"
                    : arcMode === "dipoles" || arcMode === "all"
                      ? "border-sky-400/50 bg-sky-950/60 text-sky-200"
                      : "border-transparent text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="etg-cq-hide-tight">{ARC_LABELS[arcMode]}</span>
            </button>

            {onToggleCompareMode && (
              <button
                type="button"
                tabIndex={globeToolbarIdx === 2 ? 0 : -1}
                aria-pressed={Boolean(compareMode)}
                aria-label="Compare 2 spots on Earth"
                title="Compare 2 spots on Earth"
                onClick={onToggleCompareMode}
                className="etg-hud-btn inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary aria-pressed:border-cyan-400/60 aria-pressed:bg-cyan-950/60 aria-pressed:text-cyan-200 cursor-pointer"
              >
                <GitCompare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="etg-cq-hide-narrow hidden sm:inline">
                  {compareMode ? "Comparing" : "Compare"}
                </span>
              </button>
            )}

            <button
              type="button"
              tabIndex={globeToolbarIdx === (onToggleCompareMode ? 3 : 2) ? 0 : -1}
              popoverTarget="etg-gibs-popover"
              aria-label={earthFilterButtonLabel}
              title="Global & regional NASA GIBS scientific Earth filters"
              className={`etg-hud-btn inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
                isRegionalZoom || isMultiSliceFilter || activeGlobalFilter !== null
                  ? "border-sky-400/50 bg-sky-950/60 text-sky-200"
                  : "border-transparent text-text-muted hover:bg-surface-band hover:text-text-primary"
              }`}
            >
              <Satellite className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
              <span className="etg-cq-hide-tight hidden sm:inline">{earthFilterButtonLabel}</span>
            </button>
          </div>

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
            const summaryTitle = `${humanizeNodeText(top.node.properties.name)} — ${formatMicroscopeNodeSummary(top.cue)}`;
            const dotCls = isGlitch
              ? "bg-rose-400"
              : isCycle
                ? "bg-violet-400"
                : "bg-amber-400";
            return (
              <button
                type="button"
                onClick={() => onSelectNode(top.node)}
                title={summaryTitle}
                aria-label={`Focus AI Trend Microscope finding (${flagged.length} flagged): ${humanizeNodeText(top.node.properties.name)}`}
                className="etg-hud-pill etg-hud-btn ws-numeric inline-flex h-[30px] items-center gap-1 rounded-md border-border bg-surface px-2 text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls}`} aria-hidden="true" />
                <ScanSearch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="etg-cq-hide-narrow">Microscope · </span>
                <span>{flagged.length}</span>
              </button>
            );
          })()}

          {probedCoord && !inspectorOpen && (
            <div className="etg-cq-hide-tight etg-hud-pill ws-numeric inline-flex h-[30px] items-center gap-1.5 rounded-md border-border bg-surface px-2 font-mono text-[10.5px] text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
              <span>
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

          {/* Upward Layers, Lighting & Relations Customization Popover */}
          <div
            id="etg-globe-layers-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-72 space-y-2 p-2.5 text-xs"
          >
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                Globe Arc Links
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: "focus", label: "Selected" },
                    { id: "opposite", label: "Opposite" },
                    { id: "causal", label: "Causal →" },
                    { id: "dipoles", label: "Top 6" },
                    { id: "all", label: "All Links" },
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

            <div className="border-t border-border pt-2">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                <span>Solar Lighting</span>
                {sunPreset === "live" && (
                  <span className="font-mono text-[10px] text-amber-400">
                    {liveUtcTime || "Live UTC"}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {(
                  [
                    { id: "live", label: "Live UTC" },
                    { id: "daylight", label: "Full Daylight" },
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
                    }}
                    className="rounded-sm border border-border bg-surface-inset px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary aria-pressed:border-accent-fg aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {onChangeEnabledCategories && (
              <div className="border-t border-border pt-2">
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

            <div className="border-t border-border pt-2">
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
                  <span className="text-xs text-text-primary">Station &amp; trend pins</span>
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
                    checked={filterSmooth}
                    onChange={(e) => setFilterSmooth(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">Smooth satellite pixels</span>
                </label>
                <label className="etg-check-label">
                  <input
                    type="checkbox"
                    className="checkbox-native"
                    checked={showPlaceLabels}
                    onChange={(e) => setShowPlaceLabels(e.target.checked)}
                  />
                  <span className="text-xs text-text-primary">
                    Place &amp; border labels (satellite zoom)
                  </span>
                </label>
              </div>
            </div>

            {onChangeTempUnit && (
              <div className="flex items-center justify-between border-t border-border pt-2">
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

          {/* Upward Regional NASA GIBS Satellite Popover */}
          <div
            id="etg-gibs-popover"
            popover="auto"
            className="etg-popover etg-popover-up w-72 space-y-2 p-2.5 text-xs"
          >
            <div className="flex items-center justify-between px-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
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
                className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-2.5 py-1 text-[11.5px] font-semibold text-text-primary hover:border-sky-400 hover:bg-sky-950 hover:text-sky-300 cursor-pointer"
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
                className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-2.5 py-1 text-[11.5px] font-semibold text-sky-300 hover:bg-sky-900 cursor-pointer"
              >
                <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Zoom into Region</span>
              </button>
            )}

            <div className="grid grid-cols-2 gap-1 border-t border-border pt-2">
              {REGIONAL_SATELLITE_OPTIONS.filter((opt) => {
                const targetCoord = isRegionalZoom
                  ? { lat: regionalHud.centerLat, lng: regionalHud.centerLng }
                  : probedCoord;
                if (!targetCoord) return true;
                if (opt.id === "sst_anomaly") {
                  return isMarineOrCoastalSurface(targetCoord.lat, targetCoord.lng);
                }
                if (opt.id === "ndvi") {
                  return hasTerrestrialSurface(targetCoord.lat, targetCoord.lng);
                }
                return true;
              }).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={satelliteMode === opt.id}
                  onClick={() => setSatelliteMode(opt.id)}
                  title={opt.detail}
                  className="flex flex-col items-start rounded-sm border border-border/60 bg-surface-inset/70 px-2 py-1 text-left text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary aria-pressed:border-sky-400 aria-pressed:bg-sky-950 aria-pressed:text-sky-300 cursor-pointer"
                >
                  <span className="truncate w-full">{opt.label}</span>
                  <span className="truncate w-full font-mono text-[9px] text-text-faint">{opt.detail}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {timelineSlot && (
          <div className="pointer-events-auto min-w-[232px] basis-[232px] flex-1 max-sm:w-full sm:max-w-[340px] lg:max-w-[380px]">
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
