import { DATASET_BY_ID } from "@/lib/datasets";
import type { EtgStore } from "@/lib/graph/etgStore";
import { fetchEarthTimeSeries } from "@/lib/nasa/nasaPowerClient";
import type {
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGNodeLabel,
  ETGRelationshipType,
  TimeSeriesPoint,
} from "@/types/etg";

export type GraphGuardRule =
  | "NO_MASS_DESTRUCTION"
  | "NO_OFFTOPIC_OR_INJECTION"
  | "GEO_AND_STRUCT_VALIDITY"
  | "EMPIRICAL_EDGE_VERIFICATION"
  | "PROTECTED_AGENCY_BASELINE"
  | "ALLOWED_HELPFUL_MUTATION";

export type ProposedGraphAction =
  | {
      type: "connect_nodes";
      sourceUuid: string;
      targetUuid: string;
      edgeType: ETGRelationshipType;
      rationale: string;
      mechanism?: string;
      customLabel?: string;
      optimalLagSteps?: number;
      ignoreEdgeUuid?: string;
    }
  | {
      type: "create_insight";
      name: string;
      description: string;
      region?: string;
      lat?: number;
      lng?: number;
      relatedNodeUuids?: string[];
      rationale?: string;
    }
  | {
      type: "create_node";
      label: ETGNodeLabel;
      name: string;
      description: string;
      region?: string;
      lat?: number;
      lng?: number;
      dataset?: ETGDatasetId;
      relatedNodeUuids?: string[];
      rationale?: string;
    }
  | {
      type: "ingest_live_signal";
      name?: string;
      region?: string;
      lat: number;
      lng: number;
      dataset: ETGDatasetId;
      rationale?: string;
      connectToUuid?: string;
      edgeType?: ETGRelationshipType;
    }
  | {
      type: "update_node";
      uuid: string;
      name?: string;
      description?: string;
      region?: string;
      rationale: string;
    }
  | {
      type: "revise_belief";
      priorNodeUuid: string;
      newName: string;
      newDescription: string;
      rationale: string;
    }
  | {
      type: "discover_missing_links";
      anchorUuid?: string;
      limit?: number;
    }
  | {
      type: "delete_node";
      uuid: string;
      rationale?: string;
    }
  | {
      type: "delete_edge";
      uuid: string;
      rationale?: string;
    }
  | {
      type: "clear_graph";
      rationale?: string;
    };

export interface GraphGuardVerdict {
  allowed: boolean;
  rule: GraphGuardRule;
  reason: string;
  pearsonR?: number;
}

export interface AppliedGraphActionResult {
  action: ProposedGraphAction;
  verdict: GraphGuardVerdict;
  createdNodeUuid?: string;
  createdEdgeUuid?: string;
  summary: string;
}

const VALID_ETG_LABELS = new Set<ETGNodeLabel>(["Concept", "Signal", "Insight", "Rule"]);

export const MAX_NODE_NAME_LEN = 240;
export const MAX_REGION_LEN = 200;
export const MAX_DESCRIPTION_LEN = 4000;
export const MAX_RATIONALE_LEN = 2000;
export const MAX_UUID_LEN = 200;
export const MAX_BATCH_ACTIONS = 25;

const FORBIDDEN_UUID_TOKENS = new Set(["__proto__", "prototype", "constructor"]);

const VALID_ETG_EDGE_TYPES = new Set<ETGRelationshipType>([
  "supports",
  "corroborates",
  "drives_opposite",
  "correlates_with",
  "teleconnects",
  "verified_by",
  "supersedes",
  "monitors",
  "relates_to",
  "leads",
  "amplifies",
  "dampens",
  "advects_to",
  "triggers",
  "impacts",
  "hypothesized_link",
]);

const EDGE_TYPE_SYNONYMS: Record<string, ETGRelationshipType> = {
  causes: "triggers",
  contextualizes: "relates_to",
  links_to: "relates_to",
  contradicts: "drives_opposite",
};

function normalizeEdgeType(raw: unknown): ETGRelationshipType | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return EDGE_TYPE_SYNONYMS[key] ?? (key as ETGRelationshipType);
}

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?)/i,
  /\b(override|bypass)\s+(the\s+)?(system\s+prompt|integrity\s+guard|safety\s+rules?)\b/i,
  /system\s+prompt/i,
  /drop\s+table/i,
  /<script[\s>]/i,
  /javascript:/i,
  /<\|(?:im_start|im_end|system|endoftext)\|>/i,
  /\b(hack|vandalize|corrupt|destroy|wipe|nuke|erase|purge)\s+(the\s+|all\s+)?(graph|nodes|edges|database|everything)\b/i,
  /\bdelete\s+all\s+(nodes|edges|data|graph)\b/i,
  /\breset\s+(the\s+)?(entire\s+)?graph\b/i,
];

const AGENCY_SYSTEM_MARKERS = [
  "nasa",
  "noaa",
  "usgs",
  "copernicus",
  "nsidc",
  "knmi",
  "csa",
  "gistemp",
  "eonet",
  "merra-2",
];

