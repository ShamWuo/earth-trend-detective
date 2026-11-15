import { NextRequest, NextResponse } from "next/server";
import {
  fetchCurrentEarthConditionsDetailed,
  inferEmbeddedSeriesUnits,
} from "@/lib/earth/currentConditionsClient";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  fetchEarthTimeSeries,
  fetchMultiDatasetSummariesDetailed,
  isTelemetryUnavailableError,
} from "@/lib/nasa/nasaPowerClient";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import type {
  CurrentEarthConditions,
  CurrentFeedDiagnostics,
  DatasetTelemetryDiagnostic,
  ETGDatasetId,
  ETGNode,
  TelemetryFailureKind,
  TrendAnalysisSummary,
} from "@/types/etg";

const VALID_DATASET_IDS = new Set<ETGDatasetId>([
  "nasa_power",
  "wildfire",
  "ocean_temp",
  "air_quality",
  "deforestation",
  "hydrology",
  "community",
]);

export const dynamic = "force-dynamic";

function analyzeEmbeddedNodeSeries(
  node: ETGNode,
  store: ReturnType<typeof getEtgStore>
): TrendAnalysisSummary | null {
  const series = node.properties.series ?? store.getNodeSeries(node.uuid);
  if (!Array.isArray(series) || series.length < 5) return null;
  if (node.properties.lat === undefined || node.properties.lng === undefined) return null;

  const provenance =
    node.properties.provenance_source || "Empirical Dataset (Imported)";
  const { unit, slopeUnit } = inferEmbeddedSeriesUnits(node.properties);

  return analyzeTimeSeries(series, {
    lat: node.properties.lat,
    lng: node.properties.lng,
    dataset: node.properties.dataset || "nasa_power",
    parameter: node.properties.parameter || node.properties.name,
    unit,
    slopeUnit,
    provenance,
  });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const store = getEtgStore();

    const nodeUuid = searchParams.get("node_uuid") ?? searchParams.get("nodeUuid");
    const compareNodeUuid =
      searchParams.get("compare_node_uuid") ?? searchParams.get("compareNodeUuid");

    let primary: TrendAnalysisSummary | null = null;
    let resolvedLat: number | null = null;
    let resolvedLng: number | null = null;
    if (nodeUuid) {
      const node = store.getNode(nodeUuid);
      if (node) {
        if (
          typeof node.properties.lat === "number" &&
          typeof node.properties.lng === "number"
        ) {
          resolvedLat = node.properties.lat;
          resolvedLng = node.properties.lng;
        }
        primary = analyzeEmbeddedNodeSeries(node, store);
      }
    }

    const latRaw = searchParams.get("lat");
    const lngRaw = searchParams.get("lng");
    const dataset = (searchParams.get("dataset") as ETGDatasetId) || "nasa_power";
    const datasetsParam = searchParams.get("datasets");
    const parsedDatasets = datasetsParam
      ? Array.from(
          new Set(
            datasetsParam
              .split(",")
              .map((s) => s.trim() as ETGDatasetId)
              .filter((s) => VALID_DATASET_IDS.has(s))
          )
        )
      : [];

    let summaries: TrendAnalysisSummary[] = primary ? [primary] : [];
    const datasetDiagnostics: DatasetTelemetryDiagnostic[] = [];
    let currentPromise: Promise<{
      current: CurrentEarthConditions | null;
      diagnostics: CurrentFeedDiagnostics | undefined;
    }> = Promise.resolve({ current: null, diagnostics: undefined });

    if (primary) {
      if (resolvedLat !== null && resolvedLng !== null) {
        currentPromise = fetchCurrentEarthConditionsDetailed(resolvedLat, resolvedLng);
        const primaryDataset = primary.dataset;
        const embeddedIsNonT2mNasaPower =
          primaryDataset === "nasa_power" &&
          !primary.parameter.toUpperCase().startsWith("T2M");
        const needsExtraDatasets = parsedDatasets.some(
          (ds) => ds !== primaryDataset || embeddedIsNonT2mNasaPower
        );
        if (needsExtraDatasets) {
          const extra = await fetchMultiDatasetSummariesDetailed(
            resolvedLat,
            resolvedLng,
            parsedDatasets
          );
          const seenKeys = new Set<string>([`${primary.dataset}:${primary.parameter}`]);
          const seenDatasets = new Set<ETGDatasetId>(
            embeddedIsNonT2mNasaPower ? [] : [primary.dataset]
          );
          summaries = [primary];
          for (const item of extra.summaries) {
            const key = `${item.dataset}:${item.parameter}`;
            if (seenKeys.has(key) || seenDatasets.has(item.dataset)) continue;
            seenKeys.add(key);
            seenDatasets.add(item.dataset);
            summaries.push(item);
          }
          for (const diag of extra.diagnostics) {
            if (!seenDatasets.has(diag.dataset)) {
              datasetDiagnostics.push(diag);
            }
          }
        }
      }
    } else {
      if (latRaw === null || lngRaw === null) {
        return NextResponse.json(
          { error: "Valid numeric query parameters 'lat' and 'lng' (or a node_uuid with series) are required." },
          { status: 400 }
        );
      }
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return NextResponse.json(
          { error: "Valid numeric query parameters 'lat' and 'lng' are required." },
          { status: 400 }
        );
      }

      resolvedLat = lat;
      resolvedLng = lng;
      currentPromise = fetchCurrentEarthConditionsDetailed(lat, lng);

      if (parsedDatasets.length >= 2) {
        const multi = await fetchMultiDatasetSummariesDetailed(lat, lng, parsedDatasets);
        summaries = multi.summaries;
        datasetDiagnostics.push(...multi.diagnostics);
        primary = summaries.find((s) => s.dataset === dataset) ?? summaries[0] ?? null;
      } else {
        const singleDs = parsedDatasets[0] ?? dataset;
        if (singleDs === "community") {
          datasetDiagnostics.push({
            dataset: "community",
            status: "unavailable",
            reason:
              "Local sensor trends come from nearby geo-pinned stations rather than a global gridded feed.",
          });
        } else {
          try {
            primary = await fetchEarthTimeSeries(lat, lng, singleDs);
            summaries = [primary];
          } catch (err) {
            datasetDiagnostics.push({
              dataset: singleDs,
              status: isTelemetryUnavailableError(err) ? "unavailable" : "failed_to_fetch",
              reason:
                err instanceof Error ? err.message : `Failed to fetch ${singleDs} telemetry.`,
            });
          }
        }
      }
    }

    let secondary: TrendAnalysisSummary | null = null;
    let compareResolvedLat: number | null = null;
    let compareResolvedLng: number | null = null;
    if (compareNodeUuid) {
      const compareNode = store.getNode(compareNodeUuid);
      if (compareNode) {
        if (
          typeof compareNode.properties.lat === "number" &&
          typeof compareNode.properties.lng === "number"
        ) {
          compareResolvedLat = compareNode.properties.lat;
          compareResolvedLng = compareNode.properties.lng;
        }
        secondary = analyzeEmbeddedNodeSeries(compareNode, store);
      }
    }

    const compareLatRaw = searchParams.get("compare_lat");
    const compareLngRaw = searchParams.get("compare_lng");
    const compareDataset =
      (searchParams.get("compare_dataset") as ETGDatasetId) || dataset;

    const secondarySeriesPromise: Promise<TrendAnalysisSummary | null> =
      !secondary && compareLatRaw !== null && compareLngRaw !== null
        ? (() => {
            const compareLat = Number(compareLatRaw);
            const compareLng = Number(compareLngRaw);
            if (!Number.isFinite(compareLat) || !Number.isFinite(compareLng)) {
              return Promise.resolve(null);
            }
            compareResolvedLat = compareLat;
            compareResolvedLng = compareLng;
            return fetchEarthTimeSeries(compareLat, compareLng, compareDataset).catch(
              () => null
            );
          })()
        : Promise.resolve(secondary);

    const secondaryCurrentPromise =
      compareResolvedLat !== null && compareResolvedLng !== null
        ? fetchCurrentEarthConditionsDetailed(compareResolvedLat, compareResolvedLng).then(
            (res) => res.current
          )
        : Promise.resolve(null);

    const [currentOutcome, secondaryResolved, secondaryCurrent] = await Promise.all([
      currentPromise,
      secondarySeriesPromise,
      secondaryCurrentPromise,
    ]);
    secondary = secondaryResolved;
    const current = currentOutcome.current;
    const currentDiagnostics = currentOutcome.diagnostics;

    const comparison =
      primary && secondary
        ? compareRegionalSeries(
            primary.points.map((p) => ({ date: p.date, t: p.t, value: p.value })),
            secondary.points.map((p) => ({ date: p.date, t: p.t, value: p.value })),
            {
              latA: primary.lat,
              lngA: primary.lng,
              datasetA: primary.dataset,
              latB: secondary.lat,
              lngB: secondary.lng,
              datasetB: secondary.dataset,
            }
          )
        : null;

    const hasAnyData = Boolean(
      primary || summaries.length > 0 || current || secondary || secondaryCurrent
    );
    const hasFetchFailure =
      currentDiagnostics?.weatherStatus === "failed_to_fetch" ||
      currentDiagnostics?.airQualityStatus === "failed_to_fetch" ||
      datasetDiagnostics.some((d) => d.status === "failed_to_fetch");
    const failureKind: TelemetryFailureKind | null = hasFetchFailure
      ? "failed_to_fetch"
      : hasAnyData
        ? null
        : "unavailable";

    const diagnosticsPayload = {
      ...(currentDiagnostics ? { current: currentDiagnostics } : {}),
      ...(datasetDiagnostics.length > 0 ? { datasets: datasetDiagnostics } : {}),
    };

    if (!hasAnyData && hasFetchFailure) {
      const firstFailedReason =
        datasetDiagnostics.find((d) => d.status === "failed_to_fetch")?.reason ||
        (currentDiagnostics?.weatherStatus === "failed_to_fetch"
          ? currentDiagnostics.weatherReason
          : undefined) ||
        (currentDiagnostics?.airQualityStatus === "failed_to_fetch"
          ? currentDiagnostics.airQualityReason
          : undefined) ||
        "Failed to fetch live Earth telemetry.";
      return NextResponse.json(
        {
          error: firstFailedReason,
          failureKind: "failed_to_fetch",
          diagnostics: diagnosticsPayload,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      primary,
      secondary,
      comparison,
      summaries,
      current,
      secondaryCurrent,
      failureKind,
      diagnostics: diagnosticsPayload,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Time-series query failed",
        failureKind: "failed_to_fetch",
      },
      { status: 502 }
    );
  }
}
