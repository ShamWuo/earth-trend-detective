import type { ETGNode, ETGScientificCitation } from "@/types/etg";
import { sanitizeCitation } from "@/lib/research/dossierUtils";

const USER_AGENT = "EarthTrends/1.0 (https://earthtrends.local; mailto:research@earthtrends.local)";
const CACHE_TTL_VERIFIED_MS = 1000 * 60 * 60 * 6;
const CACHE_TTL_NEGATIVE_MS = 1000 * 60 * 10;
const CACHE_TTL_SEARCH_MS = 1000 * 60 * 30;

export type DoiVerificationOutcome =
  | { status: "verified"; doi: string; citation: ETGScientificCitation }
  | { status: "not_found"; doi: string; reason: string }
  | { status: "unavailable"; doi: string; reason: string };

const doiCache = new Map<string, { expiresAt: number; outcome: DoiVerificationOutcome }>();
const searchCache = new Map<
  string,
  { expiresAt: number; results: ETGScientificCitation[] }
>();

export function clearScholarlyLiteratureCache(): void {
  doiCache.clear();
  searchCache.clear();
}

export function normalizeDoiIdentifier(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let cleaned = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;)\]]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 180) return undefined;
  // Decode percent escapes safely once if URL-encoded
  try {
    if (cleaned.includes("%")) {
      cleaned = decodeURIComponent(cleaned);
    }
  } catch {
    // keep raw cleaned string
  }
  return /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(cleaned) ? cleaned.toLowerCase() : undefined;
}

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

interface CrossrefWorkItem {
  DOI?: string;
  title?: string[];
  abstract?: string;
  author?: CrossrefAuthor[];
  "container-title"?: string[];
  publisher?: string;
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
  created?: { "date-parts"?: number[][] };
  "is-referenced-by-count"?: number;
  URL?: string;
}

export interface ClaimStanceContext {
  claimText: string;
  direction?: "increasing" | "decreasing" | "stable" | "mixed" | "opposite";
  region?: string;
  parameter?: string;
}

function stripHtmlAndJats(raw: string, maxLen = 620): string {
  const cleaned = raw
    .replace(/<jats:title[^>]*>[\s\S]*?<\/jats:title>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  const sliced = cleaned.slice(0, maxLen - 3);
  const lastSpace = sliced.lastIndexOf(" ");
  return `${(lastSpace > maxLen * 0.6 ? sliced.slice(0, lastSpace) : sliced).trim()}...`;
}

function reconstructOpenAlexAbstract(
  invertedIndex: Record<string, number[]> | undefined
): string | undefined {
  if (!invertedIndex || typeof invertedIndex !== "object") return undefined;
  const tokens: Array<{ pos: number; word: string }> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === "number" && Number.isFinite(pos) && pos >= 0 && pos < 160) {
        tokens.push({ pos, word });
      }
    }
  }
  if (tokens.length === 0) return undefined;
  tokens.sort((a, b) => a.pos - b.pos);
  return stripHtmlAndJats(tokens.map((t) => t.word).join(" "));
}

const STANCE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "over",
  "that",
  "this",
  "these",
  "those",
  "have",
  "been",
  "were",
  "into",
  "across",
  "global",
  "earth",
  "climate",
  "trend",
  "trends",
  "change",
  "changes",
  "annual",
  "monthly",
  "series",
  "signal",
  "insight",
  "region",
  "regional",
  "record",
  "records",
  "data",
  "year",
  "years",
  "rate",
  "slope",
  "mean",
  "anomaly",
  "anomalies",
  "nasa",
  "noaa",
  "nsidc",
  "gistemp",
  "power",
  "merra",
  "significant",
  "observed",
  "using",
  "analysis",
]);

/**
 * Deterministic Claim-to-Abstract Stance Entailment classifier.
 * Scores whether a citation's abstract/title supports, is neutral toward, or challenges
 * an ETG claim using keyword grounding, directional polarity, and negation/refutation cues.
 */