export function containsInjectionOrSpam(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  // Cap regex scan slice to avoid ReDoS on huge hostile payloads
  const bounded = text.length > 16_384 ? text.slice(0, 16_384) : text;
  return INJECTION_PATTERNS.some((re) => re.test(bounded));
}

function exceedsLength(text: unknown, maxLen: number): boolean {
  return typeof text === "string" && text.length > maxLen;
}

function isSafeStringId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_UUID_LEN &&
    !FORBIDDEN_UUID_TOKENS.has(value.trim())
  );
}

function wouldCreateSupersedesCycle(
  store: Pick<EtgStore, "getSnapshot">,
  sourceUuid: string,
  targetUuid: string,
  ignoreEdgeUuid?: string
): boolean {
  if (sourceUuid === targetUuid) return true;
  const edges = store.getSnapshot().edges;
  const visited = new Set<string>([targetUuid]);
  const queue: string[] = [targetUuid];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const edge of edges) {
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

function isProtectedAgencyNode(node: ETGNode): boolean {
  if (node.properties.corroborated === true) return true;
  const sys = `${node.properties.source_system ?? ""} ${node.properties.provenance_source ?? ""}`.toLowerCase();
  return AGENCY_SYSTEM_MARKERS.some((m) => sys.includes(m));
}

function isCoordOnlyRegion(region: string | undefined): boolean {
  const trimmed = region?.trim();
  if (!trimmed) return true;
  return /^-?\d+(?:\.\d+)?°,\s*-?\d+(?:\.\d+)?°$/.test(trimmed);
}

function validateOptionalCoords(
  lat: unknown,
  lng: unknown
): GraphGuardVerdict | null {
  if (lat !== undefined && (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90)) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: `Invalid latitude ${String(lat)}; must be a finite number within [-90, 90].`,
    };
  }
  if (lng !== undefined && (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180)) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: `Invalid longitude ${String(lng)}; must be a finite number within [-180, 180].`,
    };
  }
  return null;
}

function computeAlignedPearsonR(
  a: TimeSeriesPoint[] | undefined,
  b: TimeSeriesPoint[] | undefined
): number | undefined {
  if (!a || !b || a.length < 8 || b.length < 8) return undefined;
  const bMap = new Map<string, number>();
  for (const pt of b) {
    if (Number.isFinite(pt.value)) bMap.set(pt.date, pt.value);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pt of a) {
    if (!Number.isFinite(pt.value)) continue;
    const y = bMap.get(pt.date);
    if (y !== undefined) {
      xs.push(pt.value);
      ys.push(y);
    }
  }
  if (xs.length < 8) return undefined;
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const denom = Math.sqrt(denX * denY);
  if (denom < 1e-12) return undefined;
  return Number((num / denom).toFixed(4));
}

