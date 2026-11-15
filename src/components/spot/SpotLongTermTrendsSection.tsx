"use client";

import type React from "react";
import {
  Activity,
  GitBranch,
  LayoutGrid,
  List,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  isTemperatureUnitString,
} from "@/lib/earth/currentConditionsClient";
import { describeTrendPlainly, humanizeNodeText } from "@/lib/plainLanguage";
import type {
  DatasetTelemetryDiagnostic,
  ETGDatasetId,
  ETGNode,
  NodeTrendMicroscopeCue,
  TemperatureUnit,
  TrendAnalysisSummary,
  TrendMicroscopeRadarBadge,
  TrendMicroscopeScanResult,
} from "@/types/etg";
import {
  resolveTemperatureSlopeScale,
  summaryKey,
} from "@/components/spot/spotCardShared";
import { MiniSparkline } from "@/components/spot/SpotTrendChart";

/**
 * Multi-year Earth trends section supporting Cards & Table formats, active dataset filter notice,
 * fallback stored node readings, per-dataset status rows, and AI Trend Microscope cards.
 */
export function SpotLongTermTrendsSection({
  trendLayout,
  onChangeTrendLayout,
  activeTopics,
  onResetTopics,
  onlyCommunityFilterAtEmptySpot,
  visibleSummaries,
  activeSummary,
  activeDigest,
  onFocusSummary,
  tempUnit,
  hasStoredNodeMetrics,
  selectedNode,
  relevantDatasetDiags,
  loading,
  microscopeScan,
  microscopeByNode,
  onOpenInGraphWorkbench,
}: {
  trendLayout: "cards" | "table";
  onChangeTrendLayout: (layout: "cards" | "table") => void;
  activeTopics: ETGDatasetId[];
  onToggleTopic?: (ds: ETGDatasetId) => void;
  onResetTopics: () => void;
  onlyCommunityFilterAtEmptySpot: boolean;
  visibleSummaries: TrendAnalysisSummary[];
  activeSummary: TrendAnalysisSummary | null;
  activeDigest: ReturnType<typeof describeTrendPlainly> | null;
  onFocusSummary: (key: string, dataset: ETGDatasetId) => void;
  tempUnit: TemperatureUnit;
  hasStoredNodeMetrics: boolean;
  selectedNode: ETGNode | null;
  relevantDatasetDiags: DatasetTelemetryDiagnostic[];
  loading: boolean;
  microscopeScan: TrendMicroscopeScanResult | null;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  onOpenInGraphWorkbench?: (nodeUuid: string) => void;
}) {
  return (
    <section aria-label="Earth trends summary" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          Long-Term Trends
        </div>
        <div
          className="inline-flex rounded-md border border-border bg-surface-inset p-0.5"
          role="group"
          aria-label="Trend layout format"
        >
          <button
            type="button"
            aria-pressed={trendLayout === "cards"}
            onClick={() => onChangeTrendLayout("cards")}
            className="inline-flex items-center gap-1 rounded-xs px-2 py-0.5 text-[10px] font-medium text-text-muted aria-pressed:bg-surface-elevated aria-pressed:text-text-primary cursor-pointer"
          >
            <LayoutGrid className="h-3 w-3" aria-hidden="true" />
            <span>Cards</span>
          </button>
          <button
            type="button"
            aria-pressed={trendLayout === "table"}
            onClick={() => onChangeTrendLayout("table")}
            className="inline-flex items-center gap-1 rounded-xs px-2 py-0.5 text-[10px] font-medium text-text-muted aria-pressed:bg-surface-elevated aria-pressed:text-text-primary cursor-pointer"
          >
            <List className="h-3 w-3" aria-hidden="true" />
            <span>Table</span>
          </button>
        </div>
      </div>

      {/* Compact Active Filter Strip (replaces 3-row 8-chip wall) */}
      {activeTopics.length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-surface-inset px-2 py-1 text-[11px] text-text-muted">
          <span className="truncate">
            Filtered:{" "}
            {activeTopics
              .map((id) => DATASET_BY_ID[id]?.shortLabel ?? id)
              .join(", ")}
          </span>
          <button
            type="button"
            onClick={onResetTopics}
            className="shrink-0 font-medium text-accent-fg hover:underline cursor-pointer"
          >
            Show all
          </button>
        </div>
      )}

      {onlyCommunityFilterAtEmptySpot && (
        <div className="rounded-md bg-surface-inset p-3 text-text-muted">
          No local sensors recorded near this spot yet.{" "}
          <button
            type="button"
            onClick={onResetTopics}
            className="font-semibold text-accent-fg hover:underline cursor-pointer"
          >
            Show all datasets
          </button>
        </div>
      )}

      {/* Table Layout View */}
      {!onlyCommunityFilterAtEmptySpot &&
        trendLayout === "table" &&
        visibleSummaries.length > 0 && (
          <div
            className="etg-table-region rounded-md"
            tabIndex={0}
            role="region"
            aria-label="Earth trend metrics table"
            style={
              {
                "--col-2": '"Recent"',
                "--col-3": '"Δ Avg"',
                "--col-4": '"Rate/dec"',
              } as React.CSSProperties
            }
          >
            <table className="w-full table-fixed text-[11px]">
              <thead>
                <tr>
                  <th scope="col" className="w-[30%] px-1.5 py-1 text-left">Metric</th>
                  <th scope="col" className="w-[23%] px-1.5 py-1 text-right">Recent</th>
                  <th scope="col" className="w-[22%] px-1.5 py-1 text-right">Δ Avg</th>
                  <th scope="col" className="w-[25%] px-1.5 py-1 text-right">Rate/dec</th>
                </tr>
              </thead>
              <tbody>
                {visibleSummaries.map((item) => {
                  const d = describeTrendPlainly(item, tempUnit);
                  const meta = DATASET_BY_ID[item.dataset];
                  const key = summaryKey(item);
                  const isFocused = activeSummary ? summaryKey(activeSummary) === key : false;
                  const dirSymbol = d.isSignificant
                    ? d.tone === "rising"
                      ? "↑"
                      : "↓"
                    : "—";
                  return (
                    <tr
                      key={key}
                      onClick={() => onFocusSummary(key, item.dataset)}
                      className={`cursor-pointer transition-colors hover:bg-surface-band ${
                        isFocused ? "bg-surface-elevated" : ""
                      }`}
                    >
                      <th scope="row" className="px-1.5 py-1.5 text-left font-medium">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: meta?.color ?? "#e2a856" }}
                            aria-hidden="true"
                          />
                          <span className="truncate">{d.parameterShort}</span>
                        </div>
                      </th>
                      <td className="px-1.5 py-1.5 text-right font-mono tabular-nums text-text-primary whitespace-nowrap">
                        {d.latestFormatted}
                      </td>
                      <td
                        className="px-1.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap"
                        title={`Baseline average ${d.meanFormatted} (${d.rangeFormatted})`}
                      >
                        <span
                          className={
                            d.anomalyFormatted.startsWith("+")
                              ? "etg-tone-warm"
                              : d.anomalyFormatted.startsWith("-")
                                ? "etg-tone-cool"
                                : "text-text-subtle"
                          }
                        >
                          {d.anomalyFormatted}
                        </span>
                      </td>
                      <td className="px-1.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                        <span
                          className={
                            d.isSignificant
                              ? d.tone === "rising"
                                ? "etg-tone-rise"
                                : "etg-tone-cool"
                              : "text-text-subtle"
                          }
                        >
                          {dirSymbol} {d.ratePerDecade.replace(" / decade", "/dec")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      {/* Cards Layout View (Multi-Topic) */}
      {!onlyCommunityFilterAtEmptySpot &&
        trendLayout === "cards" &&
        visibleSummaries.length > 1 && (
          <div className="space-y-1.5">
            {visibleSummaries.map((item) => {
              const d = describeTrendPlainly(item, tempUnit);
              const meta = DATASET_BY_ID[item.dataset];
              const key = summaryKey(item);
              const isFocused = activeSummary ? summaryKey(activeSummary) === key : false;
              const dirSymbol = d.isSignificant ? (d.tone === "rising" ? "↑" : "↓") : "—";
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onFocusSummary(key, item.dataset)}
                  className={`w-full space-y-1 rounded-md border px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    isFocused
                      ? "border-accent-fg bg-surface-elevated"
                      : "border-border bg-surface-inset hover:border-border-strong"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: meta?.color ?? "#e2a856" }}
                          aria-hidden="true"
                        />
                        <span className="font-medium text-text-primary">{d.topicLabel}</span>
                        <span className="rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-subtle">
                          {d.parameterShort}
                        </span>
                        <span
                          className={`rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold ${
                            d.isSignificant
                              ? d.tone === "rising"
                                ? "border-rose-400 bg-rose-950 text-rose-300"
                                : "border-sky-400 bg-sky-950 text-sky-300"
                              : "border-border bg-surface-band text-text-subtle"
                          }`}
                        >
                          {dirSymbol} {d.certaintyLabel}
                        </span>
                        {d.isProxy && (
                          <span className="rounded-sm border border-amber-400 bg-amber-950 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                            Proxy
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-semibold text-text-primary">{d.headline}</div>
                    </div>

                    <MiniSparkline points={item.points} color={meta?.color ?? "#e2a856"} />
                  </div>

                  <div className="ws-numeric grid grid-cols-3 gap-1.5 border-t border-border-subtle pt-1 font-mono text-[10px]">
                    <div>
                      <span className="block text-[9px] font-sans uppercase text-text-subtle">
                        Recent
                      </span>
                      <span className="font-semibold text-text-primary">
                        {d.latestFormatted}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] font-sans uppercase text-text-subtle">
                        Avg (Δ)
                      </span>
                      <span className="text-text-muted">
                        {d.meanFormatted.split(" ")[0]}{" "}
                        <span
                          className={
                            d.anomalyFormatted.startsWith("+")
                              ? "text-amber-300"
                              : d.anomalyFormatted.startsWith("-")
                                ? "text-sky-300"
                                : ""
                          }
                        >
                          ({d.anomalyFormatted})
                        </span>
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="block text-[9px] font-sans uppercase text-text-subtle">
                        Rate/dec
                      </span>
                      <span className="font-medium text-text-secondary">
                        {d.ratePerDecade.replace(" / decade", "/dec")}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}

            {activeDigest && (
              <div className="space-y-1.5 px-0.5 pt-0.5 text-[11px] leading-relaxed text-text-muted">
                <p>
                  <strong className="font-semibold text-text-primary">
                    {activeDigest.topicLabel} ({activeDigest.periodRange}):
                  </strong>{" "}
                  {activeDigest.summarySentence}
                </p>
                {activeDigest.isProxy && activeDigest.proxyNote && (
                  <p className="rounded-sm border border-amber-400 bg-surface-elevated px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300">
                    {activeDigest.proxyNote}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

      {/* Single-Topic Highlight Card */}
      {!onlyCommunityFilterAtEmptySpot &&
        trendLayout === "cards" &&
        visibleSummaries.length <= 1 &&
        activeDigest &&
        activeSummary && (
          <div
            className={`space-y-2.5 rounded-md border p-3 ${
              activeDigest.isSignificant
                ? activeDigest.tone === "rising"
                  ? "border-rose-400 bg-rose-950"
                  : "border-sky-400 bg-sky-950"
                : "border-border bg-surface-inset"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {activeDigest.isSignificant ? (
                    activeDigest.tone === "rising" ? (
                      <TrendingUp className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                    ) : (
                      <TrendingDown className="h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
                    )
                  ) : (
                    <Activity className="h-4 w-4 shrink-0 text-text-subtle" aria-hidden="true" />
                  )}
                  <span className="text-[13px] font-semibold text-text-primary">
                    {activeDigest.headline}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-subtle">
                    {activeDigest.parameterShort}
                  </span>
                  <span className="ws-numeric font-mono font-medium text-text-secondary">
                    {activeDigest.ratePerDecade}
                  </span>
                  <span
                    className={`rounded-sm border px-2 py-0.5 text-[10px] font-semibold ${
                      activeDigest.isSignificant
                        ? "border-border-strong bg-surface-elevated text-text-primary"
                        : "border-border bg-surface-band text-text-subtle"
                    }`}
                  >
                    {activeDigest.isSignificant
                      ? activeDigest.tone === "rising"
                        ? "↑ "
                        : "↓ "
                      : "— "}
                    {activeDigest.certaintyLabel}
                  </span>
                  {activeDigest.isProxy && (
                    <span className="rounded-sm border border-amber-400 bg-amber-950 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                      Proxy
                    </span>
                  )}
                </div>
              </div>

              <MiniSparkline
                points={activeSummary.points}
                color={DATASET_BY_ID[activeSummary.dataset]?.color ?? "#e2a856"}
                width={68}
                height={24}
              />
            </div>

            <div className="ws-numeric grid grid-cols-2 gap-1.5 font-mono text-[11px]">
              <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                <span className="block font-sans text-[10px] text-text-subtle">Recent</span>
                <span className="font-semibold text-text-primary">
                  {activeDigest.latestFormatted}
                </span>
              </div>
              <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                <span className="block font-sans text-[10px] text-text-subtle">
                  {activeDigest.windowYears}y Avg (Δ)
                </span>
                <span className="text-text-primary">
                  {activeDigest.meanFormatted} ({activeDigest.anomalyFormatted})
                </span>
              </div>
            </div>

            <p className="leading-relaxed text-text-muted">{activeDigest.summarySentence}</p>
            {activeDigest.isProxy && activeDigest.proxyNote && (
              <p className="rounded-sm border border-amber-400 bg-surface-elevated px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300">
                {activeDigest.proxyNote}
              </p>
            )}
          </div>
        )}

      {/* Fallback Stored Node Reading when remote time-series are missing */}
      {!onlyCommunityFilterAtEmptySpot &&
        visibleSummaries.length === 0 &&
        hasStoredNodeMetrics &&
        selectedNode && (
          <div className="space-y-2 rounded-md border border-border bg-surface-inset p-3">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="rounded-xs border border-amber-400 bg-amber-950 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                Stored Node Reading
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-subtle">
                {selectedNode.properties.dataset && (
                  <span className="rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-text-secondary">
                    {DATASET_BY_ID[selectedNode.properties.dataset]?.shortLabel ??
                      selectedNode.properties.dataset}
                  </span>
                )}
                {selectedNode.properties.region && (
                  <span>{selectedNode.properties.region}</span>
                )}
              </div>
            </div>

            <div className="ws-numeric grid grid-cols-2 gap-1.5 font-mono text-[11px]">
              {selectedNode.properties.value !== undefined &&
                (() => {
                  const rawUnit = selectedNode.properties.unit ?? "";
                  const convVal = isTemperatureUnitString(rawUnit)
                    ? convertTemperatureDisplayValue(
                        selectedNode.properties.value,
                        rawUnit,
                        tempUnit
                      )
                    : selectedNode.properties.value;
                  const convUnit = isTemperatureUnitString(rawUnit)
                    ? convertTemperatureUnitLabel(rawUnit, tempUnit)
                    : rawUnit;
                  return (
                    <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                      <span className="block font-sans text-[10px] text-text-subtle">
                        Latest Value
                      </span>
                      <span className="font-semibold text-text-primary">
                        {convVal.toFixed(2)}
                        {convUnit ? ` ${convUnit}` : ""}
                      </span>
                    </div>
                  );
                })()}
              {selectedNode.properties.theil_sen_slope !== undefined &&
                (() => {
                  const { factor, unit } = resolveTemperatureSlopeScale(
                    selectedNode.properties.slope_unit ?? "/ yr",
                    tempUnit
                  );
                  const convSlope = selectedNode.properties.theil_sen_slope * factor;
                  return (
                    <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                      <span className="block font-sans text-[10px] text-text-subtle">
                        Theil-Sen Slope
                      </span>
                      <span className="font-semibold text-text-primary">
                        {convSlope >= 0 ? "+" : ""}
                        {convSlope.toFixed(3)} {unit}
                      </span>
                    </div>
                  );
                })()}
              {selectedNode.properties.p_value !== undefined && (
                <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                  <span className="block font-sans text-[10px] text-text-subtle">
                    Mann-Kendall p
                  </span>
                  <span className="text-text-primary">
                    {selectedNode.properties.p_value < 0.0001
                      ? "< 0.0001"
                      : selectedNode.properties.p_value.toFixed(4)}
                  </span>
                </div>
              )}
              {selectedNode.properties.confidence !== undefined && (
                <div className="rounded-sm border border-border-subtle bg-surface px-2 py-1">
                  <span className="block font-sans text-[10px] text-text-subtle">
                    Confidence
                  </span>
                  <span className="text-text-primary">
                    {Math.round(selectedNode.properties.confidence * 100)}%
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

      {/* Per-Dataset Status Rows (calm muted appearance for partial availability) */}
      {!onlyCommunityFilterAtEmptySpot && relevantDatasetDiags.length > 0 && (
        <div className="space-y-1">
          {relevantDatasetDiags.map((diag) => {
            const dsMeta = DATASET_BY_ID[diag.dataset];
            const isFetchFailed = diag.status === "failed_to_fetch";
            return (
              <div
                key={`${diag.dataset}-${diag.status}`}
                className="flex items-center justify-between gap-2 rounded-md bg-surface-inset px-2.5 py-1.5 text-[11px] text-text-muted"
                title={diag.reason}
              >
                <div className="flex min-w-0 items-center gap-1.5 truncate">
                  {isFetchFailed && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                  )}
                  <span className="font-medium text-text-primary">
                    {dsMeta?.shortLabel ?? diag.dataset}
                  </span>
                  <span className="truncate text-text-subtle">{diag.reason}</span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-text-subtle">
                  {isFetchFailed ? "Unavailable" : "N/A"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {!onlyCommunityFilterAtEmptySpot &&
        !loading &&
        visibleSummaries.length === 0 &&
        !hasStoredNodeMetrics &&
        relevantDatasetDiags.length === 0 && (
          <div className="rounded-sm border border-border-subtle bg-surface-inset px-2.5 py-2 text-[11px] text-text-subtle">
            No multi-year trend telemetry available for the active dataset filter at this coordinate.
          </div>
        )}

      {/* Node verification, AI Trend Microscope breakdown, and Graph Workbench handoff */}
      {selectedNode && (() => {
        const cue = microscopeByNode?.[selectedNode.uuid];
        const badgeMeta: Record<
          TrendMicroscopeRadarBadge,
          { label: string; cls: string }
        > = {
          EARLY_ONSET: {
            label: "Early Onset",
            cls: "border-amber-400 bg-amber-950 text-amber-200",
          },
          SECULAR_ACCELERATION: {
            label: "Secular Accel",
            cls: "border-emerald-400 bg-emerald-950 text-emerald-200",
          },
          FALSE_TREND_CYCLE: {
            label: "Cycle Alias",
            cls: "border-violet-400 bg-purple-950 text-violet-200",
          },
          SENSOR_GLITCH_RISK: {
            label: "Sensor Glitch Risk",
            cls: "border-rose-400 bg-rose-950 text-rose-200",
          },
          CONTESTED: {
            label: "Contested",
            cls: "border-orange-400 bg-orange-950 text-orange-200",
          },
          NOMINAL: {
            label: "Nominal",
            cls: "border-border bg-surface text-text-muted",
          },
        };
        const topCoupling = microscopeScan?.verifiedCouplings.find(
          (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
        );
        const topIllusion = microscopeScan?.suppressedIllusions.find(
          (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
        );
        const secPct = cue ? Math.round(cue.dealiasing.secularShare * 100) : 0;
        const cycPct = cue ? Math.round(cue.dealiasing.oscillationShare * 100) : 0;
        const artPct = cue ? Math.max(0, 100 - secPct - cycPct) : 0;

        return (
          <div className="space-y-2 px-0.5 pt-0.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
              <span
                className={`rounded-sm border px-2 py-0.5 font-medium ${
                  selectedNode.properties.status === "Superseded"
                    ? "border-amber-400 bg-amber-950 text-amber-300"
                    : selectedNode.is_provisional
                      ? "border-amber-400 bg-amber-950 text-amber-300"
                      : "border-emerald-400 bg-emerald-950 text-emerald-300"
                }`}
              >
                {selectedNode.properties.status === "Superseded"
                  ? "Updated earlier finding"
                  : selectedNode.is_provisional
                    ? "Single-source reading"
                    : "Verified across sources"}
              </span>
              {onOpenInGraphWorkbench && (
                <button
                  type="button"
                  onClick={() => onOpenInGraphWorkbench(selectedNode.uuid)}
                  className="inline-flex items-center gap-1 rounded-sm border border-accent-fg bg-amber-950 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 hover:border-amber-300 cursor-pointer"
                >
                  <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Open in Graph &amp; Predict</span>
                </button>
              )}
            </div>

            {cue && (
              <div className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2.5 text-[11px]">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="inline-flex items-center gap-1 font-semibold text-text-primary">
                    <Activity className="h-3 w-3 text-sky-400" aria-hidden="true" />
                    <span>AI Trend Microscope</span>
                  </span>
                  <div className="flex items-center gap-1">
                    {cue.preMannKendallAlert && (
                      <span className="rounded-xs border border-amber-400 bg-amber-950 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-200">
                        PRE-MK
                      </span>
                    )}
                    <span
                      className={`rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${badgeMeta[cue.radarBadge].cls}`}
                    >
                      {badgeMeta[cue.radarBadge].label}
                    </span>
                  </div>
                </div>

                <div className="ws-numeric flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-text-muted">
                  <span>Onset {Math.round(cue.onsetProb * 100)}%</span>
                  {cue.leadStepsAhead > 0 && (
                    <span>Lead ~{cue.leadStepsAhead.toFixed(1)} steps</span>
                  )}
                  <span>Trust Gate {Math.round(cue.trustGate * 100)}%</span>
                </div>

                <div className="space-y-1">
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface">
                    <div
                      className="bg-emerald-400"
                      style={{ width: `${secPct}%` }}
                      title={`Secular ${secPct}%`}
                    />
                    <div
                      className="bg-violet-400"
                      style={{ width: `${cycPct}%` }}
                      title={`Cycle ${cycPct}%`}
                    />
                    <div
                      className="bg-rose-400"
                      style={{ width: `${artPct}%` }}
                      title={`Noise/Drift ${artPct}%`}
                    />
                  </div>
                  <div className="ws-numeric flex items-center justify-between font-mono text-[9px] text-text-subtle">
                    <span>Secular {secPct}%</span>
                    <span>Cycle {cycPct}%</span>
                    <span>Noise/Drift {artPct}%</span>
                  </div>
                </div>

                {topCoupling && (
                  <div className="rounded-xs border border-emerald-400/50 bg-emerald-950/60 px-2 py-1 text-[10px] text-emerald-200">
                    {topCoupling.sourceName} → {topCoupling.targetName}:{" "}
                    {topCoupling.polarity} (lag={topCoupling.optimalLagSteps}, P=
                    {Math.round(topCoupling.trueCouplingProb * 100)}%)
                  </div>
                )}

                {topIllusion && (
                  <div className="rounded-xs border border-amber-400/50 bg-amber-950/60 px-2 py-1 text-[10px] text-amber-200">
                    Confounder Alert: {topIllusion.sourceName} ↔ {topIllusion.targetName}{" "}
                    (raw r={topIllusion.rawPeakR.toFixed(2)}, illusion{" "}
                    {Math.round(topIllusion.confounderProb * 100)}%)
                  </div>
                )}
              </div>
            )}

            {!activeDigest && (
              <p className="leading-relaxed text-text-muted">
                {humanizeNodeText(selectedNode.properties.description)}
              </p>
            )}
          </div>
        );
      })()}
    </section>
  );
}