export function evaluateCitationClaimStance(
  citation: ETGScientificCitation,
  claimContext: ClaimStanceContext
): ETGScientificCitation {
  const titleText = citation.title.trim();
  const abstractText = citation.abstract_snippet?.trim() ?? "";
  const hasAbstract = abstractText.length >= 20;
  const corpus = `${titleText} ${abstractText}`.toLowerCase();

  const extractTerms = (txt: string): string[] => {
    const raw = txt.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const w of raw) {
      if (STANCE_STOPWORDS.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
    return out;
  };

  const claimTerms = extractTerms(
    `${claimContext.claimText} ${claimContext.parameter ?? ""} ${claimContext.region ?? ""}`
  ).slice(0, 18);
  const regionTerms = extractTerms(claimContext.region ?? "").slice(0, 6);

  const matchedTerms = claimTerms.filter((t) => corpus.includes(t));
  const matchedRegionTerms = regionTerms.filter((t) => corpus.includes(t));
  const topicHits = matchedTerms.length + matchedRegionTerms.length;

  const challengeMatch = corpus.match(
    /\b(no significant trend|not statistically significant|statistically insignificant|no evidence of|no clear trend|absence of (?:a )?trend|contradict(?:s|ed|ing)?|refut(?:e|ed|es|ing)|inconsistent with|overestimat(?:e|ed|es|ing)|pause in|warming hiatus|fail(?:s|ed)? to find|contrary to (?:projections|expectations|models)|attributable to natural variability)\b/i
  );
  const upwardMatches =
    corpus.match(
      /\b(increas(?:e|ed|es|ing)|ris(?:e|es|ing|en)|warm(?:ing|ed|s)|accelerat(?:e|ed|ing|ion)|amplif(?:y|ied|ies|ication)|intensif(?:y|ied|ies|ying)|upward|elevated|expand(?:ed|ing)|unprecedented|surge)\b/gi
    ) ?? [];
  const downwardMatches =
    corpus.match(
      /\b(decreas(?:e|ed|es|ing)|declin(?:e|ed|ing|es)|cool(?:ing|ed|s)|slowdown|weakening|reduc(?:e|ed|tion)|shrink(?:ing|age)|loss(?:es)?|retreat|megadrought|drought|deficit|aridity|deplet(?:ed|ion)|warming hole)\b/gi
    ) ?? [];
  const explicitCoolingMatches =
    corpus.match(/\b(cool(?:ing|ed|s)|warming hole|slowdown|weakening|negative trend)\b/gi) ?? [];
  const dipoleMatches =
    corpus.match(
      /\b(dipole|opposite|teleconnect(?:ion|ions|ed)?|anticorrelat(?:e|ed|ion)|warming hole|amoc|subpolar|el nino|enso|indian ocean dipole|coupled)\b/gi
    ) ?? [];

  const dir = claimContext.direction;
  let claim_stance: "supports" | "neutral" | "challenges" = "neutral";
  let stance_rationale = "";

  if (challengeMatch) {
    if (hasAbstract || topicHits >= 1) {
      claim_stance = "challenges";
      stance_rationale = `${hasAbstract ? "Abstract" : "Title"} includes counter-evidence phrase ("${challengeMatch[0]}") across ${topicHits} topic match(es).`;
    }
  } else if (dir === "opposite") {
    if (topicHits >= 2 && (dipoleMatches.length > 0 || (upwardMatches.length > 0 && downwardMatches.length > 0))) {
      claim_stance = "supports";
      stance_rationale = `${hasAbstract ? "Abstract" : "Title"} entails opposing-regime or teleconnection mechanism (${topicHits} topic hits; ${matchedTerms.slice(0, 3).join(", ")}).`;
    } else if (!hasAbstract) {
      stance_rationale = "Abstract unavailable in bibliographic record; title alone does not verify dipole polarity.";
    } else {
      stance_rationale = `Abstract discusses related phenomena (${topicHits} term hits) without explicit opposite-trend teleconnection wording.`;
    }
  } else if (dir === "decreasing") {
    if (
      explicitCoolingMatches.length === 0 &&
      upwardMatches.length >= 2 &&
      downwardMatches.length === 0 &&
      topicHits >= 2 &&
      !/sea ice|glacier|drought|discharge/i.test(claimContext.claimText)
    ) {
      claim_stance = "challenges";
      stance_rationale = `${hasAbstract ? "Abstract" : "Title"} emphasizes upward/warming trajectory opposing a decreasing claim.`;
    } else if (topicHits >= 2 && (downwardMatches.length > 0 || dipoleMatches.length > 0)) {
      claim_stance = "supports";
      stance_rationale = `${hasAbstract ? "Abstract" : "Title"} aligns with declining/cooling trend (${matchedTerms.slice(0, 3).join(", ")}; ${downwardMatches.length} decline/cooling cue(s)).`;
    } else if (!hasAbstract) {
      stance_rationale = "Abstract unavailable in bibliographic record; manual full-text check recommended.";
    } else {
      stance_rationale = `Abstract provides contextual literature (${topicHits} term hits) without direct directional entailment.`;
    }
  } else if (dir === "increasing") {
    const isWarmingOrTempClaim =
      !/warming hole|cooling/i.test(claimContext.claimText) &&
      /\b(warm|temp|heat|co2|radiative|amplif|vpd|fire|discharge)\b/i.test(
        `${claimContext.claimText} ${claimContext.parameter ?? ""}`
      );
    if (
      isWarmingOrTempClaim &&
      explicitCoolingMatches.length >= 2 &&
      upwardMatches.length === 0 &&
      topicHits >= 2
    ) {
      claim_stance = "challenges";
      stance_rationale = `${hasAbstract ? "Abstract" : "Title"} reports cooling/slowdown signals contrasting with an increasing trend.`;
    } else if (topicHits >= 2 && (upwardMatches.length > 0 || dipoleMatches.length > 0)) {
      claim_stance = "supports";
      stance_rationale = `${hasAbstract ? "Abstract" : "Title"} entails increasing/intensifying trend (${matchedTerms.slice(0, 3).join(", ")}; ${upwardMatches.length} intensification cue(s)).`;
    } else if (!hasAbstract && topicHits >= 3) {
      claim_stance = "supports";
      stance_rationale = `Title strongly matches topic and region (${matchedTerms.slice(0, 3).join(", ")}; abstract unavailable in metadata).`;
    } else if (!hasAbstract) {
      stance_rationale = "Abstract unavailable in bibliographic record; manual full-text check recommended.";
    } else {
      stance_rationale = `Abstract provides related domain context (${topicHits} keyword overlap) without explicit upward trend confirmation.`;
    }
  } else {
    // mixed / stable / unspecified
    if (topicHits >= 2 && (upwardMatches.length + downwardMatches.length + dipoleMatches.length > 0)) {
      claim_stance = "supports";
      stance_rationale = `${hasAbstract ? "Abstract" : "Title"} aligns with claim scope (${matchedTerms.slice(0, 3).join(", ")}).`;
    } else {
      stance_rationale = hasAbstract
        ? `Abstract supplies broader background context (${topicHits} keyword matches).`
        : "Abstract unavailable in bibliographic record; manual review recommended.";
    }
  }

  return {
    ...citation,
    claim_stance,
    stance_rationale,
  };
}

function formatCrossrefAuthors(authors: CrossrefAuthor[] | undefined): string {
  if (!Array.isArray(authors) || authors.length === 0) {
    return "Research Consortium";
  }
  const formatted = authors.slice(0, 6).map((a) => {
    if (a.family && a.given) {
      const initials = a.given
        .split(/[\s-]+/)
        .filter(Boolean)
        .map((part) => `${part[0].toUpperCase()}.`)
        .join(" ");
      return `${a.family}, ${initials}`;
    }
    return (a.family || a.name || "Unknown").trim();
  });
  return authors.length > 6 ? `${formatted.join(", ")}, et al.` : formatted.join(", ");
}

function extractCrossrefYear(item: CrossrefWorkItem): number {
  const candidates = [
    item.published?.["date-parts"]?.[0]?.[0],
    item["published-online"]?.["date-parts"]?.[0]?.[0],
    item["published-print"]?.["date-parts"]?.[0]?.[0],
    item.issued?.["date-parts"]?.[0]?.[0],
    item.created?.["date-parts"]?.[0]?.[0],
  ];
  for (const y of candidates) {
    if (typeof y === "number" && Number.isFinite(y) && y >= 1850 && y <= 2100) {
      return Math.round(y);
    }
  }
  return new Date().getUTCFullYear();
}

function parseCrossrefWorkToCitation(
  item: CrossrefWorkItem,
  verifiedAtIso: string
): ETGScientificCitation | null {
  const doi = normalizeDoiIdentifier(item.DOI);
  const rawTitle = Array.isArray(item.title) ? item.title[0] : "";
  const title = rawTitle ? rawTitle.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!title) return null;

  const authors = formatCrossrefAuthors(item.author);
  const journal =
    (Array.isArray(item["container-title"]) && item["container-title"][0]?.trim()) ||
    item.publisher?.trim() ||
    undefined;
  const year = extractCrossrefYear(item);
  const citationCount =
    typeof item["is-referenced-by-count"] === "number" &&
    Number.isFinite(item["is-referenced-by-count"]) &&
    item["is-referenced-by-count"] >= 0
      ? Math.round(item["is-referenced-by-count"])
      : undefined;

  const abstractSnippet =
    typeof item.abstract === "string" && item.abstract.trim().length > 0
      ? stripHtmlAndJats(item.abstract)
      : undefined;

  return sanitizeCitation({
    title,
    authors,
    journal,
    year,
    doi,
    url: doi ? `https://doi.org/${doi}` : item.URL,
    doi_verified: Boolean(doi),
    citation_count: citationCount,
    abstract_snippet: abstractSnippet,
    verified_at: verifiedAtIso,
    source: "crossref",
  }) ?? null;
}

