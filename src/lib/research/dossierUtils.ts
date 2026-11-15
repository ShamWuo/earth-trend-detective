import type {
  ETGEdge,
  ETGNode,
  ETGResearchDossier,
  ETGScientificCitation,
} from "@/types/etg";

export const MAX_DOSSIER_ABSTRACT_LEN = 1500;
export const MAX_DOSSIER_MECHANISM_LEN = 4000;
export const MAX_DOSSIER_BULLET_LEN = 800;
export const MAX_DOSSIER_MARKDOWN_LEN = 16_000;
export const MAX_DOSSIER_CITATIONS = 16;

const DOSSIER_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?)/i,
  /\b(override|bypass)\s+(the\s+)?(system\s+prompt|integrity\s+guard|safety\s+rules?)\b/i,
  /system\s+prompt/i,
  /drop\s+table/i,
  /<script[\s>]/i,
  /javascript:/i,
  /<\|(?:im_start|im_end|system|endoftext)\|>/i,
];

export function dossierContainsUnsafeContent(value: unknown, depth = 0): boolean {
  if (!value || depth > 4) return false;
  if (typeof value === "string") {
    const bounded = value.length > 16_384 ? value.slice(0, 16_384) : value;
    return DOSSIER_INJECTION_PATTERNS.some((re) => re.test(bounded));
  }
  if (Array.isArray(value)) {
    return value.slice(0, 64).some((item) => dossierContainsUnsafeContent(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .slice(0, 64)
      .some((entry) => dossierContainsUnsafeContent(entry, depth + 1));
  }
  return false;
}

function normalizeDoi(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  cleaned = cleaned.replace(/^doi:\s*/i, "").trim();
  if (!/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function normalizeHttpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) return undefined;
  if (!/^https:\/\/[^\s<>"{}|\\^`[\]]+$/i.test(trimmed)) return undefined;
  return trimmed;
}

export function sanitizeCitation(raw: unknown): ETGScientificCitation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const title = typeof c.title === "string" ? c.title.trim() : "";
  const authors = typeof c.authors === "string" ? c.authors.trim() : "";
  const journal =
    typeof c.journal === "string" && c.journal.trim()
      ? c.journal.trim().slice(0, 200)
      : undefined;
  const year = typeof c.year === "number" ? Math.round(c.year) : Number(c.year);
  if (!title || title.length > 400 || !authors || authors.length > 400) return undefined;
  if (!Number.isFinite(year) || year < 1850 || year > 2100) return undefined;
  if (
    dossierContainsUnsafeContent(title) ||
    dossierContainsUnsafeContent(authors) ||
    dossierContainsUnsafeContent(journal)
  ) {
    return undefined;
  }
  const doi = normalizeDoi(c.doi);
  const explicitUrl = normalizeHttpsUrl(c.url);
  const url = explicitUrl ?? (doi ? `https://doi.org/${doi}` : undefined);
  const doiVerified = typeof c.doi_verified === "boolean" ? c.doi_verified : undefined;
  const citationCount =
    typeof c.citation_count === "number" && Number.isFinite(c.citation_count) && c.citation_count >= 0
      ? Math.round(c.citation_count)
      : undefined;
  const verifiedAtRaw = typeof c.verified_at === "string" ? c.verified_at.trim() : "";
  const verifiedAt =
    verifiedAtRaw && Number.isFinite(Date.parse(verifiedAtRaw))
      ? new Date(verifiedAtRaw).toISOString()
      : undefined;
  const source =
    c.source === "crossref" ||
    c.source === "openalex" ||
    c.source === "europe_pmc" ||
    c.source === "curated"
      ? c.source
      : undefined;
  const rawAbstract =
    typeof c.abstract_snippet === "string"
      ? c.abstract_snippet.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200)
      : "";
  const abstractSnippet =
    rawAbstract && !dossierContainsUnsafeContent(rawAbstract) ? rawAbstract : undefined;
  const claimStance =
    c.claim_stance === "supports" ||
    c.claim_stance === "neutral" ||
    c.claim_stance === "challenges"
      ? c.claim_stance
      : undefined;
  const rawStanceRationale =
    typeof c.stance_rationale === "string"
      ? c.stance_rationale.replace(/\s+/g, " ").trim().slice(0, 320)
      : "";
  const stanceRationale =
    rawStanceRationale && !dossierContainsUnsafeContent(rawStanceRationale)
      ? rawStanceRationale
      : undefined;

  return {
    title,
    authors,
    ...(journal ? { journal } : {}),
    year,
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    ...(doiVerified !== undefined ? { doi_verified: doiVerified } : {}),
    ...(citationCount !== undefined ? { citation_count: citationCount } : {}),
    ...(verifiedAt ? { verified_at: verifiedAt } : {}),
    ...(source ? { source } : {}),
    ...(abstractSnippet ? { abstract_snippet: abstractSnippet } : {}),
    ...(claimStance ? { claim_stance: claimStance } : {}),
    ...(stanceRationale ? { stance_rationale: stanceRationale } : {}),
  };
}

/**
 * Validates and normalizes an incoming `ETGResearchDossier` payload.
 * Returns `undefined` when required narrative fields are missing or unsafe content is detected.
 */
export function sanitizeResearchDossier(raw: unknown): ETGResearchDossier | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  const abstract = typeof obj.abstract === "string" ? obj.abstract.trim() : "";
  const physicalMechanism =
    typeof obj.physical_mechanism === "string" ? obj.physical_mechanism.trim() : "";
  const markdownBody =
    typeof obj.markdown_body === "string" && obj.markdown_body.trim()
      ? obj.markdown_body.trim().slice(0, MAX_DOSSIER_MARKDOWN_LEN)
      : undefined;

  if (
    dossierContainsUnsafeContent(abstract) ||
    dossierContainsUnsafeContent(physicalMechanism) ||
    dossierContainsUnsafeContent(markdownBody)
  ) {
    return undefined;
  }

  if (abstract.length < 8 || physicalMechanism.length < 8) {
    return undefined;
  }

  const empiricalRaw = Array.isArray(obj.empirical_findings) ? obj.empirical_findings : [];
  const empiricalFindings: string[] = [];
  for (const item of empiricalRaw.slice(0, 12)) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().slice(0, MAX_DOSSIER_BULLET_LEN);
    if (!cleaned || dossierContainsUnsafeContent(cleaned)) continue;
    empiricalFindings.push(cleaned);
  }

  const impactsRaw = Array.isArray(obj.impacts) ? obj.impacts : [];
  const impacts: string[] = [];
  for (const item of impactsRaw.slice(0, 10)) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().slice(0, MAX_DOSSIER_BULLET_LEN);
    if (!cleaned || dossierContainsUnsafeContent(cleaned)) continue;
    impacts.push(cleaned);
  }

  const citationsRaw = Array.isArray(obj.citations) ? obj.citations : [];
  const citations: ETGScientificCitation[] = [];
  for (const rawCit of citationsRaw.slice(0, MAX_DOSSIER_CITATIONS)) {
    const cleanCit = sanitizeCitation(rawCit);
    if (cleanCit) citations.push(cleanCit);
  }

  const updatedAtRaw = typeof obj.updated_at === "string" ? obj.updated_at.trim() : "";
  const updatedAt =
    updatedAtRaw && Number.isFinite(Date.parse(updatedAtRaw))
      ? new Date(updatedAtRaw).toISOString()
      : new Date().toISOString();

  const researchedBy =
    obj.researched_by === "agency_curation" ||
    obj.researched_by === "ai_detective" ||
    obj.researched_by === "human"
      ? obj.researched_by
      : undefined;

  return {
    abstract: abstract.slice(0, MAX_DOSSIER_ABSTRACT_LEN),
    physical_mechanism: physicalMechanism.slice(0, MAX_DOSSIER_MECHANISM_LEN),
    empirical_findings: empiricalFindings,
    ...(impacts.length > 0 ? { impacts } : {}),
    citations,
    ...(markdownBody ? { markdown_body: markdownBody } : {}),
    updated_at: updatedAt,
    ...(researchedBy ? { researched_by: researchedBy } : {}),
  };
}

