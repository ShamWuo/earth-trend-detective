import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import { validateGraphAction } from "@/lib/graph/graphGuard";
import { materializeDenverSolarGraphIntoEtg } from "@/lib/graph/graphPredictor";
import type {
  ETGAuthorType,
  ETGDatasetId,
  ETGEdgeProperties,
  ETGNodeLabel,
  ETGNodeProperties,
  ETGRelationshipType,
  ETGWorkspaceBundle,
} from "@/types/etg";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const store = getEtgStore();

    if (searchParams.get("format") === "bundle") {
      return NextResponse.json(store.exportWorkspaceBundle(), {
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="etg-workspace-bundle.json"',
        },
      });
    }

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

    if (body.action === "import_bundle") {
      const bundle =
        body.bundle && typeof body.bundle === "object"
          ? (body.bundle as Partial<ETGWorkspaceBundle>)
          : null;
      if (!bundle) {
        return NextResponse.json(
          { error: "Provide { action: 'import_bundle', bundle: ETGWorkspaceBundle }." },
          { status: 400 }
        );
      }
      const imported = store.importWorkspaceBundle(bundle, {
        merge: Boolean(body.merge),
      });
      return NextResponse.json(imported, { status: 201 });
    }

    if (body.action === "verify" && typeof body.nodeUuid === "string") {
      const audit = store.evaluateCorroboration(body.nodeUuid);
      return NextResponse.json({ audit, snapshot: store.getSnapshot() }, { status: 200 });
    }

    if (body.action === "trace" && typeof body.fromUuid === "string" && typeof body.toUuid === "string") {
      const path = store.traceShortestPath(body.fromUuid, body.toUuid);
      return NextResponse.json({ path }, { status: 200 });
    }

    if (
      body.action === "connect" &&
      typeof body.source_uuid === "string" &&
      typeof body.target_uuid === "string"
    ) {
      const edgeType = (body.type as ETGRelationshipType) || "relates_to";
      const rationaleStr =
        typeof body.rationale === "string"
          ? body.rationale
          : typeof body.mechanism === "string"
            ? body.mechanism
            : "Manual scientific graph connection";
      const verdict = validateGraphAction(store, {
        type: "connect_nodes",
        sourceUuid: body.source_uuid,
        targetUuid: body.target_uuid,
        edgeType,
        rationale: rationaleStr,
        mechanism: typeof body.mechanism === "string" ? body.mechanism : undefined,
        optimalLagSteps:
          typeof body.optimal_lag_steps === "number" ? body.optimal_lag_steps : undefined,
      });
      if (!verdict.allowed) {
        return NextResponse.json(
          { error: verdict.reason, guardVerdict: verdict },
          { status: 403 }
        );
      }

      const createdEdge = store.createEdge({
        source_uuid: body.source_uuid,
        target_uuid: body.target_uuid,
        type: edgeType,
        rationale: typeof body.rationale === "string" ? body.rationale : undefined,
        mechanism: typeof body.mechanism === "string" ? body.mechanism : undefined,
        source_snippet: typeof body.source_snippet === "string" ? body.source_snippet : undefined,
        optimal_lag_steps:
          typeof body.optimal_lag_steps === "number" ? body.optimal_lag_steps : undefined,
        lag_unit:
          body.lag_unit === "days" || body.lag_unit === "months" || body.lag_unit === "years"
            ? body.lag_unit
            : undefined,
        weight: typeof body.weight === "number" ? body.weight : undefined,
        custom_label: typeof body.custom_label === "string" ? body.custom_label : undefined,
        authored_by: (body.authored_by as ETGAuthorType) || "human",
        autoEnrichSeries: body.auto_enrich !== false,
      });
      return NextResponse.json(
        { edge: createdEdge, snapshot: store.getSnapshot() },
        { status: 201 }
      );
    }

    if (body.action === "materialize_solar_graph") {
      const result = await materializeDenverSolarGraphIntoEtg(store);
      return NextResponse.json(
        {
          hubUuid: result.hubUuid,
          createdNodesCount: result.createdNodes.length,
          createdEdgesCount: result.createdEdges.length,
          snapshot: store.getSnapshot(),
        },
        { status: 201 }
      );
    }

    type RawNodeInput = {
      uuid?: string;
      label: string;
      is_provisional?: boolean;
      properties: { name: string; description: string; [key: string]: unknown };
    };

    const parseNodeValidation = (nodeInput: RawNodeInput) => {
      const props = nodeInput.properties ?? ({} as RawNodeInput["properties"]);
      const rawLat = props.lat;
      const rawLng = props.lng;
      const parsedLat =
        rawLat !== undefined && rawLat !== null && rawLat !== "" ? Number(rawLat) : undefined;
      const parsedLng =
        rawLng !== undefined && rawLng !== null && rawLng !== "" ? Number(rawLng) : undefined;
      const rawDataset = typeof props.dataset === "string" ? props.dataset : undefined;
      const datasetForGuard =
        rawDataset === "co2" ? "air_quality" : (rawDataset as ETGDatasetId | undefined);

      return validateGraphAction(store, {
        type: "create_node",
        label: nodeInput.label as ETGNodeLabel,
        name: typeof props.name === "string" ? props.name : "",
        description: typeof props.description === "string" ? props.description : "",
        region: typeof props.region === "string" ? props.region : undefined,
        lat: parsedLat,
        lng: parsedLng,
        dataset: datasetForGuard,
      });
    };

    const primaryNodeInput: RawNodeInput | null =
      body.node && typeof body.node === "object"
        ? (body.node as RawNodeInput)
        : typeof body.label === "string" && body.properties && typeof body.properties === "object"
          ? {
              uuid: typeof body.uuid === "string" ? body.uuid : undefined,
              label: body.label,
              is_provisional: typeof body.is_provisional === "boolean" ? body.is_provisional : undefined,
              properties: body.properties as RawNodeInput["properties"],
            }
          : null;

    const secondaryNodeInput: RawNodeInput | null =
      body.secondaryNode && typeof body.secondaryNode === "object"
        ? (body.secondaryNode as RawNodeInput)
        : null;

    if (primaryNodeInput) {
      const nodeVerdict = parseNodeValidation(primaryNodeInput);
      if (!nodeVerdict.allowed) {
        return NextResponse.json(
          { error: nodeVerdict.reason, guardVerdict: nodeVerdict, rule: nodeVerdict.rule },
          { status: 400 }
        );
      }
    }
    if (secondaryNodeInput) {
      const secVerdict = parseNodeValidation(secondaryNodeInput);
      if (!secVerdict.allowed) {
        return NextResponse.json(
          { error: secVerdict.reason, guardVerdict: secVerdict, rule: secVerdict.rule },
          { status: 400 }
        );
      }
    }

    let createdNode = null;
    if (primaryNodeInput) {
      createdNode = store.createNode(primaryNodeInput);
    }

    let createdSecondaryNode = null;
    if (secondaryNodeInput) {
      createdSecondaryNode = store.createNode(secondaryNodeInput);
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

      const edgeVerdict = validateGraphAction(store, {
        type: "connect_nodes",
        sourceUuid: resolvedSource,
        targetUuid: resolvedTarget,
        edgeType: (e.type || "relates_to") as ETGRelationshipType,
        rationale:
          typeof e.rationale === "string" && e.rationale.trim().length > 0
            ? e.rationale
            : typeof e.source_snippet === "string" && e.source_snippet.trim().length > 0
              ? e.source_snippet
              : typeof e.mechanism === "string" && e.mechanism.trim().length > 0
                ? e.mechanism
                : "Scientific graph connection created via ETG API",
        mechanism: typeof e.mechanism === "string" ? e.mechanism : undefined,
        optimalLagSteps: typeof e.optimal_lag_steps === "number" ? e.optimal_lag_steps : undefined,
      });

      if (!edgeVerdict.allowed) {
        if (createdNode) store.deleteNode(createdNode.uuid, true);
        if (createdSecondaryNode) store.deleteNode(createdSecondaryNode.uuid, true);
        return NextResponse.json(
          { error: edgeVerdict.reason, guardVerdict: edgeVerdict, rule: edgeVerdict.rule },
          { status: 422 }
        );
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

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      nodeUuid?: string;
      edgeUuid?: string;
      patch?: Record<string, unknown>;
    };
    const store = getEtgStore();

    if (body.nodeUuid && body.patch) {
      const existingNode = store.getNode(body.nodeUuid);
      if (!existingNode) {
        return NextResponse.json({ error: "Node not found" }, { status: 404 });
      }
      const patchObj = body.patch;
      if (patchObj.lat !== undefined && patchObj.lat !== null) {
        const latNum = Number(patchObj.lat);
        if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
          return NextResponse.json(
            { error: `Invalid latitude ${String(patchObj.lat)}; must be within [-90, 90].` },
            { status: 400 }
          );
        }
      }
      if (patchObj.lng !== undefined && patchObj.lng !== null) {
        const lngNum = Number(patchObj.lng);
        if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
          return NextResponse.json(
            { error: `Invalid longitude ${String(patchObj.lng)}; must be within [-180, 180].` },
            { status: 400 }
          );
        }
      }
      const nextName = typeof patchObj.name === "string" ? patchObj.name.trim() : undefined;
      const nextDesc = typeof patchObj.description === "string" ? patchObj.description.trim() : undefined;
      const nextRegion = typeof patchObj.region === "string" ? patchObj.region.trim() : undefined;
      const verdict = validateGraphAction(store, {
        type: "update_node",
        uuid: body.nodeUuid,
        name: nextName !== undefined && nextName !== existingNode.properties.name ? nextName : undefined,
        description:
          nextDesc !== undefined && nextDesc !== existingNode.properties.description ? nextDesc : undefined,
        region:
          nextRegion !== undefined && nextRegion !== (existingNode.properties.region ?? "").trim()
            ? nextRegion
            : undefined,
        rationale:
          typeof patchObj.rationale === "string" && patchObj.rationale.trim().length >= 6
            ? patchObj.rationale
            : "Metadata update via ETG API",
      });
      if (!verdict.allowed) {
        return NextResponse.json(
          { error: verdict.reason, guardVerdict: verdict, rule: verdict.rule },
          { status: verdict.rule === "PROTECTED_AGENCY_BASELINE" ? 403 : 400 }
        );
      }

      const updated = store.updateNode(
        body.nodeUuid,
        patchObj as Partial<ETGNodeProperties> & { label?: string; is_provisional?: boolean }
      );
      if (!updated) {
        return NextResponse.json({ error: "Node not found" }, { status: 404 });
      }
      return NextResponse.json({ node: updated, snapshot: store.getSnapshot() }, { status: 200 });
    }

    if (body.edgeUuid && body.patch) {
      const existingEdge = store
        .getSnapshot()
        .edges.find((edge) => edge.properties.uuid === body.edgeUuid);
      if (!existingEdge) {
        return NextResponse.json({ error: "Edge not found" }, { status: 404 });
      }
      const edgePatch = body.patch as Partial<ETGEdgeProperties> & {
        type?: ETGRelationshipType;
        source_uuid?: string;
        target_uuid?: string;
      };
      const nextSource = edgePatch.source_uuid ?? existingEdge.source_uuid;
      const nextTarget = edgePatch.target_uuid ?? existingEdge.target_uuid;
      const nextType = (edgePatch.type ?? existingEdge.type) as ETGRelationshipType;
      const verdict = validateGraphAction(store, {
        type: "connect_nodes",
        ignoreEdgeUuid: body.edgeUuid,
        sourceUuid: nextSource,
        targetUuid: nextTarget,
        edgeType: nextType,
        rationale:
          typeof edgePatch.rationale === "string" && edgePatch.rationale.trim().length > 0
            ? edgePatch.rationale
            : existingEdge.properties.rationale ||
              existingEdge.properties.mechanism ||
              existingEdge.properties.source_snippet ||
              "Updated scientific edge connection",
        mechanism:
          typeof edgePatch.mechanism === "string"
            ? edgePatch.mechanism
            : existingEdge.properties.mechanism,
        customLabel:
          typeof edgePatch.custom_label === "string" ? edgePatch.custom_label : undefined,
        optimalLagSteps:
          typeof edgePatch.optimal_lag_steps === "number"
            ? edgePatch.optimal_lag_steps
            : existingEdge.properties.optimal_lag_steps,
      });
      if (!verdict.allowed) {
        return NextResponse.json(
          { error: verdict.reason, guardVerdict: verdict, rule: verdict.rule },
          { status: verdict.rule === "EMPIRICAL_EDGE_VERIFICATION" ? 422 : 400 }
        );
      }

      const updated = store.updateEdge(body.edgeUuid, edgePatch);
      if (!updated) {
        return NextResponse.json({ error: "Edge not found" }, { status: 404 });
      }
      return NextResponse.json({ edge: updated, snapshot: store.getSnapshot() }, { status: 200 });
    }

    return NextResponse.json(
      { error: "Provide { nodeUuid, patch } or { edgeUuid, patch }." },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update ETG" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    let nodeUuid = searchParams.get("nodeUuid") || undefined;
    let edgeUuid = searchParams.get("edgeUuid") || undefined;
    let sourceUuid = searchParams.get("sourceUuid") || undefined;
    let targetUuid = searchParams.get("targetUuid") || undefined;

    if (!nodeUuid && !edgeUuid && (!sourceUuid || !targetUuid)) {
      try {
        const body = (await req.json()) as {
          nodeUuid?: string;
          edgeUuid?: string;
          sourceUuid?: string;
          targetUuid?: string;
        };
        nodeUuid = body.nodeUuid;
        edgeUuid = body.edgeUuid;
        sourceUuid = body.sourceUuid;
        targetUuid = body.targetUuid;
      } catch {
        // Query params only
      }
    }

    const store = getEtgStore();
    if (edgeUuid) {
      const verdict = validateGraphAction(store, { type: "delete_edge", uuid: edgeUuid });
      if (!verdict.allowed && verdict.rule === "PROTECTED_AGENCY_BASELINE") {
        return NextResponse.json(
          { error: verdict.reason, guardVerdict: verdict },
          { status: 403 }
        );
      }
      const removed = store.deleteEdge(edgeUuid);
      if (!removed) {
        return NextResponse.json({ error: "Edge not found" }, { status: 404 });
      }
      return NextResponse.json({ deleted: true, edgeUuid, snapshot: store.getSnapshot() }, { status: 200 });
    }

    if (nodeUuid) {
      const verdict = validateGraphAction(store, { type: "delete_node", uuid: nodeUuid });
      if (!verdict.allowed && verdict.rule === "PROTECTED_AGENCY_BASELINE") {
        return NextResponse.json(
          { error: verdict.reason, guardVerdict: verdict },
          { status: 403 }
        );
      }
      const removed = store.deleteNode(nodeUuid);
      if (!removed) {
        return NextResponse.json({ error: "Node not found" }, { status: 404 });
      }
      return NextResponse.json({ deleted: true, nodeUuid, snapshot: store.getSnapshot() }, { status: 200 });
    }

    if (sourceUuid && targetUuid) {
      const pairEdges = store
        .getSnapshot()
        .edges.filter(
          (edge) =>
            (edge.source_uuid === sourceUuid && edge.target_uuid === targetUuid) ||
            (edge.source_uuid === targetUuid && edge.target_uuid === sourceUuid)
        );
      for (const edge of pairEdges) {
        const verdict = validateGraphAction(store, {
          type: "delete_edge",
          uuid: edge.properties.uuid,
        });
        if (!verdict.allowed && verdict.rule === "PROTECTED_AGENCY_BASELINE") {
          return NextResponse.json(
            { error: verdict.reason, guardVerdict: verdict, rule: verdict.rule },
            { status: 403 }
          );
        }
      }
      const count = store.unlinkNodes(sourceUuid, targetUuid);
      return NextResponse.json({ deletedCount: count, snapshot: store.getSnapshot() }, { status: 200 });
    }

    return NextResponse.json(
      { error: "Specify nodeUuid, edgeUuid, or sourceUuid & targetUuid." },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete from ETG" },
      { status: 400 }
    );
  }
}