/**
 * Verifies a DOI directly against Crossref Works API and returns canonical metadata.
 * Distinguishes definitive 404/400 "not_found" (hallucinated/non-existent DOIs) from transient upstream unavailability.
 */
export async function verifyDoiMetadataDetailed(
  rawDoi: string,
  options?: { timeoutMs?: number }
): Promise<DoiVerificationOutcome> {
  const doi = normalizeDoiIdentifier(rawDoi);
  if (!doi) {
    return {
      status: "not_found",
      doi: String(rawDoi || "").trim(),
      reason: "Invalid DOI format.",
    };
  }

  const now = Date.now();
  const cached = doiCache.get(doi);
  if (cached && cached.expiresAt > now) {
    return cached.outcome;
  }

  const timeoutMs = Math.max(800, Math.min(10_000, options?.timeoutMs ?? 4000));
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404 || res.status === 400) {
      const outcome: DoiVerificationOutcome = {
        status: "not_found",
        doi,
        reason: `Crossref returned HTTP ${res.status} for DOI ${doi}.`,
      };
      doiCache.set(doi, { expiresAt: now + CACHE_TTL_NEGATIVE_MS, outcome });
      return outcome;
    }

    if (!res.ok) {
      return {
        status: "unavailable",
        doi,
        reason: `Crossref returned HTTP ${res.status}.`,
      };
    }

    const payload = (await res.json()) as { message?: CrossrefWorkItem };
    if (!payload?.message) {
      return {
        status: "unavailable",
        doi,
        reason: "Crossref response lacked message payload.",
      };
    }

    const citation = parseCrossrefWorkToCitation(
      { ...payload.message, DOI: payload.message.DOI || doi },
      new Date().toISOString()
    );
    if (!citation) {
      const outcome: DoiVerificationOutcome = {
        status: "not_found",
        doi,
        reason: "Crossref work lacked valid citation fields.",
      };
      doiCache.set(doi, { expiresAt: now + CACHE_TTL_NEGATIVE_MS, outcome });
      return outcome;
    }

    const outcome: DoiVerificationOutcome = {
      status: "verified",
      doi,
      citation,
    };
    doiCache.set(doi, { expiresAt: now + CACHE_TTL_VERIFIED_MS, outcome });
    return outcome;
  } catch (err) {
    return {
      status: "unavailable",
      doi,
      reason: err instanceof Error ? err.message : "Crossref request failed",
    };
  }
}

