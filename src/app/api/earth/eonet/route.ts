import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import { fetchLiveEonetSignals } from "@/lib/nasa/eonetClient";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    let limit = 8;
    try {
      const body = (await req.json()) as { limit?: number };
      if (typeof body?.limit === "number") limit = body.limit;
    } catch {
      // Optional body
    }

    const { provenance, provenanceMode, signals } = await fetchLiveEonetSignals(limit);
    const store = getEtgStore();
    const { added, updated, linkedEdges } = store.ingestEonetSignals(signals);

    return NextResponse.json({
      provenance,
      provenanceMode,
      degraded: provenanceMode === "climatological_fallback",
      added,
      updated,
      linkedEdges,
      signals,
      snapshot: store.getSnapshot(),
    });
  } catch (err) {
    return NextResponse.json({
      provenance: "NASA EONET v3 (Baseline Fallback)",
      provenanceMode: "climatological_fallback",
      degraded: true,
      added: 0,
      updated: 0,
      linkedEdges: 0,
      signals: [],
      warning: err instanceof Error ? err.message : "EONET live sync unavailable",
      snapshot: getEtgStore().getSnapshot(),
    });
  }
}
