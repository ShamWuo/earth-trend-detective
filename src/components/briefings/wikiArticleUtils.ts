import { cleanEonetEventTitle, resolveNamedEarthRegion } from "@/lib/research/curatedTrendDossiers";
import { DATASET_BY_ID } from "@/lib/datasets";
import { describeGeographicZone, humanizeNodeText } from "@/lib/plainLanguage";
import type { ETGNode, ETGResearchDossier, ETGScientificCitation } from "@/types/etg";

export interface WikiSubsection {
  id: string;
  title: string;
  body: string;
}

export interface WikiSection {
  id: string;
  title: string;
  body: string;
  subsections: WikiSubsection[];
  /** Optional raw editor key if this section came from a structured field or markdown block. */
  editSectionKey?: "mechanism" | "findings" | "impacts" | "markdown";
}

export interface ParsedMarkdownArticle {
  preamble: string;
  sections: WikiSection[];
}

export interface WikiTocItem {
  id: string;
  numberLabel: string;
  title: string;
  level: 2 | 3;
}

export type WikiTextToken =
  | { type: "text"; text: string }
  | { type: "ref"; citationIndex: number; label: string };

export interface WikiInfoboxSeries {
  points: Array<{ label: string; value: number }>;
  minVal: number;
  maxVal: number;
  startLabel: string;
  endLabel: string;
  unit: string;
  slope?: number;
  slopeUnit?: string;
  pValue?: number;
  olsR2?: number;
}

export interface WikiCategoryItem {
  label: string;
  filterKind: "label" | "dataset" | "verification" | "search";
  filterValue: string;
}

export type WikiMarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const GENERIC_STUB_LEAD_RE = /^(executive summary|summary|abstract|overview)$/i;
const REDUNDANT_REF_HEADING_RE = /^(references|citations|bibliography|sources)$/i;

/**
 * Normalizes a node name into an encyclopedic Wikipedia article title:
 * strips EONET prefixes, raw machine/UUID suffixes, and normalizes typography.
 */
