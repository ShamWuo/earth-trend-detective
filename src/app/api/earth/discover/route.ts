import { NextRequest, NextResponse } from "next/server";
import { discoverGlobalEarthTrends } from "@/lib/discovery/globalTrendPipeline";
import { classifyUpstreamFault, createTelemetryBudget } from "@/lib/earth/upstreamResilience";
import { getEtgStore } from "@/lib/graph/etgStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const budget = createTelemetryBudget(1600);
  const store = getEtgStore();
  try {
    let body: { clearExisting?: boolean; maxEonetSites?: number } = {};
    try {
      body = (await req.json()) as { clearExisting?: boolean; maxEonetSites?: number };
    } catch {
      body = {};
    }

    const result = await budget.raceWithFallback(
      discoverGlobalEarthTrends(store, {
        clearExisting: body.clearExisting,
        maxEonetSites:
          typeof body.maxEonetSites === "number"
            ? Math.max(3, Math.min(12, Math.floor(body.maxEonetSites)))
            : 7,
      }),
      () => ({
        summary: {
          sourcesQueried: ["Climatological Fallback"],
          gistempZonesIngested: 0,
          eonetEventsIngested: 0,
          nasaPowerSeriesAnalyzed: 0,
          noaaCdoStationsIngested: 0,
          knmiIndicesIngested: 0,
          csaGeocaSeriesIngested: 0,
          swotGranulesLinked: 0,
          insightsCreated: 0,
          corroboratedInsights: 0,
          beliefRevisionsCreated: 0,
          oppositeDipolesWired: 0,
          coTrendingTeleconnectionsWired: 0,
        },
        provenanceMode: "climatological_fallback" as const,
        degraded: true,
        upstreamFaults: budget.faults,
        snapshot: store.getSnapshot(),
      })
    );

    return NextResponse.json(
      {
        provenanceMode:
          "provenanceMode" in result
            ? result.provenanceMode
            : ("live" as const),
        elapsedMs: budget.elapsedMs(),
        ...result,
      },
      { status: 200 }
    );
  } catch (err) {
    const fault = classifyUpstreamFault(err, "Global Earth Trend Discovery");
    return NextResponse.json(
      {
        provenanceMode: "climatological_fallback" as const,
        degraded: true,
        upstreamFault: fault,
        upstreamFaults: [fault],
        elapsedMs: budget.elapsedMs(),
        warning: fault.message,
        snapshot: store.getSnapshot(),
      },
      { status: 200 }
    );
  }
}
