import { NextRequest, NextResponse } from "next/server";
import { DATASET_BY_ID } from "@/lib/datasets";
import { getEtgStore } from "@/lib/graph/etgStore";
import { validateGraphAction } from "@/lib/graph/graphGuard";
import { ETG_NODE_LABELS, type ETGDatasetId, type ETGNodeLabel } from "@/types/etg";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json();
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return NextResponse.json({ error: "JSON object payload required." }, { status: 400 });
    }
    const body = rawBody as {
      priorNodeUuid?: unknown;
      newName?: unknown;
      newDescription?: unknown;
      rationale?: unknown;
      label?: unknown;
      dataset?: unknown;
      confidence?: unknown;
      p_value?: unknown;
      theil_sen_slope?: unknown;
    };

    if (
      typeof body.priorNodeUuid !== "string" ||
      typeof body.newName !== "string" ||
      typeof body.newDescription !== "string" ||
      typeof body.rationale !== "string" ||
      !body.priorNodeUuid.trim() ||
      !body.newName.trim() ||
      !body.newDescription.trim() ||
      !body.rationale.trim()
    ) {
      return NextResponse.json(
        {
          error:
            "String priorNodeUuid, newName, newDescription, and rationale are required for epistemic belief revision.",
        },
        { status: 400 }
      );
    }

    if (
      body.label !== undefined &&
      (typeof body.label !== "string" || !ETG_NODE_LABELS.includes(body.label as ETGNodeLabel))
    ) {
      return NextResponse.json(
        {
          error: `Invalid ETG node label "${String(body.label)}"; must be Concept, Signal, Insight, or Rule.`,
        },
        { status: 400 }
      );
    }

    if (
      body.dataset !== undefined &&
      (typeof body.dataset !== "string" || !(body.dataset in DATASET_BY_ID))
    ) {
      return NextResponse.json(
        { error: `Unknown dataset "${String(body.dataset)}".` },
        { status: 400 }
      );
    }

    for (const [k, v] of [
      ["confidence", body.confidence],
      ["p_value", body.p_value],
      ["theil_sen_slope", body.theil_sen_slope],
    ] as const) {
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
        return NextResponse.json(
          { error: `Invalid ${k}: must be a finite number.` },
          { status: 400 }
        );
      }
    }

    const store = getEtgStore();
    const verdict = validateGraphAction(store, {
      type: "revise_belief",
      priorNodeUuid: body.priorNodeUuid,
      newName: body.newName,
      newDescription: body.newDescription,
      rationale: body.rationale,
    });
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: verdict.reason, rule: verdict.rule, guardVerdict: verdict },
        { status: 400 }
      );
    }

    const result = store.reviseBelief({
      priorNodeUuid: body.priorNodeUuid,
      newName: body.newName,
      newDescription: body.newDescription,
      rationale: body.rationale,
      label: body.label as ETGNodeLabel | undefined,
      dataset: body.dataset as ETGDatasetId | undefined,
      confidence: body.confidence as number | undefined,
      p_value: body.p_value as number | undefined,
      theil_sen_slope: body.theil_sen_slope as number | undefined,
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
