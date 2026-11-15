import { NextRequest, NextResponse } from "next/server";
import { getEtgStore, type TemporalBucket } from "@/lib/graph/etgStore";
import { predictFromGraph, predictRegion } from "@/lib/graph/graphPredictor";
import type { ETGDatasetId, GraphPredictionResult } from "@/types/etg";

export const dynamic = "force-dynamic";

interface PredictRequestParams {
  format?: string;
  v?: string | number;
  action?: "log_forecast" | "reconcile_forecasts" | "sync_l4_finetune";
  targetUuid?: string;
  rootUuid?: string;
  lat?: number;
  lng?: number;
  dataset?: ETGDatasetId;
  persistRegionNode?: boolean;
  maxHops?: number;
  horizonSteps?: number;
  candidateNeighborUuid?: string;
  bucket?: TemporalBucket;
  preferredBucket?: TemporalBucket;
  persistMetrics?: boolean;
  logProspective?: boolean;
}

async function handlePredict(params: PredictRequestParams) {
  const store = getEtgStore();
  const exportVersion = params.v !== undefined ? String(params.v).trim().toLowerCase() : undefined;
  const isV2ExportAlias =
    params.format === "ml_export" && (exportVersion === "2" || exportVersion === "v2");

  if (params.format === "ml_export_v2" || isV2ExportAlias) {
    return store.exportMlGraphDatasetV2({
      rootUuid: params.rootUuid || params.targetUuid,
      maxHops: params.maxHops,
      bucket: params.bucket,
      horizonSteps: params.horizonSteps,
    });
  }

  if (params.format === "ml_export") {
    return store.exportMlGraphDataset({
      rootUuid: params.rootUuid || params.targetUuid,
      maxHops: params.maxHops,
      bucket: params.bucket,
    });
  }

  if (params.format === "ledger") {
    return store.getProspectiveLedger(params.targetUuid);
  }

  if (params.action === "reconcile_forecasts") {
    return store.reconcileProspectiveForecasts(params.targetUuid);
  }

  if (params.action === "sync_l4_finetune") {
    const bundle = store.exportMlGraphDatasetV2({
      rootUuid: params.rootUuid || params.targetUuid,
      maxHops: params.maxHops,
      bucket: params.bucket,
      horizonSteps: params.horizonSteps,
    });
    const serviceUrl = process.env.ETG_ML_SERVICE_URL?.trim().replace(/\/+$/, "");
    if (!serviceUrl) {
      return {
        synced: false,
        mode: "local_fallback",
        reason: "ETG_ML_SERVICE_URL is not configured; using local multi-scale ETG weights.",
        nodeCount: bundle.node_ids.length,
        timeSteps: bundle.time_index.length,
      };
    }
    try {
      const res = await fetch(`${serviceUrl}/finetune/incremental`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle }),
        signal: AbortSignal.timeout(1350),
      });
      if (!res.ok) {
        return {
          synced: false,
          mode: "local_fallback",
          reason: `L4 GPU service returned HTTP ${res.status}`,
        };
      }
      const l4Json = await res.json();
      return {
        synced: true,
        mode: "l4_gpu",
        result: l4Json,
      };
    } catch (err) {
      return {
        synced: false,
        mode: "local_fallback",
        reason: err instanceof Error ? err.message : "L4 GPU service unreachable",
      };
    }
  }

  const hasCoords =
    typeof params.lat === "number" &&
    Number.isFinite(params.lat) &&
    typeof params.lng === "number" &&
    Number.isFinite(params.lng);

  if (!params.targetUuid && !hasCoords) {
    throw new Error(
      "targetUuid or valid (lat, lng) coordinates are required unless format=ml_export, format=ml_export_v2, format=ledger, action=reconcile_forecasts, or action=sync_l4_finetune is specified."
    );
  }

  let prediction: GraphPredictionResult;
  if (params.targetUuid && !hasCoords) {
    prediction = predictFromGraph(store, {
      targetUuid: params.targetUuid,
      maxHops: params.maxHops,
      horizonSteps: params.horizonSteps,
      candidateNeighborUuid: params.candidateNeighborUuid,
      preferredBucket: params.preferredBucket ?? params.bucket,
    });
  } else {
    prediction = await predictRegion(store, {
      targetUuid: params.targetUuid,
      lat: params.lat,
      lng: params.lng,
      dataset: params.dataset,
      maxHops: params.maxHops,
      horizonSteps: params.horizonSteps,
      candidateNeighborUuid: params.candidateNeighborUuid,
      persistRegionNode: params.persistRegionNode,
    });
  }

  const serviceUrl = process.env.ETG_ML_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (serviceUrl) {
    try {
      const bundle = store.exportMlGraphDatasetV2({
        rootUuid: prediction.targetUuid,
        maxHops: params.maxHops,
        bucket: params.bucket ?? prediction.bucket,
        horizonSteps: params.horizonSteps,
      });
      const l4Res = await fetch(`${serviceUrl}/predict/region`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle,
          targetUuid: prediction.targetUuid,
          lat: params.lat,
          lng: params.lng,
          dataset: params.dataset,
          horizonSteps: params.horizonSteps ?? prediction.horizonSteps,
        }),
        signal: AbortSignal.timeout(1350),
      });
      if (l4Res.ok) {
        const l4Data = (await l4Res.json()) as Partial<GraphPredictionResult> & {
          predicted_value?: number;
          quantiles?: { p10: number; p50: number; p90: number };
        };
        const neuralPred =
          typeof l4Data.recommendedForecastValue === "number"
            ? l4Data.recommendedForecastValue
            : typeof l4Data.predicted_value === "number"
              ? l4Data.predicted_value
              : undefined;
        if (neuralPred !== undefined && Number.isFinite(neuralPred)) {
          prediction = {
            ...prediction,
            engineUsed: "l4_inductive_gnn",
            recommendedForecastValue: Number(neuralPred.toFixed(3)),
            quantiles: l4Data.quantiles ?? prediction.quantiles,
            trendForecast: l4Data.trendForecast ?? prediction.trendForecast,
            nextForecast: {
              ...prediction.nextForecast,
              graphAwarePred: Number(neuralPred.toFixed(3)),
            },
          };
        }
      }
    } catch {
      // Graceful fallback to local GraphPredictionResult
    }
  }

  if (params.persistMetrics) {
    for (const contrib of prediction.neighborContributions) {
      if (contrib.edgeUuid && !contrib.isCandidatePreview) {
        store.updateEdge(
          contrib.edgeUuid,
          { predictive_lift_pct: prediction.skillLiftVsSelfPct },
          true
        );
      }
    }
  }

  if (params.action === "log_forecast" || params.logProspective) {
    const loggedForecast = store.logProspectiveForecast(prediction);
    return {
      ...prediction,
      loggedForecast,
      ledger: store.getProspectiveLedger(prediction.targetUuid),
    };
  }

  return prediction;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const result = await handlePredict({
      format: searchParams.get("format") || undefined,
      v: searchParams.get("v") || undefined,
      action:
        (searchParams.get("action") as PredictRequestParams["action"] | null) || undefined,
      targetUuid: searchParams.get("targetUuid") || undefined,
      rootUuid: searchParams.get("rootUuid") || undefined,
      lat: searchParams.has("lat") ? Number(searchParams.get("lat")) : undefined,
      lng: searchParams.has("lng") ? Number(searchParams.get("lng")) : undefined,
      dataset: (searchParams.get("dataset") as ETGDatasetId | null) || undefined,
      persistRegionNode: searchParams.has("persistRegionNode")
        ? searchParams.get("persistRegionNode") !== "false"
        : undefined,
      maxHops: searchParams.has("maxHops") ? Number(searchParams.get("maxHops")) : undefined,
      horizonSteps: searchParams.has("horizonSteps")
        ? Number(searchParams.get("horizonSteps"))
        : undefined,
      candidateNeighborUuid: searchParams.get("candidateNeighborUuid") || undefined,
      bucket: (searchParams.get("bucket") as TemporalBucket | null) || undefined,
      preferredBucket:
        (searchParams.get("preferredBucket") as TemporalBucket | null) || undefined,
      persistMetrics: searchParams.get("persistMetrics") === "true",
      logProspective: searchParams.get("logProspective") === "true",
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Graph prediction failed" },
      { status: 400 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PredictRequestParams;
    const result = await handlePredict(body || {});
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Graph prediction failed" },
      { status: 400 }
    );
  }
}