export function resolveNodeRef(
  store: Pick<EtgStore, "getNode" | "getSnapshot">,
  ref: unknown,
  batchCreatedIds: readonly string[] = []
): string {
  if (typeof ref !== "string") return "";
  const trimmed = ref.trim();
  if (!trimmed || trimmed.length > MAX_UUID_LEN) return "";
  const idxMatch = trimmed.match(/^\$(\d+)$/);
  if (idxMatch) {
    const idx = Number(idxMatch[1]);
    return batchCreatedIds[idx] ?? trimmed;
  }
  if (trimmed === "$LAST" && batchCreatedIds.length > 0) {
    return batchCreatedIds[batchCreatedIds.length - 1];
  }
  if (store.getNode(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  const matches = store
    .getSnapshot()
    .nodes.filter((n) => n.properties.name.trim().toLowerCase() === lower);
  return matches.length === 1 ? matches[0].uuid : trimmed;
}

function resolveBatchActionRefs(
  store: Pick<EtgStore, "getNode" | "getSnapshot">,
  rawAction: ProposedGraphAction,
  batchCreatedIds: readonly string[]
): ProposedGraphAction {
  if (!rawAction || typeof rawAction !== "object") {
    return rawAction;
  }
  const action = rawAction;
  if (action.type === "connect_nodes") {
    return {
      ...action,
      sourceUuid: resolveNodeRef(store, action.sourceUuid, batchCreatedIds),
      targetUuid: resolveNodeRef(store, action.targetUuid, batchCreatedIds),
      edgeType: normalizeEdgeType(action.edgeType) ?? action.edgeType,
    };
  }
  if (action.type === "create_insight" || action.type === "create_node") {
    return {
      ...action,
      relatedNodeUuids: Array.isArray(action.relatedNodeUuids)
        ? action.relatedNodeUuids
            .filter((ref): ref is string => typeof ref === "string")
            .map((ref) => resolveNodeRef(store, ref, batchCreatedIds))
        : undefined,
    };
  }
  if (action.type === "ingest_live_signal") {
    return {
      ...action,
      ...(typeof action.connectToUuid === "string" && action.connectToUuid.trim()
        ? { connectToUuid: resolveNodeRef(store, action.connectToUuid, batchCreatedIds) }
        : {}),
      ...(action.edgeType !== undefined
        ? { edgeType: normalizeEdgeType(action.edgeType) ?? action.edgeType }
        : {}),
    };
  }
  if (action.type === "update_node" || action.type === "delete_node") {
    return { ...action, uuid: resolveNodeRef(store, action.uuid, batchCreatedIds) };
  }
  if (action.type === "revise_belief") {
    return {
      ...action,
      priorNodeUuid: resolveNodeRef(store, action.priorNodeUuid, batchCreatedIds),
    };
  }
  if (action.type === "discover_missing_links" && typeof action.anchorUuid === "string" && action.anchorUuid.trim()) {
    return {
      ...action,
      anchorUuid: resolveNodeRef(store, action.anchorUuid, batchCreatedIds),
    };
  }
  return action;
}

export function validateGraphAction(
  store: Pick<EtgStore, "getNode" | "getNodeSeries" | "getSnapshot">,
  action: ProposedGraphAction,
  options?: { allowProtectedDelete?: boolean }
): GraphGuardVerdict {
  if (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: "Invalid graph action object: missing string action.type.",
    };
  }

  if (action.type === "clear_graph") {
    return {
      allowed: false,
      rule: "NO_MASS_DESTRUCTION",
      reason: "Mass-clearing the Earth Trend Graph via AI or unverified requests is blocked to prevent vandalism.",
    };
  }

  if (action.type === "delete_node") {
    if (!isSafeStringId(action.uuid)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Invalid or unsafe node uuid for delete_node.",
      };
    }
    if (exceedsLength(action.rationale, MAX_RATIONALE_LEN)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Deletion rationale exceeds maximum length (${MAX_RATIONALE_LEN} chars).`,
      };
    }
    if (containsInjectionOrSpam(action.rationale)) {
      return {
        allowed: false,
        rule: "NO_OFFTOPIC_OR_INJECTION",
        reason: "Blocked suspicious or non-scientific deletion rationale.",
      };
    }
    const node = store.getNode(action.uuid);
    if (!node) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Node ${action.uuid} does not exist.`,
      };
    }
    if (!options?.allowProtectedDelete && isProtectedAgencyNode(node)) {
      return {
        allowed: false,
        rule: "PROTECTED_AGENCY_BASELINE",
        reason: `Protected corroborated/agency node "${node.properties.name}" cannot be deleted. Use epistemic belief revision (supersedes) instead.`,
      };
    }
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: `Allowed removal of uncorroborated/provisional node "${node.properties.name}".`,
    };
  }

  if (action.type === "delete_edge") {
    if (!isSafeStringId(action.uuid)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Invalid or unsafe edge uuid for delete_edge.",
      };
    }
    if (exceedsLength(action.rationale, MAX_RATIONALE_LEN)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Edge deletion rationale exceeds maximum length (${MAX_RATIONALE_LEN} chars).`,
      };
    }
    if (containsInjectionOrSpam(action.rationale)) {
      return {
        allowed: false,
        rule: "NO_OFFTOPIC_OR_INJECTION",
        reason: "Blocked suspicious or non-scientific edge deletion rationale.",
      };
    }
    const snap = store.getSnapshot();
    const edge = snap.edges.find((e) => e.properties.uuid === action.uuid);
    if (!edge) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Edge ${action.uuid} does not exist.`,
      };
    }
    if (!options?.allowProtectedDelete && (edge.type === "drives_opposite" || edge.type === "corroborates")) {
      const src = store.getNode(edge.source_uuid);
      const tgt = store.getNode(edge.target_uuid);
      if (src && tgt && isProtectedAgencyNode(src) && isProtectedAgencyNode(tgt)) {
        return {
          allowed: false,
          rule: "PROTECTED_AGENCY_BASELINE",
          reason: `Protected ${edge.type} edge between corroborated agency nodes cannot be severed arbitrarily.`,
        };
      }
    }
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: `Allowed removal of edge ${edge.properties.uuid}.`,
    };
  }

  if (action.type === "create_insight") {
    if (typeof action.name !== "string" || typeof action.description !== "string") {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Insight name and description must be strings.",
      };
    }
    const name = action.name.trim();
    const desc = action.description.trim();
    if (
      exceedsLength(name, MAX_NODE_NAME_LEN) ||
      exceedsLength(desc, MAX_DESCRIPTION_LEN) ||
      exceedsLength(action.region, MAX_REGION_LEN) ||
      exceedsLength(action.rationale, MAX_RATIONALE_LEN)
    ) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Insight field exceeds maximum length (name <= ${MAX_NODE_NAME_LEN}, description <= ${MAX_DESCRIPTION_LEN}).`,
      };
    }
    if (
      containsInjectionOrSpam(name) ||
      containsInjectionOrSpam(desc) ||
      containsInjectionOrSpam(action.region) ||
      containsInjectionOrSpam(action.rationale)
    ) {
      return {
        allowed: false,
        rule: "NO_OFFTOPIC_OR_INJECTION",
        reason: "Blocked prompt-injection or non-scientific payload in Insight creation.",
      };
    }
    if (name.length < 4 || desc.length < 12) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Insight name (>= 4 chars) and scientific description (>= 12 chars) are required.",
      };
    }
    const coordErr = validateOptionalCoords(action.lat, action.lng);
    if (coordErr) return coordErr;
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: `Verified scientific Insight "${name}".`,
    };
  }

  if (action.type === "create_node") {
    if (typeof action.name !== "string" || typeof action.description !== "string") {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Node name and description must be strings.",
      };
    }
    const name = action.name.trim();
    const desc = action.description.trim();
    if (
      exceedsLength(name, MAX_NODE_NAME_LEN) ||
      exceedsLength(desc, MAX_DESCRIPTION_LEN) ||
      exceedsLength(action.region, MAX_REGION_LEN) ||
      exceedsLength(action.rationale, MAX_RATIONALE_LEN)
    ) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Node field exceeds maximum length (name <= ${MAX_NODE_NAME_LEN}, description <= ${MAX_DESCRIPTION_LEN}).`,
      };
    }
    if (
      containsInjectionOrSpam(name) ||
      containsInjectionOrSpam(desc) ||
      containsInjectionOrSpam(action.region) ||
      containsInjectionOrSpam(action.rationale)
    ) {
      return {
        allowed: false,
        rule: "NO_OFFTOPIC_OR_INJECTION",
        reason: "Blocked prompt-injection or non-scientific payload in node creation.",
      };
    }
    if (!VALID_ETG_LABELS.has(action.label)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Invalid ETG node label "${String(action.label)}"; must be Concept, Signal, Insight, or Rule.`,
      };
    }
    if (name.length < 3 || desc.length < 10) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Node name (>= 3 chars) and scientific description (>= 10 chars) are required.",
      };
    }
    if (action.dataset && !(action.dataset in DATASET_BY_ID)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Unknown dataset "${String(action.dataset)}".`,
      };
    }
    const coordErr = validateOptionalCoords(action.lat, action.lng);
    if (coordErr) return coordErr;
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: `Verified ${action.label} node "${name}".`,
    };
  }

  if (action.type === "ingest_live_signal") {
    if (
      exceedsLength(action.name, MAX_NODE_NAME_LEN) ||
      exceedsLength(action.region, MAX_REGION_LEN) ||
      exceedsLength(action.rationale, MAX_RATIONALE_LEN)
    ) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Signal ingestion text field exceeds maximum allowed length.",
      };
    }
    if (
      containsInjectionOrSpam(action.name) ||
      containsInjectionOrSpam(action.region) ||
      containsInjectionOrSpam(action.rationale)
    ) {
      return {
        allowed: false,
        rule: "NO_OFFTOPIC_OR_INJECTION",
        reason: "Blocked prompt-injection or non-scientific payload in signal ingestion.",
      };
    }
    if (
      typeof action.lat !== "number" ||
      !Number.isFinite(action.lat) ||
      action.lat < -90 ||
      action.lat > 90 ||
      typeof action.lng !== "number" ||
      !Number.isFinite(action.lng) ||
      action.lng < -180 ||
      action.lng > 180
    ) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Invalid coordinates (${String(action.lat)}, ${String(action.lng)}); lat must be [-90, 90] and lng [-180, 180].`,
      };
    }
    if (typeof action.dataset !== "string" || !(action.dataset in DATASET_BY_ID)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Unknown dataset "${String(action.dataset)}" for live signal ingestion.`,
      };
    }
    if (action.edgeType !== undefined && !VALID_ETG_EDGE_TYPES.has(action.edgeType)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Unknown edgeType "${String(action.edgeType)}" for live signal connection.`,
      };
    }
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: `Approved live ${action.dataset} signal probe at (${action.lat.toFixed(2)}°, ${action.lng.toFixed(2)}°).`,
    };
  }

  if (action.type === "update_node") {
    if (!isSafeStringId(action.uuid)) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Invalid or unsafe node uuid for update_node.",
      };
    }
    if (
      exceedsLength(action.name, MAX_NODE_NAME_LEN) ||
      exceedsLength(action.description, MAX_DESCRIPTION_LEN) ||
      exceedsLength(action.region, MAX_REGION_LEN) ||
      exceedsLength(action.rationale, MAX_RATIONALE_LEN)
    ) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "Node update field exceeds maximum allowed length.",
      };
    }
    if (
      containsInjectionOrSpam(action.name) ||
      containsInjectionOrSpam(action.description) ||
      containsInjectionOrSpam(action.region) ||
      containsInjectionOrSpam(action.rationale)
    ) {
      return {
        allowed: false,
        rule: "NO_OFFTOPIC_OR_INJECTION",
        reason: "Blocked prompt-injection or non-scientific payload in node update.",
      };
    }
    if (typeof action.rationale !== "string" || action.rationale.trim().length < 6) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "A scientific rationale (>= 6 chars) is required to update a node.",
      };
    }
    const node = store.getNode(action.uuid);
    if (!node) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Node ${action.uuid} does not exist.`,
      };
    }
    if (
      isProtectedAgencyNode(node) &&
      (action.name !== undefined || action.description !== undefined)
    ) {
      return {
        allowed: false,
        rule: "PROTECTED_AGENCY_BASELINE",
        reason: `Protected corroborated/agency node "${node.properties.name}" cannot be overwritten in place; use revise_belief (supersedes) to record updated scientific conclusions.`,
      };
    }
    if (
      isProtectedAgencyNode(node) &&
      action.region !== undefined &&
      !isCoordOnlyRegion(node.properties.region)
    ) {
      return {
        allowed: false,
        rule: "PROTECTED_AGENCY_BASELINE",
        reason: `Protected agency node "${node.properties.name}" already has a named region ("${node.properties.region}").`,
      };
    }
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: `Approved safe metadata update on "${node.properties.name}".`,
    };
  }

  if (action.type === "revise_belief") {
    if (
      !isSafeStringId(action.priorNodeUuid) ||
      typeof action.newName !== "string" ||
      typeof action.newDescription !== "string" ||
      typeof action.rationale !== "string"
    ) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "revise_belief requires valid string priorNodeUuid, newName, newDescription, and rationale.",
      };
    }
    const newName = action.newName.trim();
    const newDesc = action.newDescription.trim();
    const rationale = action.rationale.trim();
    if (
      exceedsLength(newName, MAX_NODE_NAME_LEN) ||
      exceedsLength(newDesc, MAX_DESCRIPTION_LEN) ||
      exceedsLength(rationale, MAX_RATIONALE_LEN)
    ) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `revise_belief field exceeds maximum length (newName <= ${MAX_NODE_NAME_LEN}, newDescription <= ${MAX_DESCRIPTION_LEN}, rationale <= ${MAX_RATIONALE_LEN}).`,
      };
    }
    if (
      containsInjectionOrSpam(newName) ||
      containsInjectionOrSpam(newDesc) ||
      containsInjectionOrSpam(rationale)
    ) {
      return {
        allowed: false,
        rule: "NO_OFFTOPIC_OR_INJECTION",
        reason: "Blocked prompt-injection or non-scientific payload in belief revision.",
      };
    }
    if (newName.length < 4 || newDesc.length < 12 || rationale.length < 8) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: "revise_belief requires newName (>= 4 chars), newDescription (>= 12 chars), and rationale (>= 8 chars).",
      };
    }
    const prior = store.getNode(action.priorNodeUuid);
    if (!prior) {
      return {
        allowed: false,
        rule: "GEO_AND_STRUCT_VALIDITY",
        reason: `Prior node ${action.priorNodeUuid} does not exist.`,
      };
    }
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: `Approved epistemic supersedes revision of "${prior.properties.name}".`,
    };
  }

  if (action.type === "discover_missing_links") {
    if (action.anchorUuid !== undefined) {
      if (!isSafeStringId(action.anchorUuid) || !store.getNode(action.anchorUuid)) {
        return {
          allowed: false,
          rule: "GEO_AND_STRUCT_VALIDITY",
          reason: `Anchor node ${String(action.anchorUuid)} does not exist.`,
        };
      }
    }
    return {
      allowed: true,
      rule: "ALLOWED_HELPFUL_MUTATION",
      reason: "Approved empirical candidate-link discovery scan.",
    };
  }

  if (action.type !== "connect_nodes") {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: `Unsupported graph action type "${String((action as { type?: unknown }).type)}".`,
    };
  }

  // connect_nodes
  if (!isSafeStringId(action.sourceUuid) || !isSafeStringId(action.targetUuid)) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: "Invalid or unsafe sourceUuid/targetUuid for edge connection.",
    };
  }
  if (!VALID_ETG_EDGE_TYPES.has(action.edgeType)) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: `Unknown ETG relationship type "${String(action.edgeType)}".`,
    };
  }
  if (
    exceedsLength(action.rationale, MAX_RATIONALE_LEN) ||
    exceedsLength(action.mechanism, MAX_DESCRIPTION_LEN) ||
    exceedsLength(action.customLabel, MAX_NODE_NAME_LEN)
  ) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: "Edge rationale, mechanism, or customLabel exceeds maximum allowed length.",
    };
  }
  if (
    containsInjectionOrSpam(action.rationale) ||
    containsInjectionOrSpam(action.mechanism) ||
    containsInjectionOrSpam(action.customLabel)
  ) {
    return {
      allowed: false,
      rule: "NO_OFFTOPIC_OR_INJECTION",
      reason: "Blocked prompt-injection or non-scientific rationale in edge creation.",
    };
  }
  if (typeof action.rationale !== "string" || action.rationale.trim().length < 8) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: "A scientific rationale (>= 8 chars) is required to wire a graph connection.",
    };
  }
  if (action.sourceUuid === action.targetUuid) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: "Self-loop connections (source === target) are disallowed.",
    };
  }
  const src = store.getNode(action.sourceUuid);
  const tgt = store.getNode(action.targetUuid);
  if (!src || !tgt) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: `Both source (${action.sourceUuid}) and target (${action.targetUuid}) nodes must exist.`,
    };
  }

  const snap = store.getSnapshot();
  const duplicate = snap.edges.some(
    (e) =>
      e.properties.uuid !== action.ignoreEdgeUuid &&
      e.source_uuid === action.sourceUuid &&
      e.target_uuid === action.targetUuid &&
      e.type === action.edgeType
  );
  if (duplicate) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: `Edge ${action.sourceUuid} -[${action.edgeType}]-> ${action.targetUuid} already exists.`,
    };
  }

  if (
    action.edgeType === "supersedes" &&
    wouldCreateSupersedesCycle(store, action.sourceUuid, action.targetUuid, action.ignoreEdgeUuid)
  ) {
    return {
      allowed: false,
      rule: "GEO_AND_STRUCT_VALIDITY",
      reason: `Supersedes cycle blocked: linking ${action.sourceUuid} -[supersedes]-> ${action.targetUuid} would create a cyclic belief-revision loop.`,
    };
  }

  const srcSeries = src.properties.series ?? store.getNodeSeries(src.uuid);
  const tgtSeries = tgt.properties.series ?? store.getNodeSeries(tgt.uuid);
  const pearsonR = computeAlignedPearsonR(srcSeries, tgtSeries);

  if (action.edgeType === "drives_opposite" && pearsonR !== undefined) {
    if (pearsonR > 0.35) {
      return {
        allowed: false,
        rule: "EMPIRICAL_EDGE_VERIFICATION",
        pearsonR,
        reason: `Blocked drives_opposite edge: series are strongly co-trending (r = +${pearsonR.toFixed(2)}), not opposite.`,
      };
    }
    const hasLagEvidence =
      (action.optimalLagSteps !== undefined && action.optimalLagSteps >= 1) ||
      /lag|teleconnect/i.test(action.rationale);
    if (Math.abs(pearsonR) < 0.12 && !hasLagEvidence) {
      return {
        allowed: false,
        rule: "EMPIRICAL_EDGE_VERIFICATION",
        pearsonR,
        reason: `Blocked drives_opposite edge: series show negligible correlation (r = ${pearsonR.toFixed(2)}) with no lagged teleconnection evidence.`,
      };
    }
  }

  if (action.edgeType === "corroborates") {
    const srcTrust = src.properties.trust_score ?? src.properties.confidence ?? 0.7;
    if (!src.properties.corroborated && srcTrust < 0.3 && isProtectedAgencyNode(tgt)) {
      return {
        allowed: false,
        rule: "EMPIRICAL_EDGE_VERIFICATION",
        pearsonR,
        reason: `Blocked low-trust uncorroborated source (${src.properties.name}, trust=${srcTrust.toFixed(2)}) from corroborating agency node "${tgt.properties.name}".`,
      };
    }
    if (pearsonR !== undefined && pearsonR < -0.35) {
      return {
        allowed: false,
        rule: "EMPIRICAL_EDGE_VERIFICATION",
        pearsonR,
        reason: `Blocked corroborates edge: series are strongly opposed (r = ${pearsonR.toFixed(2)}).`,
      };
    }
  }

  return {
    allowed: true,
    rule: "ALLOWED_HELPFUL_MUTATION",
    pearsonR,
    reason:
      pearsonR !== undefined
        ? `Verified ${action.edgeType} connection (aligned r = ${pearsonR.toFixed(2)}).`
        : `Verified ${action.edgeType} structural connection.`,
  };
}

