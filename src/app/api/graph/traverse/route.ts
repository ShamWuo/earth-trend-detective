import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import type { ETGRelationshipType, TraversalDirection } from "@/types/etg";

export const dynamic = "force-dynamic";

function handleTraverseRequest(params: {
  mode?: string;
  rootUuid?: string;
  fromUuid?: string;
  toUuid?: string;
  anchorUuid?: string;
  maxHops?: number;
  direction?: TraversalDirection;
  edgeTypes?: ETGRelationshipType[];
  minWeight?: number;
  minAbsR?: number;
  limit?: number;
  includeSuperseded?: boolean;
}) {
  const store = getEtgStore();
  const mode =
    params.mode ||
    (params.fromUuid && params.toUuid
      ? "paths"
      : params.rootUuid
        ? "subgraph"
        : "discover_links");

  if (mode === "discover_links") {
    const suggestions = store.discoverCandidateLinks({
      anchorUuid: params.anchorUuid || params.rootUuid,
      minAbsR: params.minAbsR,
      limit: params.limit,
    });
    return { mode: "discover_links", suggestions };
  }

  if (mode === "paths") {
    if (!params.fromUuid || !params.toUuid) {
      throw new Error("Both fromUuid and toUuid are required for path traversal.");
    }
    const paths = store.findAllPaths(params.fromUuid, params.toUuid, params.maxHops ?? 5);
    return { mode: "paths", paths };
  }

  if (!params.rootUuid) {
    throw new Error("rootUuid is required for subgraph traversal.");
  }

  const traversal = store.traverseSubgraph({
    rootUuid: params.rootUuid,
    maxHops: params.maxHops ?? 2,
    direction: params.direction ?? "both",
    edgeTypes: params.edgeTypes,
    minWeight: params.minWeight,
    includeSuperseded: params.includeSuperseded,
  });
  return { mode: "subgraph", ...traversal };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const edgeTypesRaw = searchParams.get("edgeTypes");
    const result = handleTraverseRequest({
      mode: searchParams.get("mode") || undefined,
      rootUuid: searchParams.get("rootUuid") || undefined,
      fromUuid: searchParams.get("fromUuid") || undefined,
      toUuid: searchParams.get("toUuid") || undefined,
      anchorUuid: searchParams.get("anchorUuid") || undefined,
      maxHops: searchParams.has("maxHops") ? Number(searchParams.get("maxHops")) : undefined,
      direction: (searchParams.get("direction") as TraversalDirection | null) || undefined,
      edgeTypes: edgeTypesRaw
        ? (edgeTypesRaw.split(",").filter(Boolean) as ETGRelationshipType[])
        : undefined,
      minWeight: searchParams.has("minWeight") ? Number(searchParams.get("minWeight")) : undefined,
      minAbsR: searchParams.has("minAbsR") ? Number(searchParams.get("minAbsR")) : undefined,
      limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined,
      includeSuperseded: searchParams.get("includeSuperseded") !== "false",
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to traverse ETG" },
      { status: 400 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Parameters<typeof handleTraverseRequest>[0];
    const result = handleTraverseRequest(body || {});
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to traverse ETG" },
      { status: 400 }
    );
  }
}