export function cleanWikiTitle(rawName: string): string {
  const withoutEonet = cleanEonetEventTitle(rawName || "").trim();
  const humanized = humanizeNodeText(withoutEonet).trim();
  let cleaned = humanized
    // Strip dangling bracketed IDs or internal EONET codes like "(EONET_6421)" or "[signal-abc]"
    .replace(/\s*\((?:EONET[_-]?[A-Z0-9-]+|signal-[a-z0-9-]+|insight-[a-z0-9-]+)\)\s*$/i, "")
    .replace(/\s*\[[a-z0-9._-]{6,}\]\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Convert snake_case machine identifiers (e.g. "arctic_amplification_signal") into readable Wikipedia headings
  if (cleaned && !cleaned.includes(" ") && /_/.test(cleaned)) {
    cleaned = cleaned
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return cleaned || rawName.trim() || "Untitled Earth Observation";
}

function slugifySectionId(title: string, usedIds: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const candidate = `sec-${base}`;
  if (!usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }
  let suffix = 2;
  while (usedIds.has(`${candidate}-${suffix}`)) {
    suffix++;
  }
  const unique = `${candidate}-${suffix}`;
  usedIds.add(unique);
  return unique;
}

/**
 * Parses markdown body into preamble text (lead) plus hierarchical sections (`##` and `###`).
 * If a document uses `###` headings without any `##` headings (common in seeded dossiers),
 * those `###` headings are promoted to top-level Wikipedia sections (`<h2>`).
 */
export function parseMarkdownSections(markdownBody?: string): ParsedMarkdownArticle {
  const raw = (markdownBody ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) {
    return { preamble: "", sections: [] };
  }

  const lines = raw.split("\n");
  const hasH2 = lines.some((l) => /^##(?!#)\s+\S/.test(l));
  const usedIds = new Set<string>();

  const preambleLines: string[] = [];
  const sections: WikiSection[] = [];
  let currentSection: WikiSection | null = null;
  let currentSub: WikiSubsection | null = null;
  let subLines: string[] = [];
  let secLines: string[] = [];

  const flushSub = () => {
    if (currentSection && currentSub) {
      currentSub.body = subLines.join("\n").trim();
      if (currentSub.body || currentSub.title) {
        currentSection.subsections.push(currentSub);
      }
      currentSub = null;
      subLines = [];
    }
  };

  const flushSection = () => {
    flushSub();
    if (currentSection) {
      currentSection.body = secLines.join("\n").trim();
      if (REDUNDANT_REF_HEADING_RE.test(currentSection.title)) {
        currentSection = null;
        secLines = [];
        return;
      }
      if (GENERIC_STUB_LEAD_RE.test(currentSection.title) && sections.length === 0) {
        if (currentSection.body) {
          preambleLines.push(currentSection.body);
        }
        currentSection = null;
        secLines = [];
        return;
      }
      if (currentSection.body || currentSection.subsections.length > 0) {
        sections.push(currentSection);
      }
      currentSection = null;
      secLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip single leading `# Article Title` line if present
    const h1Match = /^#(?!#)\s+(.+)$/.exec(line);
    if (h1Match && sections.length === 0 && !currentSection) {
      continue;
    }

    const h2Match = /^##(?!#)\s+(.+)$/.exec(line);
    const h3Match = /^###(?!#)\s+(.+)$/.exec(line);
    const h4Match = /^####(?!#)\s+(.+)$/.exec(line);

    if (h2Match || (!hasH2 && h3Match)) {
      flushSection();
      const rawTitle = (h2Match ? h2Match[1] : h3Match![1]).trim().replace(/^\d+(?:\.\d+)*\.?\s+/, "");
      currentSection = {
        id: slugifySectionId(rawTitle, usedIds),
        title: rawTitle,
        body: "",
        subsections: [],
        editSectionKey: "markdown",
      };
      continue;
    }

    if ((hasH2 && h3Match) || (!hasH2 && h4Match)) {
      const subTitle = (h3Match ? h3Match[1] : h4Match![1]).trim().replace(/^\d+(?:\.\d+)*\.?\s+/, "");
      if (!currentSection) {
        currentSection = {
          id: slugifySectionId("Background", usedIds),
          title: "Background",
          body: "",
          subsections: [],
          editSectionKey: "markdown",
        };
      }
      flushSub();
      currentSub = {
        id: slugifySectionId(subTitle, usedIds),
        title: subTitle,
        body: "",
      };
      continue;
    }

    if (currentSub) {
      subLines.push(line);
    } else if (currentSection) {
      secLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  flushSection();

  return {
    preamble: preambleLines.join("\n").trim(),
    sections,
  };
}

/**
 * Splits a markdown section body into paragraphs and list blocks for Wikipedia typography.
 */
export function parseWikiMarkdownBlocks(body: string): WikiMarkdownBlock[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  const blocks: WikiMarkdownBlock[] = [];
  const rawChunks = trimmed.split(/\n{2,}/);

  for (const chunk of rawChunks) {
    const lines = chunk
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    const isAllUnordered = lines.every((l) => /^\s*[-*•]\s+/.test(l));
    const isAllOrdered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));

    if (isAllUnordered) {
      blocks.push({
        type: "ul",
        items: lines.map((l) => l.replace(/^\s*[-*•]\s+/, "").trim()),
      });
      continue;
    }

    if (isAllOrdered) {
      blocks.push({
        type: "ol",
        items: lines.map((l) => l.replace(/^\s*\d+[.)]\s+/, "").trim()),
      });
      continue;
    }

    // Handle mixed lines inside one tight block (paragraph lines interleaved with bullets)
    let paraBuf: string[] = [];
    let ulBuf: string[] = [];
    let olBuf: string[] = [];

    const flushPara = () => {
      if (paraBuf.length > 0) {
        blocks.push({ type: "paragraph", text: paraBuf.join(" ") });
        paraBuf = [];
      }
    };
    const flushUl = () => {
      if (ulBuf.length > 0) {
        blocks.push({ type: "ul", items: ulBuf });
        ulBuf = [];
      }
    };
    const flushOl = () => {
      if (olBuf.length > 0) {
        blocks.push({ type: "ol", items: olBuf });
        olBuf = [];
      }
    };

    for (const line of lines) {
      if (/^\s*[-*•]\s+/.test(line)) {
        flushPara();
        flushOl();
        ulBuf.push(line.replace(/^\s*[-*•]\s+/, "").trim());
      } else if (/^\s*\d+[.)]\s+/.test(line)) {
        flushPara();
        flushUl();
        olBuf.push(line.replace(/^\s*\d+[.)]\s+/, "").trim());
      } else {
        flushUl();
        flushOl();
        paraBuf.push(line.trim());
      }
    }
    flushPara();
    flushUl();
    flushOl();
  }

  return blocks;
}

/**
 * Builds numbered Wikipedia Contents (`toc`) items from sections plus trailing structural blocks.
 */
export function buildWikiTocItems(
  sections: readonly WikiSection[],
  options?: {
    hasSignalsTable?: boolean;
    hasSeeAlso?: boolean;
    hasReferences?: boolean;
  }
): WikiTocItem[] {
  const items: WikiTocItem[] = [];
  let secNum = 1;

  for (const sec of sections) {
    items.push({
      id: sec.id,
      numberLabel: String(secNum),
      title: sec.title,
      level: 2,
    });
    sec.subsections.forEach((sub, idx) => {
      items.push({
        id: sub.id,
        numberLabel: `${secNum}.${idx + 1}`,
        title: sub.title,
        level: 3,
      });
    });
    secNum++;
  }

  if (options?.hasSignalsTable) {
    items.push({
      id: "sec-linked-signals",
      numberLabel: String(secNum++),
      title: "Linked observations & corroboration",
      level: 2,
    });
  }

  if (options?.hasSeeAlso) {
    items.push({
      id: "sec-see-also",
      numberLabel: String(secNum++),
      title: "See also",
      level: 2,
    });
  }

  if (options?.hasReferences) {
    items.push({
      id: "sec-references",
      numberLabel: String(secNum++),
      title: "References",
      level: 2,
    });
  }

  return items;
}

/**
 * Resolves full Wikipedia lead paragraphs + structured sections from an ETGResearchDossier,
 * avoiding duplicate prose when `markdown_body` mirrors structured fields.
 */
export function buildStructuredWikiSections(dossier: ETGResearchDossier): {
  leadParagraphs: string[];
  sections: WikiSection[];
} {
  const parsed = parseMarkdownSections(dossier.markdown_body);
  const abstractTrim = (dossier.abstract ?? "").trim();
  const leadParagraphs: string[] = [];

  if (abstractTrim) {
    leadParagraphs.push(abstractTrim);
  }
  if (parsed.preamble) {
    const preambleBlocks = parseWikiMarkdownBlocks(parsed.preamble);
    for (const block of preambleBlocks) {
      if (block.type === "paragraph") {
        const normalized = block.text.trim();
        if (
          normalized &&
          !leadParagraphs.some(
            (existing) =>
              existing.toLowerCase().includes(normalized.slice(0, 48).toLowerCase()) ||
              normalized.toLowerCase().includes(existing.slice(0, 48).toLowerCase())
          )
        ) {
          leadParagraphs.push(normalized);
        }
      }
    }
  }

  // Prefer structured sections + merge extra non-overlapping markdown sections
  const sections: WikiSection[] = [];
  const usedIds = new Set<string>();

  if (parsed.sections.length >= 2) {
    for (const sec of parsed.sections) {
      const id = usedIds.has(sec.id) ? `${sec.id}-${usedIds.size + 1}` : sec.id;
      usedIds.add(id);
      sections.push({ ...sec, id });
    }
    return { leadParagraphs, sections };
  }

  const mechTrim = (dossier.physical_mechanism ?? "").trim();
  if (mechTrim) {
    sections.push({
      id: slugifySectionId("Physical mechanism", usedIds),
      title: "Physical mechanism",
      body: mechTrim,
      subsections: [],
      editSectionKey: "mechanism",
    });
  }

  if (dossier.empirical_findings && dossier.empirical_findings.length > 0) {
    sections.push({
      id: slugifySectionId("Empirical observations and statistics", usedIds),
      title: "Empirical observations and statistics",
      body: dossier.empirical_findings.map((item) => `- ${item}`).join("\n"),
      subsections: [],
      editSectionKey: "findings",
    });
  }

  if (dossier.impacts && dossier.impacts.length > 0) {
    sections.push({
      id: slugifySectionId("Environmental and societal impacts", usedIds),
      title: "Environmental and societal impacts",
      body: dossier.impacts.map((item) => `- ${item}`).join("\n"),
      subsections: [],
      editSectionKey: "impacts",
    });
  }

  for (const extraSec of parsed.sections) {
    const lower = extraSec.title.toLowerCase();
    const alreadyCovered = sections.some((s) =>
      s.title.toLowerCase().includes(lower) || lower.includes(s.title.toLowerCase().split(" ")[0])
    );
    if (!alreadyCovered) {
      sections.push({
        ...extraSec,
        id: slugifySectionId(extraSec.title, usedIds),
      });
    }
  }

  return { leadParagraphs, sections };
}

function extractSurname(authors: string): string | null {
  const firstAuthor = authors.split(/[,;&]|\band\b/i)[0]?.trim() ?? "";
  if (!firstAuthor) return null;
  const cleaned = firstAuthor.replace(/\bet al\.?/i, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  // Handle "Last, F." vs "First Last"
  if (authors.includes(",") && parts.length >= 1) {
    return parts[0].replace(/[^A-Za-zÀ-ÖØ-öø-ÿ-]/g, "");
  }
  const surname = parts[parts.length - 1].replace(/[^A-Za-zÀ-ÖØ-öø-ÿ-]/g, "");
  return surname.length >= 3 ? surname : null;
}

/**
 * Matches explicit `[n]` footnote markers (1 <= n <= citations.length) and parenthetical
 * `(Author, Year)` / `(Author et al., Year)` citations in prose into structured footnote runs.
 */
export function matchCitationFootnotes(
  text: string,
  citations: readonly ETGScientificCitation[]
): WikiTextToken[] {
  if (!text) return [];
  if (citations.length === 0) {
    return [{ type: "text", text }];
  }

  const surnameIndexPairs = citations.map((c, idx) => ({
    index: idx + 1,
    surname: extractSurname(c.authors)?.toLowerCase() ?? null,
    year: String(c.year),
  }));

  // Match either `[1]` / `[1, 2]` footnote markers OR `(Author et al., 2022)` parenthetical citations.
  // Excludes bracketed ETG IDs like `[signal-...]` or numbers > citations.length.
  const pattern =
    /(\[\d{1,2}(?:\s*,\s*\d{1,2})*\]|\([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]+(?:\s+(?:et al\.?|&\s+[A-Z][A-Za-z'-]+))?,?\s+(?:19|20)\d{2}[a-z]?\))/g;

  const tokens: WikiTextToken[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string) => {
    if (!chunk) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.type === "text") {
      prev.text += chunk;
    } else {
      tokens.push({ type: "text", text: chunk });
    }
  };

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      pushText(text.slice(lastIdx, match.index));
    }
    const raw = match[0];

    if (raw.startsWith("[") && raw.endsWith("]")) {
      const nums = raw
        .slice(1, -1)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= citations.length);

      if (nums.length > 0) {
        for (const n of nums) {
          tokens.push({ type: "ref", citationIndex: n, label: `[${n}]` });
        }
      } else {
        pushText(raw);
      }
    } else {
      // Parenthetical author-year citation: preserve the readable prose and attach matching superscript
      pushText(raw);
      const lowerRaw = raw.toLowerCase();
      const hit = surnameIndexPairs.find(
        (pair) => pair.surname && lowerRaw.includes(pair.surname) && lowerRaw.includes(pair.year)
      );
      if (hit) {
        tokens.push({
          type: "ref",
          citationIndex: hit.index,
          label: `[${hit.index}]`,
        });
      }
    }

    lastIdx = pattern.lastIndex;
  }

  if (lastIdx < text.length) {
    pushText(text.slice(lastIdx));
  }

  return tokens;
}

/**
 * Extracts normalized series points for the Wikipedia Infobox trend sparkline/regression chart.
 */
export function extractInfoboxSeries(node: ETGNode): WikiInfoboxSeries | null {
  const p = node.properties;
  const rawSeries = Array.isArray(p.series) ? p.series : [];
  const rawSparkline = Array.isArray(p.sparkline_preview) ? p.sparkline_preview : [];

  let points: Array<{ label: string; value: number }> = [];
  if (rawSeries.length >= 2) {
    const sorted = [...rawSeries]
      .filter((pt) => typeof pt.value === "number" && Number.isFinite(pt.value))
      .sort((a, b) => a.t - b.t);
    const maxSamples = 48;
    const stride = sorted.length > maxSamples ? Math.ceil(sorted.length / maxSamples) : 1;
    const sampled = sorted.filter((_, idx) => idx % stride === 0 || idx === sorted.length - 1);
    points = sampled.map((pt) => ({ label: pt.date, value: pt.value }));
  } else if (rawSparkline.length >= 2) {
    points = rawSparkline
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .map((v, idx) => ({ label: `t${idx + 1}`, value: v }));
  }

  if (points.length < 2) return null;

  let minVal = points[0].value;
  let maxVal = points[0].value;
  for (const pt of points) {
    if (pt.value < minVal) minVal = pt.value;
    if (pt.value > maxVal) maxVal = pt.value;
  }

  const datasetMeta = p.dataset ? DATASET_BY_ID[p.dataset] : undefined;

  return {
    points,
    minVal,
    maxVal,
    startLabel: points[0].label,
    endLabel: points[points.length - 1].label,
    unit: p.unit || datasetMeta?.unit || "",
    slope: typeof p.theil_sen_slope === "number" ? p.theil_sen_slope : undefined,
    slopeUnit: p.slope_unit || datasetMeta?.slopeUnit || "",
    pValue: typeof p.p_value_adjusted === "number" ? p.p_value_adjusted : p.p_value,
    olsR2: typeof p.ols_r2 === "number" ? p.ols_r2 : undefined,
  };
}

/**
 * Generates clickable Wikipedia bottom Categories (`Categories:` box) wired into article filters.
 */
export function buildWikiCategories(node: ETGNode): WikiCategoryItem[] {
  const p = node.properties;
  const items: WikiCategoryItem[] = [];
  const labelPlural: Record<ETGNode["label"], string> = {
    Insight: "Earth Trend Insights",
    Signal: "Environmental Signals",
    Concept: "Earth System Concepts",
    Rule: "Corroboration Rules",
  };
  items.push({
    label: labelPlural[node.label] ?? node.label,
    filterKind: "label",
    filterValue: node.label,
  });

  if (p.dataset) {
    const meta = DATASET_BY_ID[p.dataset];
    if (meta) {
      items.push({
        label: meta.shortLabel,
        filterKind: "dataset",
        filterValue: p.dataset,
      });
    }
  }

  if (p.status === "Superseded") {
    items.push({
      label: "Superseded assessments",
      filterKind: "verification",
      filterValue: "superseded",
    });
  } else if (p.contested) {
    items.push({
      label: "Contested observations",
      filterKind: "verification",
      filterValue: "contested",
    });
  } else if (p.corroborated) {
    items.push({
      label: "Corroborated multi-source trends",
      filterKind: "verification",
      filterValue: "corroborated",
    });
  }

  if (typeof p.lat === "number" && typeof p.lng === "number") {
    const zone = describeGeographicZone(p.lat, p.lng);
    const resolved = p.region?.trim() || resolveNamedEarthRegion(p.lat, p.lng);
    const regionLabel = resolved && resolved.length <= 36 ? resolved : zone;
    items.push({
      label: regionLabel,
      filterKind: "search",
      filterValue: regionLabel.split(",")[0].trim(),
    });
  } else if (p.region && p.region.trim()) {
    items.push({
      label: p.region.trim(),
      filterKind: "search",
      filterValue: p.region.trim(),
    });
  }

  return items;
}
