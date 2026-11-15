import crypto from "node:crypto";
import { DATASET_BY_ID } from "@/lib/datasets";
import {
  analyzeTimeSeries,
  benjaminiHochbergAdjust,
  compareRegionalSeries,
} from "@/lib/stats/trendEngine";
import type {
  CorroborationAudit,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGProducerType,
  ETGRelationshipType,
  TimeSeriesPoint,
} from "@/types/etg";
import {
  FORBIDDEN_PATH_SEGMENTS,
  alignCompatibleSeries,
  extractValueByPath,
  haversineKm,
  mergeSeriesPoints,
  toTimeSeriesPoint,
} from "./etgSeriesAndTrustUtils";
import type { EtgStoreContext } from "./etgStoreContext";

function itemCouplingPriority(
  comp: ReturnType<typeof compareRegionalSeries>,
  effR: number
): number {
  return (
    (comp.isSecularDriftOnly ? -0.35 : 0) +
    Math.max(Math.abs(comp.detrendedR), Math.abs(comp.optimalLagR), Math.abs(effR))
  );
}

/**
 * Links a geo-pinned observation to nearby Insights (`corroborates`) and Signals (`relates_to`).
 */
export function linkNearbyNodesOp(
  ctx: EtgStoreContext,
  sourceNode: ETGNode,
  radiusKm = 450
): {
  linkedInsights: ETGNode[];
  linkedSignals: ETGNode[];
  corroborationAudits: CorroborationAudit[];
} {
  const linkedInsights: ETGNode[] = [];
  const linkedSignals: ETGNode[] = [];
  const corroborationAudits: CorroborationAudit[] = [];

  const srcLat = sourceNode.properties.lat;
  const srcLng = sourceNode.properties.lng;
  if (
    srcLat === undefined ||
    srcLng === undefined ||
    !Number.isFinite(srcLat) ||
    !Number.isFinite(srcLng)
  ) {
    return { linkedInsights, linkedSignals, corroborationAudits };
  }

  const now = new Date().toISOString();
  const nearbySignals: Array<{ candidate: ETGNode; dist: number }> = [];
  const srcDevice = sourceNode.properties.device_id;
  const supportEdgeTypes = new Set<ETGRelationshipType>(["supports", "corroborates"]);

  for (const candidate of ctx.nodes.values()) {
    if (candidate.uuid === sourceNode.uuid) continue;
    if (candidate.properties.status === "Superseded") continue;
    const cLat = candidate.properties.lat;
    const cLng = candidate.properties.lng;
    if (cLat === undefined || cLng === undefined || !Number.isFinite(cLat) || !Number.isFinite(cLng)) {
      continue;
    }

    const dist = haversineKm(srcLat, srcLng, cLat, cLng);
    if (dist > radiusKm) continue;

    if (candidate.label === "Insight") {
      if (!ctx.hasEdgeBetween(sourceNode.uuid, candidate.uuid, true, supportEdgeTypes)) {
        const edgeId = `edge-corr-${crypto.randomUUID().slice(0, 8)}`;
        const unitStr = sourceNode.properties.unit ? ` ${sourceNode.properties.unit}` : "";
        const valLabel =
          sourceNode.properties.value !== undefined
            ? `${sourceNode.properties.value}${unitStr}`
            : "telemetry";
        ctx.edges.set(edgeId, {
          source_uuid: sourceNode.uuid,
          target_uuid: candidate.uuid,
          type: "corroborates",
          properties: {
            uuid: edgeId,
            is_provisional: false,
            source_snippet: `${sourceNode.properties.device_id || sourceNode.properties.source_system || sourceNode.label} within ${Math.round(dist)} km`,
            rationale: `Observation "${sourceNode.properties.name}" (${valLabel}) corroborates nearby Earth trend within ${Math.round(dist)} km.`,
            created_at: now,
          },
        });
      }
      linkedInsights.push(candidate);
      corroborationAudits.push(ctx.evaluateCorroboration(candidate.uuid, false));
    } else if (candidate.label === "Signal") {
      if (srcDevice && candidate.properties.device_id === srcDevice) continue;
      nearbySignals.push({ candidate, dist });
    }
  }

  nearbySignals.sort((a, b) => a.dist - b.dist);
  for (const { candidate, dist } of nearbySignals.slice(0, 4)) {
    if (ctx.hasEdgeBetween(sourceNode.uuid, candidate.uuid, false)) continue;
    const edgeId = `edge-near-${crypto.randomUUID().slice(0, 8)}`;
    ctx.edges.set(edgeId, {
      source_uuid: sourceNode.uuid,
      target_uuid: candidate.uuid,
      type: "relates_to",
      properties: {
        uuid: edgeId,
        is_provisional: false,
        source_snippet: `Co-located Earth observation (${Math.round(dist)} km)`,
        rationale: `Spatial proximity (${Math.round(dist)} km) between active Earth observations.`,
        created_at: now,
      },
    });
    linkedSignals.push(candidate);
  }

  return { linkedInsights, linkedSignals, corroborationAudits };
}