/**
 * Generates a structured telemetry briefing on the fly for any ETG node
 * that does not yet carry an explicit curated or AI-authored `dossier`.
 * Intentionally leaves `researched_by` unset so UI callers can distinguish
 * `"Live Telemetry Auto-Brief"` from `"Literature-Cited Dossier"`.
 */
export function buildLiveTelemetryBriefingFallback(
  node: ETGNode,
  edges: readonly ETGEdge[],
  nodesById: ReadonlyMap<string, ETGNode>
): ETGResearchDossier {
  const p = node.properties;
  const slopeStr =
    typeof p.theil_sen_slope === "number"
      ? `${p.theil_sen_slope >= 0 ? "+" : ""}${p.theil_sen_slope.toFixed(4)} ${p.slope_unit || "unit/yr"}`
      : "Unquantified slope";
  const pRawStr =
    typeof p.p_value === "number" ? `MK p = ${p.p_value.toFixed(4)}` : "MK p N/A";
  const pAdjStr =
    typeof p.p_value_adjusted === "number"
      ? `Hamed-Rao adj p = ${p.p_value_adjusted.toFixed(4)}`
      : null;

  const incident = edges.filter(
    (e) => (e.source_uuid === node.uuid || e.target_uuid === node.uuid) && !e.properties.superseded_at
  );

  const supportingEdges = incident.filter(
    (e) =>
      (e.type === "supports" || e.type === "corroborates") &&
      e.target_uuid === node.uuid
  );
  const oppositeEdges = incident.filter((e) => e.type === "drives_opposite");
  const contradictingEdges = incident.filter((e) => e.type === "contradicts");
  const causalEdges = incident.filter(
    (e) =>
      e.type === "leads" ||
      e.type === "amplifies" ||
      e.type === "dampens" ||
      e.type === "teleconnects" ||
      e.type === "impacts"
  );

  const findings: string[] = [
    `Primary Telemetry (${p.source_system || p.provenance_source || p.dataset || "ETG"}): Theil-Sen slope ${slopeStr}, ${pRawStr}${pAdjStr ? ` (${pAdjStr})` : ""}${p.regime_shift_year ? `, Pettitt structural shift near ${p.regime_shift_year}` : ""}.`,
  ];

  for (const edge of supportingEdges.slice(0, 4)) {
    const peer = nodesById.get(edge.source_uuid);
    if (!peer) continue;
    const rText =
      typeof edge.properties.correlation_r === "number"
        ? ` (r=${edge.properties.correlation_r.toFixed(2)})`
        : "";
    findings.push(
      `Corroborating source: [${peer.uuid}] (${peer.properties.source_system || peer.label})${rText}.`
    );
  }

  for (const edge of contradictingEdges.slice(0, 4)) {
    const otherId = edge.source_uuid === node.uuid ? edge.target_uuid : edge.source_uuid;
    const peer = nodesById.get(otherId);
    if (!peer) continue;
    findings.push(
      `Disconfirming / Contrasting Evidence: [${peer.uuid}] (${peer.properties.name}) ${edge.properties.rationale || edge.properties.mechanism || "diverges from expected direction"}.`
    );
  }

  for (const edge of oppositeEdges.slice(0, 3)) {
    const otherId = edge.source_uuid === node.uuid ? edge.target_uuid : edge.source_uuid;
    const peer = nodesById.get(otherId);
    if (!peer) continue;
    findings.push(
      `Cross-region opposite dipole against [${peer.uuid}] (${peer.properties.name})${edge.properties.correlation_r !== undefined ? `, r=${edge.properties.correlation_r.toFixed(2)}` : ""}${edge.properties.detrended_r !== undefined ? `, detrended r*=${edge.properties.detrended_r.toFixed(2)}` : ""}${edge.properties.partial_r !== undefined ? `, partial r=${edge.properties.partial_r.toFixed(2)}` : ""}${edge.properties.predictive_lift_pct !== undefined ? `, OOS lift ${edge.properties.predictive_lift_pct >= 0 ? "+" : ""}${edge.properties.predictive_lift_pct.toFixed(1)}%` : ""}.`
    );
  }

  for (const edge of causalEdges.slice(0, 3)) {
    const otherId = edge.source_uuid === node.uuid ? edge.target_uuid : edge.source_uuid;
    const peer = nodesById.get(otherId);
    if (!peer) continue;
    findings.push(
      `${edge.type.replaceAll("_", " ")} coupling with [${peer.uuid}] (${edge.properties.mechanism || peer.properties.name})${edge.properties.partial_r !== undefined ? ` [partial r=${edge.properties.partial_r.toFixed(2)}${edge.properties.predictive_lift_pct !== undefined ? `, OOS lift ${edge.properties.predictive_lift_pct >= 0 ? "+" : ""}${edge.properties.predictive_lift_pct.toFixed(1)}%` : ""}]` : ""}.`
    );
  }

  const mechFallback =
    causalEdges.find((e) => e.properties.mechanism)?.properties.mechanism ||
    oppositeEdges.find((e) => e.properties.mechanism)?.properties.mechanism ||
    (node.label === "Rule"
      ? "Formal epistemological verification gate enforced across all incoming signals and Insight promotions inside the Earth Trend Graph."
      : `Tracked across ${p.region || "global coordinates"} via ${p.source_system || p.provenance_source || "multi-agency Earth observation"} with serial-autocorrelation-adjusted trend detection.`);

  const citations: ETGScientificCitation[] = [];
  if (p.source_url && normalizeHttpsUrl(p.source_url)) {
    citations.push({
      title: `${p.source_system || p.provenance_source || "Official Agency"} Observational Record`,
      authors: p.source_system || String(p.provenance_source || "Earth Observation Agency"),
      journal: "Live Agency Telemetry Provenance",
      year: p.observed_at ? Math.max(1990, new Date(p.observed_at).getUTCFullYear() || 2025) : 2025,
      url: p.source_url,
    });
  }

  return {
    abstract: p.description || `${p.name} tracked in the Earth Trend Graph.`,
    physical_mechanism: mechFallback,
    empirical_findings: findings,
    citations,
    updated_at: p.observed_at || p.created_at || new Date().toISOString(),
  };
}

