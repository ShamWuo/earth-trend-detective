"use client";

import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, GitBranch, Loader2, Save, ShieldCheck } from "lucide-react";
import { DATASET_BY_ID } from "@/lib/datasets";
import { formatEdgeRelationLabel } from "@/lib/graph/graphVisuals";
import { cleanWikiTitle } from "./wikiArticleUtils";
import type { ETGEdge, ETGNode, ETGResearchDossier } from "@/types/etg";

export interface LinkedArticleRelation {
  edge: ETGEdge;
  other: ETGNode;
  direction: "outgoing" | "incoming";
}

interface PaperAuditPanelProps {
  node: ETGNode;
  dossier: ETGResearchDossier;
  relations: readonly LinkedArticleRelation[];
  onSelectNode: (node: ETGNode) => void;
  onExportMarkdown: () => void;
  onSynthesizeWithAI: () => void;
  synthesizing: boolean;
}

export function PaperAuditAndHistoryPanel({
  node,
  dossier,
  relations,
  onSelectNode,
  onExportMarkdown,
  onSynthesizeWithAI,
  synthesizing,
}: PaperAuditPanelProps) {
  const p = node.properties;
  const contradictions = relations.filter((r) => r.edge.type === "contradicts");
  const corroborations = relations.filter((r) => r.edge.type === "corroborates");
  const lineages = relations.filter((r) => r.edge.type === "supersedes");
  const dipoles = relations.filter(
    (r) =>
      r.edge.type === "drives_opposite" ||
      r.edge.type === "teleconnects" ||
      r.edge.type === "dampens" ||
      r.edge.properties.causal_polarity === "negative"
  );

  const provenanceLabel =
    dossier.researched_by === "agency_curation"
      ? "Curated Agency Baseline"
      : dossier.researched_by === "ai_detective"
        ? "AI Trend Detective Synthesis"
        : "Human / Community Investigator";

  const revisionEntries = [
    {
      ts: dossier.updated_at,
      tag: "cur",
      author: provenanceLabel,
      summary: `Current manuscript revision (${dossier.citations.length} citations, ${
        dossier.empirical_findings?.length ?? 0
      } empirical findings).`,
    },
    ...(p.observed_at
      ? [
          {
            ts: p.observed_at,
            tag: "obs",
            author:
              p.provenance_source ||
              (p.dataset ? DATASET_BY_ID[p.dataset]?.sourceName : "NASA/NOAA"),
            summary: "Latest satellite/station telemetry observation window recorded.",
          },
        ]
      : []),
    {
      ts: p.created_at,
      tag: "init",
      author: p.authored_by || "ETG Store",
      summary: `Initial ${node.label} node ingested into Earth Trend Graph (${node.uuid}).`,
    },
  ];

  return (
    <div className="space-y-6 font-sans text-[var(--paper-ink)]">
      <div className="flex items-start gap-2.5 border-l-2 border-[var(--paper-accent)] bg-[var(--paper-surface)]/70 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--paper-ink-muted)]">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--paper-accent)]" aria-hidden="true" />
        <div>
          <strong className="font-semibold text-[var(--paper-ink)]">
            Epistemic Audit &amp; Provenance Log:
          </strong>{" "}
          Corroboration gates, competing evidence checks, cross-basin teleconnections, and revision
          lineage for <b>{cleanWikiTitle(p.name)}</b>.
        </div>
      </div>

      {/* Corroboration Summary */}
      <section>
        <h2 className="etg-paper-h2 !mt-0 font-sans">Corroboration verification status</h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div className="rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] p-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--paper-ink-muted)]">
              Rule Gate
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[13.5px] font-semibold">
              {p.corroborated ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                  <span>Corroborated (≥2 sources)</span>
                </>
              ) : (
                <span>Provisional / Single Source</span>
              )}
            </div>
          </div>
          <div className="rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] p-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--paper-ink-muted)]">
              Independent Systems
            </div>
            <div className="mt-1 text-[13.5px] font-semibold tabular-nums">
              {p.independent_sources_count ?? corroborations.length + 1} distinct systems
              {typeof p.effective_independent_sources === "number"
                ? ` (eff. ${p.effective_independent_sources.toFixed(1)})`
                : ""}
            </div>
          </div>
          <div className="rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] p-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--paper-ink-muted)]">
              Verified Citations
            </div>
            <div className="mt-1 text-[13.5px] font-semibold tabular-nums">
              {dossier.citations.filter((c) => c.doi_verified).length} DOI-verified /{" "}
              {dossier.citations.length} total
            </div>
          </div>
        </div>
      </section>

      {/* Competing / Contradicting Evidence */}
      <section>
        <h2 className="etg-paper-h2 font-sans">
          Competing &amp; contradicting evidence ({contradictions.length})
        </h2>
        {contradictions.length === 0 ? (
          <p className="text-[13px] text-[var(--paper-ink-muted)]">
            No active <code className="font-mono text-[11.5px]">contradicts</code> edges dispute
            this observation in the current graph snapshot.
          </p>
        ) : (
          <ul className="space-y-2">
            {contradictions.map((item) => (
              <li
                key={item.edge.properties.uuid}
                className="rounded-xs border border-rose-500/35 bg-rose-500/5 p-3 text-[13px]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectNode(item.other)}
                    className="font-semibold text-[var(--paper-accent)] hover:underline cursor-pointer"
                  >
                    {cleanWikiTitle(item.other.properties.name)} ({item.other.label})
                  </button>
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-500">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    contradicts
                  </span>
                </div>
                {item.edge.properties.rationale && (
                  <p className="mt-1 mb-0 text-[12.5px]">{item.edge.properties.rationale}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Teleconnections & Opposite Dipoles */}
      <section>
        <h2 className="etg-paper-h2 font-sans">
          Cross-region teleconnections &amp; dipoles ({dipoles.length})
        </h2>
        {dipoles.length === 0 ? (
          <p className="text-[13px] text-[var(--paper-ink-muted)]">
            No teleconnection or opposite-trend dipole edges attached.
          </p>
        ) : (
          <ul className="space-y-2">
            {dipoles.map((item) => (
              <li
                key={item.edge.properties.uuid}
                className="rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] p-3 text-[13px]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectNode(item.other)}
                    className="font-semibold text-[var(--paper-accent)] hover:underline cursor-pointer"
                  >
                    {cleanWikiTitle(item.other.properties.name)}
                  </button>
                  <span className="font-mono text-[11.5px] text-[var(--paper-ink-muted)]">
                    {formatEdgeRelationLabel(item.edge.type, item.edge.properties.custom_label)}
                    {typeof item.edge.properties.correlation_r === "number"
                      ? ` · r = ${item.edge.properties.correlation_r.toFixed(2)}`
                      : ""}
                  </span>
                </div>
                {item.edge.properties.rationale && (
                  <p className="mt-1 mb-0 text-[12.5px] text-[var(--paper-ink-muted)]">
                    {item.edge.properties.rationale}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Belief Revision Lineage */}
      <section>
        <h2 className="etg-paper-h2 font-sans">Belief revision lineage ({lineages.length})</h2>
        {lineages.length === 0 ? (
          <p className="text-[13px] text-[var(--paper-ink-muted)]">
            Active canonical record with no{" "}
            <code className="font-mono text-[11.5px]">supersedes</code> edges.
          </p>
        ) : (
          <ul className="space-y-2">
            {lineages.map((item) => (
              <li
                key={item.edge.properties.uuid}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] p-3 text-[13px]"
              >
                <div>
                  <span className="mr-1.5 inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--paper-ink-muted)]">
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    {item.direction === "outgoing" ? "Supersedes prior node:" : "Superseded by:"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelectNode(item.other)}
                    className="font-medium text-[var(--paper-accent)] hover:underline cursor-pointer"
                  >
                    {cleanWikiTitle(item.other.properties.name)}
                  </button>
                </div>
                {item.edge.properties.rationale && (
                  <span className="text-[12px] text-[var(--paper-ink-muted)]">
                    {item.edge.properties.rationale}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Provenance & Revision History */}
      <section className="border-t border-[var(--paper-rule)] pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="etg-paper-h2 !my-0 font-sans">Revision &amp; provenance log</h2>
            <p className="mt-0.5 text-[12px] text-[var(--paper-ink-muted)]">
              Node UUID: <code className="font-mono text-[11px]">{node.uuid}</code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onExportMarkdown}
              className="rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] px-2.5 py-1 text-[12px] font-medium text-[var(--paper-ink)] hover:border-[var(--paper-accent)] cursor-pointer"
            >
              Export .md
            </button>
            <button
              type="button"
              onClick={onSynthesizeWithAI}
              disabled={synthesizing}
              className="inline-flex items-center gap-1 rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] px-2.5 py-1 text-[12px] font-medium text-[var(--paper-accent)] hover:border-[var(--paper-accent)] disabled:opacity-50 cursor-pointer"
            >
              {synthesizing && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              <span>Refresh with AI</span>
            </button>
          </div>
        </div>

        <ul className="space-y-2 border-l-2 border-[var(--paper-rule)] pl-4">
          {revisionEntries.map((entry, idx) => (
            <li key={`${entry.tag}-${idx}`} className="text-[12.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] px-1.5 py-px font-mono text-[11px] font-semibold">
                  {entry.tag}
                </span>
                <span className="inline-flex items-center gap-1 font-mono text-[11.5px]">
                  <Clock className="h-3 w-3 text-[var(--paper-ink-muted)]" aria-hidden="true" />
                  {new Date(entry.ts).toLocaleString()}
                </span>
                <span className="font-medium text-[var(--paper-accent)]">{entry.author}</span>
              </div>
              <p className="mt-0.5 mb-0 text-[var(--paper-ink-muted)]">{entry.summary}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface PaperSourceEditorPanelProps {
  node: ETGNode;
  dossier: ETGResearchDossier;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
}

export function WikiSourceEditorPanel({
  node,
  dossier,
  onSaved,
  onCancel,
}: PaperSourceEditorPanelProps) {
  const [title, setTitle] = useState(node.properties.name);
  const [region, setRegion] = useState(node.properties.region ?? "");
  const [abstractText, setAbstractText] = useState(dossier.abstract ?? "");
  const [mechanism, setMechanism] = useState(dossier.physical_mechanism ?? "");
  const [findingsText, setFindingsText] = useState(
    (dossier.empirical_findings ?? []).join("\n")
  );
  const [impactsText, setImpactsText] = useState((dossier.impacts ?? []).join("\n"));
  const [markdownBody, setMarkdownBody] = useState(dossier.markdown_body ?? "");
  const [editSummary, setEditSummary] = useState("Updated working paper manuscript text and findings");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const parsedFindings = findingsText
        .split("\n")
        .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
        .filter(Boolean);
      const parsedImpacts = impactsText
        .split("\n")
        .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
        .filter(Boolean);

      const nextDossier: ETGResearchDossier = {
        ...dossier,
        abstract: abstractText.trim(),
        physical_mechanism: mechanism.trim(),
        empirical_findings: parsedFindings,
        impacts: parsedImpacts.length > 0 ? parsedImpacts : undefined,
        markdown_body: markdownBody.trim() || undefined,
        updated_at: new Date().toISOString(),
        researched_by: "human",
      };

      const res = await fetch("/api/graph", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeUuid: node.uuid,
          patch: {
            name: title.trim() || node.properties.name,
            region: region.trim() || undefined,
            description: abstractText.trim() || node.properties.description,
            dossier: nextDossier,
            rationale:
              editSummary.trim().length >= 6
                ? editSummary.trim()
                : "Manual paper edit in ETG Briefing Reader",
          },
        }),
      });

      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Save failed (HTTP ${res.status})`);
      }

      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save working paper edits");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 font-sans text-[var(--paper-ink)]">
      <div className="border-l-2 border-[var(--paper-accent)] bg-[var(--paper-surface)]/70 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--paper-ink-muted)]">
        <strong className="font-semibold text-[var(--paper-ink)]">Editing working paper:</strong>{" "}
        Changes are validated by the ETG Integrity Guard and saved directly to the Knowledge Graph.
        Reference other observations inline using <code className="font-mono text-[11.5px]">[{node.uuid}]</code>{" "}
        or inline LaTeX math <code className="font-mono text-[11.5px]">$r = 0.84$</code>.
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xs border border-rose-500/45 bg-rose-500/10 p-3 text-[13px] text-rose-500"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-[12.5px]">
          <span className="mb-1 block font-semibold">Paper title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 text-[13px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
          />
        </label>
        <label className="block text-[12.5px]">
          <span className="mb-1 block font-semibold">Geographic region</span>
          <input
            type="text"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 text-[13px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
          />
        </label>
      </div>

      <label className="block text-[12.5px]">
        <span className="mb-1 block font-semibold">Abstract</span>
        <textarea
          rows={3}
          autoFocus
          value={abstractText}
          onChange={(e) => setAbstractText(e.target.value)}
          className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 text-[13px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
        />
      </label>

      <label className="block text-[12.5px]">
        <span className="mb-1 block font-semibold">Physical mechanism</span>
        <textarea
          rows={4}
          value={mechanism}
          onChange={(e) => setMechanism(e.target.value)}
          className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 text-[13px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
        />
      </label>

      <label className="block text-[12.5px]">
        <span className="mb-1 block font-semibold">
          Empirical observations &amp; statistics (one item per line)
        </span>
        <textarea
          rows={4}
          value={findingsText}
          onChange={(e) => setFindingsText(e.target.value)}
          className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
        />
      </label>

      <label className="block text-[12.5px]">
        <span className="mb-1 block font-semibold">
          Environmental &amp; societal impacts (one item per line)
        </span>
        <textarea
          rows={3}
          value={impactsText}
          onChange={(e) => setImpactsText(e.target.value)}
          className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
        />
      </label>

      <label className="block text-[12.5px]">
        <span className="mb-1 block font-semibold">
          Extended Markdown manuscript sections (<code className="font-mono">## Section</code> and{" "}
          <code className="font-mono">### Subsection</code>)
        </span>
        <textarea
          rows={6}
          value={markdownBody}
          onChange={(e) => setMarkdownBody(e.target.value)}
          className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
        />
      </label>

      <label className="block text-[12.5px]">
        <span className="mb-1 block font-semibold">Revision note</span>
        <input
          type="text"
          value={editSummary}
          onChange={(e) => setEditSummary(e.target.value)}
          className="w-full rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-sheet)] px-2.5 py-1.5 text-[12.5px] text-[var(--paper-ink)] focus:border-[var(--paper-accent)] focus:outline-none"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2.5 border-t border-[var(--paper-rule)] pt-3">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--paper-accent)] bg-[var(--paper-accent)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-60 cursor-pointer"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{saving ? "Saving..." : "Save manuscript"}</span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xs border border-[var(--paper-rule)] bg-[var(--paper-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--paper-ink)] hover:border-[var(--paper-rule-strong)] cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
