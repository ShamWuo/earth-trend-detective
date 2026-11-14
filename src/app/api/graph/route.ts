import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import type { ETGDatasetId, ETGNodeLabel, ETGRelationshipType } from "@/types/etg";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const dataset = (searchParams.get("dataset") as ETGDatasetId | "all") || "all";
    const label = (searchParams.get("label") as ETGNodeLabel | "all") || "all";
    const since = searchParams.get("since") || undefined;
    const until = searchParams.get("until") || undefined;
    const search = searchParams.get("search") || undefined;
    const includeSuperseded = searchParams.get("include_superseded") !== "false";
    const onlyOppositeTrends = searchParams.get("only_opposite") === "true";

    const latRaw = searchParams.get("lat");
    const lngRaw = searchParams.get("lng");
    const radiusRaw = searchParams.get("radius_km");

    const store = getEtgStore();
    const snapshot = store.queryGraph({
      dataset,
      label,
      since,
      until,
      search,
      includeSuperseded,
      onlyOppositeTrends,
      lat: latRaw !== null ? Number(latRaw) : undefined,
      lng: lngRaw !== null ? Number(lngRaw) : undefined,
      radiusKm: radiusRaw !== null ? Number(radiusRaw) : undefined,
    });

    return NextResponse.json(snapshot, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to query ETG" },
      { status: 400 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const store = getEtgStore();

    if (body.action === "clear" || body.action === "reset") {
      return NextResponse.json(store.clearGraph(), { status: 200 });
    }

    if (body.action === "verify" && typeof body.nodeUuid === "string") {
      const audit = store.evaluateCorroboration(body.nodeUuid);
      return NextResponse.json({ audit, snapshot: store.getSnapshot() }, { status: 200 });
    }

    if (body.action === "trace" && typeof body.fromUuid === "string" && typeof body.toUuid === "string") {
      const path = store.traceShortestPath(body.fromUuid, body.toUuid);
      return NextResponse.json({ path }, { status: 200 });
    }

    let createdNode = null;
    if (body.node && typeof body.node === "object") {
      const n = body.node as {
        uuid?: string;
        label: string;
        is_provisional?: boolean;
        properties: { name: string; description: string; [key: string]: unknown };
      };
      createdNode = store.createNode(n);
    } else if (typeof body.label === "string" && body.properties && typeof body.properties === "object") {
      createdNode = store.createNode({
        uuid: typeof body.uuid === "string" ? body.uuid : undefined,
        label: body.label,
        is_provisional: typeof body.is_provisional === "boolean" ? body.is_provisional : undefined,
        properties: body.properties as { name: string; description: string; [key: string]: unknown },
      });
    }

    let createdSecondaryNode = null;
    if (body.secondaryNode && typeof body.secondaryNode === "object") {
      const sn = body.secondaryNode as {
        uuid?: string;
        label: string;
        is_provisional?: boolean;
        properties: { name: string; description: string; [key: string]: unknown };
      };
      createdSecondaryNode = store.createNode(sn);
    }

    let createdEdge = null;
    if (body.edge && typeof body.edge === "object") {
      const e = body.edge as {
        uuid?: string;
        source_uuid: string;
        target_uuid: string;
        type: ETGRelationshipType;
        source_snippet?: string;
        rationale?: string;
        is_provisional?: boolean;
        correlation_r?: number;
        detrended_r?: number;
        lag_days?: number;
        optimal_lag_steps?: number;
        lag_unit?: "months" | "years" | "days";
        mechanism?: string;
        amplification_ratio?: number;
        shared_shift_year?: number;
      };
      const resolvedSource =
        e.source_uuid === "$NEW_NODE" && createdNode
          ? createdNode.uuid
          : e.source_uuid === "$NEW_SECONDARY_NODE" && createdSecondaryNode
            ? createdSecondaryNode.uuid
            : e.source_uuid;
      const resolvedTarget =
        e.target_uuid === "$NEW_SECONDARY_NODE" && createdSecondaryNode
          ? createdSecondaryNode.uuid
          : e.target_uuid === "$NEW_NODE" && createdNode
            ? createdNode.uuid
            : e.target_uuid;

      if (resolvedTarget === "rule-corroboration" || resolvedTarget === "rule-mann-kendall") {
        store.ensureGovernanceRules();
      }
      createdEdge = store.createEdge({
        ...e,
        source_uuid: resolvedSource,
        target_uuid: resolvedTarget,
      });
    }

    let autoConnections = null;
    if (createdNode && createdNode.label === "Signal" && body.auto_connect !== false) {
      autoConnections = store.autoConnectNode(createdNode.uuid, true);
    }

    return NextResponse.json(
      {
        node: createdNode ? store.getNode(createdNode.uuid) ?? createdNode : null,
        secondaryNode: createdSecondaryNode,
        edge: createdEdge,
        autoConnections,
        snapshot: store.getSnapshot(),
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to mutate ETG" },
      { status: 400 }
    );
  }
}
