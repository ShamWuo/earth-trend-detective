import crypto from "node:crypto";
import type {
  CorroborationAudit,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGNodeLabel,
  ETGProducerType,
  ETGResearchDossier,
} from "@/types/etg";
import {
  assertValidEtgLabel,
  haversineKm,
  inferProducerType,
  isCommunityContributorNode,
} from "./etgSeriesAndTrustUtils";
import type { EtgStoreContext } from "./etgStoreContext";

export function ensureGovernanceRulesOp(ctx: EtgStoreContext): {
  mkRule: ETGNode;
  corrRule: ETGNode;
} {
  const now = new Date().toISOString();
  let mkRule = ctx.nodes.get("rule-mann-kendall");
  if (!mkRule) {
    mkRule = {
      uuid: "rule-mann-kendall",
      label: "Rule",
      is_provisional: false,
      properties: {
        name: "Mann-Kendall Trend Significance Gate (p < 0.05)",
        concept_name: "Mann-Kendall Significance Gate",
        description:
          "Mathematical gate verifying that monotonic time-series slopes via Theil-Sen exceed natural variability using two-sided Mann-Kendall (α = 0.05).",
        status: "Active",
        importance: 9,
        producer_type: "ai_synthesis",
        confidence: 0.99,
        created_at: now,
        observed_at: now,
      },
    };
    ctx.nodes.set(mkRule.uuid, mkRule);
  }

  let corrRule = ctx.nodes.get("rule-corroboration");
  if (!corrRule) {
    corrRule = {
      uuid: "rule-corroboration",
      label: "Rule",
      is_provisional: false,
      properties: {
        name: "Multi-Source Corroboration Gate (≥2 Sources)",
        concept_name: "Multi-Source Corroboration Gate",
        description:
          "Scientific epistemology gate requiring at least two independent observational instruments or datasets before promoting a trend Insight to Corroborated.",
        status: "Active",
        importance: 9,
        producer_type: "ai_synthesis",
        confidence: 0.99,
        created_at: now,
        observed_at: now,
      },
    };
    ctx.nodes.set(corrRule.uuid, corrRule);
  }

  return { mkRule, corrRule };
}

export function wouldCreateSupersedesCycleOp(
  ctx: EtgStoreContext,
  sourceUuid: string,
  targetUuid: string,
  ignoreEdgeUuid?: string
): boolean {
  if (sourceUuid === targetUuid) return true;
  const visited = new Set<string>([targetUuid]);
  const queue: string[] = [targetUuid];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const edge of ctx.edges.values()) {
      if (edge.type !== "supersedes") continue;
      if (ignoreEdgeUuid && edge.properties.uuid === ignoreEdgeUuid) continue;
      if (edge.source_uuid !== curr) continue;
      if (edge.target_uuid === sourceUuid) return true;
      if (!visited.has(edge.target_uuid)) {
        visited.add(edge.target_uuid);
        queue.push(edge.target_uuid);
      }
    }
  }
  return false;
}

