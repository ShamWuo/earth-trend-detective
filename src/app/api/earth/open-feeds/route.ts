import { NextRequest, NextResponse } from "next/server";
import {
  fetchCamsSurfacePm25Series,
  fetchGlofasDischargeSeries,
  fetchNearestUsgsGaugeAnnualSeries,
  type OpenFeedSeriesResult,
} from "@/lib/earth/openFeedsClient";
import { getEtgStore } from "@/lib/graph/etgStore";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";

export const dynamic = "force-dynamic";

type SupportedFeed = "cams_pm25" | "usgs_gauge" | "glofas_discharge";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      feed?: string;
      lat?: number;
      lng?: number;
      startYear?: number;
      endYear?: number;
      granularity?: "annual" | "monthly";
      label?: string;
    };

    const feed = body.feed as SupportedFeed | undefined;
    const lat = Number(body.lat);
    const lng = Number(body.lng);

    if (
      feed !== "cams_pm25" &&
      feed !== "usgs_gauge" &&
      feed !== "glofas_discharge"
    ) {
      return NextResponse.json(
        {
          error:
            "Unsupported feed. Choose one of: cams_pm25, usgs_gauge, glofas_discharge.",
        },
        { status: 400 }
      );
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return NextResponse.json(
        { error: "Valid lat (-90..90) and lng (-180..180) coordinates are required." },
        { status: 400 }
      );
    }

    const startYear = Number.isFinite(Number(body.startYear))
      ? Number(body.startYear)
      : feed === "cams_pm25"
        ? 2022
        : 1995;
    const endYear = Number.isFinite(Number(body.endYear))
      ? Number(body.endYear)
      : 2025;
    const granularity: "annual" | "monthly" =
      body.granularity === "annual" || body.granularity === "monthly"
        ? body.granularity
        : feed === "cams_pm25"
          ? "monthly"
          : "annual";

    let feedResult: OpenFeedSeriesResult | null = null;
    if (feed === "cams_pm25") {
      feedResult = await fetchCamsSurfacePm25Series(
        lat,
        lng,
        startYear,
        endYear,
        granularity
      );
    } else if (feed === "usgs_gauge") {
      feedResult = await fetchNearestUsgsGaugeAnnualSeries(
        lat,
        lng,
        startYear,
        endYear
      );
    } else {
      feedResult = await fetchGlofasDischargeSeries(
        lat,
        lng,
        startYear,
        endYear,
        granularity
      );
    }

    if (!feedResult || feedResult.points.length < 6) {
      return NextResponse.json(
        {
          error:
            feed === "usgs_gauge"
              ? `No active USGS river gauge with >= 6 years of annual discharge data found near (${lat.toFixed(2)}, ${lng.toFixed(2)}). Try GloFAS Discharge outside the US.`
              : `No sufficient observations returned from ${feed} near (${lat.toFixed(2)}, ${lng.toFixed(2)}).`,
        },
        { status: 404 }
      );
    }

    const dataset = feed === "cams_pm25" ? "air_quality" : "hydrology";
    const summaryStats = analyzeTimeSeries(feedResult.points, {
      lat: feedResult.siteInfo?.lat ?? lat,
      lng: feedResult.siteInfo?.lng ?? lng,
      dataset,
      parameter: feedResult.metricName,
      unit: feedResult.unit,
      slopeUnit: `${feedResult.unit}/yr`,
      provenance: feedResult.provenanceSource,
    });

    const latest = feedResult.points[feedResult.points.length - 1];
    const cleanLabel =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim()
        : feedResult.siteInfo
          ? `${feedResult.siteInfo.siteName} (USGS ${feedResult.siteInfo.siteNo})`
          : `${feedResult.metricName} (${lat.toFixed(2)}, ${lng.toFixed(2)})`;

    const nodeSlug = `${feed}-${lat.toFixed(2)}_${lng.toFixed(2)}-${granularity}`;
    const store = getEtgStore();

    const webhookResult = store.ingestHardwareWebhook(`openfeed-${nodeSlug}`, {
      device_id: feedResult.siteInfo?.siteNo
        ? `USGS-${feedResult.siteInfo.siteNo}`
        : `${feedResult.parameterCode}-${lat.toFixed(2)}_${lng.toFixed(2)}`,
      device_name: cleanLabel,
      title: cleanLabel,
      description: `${feedResult.provenanceSource} · ${feedResult.points.length} ${granularity} observations (${feedResult.points[0].date}..${latest.date}). ${summaryStats.verdict}. Source: ${feedResult.sourceUrl}`,
      lat: feedResult.siteInfo?.lat ?? lat,
      lng: feedResult.siteInfo?.lng ?? lng,
      dataset,
      producer_type: feed === "usgs_gauge" ? "iot_sensor" : "nasa_satellite",
      value: latest.value,
      unit: feedResult.unit,
      observed_at: latest.date,
      confidence: feed === "usgs_gauge" ? 0.96 : 0.9,
      series: feedResult.points,
    });

    return NextResponse.json({
      status: "ingested",
      feed,
      provenance: feedResult.provenanceSource,
      sourceUrl: feedResult.sourceUrl,
      pointCount: feedResult.points.length,
      summaryStats,
      hardwareNode: webhookResult.hardwareNode,
      signalNode: webhookResult.signalNode,
      discoveredConnectionsCount: webhookResult.discoveredConnections.length,
      linkedInsightsCount: webhookResult.linkedInsights.length,
      snapshot: store.getSnapshot(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to ingest open physical feed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
