"use client";

import type React from "react";
import {
  CheckCircle2,
  GitBranch,
  GitCompare,
  PlusCircle,
  Radio,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { buildExternalExplorerLinks, DATASET_BY_ID } from "@/lib/datasets";
import {
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  isTemperatureUnitString,
} from "@/lib/earth/currentConditionsClient";
import {
  ALL_RELATION_CATEGORIES,
  RELATION_CATEGORY_META,
  describeTrendPlainly,
  formatRelationForDisplay,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type {
  CrossRegionComparison,
  CurrentEarthConditions,
  ETGEdge,
  ETGNode,
  GraphPredictionResult,
  RelationCategory,
  TemperatureUnit,
  TrendAnalysisSummary,
} from "@/types/etg";
import {
  relationCategoryStyles,
  resolveTemperatureSlopeScale,
} from "@/components/spot/spotCardShared";

/** Section 3: Connected ETG relations, category filters, nearby stations, and compare toggle. */
export function SpotRelationsSection({
  allNodesCount,
  allLinkedRelations,
  filteredLinkedRelations,
  relationCategoryCounts,
  localRelationFilter,
  onChangeLocalRelationFilter,
  anchorNode,
  nearbyMatching,
  compareMode,
  discoverBusy,
  onSelectNode,
  onSelectEdge,
  onCompareOpposite,
  onToggleCompareMode,
  onDiscoverGlobalTrends,
}: {
  allNodesCount: number;
  allLinkedRelations: Array<{
    edge: ETGEdge;
    peer: ETGNode;
    formatted: ReturnType<typeof formatRelationForDisplay>;
  }>;
  filteredLinkedRelations: Array<{
    edge: ETGEdge;
    peer: ETGNode;
    formatted: ReturnType<typeof formatRelationForDisplay>;
  }>;
  relationCategoryCounts: Record<RelationCategory, number>;
  localRelationFilter: "all" | RelationCategory;
  onChangeLocalRelationFilter: (filter: "all" | RelationCategory) => void;
  anchorNode: ETGNode | null;
  nearbyMatching: Array<{ node: ETGNode; distanceKm: number }>;
  compareMode: boolean;
  discoverBusy: boolean;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge?: (edge: ETGEdge) => void;
  onCompareOpposite: (nodeA: ETGNode, nodeB: ETGNode) => void;
  onToggleCompareMode: () => void;
  onDiscoverGlobalTrends?: () => void;
}) {
  return (
    <section
      aria-label="Relations and connected places"
      className="space-y-1.5 border-t border-border pt-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          Relations &amp; Connected Places
        </div>
        {anchorNode && (
          <span className="max-w-[165px] truncate text-[10px] text-text-subtle">
            via {humanizeNodeText(anchorNode.properties.name)}
          </span>
        )}
      </div>

      {allLinkedRelations.length > 0 && anchorNode ? (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              aria-pressed={localRelationFilter === "all"}
              onClick={() => onChangeLocalRelationFilter("all")}
              className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                localRelationFilter === "all"
                  ? "border-sky-400 bg-sky-950 text-sky-200"
                  : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
              }`}
            >
              All ({allLinkedRelations.length})
            </button>
            {ALL_RELATION_CATEGORIES.filter((c) => relationCategoryCounts[c] > 0).map((cat) => {
              const styles = relationCategoryStyles(cat);
              const active = localRelationFilter === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChangeLocalRelationFilter(cat)}
                  className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                    active
                      ? styles.badge
                      : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                  }`}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: styles.dot }}
                    aria-hidden="true"
                  />
                  <span>
                    {RELATION_CATEGORY_META[cat].shortLabel} ({relationCategoryCounts[cat]})
                  </span>
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            {filteredLinkedRelations.slice(0, 6).map(({ edge, peer, formatted }) => {
              const styles = relationCategoryStyles(formatted.category);
              const hasPeerCoords =
                typeof peer.properties.lat === "number" &&
                typeof peer.properties.lng === "number";
              const hasAnchorCoords =
                typeof anchorNode.properties.lat === "number" &&
                typeof anchorNode.properties.lng === "number";
              const arrow =
                formatted.direction === "outgoing"
                  ? "→"
                  : formatted.direction === "incoming"
                    ? "←"
                    : "↔";
              return (
                <div
                  key={edge.properties.uuid}
                  className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-xs border px-1.5 py-0.5 text-[10.5px] font-semibold ${styles.badge}`}
                        >
                          {formatted.badgeText}
                        </span>
                        <span className="ws-numeric text-xs font-medium leading-snug text-text-primary line-clamp-2">
                          {arrow} {formatted.peerName}
                        </span>
                      </div>
                      <div className="ws-numeric mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-text-subtle">
                        {formatted.peerRegion && <span>{formatted.peerRegion}</span>}
                        {formatted.correlationText && (
                          <span className="font-mono text-text-muted">
                            {formatted.correlationText}
                          </span>
                        )}
                        {formatted.lagText && (
                          <span className="font-mono text-text-muted">{formatted.lagText}</span>
                        )}
                        {formatted.liftText && (
                          <span className="font-mono text-emerald-300">{formatted.liftText}</span>
                        )}
                        {formatted.distanceKm !== null && (
                          <span className="font-mono">{formatted.distanceKm} km</span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {onSelectEdge && (
                        <button
                          type="button"
                          onClick={() => onSelectEdge(edge)}
                          className="rounded-sm border border-border bg-surface px-2 py-0.5 text-[10.5px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                        >
                          Focus
                        </button>
                      )}
                      {hasPeerCoords && hasAnchorCoords && (
                        <button
                          type="button"
                          onClick={() => onCompareOpposite(anchorNode, peer)}
                          className="rounded-sm border border-border bg-surface px-2 py-0.5 text-[10.5px] font-medium text-sky-300 hover:border-sky-400 cursor-pointer"
                        >
                          Compare
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="line-clamp-2 text-xs leading-relaxed text-text-muted">
                    {formatted.summaryLine}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      ) : allNodesCount === 0 && onDiscoverGlobalTrends ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-inset p-3 text-text-muted">
          <p>
            No global network nodes are loaded yet. Load live NASA, NOAA &amp; CSA observations
            to uncover opposite teleconnections and causal chains.
          </p>
          <button
            type="button"
            disabled={discoverBusy}
            onClick={onDiscoverGlobalTrends}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${discoverBusy ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>
              {discoverBusy ? "Loading Live Data…" : "Load Live Global Trends & Relations"}
            </span>
          </button>
        </div>
      ) : (
        <div className="rounded-sm border border-border-subtle bg-surface-inset px-2.5 py-2 text-[11px] text-text-subtle">
          No graph relations linked within 850 km yet. Select a nearby station or compare any two
          spots below.
        </div>
      )}

      {nearbyMatching.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-text-subtle">Nearby observations</div>
          {nearbyMatching.slice(0, 3).map(({ node, distanceKm }) => {
            const dsColor = node.properties.dataset
              ? DATASET_BY_ID[node.properties.dataset]?.color ?? "#e2a856"
              : "#e2a856";
            return (
              <button
                key={node.uuid}
                type="button"
                onClick={() => onSelectNode(node)}
                className="flex w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface-elevated cursor-pointer"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: dsColor }}
                    aria-hidden="true"
                  />
                  <span className="ws-numeric truncate font-medium text-text-primary">
                    {humanizeNodeText(node.properties.name)}
                  </span>
                </span>
                <span className="ws-numeric shrink-0 font-mono text-[11px] text-text-subtle">
                  {distanceKm} km
                </span>
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={onToggleCompareMode}
        className={`flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
          compareMode
            ? "border-cyan-400 bg-cyan-950 text-cyan-300"
            : "border-border-strong bg-surface-elevated text-text-primary hover:border-accent-fg"
        }`}
      >
        <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          {compareMode
            ? "Click another spot on Earth…"
            : "Compare with another Earth point"}
        </span>
      </button>
    </section>
  );
}

/** Section 5: Data provenance, graph commits/corroboration/sensor webhook, regional GNN forecast & MK stats. */
export function SpotScienceAndActionsSection({
  coord,
  selectedNode,
  activeSummary,
  activeDigest,
  comparison,
  current,
  isComparingTwoSpots,
  tempUnit,
  committing,
  supportingCount,
  beliefChain,
  actionMsg,
  showReviseForm,
  onToggleReviseForm,
  revName,
  revDesc,
  revRationale,
  onChangeRevName,
  onChangeRevDesc,
  onChangeRevRationale,
  onReviseBelief,
  onSaveToGraph,
  onVerifyGate,
  onSimulateWebhook,
  onSelectNode,
  spotPrediction,
  spotPredLoading,
  spotPredError,
  onRunRegionalForecast,
}: {
  coord: { lat: number; lng: number } | null;
  selectedNode: ETGNode | null;
  activeSummary: TrendAnalysisSummary | null;
  activeDigest: ReturnType<typeof describeTrendPlainly> | null;
  comparison: CrossRegionComparison | null;
  current: CurrentEarthConditions | null;
  isComparingTwoSpots: boolean;
  tempUnit: TemperatureUnit;
  committing: boolean;
  supportingCount: number;
  beliefChain: Array<{ node: ETGNode; rationale?: string }>;
  actionMsg: string | null;
  showReviseForm: boolean;
  onToggleReviseForm: () => void;
  revName: string;
  revDesc: string;
  revRationale: string;
  onChangeRevName: (v: string) => void;
  onChangeRevDesc: (v: string) => void;
  onChangeRevRationale: (v: string) => void;
  onReviseBelief: (e: React.FormEvent) => void;
  onSaveToGraph: () => void;
  onVerifyGate: () => void;
  onSimulateWebhook: () => void;
  onSelectNode: (node: ETGNode) => void;
  spotPrediction: GraphPredictionResult | null;
  spotPredLoading: boolean;
  spotPredError: string | null;
  onRunRegionalForecast: () => void;
}) {
  return (
    <div className="space-y-2.5 border-t border-border pt-2.5">
      {activeDigest && (
        <div className="ws-numeric grid grid-cols-2 gap-2 font-mono text-[11px]">
          <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
            <span className="block font-sans text-[10px] text-text-subtle">Window</span>
            <span className="text-text-primary">
              {activeDigest.periodRange} ({activeDigest.windowYears} pts)
            </span>
          </div>
          <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
            <span className="block font-sans text-[10px] text-text-subtle">Range</span>
            <span className="text-text-primary">{activeDigest.rangeFormatted}</span>
          </div>
          <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
            <span className="block font-sans text-[10px] text-text-subtle">Mean / Δ</span>
            <span className="text-text-primary">
              {activeDigest.meanFormatted} ({activeDigest.anomalyFormatted})
            </span>
          </div>
          <div className="rounded-sm border border-border bg-surface-inset px-2.5 py-1.5">
            <span className="block font-sans text-[10px] text-text-subtle">Anomaly Z</span>
            <span className="text-text-primary">{activeDigest.anomalyZFormatted ?? "—"}</span>
          </div>
        </div>
      )}

      {/* Data Provenance & Quick Links */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(activeSummary?.provenance || selectedNode?.properties.source_system) && (
          <span className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-subtle">
            {activeSummary?.provenance ?? selectedNode?.properties.source_system}
          </span>
        )}
        {current?.source && (
          <span className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-subtle">
            {current.source}
          </span>
        )}
        {typeof selectedNode?.properties.source_url === "string" && (
          <a
            href={selectedNode.properties.source_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-accent-fg hover:underline"
          >
            Source Data ↗
          </a>
        )}
        {coord && (
          <a
            href={
              buildExternalExplorerLinks(
                coord.lat,
                coord.lng,
                activeSummary?.dataset ?? selectedNode?.properties.dataset ?? "nasa_power"
              ).giovanniUrl
            }
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-sky-400 hover:underline"
          >
            NASA Giovanni ↗
          </a>
        )}
      </div>

      {/* Save to Graph / Verify / Sensor Ping */}
      <div className="flex flex-wrap gap-1.5">
        {(activeSummary || isComparingTwoSpots) && (
          <button
            type="button"
            disabled={committing}
            onClick={onSaveToGraph}
            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{committing ? "Saving…" : "Save to Graph"}</span>
          </button>
        )}

        {selectedNode && (
          <>
            <button
              type="button"
              disabled={committing}
              onClick={onVerifyGate}
              className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
            >
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              <span>Verify sources ({supportingCount})</span>
            </button>

            {selectedNode.properties.lat !== undefined && (
              <button
                type="button"
                disabled={committing}
                onClick={onSimulateWebhook}
                className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
              >
                <Radio className="h-3.5 w-3.5 text-purple-400" aria-hidden="true" />
                <span>Ping local sensor</span>
              </button>
            )}

            <button
              type="button"
              onClick={onToggleReviseForm}
              className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-amber-300 hover:border-amber-400 cursor-pointer"
            >
              <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{showReviseForm ? "Cancel update" : "Update finding"}</span>
            </button>
          </>
        )}
      </div>

      {showReviseForm && selectedNode && (
        <form onSubmit={onReviseBelief} className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2.5">
          <input
            type="text"
            required
            placeholder="Updated conclusion title"
            value={revName}
            onChange={(e) => onChangeRevName(e.target.value)}
            className="form-input"
          />
          <input
            type="text"
            required
            placeholder="Evidence summary"
            value={revDesc}
            onChange={(e) => onChangeRevDesc(e.target.value)}
            className="form-input"
          />
          <input
            type="text"
            required
            placeholder="Why was the earlier finding revised?"
            value={revRationale}
            onChange={(e) => onChangeRevRationale(e.target.value)}
            className="form-input"
          />
          <button
            type="submit"
            disabled={committing}
            className="w-full rounded-sm border border-amber-400 bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:border-amber-300 cursor-pointer"
          >
            Save revision
          </button>
        </form>
      )}

      {beliefChain.length > 1 && (
        <div className="space-y-1 rounded-md border border-border bg-surface-inset p-2">
          <div className="text-[11px] font-semibold text-amber-300">
            Revision history ({beliefChain.length})
          </div>
          {beliefChain.map((step, idx) => (
            <button
              key={step.node.uuid}
              type="button"
              onClick={() => onSelectNode(step.node)}
              className="block w-full truncate text-left text-[11px] text-text-muted hover:text-text-primary hover:underline cursor-pointer"
            >
              {idx === 0 ? "Current: " : "Prior: "}
              {humanizeNodeText(step.node.properties.name)}
            </button>
          ))}
        </div>
      )}

      {/* Regional Multi-Scale Graph Forecast */}
      {(coord || selectedNode) && (
        <div className="space-y-2 rounded-md border border-sky-400 bg-sky-950 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-sky-200">
                Regional Multi-Scale Graph Forecast
              </div>
              <div className="text-[11px] leading-snug text-text-muted">
                Uses global teleconnections, nearby sensors &amp; multi-scale ETG weights
              </div>
            </div>
            <button
              type="button"
              disabled={spotPredLoading}
              onClick={onRunRegionalForecast}
              className="inline-flex items-center gap-1.5 rounded-sm border border-sky-400 bg-sky-900 px-2.5 py-1 text-[11.5px] font-medium text-sky-100 hover:border-sky-300 cursor-pointer disabled:opacity-60"
            >
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
              {spotPredLoading ? "Predicting…" : "Predict Region Trajectory"}
            </button>
          </div>

          {spotPredError && <p className="text-[11px] text-rose-300">{spotPredError}</p>}

          {spotPrediction &&
            (() => {
              const predIsTemp = isTemperatureUnitString(spotPrediction.unit);
              const predUnit = predIsTemp
                ? convertTemperatureUnitLabel(spotPrediction.unit, tempUnit)
                : spotPrediction.unit;
              const fmtPred = (v: number) =>
                (predIsTemp
                  ? convertTemperatureDisplayValue(v, spotPrediction.unit, tempUnit)
                  : v
                ).toFixed(2);
              return (
                <div className="space-y-1.5 border-t border-sky-800 pt-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-1.5">
                    <span className="font-mono text-sm font-bold text-text-primary">
                      {fmtPred(spotPrediction.recommendedForecastValue)} {predUnit}
                      <span className="ml-1.5 text-[10px] font-normal text-text-muted">
                        ({spotPrediction.nextForecast.nextPeriodLabel})
                      </span>
                    </span>
                    <span className="font-mono text-[10px] text-emerald-300">
                      Lift {spotPrediction.skillLiftVsSelfPct >= 0 ? "+" : ""}
                      {spotPrediction.skillLiftVsSelfPct.toFixed(1)}%
                    </span>
                  </div>

                  {spotPrediction.quantiles && (
                    <div className="font-mono text-[10px] text-sky-200">
                      P10 {fmtPred(spotPrediction.quantiles.p10)} · P50{" "}
                      {fmtPred(spotPrediction.quantiles.p50)} · P90{" "}
                      {fmtPred(spotPrediction.quantiles.p90)} {predUnit}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5">
                    {spotPrediction.trendForecast && (
                      <span className="rounded-sm border border-sky-400 bg-sky-900 px-1.5 py-0.5 font-mono text-[9px] text-sky-100">
                        {spotPrediction.trendForecast.direction} · regime shift{" "}
                        {(spotPrediction.trendForecast.regimeShiftProb * 100).toFixed(0)}%
                      </span>
                    )}
                    {spotPrediction.scalesUsed?.map((sc) => (
                      <span
                        key={sc}
                        className="rounded-sm border border-border-strong bg-surface-inset px-1.5 py-0.5 font-mono text-[9px] text-text-muted"
                      >
                        {sc}
                      </span>
                    ))}
                    {spotPrediction.communityImpact &&
                      (spotPrediction.communityImpact.communityNodesActive > 0 ||
                        spotPrediction.communityImpact.trustGatedCount > 0) && (
                        <span className="rounded-sm border border-emerald-400 bg-emerald-950 px-1.5 py-0.5 font-mono text-[9px] text-emerald-200">
                          {spotPrediction.communityImpact.communityNodesActive} community active (
                          {spotPrediction.communityImpact.marginalCommunityLiftPct >= 0 ? "+" : ""}
                          {spotPrediction.communityImpact.marginalCommunityLiftPct.toFixed(1)}%)
                        </span>
                      )}
                  </div>
                </div>
              );
            })()}
        </div>
      )}

      {/* Collapsible Raw Statistical Engine Metrics */}
      {(activeSummary || selectedNode?.properties.p_value !== undefined || comparison) && (
        <details className="etg-details">
          <summary>Statistical test details (Mann-Kendall &amp; Theil-Sen)</summary>
          <div className="space-y-2 p-3 font-mono text-[11px] text-text-muted">
            {activeSummary &&
              (() => {
                const forceTemp = isTemperatureUnitString(activeSummary.unit);
                const { factor: slopeScale, unit: dispSlopeUnit } = resolveTemperatureSlopeScale(
                  activeSummary.slopeUnit,
                  tempUnit,
                  forceTemp
                );
                const dispSlope = activeSummary.theilSen.slope * slopeScale;
                const dispLow95 = activeSummary.theilSen.slopeLow95 * slopeScale;
                const dispHigh95 = activeSummary.theilSen.slopeHigh95 * slopeScale;
                const dispSeasonalSlope = activeSummary.seasonalAnalysis
                  ? activeSummary.seasonalAnalysis.seasonalTheilSenSlope * slopeScale
                  : null;
                return (
                  <>
                    <div className="flex justify-between gap-2">
                      <span>Mann-Kendall p-value</span>
                      <span className="ws-numeric text-text-primary">
                        {activeSummary.mannKendall.pValue < 0.0001
                          ? "< 0.0001"
                          : activeSummary.mannKendall.pValue.toFixed(4)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>Hamed-Rao p* / τ / Z</span>
                      <span className="ws-numeric text-text-primary">
                        {activeSummary.mannKendall.pValueAdjusted.toFixed(4)} · τ=
                        {activeSummary.mannKendall.tau.toFixed(2)} · Z=
                        {activeSummary.mannKendall.zScore.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>Theil-Sen slope (95% CI)</span>
                      <span className="ws-numeric text-text-primary">
                        {dispSlope >= 0 ? "+" : ""}
                        {dispSlope.toFixed(4)} {dispSlopeUnit} [{dispLow95.toFixed(3)},{" "}
                        {dispHigh95.toFixed(3)}]
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>OLS R² / Pettitt shift</span>
                      <span className="ws-numeric text-text-primary">
                        {activeSummary.ols.rSquared.toFixed(2)}
                        {activeSummary.changePoint?.significant
                          ? ` · Shift ${activeSummary.changePoint.date}`
                          : " · No shift break"}
                      </span>
                    </div>
                    {activeSummary.seasonalAnalysis && dispSeasonalSlope !== null && (
                      <div className="flex justify-between gap-2 border-t border-border pt-1.5">
                        <span>Seasonal MK (Hirsch-Slack)</span>
                        <span className="ws-numeric text-text-primary">
                          Seasonal p=
                          {activeSummary.seasonalAnalysis.pValue < 0.0001
                            ? "<0.0001"
                            : activeSummary.seasonalAnalysis.pValue.toFixed(4)}
                          {" · "}
                          {dispSeasonalSlope >= 0 ? "+" : ""}
                          {dispSeasonalSlope.toFixed(4)} {dispSlopeUnit} (
                          {activeSummary.seasonalAnalysis.seasonsDetected} seasons)
                        </span>
                      </div>
                    )}
                  </>
                );
              })()}
            {!activeSummary &&
              selectedNode?.properties.p_value !== undefined &&
              (() => {
                const rawSlope = selectedNode.properties.theil_sen_slope;
                const { factor, unit, isTempSlope } = resolveTemperatureSlopeScale(
                  selectedNode.properties.slope_unit ?? "",
                  tempUnit
                );
                const convSlope =
                  typeof rawSlope === "number" ? (rawSlope * factor).toFixed(4) : "—";
                const convUnit = isTempSlope ? ` ${unit}` : "";
                return (
                  <div className="flex justify-between gap-2">
                    <span>Mann-Kendall p / Theil-Sen</span>
                    <span className="ws-numeric text-text-primary">
                      p={selectedNode.properties.p_value.toFixed(4)} ·{" "}
                      {typeof rawSlope === "number" && rawSlope * factor >= 0 ? "+" : ""}
                      {convSlope}
                      {convUnit}
                    </span>
                  </div>
                );
              })()}
            {comparison && (
              <div className="flex justify-between gap-2 border-t border-border pt-2">
                <span>Pearson r / Detrended r*</span>
                <span className="ws-numeric text-text-primary">
                  r={comparison.pearsonR.toFixed(2)} · r*={comparison.detrendedR.toFixed(2)} (Δt=
                  {comparison.optimalLagSteps} {comparison.lagUnit})
                </span>
              </div>
            )}
          </div>
        </details>
      )}

      {actionMsg && (
        <div role="status" className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{actionMsg}</span>
        </div>
      )}
    </div>
  );
}