export function evaluateCorroborationOp(
  ctx: EtgStoreContext,
  nodeUuid: string,
  emit = true
): CorroborationAudit {
  const node = ctx.nodes.get(nodeUuid);
  if (!node) {
    throw new Error(`Node "${nodeUuid}" not found.`);
  }

  ctx.ensureGovernanceRules();

  const supportingSources: CorroborationAudit["supportingSources"] = [];
  const contradictingSources: NonNullable<CorroborationAudit["contradictingSources"]> = [];
  const producerSet = new Set<ETGProducerType>();
  const sourceSystemSet = new Set<string>();
  const countedSupportCoords: Array<{
    pType: ETGProducerType;
    isCommunity: boolean;
    systemKey: string;
    dataset?: string;
    lat?: number;
    lng?: number;
  }> = [];
  let effectiveIndependentTotal = 0;

  for (const edge of ctx.edges.values()) {
    if (edge.target_uuid !== nodeUuid || edge.properties.superseded_at) continue;
    if (edge.type === "supports" || edge.type === "corroborates") {
      const src = ctx.nodes.get(edge.source_uuid);
      if (!src) continue;
      const pType = inferProducerType(src);
      const isCommunityModality =
        pType === "community_camera" || isCommunityContributorNode(src);
      const systemKey = String(
        src.properties.source_system ||
          `${pType}:${src.properties.dataset || src.uuid}`
      );
      producerSet.add(pType);
      sourceSystemSet.add(systemKey);

      const srcLat =
        typeof src.properties.lat === "number" && Number.isFinite(src.properties.lat)
          ? src.properties.lat
          : undefined;
      const srcLng =
        typeof src.properties.lng === "number" && Number.isFinite(src.properties.lng)
          ? src.properties.lng
          : undefined;

      let weightFactor = 1.0;
      for (const prev of countedSupportCoords) {
        const isHomogeneousCommunity = isCommunityModality && prev.isCommunity;
        const isSameSystemOrDataset =
          prev.systemKey === systemKey ||
          (Boolean(src.properties.dataset) &&
            prev.dataset === src.properties.dataset &&
            prev.pType === pType);

        if (
          srcLat !== undefined &&
          srcLng !== undefined &&
          prev.lat !== undefined &&
          prev.lng !== undefined
        ) {
          const distKm = haversineKm(srcLat, srcLng, prev.lat, prev.lng);
          if (distKm < 150 && (isHomogeneousCommunity || isSameSystemOrDataset)) {
            weightFactor = Math.min(weightFactor, 0.45);
          }
        } else if (prev.systemKey === systemKey) {
          weightFactor = Math.min(weightFactor, 0.45);
        }
      }
      effectiveIndependentTotal += weightFactor;
      countedSupportCoords.push({
        pType,
        isCommunity: isCommunityModality,
        systemKey,
        dataset: src.properties.dataset,
        lat: srcLat,
        lng: srcLng,
      });

      supportingSources.push({
        uuid: src.uuid,
        name: src.properties.name,
        label: src.label,
        producerType: pType,
      });
    } else if (edge.type === "contradicts") {
      const src = ctx.nodes.get(edge.source_uuid);
      if (!src) continue;
      contradictingSources.push({
        uuid: src.uuid,
        name: src.properties.name,
        label: src.label,
        producerType: inferProducerType(src),
      });
    }
  }

  const effectiveIndependentSources = Number(effectiveIndependentTotal.toFixed(2));
  const distinctProducerTypes = Array.from(producerSet);
  const corroborated =
    supportingSources.length >= 2 &&
    effectiveIndependentSources >= 1.95 &&
    (sourceSystemSet.size >= 2 || distinctProducerTypes.length >= 2);
  const contested = contradictingSources.length > 0;

  if (supportingSources.length > 0 || contested || node.properties.contested) {
    if (supportingSources.length > 0) {
      node.properties.independent_sources_count = Math.max(
        sourceSystemSet.size,
        supportingSources.length
      );
      node.properties.effective_independent_sources = effectiveIndependentSources;
    }
    node.properties.contradicting_sources_count = contradictingSources.length;
    node.properties.contested = contested;
    ctx.nodes.set(node.uuid, node);
  }

  if (corroborated) {
    const wasTransition = Boolean(node.is_provisional) || node.properties.corroborated !== true;
    node.is_provisional = false;
    node.properties.corroborated = true;
    if (!node.properties.status || node.properties.status === "Provisional") {
      node.properties.status = "Active";
    }
    node.properties.confidence = Math.max(node.properties.confidence ?? 0.85, 0.9);
    ctx.nodes.set(node.uuid, node);

    // Attach rule-corroboration verified_by edge if absent
    const hasRuleEdge = Array.from(ctx.edges.values()).some(
      (e) =>
        e.source_uuid === "rule-corroboration" &&
        e.target_uuid === nodeUuid &&
        e.type === "verified_by"
    );
    if (!hasRuleEdge && ctx.nodes.has("rule-corroboration")) {
      const ruleEdgeId = `edge-rule-${nodeUuid}`;
      ctx.edges.set(ruleEdgeId, {
        source_uuid: "rule-corroboration",
        target_uuid: nodeUuid,
        type: "verified_by",
        properties: {
          uuid: ruleEdgeId,
          is_provisional: false,
          source_snippet: `${supportingSources.length} independent sources (${distinctProducerTypes.join(", ")})`,
          rationale: "Automatically promoted after satisfying multi-source corroboration gate.",
          created_at: new Date().toISOString(),
        },
      });
    }

    if (emit && wasTransition) {
      const act = ctx.pushActivity({
        kind: "corroboration",
        nodeUuid,
        summary: `Corroborated "${node.properties.name}" via ${supportingSources.length} independent sources.`,
      });
      ctx.emitUpdate(act);
    }
  }

  return {
    nodeUuid,
    supportingSources,
    ...(contradictingSources.length > 0 ? { contradictingSources } : {}),
    distinctProducerTypes,
    effectiveIndependentSources,
    corroborated: corroborated || (!node.is_provisional && node.label === "Insight"),
    ...(contested ? { contested } : {}),
    requiredSources: 2,
    gateRuleUuid: "rule-corroboration",
  };
}