export async function verifyDoiMetadata(
  rawDoi: string,
  options?: { timeoutMs?: number }
): Promise<ETGScientificCitation | null> {
  const outcome = await verifyDoiMetadataDetailed(rawDoi, options);
  return outcome.status === "verified" ? outcome.citation : null;
}

async function searchCrossrefWorks(
  query: string,
  rows: number,
  timeoutMs: number
): Promise<ETGScientificCitation[]> {
  const res = await fetch(
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${rows}&sort=relevance&filter=type:journal-article`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    message?: { items?: CrossrefWorkItem[] };
  };
  const items = Array.isArray(data?.message?.items) ? data.message!.items! : [];
  const verifiedAt = new Date().toISOString();
  const out: ETGScientificCitation[] = [];
  for (const item of items) {
    const cit = parseCrossrefWorkToCitation(item, verifiedAt);
    if (cit && cit.doi) out.push(cit);
  }
  return out;
}

interface EuropePmcItem {
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  doi?: string;
  citedByCount?: number;
  pmcid?: string;
  pmid?: string;
  abstractText?: string;
}

async function searchEuropePmc(
  query: string,
  rows: number,
  timeoutMs: number
): Promise<ETGScientificCitation[]> {
  const res = await fetch(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${rows}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    resultList?: { result?: EuropePmcItem[] };
  };
  const items = Array.isArray(data?.resultList?.result) ? data.resultList!.result! : [];
  const nowIso = new Date().toISOString();
  const out: ETGScientificCitation[] = [];
  for (const item of items) {
    const doi = normalizeDoiIdentifier(item.doi);
    const title = typeof item.title === "string"
      ? item.title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().replace(/\.$/, "")
      : "";
    const authors = typeof item.authorString === "string" ? item.authorString.trim() : "";
    const year = Number(item.pubYear);
    if (!title || !authors || !Number.isFinite(year) || year < 1900 || year > 2100) continue;
    const url = doi
      ? `https://doi.org/${doi}`
      : item.pmcid
        ? `https://europepmc.org/article/PMC/${item.pmcid}`
        : undefined;
    const abstractSnippet =
      typeof item.abstractText === "string" && item.abstractText.trim().length > 0
        ? stripHtmlAndJats(item.abstractText)
        : undefined;
    const cit = sanitizeCitation({
      title,
      authors,
      journal: item.journalTitle?.trim() || "Europe PMC Indexed Literature",
      year,
      doi,
      url,
      doi_verified: Boolean(doi),
      citation_count:
        typeof item.citedByCount === "number" && item.citedByCount >= 0
          ? item.citedByCount
          : undefined,
      abstract_snippet: abstractSnippet,
      verified_at: nowIso,
      source: "europe_pmc",
    });
    if (cit) out.push(cit);
  }
  return out;
}

