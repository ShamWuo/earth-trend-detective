import { NextRequest, NextResponse } from "next/server";
import { discoverGlobalEarthTrends } from "@/lib/discovery/globalTrendPipeline";
import { getEtgStore } from "@/lib/graph/etgStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    let body: { clearExisting?: boolean; maxEonetSites?: number } = {};
    try {
      body = (await req.json()) as { clearExisting?: boolean; maxEonetSites?: number };
    } catch {
      body = {};
    }

    const store = getEtgStore();
    const result = await discoverGlobalEarthTrends(store, {
      clearExisting: body.clearExisting,
      maxEonetSites:
        typeof body.maxEonetSites === "number"
          ? Math.max(3, Math.min(12, Math.floor(body.maxEonetSites)))
          : 7,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Live global trend discovery failed",
      },
      { status: 502 }
    );
  }
}
