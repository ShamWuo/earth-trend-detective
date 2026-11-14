import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  fetchEarthTimeSeries,
  fetchMultiDatasetSummaries,
} from "@/lib/nasa/nasaPowerClient";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import type { ETGDatasetId, ETGNode, TrendAnalysisSummary } from "@/types/etg";

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

  return analyzeTimeSeries(series, {
    lat: node.properties.lat,
    lng: node.properties.lng,
    dataset: node.properties.dataset || "nasa_power",
    parameter: node.properties.parameter || node.properties.name,
    unit: node.properties.unit || "value",
    slopeUnit: node.properties.slope_unit || "unit/yr",
    provenance,
  });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const store = getEtgStore();

    const nodeUuid = searchParams.get("node_uuid");
    const compareNodeUuid = searchParams.get("compare_node_uuid");

    let primary: TrendAnalysisSummary | null = null;
    if (nodeUuid) {
      const node = store.getNode(nodeUuid);
      if (node) {
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

    if (!primary) {
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

      if (parsedDatasets.length >= 2) {
        summaries = await fetchMultiDatasetSummaries(lat, lng, parsedDatasets);
        primary =
          summaries.find((s) => s.dataset === dataset) ?? summaries[0];
      } else {
        const singleDs = parsedDatasets[0] ?? dataset;
        primary = await fetchEarthTimeSeries(lat, lng, singleDs);
        summaries = [primary];
      }
    }

    let secondary: TrendAnalysisSummary | null = null;
    if (compareNodeUuid) {
      const compareNode = store.getNode(compareNodeUuid);
      if (compareNode) {
        secondary = analyzeEmbeddedNodeSeries(compareNode, store);
      }
    }

    const compareLatRaw = searchParams.get("compare_lat");
    const compareLngRaw = searchParams.get("compare_lng");
    const compareDataset =
      (searchParams.get("compare_dataset") as ETGDatasetId) || dataset;

    if (!secondary && compareLatRaw !== null && compareLngRaw !== null) {
      const compareLat = Number(compareLatRaw);
      const compareLng = Number(compareLngRaw);
      if (Number.isFinite(compareLat) && Number.isFinite(compareLng)) {
        secondary = await fetchEarthTimeSeries(compareLat, compareLng, compareDataset);
      }
    }

    const comparison = secondary
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

    return NextResponse.json({
      primary,
      secondary,
      comparison,
      summaries,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Time-series query failed" },
      { status: 502 }
    );
  }
}
