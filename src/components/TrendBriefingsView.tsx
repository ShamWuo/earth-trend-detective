"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Download,
  FilePenLine,
  Globe2,
  Loader2,
  Network,
  Printer,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { DATASET_BY_ID } from "@/lib/datasets";
import { formatEdgeRelationLabel } from "@/lib/graph/graphVisuals";
import { formatCoordShort } from "@/lib/plainLanguage";
import { resolveNamedEarthRegion } from "@/lib/research/curatedTrendDossiers";
import { buildLiveTelemetryBriefingFallback, exportDossierToMarkdown } from "@/lib/research/dossierUtils";
import { renderFormattedBriefing } from "@/components/workbench/briefingFormatUtils";
import type { ETGEdge, ETGNode, ETGResearchDossier } from "@/types/etg";
import {
  PaperAuditAndHistoryPanel,
  WikiSourceEditorPanel,
  type LinkedArticleRelation,
} from "./briefings/WikiAuditAndEditorTabs";
import { PaperFigureBlock } from "./briefings/WikiInfobox";
import { WikiReferencesSection } from "./briefings/WikiReferencesSection";
import {
  buildStructuredWikiSections,
  buildWikiCategories,
  cleanWikiTitle,
  matchCitationFootnotes,
  parseWikiMarkdownBlocks,
} from "./briefings/wikiArticleUtils";

export interface TrendBriefingsViewProps {
  nodes: readonly ETGNode[];
  edges: readonly ETGEdge[];
  initialNodeUuid?: string | null;
  backLabel?: string;
  onActiveArticleChange?: (nodeUuid: string) => void;
  onLocateOnGlobe?: (node: ETGNode) => void;
  onOpenInGraph?: (node: ETGNode) => void;
  onBackToCanvas?: () => void;
  onRefreshGraph?: () => Promise<void> | void;
}

type ReaderMode = "read" | "audit" | "edit";

function scoreArticleRank(node: ETGNode): number {
  let score = 0;
  if (node.properties.dossier) score += 200;
  if (node.label === "Insight") score += 60;
  else if (node.label === "Signal") score += 45;
  else if (node.label === "Concept") score += 30;
  else score += 10;
  if (node.properties.corroborated) score += 25;
  if (node.properties.status === "Superseded") score -= 40;
  if (typeof node.properties.p_value === "number" && node.properties.p_value < 0.05) score += 15;
  if (typeof node.properties.lat === "number" && typeof node.properties.lng === "number") score += 10;
  score += Math.min(20, Math.round((node.properties.importance ?? 0.5) * 10));
  return score;
}

