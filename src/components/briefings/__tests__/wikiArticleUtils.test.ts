import { describe, expect, it } from "vitest";
import {
  buildStructuredWikiSections,
  buildWikiCategories,
  buildWikiTocItems,
  cleanWikiTitle,
  extractInfoboxSeries,
  matchCitationFootnotes,
  parseMarkdownSections,
  parseWikiMarkdownBlocks,
} from "@/components/briefings/wikiArticleUtils";
import type { ETGNode, ETGResearchDossier, ETGScientificCitation } from "@/types/etg";

function makeTestNode(overrides?: Partial<ETGNode["properties"]>): ETGNode {
  return {
    uuid: "insight-test-node",
    label: "Insight",
    properties: {
      name: "Arctic Amplification Trend",
      description: "Polar warming accelerates faster than the mid-latitudes.",
      region: "Arctic Basin",
      dataset: "nasa_power",
      lat: 71.3,
      lng: -156.8,
      corroborated: true,
      theil_sen_slope: 0.72,
      slope_unit: "°C/decade",
      p_value: 0.0002,
      created_at: "2025-01-01T00:00:00Z",
      series: [
        { date: "2000-01", t: 2000, value: -11.2 },
        { date: "2010-01", t: 2010, value: -10.1 },
        { date: "2020-01", t: 2020, value: -8.9 },
      ],
      ...overrides,
    },
  };
}

const SAMPLE_CITATIONS: ETGScientificCitation[] = [
  {
    title: "The Arctic has warmed nearly four times faster than the globe",
    authors: "Rantanen M, Karpechko A, Lipponen A",
    journal: "Communications Earth & Environment",
    year: 2022,
    doi: "10.1038/s43247-022-00498-3",
    doi_verified: true,
  },
  {
    title: "AR6 Climate Change 2021: The Physical Science Basis",
    authors: "IPCC Working Group I",
    year: 2021,
  },
];

describe("cleanWikiTitle", () => {
  it("removes EONET numeric/GDACS suffixes and trailing machine identifiers while preserving geographic qualifiers", () => {
    expect(cleanWikiTitle("Front Range Complex (CO) 284910")).toBe(
      "Front Range Complex (CO)"
    );
    expect(cleanWikiTitle("Colorado Smoke Plume (EONET_6421)")).toBe(
      "Colorado Smoke Plume"
    );
    expect(cleanWikiTitle("Severe Storms GDACS-90211")).toBe("Severe Storms");
    expect(cleanWikiTitle("arctic_amplification_signal [signal-123456]")).toBe(
      "Arctic Amplification Signal"
    );
  });
});

describe("parseMarkdownSections & buildStructuredWikiSections", () => {
  it("parses ## sections and ### subsections into hierarchical numbered structure", () => {
    const parsed = parseMarkdownSections(`# Ignored H1 Title

Lead overview sentence before sections.

## Radiative forcing
Sea-ice albedo feedback lowers surface reflectivity.

### Lapse-rate feedback
Polar tropospheric stability traps warming near the surface.

## Hydrological coupling
Increased freshwater discharge enters the Arctic Ocean.
`);
    expect(parsed.preamble).toBe("Lead overview sentence before sections.");
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0].title).toBe("Radiative forcing");
    expect(parsed.sections[0].subsections).toHaveLength(1);
    expect(parsed.sections[0].subsections[0].title).toBe("Lapse-rate feedback");
    expect(parsed.sections[1].title).toBe("Hydrological coupling");
  });

  it("promotes ### sections to top-level sections when no ## exists and omits Abstract/References sections", () => {
    const parsed = parseMarkdownSections(`
### Executive Summary
Summary text folded into preamble.

### Empirical Signal Analysis
- Strong warming (+0.72 °C/dec).

### References
Duplicate heading ignored.
`);
    expect(parsed.preamble).toContain("Summary text folded into preamble.");
    expect(parsed.sections.map((s) => s.title)).toEqual(["Empirical Signal Analysis"]);
  });

  it("synthesizes structured Wikipedia sections from dossier fields when markdown_body is absent", () => {
    const dossier: ETGResearchDossier = {
      abstract: "Polar temperatures rose almost four times faster than global averages.",
      physical_mechanism: "Ice-albedo feedback amplifies absorbed shortwave solar radiation.",
      empirical_findings: ["Station slope +0.72 °C/dec (p < 0.001)."],
      impacts: ["Permafrost thaw accelerates methane release."],
      citations: SAMPLE_CITATIONS,
      updated_at: "2026-01-01T00:00:00Z",
    };

    const structured = buildStructuredWikiSections(dossier);
    expect(structured.leadParagraphs).toEqual([dossier.abstract]);
    expect(structured.sections.map((s) => s.title)).toEqual([
      "Physical mechanism",
      "Empirical observations and statistics",
      "Environmental and societal impacts",
    ]);

    const toc = buildWikiTocItems(structured.sections, {
      hasSignalsTable: true,
      hasSeeAlso: true,
      hasReferences: true,
    });
    expect(toc.map((t) => `${t.numberLabel} ${t.title}`)).toEqual([
      "1 Physical mechanism",
      "2 Empirical observations and statistics",
      "3 Environmental and societal impacts",
      "4 Linked observations & corroboration",
      "5 See also",
      "6 References",
    ]);
  });

  it("parses mixed paragraphs and bullet lists into distinct blocks", () => {
    const blocks = parseWikiMarkdownBlocks(`Intro paragraph here.
- First bullet
- Second bullet

Closing paragraph.`);
    expect(blocks).toEqual([
      { type: "paragraph", text: "Intro paragraph here." },
      { type: "ul", items: ["First bullet", "Second bullet"] },
      { type: "paragraph", text: "Closing paragraph." },
    ]);
  });
});

describe("matchCitationFootnotes", () => {
  it("converts valid [n] markers and parenthetical (Author, Year) citations without breaking ETG slugs", () => {
    const tokens = matchCitationFootnotes(
      "Warming quadrupled [1] according to (Rantanen et al., 2022) tracked via [signal-barrow-t2m] and [99].",
      SAMPLE_CITATIONS
    );

    const refs = tokens.filter((t) => t.type === "ref");
    expect(refs).toEqual([
      { type: "ref", citationIndex: 1, label: "[1]" },
      { type: "ref", citationIndex: 1, label: "[1]" },
    ]);

    const reconstructedText = tokens
      .filter((t) => t.type === "text")
      .map((t) => t.text)
      .join("");
    expect(reconstructedText).toContain("[signal-barrow-t2m]");
    expect(reconstructedText).toContain("[99]");
  });
});

describe("extractInfoboxSeries & buildWikiCategories", () => {
  it("extracts sorted series stats and generates clickable verification & region categories", () => {
    const node = makeTestNode();
    const series = extractInfoboxSeries(node);
    expect(series).not.toBeNull();
    expect(series?.points).toHaveLength(3);
    expect(series?.minVal).toBe(-11.2);
    expect(series?.maxVal).toBe(-8.9);

    const categories = buildWikiCategories(node);
    expect(categories.map((c) => c.label)).toContain("Earth Trend Insights");
    expect(categories.map((c) => c.label)).toContain("Temperature");
    expect(categories.map((c) => c.label)).toContain("Corroborated multi-source trends");
    expect(categories.map((c) => c.label)).toContain("Arctic Basin");
  });
});
