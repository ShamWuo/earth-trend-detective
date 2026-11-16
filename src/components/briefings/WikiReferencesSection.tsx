"use client";

import React, { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Plus, Search } from "lucide-react";
import type { ETGNode, ETGScientificCitation } from "@/types/etg";

interface WikiReferencesSectionProps {
  sectionNumber: number;
  node: ETGNode;
  citations: readonly ETGScientificCitation[];
  referencedIndices: ReadonlySet<number>;
  onCitationAttached?: () => Promise<void> | void;
}

function getStanceLabel(stance?: ETGScientificCitation["claim_stance"]): {
  label: string;
  className: string;
} | null {
  if (stance === "supports") {
    return {
      label: "Supports",
      className:
        "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (stance === "challenges") {
    return {
      label: "Qualifies",
      className: "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    };
  }
  if (stance === "neutral") {
    return {
      label: "Context",
      className: "border-[var(--paper-rule)] bg-[var(--paper-surface)] text-[var(--paper-ink-muted)]",
    };
  }
  return null;
}

export function WikiReferencesSection({
  sectionNumber,
  node,
  citations,
  referencedIndices,
  onCitationAttached,
}: WikiReferencesSectionProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<ETGScientificCitation[]>([]);
  const [attachingKey, setAttachingKey] = useState<string | null>(null);
  const [attachMessage, setAttachMessage] = useState<string | null>(null);

  const handleSearchLiterature = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    setSearchError(null);
    setAttachMessage(null);
    try {
      const qs = new URLSearchParams({
        nodeUuid: node.uuid,
        limit: "6",
        ...(query.trim().length >= 3 ? { q: query.trim() } : {}),
      });
      const res = await fetch(`/api/earth/literature?${qs.toString()}`);
      const data = (await res.json()) as {
        results?: ETGScientificCitation[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || `Literature lookup returned HTTP ${res.status}`);
      }
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Failed to query Crossref / Europe PMC");
    } finally {
      setSearching(false);
    }
  };

  const handleAttachCitation = async (citation: ETGScientificCitation) => {
    const key = citation.doi || citation.title;
    setAttachingKey(key);
    setSearchError(null);
    setAttachMessage(null);
    try {
      const res = await fetch("/api/earth/literature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attach_citation",
          nodeUuid: node.uuid,
          citation,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Failed to attach reference (${res.status})`);
      }
      setAttachMessage(`Attached "${citation.title}" to references.`);
      if (onCitationAttached) {
        await onCitationAttached();
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Failed to attach citation");
    } finally {
      setAttachingKey(null);
    }
  };

  const handleJumpBack = (citNum: number) => {
    const el = document.getElementById(`cite-ref-${citNum}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <section
      aria-labelledby="sec-references"
      className="mt-8 border-t border-[var(--paper-rule)] pt-4"
    >
      <h2 id="sec-references" className="etg-paper-h2 !mt-0">
        {sectionNumber}. References
      </h2>

      {citations.length === 0 ? (
        <p className="font-sans text-[13px] italic text-[var(--paper-ink-muted)]">
          No peer-reviewed citations are attached to this working paper yet.
        </p>
      ) : (
        <ol className="mt-3 list-none space-y-2.5 pl-0 font-sans text-[12.5px] leading-relaxed text-[var(--paper-ink)]">
          {citations.map((cit, idx) => {
            const citNum = idx + 1;
            const href = cit.doi
              ? `https://doi.org/${cit.doi.replace(/^https?:\/\/doi\.org\//i, "")}`
              : cit.url;
            const stanceMeta = getStanceLabel(cit.claim_stance);
            const hasBacklinkTarget = referencedIndices.has(citNum);

            return (
              <li
                key={`${cit.doi ?? cit.title}-${citNum}`}
                id={`cite-note-${citNum}`}
                className="etg-paper-ref-item flex items-start gap-2.5"
              >
                <span className="w-7 shrink-0 pt-px font-mono text-[11.5px] font-medium tabular-nums">
                  {hasBacklinkTarget ? (
                    <button
                      type="button"
                      onClick={() => handleJumpBack(citNum)}
                      title={`Jump back to inline citation [${citNum}]`}
                      className="text-[var(--paper-accent)] hover:underline cursor-pointer"
                    >
                      [{citNum}]
                    </button>
                  ) : (
                    <span className="text-[var(--paper-ink-muted)]">[{citNum}]</span>
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <span>
                    {cit.authors} ({cit.year}).{" "}
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-[var(--paper-accent)] hover:underline"
                      >
                        &ldquo;{cit.title}&rdquo;
                        <ExternalLink
                          className="ml-0.5 inline h-3 w-3 align-text-top opacity-70"
                          aria-hidden="true"
                        />
                      </a>
                    ) : (
                      <span>&ldquo;{cit.title}&rdquo;</span>
                    )}
                    .{cit.journal ? <> <i>{cit.journal}</i>.</> : null}{" "}
                    {cit.doi && (
                      <span className="font-mono text-[11px] text-[var(--paper-ink-muted)]">
                        doi:{cit.doi.replace(/^https?:\/\/doi\.org\//i, "")}.{" "}
                      </span>
                    )}
                    {cit.doi_verified && (
                      <span className="inline-flex items-center gap-0.5 rounded-xs border border-emerald-500/35 bg-emerald-500/10 px-1 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />
                        DOI verified
                      </span>
                    )}
                    {typeof cit.citation_count === "number" && cit.citation_count > 0 && (
                      <span className="ml-1 text-[11px] text-[var(--paper-ink-muted)] tabular-nums">
                        ({cit.citation_count.toLocaleString()} citations)
                      </span>
                    )}
                    {stanceMeta && (
                      <span
                        title={cit.stance_rationale || undefined}
                        className={`ml-1 inline-flex items-center rounded-xs border px-1 py-px text-[10px] font-medium ${stanceMeta.className}`}
                      >
                        {stanceMeta.label}
                      </span>
                    )}
                  </span>

                  {cit.abstract_snippet && (
                    <details className="mt-1 text-[11.5px] text-[var(--paper-ink-muted)]">
                      <summary className="cursor-pointer select-none text-[var(--paper-ink-muted)] hover:text-[var(--paper-accent)]">
                        Excerpt / alignment note
                      </summary>
                      <div className="mt-1 border-l border-[var(--paper-rule)] pl-2.5">
                        {cit.stance_rationale && (
                          <p className="mb-1 font-medium text-[var(--paper-ink)]">
                            Alignment: {cit.stance_rationale}
                          </p>
                        )}
                        <p className="leading-relaxed">{cit.abstract_snippet}</p>
                      </div>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Subtle Secondary Literature Search Disclosure */}
      <div className="no-print mt-4">
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className="text-[12px] font-sans text-[var(--paper-ink-muted)] hover:text-[var(--paper-accent)] hover:underline cursor-pointer"
        >
          {searchOpen
            ? "− Hide Crossref / Europe PMC literature lookup"
            : "+ Search & attach peer-reviewed literature (Crossref / Europe PMC)"}
        </button>

        {searchOpen && (
          <div className="mt-2.5 rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] p-3.5 font-sans">
            <form onSubmit={handleSearchLiterature} className="flex flex-wrap gap-2">
              <label htmlFor="paper-lit-search-input" className="sr-only">
                Literature search keywords
              </label>
              <input
                id="paper-lit-search-input"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Keywords (defaults to "${node.properties.name.slice(0, 42)}...")`}
                className="min-w-[220px] flex-1 rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 text-[12.5px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
              />
              <button
                type="submit"
                disabled={searching}
                className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--paper-rule-strong)] bg-[var(--paper-sheet)] px-3 py-1.5 text-[12px] font-medium text-[var(--paper-ink)] hover:border-[var(--paper-accent)] disabled:opacity-60 cursor-pointer"
              >
                {searching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>{searching ? "Searching..." : "Search papers"}</span>
              </button>
            </form>

            {searchError && (
              <p className="mt-2 text-[12px] text-rose-500" role="alert">
                {searchError}
              </p>
            )}
            {attachMessage && (
              <p className="mt-2 text-[12px] text-emerald-600 dark:text-emerald-400" role="status">
                {attachMessage}
              </p>
            )}

            {results.length > 0 && (
              <ul className="mt-3 space-y-2 border-t border-[var(--paper-rule)] pt-2.5">
                {results.map((res, rIdx) => {
                  const key = res.doi || `${res.title}-${rIdx}`;
                  const alreadyCited = citations.some(
                    (existing) =>
                      (res.doi && existing.doi === res.doi) ||
                      existing.title.toLowerCase() === res.title.toLowerCase()
                  );
                  return (
                    <li
                      key={key}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] p-2.5 text-[12px]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-[var(--paper-ink)]">{res.title}</div>
                        <div className="mt-0.5 text-[11.5px] text-[var(--paper-ink-muted)]">
                          {res.authors} ({res.year})
                          {res.journal ? ` · ${res.journal}` : ""}
                          {res.doi ? ` · doi:${res.doi}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={alreadyCited || attachingKey === key}
                        onClick={() => handleAttachCitation(res)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] px-2 py-1 text-[11.5px] font-medium text-[var(--paper-accent)] hover:border-[var(--paper-accent)] disabled:opacity-50 cursor-pointer"
                      >
                        {attachingKey === key ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <Plus className="h-3 w-3" aria-hidden="true" />
                        )}
                        <span>{alreadyCited ? "Cited" : "Cite"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