interface OpenAlexWork {
  doi?: string;
  title?: string;
  publication_year?: number;
  cited_by_count?: number;
  primary_location?: { source?: { display_name?: string } };
  authorships?: Array<{ author?: { display_name?: string } }>;
  abstract_inverted_index?: Record<string, number[]>;
}

async function searchOpenAlexWorks(
  query: string,
  rows: number,
  timeoutMs: number
): Promise<ETGScientificCitation[]> {
  const apiKey = process.env.OPENALEX_API_KEY?.trim();
  if (!apiKey) return [];
  const res = await fetch(
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${rows}&sort=relevance_score:desc&api_key=${encodeURIComponent(apiKey)}`,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: OpenAlexWork[] };
  const items = Array.isArray(data?.results) ? data.results! : [];
  const nowIso = new Date().toISOString();
  const out: ETGScientificCitation[] = [];
  for (const w of items) {
    const doi = normalizeDoiIdentifier(w.doi);
    const title = typeof w.title === "string" ? w.title.trim() : "";
    const authors = Array.isArray(w.authorships) && w.authorships.length > 0
      ? w.authorships
          .slice(0, 6)
          .map((a) => a.author?.display_name?.trim())
          .filter(Boolean)
          .join(", ") + (w.authorships.length > 6 ? ", et al." : "")
      : "";
    const year = Number(w.publication_year);
    if (!title || !authors || !Number.isFinite(year) || year < 1900) continue;
    const abstractSnippet = reconstructOpenAlexAbstract(w.abstract_inverted_index);
    const cit = sanitizeCitation({
      title,
      authors,
      journal: w.primary_location?.source?.display_name?.trim(),
      year,
      doi,
      url: doi ? `https://doi.org/${doi}` : undefined,
      doi_verified: Boolean(doi),
      citation_count:
        typeof w.cited_by_count === "number" && w.cited_by_count >= 0
          ? w.cited_by_count
          : undefined,
      abstract_snippet: abstractSnippet,
      verified_at: nowIso,
      source: "openalex",
    });
    if (cit) out.push(cit);
  }
  return out;
}

