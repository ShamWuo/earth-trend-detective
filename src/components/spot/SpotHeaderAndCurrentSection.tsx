"use client";

import type React from "react";
import {
  Activity,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Cloud,
  Droplets,
  Gauge,
  MapPin,
  Maximize2,
  Minimize2,
  Satellite,
  Sun,
  Wind,
  X,
} from "lucide-react";
import { VariableGuidePopoverButton } from "@/components/DatasetSelector";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  formatTemperatureDelta,
  formatTemperatureValue,
} from "@/lib/earth/currentConditionsClient";
import {
  describeComparisonPlainly,
  describeTrendPlainly,
  formatCompactLag,
  formatCoordShort,
} from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  CurrentEarthConditions,
  ETGNode,
  TelemetryFailureKind,
  TelemetryQueryDiagnostics,
  TemperatureUnit,
  TrendAnalysisSummary,
} from "@/types/etg";
import {
  formatObservedStamp,
  type GuidedCaseStudyItem,
  type SpotInspectorTab,
} from "@/components/spot/spotCardShared";
import { getTrendToneStyles } from "@/components/spot/TrendFindingHighlight";

/** Structured spot header with uncrushed balanced heading, unit controls, and single-row ARIA tablist. */
export function SpotCardHeader({
  cardTitle,
  isComparingTwoSpots,
  isCompareHeader,
  coord,
  current,
  selectedNode,
  tempUnit,
  onChangeTempUnit,
  onSatelliteZoomSpot,
  onOpenSolarForSpot,
  mobileCollapsed,
  onToggleMobileCollapse,
  isWide = false,
  onToggleWide,
  activeTab,
  onSelectTab,
  visibleSummaryCount,
  linkedRelationCount,
  onClose,
}: {
  cardTitle: string;
  isComparingTwoSpots: boolean;
  isCompareHeader: boolean;
  coord: { lat: number; lng: number } | null;
  current: CurrentEarthConditions | null;
  selectedNode: ETGNode | null;
  tempUnit: TemperatureUnit;
  onChangeTempUnit?: (unit: TemperatureUnit) => void;
  onSatelliteZoomSpot?: (lat: number, lng: number) => void;
  onOpenSolarForSpot?: (lat: number, lng: number, label: string) => void;
  mobileCollapsed: boolean;
  onToggleMobileCollapse?: () => void;
  isWide?: boolean;
  onToggleWide?: () => void;
  activeTab: SpotInspectorTab;
  onSelectTab: (tab: SpotInspectorTab) => void;
  visibleSummaryCount: number;
  linkedRelationCount: number;
  onClose: () => void;
}) {
  const tabs: Array<{ id: SpotInspectorTab; label: string }> = isCompareHeader
    ? [
        { id: "relations", label: "Comparison" },
        { id: "science", label: "Stats & Graph" },
      ]
    : [
        { id: "overview", label: "Overview" },
        {
          id: "trends",
          label: visibleSummaryCount > 0 ? `Trends (${visibleSummaryCount})` : "Trends",
        },
        {
          id: "relations",
          label: linkedRelationCount > 0 ? `Links (${linkedRelationCount})` : "Links",
        },
        { id: "science", label: "Stats" },
      ];

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.id === activeTab);
    if (idx < 0) return;
    let nextIdx = idx;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    else return;
    e.preventDefault();
    const nextTab = tabs[nextIdx];
    if (!nextTab) return;
    onSelectTab(nextTab.id);
    const btn = document.getElementById(`spot-tab-${nextTab.id}`);
    btn?.focus();
  };

  return (
    <div className="shrink-0 px-4 pt-3.5">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] sm:text-base font-semibold leading-snug text-text-primary">
            {cardTitle}
          </h2>
          {coord && !isComparingTwoSpots && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-subtle">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0 text-accent-fg" aria-hidden="true" />
                <span className="ws-numeric font-mono">{formatCoordShort(coord.lat, coord.lng)}</span>
              </span>
              {current?.elevationM !== null && current?.elevationM !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="ws-numeric font-mono">{Math.round(current.elevationM)} m</span>
                </>
              )}
              {selectedNode?.properties.dataset && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {DATASET_BY_ID[selectedNode.properties.dataset]?.shortLabel ?? "Observation"}
                  </span>
                </>
              )}
              {onSatelliteZoomSpot && (
                <button
                  type="button"
                  onClick={() => onSatelliteZoomSpot(coord.lat, coord.lng)}
                  title="Zoom globe down to City HD satellite view at these coordinates"
                  aria-label="Satellite zoom to spot"
                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-sky-300 transition-colors hover:border-sky-400 hover:bg-sky-950 cursor-pointer"
                >
                  <Satellite className="h-3 w-3" aria-hidden="true" />
                  <span>Sat Zoom</span>
                </button>
              )}
              {onOpenSolarForSpot && (
                <button
                  type="button"
                  onClick={() => onOpenSolarForSpot(coord.lat, coord.lng, cardTitle)}
                  title="Open 7-node upwind solar microgrid forecast at these coordinates"
                  aria-label="Open 7-node solar forecast for spot"
                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-amber-300 transition-colors hover:border-amber-400 hover:bg-amber-950 cursor-pointer"
                >
                  <Sun className="h-3 w-3" aria-hidden="true" />
                  <span>7-Node Solar</span>
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {onChangeTempUnit && (
            <div
              className="inline-flex h-7 items-center rounded-md border border-border bg-surface-inset p-0.5"
              role="group"
              aria-label="Temperature unit"
            >
              {(["C", "F"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={tempUnit === u}
                  onClick={() => onChangeTempUnit(u)}
                  className="rounded-xs px-1.5 py-0.5 text-[10px] font-semibold text-text-muted transition-colors hover:text-text-primary aria-pressed:bg-surface-elevated aria-pressed:text-text-primary cursor-pointer"
                >
                  °{u}
                </button>
              ))}
            </div>
          )}

          <VariableGuidePopoverButton iconOnly />

          {onToggleMobileCollapse && (
            <button
              type="button"
              onClick={onToggleMobileCollapse}
              aria-expanded={!mobileCollapsed}
              aria-label={mobileCollapsed ? "Expand spot card" : "Collapse spot card"}
              title={mobileCollapsed ? "Expand spot card" : "Collapse spot card"}
              className="etg-hud-btn inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-inset text-text-muted transition-colors hover:text-text-primary cursor-pointer sm:hidden"
            >
              {mobileCollapsed ? (
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}

          {onToggleWide && (
            <button
              type="button"
              onClick={onToggleWide}
              title={isWide ? "Restore standard panel width" : "Expand panel width"}
              aria-label={isWide ? "Restore standard panel width" : "Expand panel width"}
              className="etg-hud-btn hidden lg:inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
            >
              {isWide ? (
                <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close spot card"
            className="etg-hud-btn inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Single-Row Accessible Tablist */}
      <div
        role="tablist"
        aria-label="Spot inspector sections"
        onKeyDown={handleTabKeyDown}
        className={`etg-tablist -mx-4 mt-2 px-4 ${mobileCollapsed ? "max-sm:hidden" : ""}`}
      >
        {tabs.map((tab) => {
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`spot-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelectTab(tab.id)}
              className="etg-tab"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Side-by-side comparison mode card section with Pearson/Detrended/Lag metrics & guided case switcher. */
export function SpotComparisonModeSection({
  comparisonDigest,
  primary,
  secondary,
  comparison,
  current,
  secondaryCurrent,
  labelA,
  labelB,
  tempUnit,
  guidedCases,
  activeCaseStudyId,
  onSelectCaseStudy,
  onSwapPins,
  onClearComparison,
}: {
  comparisonDigest: ReturnType<typeof describeComparisonPlainly>;
  primary: TrendAnalysisSummary;
  secondary: TrendAnalysisSummary;
  comparison: CrossRegionComparison;
  current: CurrentEarthConditions | null;
  secondaryCurrent: CurrentEarthConditions | null;
  labelA: string;
  labelB: string;
  tempUnit: TemperatureUnit;
  guidedCases?: ReadonlyArray<GuidedCaseStudyItem>;
  activeCaseStudyId: string | null;
  onSelectCaseStudy?: (caseId: string) => void;
  onSwapPins: () => void;
  onClearComparison: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${
            comparisonDigest.badgeLabel === "Opposite trends"
              ? "border-rose-400 bg-rose-950 text-rose-300"
              : comparisonDigest.badgeLabel === "Moving together"
                ? "border-sky-400 bg-sky-950 text-sky-300"
                : "border-border bg-surface-inset text-text-muted"
          }`}
        >
          {comparisonDigest.badgeLabel} · {comparisonDigest.strengthLabel}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onSwapPins}
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
          >
            <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
            <span>Swap</span>
          </button>
          <button
            type="button"
            onClick={onClearComparison}
            className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary cursor-pointer"
          >
            1 spot
          </button>
        </div>
      </div>

      <p className="text-[13px] font-medium leading-snug text-text-primary">
        {comparisonDigest.headline}
      </p>
      <p className="leading-relaxed text-text-muted">
        {comparisonDigest.explanation} {comparisonDigest.timingNote}
      </p>

      <div className="grid grid-cols-4 gap-1.5">
        <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
          <div className="text-[10px] text-text-subtle">Pearson r</div>
          <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
            {comparison.pearsonR >= 0 ? "+" : ""}
            {comparison.pearsonR.toFixed(2)}
          </div>
        </div>
        <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
          <div className="text-[10px] text-text-subtle">Detrended r*</div>
          <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
            {comparison.detrendedR >= 0 ? "+" : ""}
            {comparison.detrendedR.toFixed(2)}
          </div>
        </div>
        <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
          <div className="text-[10px] text-text-subtle">Lag</div>
          <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
            {formatCompactLag(comparison.optimalLagSteps, comparison.lagUnit)}
          </div>
        </div>
        <div className="rounded-sm border border-border bg-surface-inset px-2 py-1.5">
          <div className="text-[10px] text-text-subtle">Shift</div>
          <div className="ws-numeric font-mono text-[12px] font-semibold text-text-primary">
            {comparison.sharedRegimeShiftYear ?? "—"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          {
            id: "a",
            label: labelA,
            summary: primary,
            live: current,
            dot: "bg-amber-400",
          },
          {
            id: "b",
            label: labelB,
            summary: secondary,
            live: secondaryCurrent,
            dot: "bg-sky-400",
          },
        ].map((side) => {
          const d = describeTrendPlainly(side.summary, tempUnit);
          const toneStyles = getTrendToneStyles(d);
          return (
            <div key={side.id} className="ws-inset space-y-0.5 rounded-md p-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-primary">
                <span className={`h-2 w-2 shrink-0 rounded-full ${side.dot}`} aria-hidden="true" />
                <span className="truncate">{side.label}</span>
              </div>
              {side.live?.temperatureC !== null && side.live?.temperatureC !== undefined && (
                <div className="ws-numeric flex items-center justify-between text-[11px] text-amber-300">
                  <span>Now</span>
                  <span className="font-mono font-semibold">
                    {formatTemperatureValue(side.live.temperatureC, tempUnit, 1)}
                  </span>
                </div>
              )}
              <div className={`text-[12px] font-semibold leading-snug ${toneStyles.headline}`}>
                {toneStyles.dirSymbol !== "—" ? `${toneStyles.dirSymbol} ` : ""}
                {d.headline}
              </div>
              <div className={`ws-numeric font-mono text-[11px] font-medium ${toneStyles.rate}`}>
                {d.ratePerDecade}
              </div>
            </div>
          );
        })}
      </div>

      {guidedCases && guidedCases.length > 0 && onSelectCaseStudy && (
        <div className="space-y-1 rounded-sm border border-border bg-surface-inset p-1.5">
          <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
            <span>Guided Case Studies</span>
            <span className="font-mono text-[9px] text-accent-fg">
              {guidedCases.length} NASA Cases
            </span>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Switch guided Earth case study">
            {guidedCases.map((c) => {
              const isActive = activeCaseStudyId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => onSelectCaseStudy(c.id)}
                  title={c.subtitle}
                  className={`rounded-xs border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                    isActive
                      ? "border-rose-400 bg-rose-950 text-rose-200 font-semibold"
                      : "border-border bg-surface text-text-muted hover:border-border-strong hover:text-text-primary"
                  }`}
                >
                  {c.title}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** De-boxed live current weather, air quality, UV, pressure, solar hairline grid and baseline comparison row. */
export function SpotCurrentConditionsSection({
  current,
  tempUnit,
  tempSummaryForNow,
  diagnostics,
  failureKind,
  error,
}: {
  current: CurrentEarthConditions | null;
  tempUnit: TemperatureUnit;
  tempSummaryForNow: TrendAnalysisSummary | null;
  diagnostics: TelemetryQueryDiagnostics | null;
  failureKind: TelemetryFailureKind | null;
  error: string | null;
}) {
  return (
    <section aria-label="Current conditions" className="space-y-2">
      {current ? (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2.5">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="ws-numeric text-2xl font-semibold tracking-tight text-text-primary">
                  {current.temperatureC !== null
                    ? formatTemperatureValue(current.temperatureC, tempUnit, 1)
                    : current.usAqi !== null
                      ? `AQI ${Math.round(current.usAqi)}`
                      : current.uvIndex !== null
                        ? `UV ${current.uvIndex.toFixed(1)}`
                        : current.pm25 !== null
                          ? `${current.pm25.toFixed(1)} μg/m³`
                          : current.shortwaveRadiationWm2 !== null
                            ? `${Math.round(current.shortwaveRadiationWm2)} W/m²`
                            : "—"}
                </span>
                <span className="text-[13px] font-medium text-text-secondary">
                  {current.weatherLabel}
                </span>
                {current.temperatureC === null && diagnostics?.current && (
                  <span
                    className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-subtle"
                    title={diagnostics.current.weatherReason}
                  >
                    {diagnostics.current.weatherStatus === "failed_to_fetch"
                      ? "Weather unavailable"
                      : "Weather N/A"}
                  </span>
                )}
              </div>
              <div className="ws-numeric mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-subtle">
                {current.apparentTemperatureC !== null && (
                  <span>
                    Feels {formatTemperatureValue(current.apparentTemperatureC, tempUnit, 1)}
                  </span>
                )}
                {current.todayMaxC !== null && current.todayMinC !== null && (
                  <span>
                    · H {formatTemperatureValue(current.todayMaxC, tempUnit, 0)} / L{" "}
                    {formatTemperatureValue(current.todayMinC, tempUnit, 0)}
                  </span>
                )}
              </div>
            </div>

            <div className="text-right text-[10px] text-text-subtle">
              <div className="ws-numeric font-mono">{formatObservedStamp(current.observedAt)}</div>
              <div>Live obs</div>
            </div>
          </div>

          {current.temperatureC !== null && tempSummaryForNow && (
            <div className="ws-numeric flex items-center justify-between gap-2 text-[11px]">
              <span className="text-text-muted">
                vs {tempSummaryForNow.points.length}y annual mean (
                {formatTemperatureValue(tempSummaryForNow.mean, tempUnit, 1)})
              </span>
              <span
                className={`font-mono font-semibold ${
                  current.temperatureC >= tempSummaryForNow.mean
                    ? "etg-tone-warm"
                    : "etg-tone-cool"
                }`}
              >
                {formatTemperatureDelta(
                  current.temperatureC - tempSummaryForNow.mean,
                  tempUnit,
                  1
                )}
              </span>
            </div>
          )}

          {/* Clean Borderless 3-Column Compact Telemetry Grid */}
          <div className="grid grid-cols-3 gap-x-2.5 gap-y-1.5 border-t border-border-subtle pt-2">
            {current.windSpeedKmh !== null && (
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                  <Wind className="h-3 w-3 shrink-0 text-sky-400" aria-hidden="true" />
                  <span className="truncate">Wind</span>
                </div>
                <div className="ws-numeric mt-0.5 truncate font-mono text-[11px] font-medium text-text-primary">
                  {Math.round(current.windSpeedKmh)} km/h
                  {current.windCardinal ? ` ${current.windCardinal}` : ""}
                  {current.windGustsKmh !== null &&
                    current.windGustsKmh > current.windSpeedKmh + 6 && (
                      <span className="font-normal text-text-subtle">
                        {" "}
                        (g{Math.round(current.windGustsKmh)})
                      </span>
                    )}
                </div>
              </div>
            )}

            {current.relativeHumidityPct !== null && (
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                  <Droplets className="h-3 w-3 shrink-0 text-cyan-400" aria-hidden="true" />
                  <span className="truncate">Humidity</span>
                </div>
                <div className="ws-numeric mt-0.5 truncate font-mono text-[11px] font-medium text-text-primary">
                  {Math.round(current.relativeHumidityPct)}%
                  {current.precipitationMm !== null
                    ? ` · ${current.precipitationMm.toFixed(1)}mm`
                    : ""}
                </div>
              </div>
            )}

            {current.usAqi !== null || current.pm25 !== null ? (
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                  <Activity className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden="true" />
                  <span className="truncate">Air Quality</span>
                </div>
                <div
                  className="ws-numeric mt-0.5 truncate font-mono text-[11px] font-medium text-text-primary"
                  title={`${current.usAqi !== null ? `AQI ${Math.round(current.usAqi)}` : "PM2.5"}${current.aqiCategory ? ` (${current.aqiCategory})` : ""}${current.pm25 !== null ? ` · ${current.pm25.toFixed(1)} μg/m³` : ""}`}
                >
                  {current.usAqi !== null ? `AQI ${Math.round(current.usAqi)}` : "PM2.5"}
                  {current.pm25 !== null ? ` · ${current.pm25.toFixed(1)}μg` : current.aqiCategory ? ` (${current.aqiCategory})` : ""}
                </div>
              </div>
            ) : (
              <div className="min-w-0" title={diagnostics?.current?.airQualityReason}>
                <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                  <Activity className="h-3 w-3 shrink-0 text-text-subtle" aria-hidden="true" />
                  <span className="truncate">Air Quality</span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-text-muted">N/A</div>
              </div>
            )}

            {current.uvIndex !== null && (
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                  <Sun className="h-3 w-3 shrink-0 text-amber-400" aria-hidden="true" />
                  <span className="truncate">UV</span>
                </div>
                <div className="ws-numeric mt-0.5 truncate font-mono text-[11px] font-medium text-text-primary">
                  {current.uvIndex.toFixed(1)}
                </div>
              </div>
            )}

            {current.surfacePressureHpa !== null && (
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                  <Gauge className="h-3 w-3 shrink-0 text-violet-400" aria-hidden="true" />
                  <span className="truncate">Pressure</span>
                </div>
                <div className="ws-numeric mt-0.5 truncate font-mono text-[11px] font-medium text-text-primary">
                  {Math.round(current.surfacePressureHpa)} hPa
                </div>
              </div>
            )}

            {(current.cloudCoverPct !== null || current.shortwaveRadiationWm2 !== null) && (
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                  <Cloud className="h-3 w-3 shrink-0 text-sky-400" aria-hidden="true" />
                  <span className="truncate">Solar / Cloud</span>
                </div>
                <div className="ws-numeric mt-0.5 truncate font-mono text-[11px] font-medium text-text-primary">
                  {current.cloudCoverPct !== null
                    ? `${Math.round(current.cloudCoverPct)}%`
                    : "—"}
                  {current.shortwaveRadiationWm2 !== null
                    ? ` · ${Math.round(current.shortwaveRadiationWm2)}W`
                    : ""}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        (() => {
          const currentFetchFailed =
            diagnostics?.current?.weatherStatus === "failed_to_fetch" ||
            diagnostics?.current?.airQualityStatus === "failed_to_fetch" ||
            failureKind === "failed_to_fetch" ||
            (Boolean(error) && failureKind !== "unavailable");
          const reasonText =
            diagnostics?.current?.weatherReason ||
            diagnostics?.current?.airQualityReason ||
            error ||
            null;
          return (
            <div className="rounded-md bg-surface-inset px-3 py-2 text-[11px] text-text-muted">
              <span className="font-medium text-text-primary">
                {currentFetchFailed
                  ? "Live weather unavailable right now"
                  : "Live weather unavailable at this coordinate"}
              </span>
              {reasonText ? ` — ${reasonText}` : "."}
            </div>
          );
        })()
      )}
    </section>
  );
}
