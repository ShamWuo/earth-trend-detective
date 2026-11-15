import { NextRequest, NextResponse } from "next/server";
import { normalizeEarthCoordinates } from "@/lib/earth/coordinates";
import { validateDatasetForSurface } from "@/lib/earth/surfaceMask";
import {
  fetchCurrentEarthConditionsDetailed,
  inferEmbeddedSeriesUnits,
} from "@/lib/earth/currentConditionsClient";
import {
  classifyUpstreamFault,
  createTelemetryBudget,
} from "@/lib/earth/upstreamResilience";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  buildClimatologicalTrendSummary,
  enrichSummaryWithMonthlySeasonality,
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

export const dynamic = "force-dynamic";

const VALID_DATASET_IDS = new Set<ETGDatasetId>([
  "nasa_power",
  "wildfire",
  "ocean_temp",
  "air_quality",
  "deforestation",
  "hydrology",
  "community",
]);

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

  const summary = analyzeTimeSeries(series, {
    lat: node.properties.lat,
    lng: node.properties.lng,
    dataset: node.properties.dataset || "nasa_power",
    parameter: node.properties.parameter || node.properties.name,
    unit,
    slopeUnit,
    provenance,
  });

  if (!summary.seasonalAnalysis) {
    const monthSeries = store.getNodeMultiScaleSeries(node.uuid, "month");
    if (monthSeries && monthSeries.length >= 18) {
      return enrichSummaryWithMonthlySeasonality(summary, monthSeries);
    }
  }
  return summary;
}