function applySyncValidatedAction(
  store: EtgStore,
  action: ProposedGraphAction,
  verdict: GraphGuardVerdict,
  batchCreatedIds: string[],
  applied: AppliedGraphActionResult[],
  blocked: AppliedGraphActionResult[]
): void {
  if (action.type === "connect_nodes") {
    const edge: ETGEdge = store.createEdge({
      source_uuid: action.sourceUuid,
      target_uuid: action.targetUuid,
      type: action.edgeType,
      rationale: action.rationale.trim(),
      mechanism: action.mechanism?.trim(),
      optimal_lag_steps: action.optimalLagSteps,
      correlation_r: verdict.pearsonR,
      authored_by: "ai",
      source_snippet: "AI Detective + Graph Integrity Guard",
    });
    applied.push({
      action,
      verdict,
      createdEdgeUuid: edge.properties.uuid,
      summary: `Connected ${action.sourceUuid} -[${action.edgeType}]-> ${action.targetUuid}`,
    });
    return;
  }

  if (action.type === "create_insight" || action.type === "create_node") {
    const label: ETGNodeLabel = action.type === "create_insight" ? "Insight" : action.label;
    const node = store.createNode({
      label,
      is_provisional: label === "Signal",
      properties: {
        name: action.name.trim(),
        description: action.description.trim(),
        region: action.region?.trim() || "Global / Regional Synthesis",
        lat: action.lat,
        lng: action.lng,
        dataset: action.type === "create_node" ? action.dataset : undefined,
        confidence: label === "Signal" ? 0.72 : 0.85,
        corroborated: false,
        authored_by: "ai",
        source_system: "AI Graph Studio",
        created_at: new Date().toISOString(),
      },
    });
    batchCreatedIds.push(node.uuid);
    for (const relUuid of (action.relatedNodeUuids ?? []).slice(0, 4)) {
      if (relUuid !== node.uuid && store.getNode(relUuid)) {
        store.createEdge({
          source_uuid: relUuid,
          target_uuid: node.uuid,
          type: label === "Insight" ? "supports" : "relates_to",
          rationale:
            action.rationale?.trim() ||
            `Supporting evidence linked to AI-authored ${label} node.`,
          authored_by: "ai",
        });
      }
    }
    applied.push({
      action,
      verdict,
      createdNodeUuid: node.uuid,
      summary: `Created ${label} "${node.properties.name}" [${node.uuid}]`,
    });
    return;
  }

  if (action.type === "update_node") {
    const updated = store.updateNode(action.uuid, {
      ...(action.name !== undefined ? { name: action.name } : {}),
      ...(action.description !== undefined ? { description: action.description } : {}),
      ...(action.region !== undefined ? { region: action.region } : {}),
    });
    if (updated) {
      applied.push({
        action,
        verdict,
        createdNodeUuid: updated.uuid,
        summary: `Updated "${updated.properties.name}" [${updated.uuid}]`,
      });
    }
    return;
  }

  if (action.type === "revise_belief") {
    const rev = store.reviseBelief({
      priorNodeUuid: action.priorNodeUuid,
      newName: action.newName,
      newDescription: action.newDescription,
      rationale: action.rationale,
    });
    batchCreatedIds.push(rev.revisedNode.uuid);
    applied.push({
      action,
      verdict,
      createdNodeUuid: rev.revisedNode.uuid,
      createdEdgeUuid: rev.supersedesEdge.properties.uuid,
      summary: `Revised "${rev.priorNode.properties.name}" via supersedes -> "${rev.revisedNode.properties.name}" [${rev.revisedNode.uuid}]`,
    });
    return;
  }

  if (action.type === "discover_missing_links") {
    const candidates = store.discoverCandidateLinks({
      anchorUuid: action.anchorUuid,
      limit: Math.min(Math.max(1, action.limit ?? 3), 5),
    });
    if (candidates.length === 0) {
      blocked.push({
        action,
        verdict: {
          allowed: false,
          rule: "EMPIRICAL_EDGE_VERIFICATION",
          reason: "No statistically strong unwired candidate links found in current graph.",
        },
        summary: "No unwired empirical links met significance criteria.",
      });
      return;
    }
    for (const c of candidates) {
      const candidateAction: ProposedGraphAction = {
        type: "connect_nodes",
        sourceUuid: c.sourceUuid,
        targetUuid: c.targetUuid,
        edgeType: c.suggestedType,
        rationale:
          c.rationale ||
          `Discovered latent ${c.suggestedType} link (${c.pearsonR !== undefined ? `r=${c.pearsonR.toFixed(2)}` : "structural"}).`,
      };
      const cVerdict = validateGraphAction(store, candidateAction);
      if (cVerdict.allowed) {
        applySyncValidatedAction(store, candidateAction, cVerdict, batchCreatedIds, applied, blocked);
      } else {
        blocked.push({
          action: candidateAction,
          verdict: cVerdict,
          summary: `Blocked (${cVerdict.rule}): ${cVerdict.reason}`,
        });
      }
    }
    return;
  }

  if (action.type === "delete_node") {
    store.deleteNode(action.uuid);
    applied.push({
      action,
      verdict,
      summary: `Removed provisional/uncorroborated node ${action.uuid}`,
    });
    return;
  }

  if (action.type === "delete_edge") {
    store.deleteEdge(action.uuid);
    applied.push({
      action,
      verdict,
      summary: `Removed edge ${action.uuid}`,
    });
  }
}

