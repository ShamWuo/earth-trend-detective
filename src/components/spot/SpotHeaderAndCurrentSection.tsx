"use client";

import {
  Activity,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Cloud,
  Droplets,
  Gauge,
  MapPin,
  SlidersHorizontal,
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
  type SpotViewPrefs,
} from "@/components/spot/spotCardShared";

/** Structured spot header, unit/customize controls, `#etg-spot-customize-popover`, and section quick-toggle bar. */
export function SpotCardHeader({
  cardTitle,
  isComparingTwoSpots,
  isCompareHeader,
  coord,
  current,
  selectedNode,
  tempUnit,
  onChangeTempUnit,
  mobileCollapsed,
  onToggleMobileCollapse,
  prefs,
  onUpdatePref,
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
  mobileCollapsed: boolean;
  onToggleMobileCollapse?: () => void;
  prefs: SpotViewPrefs;
  onUpdatePref: <K extends keyof SpotViewPrefs>(key: K, value: SpotViewPrefs[K]) => void;
  visibleSummaryCount: number;
  linkedRelationCount: number;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 space-y-2 border-b border-border px-3.5 pt-3 pb-2 sm:px-4 sm:pt-3.5 sm:pb-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-snug text-text-primary">
            {cardTitle}
          </h2>
          {coord && !isComparingTwoSpots && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-subtle">
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
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <VariableGuidePopoverButton compact label="Guide" />
          {onChangeTempUnit && (
            <div
              className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5"
              role="group"
              aria-label="Temperature unit"
            >
              {(["C", "F"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={tempUnit === u}
                  onClick={() => onChangeTempUnit(u)}
                  className="rounded-xs px-1.5 py-0.5 text-[10px] font-semibold text-text-muted transition-colors hover:text-text-primary aria-pressed:bg-amber-950 aria-pressed:text-amber-300 cursor-pointer"
                >
                  °{u}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            popoverTarget="etg-spot-customize-popover"
            aria-label="Customize visible data and sections"
            title="Choose what stats, sections, and formats to display"
            className="inline-flex h-7 items-center gap-1 rounded-sm border border-border bg-surface-inset px-2 text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">View</span>
          </button>

          {onToggleMobileCollapse && (
            <button
              type="button"
              onClick={onToggleMobileCollapse}
              aria-expanded={!mobileCollapsed}
              aria-label={mobileCollapsed ? "Expand spot card" : "Collapse spot card"}
              title={mobileCollapsed ? "Expand spot card" : "Collapse spot card"}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-inset text-text-muted transition-colors hover:text-text-primary cursor-pointer sm:hidden"
            >
              {mobileCollapsed ? (
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close spot card"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Native Customize Spot View Popover */}
      <div
        id="etg-spot-customize-popover"
        popover="auto"
        className="etg-popover etg-popover-end w-72 space-y-3 p-3 text-xs"
      >
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          Choose What You See
        </div>

        <div className="space-y-0.5">
          <label className="etg-check-label">
            <input
              type="checkbox"
              className="checkbox-native"
              checked={prefs.showCurrent}
              onChange={(e) => onUpdatePref("showCurrent", e.target.checked)}
            />
            <span className="text-text-primary">Current weather &amp; air (Now)</span>
          </label>
          <label className="etg-check-label">
            <input
              type="checkbox"
              className="checkbox-native"
              checked={prefs.showTrends}
              onChange={(e) => onUpdatePref("showTrends", e.target.checked)}
            />
            <span className="text-text-primary">Multi-year Earth trends</span>
          </label>
          <label className="etg-check-label">
            <input
              type="checkbox"
              className="checkbox-native"
              checked={prefs.showRelations}
              onChange={(e) => onUpdatePref("showRelations", e.target.checked)}
            />
            <span className="text-text-primary">Relations &amp; connected places</span>
          </label>
          <label className="etg-check-label">
            <input
              type="checkbox"
              className="checkbox-native"
              checked={prefs.showChart}
              onChange={(e) => onUpdatePref("showChart", e.target.checked)}
            />
            <span className="text-text-primary">Time-series chart</span>
          </label>
          <label className="etg-check-label">
            <input
              type="checkbox"
              className="checkbox-native"
              checked={prefs.showScience}
              onChange={(e) => onUpdatePref("showScience", e.target.checked)}
            />
            <span className="text-text-primary">Stats, sources &amp; graph actions</span>
          </label>
        </div>

        <div className="border-t border-border pt-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Current Conditions Tiles
          </div>
          <div className="space-y-0.5">
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showWindHumidity}
                onChange={(e) => onUpdatePref("showWindHumidity", e.target.checked)}
              />
              <span className="text-text-primary">Wind, humidity &amp; precip</span>
            </label>
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showAirUv}
                onChange={(e) => onUpdatePref("showAirUv", e.target.checked)}
              />
              <span className="text-text-primary">Air quality (US AQI / PM2.5) &amp; UV</span>
            </label>
            <label className="etg-check-label">
              <input
                type="checkbox"
                className="checkbox-native"
                checked={prefs.showPressureSolar}
                onChange={(e) => onUpdatePref("showPressureSolar", e.target.checked)}
              />
              <span className="text-text-primary">Pressure, clouds &amp; solar flux</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
            Trends Layout
          </span>
          <div className="inline-flex rounded-sm border border-border bg-surface-inset p-0.5">
            {(["cards", "table"] as const).map((layout) => (
              <button
                key={layout}
                type="button"
                aria-pressed={prefs.trendLayout === layout}
                onClick={() => onUpdatePref("trendLayout", layout)}
                className="rounded-xs px-2 py-0.5 text-[11px] font-medium capitalize text-text-muted aria-pressed:bg-sky-950 aria-pressed:text-sky-200 cursor-pointer"
              >
                {layout}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Section Quick-Toggle Bar */}
      <div
        className={`flex flex-wrap items-center gap-1 ${mobileCollapsed ? "max-sm:hidden" : ""}`}
        role="group"
        aria-label="Toggle spot card sections"
      >
        {(isCompareHeader
          ? ([
              { key: "showChart", label: "Chart" },
              { key: "showScience", label: "Stats" },
            ] as const)
          : ([
              { key: "showCurrent", label: "Now" },
              {
                key: "showTrends",
                label:
                  visibleSummaryCount > 0 ? `Trends (${visibleSummaryCount})` : "Trends",
              },
              {
                key: "showRelations",
                label:
                  linkedRelationCount > 0 ? `Relations (${linkedRelationCount})` : "Relations",
              },
              { key: "showChart", label: "Chart" },
              { key: "showScience", label: "Stats" },
            ] as const)
        ).map((btn) => {
          const active = prefs[btn.key];
          return (
            <button
              key={btn.key}
              type="button"
              aria-pressed={active}
              onClick={() => onUpdatePref(btn.key, !active)}
              className={`rounded-sm border px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                active
                  ? "border-accent-fg bg-amber-950 text-amber-300"
                  : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
              }`}
            >
              {btn.label}
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
    <div className="space-y-2.5">
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
          return (
            <div key={side.id} className="ws-inset space-y-1 rounded-md p-2.5">
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
              <div className="text-[11px] font-medium text-text-secondary">
                {d.headline}
              </div>
              <div className="ws-numeric font-mono text-[11px] text-text-subtle">
                {d.ratePerDecade}
              </div>
            </div>
          );
        })}
      </div>

      {guidedCases && guidedCases.length > 0 && onSelectCaseStudy && (
        <div className="space-y-1.5 rounded-sm border border-border bg-surface-inset p-2">
          <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
            <span>Guided Opposite-Trend Case Studies</span>
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

/** Live current weather, air quality, UV, pressure, solar tiles and baseline comparison pill. */
export function SpotCurrentConditionsSection({
  current,
  tempUnit,
  tempSummaryForNow,
  prefs,
  diagnostics,
  failureKind,
  error,
}: {
  current: CurrentEarthConditions | null;
  tempUnit: TemperatureUnit;
  tempSummaryForNow: TrendAnalysisSummary | null;
  prefs: SpotViewPrefs;
  diagnostics: TelemetryQueryDiagnostics | null;
  failureKind: TelemetryFailureKind | null;
  error: string | null;
}) {
  return (
    <section aria-label="Current conditions" className="space-y-2">
      {current ? (
        <div className="rounded-md border border-border bg-surface-inset p-3 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="ws-numeric text-2xl font-bold tracking-tight text-text-primary">
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
                <span className="text-xs font-medium text-text-secondary">
                  {current.weatherLabel}
                </span>
                {current.temperatureC === null && diagnostics?.current && (
                  <span
                    className={`rounded-xs border px-1.5 py-0.5 text-[10px] font-medium ${
                      diagnostics.current.weatherStatus === "failed_to_fetch"
                        ? "border-rose-400 bg-rose-950 text-rose-200"
                        : "border-border-subtle bg-surface text-text-subtle"
                    }`}
                    title={diagnostics.current.weatherReason}
                  >
                    {diagnostics.current.weatherStatus === "failed_to_fetch"
                      ? "Weather: Failed to fetch"
                      : "Weather: Unavailable here"}
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
                    · Today H {formatTemperatureValue(current.todayMaxC, tempUnit, 0)} / L{" "}
                    {formatTemperatureValue(current.todayMinC, tempUnit, 0)}
                  </span>
                )}
              </div>
            </div>

            <div className="text-right text-[10px] text-text-subtle">
              <div className="ws-numeric font-mono">{formatObservedStamp(current.observedAt)}</div>
              <div className="truncate max-w-[100px]">Live obs</div>
            </div>
          </div>

          {current.temperatureC !== null && tempSummaryForNow && (
            <div className="ws-numeric flex items-center justify-between gap-2 rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5 text-[11px]">
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

          {(prefs.showWindHumidity || prefs.showAirUv || prefs.showPressureSolar) && (
            <div className="grid grid-cols-2 gap-1.5">
              {prefs.showWindHumidity && current.windSpeedKmh !== null && (
                <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                    <Wind className="h-3 w-3 text-sky-400" aria-hidden="true" />
                    <span>Wind</span>
                  </div>
                  <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                    {Math.round(current.windSpeedKmh)} km/h
                    {current.windCardinal ? ` ${current.windCardinal}` : ""}
                    {current.windGustsKmh !== null &&
                      current.windGustsKmh > current.windSpeedKmh + 6 && (
                        <span className="font-normal text-text-subtle">
                          {" "}
                          (gust {Math.round(current.windGustsKmh)})
                        </span>
                      )}
                  </div>
                </div>
              )}

              {prefs.showWindHumidity && current.relativeHumidityPct !== null && (
                <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                    <Droplets className="h-3 w-3 text-cyan-400" aria-hidden="true" />
                    <span>Humidity &amp; Precip</span>
                  </div>
                  <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                    {Math.round(current.relativeHumidityPct)}%
                    {current.precipitationMm !== null
                      ? ` · ${current.precipitationMm.toFixed(1)} mm`
                      : ""}
                  </div>
                </div>
              )}

              {prefs.showAirUv && (current.usAqi !== null || current.pm25 !== null) && (
                <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                    <Activity className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                    <span>Air Quality</span>
                  </div>
                  <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                    {current.usAqi !== null ? `AQI ${Math.round(current.usAqi)}` : "PM2.5"}
                    {current.aqiCategory ? ` (${current.aqiCategory})` : ""}
                    {current.pm25 !== null ? ` · ${current.pm25.toFixed(1)} μg/m³` : ""}
                  </div>
                </div>
              )}

              {prefs.showAirUv &&
                current.usAqi === null &&
                current.pm25 === null &&
                (() => {
                  const aqStatus = diagnostics?.current?.airQualityStatus;
                  const aqFailed = aqStatus === "failed_to_fetch";
                  return (
                    <div
                      className={`rounded-sm border px-2.5 py-1.5 ${
                        aqFailed
                          ? "border-rose-400 bg-rose-950"
                          : "border-border-subtle bg-surface"
                      }`}
                      title={diagnostics?.current?.airQualityReason}
                    >
                      <div
                        className={`flex items-center gap-1 text-[10px] ${
                          aqFailed ? "text-rose-300" : "text-text-subtle"
                        }`}
                      >
                        <Activity
                          className={`h-3 w-3 ${aqFailed ? "text-rose-400" : "text-text-subtle"}`}
                          aria-hidden="true"
                        />
                        <span>Air Quality</span>
                      </div>
                      <div
                        className={`mt-0.5 text-[11px] font-semibold ${
                          aqFailed ? "text-rose-200" : "text-text-muted"
                        }`}
                      >
                        {aqFailed ? "Failed to fetch" : "Unavailable here"}
                      </div>
                    </div>
                  );
                })()}

              {prefs.showAirUv && current.uvIndex !== null && (
                <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                    <Sun className="h-3 w-3 text-amber-400" aria-hidden="true" />
                    <span>UV Index</span>
                  </div>
                  <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                    {current.uvIndex.toFixed(1)}
                    {current.shortwaveRadiationWm2 !== null && !prefs.showPressureSolar
                      ? ` · ${Math.round(current.shortwaveRadiationWm2)} W/m²`
                      : ""}
                  </div>
                </div>
              )}

              {prefs.showPressureSolar && current.surfacePressureHpa !== null && (
                <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                    <Gauge className="h-3 w-3 text-violet-400" aria-hidden="true" />
                    <span>Surface Pressure</span>
                  </div>
                  <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                    {Math.round(current.surfacePressureHpa)} hPa
                  </div>
                </div>
              )}

              {prefs.showPressureSolar &&
                (current.cloudCoverPct !== null || current.shortwaveRadiationWm2 !== null) && (
                  <div className="rounded-sm border border-border-subtle bg-surface px-2.5 py-1.5">
                    <div className="flex items-center gap-1 text-[10px] text-text-subtle">
                      <Cloud className="h-3 w-3 text-slate-300" aria-hidden="true" />
                      <span>Clouds &amp; Solar</span>
                    </div>
                    <div className="ws-numeric mt-0.5 font-mono text-[11px] font-semibold text-text-primary">
                      {current.cloudCoverPct !== null
                        ? `${Math.round(current.cloudCoverPct)}% cloud`
                        : "—"}
                      {current.shortwaveRadiationWm2 !== null
                        ? ` · ${Math.round(current.shortwaveRadiationWm2)} W/m²`
                        : ""}
                    </div>
                  </div>
                )}
            </div>
          )}
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
          return currentFetchFailed ? (
            <div className="rounded-sm border border-rose-400 bg-rose-950 px-2.5 py-2 text-[11px] text-rose-200">
              <span className="font-semibold text-rose-100">
                Failed to fetch live weather &amp; air quality
              </span>
              {reasonText ? ` — ${reasonText}` : " for this coordinate right now."}
            </div>
          ) : (
            <div className="rounded-sm border border-border-subtle bg-surface-inset px-2.5 py-2 text-[11px] text-text-subtle">
              <span className="font-medium text-text-secondary">
                Live weather &amp; air quality unavailable at this coordinate
              </span>
              {reasonText ? ` (${reasonText}).` : " right now."}
            </div>
          );
        })()
      )}
    </section>
  );
}