export function getBeliefLineageOp(ctx: EtgStoreContext, nodeUuid: string): ETGNode[] {
  // Walk upstream to find newest node, then downstream along `supersedes`
  let head = nodeUuid;
  const guard = new Set<string>();
  while (!guard.has(head)) {
    guard.add(head);
    const newer = Array.from(ctx.edges.values()).find(
      (e) => e.type === "supersedes" && e.target_uuid === head
    );
    if (!newer) break;
    head = newer.source_uuid;
  }

  const chain: ETGNode[] = [];
  const seen = new Set<string>();
  let curr: string | undefined = head;
  while (curr && !seen.has(curr)) {
    seen.add(curr);
    const n = ctx.nodes.get(curr);
    if (n) chain.push(n);
    const older = Array.from(ctx.edges.values()).find(
      (e) => e.type === "supersedes" && e.source_uuid === curr
    );
    curr = older?.target_uuid;
  }
  return chain;
}

export function reviseBeliefOp(
  ctx: EtgStoreContext,
  params: {
    priorNodeUuid: string;
    newNodeUuid?: string;
    newName: string;
    newDescription: string;
    rationale: string;
    label?: ETGNodeLabel;
    dataset?: ETGDatasetId;
    confidence?: number;
    p_value?: number;
    theil_sen_slope?: number;
    series?: ETGNode["properties"]["series"];
    observed_at?: string;
    dossier?: ETGResearchDossier;
    silent?: boolean;
  }
): {
  priorNode: ETGNode;
  revisedNode: ETGNode;
  supersedesEdge: ETGEdge;
  lineage: ETGNode[];
} {
  const prior = ctx.nodes.get(params.priorNodeUuid);
  if (!prior) {
    throw new Error(`Prior node "${params.priorNodeUuid}" not found.`);
  }

  const revisedLabel = assertValidEtgLabel(params.label || prior.label);
  const now = new Date().toISOString();
  const cleanCustomUuid = params.newNodeUuid?.trim();
  const revisedUuid =
    cleanCustomUuid && cleanCustomUuid !== prior.uuid
      ? cleanCustomUuid
      : `revised-${crypto.randomUUID().slice(0, 8)}`;

  const revisedNode: ETGNode = {
    uuid: revisedUuid,
    label: revisedLabel,
    is_provisional: false,
    properties: ctx.offloadNodeSeries(revisedUuid, {
      ...prior.properties,
      name: params.newName.trim(),
      concept_name: params.newName.trim(),
      description: params.newDescription.trim(),
      ...(params.dossier
        ? { dossier: params.dossier }
        : prior.properties.dossier
          ? { dossier: prior.properties.dossier }
          : {}),
      status: "Active",
      superseded_by: undefined,
      dataset: params.dataset || prior.properties.dataset,
      confidence: params.confidence ?? 0.94,
      p_value: params.p_value ?? prior.properties.p_value,
      theil_sen_slope: params.theil_sen_slope ?? prior.properties.theil_sen_slope,
      series: params.series ?? ctx.getNodeSeries(prior.uuid),
      observed_at: params.observed_at ?? now,
      created_at: now,
    }),
  };

  prior.is_provisional = false;
  prior.properties.status = "Superseded";
  prior.properties.superseded_by = revisedUuid;

  const edgeUuid =
    cleanCustomUuid && cleanCustomUuid !== prior.uuid
      ? `edge-supersedes-${revisedUuid}-${prior.uuid}`
      : `edge-supersedes-${crypto.randomUUID().slice(0, 8)}`;
  const supersedesEdge: ETGEdge = {
    source_uuid: revisedUuid,
    target_uuid: prior.uuid,
    type: "supersedes",
    properties: {
      uuid: edgeUuid,
      is_provisional: false,
      source_snippet: "Epistemic belief revision",
      rationale: params.rationale.trim(),
      created_at: now,
    },
  };

  ctx.nodes.set(prior.uuid, prior);
  ctx.nodes.set(revisedNode.uuid, revisedNode);
  ctx.edges.set(edgeUuid, supersedesEdge);

  // Carry forward active incoming/outgoing corroboration and causal links so the revised
  // conclusion remains connected in the graph when Superseded nodes are hidden.
  for (const existingEdge of Array.from(ctx.edges.values())) {
    if (
      existingEdge.type === "supersedes" ||
      existingEdge.type === "verified_by" ||
      existingEdge.properties.superseded_at
    ) {
      continue;
    }
    if (existingEdge.target_uuid === prior.uuid && existingEdge.source_uuid !== revisedUuid) {
      const peer = ctx.nodes.get(existingEdge.source_uuid);
      if (
        peer &&
        peer.properties.status !== "Superseded" &&
        !ctx.hasEdgeBetween(peer.uuid, revisedUuid, true, new Set([existingEdge.type]))
      ) {
        const carriedUuid = `edge-rev-${crypto.randomUUID().slice(0, 8)}`;
        ctx.edges.set(carriedUuid, {
          source_uuid: peer.uuid,
          target_uuid: revisedUuid,
          type: existingEdge.type,
          properties: {
            ...existingEdge.properties,
            uuid: carriedUuid,
            created_at: now,
          },
        });
      }
    } else if (existingEdge.source_uuid === prior.uuid && existingEdge.target_uuid !== revisedUuid) {
      const peer = ctx.nodes.get(existingEdge.target_uuid);
      if (
        peer &&
        peer.properties.status !== "Superseded" &&
        !ctx.hasEdgeBetween(revisedUuid, peer.uuid, true, new Set([existingEdge.type]))
      ) {
        const carriedUuid = `edge-rev-${crypto.randomUUID().slice(0, 8)}`;
        ctx.edges.set(carriedUuid, {
          source_uuid: revisedUuid,
          target_uuid: peer.uuid,
          type: existingEdge.type,
          properties: {
            ...existingEdge.properties,
            uuid: carriedUuid,
            created_at: now,
          },
        });
      }
    }
  }
  ctx.evaluateCorroboration(revisedUuid, false);

  if (!params.silent) {
    const act = ctx.pushActivity({
      kind: "revision",
      nodeUuid: revisedNode.uuid,
      summary: `Belief Revision: "${revisedNode.properties.name}" supersedes "${prior.properties.name}"`,
    });
    ctx.emitUpdate(act);
  }

  return {
    priorNode: prior,
    revisedNode,
    supersedesEdge,
    lineage: getBeliefLineageOp(ctx, revisedNode.uuid),
  };
}