/**
 * Runs Mann-Kendall / Theil-Sen on a node's accumulated series and discovers statistically
 * significant cross-region couplings (`drives_opposite`, `teleconnects`, `correlates_with`).
 */
export function discoverConnectionsForSeriesNodeOp(
  ctx: EtgStoreContext,
  anchorNode: ETGNode
): { discoveredEdges: ETGEdge[] } {
  const discoveredEdges: ETGEdge[] = [];
  const series = ctx.getNodeSeries(anchorNode.uuid);
  const lat = anchorNode.properties.lat;
  const lng = anchorNode.properties.lng;
  if (!series || series.length < 5 || lat === undefined || lng === undefined) {
    return { discoveredEdges };
  }

  const dataset = anchorNode.properties.dataset || "community";
  const unit = anchorNode.properties.unit || "units";
  const slopeUnit = anchorNode.properties.slope_unit || `${unit}/yr`;
  const summary = analyzeTimeSeries(series, {
    lat,
    lng,
    dataset,
    parameter: anchorNode.properties.parameter || anchorNode.properties.name,
    unit,
    slopeUnit,
    provenance: anchorNode.properties.provenance_source || "Empirical Dataset (Imported)",
  });

  const updatedAnchor: ETGNode = {
    ...anchorNode,
    properties: {
      ...anchorNode.properties,
      p_value: summary.mannKendall.pValue,
      p_value_adjusted: summary.mannKendall.pValueAdjusted,
      theil_sen_slope: summary.theilSen.slope,
      slope_unit: slopeUnit,
      ols_r2: summary.ols.rSquared,
      regime_shift_year: summary.changePoint?.date ?? anchorNode.properties.regime_shift_year,
      series_count: series.length,
    },
  };
  ctx.nodes.set(anchorNode.uuid, updatedAnchor);

  // Deduplicate remote candidates by rounded coordinate + dataset, preferring Insight over Signal
  const dedupedCandidates = new Map<string, { node: ETGNode; distKm: number; series: TimeSeriesPoint[] }>();
  for (const other of ctx.nodes.values()) {
    if (other.uuid === anchorNode.uuid) continue;
    if (other.properties.status === "Superseded") continue;
    if (other.label !== "Insight" && other.label !== "Signal") continue;
    const oLat = other.properties.lat;
    const oLng = other.properties.lng;
    if (oLat === undefined || oLng === undefined || !Number.isFinite(oLat) || !Number.isFinite(oLng)) {
      continue;
    }

    const distKm = haversineKm(lat, lng, oLat, oLng);
    if (distKm < 800) continue;
    if (ctx.hasEdgeBetween(anchorNode.uuid, other.uuid, false)) continue;

    const otherSeries = ctx.getNodeSeries(other.uuid);
    if (!otherSeries || otherSeries.length < 5) continue;

    const siteKey = `${oLat.toFixed(1)}:${oLng.toFixed(1)}:${other.properties.dataset || "community"}`;
    const existing = dedupedCandidates.get(siteKey);
    if (!existing || (existing.node.label !== "Insight" && other.label === "Insight")) {
      dedupedCandidates.set(siteKey, { node: other, distKm, series: otherSeries });
    }
  }

  const rawScored: Array<{
    other: ETGNode;
    distKm: number;
    comp: ReturnType<typeof compareRegionalSeries>;
    effectiveR: number;
    rawP: number;
  }> = [];

  for (const cand of dedupedCandidates.values()) {
    const aligned = alignCompatibleSeries(series, cand.series);
    if (!aligned) continue;

    const comp = compareRegionalSeries(aligned.alignedA, aligned.alignedB, {
      latA: lat,
      lngA: lng,
      datasetA: dataset,
      latB: cand.node.properties.lat,
      lngB: cand.node.properties.lng,
      datasetB: cand.node.properties.dataset || "community",
    });

    const effectiveR =
      Math.abs(comp.detrendedR) >= Math.abs(comp.pearsonR) ? comp.detrendedR : comp.pearsonR;
    const rawP = comp.isSecularDriftOnly
      ? Math.min(comp.detrendedPValue, comp.optimalLagPValue)
      : Math.min(comp.pValue, comp.detrendedPValue, comp.optimalLagPValue);
    const significant = comp.pValue < 0.05 || comp.detrendedPValue < 0.05;
    if (significant && Math.abs(effectiveR) >= 0.45) {
      rawScored.push({ other: cand.node, distKm: cand.distKm, comp, effectiveR, rawP });
    }
  }

  const qValues = benjaminiHochbergAdjust(rawScored.map((s) => s.rawP));
  const scored = rawScored
    .map((item, idx) => ({ ...item, fdrQ: qValues[idx] ?? 1 }))
    .filter((item) => {
      if (!item.comp.isSecularDriftOnly) return rawScored.length <= 2 || item.fdrQ < 0.1;
      return rawScored.every((r) => r.comp.isSecularDriftOnly) && Math.abs(item.comp.pearsonR) >= 0.65;
    })
    .sort((a, b) => {
      const scoreA = itemCouplingPriority(a.comp, a.effectiveR);
      const scoreB = itemCouplingPriority(b.comp, b.effectiveR);
      return scoreB - scoreA;
    });
  const now = new Date().toISOString();

  for (const item of scored.slice(0, 4)) {
    const { other, distKm, comp } = item;
    const otherDataset = other.properties.dataset || "community";
    const otherSlope = other.properties.theil_sen_slope ?? comp.slopeB ?? 0;

    let edgeType: ETGRelationshipType = "correlates_with";
    if (
      (summary.theilSen.slope * otherSlope < 0 && comp.pearsonR <= -0.45) ||
      comp.detrendedR <= -0.5
    ) {
      edgeType = "drives_opposite";
    } else if (
      distKm >= 2500 &&
      (dataset === "ocean_temp" || otherDataset === "ocean_temp" || Math.abs(comp.optimalLagSteps) >= 1)
    ) {
      edgeType = "teleconnects";
    }

    const edgeId = `edge-auto-${edgeType}-${crypto.randomUUID().slice(0, 8)}`;
    const edge: ETGEdge = {
      source_uuid: anchorNode.uuid,
      target_uuid: other.uuid,
      type: edgeType,
      properties: {
        uuid: edgeId,
        is_provisional: false,
        correlation_r: comp.pearsonR,
        detrended_r: comp.detrendedR,
        optimal_lag_steps: comp.optimalLagSteps,
        lag_unit: comp.lagUnit,
        mechanism: comp.mechanism,
        amplification_ratio: comp.slopeRatio,
        shared_shift_year: comp.sharedRegimeShiftYear ?? undefined,
        source_snippet: `${edgeType} r=${comp.pearsonR.toFixed(2)} (detrended ${comp.detrendedR.toFixed(2)}, ${Math.round(distKm)} km)`,
        rationale: `Auto-discovered ${comp.couplingRegime} across ${Math.round(distKm)} km: ${updatedAnchor.properties.name} vs ${other.properties.name} (r=${comp.pearsonR.toFixed(2)}, detrended r=${comp.detrendedR.toFixed(2)}, lag=${comp.optimalLagSteps} ${comp.lagUnit}; ${comp.mechanism}).`,
        created_at: now,
      },
    };
    ctx.edges.set(edgeId, edge);
    discoveredEdges.push(edge);
  }

  return { discoveredEdges };
}

