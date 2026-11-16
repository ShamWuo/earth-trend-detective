"use client";

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, BookOpenText, GitBranch, GitCompare, PlusCircle } from "lucide-react";
import { DATASET_BY_ID } from "@/lib/datasets";
import { isTemperatureUnitString } from "@/lib/earth/currentConditionsClient";
import {
  classifyRelationCategory,
  describeComparisonPlainly,
  describeGeographicZone,
  describeTrendPlainly,
  findNearbyFilteredNodes,
  formatCoordShort,
  formatRelationForDisplay,
  humanizeNodeText,
} from "@/lib/plainLanguage";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  GraphPredictionResult,
  RelationCategory,
} from "@/types/etg";
import {
  type CompactSpotCardProps,
  DEFAULT_SPOT_VIEW_PREFS,
  SPOT_VIEW_PREFS_KEY,
  type SpotInspectorTab,
  type SpotViewPrefs,
  summaryKey,
} from "@/components/spot/spotCardShared";
import {
  SpotCardHeader,
  SpotComparisonModeSection,
  SpotCurrentConditionsSection,
} from "@/components/spot/SpotHeaderAndCurrentSection";
import { SpotLongTermTrendsSection } from "@/components/spot/SpotLongTermTrendsSection";
import {
  SpotRelationsSection,
  SpotScienceAndActionsSection,
} from "@/components/spot/SpotRelationsAndScienceSection";
import { SpotTrendChart } from "@/components/spot/SpotTrendChart";

export type { GuidedCaseStudyItem } from "@/components/spot/spotCardShared";

/**
 * Compact Spot Card displaying live Earth conditions, multi-year statistical trends,
 * AI Trend Microscope decomposition, connected ETG relations, comparison mode, and regional GNN forecasts.
 */
