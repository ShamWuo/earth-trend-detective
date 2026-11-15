import { NextRequest, NextResponse } from "next/server";
import {
  buildOpenFeedClimatologicalFallback,
  fetchCamsSurfacePm25Series,
  fetchGlofasDischargeSeries,
  fetchNearestUsgsGaugeAnnualSeries,
  isWithinUsgsBounds,
  type OpenFeedSeriesResult,
} from "@/lib/earth/openFeedsClient";
import {
  classifyUpstreamFault,
  createTelemetryBudget,
} from "@/lib/earth/upstreamResilience";
import { getEtgStore } from "@/lib/graph/etgStore";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";

export const dynamic = "force-dynamic";

type SupportedFeed = "cams_pm25" | "usgs_gauge" | "glofas_discharge";

export async function POST(request: NextRequest) {
  const budget = createTelemetryBudget(1500);
  let resolvedFeed: SupportedFeed | undefined;
  let resolvedLat = Number.NaN;
  let resolvedLng = Number.NaN;
  let resolvedStart = 1995;
  let resolvedEnd = 2025;
  let resolvedGranularity: "annual" | "monthly" = "annual";

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

    resolvedFeed = feed;
    resolvedLat = lat;
    resolvedLng = lng;
    resolvedStart = startYear;
    resolvedEnd = endYear;
    resolvedGranularity = granularity;

    const feedPromise =
      feed === "cams_pm25"
        ? fetchCamsSurfacePm25Series(lat, lng, startYear, endYear, granularity, budget)
        : feed === "usgs_gauge"
          ? fetchNearestUsgsGaugeAnnualSeries(lat, lng, startYear, endYear, budget)
          : fetchGlofasDischargeSeries(lat, lng, startYear, endYear, granularity, budget);

    let feedResult = await budget.raceWithFallback<OpenFeedSeriesResult | null>(
      feedPromise,
      () => null
    );

    if (!feedResult || feedResult.points.length < 6) {
      if (feed === "usgs_gauge" && !isWithinUsgsBounds(lat, lng)) {
        return NextResponse.json(
          {
            error: `No active USGS river gauge outside US domain near (${lat.toFixed(2)}, ${lng.toFixed(2)}). Try GloFAS Discharge outside the US.`,
          },
          { status: 404 }
        );
      }
      feedResult = buildOpenFeedClimatologicalFallback(
        feed,
        lat,
        lng,
        startYear,
        endYear,
        granularity
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
      provenanceMode: feedResult.provenanceMode ?? "live",
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
      confidence:
        feedResult.provenanceMode === "climatological_fallback"
          ? 0.58
          : feed === "usgs_gauge"
            ? 0.96
            : 0.9,
      series: feedResult.points,
    });

    const upstreamFault = feedResult.upstreamFault ?? budget.faults[0];
    return NextResponse.json({
      status: "ingested",
      feed,
      provenance: feedResult.provenanceSource,
      provenanceMode: feedResult.provenanceMode ?? "live",
      sourceUrl: feedResult.sourceUrl,
      pointCount: feedResult.points.length,
      ...(upstreamFault ? { upstreamFault } : {}),
      ...(budget.faults.length > 0 ? { upstreamFaults: budget.faults } : {}),
      elapsedMs: budget.elapsedMs(),
      summaryStats,
      hardwareNode: webhookResult.hardwareNode,
      signalNode: webhookResult.signalNode,
      discoveredConnectionsCount: webhookResult.discoveredConnections.length,
      linkedInsightsCount: webhookResult.linkedInsights.length,
      snapshot: store.getSnapshot(),
    });
  } catch (error) {
    const fault = classifyUpstreamFault(error, resolvedFeed ?? "Open Feeds");
    if (resolvedFeed && Number.isFinite(resolvedLat) && Number.isFinite(resolvedLng)) {
      const fallback = buildOpenFeedClimatologicalFallback(
        resolvedFeed,
        resolvedLat,
        resolvedLng,
        resolvedStart,
        resolvedEnd,
        resolvedGranularity
      );
      return NextResponse.json({
        status: "ingested",
        feed: resolvedFeed,
        provenance: fallback.provenanceSource,
        provenanceMode: "climatological_fallback",
        sourceUrl: fallback.sourceUrl,
        pointCount: fallback.points.length,
        upstreamFault: fault,
        upstreamFaults: budget.faults.length > 0 ? budget.faults : [fault],
        elapsedMs: budget.elapsedMs(),
        snapshot: getEtgStore().getSnapshot(),
      });
    }
    return NextResponse.json(
      { error: fault.message, upstreamFault: fault, elapsedMs: budget.elapsedMs() },
      { status: 400 }
    );
  }
}
