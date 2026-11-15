import { NextRequest, NextResponse } from "next/server";
import { classifyUpstreamFault, createTelemetryBudget } from "@/lib/earth/upstreamResilience";
import { getEtgStore } from "@/lib/graph/etgStore";
import { fetchLiveEonetSignals } from "@/lib/nasa/eonetClient";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const budget = createTelemetryBudget(1500);
  try {
    let limit = 8;
    try {
      const body = (await req.json()) as { limit?: number };
      if (typeof body?.limit === "number") limit = body.limit;
    } catch {
      // Optional body
    }

    const result = await budget.raceWithFallback(
      fetchLiveEonetSignals(limit, budget),
      () => ({
        provenance: "NASA EONET v3 (Baseline Fallback)" as const,
        provenanceMode: "climatological_fallback" as const,
        signals: [],
        upstreamFault: {
          source: "NASA EONET v3",
          kind: "timeout" as const,
          message: "NASA EONET route deadline exceeded; using baseline fallback",
          retryable: false,
        },
        upstreamFaults: budget.faults,
        elapsedMs: budget.elapsedMs(),
      })
    );
    const { provenance, provenanceMode, signals, upstreamFault, upstreamFaults } = result;
    const store = getEtgStore();
    const { added, updated, linkedEdges } = store.ingestEonetSignals(signals);

    return NextResponse.json({
      provenance,
      provenanceMode,
      degraded: provenanceMode === "climatological_fallback",
      ...(upstreamFault ? { upstreamFault } : {}),
      ...(upstreamFaults && upstreamFaults.length > 0 ? { upstreamFaults } : {}),
      elapsedMs: budget.elapsedMs(),
      added,
      updated,
      linkedEdges,
      signals,
      snapshot: store.getSnapshot(),
    });
  } catch (err) {
    const fault = classifyUpstreamFault(err, "NASA EONET v3");
    return NextResponse.json({
      provenance: "NASA EONET v3 (Baseline Fallback)",
      provenanceMode: "climatological_fallback",
      degraded: true,
      upstreamFault: fault,
      upstreamFaults: [fault],
      elapsedMs: budget.elapsedMs(),
      added: 0,
      updated: 0,
      linkedEdges: 0,
      signals: [],
      warning: fault.message,
      snapshot: getEtgStore().getSnapshot(),
    });
  }
}