/**
 * Automatically wires local corroboration/proximity links and cross-region series connections for a node.
 */
export function autoConnectNodeOp(
  ctx: EtgStoreContext,
  nodeUuid: string,
  emit = false
): {
  linkedInsights: ETGNode[];
  linkedSignals: ETGNode[];
  corroborationAudits: CorroborationAudit[];
  discoveredConnections: ETGEdge[];
} {
  const node = ctx.nodes.get(nodeUuid);
  if (!node || node.properties.status === "Superseded") {
    return {
      linkedInsights: [],
      linkedSignals: [],
      corroborationAudits: [],
      discoveredConnections: [],
    };
  }

  const nearby = ctx.linkNearbyNodes(node, 450);
  const { discoveredEdges } = ctx.discoverConnectionsForSeriesNode(ctx.nodes.get(nodeUuid) ?? node);
  const totalAdded =
    nearby.linkedInsights.length + nearby.linkedSignals.length + discoveredEdges.length;

  if (totalAdded > 0) {
    if (emit) {
      const act = ctx.pushActivity({
        kind: "corroboration",
        nodeUuid,
        summary: `Auto-connected "${node.properties.name}": ${nearby.linkedInsights.length} trend link(s), ${nearby.linkedSignals.length} nearby event(s), ${discoveredEdges.length} global coupling(s).`,
      });
      ctx.emitUpdate(act);
    } else {
      ctx.persistState();
    }
  }

  return {
    linkedInsights: nearby.linkedInsights,
    linkedSignals: nearby.linkedSignals,
    corroborationAudits: nearby.corroborationAudits,
    discoveredConnections: discoveredEdges,
  };
}