export async function GET(req: NextRequest) {
  const budget = createTelemetryBudget(1550);
  let resolvedLat: number | null = null;
  let resolvedLng: number | null = null;
  let dataset: ETGDatasetId = "nasa_power";

  try {
    const { searchParams } = new URL(req.url);
    const store = getEtgStore();

    const nodeUuid = searchParams.get("node_uuid") ?? searchParams.get("nodeUuid");
    const compareNodeUuid =
      searchParams.get("compare_node_uuid") ?? searchParams.get("compareNodeUuid");

    let primary: TrendAnalysisSummary | null = null;
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
    dataset = (searchParams.get("dataset") as ETGDatasetId) || "nasa_power";
    const preferFallback =
      searchParams.get("fallback") === "1" ||
      searchParams.get("fallback") === "climatological";
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
        currentPromise = fetchCurrentEarthConditionsDetailed(resolvedLat, resolvedLng, budget);
        const primaryDataset = primary.dataset;
        const embeddedIsNonT2mNasaPower =
          primaryDataset === "nasa_power" &&
          !primary.parameter.toUpperCase().startsWith("T2M");
        const needsExtraDatasets = parsedDatasets.some(
          (ds) => ds !== primaryDataset || embeddedIsNonT2mNasaPower
        );
        if (needsExtraDatasets) {
          const extra = await budget.raceWithFallback(
            fetchMultiDatasetSummariesDetailed(
              resolvedLat,
              resolvedLng,
              parsedDatasets,
              1995,
              2025,
              budget
            ),
            () => ({
              summaries: [],
              diagnostics: parsedDatasets
                .filter((ds) => ds !== primaryDataset || embeddedIsNonT2mNasaPower)
                .map((ds) => ({
                  dataset: ds,
                  status: "failed_to_fetch" as const,
                  faultKind: "timeout" as const,
                  reason: "Telemetry deadline exceeded during multi-dataset enrichment",
                })),
            })
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

      const coord = normalizeEarthCoordinates(lat, lng, {
        poleGuardMargin: 0,
        antimeridianMargin: 0,
      });
      resolvedLat = coord.lat;
      resolvedLng = coord.lng;
      currentPromise = fetchCurrentEarthConditionsDetailed(coord.lat, coord.lng, budget);

      if (parsedDatasets.length >= 2) {
        const multi = await budget.raceWithFallback(
          fetchMultiDatasetSummariesDetailed(
            coord.lat,
            coord.lng,
            parsedDatasets,
            1995,
            2025,
            budget
          ),
          () => ({
            summaries: [],
            diagnostics: parsedDatasets.map((ds) => ({
              dataset: ds,
              status: "failed_to_fetch" as const,
              faultKind: "timeout" as const,
              reason: "Telemetry route deadline exceeded",
            })),
          })
        );
        summaries = multi.summaries;
        datasetDiagnostics.push(...multi.diagnostics);
        primary = summaries.find((s) => s.dataset === dataset) ?? summaries[0] ?? null;
      } else {
        const singleDs = parsedDatasets[0] ?? dataset;
        if (singleDs === "community") {
          datasetDiagnostics.push({
            dataset: "community",
            status: "unavailable",
            faultKind: "unavailable",
            reason:
              "Local sensor trends come from nearby geo-pinned stations rather than a global gridded feed.",
          });
        } else {
          try {
            primary = await fetchEarthTimeSeries(
              coord.lat,
              coord.lng,
              singleDs,
              1995,
              2025,
              budget
            );
            summaries = [primary];
          } catch (err) {
            const fault = classifyUpstreamFault(err, singleDs);
            budget.recordFault(fault);
            datasetDiagnostics.push({
              dataset: singleDs,
              status: isTelemetryUnavailableError(err) ? "unavailable" : "failed_to_fetch",
              faultKind: fault.kind,
              ...(fault.httpStatus !== undefined ? { httpStatus: fault.httpStatus } : {}),
              reason: fault.message,
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
            return fetchEarthTimeSeries(
              compareLat,
              compareLng,
              compareDataset,
              1995,
              2025,
              budget
            ).catch(() => null);
          })()
        : Promise.resolve(secondary);

    const secondaryCurrentPromise =
      compareResolvedLat !== null && compareResolvedLng !== null
        ? fetchCurrentEarthConditionsDetailed(compareResolvedLat, compareResolvedLng, budget).then(
            (res) => res.current
          )
        : Promise.resolve(null);

    const [currentOutcome, secondaryResolved, secondaryCurrent] = await budget.raceWithFallback(
      Promise.all([currentPromise, secondarySeriesPromise, secondaryCurrentPromise]),
      () =>
        [
          {
            current: null,
            diagnostics: {
              weatherStatus: "failed_to_fetch" as const,
              weatherReason: "Open-Meteo current conditions deadline exceeded",
              weatherFaultKind: "timeout" as const,
              airQualityStatus: "failed_to_fetch" as const,
              airQualityReason: "Open-Meteo CAMS current deadline exceeded",
              airQualityFaultKind: "timeout" as const,
            },
          },
          null,
          null,
        ] as [
          { current: CurrentEarthConditions | null; diagnostics: CurrentFeedDiagnostics | undefined },
          TrendAnalysisSummary | null,
          CurrentEarthConditions | null,
        ]
    );
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

    const primarySurfaceCheck =
      resolvedLat !== null && resolvedLng !== null
        ? validateDatasetForSurface(dataset, resolvedLat, resolvedLng)
        : null;
    const primaryApplicable = primarySurfaceCheck ? primarySurfaceCheck.applicable : true;

    const climatologicalFallback =
      !primary &&
      resolvedLat !== null &&
      resolvedLng !== null &&
      (primaryApplicable || hasFetchFailure)
        ? buildClimatologicalTrendSummary(
            resolvedLat,
            resolvedLng,
            primaryApplicable ? dataset : "nasa_power"
          )
        : null;

    const resolvedProvenanceMode =
      !hasAnyData && climatologicalFallback
        ? ("climatological_fallback" as const)
        : (primary?.provenanceMode ?? current?.provenanceMode ?? null);

    const diagnosticsPayload = {
      ...(currentDiagnostics ? { current: currentDiagnostics } : {}),
      ...(datasetDiagnostics.length > 0 ? { datasets: datasetDiagnostics } : {}),
      ...(budget.faults.length > 0 ? { faults: budget.faults } : {}),
      elapsedMs: budget.elapsedMs(),
      ...(resolvedProvenanceMode ? { provenanceMode: resolvedProvenanceMode } : {}),
    };

    if (!hasAnyData && climatologicalFallback) {
      return NextResponse.json({
        primary: climatologicalFallback,
        secondary,
        comparison,
        summaries: [climatologicalFallback],
        current,
        secondaryCurrent,
        provenanceMode: "climatological_fallback" as const,
        failureKind,
        ...(budget.faults[0] ? { upstreamFault: budget.faults[0] } : {}),
        diagnostics: diagnosticsPayload,
        climatologicalFallback,
      });
    }

    if (preferFallback && !primary && climatologicalFallback) {
      primary = climatologicalFallback;
      summaries = [climatologicalFallback];
    }

    return NextResponse.json({
      primary,
      secondary,
      comparison,
      summaries,
      current,
      secondaryCurrent,
      provenanceMode: primary?.provenanceMode ?? current?.provenanceMode ?? null,
      failureKind,
      ...(budget.faults[0] ? { upstreamFault: budget.faults[0] } : {}),
      diagnostics: diagnosticsPayload,
      ...(climatologicalFallback ? { climatologicalFallback } : {}),
    });
  } catch (err) {
    const fault = classifyUpstreamFault(err, dataset ?? "nasa_power");
    budget.recordFault(fault);
    if (resolvedLat !== null && resolvedLng !== null) {
      const fallbackSurface = validateDatasetForSurface(
        dataset,
        resolvedLat,
        resolvedLng
      );
      const climatologicalFallback = buildClimatologicalTrendSummary(
        resolvedLat,
        resolvedLng,
        fallbackSurface.applicable ? dataset : "nasa_power"
      );
      return NextResponse.json({
        primary: climatologicalFallback,
        secondary: null,
        comparison: null,
        summaries: [climatologicalFallback],
        current: null,
        secondaryCurrent: null,
        provenanceMode: "climatological_fallback" as const,
        failureKind: "failed_to_fetch" as const,
        upstreamFault: fault,
        diagnostics: {
          faults: budget.faults,
          elapsedMs: budget.elapsedMs(),
          provenanceMode: "climatological_fallback" as const,
        },
        error: fault.message,
        climatologicalFallback,
      });
    }
    return NextResponse.json(
      {
        error: fault.message,
        failureKind: "failed_to_fetch",
        upstreamFault: fault,
      },
      { status: 400 }
    );
  }
}