export function exportDossierToMarkdown(
  node: ETGNode,
  dossier: ETGResearchDossier
): string {
  const p = node.properties;
  const coords =
    typeof p.lat === "number" && typeof p.lng === "number"
      ? `${p.lat.toFixed(2)}°, ${p.lng.toFixed(2)}°`
      : "Global / Non-point";
  const slope =
    typeof p.theil_sen_slope === "number"
      ? `${p.theil_sen_slope >= 0 ? "+" : ""}${p.theil_sen_slope.toFixed(4)} ${p.slope_unit || "unit/yr"}`
      : "N/A";
  const pVal =
    typeof p.p_value === "number"
      ? `MK p = ${p.p_value.toFixed(4)}${typeof p.p_value_adjusted === "number" ? ` (Hamed-Rao adj p = ${p.p_value_adjusted.toFixed(4)})` : ""}`
      : "N/A";

  const lines: string[] = [
    `# ${p.name}`,
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| ETG UUID | \`${node.uuid}\` (${node.label}) |`,
    `| Status | ${p.corroborated ? "Corroborated Active" : p.status || "Active"} |`,
    `| Region & Coordinates | ${p.region || "Global"} (${coords}) |`,
    `| Dataset / Provenance | ${p.dataset || "general"} · ${p.source_system || p.provenance_source || "ETG"} |`,
    `| Trend Rate & Significance | ${slope} · ${pVal} |`,
    "",
    "## Executive Abstract",
    "",
    dossier.abstract,
    "",
    "## Physical & Dynamical Mechanism",
    "",
    dossier.physical_mechanism,
    "",
  ];

  if (dossier.empirical_findings.length > 0) {
    lines.push("## Empirical Findings & Graph Evidence", "");
    for (const item of dossier.empirical_findings) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (dossier.impacts && dossier.impacts.length > 0) {
    lines.push("## Earth-System & Regional Impacts", "");
    for (const item of dossier.impacts) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (dossier.markdown_body) {
    lines.push("## Extended Scientific Synthesis", "", dossier.markdown_body, "");
  }

  if (dossier.citations.length > 0) {
    lines.push("## Peer-Reviewed Literature & Data Citations", "");
    dossier.citations.forEach((c, idx) => {
      const doiPart = c.doi ? ` DOI: https://doi.org/${c.doi}` : c.url ? ` URL: ${c.url}` : "";
      lines.push(
        `${idx + 1}. **${c.authors} (${c.year})**. *${c.title}*.${c.journal ? ` ${c.journal}.` : ""}${doiPart}`
      );
    });
    lines.push("");
  }

  return lines.join("\n");
}
