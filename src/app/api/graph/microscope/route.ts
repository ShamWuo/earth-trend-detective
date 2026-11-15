import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import { scanTrendMicroscopeAsync } from "@/lib/graph/trendMicroscope";
import type { ETGDatasetId } from "@/types/etg";

export const dynamic = "force-dynamic";

function parseFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const focusNodeUuid = searchParams.get("focusUuid") || undefined;
    const lat = parseFiniteNumber(searchParams.get("lat"));
    const lng = parseFiniteNumber(searchParams.get("lng"));
    const datasetRaw = searchParams.get("dataset");
    const dataset = datasetRaw ? (datasetRaw as ETGDatasetId) : undefined;
    const maxHops = parseFiniteNumber(searchParams.get("maxHops"));
    const topK = parseFiniteNumber(searchParams.get("topK"));

    const result = await scanTrendMicroscopeAsync(getEtgStore(), {
      focusNodeUuid,
      lat,
      lng,
      dataset,
      maxHops,
      topK,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Trend Microscope scan failed",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return NextResponse.json({ error: "JSON object payload required" }, { status: 400 });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }

    const focusNodeUuid =
      typeof body.focusUuid === "string" && body.focusUuid.trim().length > 0
        ? body.focusUuid.trim()
        : undefined;
    const lat = parseFiniteNumber(body.lat);
    const lng = parseFiniteNumber(body.lng);
    const dataset =
      typeof body.dataset === "string" && body.dataset.trim().length > 0
        ? (body.dataset.trim() as ETGDatasetId)
        : undefined;
    const maxHops = parseFiniteNumber(body.maxHops);
    const topK = parseFiniteNumber(body.topK);

    const result = await scanTrendMicroscopeAsync(getEtgStore(), {
      focusNodeUuid,
      lat,
      lng,
      dataset,
      maxHops,
      topK,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Trend Microscope scan failed",
      },
      { status: 500 }
    );
  }
}