export function validateAndApplyGraphActions(
  store: EtgStore,
  actions: ProposedGraphAction[]
): {
  applied: AppliedGraphActionResult[];
  blocked: AppliedGraphActionResult[];
} {
  const applied: AppliedGraphActionResult[] = [];
  const blocked: AppliedGraphActionResult[] = [];
  const batchCreatedIds: string[] = [];
  const safeActions = Array.isArray(actions) ? actions.slice(0, MAX_BATCH_ACTIONS) : [];

  for (const rawAction of safeActions) {
    const action = resolveBatchActionRefs(store, rawAction, batchCreatedIds);
    if (action && typeof action === "object" && action.type === "ingest_live_signal") {
      blocked.push({
        action,
        verdict: {
          allowed: false,
          rule: "GEO_AND_STRUCT_VALIDITY",
          reason: "Live signal ingestion requires async pipeline execution.",
        },
        summary: "Blocked (GEO_AND_STRUCT_VALIDITY): Live signal ingestion requires async pipeline.",
      });
      continue;
    }

    const verdict = validateGraphAction(store, action);
    if (!verdict.allowed) {
      blocked.push({
        action,
        verdict,
        summary: `Blocked (${verdict.rule}): ${verdict.reason}`,
      });
      continue;
    }

    applySyncValidatedAction(store, action, verdict, batchCreatedIds, applied, blocked);
  }

  return { applied, blocked };
}