function formatDateLong(iso?: string): string {
  if (!iso) return "Current revision";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function TrendBriefingsView({
  nodes,
  edges,
  initialNodeUuid,
  backLabel = "Back to canvas",
  onActiveArticleChange,
  onLocateOnGlobe,
  onOpenInGraph,
  onBackToCanvas,
  onRefreshGraph,
}: TrendBriefingsViewProps) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.uuid, n])), [nodes]);

  const rankedNodes = useMemo(
    () =>
      [...nodes].sort((a, b) => {
        const diff = scoreArticleRank(b) - scoreArticleRank(a);
        if (diff !== 0) return diff;
        return cleanWikiTitle(a.properties.name).localeCompare(cleanWikiTitle(b.properties.name));
      }),
    [nodes]
  );

  const [selectedUuid, setSelectedUuid] = useState<string | null>(() => {
    if (initialNodeUuid && nodes.some((n) => n.uuid === initialNodeUuid)) {
      return initialNodeUuid;
    }
    return rankedNodes[0]?.uuid ?? null;
  });

  // Sync external navigation targets (e.g., CompactSpotCard -> Paper or URL ?briefing=)
  useEffect(() => {
    if (initialNodeUuid && nodeById.has(initialNodeUuid) && initialNodeUuid !== selectedUuid) {
      setSelectedUuid(initialNodeUuid);
      setReaderMode("read");
      setSynthesisNotice(null);
    }
  }, [initialNodeUuid, nodeById]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeNode = useMemo(() => {
    if (selectedUuid && nodeById.has(selectedUuid)) {
      return nodeById.get(selectedUuid)!;
    }
    return rankedNodes[0] ?? null;
  }, [selectedUuid, nodeById, rankedNodes]);

  useEffect(() => {
    if (activeNode && onActiveArticleChange) {
      onActiveArticleChange(activeNode.uuid);
    }
  }, [activeNode?.uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  const [readerMode, setReaderMode] = useState<ReaderMode>("read");
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthesisNotice, setSynthesisNotice] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const activeDossier: ETGResearchDossier | null = useMemo(() => {
    if (!activeNode) return null;
    if (activeNode.properties.dossier) {
      return activeNode.properties.dossier;
    }
    return buildLiveTelemetryBriefingFallback(activeNode, edges, nodeById);
  }, [activeNode, edges, nodeById]);

  const isTelemetryFallback = Boolean(activeNode && !activeNode.properties.dossier);

  const linkedRelations = useMemo<LinkedArticleRelation[]>(() => {
    if (!activeNode) return [];
    const list: LinkedArticleRelation[] = [];
    for (const edge of edges) {
      if (edge.source_uuid === activeNode.uuid) {
        const other = nodeById.get(edge.target_uuid);
        if (other) {
          list.push({ edge, other, direction: "outgoing" });
        }
      } else if (edge.target_uuid === activeNode.uuid) {
        const other = nodeById.get(edge.source_uuid);
        if (other) {
          list.push({ edge, other, direction: "incoming" });
        }
      }
    }
    return list;
  }, [activeNode, edges, nodeById]);

  const structuredArticle = useMemo(() => {
    if (!activeDossier) return { leadParagraphs: [], sections: [] };
    return buildStructuredWikiSections(activeDossier);
  }, [activeDossier]);

  const selectPaperNode = (target: ETGNode) => {
    setSelectedUuid(target.uuid);
    setReaderMode("read");
    setSynthesisNotice(null);
    scrollRootRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSynthesizeWithAI = async () => {
    if (!activeNode) return;
    setSynthesizing(true);
    setSynthesisNotice(null);
    try {
      const res = await fetch("/api/ai/detective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedNodeUuid: activeNode.uuid,
          question: `Synthesize a full peer-reviewed working paper dossier for "${cleanWikiTitle(
            activeNode.properties.name
          )}" citing empirical statistics and linked ETG nodes.`,
          synthesizeDossier: true,
          applyEdits: true,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        appliedActions?: Array<{ summary: string }>;
        blockedActions?: Array<{ reason: string }>;
      };
      if (!res.ok) {
        throw new Error(data.error || `AI synthesis failed (HTTP ${res.status})`);
      }
      if (onRefreshGraph) {
        await onRefreshGraph();
      }
      const appliedCount = data.appliedActions?.length ?? 0;
      const blockedReason = data.blockedActions?.[0]?.reason;
      setSynthesisNotice({
        kind: appliedCount > 0 ? "success" : blockedReason ? "error" : "success",
        text:
          appliedCount > 0
            ? `Updated working paper with AI synthesis and verified citations (${appliedCount} graph update${appliedCount === 1 ? "" : "s"}).`
            : blockedReason || "Synthesis verification completed.",
      });
      setReaderMode("read");
    } catch (err) {
      setSynthesisNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to run AI synthesis",
      });
    } finally {
      setSynthesizing(false);
    }
  };

  const handleExportMarkdown = () => {
    if (!activeNode || !activeDossier) return;
    const md = exportDossierToMarkdown(activeNode, activeDossier);
    const slug = cleanWikiTitle(activeNode.properties.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug || activeNode.uuid}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  if (!activeNode || !activeDossier) {
    return (
      <div className="etg-paper-scroll-root flex h-full w-full items-center justify-center p-6">
        <div className="etg-paper-sheet max-w-md border border-[var(--paper-rule)] p-6 text-center">
          <BookOpen className="mx-auto mb-3 h-7 w-7 text-[var(--paper-ink-muted)]" aria-hidden="true" />
          <h1 className="etg-paper-title text-[20px]">Working Papers &amp; Briefings</h1>
          <p className="mt-2 font-sans text-[13.5px] text-[var(--paper-ink-muted)]">
            No ETG observations or insights are currently loaded in the Knowledge Graph.
          </p>
          {onBackToCanvas && (
            <button
              type="button"
              onClick={onBackToCanvas}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xs border border-[var(--paper-rule-strong)] bg-[var(--paper-surface)] px-3.5 py-1.5 font-sans text-[12.5px] font-medium text-[var(--paper-ink)] cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{backLabel}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const p = activeNode.properties;
  const paperTitle = cleanWikiTitle(p.name);
  const keywords = buildWikiCategories(activeNode).map((c) => c.label);
  const datasetMeta = p.dataset ? DATASET_BY_ID[p.dataset] : undefined;

  const hasGeo =
    typeof p.lat === "number" &&
    Number.isFinite(p.lat) &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lng);

  const regionLine = hasGeo
    ? `${p.region?.trim() || resolveNamedEarthRegion(p.lat!, p.lng!, paperTitle)} · ${formatCoordShort(p.lat!, p.lng!)}`
    : p.region?.trim() || "Planetary / Multi-Basin Domain";

  const supersededByEdge = linkedRelations.find(
    (r) => r.edge.type === "supersedes" && r.direction === "incoming"
  );
  const contradictions = linkedRelations.filter((r) => r.edge.type === "contradicts");

  // Strict-Mode safe deterministic inline footnote tracking across Abstract + Sections
  const seenCitationRefs = new Set<number>();
  const citations = activeDossier.citations ?? [];

  const renderPaperText = (text: string, fallbackCitationNumbers?: number[]) => {
    const tokens = matchCitationFootnotes(text, citations);
    const hasExplicitRef = tokens.some((t) => t.type === "ref");

    return (
      <>
        {tokens.map((tok, idx) => {
          if (tok.type === "text") {
            return (
              <React.Fragment key={`txt-${idx}`}>
                {renderFormattedBriefing(tok.text, nodeById, selectPaperNode, {
                  variant: "paper",
                })}
              </React.Fragment>
            );
          }
          const isFirst = !seenCitationRefs.has(tok.citationIndex);
          if (isFirst) seenCitationRefs.add(tok.citationIndex);
          return (
            <sup
              key={`ref-${tok.citationIndex}-${idx}`}
              id={isFirst ? `cite-ref-${tok.citationIndex}` : undefined}
              className="etg-paper-ref"
            >
              <a
                href={`#cite-note-${tok.citationIndex}`}
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById(`cite-note-${tok.citationIndex}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                title={citations[tok.citationIndex - 1]?.title}
              >
                {tok.label}
              </a>
            </sup>
          );
        })}
        {!hasExplicitRef &&
          fallbackCitationNumbers &&
          fallbackCitationNumbers.map((citNum) => {
            if (citNum < 1 || citNum > citations.length) return null;
            const isFirst = !seenCitationRefs.has(citNum);
            if (isFirst) seenCitationRefs.add(citNum);
            return (
              <sup
                key={`fb-ref-${citNum}`}
                id={isFirst ? `cite-ref-${citNum}` : undefined}
                className="etg-paper-ref"
              >
                <a
                  href={`#cite-note-${citNum}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById(`cite-note-${citNum}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                  title={citations[citNum - 1]?.title}
                >
                  [{citNum}]
                </a>
              </sup>
            );
          })}
      </>
    );
  };

  const bodySectionCount = structuredArticle.sections.length;
  const couplingsSectionNum = bodySectionCount + 1;
  const referencesSectionNum = bodySectionCount + (linkedRelations.length > 0 ? 2 : 1);

  const hasAnyInlineRefInBody =
    structuredArticle.leadParagraphs.some((para) =>
      matchCitationFootnotes(para, citations).some((t) => t.type === "ref")
    ) ||
    structuredArticle.sections.some(
      (s) =>
        matchCitationFootnotes(s.body, citations).some((t) => t.type === "ref") ||
        s.subsections.some((sub) =>
          matchCitationFootnotes(sub.body, citations).some((t) => t.type === "ref")
        )
    );

  const abstractFallbackCits =
    !hasAnyInlineRefInBody && citations.length > 0
      ? citations.slice(0, Math.min(2, citations.length)).map((_, i) => i + 1)
      : undefined;

  const provenanceLabel =
    activeDossier.researched_by === "agency_curation"
      ? "Agency-curated synthesis"
      : activeDossier.researched_by === "ai_detective"
        ? "AI Detective synthesis"
        : activeDossier.researched_by === "human"
          ? "Investigator-edited manuscript"
          : "Auto-compiled from empirical telemetry";

  const sourceLine =
    p.provenance_source || datasetMeta?.sourceName || p.source_system || "NASA / NOAA Telemetry";

  const updatedDate = formatDateLong(activeDossier.updated_at);

  return (
    <div
      ref={scrollRootRef}
      className="etg-paper-scroll-root h-full w-full overflow-y-auto"
      data-testid="paper-briefings-view"
    >
      <div className="mx-auto w-full max-w-[820px] px-3 py-5 sm:px-6 sm:py-7">
        {/* Slim Non-Intrusive Reader Utility Bar */}
        <div className="etg-paper-toolbar no-print mb-4 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[var(--paper-ink-muted)]">
          <div className="flex min-w-0 items-center gap-2">
            {onBackToCanvas && (
              <button
                type="button"
                onClick={onBackToCanvas}
                className="inline-flex shrink-0 items-center gap-1 rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1 font-medium text-[var(--paper-ink)] hover:border-[var(--paper-rule-strong)] cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{backLabel}</span>
              </button>
            )}

            <label htmlFor="paper-node-switcher" className="sr-only">
              Select research paper
            </label>
            <select
              id="paper-node-switcher"
              value={activeNode.uuid}
              onChange={(e) => {
                const chosen = nodeById.get(e.target.value);
                if (chosen) selectPaperNode(chosen);
              }}
              className="max-w-[210px] truncate rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2 py-1 text-[12px] text-[var(--paper-ink)] sm:max-w-[300px]"
            >
              {rankedNodes.map((n) => (
                <option key={n.uuid} value={n.uuid}>
                  {cleanWikiTitle(n.properties.name)} ({n.label})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {readerMode !== "read" && (
              <button
                type="button"
                onClick={() => setReaderMode("read")}
                className="inline-flex items-center gap-1 rounded-xs border border-[var(--paper-accent)] bg-[var(--paper-sheet)] px-2 py-1 font-medium text-[var(--paper-accent)] cursor-pointer"
              >
                <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Read paper</span>
              </button>
            )}

            {onLocateOnGlobe && (
              <button
                type="button"
                onClick={() => onLocateOnGlobe(activeNode)}
                title="Inspect this observation on the 3D Earth Globe"
                className="inline-flex items-center gap-1 rounded-xs px-2 py-1 hover:bg-[var(--paper-surface)] hover:text-[var(--paper-ink)] cursor-pointer"
              >
                <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Globe</span>
              </button>
            )}
            {onOpenInGraph && (
              <button
                type="button"
                onClick={() => onOpenInGraph(activeNode)}
                title="Inspect this observation in the Knowledge Graph"
                className="inline-flex items-center gap-1 rounded-xs px-2 py-1 hover:bg-[var(--paper-surface)] hover:text-[var(--paper-ink)] cursor-pointer"
              >
                <Network className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Graph</span>
              </button>
            )}

            <span aria-hidden="true" className="mx-0.5 text-[var(--paper-rule-strong)]">
              |
            </span>

            <button
              type="button"
              onClick={() => setReaderMode((m) => (m === "audit" ? "read" : "audit"))}
              className={`inline-flex items-center gap-1 rounded-xs px-2 py-1 cursor-pointer ${
                readerMode === "audit"
                  ? "bg-[var(--paper-surface)] font-semibold text-[var(--paper-ink)]"
                  : "hover:bg-[var(--paper-surface)] hover:text-[var(--paper-ink)]"
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                Audit{contradictions.length > 0 ? ` (${contradictions.length})` : ""}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setReaderMode((m) => (m === "edit" ? "read" : "edit"))}
              className={`inline-flex items-center gap-1 rounded-xs px-2 py-1 cursor-pointer ${
                readerMode === "edit"
                  ? "bg-[var(--paper-surface)] font-semibold text-[var(--paper-ink)]"
                  : "hover:bg-[var(--paper-surface)] hover:text-[var(--paper-ink)]"
              }`}
            >
              <FilePenLine className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Edit</span>
            </button>

            <button
              type="button"
              onClick={handleSynthesizeWithAI}
              disabled={synthesizing}
              className="inline-flex items-center gap-1 rounded-xs px-2 py-1 hover:bg-[var(--paper-surface)] hover:text-[var(--paper-ink)] disabled:opacity-55 cursor-pointer"
            >
              {synthesizing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">
                {synthesizing ? "Synthesizing..." : "Synthesize"}
              </span>
            </button>

            <button
              type="button"
              onClick={handleExportMarkdown}
              title="Download Markdown manuscript"
              className="inline-flex items-center gap-1 rounded-xs px-2 py-1 hover:bg-[var(--paper-surface)] hover:text-[var(--paper-ink)] cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>.md</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              title="Print working paper"
              className="inline-flex items-center gap-1 rounded-xs px-2 py-1 hover:bg-[var(--paper-surface)] hover:text-[var(--paper-ink)] cursor-pointer"
            >
              <Printer className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Print</span>
            </button>
          </div>
        </div>

        {/* Centered Single-Column Scientific Paper Sheet */}
        <article
          aria-labelledby="paper-article-title"
          className="etg-paper-sheet border border-[var(--paper-rule)] px-5 py-7 shadow-xs sm:px-12 sm:py-10"
        >
          {/* Running Paper Kicker Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--paper-rule)] pb-2.5 font-mono text-[10.5px] uppercase tracking-wider text-[var(--paper-ink-muted)]">
            <span>Earth Trend Graph · Working Paper</span>
            <span>
              {activeNode.label} · {updatedDate}
            </span>
          </div>

          {/* Paper Title & Attribution Header */}
          <header className="mt-5">
            <h1 id="paper-article-title" className="etg-paper-title">
              {paperTitle}
            </h1>
            <p className="mt-2.5 font-sans text-[12.5px] text-[var(--paper-ink-muted)]">
              {provenanceLabel}
              {isTelemetryFallback ? " · Empirical telemetry compilation" : ""}
              {" · "}
              {sourceLine}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--paper-ink-muted)]">
              {regionLine}
              {datasetMeta ? ` · ${datasetMeta.shortLabel}` : ""}
            </p>
          </header>

          {/* Transient AI Synthesis / Save Notice */}
          {synthesisNotice && (
            <div
              role="status"
              className={`mt-4 flex items-start gap-2.5 rounded-xs border px-3.5 py-2.5 font-sans text-[12.5px] ${
                synthesisNotice.kind === "success"
                  ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-rose-500/35 bg-rose-500/10 text-rose-600 dark:text-rose-300"
              }`}
            >
              {synthesisNotice.kind === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <div className="flex-1">{synthesisNotice.text}</div>
              <button
                type="button"
                onClick={() => setSynthesisNotice(null)}
                aria-label="Dismiss notification"
                className="cursor-pointer opacity-70 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Reader Mode Switching: Audit | Edit | Manuscript */}
          {readerMode === "audit" && (
            <div className="mt-6">
              <PaperAuditAndHistoryPanel
                node={activeNode}
                dossier={activeDossier}
                relations={linkedRelations}
                onSelectNode={selectPaperNode}
                onExportMarkdown={handleExportMarkdown}
                onSynthesizeWithAI={handleSynthesizeWithAI}
                synthesizing={synthesizing}
              />
            </div>
          )}

          {readerMode === "edit" && (
            <div className="mt-6">
              <WikiSourceEditorPanel
                node={activeNode}
                dossier={activeDossier}
                onSaved={async () => {
                  if (onRefreshGraph) await onRefreshGraph();
                  setReaderMode("read");
                  setSynthesisNotice({
                    kind: "success",
                    text: "Saved manuscript edits to the Earth Trend Graph.",
                  });
                }}
                onCancel={() => setReaderMode("read")}
              />
            </div>
          )}

          {readerMode === "read" && (
            <div>
              {/* Discrete Epistemic Caveats (Supersession or Competing Evidence) */}
              {(supersededByEdge || contradictions.length > 0) && (
                <div className="mt-5 space-y-2">
                  {supersededByEdge && (
                    <div className="border-l-2 border-amber-500/75 bg-[var(--paper-surface)]/75 px-3.5 py-2 font-sans text-[12.5px] text-[var(--paper-ink)]">
                      <strong className="font-semibold">Revision note:</strong> Earlier finding
                      superseded by{" "}
                      <button
                        type="button"
                        onClick={() => selectPaperNode(supersededByEdge.other)}
                        className="etg-paper-cite font-medium"
                      >
                        {cleanWikiTitle(supersededByEdge.other.properties.name)}
                      </button>
                      .
                    </div>
                  )}
                  {contradictions.length > 0 && (
                    <div className="border-l-2 border-rose-500/75 bg-[var(--paper-surface)]/75 px-3.5 py-2 font-sans text-[12.5px] text-[var(--paper-ink)]">
                      <strong className="font-semibold">
                        Competing evidence ({contradictions.length}):
                      </strong>{" "}
                      Disputing telemetry edges are attached; review details in{" "}
                      <button
                        type="button"
                        onClick={() => setReaderMode("audit")}
                        className="etg-paper-cite font-medium"
                      >
                        Epistemic Audit
                      </button>
                      .
                    </div>
                  )}
                </div>
              )}

              {/* Formal Academic Abstract Block */}
              <section aria-labelledby="paper-abstract-heading" className="etg-paper-abstract">
                <h2
                  id="paper-abstract-heading"
                  className="mb-2 font-sans text-[11px] font-bold uppercase tracking-widest text-[var(--paper-ink-muted)]"
                >
                  Abstract
                </h2>
                <div className="etg-paper-body">
                  {structuredArticle.leadParagraphs.map((para, pIdx) => (
                    <p key={`abs-${pIdx}`} className={pIdx === 0 ? "!mt-0" : ""}>
                      {renderPaperText(para, pIdx === 0 ? abstractFallbackCits : undefined)}
                    </p>
                  ))}
                </div>
                {keywords.length > 0 && (
                  <p className="mt-2.5 mb-0 font-sans text-[11.5px] text-[var(--paper-ink-muted)]">
                    <span className="font-semibold text-[var(--paper-ink)]">Keywords: </span>
                    {keywords.join(" · ")}
                  </p>
                )}
              </section>

              {/* Inline Two-Panel Manuscript Figure */}
              <PaperFigureBlock
                node={activeNode}
                title={paperTitle}
                dossier={activeDossier}
                figureNumber={1}
              />

              {/* Numbered Manuscript Body Sections */}
              <div className="etg-paper-body">
                {structuredArticle.sections.map((sec, sIdx) => {
                  const secNum = sIdx + 1;
                  const blocks = parseWikiMarkdownBlocks(sec.body);
                  return (
                    <section key={sec.id} aria-labelledby={sec.id}>
                      <h2 id={sec.id} className="etg-paper-h2">
                        {secNum}. {sec.title}
                      </h2>

                      {blocks.map((blk, bIdx) => {
                        if (blk.type === "paragraph") {
                          return <p key={`${sec.id}-b-${bIdx}`}>{renderPaperText(blk.text)}</p>;
                        }
                        if (blk.type === "ul") {
                          return (
                            <ul key={`${sec.id}-b-${bIdx}`} className="list-disc">
                              {blk.items.map((item, iIdx) => (
                                <li key={`${sec.id}-b-${bIdx}-i-${iIdx}`}>
                                  {renderPaperText(item)}
                                </li>
                              ))}
                            </ul>
                          );
                        }
                        return (
                          <ol key={`${sec.id}-b-${bIdx}`} className="list-decimal">
                            {blk.items.map((item, iIdx) => (
                              <li key={`${sec.id}-b-${bIdx}-i-${iIdx}`}>
                                {renderPaperText(item)}
                              </li>
                            ))}
                          </ol>
                        );
                      })}

                      {sec.subsections.map((sub, subIdx) => {
                        const subBlocks = parseWikiMarkdownBlocks(sub.body);
                        return (
                          <div key={sub.id} id={sub.id}>
                            <h3 className="etg-paper-h3">
                              {secNum}.{subIdx + 1} {sub.title}
                            </h3>
                            {subBlocks.map((blk, sbIdx) => {
                              if (blk.type === "paragraph") {
                                return (
                                  <p key={`${sub.id}-b-${sbIdx}`}>{renderPaperText(blk.text)}</p>
                                );
                              }
                              if (blk.type === "ul") {
                                return (
                                  <ul key={`${sub.id}-b-${sbIdx}`} className="list-disc">
                                    {blk.items.map((item, iIdx) => (
                                      <li key={`${sub.id}-b-${sbIdx}-i-${iIdx}`}>
                                        {renderPaperText(item)}
                                      </li>
                                    ))}
                                  </ul>
                                );
                              }
                              return (
                                <ol key={`${sub.id}-b-${sbIdx}`} className="list-decimal">
                                  {blk.items.map((item, iIdx) => (
                                    <li key={`${sub.id}-b-${sbIdx}-i-${iIdx}`}>
                                      {renderPaperText(item)}
                                    </li>
                                  ))}
                                </ol>
                              );
                            })}
                          </div>
                        );
                      })}
                    </section>
                  );
                })}
              </div>

              {/* Quantitative Couplings & Booktabs Table 1 */}
              {linkedRelations.length > 0 && (
                <section aria-labelledby="sec-linked-signals" className="mt-7">
                  <h2 id="sec-linked-signals" className="etg-paper-h2">
                    {couplingsSectionNum}. Quantitative network couplings
                  </h2>

                  <p className="mb-2.5 font-sans text-[12px] text-[var(--paper-ink-muted)]">
                    <strong className="font-semibold text-[var(--paper-ink)]">Table 1.</strong>{" "}
                    Corroborating ETG observations, statistical correlations, and teleconnection
                    links attached to this finding.
                  </p>

                  <div className="etg-papertable-wrap !mt-0">
                    <table className="etg-papertable">
                      <thead>
                        <tr>
                          <th scope="col">Connected observation</th>
                          <th scope="col">Class</th>
                          <th scope="col">Relationship</th>
                          <th scope="col">Statistic / r</th>
                          <th scope="col">Region</th>
                        </tr>
                      </thead>
                      <tbody>
                        {linkedRelations.map((rel) => {
                          const rVal = rel.edge.properties.correlation_r;
                          const slope = rel.other.properties.theil_sen_slope;
                          const metricText =
                            typeof rVal === "number"
                              ? `r = ${rVal >= 0 ? "+" : ""}${rVal.toFixed(2)}`
                              : typeof slope === "number"
                                ? `${slope >= 0 ? "+" : ""}${slope.toFixed(3)} ${rel.other.properties.slope_unit ?? ""}`
                                : "—";
                          return (
                            <tr key={`${rel.edge.properties.uuid}-${rel.other.uuid}`}>
                              <td data-label="Connected observation">
                                <button
                                  type="button"
                                  onClick={() => selectPaperNode(rel.other)}
                                  className="etg-paper-cite font-medium"
                                >
                                  {cleanWikiTitle(rel.other.properties.name)}
                                </button>
                              </td>
                              <td data-label="Class">{rel.other.label}</td>
                              <td data-label="Relationship">
                                {formatEdgeRelationLabel(
                                  rel.edge.type,
                                  rel.edge.properties.custom_label
                                )}
                              </td>
                              <td data-label="Statistic / r" className="font-mono tabular-nums">
                                {metricText}
                              </td>
                              <td data-label="Region">
                                {rel.other.properties.region || "Global"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* Numbered Single-Column References */}
              <WikiReferencesSection
                sectionNumber={referencesSectionNum}
                node={activeNode}
                citations={citations}
                referencedIndices={seenCitationRefs}
                onCitationAttached={onRefreshGraph}
              />
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
