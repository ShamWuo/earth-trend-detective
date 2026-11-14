import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ nodeId: string }> }
) {
  const { nodeId } = await context.params;
  const store = getEtgStore();
  const node = store.getNode(nodeId);
  const origin = new URL(req.url).origin;

  return NextResponse.json({
    ready: true,
    nodeId,
    registered: Boolean(node),
    nodeName: node?.properties.name ?? null,
    endpoint: `${origin}/api/graph/nodes/${encodeURIComponent(nodeId)}/webhook`,
    payloadTemplate: {
      device_id: node?.properties.device_id || nodeId,
      dataset: node?.properties.dataset || "community",
      lat: node?.properties.lat ?? null,
      lng: node?.properties.lng ?? null,
      value: node?.properties.value ?? null,
      unit: node?.properties.unit || "units",
      confidence: node?.properties.confidence ?? null,
      observed_at: new Date().toISOString(),
      title: `Live telemetry from ${nodeId}`,
    },
  });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ nodeId: string }> }
) {
  try {
    const { nodeId } = await context.params;
    const url = new URL(req.url);
    const queryParams: Record<string, string | undefined> = {
      value_path: url.searchParams.get("value_path") ?? undefined,
    };

    const rawBody = (await req.json()) as Record<string, unknown>;
    if (!rawBody || typeof rawBody !== "object") {
      return NextResponse.json({ error: "JSON object payload required" }, { status: 400 });
    }

    const store = getEtgStore();
    const result = store.ingestHardwareWebhook(nodeId, rawBody, queryParams);

    return NextResponse.json(
      {
        status: "ingested",
        ...result,
        snapshot: store.getSnapshot(),
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Webhook ingestion failed" },
      { status: 400 }
    );
  }
}
