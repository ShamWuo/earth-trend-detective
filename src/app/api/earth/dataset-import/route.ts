import { NextRequest, NextResponse } from "next/server";
import { importEmpiricalDataset } from "@/lib/discovery/datasetImport";
import { getEtgStore } from "@/lib/graph/etgStore";
import type { ETGDatasetId } from "@/types/etg";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      format?: "csv" | "json";
      content?: string;
      defaultName?: string;
      defaultLat?: number;
      defaultLng?: number;
      defaultDataset?: ETGDatasetId;
      defaultUnit?: string;
      sourceName?: string;
    };

    if (!body || typeof body.content !== "string" || !body.content.trim()) {
      return NextResponse.json(
        { error: "Dataset content (CSV or JSON) is required." },
        { status: 400 }
      );
    }

    const format: "csv" | "json" =
      body.format === "json" || body.content.trim().startsWith("[") || body.content.trim().startsWith("{")
        ? "json"
        : "csv";

    const result = importEmpiricalDataset(getEtgStore(), {
      format,
      content: body.content,
      defaultName: body.defaultName,
      defaultLat: typeof body.defaultLat === "number" ? body.defaultLat : undefined,
      defaultLng: typeof body.defaultLng === "number" ? body.defaultLng : undefined,
      defaultDataset: body.defaultDataset,
      defaultUnit: body.defaultUnit,
      sourceName: body.sourceName,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to import dataset",
      },
      { status: 400 }
    );
  }
}