export function CompactSpotCard({
  selectedNode,
  selectedEdge,
  sourceNode,
  targetNode,
  allNodes,
  allEdges,
  visibleNodes,
  microscopeScan = null,
  microscopeByNode,
  probedCoord,
  primary,
  secondary,
  summaries,
  focusedSummaryDataset,
  comparison,
  current = null,
  secondaryCurrent = null,
  tempUnit = "C",
  onChangeTempUnit,
  mobileCollapsed = false,
  onToggleMobileCollapse,
  enabledRelationCategories,
  compareMode,
  comparePending = false,
  activeTopics,
  loading,
  error,
  diagnostics = null,
  failureKind = null,
  onRetry,
  discoverBusy = false,
  guidedCases,
  activeCaseStudyId = null,
  onSelectCaseStudy,
  onToggleTopic,
  onResetTopics,
  onFocusSummaryDataset,
  onSelectNode,
  onSelectEdge,
  onCompareOpposite,
  onToggleCompareMode,
  onSwapPins,
  onClearComparison,
  onDiscoverGlobalTrends,
  onCommitToGraph,
  onCommitRelation,
  onOpenInGraphWorkbench,
  onOpenBriefing,
  onSatelliteZoomSpot,
  onOpenSolarForSpot,
  onGraphUpdated,
  onClose,
}: CompactSpotCardProps) {
  const [prefs, setPrefs] = useState<SpotViewPrefs>(DEFAULT_SPOT_VIEW_PREFS);
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<SpotInspectorTab>("overview");
  const [localRelationFilter, setLocalRelationFilter] = useState<"all" | RelationCategory>("all");
  const [committing, setCommitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const [showReviseForm, setShowReviseForm] = useState(false);
  const [revName, setRevName] = useState("");
  const [revDesc, setRevDesc] = useState("");
  const [revRationale, setRevRationale] = useState("");
  const [focusedSummaryKey, setFocusedSummaryKey] = useState<string | null>(null);

  const [spotPrediction, setSpotPrediction] = useState<GraphPredictionResult | null>(null);
  const [spotPredLoading, setSpotPredLoading] = useState(false);
  const [spotPredError, setSpotPredError] = useState<string | null>(null);
  const forecastAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      forecastAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SPOT_VIEW_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SpotViewPrefs>;
        setPrefs((prev) => ({
          showCurrent:
            typeof parsed.showCurrent === "boolean" ? parsed.showCurrent : prev.showCurrent,
          showTrends:
            typeof parsed.showTrends === "boolean" ? parsed.showTrends : prev.showTrends,
          showRelations:
            typeof parsed.showRelations === "boolean" ? parsed.showRelations : prev.showRelations,
          showChart:
            typeof parsed.showChart === "boolean" ? parsed.showChart : prev.showChart,
          showScience:
            typeof parsed.showScience === "boolean" ? parsed.showScience : prev.showScience,
          trendLayout:
            parsed.trendLayout === "table" || parsed.trendLayout === "cards"
              ? parsed.trendLayout
              : prev.trendLayout,
          showWindHumidity:
            typeof parsed.showWindHumidity === "boolean"
              ? parsed.showWindHumidity
              : prev.showWindHumidity,
          showAirUv:
            typeof parsed.showAirUv === "boolean" ? parsed.showAirUv : prev.showAirUv,
          showPressureSolar:
            typeof parsed.showPressureSolar === "boolean"
              ? parsed.showPressureSolar
              : prev.showPressureSolar,
        }));
      }
    } catch {
      // Ignore storage errors
    } finally {
      setPrefsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      window.localStorage.setItem(SPOT_VIEW_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage errors
    }
  }, [prefsHydrated, prefs]);

  const updatePref = <K extends keyof SpotViewPrefs>(key: K, value: SpotViewPrefs[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  const selectionKey =
    selectedEdge?.properties.uuid ??
    selectedNode?.uuid ??
    (probedCoord ? `${probedCoord.lat.toFixed(2)}:${probedCoord.lng.toFixed(2)}` : "empty");

  useEffect(() => {
    forecastAbortRef.current?.abort();
    forecastAbortRef.current = null;
    setActionMsg(null);
    setShowReviseForm(false);
    setSpotPrediction(null);
    setSpotPredError(null);
    setSpotPredLoading(false);
    setFocusedSummaryKey(null);
  }, [selectionKey]);

  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.uuid, n])), [allNodes]);

  const coord = useMemo(() => {
    if (probedCoord) return probedCoord;
    if (
      selectedNode &&
      typeof selectedNode.properties.lat === "number" &&
      typeof selectedNode.properties.lng === "number"
    ) {
      return { lat: selectedNode.properties.lat, lng: selectedNode.properties.lng };
    }
    if (primary) return { lat: primary.lat, lng: primary.lng };
    return null;
  }, [probedCoord, selectedNode, primary]);

  const nearbyMatching = useMemo(() => {
    if (!coord) return [];
    const candidates = visibleNodes.filter((n) => n.uuid !== selectedNode?.uuid);
    return findNearbyFilteredNodes(coord.lat, coord.lng, candidates, 1200, 5);
  }, [coord, visibleNodes, selectedNode]);

  const visibleSummaries = useMemo(() => {
    if (activeTopics.length === 0) return summaries;
    return summaries.filter((s) => activeTopics.includes(s.dataset));
  }, [summaries, activeTopics]);

  const activeSummary = useMemo(() => {
    if (comparison && primary) return primary;
    if (focusedSummaryKey) {
      const hit = visibleSummaries.find((s) => summaryKey(s) === focusedSummaryKey);
      if (hit) return hit;
    }
    if (focusedSummaryDataset) {
      const hit = visibleSummaries.find((s) => s.dataset === focusedSummaryDataset);
      if (hit) return hit;
    }
    if (selectedNode && primary) return primary;
    if (visibleSummaries.length === 0) {
      return activeTopics.length === 1 && activeTopics[0] === "community" ? null : primary;
    }
    return visibleSummaries[0];
  }, [
    selectedNode,
    primary,
    comparison,
    visibleSummaries,
    activeTopics,
    focusedSummaryKey,
    focusedSummaryDataset,
  ]);

  const activeDatasetId: ETGDatasetId =
    activeSummary?.dataset ?? selectedNode?.properties.dataset ?? activeTopics[0] ?? "nasa_power";

  const handleRunRegionalForecast = async () => {
    forecastAbortRef.current?.abort();
    const controller = new AbortController();
    forecastAbortRef.current = controller;
    setSpotPredLoading(true);
    setSpotPredError(null);
    try {
      const qs = new URLSearchParams();
      if (selectedNode && !probedCoord) {
        qs.set("targetUuid", selectedNode.uuid);
      } else if (coord) {
        qs.set("lat", String(coord.lat));
        qs.set("lng", String(coord.lng));
        qs.set("dataset", activeDatasetId);
        if (selectedNode) qs.set("targetUuid", selectedNode.uuid);
      } else if (selectedNode) {
        qs.set("targetUuid", selectedNode.uuid);
      } else {
        throw new Error("Select a pin or click a coordinate on Earth to run a regional forecast.");
      }
      const res = await fetch(`/api/graph/predict?${qs.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = (await res.json()) as GraphPredictionResult & { error?: string };
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || "Regional forecast failed");
      setSpotPrediction(data);
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setSpotPredError(err instanceof Error ? err.message : "Regional forecast failed");
    } finally {
      if (!controller.signal.aborted) {
        setSpotPredLoading(false);
      }
    }
  };

  const anchorNode = useMemo(() => {
    if (selectedNode) return selectedNode;
    if (nearbyMatching[0] && nearbyMatching[0].distanceKm <= 850) {
      return nearbyMatching[0].node;
    }
    return null;
  }, [selectedNode, nearbyMatching]);

  const allLinkedRelations = useMemo(() => {
    if (!anchorNode) return [];
    const categoryPriority: Record<RelationCategory, number> = {
      opposite: 4,
      causal: 3,
      coupled: 2,
      corroboration: 1,
    };
    const allowedCats = enabledRelationCategories ? new Set(enabledRelationCategories) : null;
    const seenEdgeIds = new Set<string>();
    const items: Array<{
      edge: ETGEdge;
      peer: ETGNode;
      formatted: ReturnType<typeof formatRelationForDisplay>;
    }> = [];

    for (const edge of allEdges) {
      if (seenEdgeIds.has(edge.properties.uuid)) continue;
      if (edge.source_uuid !== anchorNode.uuid && edge.target_uuid !== anchorNode.uuid) {
        continue;
      }
      const category = classifyRelationCategory(edge.type);
      if (allowedCats && !allowedCats.has(category)) continue;

      const peerId = edge.source_uuid === anchorNode.uuid ? edge.target_uuid : edge.source_uuid;
      const peer = nodeMap.get(peerId);
      if (!peer) continue;

      seenEdgeIds.add(edge.properties.uuid);
      items.push({
        edge,
        peer,
        formatted: formatRelationForDisplay(edge, anchorNode, peer),
      });
    }

    return items.sort((a, b) => {
      const catDiff =
        categoryPriority[b.formatted.category] - categoryPriority[a.formatted.category];
      if (catDiff !== 0) return catDiff;
      return (
        Math.abs(b.edge.properties.correlation_r ?? 0) -
        Math.abs(a.edge.properties.correlation_r ?? 0)
      );
    });
  }, [anchorNode, allEdges, nodeMap, enabledRelationCategories]);

  const filteredLinkedRelations = useMemo(() => {
    if (localRelationFilter === "all") return allLinkedRelations;
    return allLinkedRelations.filter((item) => item.formatted.category === localRelationFilter);
  }, [allLinkedRelations, localRelationFilter]);

  const relationCategoryCounts = useMemo(() => {
    const counts: Record<RelationCategory, number> = {
      opposite: 0,
      causal: 0,
      coupled: 0,
      corroboration: 0,
    };
    for (const item of allLinkedRelations) {
      counts[item.formatted.category] += 1;
    }
    return counts;
  }, [allLinkedRelations]);

  const supportingEdges = useMemo(() => {
    if (!selectedNode) return [];
    return allEdges.filter(
      (e) =>
        e.target_uuid === selectedNode.uuid &&
        (e.type === "supports" || e.type === "corroborates")
    );
  }, [selectedNode, allEdges]);

  const beliefChain = useMemo(() => {
    if (!selectedNode) return [];
    let head = selectedNode.uuid;
    const guard = new Set<string>();
    while (!guard.has(head)) {
      guard.add(head);
      const newer = allEdges.find((e) => e.type === "supersedes" && e.target_uuid === head);
      if (!newer) break;
      head = newer.source_uuid;
    }
    const chain: Array<{ node: ETGNode; rationale?: string }> = [];
    const seen = new Set<string>();
    let curr: string | undefined = head;
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const n = nodeMap.get(curr);
      const edge = allEdges.find((e) => e.type === "supersedes" && e.source_uuid === curr);
      if (n) chain.push({ node: n, rationale: edge?.properties.rationale });
      curr = edge?.target_uuid;
    }
    return chain;
  }, [selectedNode, allEdges, nodeMap]);

  const activeGuidedCase = useMemo(
    () => (activeCaseStudyId ? guidedCases?.find((c) => c.id === activeCaseStudyId) ?? null : null),
    [activeCaseStudyId, guidedCases]
  );
  const isComparingTwoSpots = Boolean(comparison && primary && secondary);
  const isCompareHeader = isComparingTwoSpots || Boolean(comparePending && loading);

  // Sync tab selection when switching between single-spot exploration and 2-spot comparisons
  useEffect(() => {
    if (isCompareHeader || Boolean(selectedEdge)) {
      setActiveTab((prev) => (prev === "science" ? "science" : "relations"));
      return;
    }
    setActiveTab("overview");
  }, [selectionKey, isCompareHeader, selectedEdge]);
  const zoneCandidateNodes = useMemo(
    () => [...nearbyMatching.map((m) => m.node), ...allNodes],
    [nearbyMatching, allNodes]
  );

  const rawLabelA =
    activeGuidedCase?.spotAName ||
    (sourceNode?.properties.region && !sourceNode.properties.region.includes("°")
      ? sourceNode.properties.region
      : sourceNode
        ? humanizeNodeText(sourceNode.properties.name)
        : null) ||
    (primary
      ? describeGeographicZone(primary.lat, primary.lng, zoneCandidateNodes)
      : coord
        ? describeGeographicZone(coord.lat, coord.lng, zoneCandidateNodes)
        : "Spot A");
  const rawLabelB =
    activeGuidedCase?.spotBName ||
    (targetNode?.properties.region && !targetNode.properties.region.includes("°")
      ? targetNode.properties.region
      : targetNode
        ? humanizeNodeText(targetNode.properties.name)
        : null) ||
    (secondary ? describeGeographicZone(secondary.lat, secondary.lng, allNodes) : "Spot B");

  const needZoneDisambiguation =
    isComparingTwoSpots && rawLabelA === rawLabelB && Boolean(primary && secondary);
  const labelA =
    needZoneDisambiguation && primary
      ? `${rawLabelA} (${formatCoordShort(primary.lat, primary.lng)})`
      : rawLabelA;
  const labelB =
    needZoneDisambiguation && secondary
      ? `${rawLabelB} (${formatCoordShort(secondary.lat, secondary.lng)})`
      : rawLabelB;

  const cardTitle = isCompareHeader
    ? `${labelA} ↔ ${labelB}`
    : selectedNode
      ? humanizeNodeText(selectedNode.properties.name)
      : coord
        ? describeGeographicZone(coord.lat, coord.lng, zoneCandidateNodes)
        : "Selected Spot";

  const activeDigest = activeSummary ? describeTrendPlainly(activeSummary, tempUnit) : null;
  const comparisonDigest =
    comparison && primary && secondary
      ? describeComparisonPlainly(comparison, labelA, labelB)
      : null;

  const tempSummaryForNow = useMemo(() => {
    const direct = summaries.find(
      (s) => s.dataset === "nasa_power" && isTemperatureUnitString(s.unit)
    );
    if (direct) return direct;
    if (primary?.dataset === "nasa_power" && isTemperatureUnitString(primary.unit)) {
      return primary;
    }
    return null;
  }, [summaries, primary]);

  const onlyCommunityFilterAtEmptySpot =
    !selectedNode &&
    !isComparingTwoSpots &&
    activeTopics.length === 1 &&
    activeTopics[0] === "community" &&
    nearbyMatching.length === 0;

  const hasStoredNodeMetrics = Boolean(
    selectedNode &&
      (typeof selectedNode.properties.value === "number" ||
        typeof selectedNode.properties.latest_value === "number" ||
        typeof selectedNode.properties.p_value === "number" ||
        typeof selectedNode.properties.theil_sen_slope === "number" ||
        typeof selectedNode.properties.anomaly === "number")
  );

  const visibleDatasetSet = useMemo(
    () => new Set(visibleSummaries.map((s) => s.dataset)),
    [visibleSummaries]
  );

  const hasLocalCommunityMatch = useMemo(
    () => nearbyMatching.some((m) => m.node.properties.dataset === "community"),
    [nearbyMatching]
  );

  const relevantDatasetDiags = useMemo(() => {
    const raw = diagnostics?.datasets ?? [];
    return raw.filter((d) => {
      if (activeTopics.length > 0 && !activeTopics.includes(d.dataset)) return false;
      if (visibleDatasetSet.has(d.dataset)) return false;
      if (d.dataset === "community" && hasLocalCommunityMatch) return false;
      if (
        d.status === "unavailable" &&
        activeTopics.length === 0 &&
        visibleSummaries.length > 0
      ) {
        return false;
      }
      return true;
    });
  }, [diagnostics, activeTopics, visibleDatasetSet, hasLocalCommunityMatch, visibleSummaries.length]);

  const failedFeedLabels = useMemo(() => {
    const labels: string[] = [];
    if (diagnostics?.current?.weatherStatus === "failed_to_fetch") {
      labels.push("Live Weather");
    }
    if (diagnostics?.current?.airQualityStatus === "failed_to_fetch") {
      labels.push("Air Quality");
    }
    for (const d of relevantDatasetDiags) {
      if (d.status === "failed_to_fetch") {
        labels.push(DATASET_BY_ID[d.dataset]?.shortLabel ?? d.dataset);
      }
    }
    return labels;
  }, [diagnostics, relevantDatasetDiags]);

  const hasTopFetchFailure =
    Boolean(error) || failureKind === "failed_to_fetch" || failedFeedLabels.length > 0;

  const hasAnySpotData = Boolean(
    current ||
      visibleSummaries.length > 0 ||
      hasStoredNodeMetrics ||
      nearbyMatching.length > 0 ||
      isComparingTwoSpots
  );

  const handleSaveToGraph = async () => {
    setCommitting(true);
    setActionMsg(null);
    try {
      if (isComparingTwoSpots && primary && secondary && comparison) {
        await onCommitRelation({
          primary,
          secondary,
          comparison,
          sourceNodeUuid: sourceNode?.uuid,
          targetNodeUuid: targetNode?.uuid,
        });
        setActionMsg("Saved linked places to the Knowledge Graph.");
      } else if (activeSummary) {
        await onCommitToGraph(activeSummary);
        setActionMsg("Saved spot to the Knowledge Graph.");
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleVerifyGate = async () => {
    if (!selectedNode) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", nodeUuid: selectedNode.uuid }),
      });
      const data = await res.json();
      setActionMsg(
        data.audit?.corroborated
          ? "Confirmed by multiple independent sources."
          : `Needs ≥2 independent sources (${data.audit?.supportingSources?.length ?? 0} so far).`
      );
      await onGraphUpdated();
    } finally {
      setCommitting(false);
    }
  };

  const handleSimulateWebhook = async () => {
    if (
      !selectedNode ||
      selectedNode.properties.lat === undefined ||
      selectedNode.properties.lng === undefined
    ) {
      return;
    }
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch(
        `/api/graph/nodes/${encodeURIComponent(selectedNode.uuid)}/webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id:
              selectedNode.properties.device_id || `edge-sensor-${selectedNode.uuid.slice(0, 6)}`,
            producer_type: "iot_sensor",
            dataset: selectedNode.properties.dataset || "community",
            lat: selectedNode.properties.lat,
            lng: selectedNode.properties.lng,
            value: selectedNode.properties.value,
            unit: selectedNode.properties.unit || "units",
            confidence: 0.93,
            title: `Local sensor check-in near ${humanizeNodeText(selectedNode.properties.name).slice(0, 28)}`,
          }),
        }
      );
      if (res.ok) {
        setActionMsg("Recorded local sensor check-in.");
        await onGraphUpdated();
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleReviseBelief = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !revName.trim() || !revDesc.trim() || !revRationale.trim()) return;
    setCommitting(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/graph/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorNodeUuid: selectedNode.uuid,
          newName: revName,
          newDescription: revDesc,
          rationale: revRationale,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setShowReviseForm(false);
        setRevName("");
        setRevDesc("");
        setRevRationale("");
        setActionMsg("Saved updated finding.");
        await onGraphUpdated();
        if (data.revisedNode) onSelectNode(data.revisedNode);
      }
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="relative flex max-sm:max-h-[54dvh] sm:max-h-[calc(100dvh-4.25rem)] w-full flex-col overflow-hidden rounded-lg border border-border bg-surface/95 backdrop-blur-md shadow-2xl">
      <SpotCardHeader
        cardTitle={cardTitle}
        isComparingTwoSpots={isComparingTwoSpots}
        isCompareHeader={isCompareHeader}
        coord={coord}
        current={current}
        selectedNode={selectedNode}
        tempUnit={tempUnit}
        onChangeTempUnit={onChangeTempUnit}
        onSatelliteZoomSpot={onSatelliteZoomSpot}
        onOpenSolarForSpot={onOpenSolarForSpot}
        mobileCollapsed={mobileCollapsed}
        onToggleMobileCollapse={onToggleMobileCollapse}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        visibleSummaryCount={visibleSummaries.length}
        linkedRelationCount={allLinkedRelations.length}
        onClose={onClose}
      />

      <div
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain text-xs ${
          mobileCollapsed ? "max-sm:hidden" : ""
        }`}
      >
        {(loading || (!loading && hasTopFetchFailure) || (compareMode && !isComparingTwoSpots)) && (
          <div className="space-y-1.5 px-3 pt-2">
            {loading && (
              <div
                role="progressbar"
                aria-label="Loading spot telemetry"
                className="space-y-2 py-0.5"
              >
                <div className="h-1 w-full overflow-hidden rounded-xs bg-surface-elevated">
                  <div className="h-full w-1/2 animate-pulse rounded-xs bg-sky-400" />
                </div>
                {!hasAnySpotData && (
                  <>
                    <div className="h-14 w-full animate-pulse rounded-md bg-surface-elevated" />
                    <div className="h-12 w-full animate-pulse rounded-md bg-surface-elevated" />
                  </>
                )}
              </div>
            )}

            {!loading && hasTopFetchFailure && hasAnySpotData && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-inset px-2.5 py-1 text-[11px] text-text-muted">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                  <span className="truncate">
                    {failedFeedLabels.length > 0
                      ? `${failedFeedLabels.join(", ")} unavailable right now`
                      : "Partial telemetry unavailable right now"}
                  </span>
                </span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    aria-label="Retry spot telemetry"
                    className="shrink-0 font-medium text-accent-fg hover:underline cursor-pointer"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            {!loading && hasTopFetchFailure && !hasAnySpotData && (
              <div
                role="alert"
                className="flex items-start justify-between gap-2 rounded-md border border-rose-500/40 bg-rose-950/40 p-2.5 text-rose-200"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-[11px] font-semibold text-rose-100">
                      Unable to load live telemetry
                      {failedFeedLabels.length > 0 ? ` (${failedFeedLabels.join(" · ")})` : ""}
                    </div>
                    <p className="text-[11px] leading-relaxed text-rose-200/85">
                      {error
                        ? error
                        : "Upstream telemetry servers could not be reached for this coordinate right now."}
                    </p>
                  </div>
                </div>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    aria-label="Retry spot telemetry"
                    className="shrink-0 cursor-pointer rounded-md border border-rose-400/50 bg-rose-900/70 px-2.5 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-800"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            {compareMode && !isComparingTwoSpots && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-cyan-400/50 bg-cyan-950/60 px-2.5 py-1.5 text-[11px] text-cyan-200">
                <span>Click a second spot on Earth to compare how they change together.</span>
                <button
                  type="button"
                  onClick={onToggleCompareMode}
                  className="shrink-0 font-semibold text-cyan-200 hover:underline cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {!isCompareHeader && (
          <div
            id="spot-panel-overview"
            role="tabpanel"
            aria-labelledby="spot-tab-overview"
            hidden={activeTab !== "overview"}
          >
            <div className="space-y-2.5 px-3 py-2.5">
              {(current || !loading) && coord && (
                <SpotCurrentConditionsSection
                  current={current}
                  tempUnit={tempUnit}
                  tempSummaryForNow={tempSummaryForNow}
                  diagnostics={diagnostics}
                  failureKind={failureKind}
                  error={error}
                />
              )}

              {activeSummary && (
                <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-text-subtle">
                        {activeDigest
                          ? `${activeDigest.topicLabel} · ${activeDigest.parameterShort}`
                          : `${DATASET_BY_ID[activeSummary.dataset]?.shortLabel ?? activeSummary.dataset} · ${activeSummary.parameter}`}
                      </div>
                      {activeDigest && (
                        <div className="mt-0.5 text-[13px] font-medium leading-snug text-text-primary">
                          {activeDigest.headline}
                        </div>
                      )}
                    </div>
                    {visibleSummaries.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setActiveTab("trends")}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent-fg hover:bg-surface-band cursor-pointer"
                      >
                        <span>All {visibleSummaries.length}</span>
                        <ArrowRight className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </div>

                  <SpotTrendChart
                    summary={activeSummary}
                    secondarySummary={secondary}
                    comparison={comparison}
                    labelA={labelA}
                    labelB={labelB}
                    tempUnit={tempUnit}
                  />
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onToggleCompareMode}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
                      compareMode
                        ? "border-cyan-400 bg-cyan-950/70 text-cyan-200"
                        : "border-border bg-surface-elevated text-text-primary hover:border-border-strong"
                    }`}
                  >
                    <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{compareMode ? "Comparing…" : "Compare"}</span>
                  </button>

                  {activeSummary && !selectedNode && (
                    <button
                      type="button"
                      disabled={committing}
                      onClick={() => void handleSaveToGraph()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                    >
                      <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{committing ? "Saving…" : "Save to Graph"}</span>
                    </button>
                  )}

                  {selectedNode && onOpenInGraphWorkbench && (
                    <button
                      type="button"
                      onClick={() => onOpenInGraphWorkbench(selectedNode.uuid)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                    >
                      <GitBranch className="h-3.5 w-3.5 text-accent-fg" aria-hidden="true" />
                      <span>Open in Graph</span>
                    </button>
                  )}

                  {selectedNode && onOpenBriefing && (
                    <button
                      type="button"
                      onClick={() => onOpenBriefing(selectedNode.uuid)}
                      title="Open scientific working paper & references for this node"
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-transparent px-2 py-1.5 text-[11px] font-medium text-text-muted hover:border-border-strong hover:text-text-primary cursor-pointer"
                    >
                      <BookOpenText className="h-3 w-3 text-text-muted" aria-hidden="true" />
                      <span>
                        Paper
                        {selectedNode.properties.dossier?.citations.length
                          ? ` (${selectedNode.properties.dossier.citations.length})`
                          : ""}
                      </span>
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setActiveTab("science")}
                  className="text-[11px] font-medium text-text-muted hover:text-text-primary hover:underline cursor-pointer"
                >
                  Forecast &amp; Stats →
                </button>
              </div>
            </div>
          </div>
        )}

        {!isCompareHeader && (
          <div
            id="spot-panel-trends"
            role="tabpanel"
            aria-labelledby="spot-tab-trends"
            hidden={activeTab !== "trends"}
          >
            <div className="space-y-2.5 px-3 py-2.5">
              <SpotLongTermTrendsSection
                trendLayout={prefs.trendLayout}
                onChangeTrendLayout={(layout) => updatePref("trendLayout", layout)}
                activeTopics={activeTopics}
                onResetTopics={onResetTopics}
                onlyCommunityFilterAtEmptySpot={onlyCommunityFilterAtEmptySpot}
                visibleSummaries={visibleSummaries}
                activeSummary={activeSummary}
                activeDigest={activeDigest}
                onFocusSummary={(key, dataset) => {
                  setFocusedSummaryKey(key);
                  onFocusSummaryDataset(dataset);
                }}
                tempUnit={tempUnit}
                hasStoredNodeMetrics={hasStoredNodeMetrics}
                selectedNode={selectedNode}
                relevantDatasetDiags={relevantDatasetDiags}
                loading={loading}
                microscopeScan={microscopeScan}
                microscopeByNode={microscopeByNode}
                onOpenInGraphWorkbench={onOpenInGraphWorkbench}
              />

              {activeSummary && (
                <div className="border-t border-border-subtle pt-2">
                  <SpotTrendChart
                    summary={activeSummary}
                    secondarySummary={secondary}
                    comparison={comparison}
                    labelA={labelA}
                    labelB={labelB}
                    tempUnit={tempUnit}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        <div
          id="spot-panel-relations"
          role="tabpanel"
          aria-labelledby="spot-tab-relations"
          hidden={activeTab !== "relations"}
        >
          <div className="space-y-2.5 px-3 py-2.5">
            {isComparingTwoSpots && comparisonDigest && primary && secondary && comparison ? (
              <>
                <SpotComparisonModeSection
                  comparisonDigest={comparisonDigest}
                  primary={primary}
                  secondary={secondary}
                  comparison={comparison}
                  current={current}
                  secondaryCurrent={secondaryCurrent}
                  labelA={labelA}
                  labelB={labelB}
                  tempUnit={tempUnit}
                  guidedCases={guidedCases}
                  activeCaseStudyId={activeCaseStudyId}
                  onSelectCaseStudy={onSelectCaseStudy}
                  onSwapPins={onSwapPins}
                  onClearComparison={onClearComparison}
                />

                <div className="border-t border-border-subtle pt-3">
                  <SpotTrendChart
                    summary={activeSummary}
                    secondarySummary={secondary}
                    comparison={comparison}
                    labelA={labelA}
                    labelB={labelB}
                    tempUnit={tempUnit}
                  />
                </div>
              </>
            ) : (
              <SpotRelationsSection
                allNodesCount={allNodes.length}
                allLinkedRelations={allLinkedRelations}
                filteredLinkedRelations={filteredLinkedRelations}
                relationCategoryCounts={relationCategoryCounts}
                localRelationFilter={localRelationFilter}
                onChangeLocalRelationFilter={setLocalRelationFilter}
                anchorNode={anchorNode}
                nearbyMatching={nearbyMatching}
                compareMode={compareMode}
                discoverBusy={discoverBusy}
                onSelectNode={onSelectNode}
                onSelectEdge={onSelectEdge}
                onCompareOpposite={onCompareOpposite}
                onToggleCompareMode={onToggleCompareMode}
                onDiscoverGlobalTrends={onDiscoverGlobalTrends}
              />
            )}
          </div>
        </div>

        <div
          id="spot-panel-science"
          role="tabpanel"
          aria-labelledby="spot-tab-science"
          hidden={activeTab !== "science"}
        >
          <div className="space-y-2.5 px-3 py-2.5">
            <SpotScienceAndActionsSection
              coord={coord}
              selectedNode={selectedNode}
              activeSummary={activeSummary}
              activeDigest={activeDigest}
              comparison={comparison}
              current={current}
              isComparingTwoSpots={isComparingTwoSpots}
              tempUnit={tempUnit}
              committing={committing}
              supportingCount={supportingEdges.length}
              beliefChain={beliefChain}
              actionMsg={actionMsg}
              showReviseForm={showReviseForm}
              onToggleReviseForm={() => setShowReviseForm((v) => !v)}
              revName={revName}
              revDesc={revDesc}
              revRationale={revRationale}
              onChangeRevName={setRevName}
              onChangeRevDesc={setRevDesc}
              onChangeRevRationale={setRevRationale}
              onReviseBelief={handleReviseBelief}
              onSaveToGraph={() => void handleSaveToGraph()}
              onVerifyGate={() => void handleVerifyGate()}
              onSimulateWebhook={() => void handleSimulateWebhook()}
              onSelectNode={onSelectNode}
              spotPrediction={spotPrediction}
              spotPredLoading={spotPredLoading}
              spotPredError={spotPredError}
              onRunRegionalForecast={() => void handleRunRegionalForecast()}
            />

            {(activeSummary || comparison || selectedNode?.properties.p_value !== undefined) && (
              <details
                className="etg-details"
                aria-label="Statistics key for students and judges"
              >
                <summary>Statistics key (p-value, Theil-Sen, SMK)</summary>
                <div className="space-y-1.5 border-t border-border-subtle px-2.5 py-2 font-sans text-[11px] leading-snug text-text-muted">
                  <div>
                    <strong className="ws-numeric text-text-primary">p-value &lt; 0.05:</strong> Less than a 5% chance the trend is random weather luck.
                  </div>
                  <div>
                    <strong className="text-text-primary">Theil-Sen Slope:</strong> Median yearly rate of change (ignores one-off outlier storms).
                  </div>
                  <div>
                    <strong className="text-text-primary">Seasonal MK (Seasonal p):</strong> Compares matching calendar months year-to-year so winter/summer swings never bias the trend.
                  </div>
                </div>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
