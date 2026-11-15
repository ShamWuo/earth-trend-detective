import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CrossRegionComparison,
  CurrentEarthConditions,
  ETGDatasetId,
  TelemetryFailureKind,
  TelemetryQueryDiagnostics,
  TemperatureUnit,
  TrendAnalysisSummary,
} from "@/types/etg";
import {
  DEFAULT_MULTI_TOPICS,
  GRIDDED_TOPIC_SET,
  isSameSpotCoord,
} from "./workspaceDipolesAndUtils";

export interface UseWorkspaceTelemetryArgs {
  inspectorOpen: boolean;
  probedCoord: { lat: number; lng: number } | null;
  selectedNodeUuid: string | null;
  comparePinB: { lat: number; lng: number } | null;
  selectedEdgeUuid: string | null;
  activeTopics: ETGDatasetId[];
}

export function useWorkspaceTelemetry({
  inspectorOpen,
  probedCoord,
  selectedNodeUuid,
  comparePinB,
  selectedEdgeUuid,
  activeTopics,
}: UseWorkspaceTelemetryArgs) {
  const [telemetryPrimary, setTelemetryPrimary] = useState<TrendAnalysisSummary | null>(null);
  const [telemetrySecondary, setTelemetrySecondary] = useState<TrendAnalysisSummary | null>(null);
  const [telemetryCurrent, setTelemetryCurrent] = useState<CurrentEarthConditions | null>(null);
  const [telemetrySecondaryCurrent, setTelemetrySecondaryCurrent] =
    useState<CurrentEarthConditions | null>(null);
  const [telemetrySummaries, setTelemetrySummaries] = useState<TrendAnalysisSummary[]>([]);
  const [focusedSummaryDataset, setFocusedSummaryDataset] = useState<ETGDatasetId | null>(null);
  const [comparison, setComparison] = useState<CrossRegionComparison | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [telemetryDiagnostics, setTelemetryDiagnostics] =
    useState<TelemetryQueryDiagnostics | null>(null);
  const [telemetryFailureKind, setTelemetryFailureKind] =
    useState<TelemetryFailureKind | null>(null);

  const [tempUnit, setTempUnit] = useState<TemperatureUnit>("C");
  const [tempUnitHydrated, setTempUnitHydrated] = useState(false);

  useEffect(() => {
    try {
      const savedUnit = window.localStorage.getItem("etg:temp-unit:v1");
      if (savedUnit === "C" || savedUnit === "F") {
        setTempUnit(savedUnit);
      }
    } catch {
      // Ignore storage errors
    } finally {
      setTempUnitHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!tempUnitHydrated) return;
    try {
      window.localStorage.setItem("etg:temp-unit:v1", tempUnit);
    } catch {
      // Ignore storage errors
    }
  }, [tempUnitHydrated, tempUnit]);

  const telemetrySummariesRef = useRef<TrendAnalysisSummary[]>([]);
  telemetrySummariesRef.current = telemetrySummaries;
  const telemetryPrimaryRef = useRef<TrendAnalysisSummary | null>(null);
  telemetryPrimaryRef.current = telemetryPrimary;
  const telemetryCurrentRef = useRef<CurrentEarthConditions | null>(null);
  telemetryCurrentRef.current = telemetryCurrent;
  const telemetryLoadingRef = useRef(false);
  telemetryLoadingRef.current = telemetryLoading;
  const telemetryReqSeqRef = useRef(0);
  const telemetryAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      telemetryAbortRef.current?.abort();
    };
  }, []);

  const lastTelemetryArgsRef = useRef<{
    lat: number;
    lng: number;
    dataset: ETGDatasetId;
    compareWith?: { lat: number; lng: number; dataset?: ETGDatasetId; nodeUuid?: string };
    nodeUuid?: string;
    datasetsList?: ETGDatasetId[];
  } | null>(null);

  const cancelTelemetryRequests = useCallback(() => {
    telemetryReqSeqRef.current += 1;
    telemetryAbortRef.current?.abort();
    telemetryAbortRef.current = null;
  }, []);

  const queryTimeSeries = useCallback(
    async (
      lat: number,
      lng: number,
      dataset: ETGDatasetId,
      compareWith?: { lat: number; lng: number; dataset?: ETGDatasetId; nodeUuid?: string },
      nodeUuid?: string,
      datasetsList?: ETGDatasetId[]
    ) => {
      const reqId = ++telemetryReqSeqRef.current;
      telemetryAbortRef.current?.abort();
      const controller = new AbortController();
      telemetryAbortRef.current = controller;
      lastTelemetryArgsRef.current = {
        lat,
        lng,
        dataset,
        compareWith,
        nodeUuid,
        datasetsList,
      };
      setTelemetryLoading(true);
      setTelemetryError(null);
      try {
        const params = new URLSearchParams({
          lat: String(lat),
          lng: String(lng),
          dataset,
        });
        if (datasetsList && datasetsList.length > 0) {
          params.set("datasets", datasetsList.join(","));
        }
        if (nodeUuid) {
          params.set("node_uuid", nodeUuid);
        }
        if (compareWith) {
          params.set("compare_lat", String(compareWith.lat));
          params.set("compare_lng", String(compareWith.lng));
          params.set("compare_dataset", compareWith.dataset || dataset);
          if (compareWith.nodeUuid) {
            params.set("compare_node_uuid", compareWith.nodeUuid);
          }
        }
        const res = await fetch(`/api/earth/timeseries?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (controller.signal.aborted || reqId !== telemetryReqSeqRef.current) return;

        if (res.ok && data) {
          const incomingPrimary: TrendAnalysisSummary | null = data.primary ?? null;
          const incomingSummaries: TrendAnalysisSummary[] = Array.isArray(data.summaries)
            ? data.summaries
            : incomingPrimary
              ? [incomingPrimary]
              : [];
          const incomingDiagnostics: TelemetryQueryDiagnostics | null =
            data.diagnostics ?? null;
          const incomingCurrent: CurrentEarthConditions | null = data.current ?? null;

          const sameSpotPrevSummaries = telemetrySummariesRef.current.filter((s) =>
            isSameSpotCoord(s, lat, lng)
          );
          const sameSpotPrevCurrent =
            telemetryCurrentRef.current &&
            isSameSpotCoord(telemetryCurrentRef.current, lat, lng)
              ? telemetryCurrentRef.current
              : null;

          // If a transient partial retry failed for a topic we already loaded at this spot, preserve it
          let mergedSummaries = incomingSummaries;
          if (!compareWith && sameSpotPrevSummaries.length > 0) {
            const incomingKeys = new Set(
              incomingSummaries.map((s) => `${s.dataset}:${s.parameter}`)
            );
            const failedDatasets = new Set(
              (incomingDiagnostics?.datasets ?? [])
                .filter((d) => d.status === "failed_to_fetch")
                .map((d) => d.dataset)
            );
            const preserved = sameSpotPrevSummaries.filter(
              (s) =>
                !incomingKeys.has(`${s.dataset}:${s.parameter}`) &&
                failedDatasets.has(s.dataset)
            );
            if (preserved.length > 0) {
              mergedSummaries = [...incomingSummaries, ...preserved];
            }
          }

          const preservedCurrent =
            incomingCurrent ??
            (incomingDiagnostics?.current?.weatherStatus === "failed_to_fetch"
              ? sameSpotPrevCurrent
              : null);

          setTelemetryPrimary(
            incomingPrimary ?? mergedSummaries[0] ?? (sameSpotPrevSummaries[0] ?? null)
          );
          setTelemetrySecondary(data.secondary ?? null);
          setTelemetryCurrent(preservedCurrent);
          setTelemetrySecondaryCurrent(data.secondaryCurrent ?? null);
          setComparison(data.comparison ?? null);
          setTelemetrySummaries(mergedSummaries);
          setTelemetryDiagnostics(incomingDiagnostics);
          setTelemetryFailureKind(data.failureKind ?? null);
        } else {
          setTelemetryDiagnostics(data?.diagnostics ?? null);
          setTelemetryFailureKind(data?.failureKind ?? "failed_to_fetch");
          setTelemetryError(
            data?.error ||
              `Failed to fetch telemetry from /api/earth/timeseries (HTTP ${res.status}).`
          );
        }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        if (reqId !== telemetryReqSeqRef.current) return;
        const rawMsg =
          err instanceof Error ? err.message : "Failed to fetch live Earth data.";
        const friendlyMsg = /failed to fetch|networkerror|load failed|fetch failed/i.test(
          rawMsg
        )
          ? "Failed to fetch telemetry from /api/earth/timeseries (local server or network unreachable)."
          : rawMsg;
        setTelemetryFailureKind("failed_to_fetch");
        setTelemetryError(friendlyMsg);
      } finally {
        if (telemetryAbortRef.current === controller) {
          telemetryAbortRef.current = null;
        }
        if (!controller.signal.aborted && reqId === telemetryReqSeqRef.current) {
          setTelemetryLoading(false);
        }
      }
    },
    []
  );

  const retryTelemetry = useCallback(() => {
    const last = lastTelemetryArgsRef.current;
    if (!last) return;
    void queryTimeSeries(
      last.lat,
      last.lng,
      last.dataset,
      last.compareWith,
      last.nodeUuid,
      last.datasetsList
    );
  }, [queryTimeSeries]);

  // Keep open coordinate digest synchronized when user toggles topic filters
  const activeTopicsKey = activeTopics.join(",");
  useEffect(() => {
    if (!inspectorOpen || !probedCoord || selectedNodeUuid || comparePinB || selectedEdgeUuid) {
      return;
    }
    if (telemetryLoadingRef.current) return;

    const requested = activeTopics.length > 0 ? activeTopics : DEFAULT_MULTI_TOPICS;
    const griddedNeeded = requested.filter((ds) => GRIDDED_TOPIC_SET.has(ds));
    if (griddedNeeded.length === 0) return;

    const current = telemetrySummariesRef.current;
    const sameSpot =
      current.length > 0 &&
      Math.abs(current[0].lat - probedCoord.lat) < 0.6 &&
      Math.abs(current[0].lng - probedCoord.lng) < 0.6;
    const loadedSet = new Set(sameSpot ? current.map((s) => s.dataset) : []);
    const missing = griddedNeeded.filter((ds) => !loadedSet.has(ds));

    if (missing.length > 0) {
      const targetTopics = Array.from(new Set([...Array.from(loadedSet), ...missing]));
      void queryTimeSeries(
        probedCoord.lat,
        probedCoord.lng,
        targetTopics[0],
        undefined,
        undefined,
        targetTopics
      );
    }
  }, [
    activeTopicsKey,
    activeTopics,
    inspectorOpen,
    probedCoord,
    selectedNodeUuid,
    comparePinB,
    selectedEdgeUuid,
    queryTimeSeries,
  ]);

  return {
    telemetryPrimary,
    setTelemetryPrimary,
    telemetrySecondary,
    setTelemetrySecondary,
    telemetryCurrent,
    setTelemetryCurrent,
    telemetrySecondaryCurrent,
    setTelemetrySecondaryCurrent,
    telemetrySummaries,
    setTelemetrySummaries,
    focusedSummaryDataset,
    setFocusedSummaryDataset,
    comparison,
    setComparison,
    telemetryLoading,
    setTelemetryLoading,
    telemetryError,
    setTelemetryError,
    telemetryDiagnostics,
    setTelemetryDiagnostics,
    telemetryFailureKind,
    setTelemetryFailureKind,
    tempUnit,
    setTempUnit,
    telemetryPrimaryRef,
    telemetrySummariesRef,
    telemetryCurrentRef,
    cancelTelemetryRequests,
    queryTimeSeries,
    retryTelemetry,
  };
}