/**
 * Queries live peer-reviewed scholarly databases (Crossref + Europe PMC, plus OpenAlex when `OPENALEX_API_KEY` is configured),
 * returning deduplicated citations ranked by relevance and citation impact.
 */
export async function searchPeerReviewedEarthLiterature(
  query: string,
  limit = 6,
  options?: { timeoutMs?: number; claimContext?: ClaimStanceContext }
): Promise<ETGScientificCitation[]> {
  const cleanQuery = query.trim().replace(/\s+/g, " ").slice(0, 240);
  if (cleanQuery.length < 3) return [];

  const boundedLimit = Math.max(1, Math.min(12, limit));
  const cacheKey = `${cleanQuery.toLowerCase()}::${boundedLimit}`;
  const now = Date.now();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return options?.claimContext
      ? cached.results.map((c) => evaluateCitationClaimStance(c, options.claimContext!))
      : cached.results;
  }

  const timeoutMs = Math.max(800, Math.min(10_000, options?.timeoutMs ?? 4500));
  const fetchRows = Math.min(10, Math.max(boundedLimit * 2, 6));

  const settled = await Promise.allSettled([
    searchCrossrefWorks(cleanQuery, fetchRows, timeoutMs),
    searchEuropePmc(cleanQuery, Math.min(6, boundedLimit), timeoutMs),
    searchOpenAlexWorks(cleanQuery, Math.min(6, boundedLimit), timeoutMs),
  ]);

  const combined: ETGScientificCitation[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      combined.push(...r.value);
    }
  }

  const byKey = new Map<string, ETGScientificCitation>();
  for (const cit of combined) {
    const key = cit.doi ? `doi:${cit.doi}` : `title:${cit.title.toLowerCase().slice(0, 80)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, cit);
      continue;
    }
    // Prefer Crossref metadata + higher citation count, while preserving abstract_snippet
    const preferNew =
      (cit.source === "crossref" && prev.source !== "crossref") ||
      (cit.citation_count ?? 0) > (prev.citation_count ?? 0);
    if (preferNew) {
      byKey.set(key, {
        ...prev,
        ...cit,
        abstract_snippet: cit.abstract_snippet ?? prev.abstract_snippet,
        citation_count: Math.max(prev.citation_count ?? 0, cit.citation_count ?? 0) || undefined,
      });
    } else if (!prev.abstract_snippet && cit.abstract_snippet) {
      byKey.set(key, {
        ...prev,
        abstract_snippet: cit.abstract_snippet,
      });
    }
  }

  const baseResults = Array.from(byKey.values())
    .sort((a, b) => {
      const aHasDoi = a.doi ? 1 : 0;
      const bHasDoi = b.doi ? 1 : 0;
      if (aHasDoi !== bHasDoi) return bHasDoi - aHasDoi;
      return (b.citation_count ?? 0) - (a.citation_count ?? 0);
    })
    .slice(0, boundedLimit);

  if (baseResults.length > 0) {
    searchCache.set(cacheKey, {
      expiresAt: now + CACHE_TTL_SEARCH_MS,
      results: baseResults,
    });
  }
  return options?.claimContext
    ? baseResults.map((c) => evaluateCitationClaimStance(c, options.claimContext!))
    : baseResults;
}

const OFFICIAL_AGENCY_HOST_RE =
  /^https:\/\/(?:[^/]+\.)?(?:nasa\.gov|noaa\.gov|usgs\.gov|ipcc\.ch|copernicus\.eu|nsidc\.org|wmo\.int|doi\.org)\//i;

/**
 * Validates candidate citations against Crossref DOI resolution.
 * - Any citation whose DOI returns 404/invalid is stripped (preventing hallucinated DOIs from reaching the graph).
 * - Verified DOIs are enriched with canonical Crossref title, journal, citation count, and `doi_verified: true`.
 */
export async function verifyAndFilterCitations(
  citations: readonly ETGScientificCitation[],
  options?: {
    timeoutMs?: number;
    strictDropUnverifiedNonAgency?: boolean;
    claimContext?: ClaimStanceContext;
  }
): Promise<{ verified: ETGScientificCitation[]; rejectedDois: string[] }> {
  const verified: ETGScientificCitation[] = [];
  const rejectedDois: string[] = [];
  const seenKeys = new Set<string>();

  const scoreIfNeeded = (cit: ETGScientificCitation): ETGScientificCitation =>
    options?.claimContext
      ? evaluateCitationClaimStance(cit, options.claimContext)
      : cit;

  const timeoutMs = options?.timeoutMs ?? 3500;
  const outcomes = await Promise.all(
    citations.map(async (cit) => {
      const doi = normalizeDoiIdentifier(cit.doi);
      if (!doi) {
        return { cit, outcome: null as DoiVerificationOutcome | null };
      }
      const outcome = await verifyDoiMetadataDetailed(doi, { timeoutMs });
      return { cit, outcome };
    })
  );

  for (const { cit, outcome } of outcomes) {
    if (outcome) {
      if (outcome.status === "not_found") {
        rejectedDois.push(outcome.doi);
        continue;
      }
      if (outcome.status === "verified") {
        const merged: ETGScientificCitation = {
          ...cit,
          ...outcome.citation,
          abstract_snippet: outcome.citation.abstract_snippet ?? cit.abstract_snippet,
          claim_stance: outcome.citation.claim_stance ?? cit.claim_stance,
          stance_rationale: outcome.citation.stance_rationale ?? cit.stance_rationale,
        };
        const key = merged.doi ? `doi:${merged.doi}` : `title:${merged.title.toLowerCase()}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          verified.push(scoreIfNeeded(merged));
        }
        continue;
      }
      // Transient unavailability: retain curated or agency-grounded citations without spoofing doi_verified=true
      if (cit.source === "curated" || !options?.strictDropUnverifiedNonAgency) {
        const key = outcome.doi ? `doi:${outcome.doi}` : `title:${cit.title.toLowerCase()}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          verified.push(scoreIfNeeded({ ...cit, doi: outcome.doi }));
        }
      }
      continue;
    }

    // No DOI supplied: preserve agency observational citations & curated records
    const hasOfficialUrl = Boolean(cit.url && OFFICIAL_AGENCY_HOST_RE.test(cit.url));
    if (cit.source === "curated" || hasOfficialUrl || !options?.strictDropUnverifiedNonAgency) {
      const key = `title:${cit.title.toLowerCase()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        verified.push(scoreIfNeeded(cit));
      }
    }
  }

  return { verified, rejectedDois };
}