/**
 * Hardware-Agnostic Node Webhook Ingestion & Live Event Updater.
 */
export function ingestHardwareWebhookOp(
  ctx: EtgStoreContext,
  nodeId: string,
  payload: Record<string, unknown>,
  queryParams: Record<string, string | undefined> = {}
): {
  hardwareNode: ETGNode;
  signalNode: ETGNode;
  linkedInsights: ETGNode[];
  linkedSignals: ETGNode[];
  corroborationAudits: CorroborationAudit[];
  discoveredConnections: ETGEdge[];
} {
  const cleanNodeId = typeof nodeId === "string" ? nodeId.trim() : "";
  if (!cleanNodeId || cleanNodeId.length > 160 || FORBIDDEN_PATH_SEGMENTS.has(cleanNodeId)) {
    throw new Error("Invalid webhook nodeId.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Webhook JSON object payload required.");
  }

  const assertWebhookText = (raw: unknown, label: string, maxLen: number): string | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") {
      throw new Error(`Invalid webhook ${label}: must be a string.`);
    }
    if (raw.length > maxLen) {
      throw new Error(`Webhook ${label} exceeds maximum length (${maxLen} chars).`);
    }
    const trimmed = raw.trim();
    if (
      trimmed &&
      /(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?|<script[\s>]|javascript:|drop\s+table|\b(?:wipe|destroy|corrupt)\s+(?:all\s+|the\s+)?(?:graph|nodes)\b)/i.test(
        trimmed
      )
    ) {
      throw new Error(`Blocked suspicious or prompt-injection payload in webhook ${label}.`);
    }
    return trimmed || undefined;
  };

  const existingTarget = ctx.nodes.get(cleanNodeId);
  const now = new Date().toISOString();

  const valuePath = queryParams.value_path;
  const rawValue =
    (valuePath ? extractValueByPath(payload, valuePath) : undefined) ??
    extractValueByPath(payload, "value") ??
    extractValueByPath(payload, "reading.value") ??
    extractValueByPath(payload, "metrics.pm25") ??
    extractValueByPath(payload, "data.value");

  if (rawValue !== undefined && rawValue !== null && rawValue !== "") {
    const candidateNum =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number(rawValue.trim())
          : NaN;
    if (!Number.isFinite(candidateNum)) {
      throw new Error("Invalid webhook reading value: must be a finite number.");
    }
  }

  const numericValue =
    typeof rawValue === "number" && Number.isFinite(rawValue)
      ? rawValue
      : typeof rawValue === "string" && rawValue.trim() !== "" && Number.isFinite(Number(rawValue))
        ? Number(rawValue)
        : undefined;

  const parseExplicitCoord = (raw: unknown, min: number, max: number, label: string): number | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "string" && raw.trim() === "") return undefined;
    const num =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw.trim())
          : NaN;
    if (!Number.isFinite(num) || num < min || num > max) {
      throw new Error(`Invalid webhook ${label}: must be a finite number within [${min}, ${max}].`);
    }
    return num;
  };

  const explicitLat = parseExplicitCoord(payload.lat ?? payload.latitude, -90, 90, "latitude");
  const explicitLng = parseExplicitCoord(payload.lng ?? payload.longitude, -180, 180, "longitude");
  const lat = explicitLat ?? existingTarget?.properties.lat;
  const lng = explicitLng ?? existingTarget?.properties.lng;
  const hasCoords =
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  if (payload.dataset !== undefined && payload.dataset !== null) {
    if (typeof payload.dataset !== "string" || !(payload.dataset in DATASET_BY_ID)) {
      throw new Error(`Invalid webhook dataset "${String(payload.dataset)}".`);
    }
  }

  const dataset = (
    typeof payload.dataset === "string"
      ? payload.dataset
      : existingTarget?.properties.dataset || "community"
  ) as ETGDatasetId;

  const checkedDeviceId = assertWebhookText(payload.device_id, "device_id", 160);
  if (checkedDeviceId && FORBIDDEN_PATH_SEGMENTS.has(checkedDeviceId)) {
    throw new Error("Invalid webhook device_id.");
  }
  const deviceId =
    checkedDeviceId ||
    existingTarget?.properties.device_id ||
    cleanNodeId;

  const producerType = (
    typeof payload.producer_type === "string"
      ? payload.producer_type
      : existingTarget?.properties.producer_type ||
        (cleanNodeId.includes("cam") ? "community_camera" : "iot_sensor")
  ) as ETGProducerType;

  const unit =
    assertWebhookText(payload.unit, "unit", 64) ||
    existingTarget?.properties.unit ||
    "units";

  if (payload.observed_at !== undefined && payload.observed_at !== null && typeof payload.observed_at !== "string") {
    throw new Error("Invalid webhook observed_at: must be an ISO/date string.");
  }
  const observedAt =
    typeof payload.observed_at === "string" &&
    payload.observed_at.length <= 64 &&
    !Number.isNaN(Date.parse(payload.observed_at))
      ? payload.observed_at
      : now;

  if (
    payload.confidence !== undefined &&
    payload.confidence !== null &&
    (typeof payload.confidence !== "number" ||
      !Number.isFinite(payload.confidence) ||
      payload.confidence < 0 ||
      payload.confidence > 1)
  ) {
    throw new Error("Invalid webhook confidence: must be a finite number in [0, 1].");
  }
  const confidence =
    typeof payload.confidence === "number" && payload.confidence >= 0 && payload.confidence <= 1
      ? payload.confidence
      : existingTarget?.properties.confidence ?? 0.88;

  const distinctSignal = payload.distinct_signal === true;
  const isUpdatingExistingSignal = existingTarget?.label === "Signal";
  const isTargetingInsight = existingTarget?.label === "Insight";

  const hardwareUuid = isUpdatingExistingSignal
    ? checkedDeviceId
      ? `sensor-${checkedDeviceId}`
      : `sensor-${cleanNodeId.slice(0, 12)}`
    : isTargetingInsight
      ? `sensor-${deviceId}`
      : cleanNodeId;

  const existingHardware = ctx.nodes.get(hardwareUuid);
  const hardwareName =
    assertWebhookText(payload.device_name, "device_name", 240) ||
    existingHardware?.properties.name ||
    `Community Node (${deviceId})`;

  let hardwareNode: ETGNode = {
    uuid: hardwareUuid,
    label: "Concept",
    is_provisional: false,
    properties: {
      ...(existingHardware?.properties ?? {}),
      name: hardwareName,
      concept_name: hardwareName,
      description:
        existingHardware?.properties.description ||
        `Hardware-agnostic Earth observation webhook endpoint (${producerType}).`,
      status: "Active",
      importance: existingHardware?.properties.importance ?? 7,
      lat: hasCoords ? lat : existingHardware?.properties.lat,
      lng: hasCoords ? lng : existingHardware?.properties.lng,
      dataset,
      producer_type: producerType,
      device_id: deviceId,
      value: numericValue ?? existingHardware?.properties.value,
      unit,
      observed_at: observedAt,
      created_at: existingHardware?.properties.created_at || now,
    },
  };

  const signalUuid = isUpdatingExistingSignal
    ? existingTarget.uuid
    : distinctSignal
      ? `signal-wh-${crypto.randomUUID().slice(0, 8)}`
      : isTargetingInsight
        ? `signal-wh-${deviceId}`
        : `signal-wh-${cleanNodeId}`;

  const existingSignal = ctx.nodes.get(signalUuid);
  const defaultSignalTitle = `${hardwareNode.properties.name} Reading${numericValue !== undefined ? ` (${numericValue} ${unit})` : ""}`;
  const titleFromPayload =
    assertWebhookText(payload.title, "title", 240) ||
    assertWebhookText(payload.summary, "summary", 240) ||
    (isUpdatingExistingSignal ? existingSignal?.properties.name : undefined) ||
    defaultSignalTitle;

  const descriptionFromPayload =
    assertWebhookText(payload.description, "description", 4000) ||
    existingSignal?.properties.description ||
    `Live webhook telemetry pushed from ${deviceId} (${producerType}).`;

  let signalNode: ETGNode = {
    uuid: signalUuid,
    label: "Signal",
    is_provisional: false,
    properties: {
      ...(existingSignal?.properties ?? {}),
      name: titleFromPayload,
      concept_name: titleFromPayload,
      description: descriptionFromPayload,
      status: "Active",
      importance: existingSignal?.properties.importance ?? 8,
      lat: hasCoords ? lat : existingSignal?.properties.lat ?? hardwareNode.properties.lat,
      lng: hasCoords ? lng : existingSignal?.properties.lng ?? hardwareNode.properties.lng,
      dataset,
      producer_type: producerType,
      device_id: deviceId,
      value: numericValue ?? existingSignal?.properties.value,
      unit,
      confidence,
      observed_at: observedAt,
      created_at: existingSignal?.properties.created_at || now,
    },
  };

  // Accumulate incoming series array + numeric point into rolling series for both nodes
  const incomingPoints: TimeSeriesPoint[] = [];
  if (Array.isArray(payload.series)) {
    for (const item of payload.series.slice(0, 2000)) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const val = typeof rec.value === "number" ? rec.value : Number(rec.value);
      if (!Number.isFinite(val)) continue;
      const dateStr = typeof rec.date === "string" ? rec.date : String(rec.date ?? "");
      const parsed = toTimeSeriesPoint(dateStr, val);
      if (parsed) {
        if (typeof rec.t === "number" && Number.isFinite(rec.t)) {
          parsed.t = rec.t;
        }
        incomingPoints.push(parsed);
      }
    }
  }
  if (numericValue !== undefined) {
    const point = toTimeSeriesPoint(observedAt, numericValue);
    if (point) incomingPoints.push(point);
  }

  if (incomingPoints.length > 0) {
    const priorSeries =
      ctx.getNodeSeries(signalNode.uuid) ?? ctx.getNodeSeries(hardwareNode.uuid) ?? [];
    const merged = mergeSeriesPoints(priorSeries, incomingPoints);
    signalNode = {
      ...signalNode,
      properties: ctx.offloadNodeSeries(signalNode.uuid, {
        ...signalNode.properties,
        series: merged,
      }),
    };
    hardwareNode = {
      ...hardwareNode,
      properties: ctx.offloadNodeSeries(hardwareNode.uuid, {
        ...hardwareNode.properties,
        series: merged,
      }),
    };
  } else {
    signalNode = {
      ...signalNode,
      properties: ctx.offloadNodeSeries(signalNode.uuid, signalNode.properties),
    };
    hardwareNode = {
      ...hardwareNode,
      properties: ctx.offloadNodeSeries(hardwareNode.uuid, hardwareNode.properties),
    };
  }

  ctx.nodes.set(hardwareNode.uuid, hardwareNode);
  ctx.nodes.set(signalNode.uuid, signalNode);

  const monitorTypes = new Set<ETGRelationshipType>(["monitors"]);
  if (!ctx.hasEdgeBetween(hardwareNode.uuid, signalNode.uuid, true, monitorTypes)) {
    const monitorEdgeId = `edge-mon-${crypto.randomUUID().slice(0, 8)}`;
    ctx.edges.set(monitorEdgeId, {
      source_uuid: hardwareNode.uuid,
      target_uuid: signalNode.uuid,
      type: "monitors",
      properties: {
        uuid: monitorEdgeId,
        is_provisional: false,
        source_snippet: `Webhook reading from ${deviceId}`,
        created_at: now,
      },
    });
  }

  const { linkedInsights, linkedSignals, corroborationAudits } = ctx.linkNearbyNodes(signalNode, 450);
  const { discoveredEdges: discoveredConnections } = ctx.discoverConnectionsForSeriesNode(
    ctx.nodes.get(signalNode.uuid) ?? signalNode
  );

  const refreshedSignal = ctx.nodes.get(signalNode.uuid) ?? signalNode;
  if (refreshedSignal.properties.theil_sen_slope !== undefined) {
    const refreshedHw = ctx.nodes.get(hardwareNode.uuid) ?? hardwareNode;
    hardwareNode = {
      ...refreshedHw,
      properties: {
        ...refreshedHw.properties,
        p_value: refreshedSignal.properties.p_value,
        p_value_adjusted: refreshedSignal.properties.p_value_adjusted,
        theil_sen_slope: refreshedSignal.properties.theil_sen_slope,
        slope_unit: refreshedSignal.properties.slope_unit,
        ols_r2: refreshedSignal.properties.ols_r2,
        regime_shift_year: refreshedSignal.properties.regime_shift_year,
      },
    };
    ctx.nodes.set(hardwareNode.uuid, hardwareNode);
  }

  const act = ctx.pushActivity({
    kind: "webhook",
    nodeUuid: refreshedSignal.uuid,
    summary: `Webhook [${deviceId}] ingested "${refreshedSignal.properties.name}" (${linkedInsights.length} trend link${linkedInsights.length === 1 ? "" : "s"}, ${linkedSignals.length} nearby event${linkedSignals.length === 1 ? "" : "s"}, ${discoveredConnections.length} global link${discoveredConnections.length === 1 ? "" : "s"})`,
  });
  ctx.emitUpdate(act);

  return {
    hardwareNode,
    signalNode: refreshedSignal,
    linkedInsights,
    linkedSignals,
    corroborationAudits,
    discoveredConnections,
  };
}

