import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import type { ETGDatasetId, ETGNodeLabel } from "@/types/etg";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      priorNodeUuid?: string;
      newName?: string;
      newDescription?: string;
      rationale?: string;
      label?: ETGNodeLabel;
      dataset?: ETGDatasetId;
      confidence?: number;
      p_value?: number;
      theil_sen_slope?: number;
    };

    if (!body.priorNodeUuid || !body.newName || !body.newDescription || !body.rationale) {
      return NextResponse.json(
        {
          error:
            "priorNodeUuid, newName, newDescription, and rationale are required for epistemic belief revision.",
        },
        { status: 400 }
      );
    }

    const store = getEtgStore();
    const result = store.reviseBelief({
      priorNodeUuid: body.priorNodeUuid,
      newName: body.newName,
      newDescription: body.newDescription,
      rationale: body.rationale,
      label: body.label,
      dataset: body.dataset,
      confidence: body.confidence,
      p_value: body.p_value,
      theil_sen_slope: body.theil_sen_slope,
    });

    return NextResponse.json(
      {
        ...result,
        snapshot: store.getSnapshot(),
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to revise belief" },
      { status: 400 }
    );
  }
}
