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

    const { provenance, signals } = await fetchLiveEonetSignals(limit);
    const store = getEtgStore();
    const { added, updated, linkedEdges } = store.ingestEonetSignals(signals);

    return NextResponse.json({
      provenance,
      added,
      updated,
      linkedEdges,
      signals,
      snapshot: store.getSnapshot(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "EONET sync failed" },
      { status: 500 }
    );
  }
}