/**
 * Builds a structured claim-stance context from an ETG node's claim, trend slope, and region.
 */
export function buildNodeClaimStanceContext(node: ETGNode): ClaimStanceContext {
  const p = node.properties;
  const hay = `${p.name} ${p.description}`;
  let direction: ClaimStanceContext["direction"];
  if (/(opposite|dipole|teleconnect|warming hole|anticorrelat)/i.test(hay)) {
    direction = "opposite";
  } else if (typeof p.theil_sen_slope === "number" && Number.isFinite(p.theil_sen_slope)) {
    direction =
      p.theil_sen_slope > 0.0005
        ? "increasing"
        : p.theil_sen_slope < -0.0005
          ? "decreasing"
          : "stable";
  }
  return {
    claimText: `${p.name}. ${p.description}`,
    direction,
    region: p.region,
    parameter: p.parameter,
  };
}

/**
 * Generates a domain-focused scholarly search query for an ETG node.
 */
export function buildNodeLiteratureQuery(node: ETGNode): string {
  const p = node.properties;
  const hay = `${p.name} ${p.region || ""} ${p.dataset || ""} ${(p.domain_tags ?? []).join(" ")}`.toLowerCase();

  if (/warming hole|subpolar.*atlantic|amoc/.test(hay)) {
    return "North Atlantic warming hole AMOC slowdown sea surface temperature";
  }
  if (/arctic amplification|arctic surface/.test(hay)) {
    return "Arctic amplification warming sea ice loss feedback";
  }
  if (/sea ice/.test(hay)) {
    return "Arctic sea ice extent decline warming feedback";
  }
  if (/mackenzie|arctic river|discharge/.test(hay)) {
    return "Mackenzie Arctic river discharge hydrological climate change";
  }
  if (/chile|andes.*drought|south america.*aridity/.test(hay)) {
    return "Central Chile megadrought atmospheric circulation climate trend";
  }
  if (/indian ocean|horn of africa|east africa/.test(hay)) {
    return "Indian Ocean Dipole East Africa drought rainfall teleconnection";
  }
  if (/boulder|front range|colorado|wildfire/.test(hay)) {
    return "western North America vapor pressure deficit wildfire climate";
  }
  if (/co2|mauna loa|keeling/.test(hay)) {
    return "Mauna Loa atmospheric CO2 global warming climate trend";
  }
  if (/el nino|enso|nino|oni/.test(hay)) {
    return "El Nino Southern Oscillation global climate teleconnections";
  }
  if (/nao|north atlantic oscillation/.test(hay)) {
    return "North Atlantic Oscillation European climate hydroclimate trend";
  }
  if (/sahel/.test(hay)) {
    return "Sahel rainfall variability Atlantic warming trend";
  }

  const strippedName = p.name
    .replace(/\b(?:GDACS|EONET|NASA|NOAA|NSIDC|USGS|KNMI|ERA5|POWER)[-_:\s]*[A-Z0-9]*\b/gi, " ")
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const regionBit = p.region && !strippedName.toLowerCase().includes(p.region.toLowerCase())
    ? p.region
    : "";
  const paramBit = p.parameter || "";
  return `${strippedName} ${regionBit} ${paramBit} climate trend`.replace(/\s+/g, " ").trim().slice(0, 120);
}