export function ingestEonetSignalsOp(
  ctx: EtgStoreContext,
  signals: ETGNode[]
): { added: number; updated: number; linkedEdges: number } {
  let added = 0;
  let updated = 0;
  let linkedEdges = 0;
  const now = new Date().toISOString();

  if (!ctx.nodes.has("source-nasa-eonet")) {
    ctx.nodes.set("source-nasa-eonet", {
      uuid: "source-nasa-eonet",
      label: "Concept",
      is_provisional: false,
      properties: {
        name: "NASA EONET v3 Event Feed",
        concept_name: "NASA EONET v3 Event Feed",
        description:
          "Earth Observatory Natural Event Tracker streaming active wildfires, ice anomalies, storms, and dust events.",
        status: "Active",
        importance: 9,
        dataset: "nasa_power",
        producer_type: "nasa_satellite",
        created_at: now,
      },
    });
  }

  for (const sig of signals) {
    const existed = ctx.nodes.has(sig.uuid);
    const preparedSig: ETGNode = {
      ...sig,
      properties: ctx.offloadNodeSeries(sig.uuid, sig.properties),
    };
    ctx.nodes.set(preparedSig.uuid, preparedSig);
    if (existed) updated += 1;
    else added += 1;

    const monitorId = `edge-eonet-${preparedSig.uuid}`;
    if (!ctx.edges.has(monitorId)) {
      ctx.edges.set(monitorId, {
        source_uuid: "source-nasa-eonet",
        target_uuid: preparedSig.uuid,
        type: "monitors",
        properties: {
          uuid: monitorId,
          is_provisional: false,
          source_snippet: "NASA EONET v3 telemetry",
          created_at: now,
        },
      });
    }

    const nearby = ctx.linkNearbyNodes(preparedSig, 450);
    linkedEdges += nearby.linkedInsights.length + nearby.linkedSignals.length;
  }

  const act = ctx.pushActivity({
    kind: "eonet",
    summary: `Synced ${signals.length} NASA EONET orbital events (${added} new, ${updated} updated, ${linkedEdges} local links).`,
  });
  ctx.emitUpdate(act);

  return { added, updated, linkedEdges };
}