export async function validateAndApplyGraphActionsAsync(
  store: EtgStore,
  actions: ProposedGraphAction[]
): Promise<{
  applied: AppliedGraphActionResult[];
  blocked: AppliedGraphActionResult[];
}> {
  const applied: AppliedGraphActionResult[] = [];
  const blocked: AppliedGraphActionResult[] = [];
  const batchCreatedIds: string[] = [];
  const safeActions = Array.isArray(actions) ? actions.slice(0, MAX_BATCH_ACTIONS) : [];

  for (const rawAction of safeActions) {
    const action = resolveBatchActionRefs(store, rawAction, batchCreatedIds);
    const verdict = validateGraphAction(store, action);
    if (!verdict.allowed) {
      blocked.push({
        action,
        verdict,
        summary: `Blocked (${verdict.rule}): ${verdict.reason}`,
      });
      continue;
    }

    if (action.type === "ingest_live_signal") {
      try {
        const summary = await fetchEarthTimeSeries(action.lat, action.lng, action.dataset);
        const dsMeta = DATASET_BY_ID[summary.dataset];
        const statisticallyAdjusted =
          summary.mannKendall.significant && summary.mannKendall.significantAdjusted;
        const verdictShort =
          summary.verdict === "Normal Environmental Variability"
            ? "Baseline"
            : summary.verdict.replace("Statistically Significant ", "");
        const nodeName =
          action.name?.trim() ||
          `${dsMeta.shortLabel} ${verdictShort} (${summary.lat.toFixed(1)}°, ${summary.lng.toFixed(1)}°)`;
        const regionLabel =
          action.region?.trim() || `${summary.lat.toFixed(2)}°, ${summary.lng.toFixed(2)}°`;

        const createdNode = store.createNode({
          label: "Signal",
          is_provisional: true,
          properties: {
            name: nodeName,
            description: `${summary.parameter} time-series analyzed via Mann-Kendall (raw p=${summary.mannKendall.pValue.toFixed(4)}, Hamed-Rao adj p=${summary.mannKendall.pValueAdjusted.toFixed(4)}) and Theil-Sen slope (${summary.theilSen.slope >= 0 ? "+" : ""}${summary.theilSen.slope.toFixed(3)} ${summary.slopeUnit}). Provenance: ${summary.provenance}.`,
            status: "Provisional",
            importance: statisticallyAdjusted ? 0.82 : 0.62,
            lat: summary.lat,
            lng: summary.lng,
            region: regionLabel,
            dataset: summary.dataset,
            producer_type: "nasa_satellite",
            authored_by: "ai",
            confidence: statisticallyAdjusted ? 0.78 : 0.62,
            value: Number(summary.latestValue.toFixed(2)),
            unit: summary.unit,
            p_value: Number(summary.mannKendall.pValue.toFixed(5)),
            p_value_adjusted: Number(summary.mannKendall.pValueAdjusted.toFixed(5)),
            ols_r2: summary.ols.rSquared,
            regime_shift_year: summary.changePoint?.significant ? summary.changePoint.date : undefined,
            theil_sen_slope: Number(summary.theilSen.slope.toFixed(4)),
            slope_unit: summary.slopeUnit,
            provenance_source: summary.provenance,
            observed_at: new Date().toISOString(),
            series: summary.points.map((p) => ({ date: p.date, t: p.t, value: p.value })),
          },
        });
        batchCreatedIds.push(createdNode.uuid);

        if (statisticallyAdjusted && store.getNode("rule-mann-kendall")) {
          store.createEdge({
            source_uuid: createdNode.uuid,
            target_uuid: "rule-mann-kendall",
            type: "verified_by",
            source_snippet: `AI-ingested live signal passed Hamed-Rao Mann-Kendall (adj p=${summary.mannKendall.pValueAdjusted.toFixed(4)}).`,
            authored_by: "ai",
          });
        }

        applied.push({
          action,
          verdict,
          createdNodeUuid: createdNode.uuid,
          summary: `Ingested live ${summary.dataset} signal "${nodeName}" [${createdNode.uuid}] (${summary.verdict}, p=${summary.mannKendall.pValue.toFixed(4)})`,
        });

        if (action.connectToUuid) {
          const connectAction: ProposedGraphAction = {
            type: "connect_nodes",
            sourceUuid: createdNode.uuid,
            targetUuid: action.connectToUuid,
            edgeType: action.edgeType || "relates_to",
            rationale:
              action.rationale?.trim() ||
              `AI-wired live ${summary.dataset} signal at (${summary.lat.toFixed(2)}°, ${summary.lng.toFixed(2)}°).`,
          };
          const cVerdict = validateGraphAction(store, connectAction);
          if (cVerdict.allowed) {
            applySyncValidatedAction(store, connectAction, cVerdict, batchCreatedIds, applied, blocked);
          } else {
            blocked.push({
              action: connectAction,
              verdict: cVerdict,
              summary: `Blocked (${cVerdict.rule}): ${cVerdict.reason}`,
            });
          }
        }
      } catch (err) {
        blocked.push({
          action,
          verdict: {
            allowed: false,
            rule: "GEO_AND_STRUCT_VALIDITY",
            reason:
              err instanceof Error
                ? `Live telemetry fetch failed: ${err.message}`
                : "Live telemetry fetch failed.",
          },
          summary: `Blocked: Failed to fetch live ${action.dataset} data at (${action.lat}, ${action.lng}).`,
        });
      }
      continue;
    }

    applySyncValidatedAction(store, action, verdict, batchCreatedIds, applied, blocked);
  }

  return { applied, blocked };
}
