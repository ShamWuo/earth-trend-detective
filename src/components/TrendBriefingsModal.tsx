"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpenText,
  CheckCircle2,
  Download,
  ExternalLink,
  FilePenLine,
  Globe2,
  Network,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { attachDialogLightDismissFallback } from "@/lib/a11y/dialogLightDismiss";
import { DATASET_BY_ID } from "@/lib/datasets";
import { resolveEtgNodeColor } from "@/lib/graph/graphVisuals";
import { renderFormattedBriefing } from "@/components/workbench/briefingFormatUtils";
import {
  buildLiveTelemetryBriefingFallback,
  exportDossierToMarkdown,
  sanitizeResearchDossier,
} from "@/lib/research/dossierUtils";
import type {
  ETGEdge,
  ETGNode,
  ETGResearchDossier,
  ETGScientificCitation,
} from "@/types/etg";

type BriefingsFilterMode = "briefings" | "citations" | "corroborated" | "all";

interface TrendBriefingsModalProps {
  open: boolean;
  initialNodeUuid?: string | null;
  nodes: ETGNode[];
  edges: ETGEdge[];
  onClose: () => void;
  onLocateOnGlobe: (node: ETGNode) => void;
  onOpenInGraph: (nodeUuid: string) => void;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
}

function formatSignedSlope(slope: number, unit?: string): string {
  const prefix = slope > 0 ? "+" : "";
  return `${prefix}${slope.toFixed(4)}${unit ? ` ${unit}` : ""}`;
}

function renderCitationStanceBadge(cit: ETGScientificCitation): React.ReactNode {
  if (!cit.claim_stance) return null;
  if (cit.claim_stance === "supports") {
    return (
      <span className="inline-flex items-center gap-1 rounded-xs border border-emerald-500/40 bg-emerald-950/40 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-300">
        <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />
        <span>Supports Claim</span>
      </span>
    );
  }
  if (cit.claim_stance === "challenges") {
    return (
      <span className="inline-flex items-center gap-1 rounded-xs border border-rose-500/40 bg-rose-950/40 px-1.5 py-0.5 font-mono text-[10px] font-medium text-rose-300">
        <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
        <span>Challenges Claim</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-text-muted">
      <BookOpenText className="h-2.5 w-2.5" aria-hidden="true" />
      <span>Contextual / Neutral</span>
    </span>
  );
}

function renderAbstractDisclosure(cit: ETGScientificCitation): React.ReactNode {
  if (!cit.abstract_snippet && !cit.stance_rationale) return null;
  return (
    <details className="mt-1.5 rounded-xs border border-border/70 bg-surface/60 px-2 py-1">
      <summary className="cursor-pointer select-none text-[11px] font-medium text-text-muted hover:text-text-primary">
        {cit.abstract_snippet
          ? "Read abstract & entailment rationale"
          : "Entailment rationale"}
      </summary>
      <div className="mt-1.5 space-y-1 border-t border-border/50 pt-1.5 text-[11px] leading-relaxed text-text-muted">
        {cit.stance_rationale && (
          <p className="font-mono text-[10.5px] text-text-primary">
            Stance analysis: {cit.stance_rationale}
          </p>
        )}
        {cit.abstract_snippet && <p>{cit.abstract_snippet}</p>}
      </div>
    </details>
  );
}

function renderInlineEvidenceText(
  text: string,
  nodeById: Map<string, ETGNode>,
  onInspectEvidenceNode: (uuid: string) => void
): React.ReactNode {
  return renderFormattedBriefing(text, nodeById, (node) =>
    onInspectEvidenceNode(node.uuid)
  );
}

function renderSafeMarkdownProse(
  markdown: string,
  nodeById: Map<string, ETGNode>,
  onInspectEvidenceNode: (uuid: string) => void
): React.ReactNode {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((block, idx) => {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0])) {
      const headingText = lines[0].replace(/^#{1,4}\s+/, "");
      return (
        <h4
          key={idx}
          className="mt-3 mb-1.5 font-outfit text-xs font-semibold uppercase tracking-wide text-text-primary first:mt-0"
        >
          {headingText}
        </h4>
      );
    }
    if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
      return (
        <ul key={idx} className="my-2 list-disc space-y-1 pl-5 text-xs text-text-muted">
          {lines.map((line, i) => (
            <li key={i} className="leading-relaxed">
              {renderInlineEvidenceText(
                line.trim().replace(/^[-*]\s+/, ""),
                nodeById,
                onInspectEvidenceNode
              )}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p key={idx} className="text-xs leading-relaxed text-text-muted">
        {renderInlineEvidenceText(lines.join(" "), nodeById, onInspectEvidenceNode)}
      </p>
    );
  });
}

function provenanceBadgeLabel(mode?: ETGResearchDossier["researched_by"]): {
  text: string;
  cls: string;
} {
  switch (mode) {
    case "agency_curation":
      return {
        text: "Curated Research + Live Telemetry",
        cls: "border-emerald-400/40 bg-emerald-950/60 text-emerald-300",
      };
    case "ai_detective":
      return {
        text: "AI Detective Synthesis",
        cls: "border-sky-400/40 bg-sky-950/60 text-sky-300",
      };
    case "human":
      return {
        text: "Community & Researcher Brief",
        cls: "border-amber-400/40 bg-amber-950/60 text-amber-300",
      };
    default:
      return {
        text: "Live Statistical Summary",
        cls: "border-border bg-surface-inset text-text-muted",
      };
  }
}

export function TrendBriefingsModal({
  open,
  initialNodeUuid = null,
  nodes,
  edges,
  onClose,
  onLocateOnGlobe,
  onOpenInGraph,
  onSnapshotChange,
}: TrendBriefingsModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<BriefingsFilterMode>("briefings");
  const [activeNodeUuid, setActiveNodeUuid] = useState<string | null>(initialNodeUuid);

  const [editMode, setEditMode] = useState(false);
  const [draftAbstract, setDraftAbstract] = useState("");
  const [draftMechanism, setDraftMechanism] = useState("");
  const [draftFindings, setDraftFindings] = useState("");
  const [draftImpacts, setDraftImpacts] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [draftCitations, setDraftCitations] = useState<ETGScientificCitation[]>([]);

  const [busyAi, setBusyAi] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [litQuery, setLitQuery] = useState("");
  const [litResults, setLitResults] = useState<ETGScientificCitation[]>([]);
  const [litLoading, setLitLoading] = useState(false);
  const [litAttachingDoi, setLitAttachingDoi] = useState<string | null>(null);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.uuid, n])), [nodes]);

  const rankedNodes = useMemo(() => {
    const labelRank = (n: ETGNode) => {
      let score = 0;
      if (n.properties.dossier) score += 100;
      if ((n.properties.dossier?.citations?.length ?? 0) > 0) score += 20;
      if (n.label === "Insight") score += 40;
      if (n.properties.corroborated) score += 15;
      if (n.properties.status === "Superseded") score -= 10;
      return score;
    };
    return [...nodes].sort((a, b) => {
      const diff = labelRank(b) - labelRank(a);
      if (diff !== 0) return diff;
      return a.properties.name.localeCompare(b.properties.name);
    });
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rankedNodes.filter((n) => {
      if (n.label === "Rule") return false;
      const d = n.properties.dossier;
      if (filterMode === "briefings" && !d) return false;
      if (filterMode === "citations" && (!d || d.citations.length === 0)) return false;
      if (filterMode === "corroborated" && !n.properties.corroborated) return false;
      if (!q) return true;
      const hay = [
        n.uuid,
        n.properties.name,
        n.properties.region,
        n.properties.description,
        n.properties.parameter,
        d?.abstract,
        d?.physical_mechanism,
        ...(d?.citations.flatMap((c) => [c.title, c.authors, c.doi, c.journal]) ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rankedNodes, filterMode, query]);

  // Synchronize open/close state with native HTML <dialog> showModal()
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
      setEditMode(false);
      setErrorMsg(null);
      setStatusMsg(null);
      if (initialNodeUuid && nodeById.has(initialNodeUuid)) {
        const target = nodeById.get(initialNodeUuid);
        setActiveNodeUuid(initialNodeUuid);
        if (target && !target.properties.dossier) {
          setFilterMode("all");
        }
      } else {
        setFilterMode("briefings");
        const firstDossier = rankedNodes.find((n) => Boolean(n.properties.dossier)) ?? rankedNodes[0];
        setActiveNodeUuid(firstDossier?.uuid ?? null);
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, initialNodeUuid, nodeById, rankedNodes]);

  // Mandatory closedby="any" fallback for browsers without HTMLDialogElement.prototype.closedBy
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;
    return attachDialogLightDismissFallback(dialog, () => {
      dialog.close("dismiss");
    });
  }, [open]);

  const selectedNode = useMemo(() => {
    if (activeNodeUuid && nodeById.has(activeNodeUuid)) {
      return nodeById.get(activeNodeUuid)!;
    }
    return filteredNodes[0] ?? rankedNodes[0] ?? null;
  }, [activeNodeUuid, nodeById, filteredNodes, rankedNodes]);

  const activeDossier: ETGResearchDossier | null = useMemo(() => {
    if (!selectedNode) return null;
    if (selectedNode.properties.dossier) return selectedNode.properties.dossier;
    return buildLiveTelemetryBriefingFallback(selectedNode, edges, nodeById);
  }, [selectedNode, edges, nodeById]);

  const isFallbackPreview = Boolean(selectedNode && !selectedNode.properties.dossier);

  // Compute epistemic lineage (`supersedes` incoming & outgoing edges)
  const lineage = useMemo(() => {
    if (!selectedNode) {
      return {
        supersededBy: [] as Array<{ node: ETGNode; rationale?: string }>,
        supersedes: [] as Array<{ node: ETGNode; rationale?: string }>,
      };
    }
    const supersededBy: Array<{ node: ETGNode; rationale?: string }> = [];
    const supersedes: Array<{ node: ETGNode; rationale?: string }> = [];
    for (const e of edges) {
      if (e.type !== "supersedes") continue;
      if (e.target_uuid === selectedNode.uuid) {
        const newer = nodeById.get(e.source_uuid);
        if (newer) supersededBy.push({ node: newer, rationale: e.properties.rationale });
      }
      if (e.source_uuid === selectedNode.uuid) {
        const older = nodeById.get(e.target_uuid);
        if (older) supersedes.push({ node: older, rationale: e.properties.rationale });
      }
    }
    return { supersededBy, supersedes };
  }, [selectedNode, edges, nodeById]);

  // Compute disconfirming / contradicting evidence (`contradicts` incoming & outgoing edges)
  const contradictions = useMemo(() => {
    if (!selectedNode) {
      return [] as Array<{ node: ETGNode; direction: "incoming" | "outgoing"; rationale?: string }>;
    }
    const items: Array<{ node: ETGNode; direction: "incoming" | "outgoing"; rationale?: string }> = [];
    for (const e of edges) {
      if (e.type !== "contradicts" || e.properties.superseded_at) continue;
      if (e.target_uuid === selectedNode.uuid) {
        const peer = nodeById.get(e.source_uuid);
        if (peer) items.push({ node: peer, direction: "incoming", rationale: e.properties.rationale });
      } else if (e.source_uuid === selectedNode.uuid) {
        const peer = nodeById.get(e.target_uuid);
        if (peer) items.push({ node: peer, direction: "outgoing", rationale: e.properties.rationale });
      }
    }
    return items;
  }, [selectedNode, edges, nodeById]);

  const connectedSignals = useMemo(() => {
    if (!selectedNode) return [] as Array<{ node: ETGNode; relation: string; r?: number }>;
    const items: Array<{ node: ETGNode; relation: string; r?: number }> = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.source_uuid !== selectedNode.uuid && e.target_uuid !== selectedNode.uuid) continue;
      const peerUuid = e.source_uuid === selectedNode.uuid ? e.target_uuid : e.source_uuid;
      if (seen.has(peerUuid)) continue;
      const peer = nodeById.get(peerUuid);
      if (!peer) continue;
      seen.add(peerUuid);
      items.push({ node: peer, relation: e.type, r: e.properties.correlation_r });
    }
    return items.slice(0, 8);
  }, [selectedNode, edges, nodeById]);

  const handleNativeClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    onClose();
  };

  const openEditorForSelected = () => {
    if (!selectedNode || !activeDossier) return;
    setDraftAbstract(activeDossier.abstract);
    setDraftMechanism(activeDossier.physical_mechanism ?? "");
    setDraftFindings(activeDossier.empirical_findings.join("\n"));
    setDraftImpacts((activeDossier.impacts ?? []).join("\n"));
    setDraftMarkdown(activeDossier.markdown_body ?? "");
    setDraftCitations(
      activeDossier.citations.length > 0
        ? activeDossier.citations.map((c) => ({ ...c }))
        : []
    );
    setErrorMsg(null);
    setStatusMsg(null);
    setEditMode(true);
  };

  const handleSynthesizeWithAi = async () => {
    if (!selectedNode) return;
    setBusyAi(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/ai/detective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedNodeUuid: selectedNode.uuid,
          synthesizeDossier: true,
          question: `Synthesize a structured peer-reviewed scientific trend briefing for "${selectedNode.properties.name}" citing connected signals, statistical significance, physical mechanism, impacts, and DOIs.`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "AI briefing synthesis failed.");
      if (data.updatedSnapshot) {
        onSnapshotChange(
          data.updatedSnapshot,
          `Synthesized research briefing for "${selectedNode.properties.name}".`
        );
        setStatusMsg(`Briefing synthesized via ${data.engine || "AI Detective"}.`);
      } else {
        setStatusMsg("AI Detective completed analysis.");
      }
      setEditMode(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "AI briefing synthesis failed.");
    } finally {
      setBusyAi(false);
    }
  };

  const handleSaveManualDossier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode) return;
    setErrorMsg(null);
    setStatusMsg(null);

    const cleanCitations = draftCitations
      .map((c) => ({
        title: c.title.trim(),
        authors: c.authors.trim(),
        journal: c.journal?.trim() || undefined,
        year: Number(c.year) || new Date().getUTCFullYear(),
        doi: c.doi?.trim() || undefined,
        url: c.url?.trim() || (c.doi?.trim() ? `https://doi.org/${c.doi.trim()}` : undefined),
      }))
      .filter((c) => c.title && c.authors);

    const parsed = sanitizeResearchDossier({
      abstract: draftAbstract,
      physical_mechanism: draftMechanism,
      empirical_findings: draftFindings
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      impacts: draftImpacts
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      markdown_body: draftMarkdown,
      citations: cleanCitations,
      researched_by: "human",
      updated_at: new Date().toISOString(),
    });

    if (!parsed) {
      setErrorMsg("Briefing abstract cannot be empty or contain unsafe script markup.");
      return;
    }

    setBusySave(true);
    try {
      const res = await fetch("/api/graph", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeUuid: selectedNode.uuid,
          patch: { dossier: parsed },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save research briefing.");
      onSnapshotChange(data.snapshot, `Saved research briefing for "${selectedNode.properties.name}".`);
      setEditMode(false);
      setStatusMsg("Research briefing persisted to Knowledge Graph.");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save research briefing.");
    } finally {
      setBusySave(false);
    }
  };

  const handleDownloadMarkdown = () => {
    if (!selectedNode || !activeDossier) return;
    const md = exportDossierToMarkdown(selectedNode, activeDossier);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedNode.uuid}-briefing.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    setLitResults([]);
    setLitQuery("");
  }, [activeNodeUuid]);

  const handleSearchLiterature = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!selectedNode) return;
    setLitLoading(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const trimmed = litQuery.trim();
      const params = new URLSearchParams({ limit: "5" });
      if (trimmed.length >= 3) {
        params.set("q", trimmed);
      } else {
        params.set("nodeUuid", selectedNode.uuid);
      }
      const res = await fetch(`/api/earth/literature?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Literature search failed.");
      const found = Array.isArray(data.results) ? (data.results as ETGScientificCitation[]) : [];
      setLitResults(found);
      if (data.query && !trimmed) {
        setLitQuery(String(data.query));
      }
      setStatusMsg(
        found.length > 0
          ? `Found ${found.length} peer-reviewed publication(s) from Crossref / Europe PMC.`
          : "No matching peer-reviewed publications returned for that query."
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Scholarly literature search failed.");
    } finally {
      setLitLoading(false);
    }
  };

  const handleAttachLiteratureCitation = async (citation: ETGScientificCitation) => {
    if (!selectedNode) return;
    const attachKey = citation.doi || citation.title;
    setLitAttachingDoi(attachKey);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/earth/literature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attach_citation",
          nodeUuid: selectedNode.uuid,
          doi: citation.doi,
          citation,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to verify and attach citation.");
      if (data.updatedSnapshot) {
        onSnapshotChange(
          data.updatedSnapshot,
          `Verified and attached citation to "${selectedNode.properties.name}".`
        );
      }
      setStatusMsg(
        data.citation?.doi_verified
          ? `Verified DOI ${data.citation.doi} via Crossref and attached to briefing.`
          : `Attached peer-reviewed citation to briefing.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to attach citation.");
    } finally {
      setLitAttachingDoi(null);
    }
  };

  const badge = provenanceBadgeLabel(
    isFallbackPreview ? undefined : activeDossier?.researched_by
  );

  const counts = useMemo(() => {
    const withDossier = nodes.filter((n) => n.label !== "Rule" && Boolean(n.properties.dossier));
    const withDois = withDossier.filter((n) => (n.properties.dossier?.citations.length ?? 0) > 0);
    const corroborated = nodes.filter((n) => Boolean(n.properties.corroborated));
    return {
      briefings: withDossier.length,
      citations: withDois.length,
      corroborated: corroborated.length,
      all: nodes.filter((n) => n.label !== "Rule").length,
    };
  }, [nodes]);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: "any" } as Record<string, unknown>)}
      aria-labelledby={titleId}
      onClose={handleNativeClose}
      className="etg-dialog etg-dialog--wide overflow-hidden shadow-2xl"
    >
      {/* Modal Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-header px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent-fg/30 bg-accent/15 text-accent-fg">
            <BookOpenText className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2
              id={titleId}
              className="truncate font-outfit text-base font-semibold tracking-tight text-text-primary"
            >
              Earth Trend Research Briefings
            </h2>
            <p className="truncate text-[11px] text-text-muted">
              Peer-reviewed mechanisms, multi-agency evidence provenance, and epistemic belief revisions attached to ETG nodes
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close("close")}
          aria-label="Close research briefings"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-inset text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Main Split Broadsheet Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* Left Navigation & Search Column */}
        <aside className="flex min-h-0 w-full flex-col border-b border-border bg-surface-inset/50 max-md:max-h-[34dvh] md:h-full md:w-80 md:shrink-0 md:border-r md:border-b-0">
          <search aria-label="Search and filter research briefings" className="block space-y-1.5 border-b border-border p-2.5">
            <div className="relative flex items-center">
              <Search
                className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-text-subtle"
                aria-hidden="true"
              />
              <label htmlFor={`${titleId}-search`} className="sr-only">
                Search briefings, DOIs, or regions
              </label>
              <input
                id={`${titleId}-search`}
                type="search"
                autoFocus
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                }}
                placeholder="Search briefings, DOIs, regions…"
                className="form-input pl-8 text-xs"
              />
            </div>

            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter trend briefings">
              {(
                [
                  { id: "briefings", label: `Briefings (${counts.briefings})` },
                  { id: "citations", label: `DOIs (${counts.citations})` },
                  { id: "corroborated", label: `Verified (${counts.corroborated})` },
                  { id: "all", label: `All Nodes (${counts.all})` },
                ] as const
              ).map((tab) => {
                const active = filterMode === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilterMode(tab.id)}
                    className={`rounded-sm border px-2 py-0.5 text-[10.5px] font-medium transition-colors cursor-pointer ${
                      active
                        ? "border-accent-fg bg-accent/15 text-accent-fg"
                        : "border-border bg-surface text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </search>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-2">
            {filteredNodes.length === 0 ? (
              <div className="p-4 text-center text-xs text-text-subtle">
                No briefings match your search filter.
              </div>
            ) : (
              filteredNodes.map((n) => {
                const selected = selectedNode?.uuid === n.uuid;
                const d = n.properties.dossier;
                const color = resolveEtgNodeColor(n);
                const citeCount = d?.citations.length ?? 0;
                return (
                  <button
                    key={n.uuid}
                    type="button"
                    onClick={() => {
                      setActiveNodeUuid(n.uuid);
                      setEditMode(false);
                      setErrorMsg(null);
                      setStatusMsg(null);
                    }}
                    className={`w-full rounded-md border p-2 text-left transition-colors cursor-pointer ${
                      selected
                        ? "border-accent-fg bg-surface-elevated shadow-xs"
                        : "border-transparent bg-surface/60 hover:border-border hover:bg-surface"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: color }}
                          aria-hidden="true"
                        />
                        {n.label}
                      </span>
                      <div className="flex items-center gap-1">
                        {n.properties.corroborated && (
                          <CheckCircle2
                            className="h-3 w-3 text-emerald-400"
                            aria-label="Corroborated"
                          />
                        )}
                        {citeCount > 0 && (
                          <span className="rounded-xs border border-border bg-surface-inset px-1 font-mono text-[9.5px] text-text-muted">
                            {citeCount} DOI{citeCount > 1 ? "s" : ""}
                          </span>
                        )}
                        {!d && (
                          <span className="rounded-xs border border-border bg-surface-inset px-1 text-[9.5px] text-text-subtle">
                            Live
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-text-primary">
                      {n.properties.name}
                    </div>
                    {n.properties.region && (
                      <div className="mt-0.5 truncate text-[10.5px] text-text-subtle">
                        {n.properties.region}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Reader / Composer Pane */}
        <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-6">
          {!selectedNode || !activeDossier ? (
            <div className="flex h-full items-center justify-center text-xs text-text-muted">
              Select a trend Insight or Signal to inspect its scientific briefing.
            </div>
          ) : (
            <div className="etg-prose space-y-3">
              {/* Top Briefing Header */}
              <div className="space-y-2 border-b border-border pb-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-sm border px-2 py-0.5 text-[10.5px] font-medium ${badge.cls}`}>
                      {badge.text}
                    </span>
                    {selectedNode.properties.corroborated && (
                      <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-400/40 bg-emerald-950/50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-300">
                        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                        Corroborated ({selectedNode.properties.independent_sources_count ?? 2}+ sources)
                      </span>
                    )}
                    {selectedNode.properties.status === "Superseded" && (
                      <span className="rounded-sm border border-amber-400/50 bg-amber-950/60 px-2 py-0.5 text-[10.5px] font-medium text-amber-300">
                        Superseded Revision
                      </span>
                    )}
                    {selectedNode.properties.dataset && (
                      <span className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[10.5px] text-text-muted">
                        {DATASET_BY_ID[selectedNode.properties.dataset]?.label ??
                          selectedNode.properties.dataset}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10.5px] text-text-subtle">
                    Updated {activeDossier.updated_at.slice(0, 10)}
                  </span>
                </div>

                <h3 className="font-outfit text-lg font-semibold leading-snug text-text-primary">
                  {selectedNode.properties.name}
                </h3>

                {/* Quantitative Metrics Strip */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="ws-inset p-2">
                    <div className="ws-eyebrow">Theil-Sen Slope</div>
                    <div className="ws-numeric mt-0.5 font-mono text-xs font-semibold text-text-primary">
                      {typeof selectedNode.properties.theil_sen_slope === "number"
                        ? `${selectedNode.properties.theil_sen_slope >= 0 ? "+" : ""}${selectedNode.properties.theil_sen_slope.toFixed(4)} ${selectedNode.properties.slope_unit || ""}`
                        : "n/a"}
                    </div>
                  </div>
                  <div className="ws-inset p-2">
                    <div className="ws-eyebrow">Mann-Kendall p</div>
                    <div className="ws-numeric mt-0.5 font-mono text-xs font-semibold text-text-primary">
                      {typeof selectedNode.properties.p_value === "number"
                        ? selectedNode.properties.p_value.toExponential(2)
                        : "n/a"}
                    </div>
                  </div>
                  <div className="ws-inset p-2">
                    <div className="ws-eyebrow">Hamed-Rao p*</div>
                    <div className="ws-numeric mt-0.5 font-mono text-xs font-semibold text-text-primary">
                      {typeof selectedNode.properties.p_value_adjusted === "number"
                        ? selectedNode.properties.p_value_adjusted.toFixed(4)
                        : "n/a"}
                    </div>
                  </div>
                  <div className="ws-inset p-2">
                    <div className="ws-eyebrow">Region / Coords</div>
                    <div className="truncate mt-0.5 text-xs font-medium text-text-primary">
                      {selectedNode.properties.region ||
                        (typeof selectedNode.properties.lat === "number" &&
                        typeof selectedNode.properties.lng === "number"
                          ? `${selectedNode.properties.lat.toFixed(1)}°, ${selectedNode.properties.lng.toFixed(1)}°`
                          : "Global")}
                    </div>
                  </div>
                </div>

                {/* Toolbar Actions */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      dialogRef.current?.close("locate");
                      onLocateOnGlobe(selectedNode);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-accent-fg cursor-pointer"
                  >
                    <Globe2 className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
                    Locate on 3D Globe
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      dialogRef.current?.close("graph");
                      onOpenInGraph(selectedNode.uuid);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-accent-fg cursor-pointer"
                  >
                    <Network className="h-3.5 w-3.5 text-accent-fg" aria-hidden="true" />
                    Open in Graph
                  </button>
                  <button
                    type="button"
                    disabled={busyAi}
                    onClick={() => void handleSynthesizeWithAi()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-accent-fg/40 bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent-fg transition-colors hover:bg-accent/25 disabled:opacity-50 cursor-pointer"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    {busyAi ? "Synthesizing…" : "Synthesize Research with AI"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      editMode ? setEditMode(false) : openEditorForSelected()
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-inset px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary cursor-pointer"
                  >
                    <FilePenLine className="h-3.5 w-3.5" aria-hidden="true" />
                    {editMode ? "Cancel Edit" : "Edit Briefing"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadMarkdown}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-inset px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Export .md
                  </button>
                </div>
              </div>

              {errorMsg && (
                <div
                  role="alert"
                  className="rounded-md border border-rose-400/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200"
                >
                  {errorMsg}
                </div>
              )}
              {statusMsg && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-md border border-emerald-400/50 bg-emerald-950/60 px-3 py-2 text-xs text-emerald-200"
                >
                  {statusMsg}
                </div>
              )}

              {/* Epistemic Belief Lineage Banner */}
              {(lineage.supersedes.length > 0 || lineage.supersededBy.length > 0) && (
                <div className="rounded-md border border-amber-400/35 bg-amber-950/25 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                    <Waypoints className="h-3.5 w-3.5" aria-hidden="true" />
                    Epistemic Belief Revision Lineage
                  </div>
                  {lineage.supersedes.map(({ node: older, rationale }) => {
                    const hasSlopeCmp =
                      typeof older.properties.theil_sen_slope === "number" &&
                      typeof selectedNode.properties.theil_sen_slope === "number";
                    return (
                      <div key={older.uuid} className="text-xs text-text-muted leading-relaxed">
                        <span className="font-semibold text-text-primary">Supersedes prior conclusion: </span>
                        <button
                          type="button"
                          onClick={() => setActiveNodeUuid(older.uuid)}
                          className="underline decoration-amber-400/60 underline-offset-2 hover:text-amber-300 cursor-pointer"
                        >
                          {older.properties.name}
                        </button>
                        {hasSlopeCmp && (
                          <span className="ws-numeric ml-1.5 inline-block rounded-xs border border-amber-500/30 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
                            Prior {formatSignedSlope(older.properties.theil_sen_slope!, older.properties.slope_unit)} → Current{" "}
                            {formatSignedSlope(
                              selectedNode.properties.theil_sen_slope!,
                              selectedNode.properties.slope_unit
                            )}
                          </span>
                        )}
                        {rationale ? ` — ${rationale}` : ""}
                      </div>
                    );
                  })}
                  {lineage.supersededBy.map(({ node: newer, rationale }) => {
                    const hasSlopeCmp =
                      typeof newer.properties.theil_sen_slope === "number" &&
                      typeof selectedNode.properties.theil_sen_slope === "number";
                    return (
                      <div key={newer.uuid} className="text-xs text-text-muted leading-relaxed">
                        <span className="font-semibold text-amber-300">Superseded by newer finding: </span>
                        <button
                          type="button"
                          onClick={() => setActiveNodeUuid(newer.uuid)}
                          className="underline decoration-amber-400/60 underline-offset-2 hover:text-amber-200 cursor-pointer"
                        >
                          {newer.properties.name}
                        </button>
                        {hasSlopeCmp && (
                          <span className="ws-numeric ml-1.5 inline-block rounded-xs border border-amber-500/30 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
                            This baseline {formatSignedSlope(selectedNode.properties.theil_sen_slope!, selectedNode.properties.slope_unit)} → Revised{" "}
                            {formatSignedSlope(newer.properties.theil_sen_slope!, newer.properties.slope_unit)}
                          </span>
                        )}
                        {rationale ? ` — ${rationale}` : ""}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Disconfirming / Contradicting Evidence Callout */}
              {contradictions.length > 0 && (
                <div className="rounded-md border border-rose-500/40 bg-rose-950/25 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-300">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    Disconfirming / Contrasting Evidence ({contradictions.length})
                  </div>
                  {contradictions.map(({ node: peer, direction, rationale }) => (
                    <div key={`${peer.uuid}-${direction}`} className="text-xs text-text-muted leading-relaxed">
                      <span className="font-semibold text-rose-200">
                        {direction === "incoming" ? "Contradicted by: " : "Contradicts: "}
                      </span>
                      <button
                        type="button"
                        onClick={() => setActiveNodeUuid(peer.uuid)}
                        className="underline decoration-rose-400/60 underline-offset-2 hover:text-rose-200 cursor-pointer"
                      >
                        {peer.properties.name}
                      </button>
                      {rationale ? ` — ${rationale}` : ""}
                    </div>
                  ))}
                </div>
              )}

              {isFallbackPreview && !editMode && (
                <div className="rounded-md border border-border bg-surface-inset/70 p-3 text-xs text-text-muted">
                  This node does not yet have a curated research briefing attached. Below is a live statistical summary generated from its persisted ETG telemetry. Click{" "}
                  <strong className="text-text-primary">Synthesize Research with AI</strong> or{" "}
                  <strong className="text-text-primary">Edit Briefing</strong> to attach mechanisms and peer-reviewed DOIs.
                </div>
              )}

              {editMode ? (
                <form onSubmit={(e) => void handleSaveManualDossier(e)} className="space-y-3">
                  <div>
                    <label className="ws-eyebrow mb-1 block">Scientific Abstract *</label>
                    <textarea
                      required
                      rows={3}
                      value={draftAbstract}
                      onChange={(e) => setDraftAbstract(e.target.value)}
                      className="form-input text-xs"
                    />
                  </div>
                  <div>
                    <label className="ws-eyebrow mb-1 block">Physical Mechanism</label>
                    <textarea
                      rows={3}
                      value={draftMechanism}
                      onChange={(e) => setDraftMechanism(e.target.value)}
                      className="form-input text-xs"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="ws-eyebrow mb-1 block">
                        Empirical Findings (one per line; wrap IDs as [node-uuid])
                      </label>
                      <textarea
                        rows={4}
                        value={draftFindings}
                        onChange={(e) => setDraftFindings(e.target.value)}
                        className="form-input text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="ws-eyebrow mb-1 block">
                        Regional &amp; Earth Impacts (one per line)
                      </label>
                      <textarea
                        rows={4}
                        value={draftImpacts}
                        onChange={(e) => setDraftImpacts(e.target.value)}
                        className="form-input text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="ws-eyebrow mb-1 block">
                      Extended Briefing Narrative (Markdown)
                    </label>
                    <textarea
                      rows={4}
                      value={draftMarkdown}
                      onChange={(e) => setDraftMarkdown(e.target.value)}
                      className="form-input text-xs font-mono"
                    />
                  </div>

                  {/* Citations Editor */}
                  <div className="space-y-2 rounded-md border border-border bg-surface-inset/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="ws-eyebrow">Peer-Reviewed Citations ({draftCitations.length})</span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraftCitations((prev) => [
                            ...prev,
                            {
                              title: "",
                              authors: "",
                              journal: "",
                              year: new Date().getUTCFullYear(),
                              doi: "",
                            },
                          ])
                        }
                        className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-2 py-0.5 text-[10.5px] font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                      >
                        <Plus className="h-3 w-3" aria-hidden="true" />
                        Add Citation
                      </button>
                    </div>
                    {draftCitations.map((cit, idx) => (
                      <div
                        key={idx}
                        className="grid gap-1.5 rounded-sm border border-border bg-surface p-2 sm:grid-cols-6"
                      >
                        <input
                          type="text"
                          placeholder="Paper title"
                          value={cit.title}
                          onChange={(e) =>
                            setDraftCitations((prev) =>
                              prev.map((c, i) => (i === idx ? { ...c, title: e.target.value } : c))
                            )
                          }
                          className="form-input text-xs sm:col-span-4"
                        />
                        <input
                          type="number"
                          placeholder="Year"
                          value={cit.year}
                          onChange={(e) =>
                            setDraftCitations((prev) =>
                              prev.map((c, i) =>
                                i === idx ? { ...c, year: Number(e.target.value) || 2024 } : c
                              )
                            )
                          }
                          className="form-input text-xs sm:col-span-1"
                        />
                        <button
                          type="button"
                          aria-label="Remove citation"
                          onClick={() =>
                            setDraftCitations((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="inline-flex items-center justify-center rounded-sm border border-rose-400/40 bg-rose-950/40 px-2 py-1 text-rose-300 hover:border-rose-400 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <input
                          type="text"
                          placeholder="Authors (e.g. Rantanen, M., et al.)"
                          value={cit.authors}
                          onChange={(e) =>
                            setDraftCitations((prev) =>
                              prev.map((c, i) => (i === idx ? { ...c, authors: e.target.value } : c))
                            )
                          }
                          className="form-input text-xs sm:col-span-2"
                        />
                        <input
                          type="text"
                          placeholder="Journal"
                          value={cit.journal ?? ""}
                          onChange={(e) =>
                            setDraftCitations((prev) =>
                              prev.map((c, i) => (i === idx ? { ...c, journal: e.target.value } : c))
                            )
                          }
                          className="form-input text-xs sm:col-span-2"
                        />
                        <input
                          type="text"
                          placeholder="DOI (e.g. 10.1038/...)"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={cit.doi ?? ""}
                          onChange={(e) =>
                            setDraftCitations((prev) =>
                              prev.map((c, i) => (i === idx ? { ...c, doi: e.target.value } : c))
                            )
                          }
                          className="form-input text-xs font-mono sm:col-span-2"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditMode(false)}
                      className="rounded-md border border-border bg-surface-inset px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text-primary cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={busySave}
                      className="rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                    >
                      {busySave ? "Saving…" : "Save Research Briefing"}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="space-y-4">
                  {/* Abstract */}
                  <section className="space-y-1.5">
                    <h4 className="ws-eyebrow">Abstract</h4>
                    <p className="text-sm leading-relaxed text-text-primary">
                      {renderInlineEvidenceText(
                        activeDossier.abstract,
                        nodeById,
                        (uuid) => setActiveNodeUuid(uuid)
                      )}
                    </p>
                  </section>

                  {/* Physical Mechanism */}
                  {activeDossier.physical_mechanism && (
                    <section className="space-y-1.5 rounded-md border border-border bg-surface-inset/50 p-3">
                      <h4 className="ws-eyebrow">Physical Mechanism</h4>
                      <p className="text-xs leading-relaxed text-text-muted">
                        {renderInlineEvidenceText(
                          activeDossier.physical_mechanism,
                          nodeById,
                          (uuid) => setActiveNodeUuid(uuid)
                        )}
                      </p>
                    </section>
                  )}

                  {/* Empirical Findings */}
                  {activeDossier.empirical_findings.length > 0 && (
                    <section className="space-y-1.5">
                      <h4 className="ws-eyebrow">Empirical Findings &amp; Linked Telemetry</h4>
                      <ul className="list-disc space-y-1.5 pl-5 text-xs text-text-muted">
                        {activeDossier.empirical_findings.map((finding, idx) => (
                          <li key={idx} className="leading-relaxed">
                            {renderInlineEvidenceText(
                              finding,
                              nodeById,
                              (uuid) => setActiveNodeUuid(uuid)
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* Impacts */}
                  {activeDossier.impacts && activeDossier.impacts.length > 0 && (
                    <section className="space-y-1.5">
                      <h4 className="ws-eyebrow">Earth-System &amp; Regional Impacts</h4>
                      <ul className="list-disc space-y-1 pl-5 text-xs text-text-muted">
                        {activeDossier.impacts.map((imp, idx) => (
                          <li key={idx} className="leading-relaxed">
                            {renderInlineEvidenceText(
                              imp,
                              nodeById,
                              (uuid) => setActiveNodeUuid(uuid)
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* Extended Markdown Narrative */}
                  {activeDossier.markdown_body && (
                    <section className="space-y-1.5 border-t border-border pt-3">
                      {renderSafeMarkdownProse(
                        activeDossier.markdown_body,
                        nodeById,
                        (uuid) => setActiveNodeUuid(uuid)
                      )}
                    </section>
                  )}

                  {/* Peer-Reviewed Citations */}
                  {activeDossier.citations.length > 0 && (
                    <section className="space-y-2 border-t border-border pt-3">
                      <h4 className="ws-eyebrow">
                        Peer-Reviewed Scientific Literature ({activeDossier.citations.length})
                      </h4>
                      <ol className="space-y-2">
                        {activeDossier.citations.map((cit, idx) => {
                          const href =
                            cit.url || (cit.doi ? `https://doi.org/${cit.doi}` : undefined);
                          return (
                            <li
                              key={`${cit.title}-${idx}`}
                              className="rounded-md border border-border bg-surface-inset/50 p-2.5 text-xs"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="font-semibold text-text-primary leading-snug">
                                  {cit.title}
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-1">
                                  {renderCitationStanceBadge(cit)}
                                  {cit.doi_verified && (
                                    <span className="inline-flex items-center gap-1 rounded-xs border border-emerald-500/40 bg-emerald-950/40 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-300">
                                      <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />
                                      DOI Verified
                                    </span>
                                  )}
                                  {typeof cit.citation_count === "number" && (
                                    <span className="ws-numeric rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                                      Cited by {cit.citation_count.toLocaleString()}
                                    </span>
                                  )}
                                  {cit.source && (
                                    <span className="rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase text-text-subtle">
                                      {cit.source.replace("_", " ")}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="mt-0.5 text-[11px] text-text-muted">
                                {cit.authors} ({cit.year})
                                {cit.journal ? ` · ${cit.journal}` : ""}
                              </div>
                              {href && (
                                <div className="mt-1">
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 font-mono text-[10.5px] text-accent-fg hover:underline"
                                  >
                                    <span>{cit.doi ? `DOI: ${cit.doi}` : href}</span>
                                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                  </a>
                                </div>
                              )}
                              {renderAbstractDisclosure(cit)}
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  )}

                  {/* Live Scholarly Literature Search (Crossref & Europe PMC) */}
                  <section className="space-y-2 border-t border-border pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="ws-eyebrow">
                        Live Peer-Reviewed Literature Search (Crossref &amp; Europe PMC)
                      </h4>
                      <button
                        type="button"
                        disabled={litLoading}
                        onClick={() => void handleSearchLiterature()}
                        className="inline-flex items-center gap-1 rounded-sm border border-accent-fg/40 bg-accent/10 px-2 py-0.5 text-[10.5px] font-medium text-accent-fg hover:bg-accent/20 disabled:opacity-50 cursor-pointer"
                      >
                        <Search className="h-3 w-3" aria-hidden="true" />
                        <span>{litLoading ? "Searching…" : "Auto-Find Papers"}</span>
                      </button>
                    </div>
                    <search aria-label="Search peer-reviewed Earth science literature" className="block">
                      <form
                        onSubmit={(e) => void handleSearchLiterature(e)}
                        className="flex items-center gap-2"
                      >
                        <label htmlFor={`${titleId}-lit-query`} className="sr-only">
                          Search Crossref and Europe PMC for peer-reviewed papers
                        </label>
                        <input
                          id={`${titleId}-lit-query`}
                          type="search"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={litQuery}
                          onChange={(e) => setLitQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                              e.preventDefault();
                              e.currentTarget.form?.requestSubmit();
                            }
                          }}
                          placeholder="Search papers by mechanism, region, or DOI…"
                          className="form-input flex-1 text-xs"
                        />
                        <button
                          type="submit"
                          disabled={litLoading}
                          className="rounded-sm border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary hover:border-accent-fg disabled:opacity-50 cursor-pointer"
                        >
                          {litLoading ? "Searching…" : "Search Literature"}
                        </button>
                      </form>
                    </search>
                    {litResults.length > 0 && (
                      <ul className="space-y-2 pt-1">
                        {litResults.map((hit, idx) => {
                          const attachKey = hit.doi || hit.title;
                          const alreadyCited = activeDossier.citations.some(
                            (c) =>
                              (hit.doi && c.doi?.toLowerCase() === hit.doi.toLowerCase()) ||
                              c.title.toLowerCase() === hit.title.toLowerCase()
                          );
                          return (
                            <li
                              key={`${attachKey}-${idx}`}
                              className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-inset/40 p-2.5 text-xs"
                            >
                              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-medium text-text-primary leading-snug">
                                      {hit.title}
                                    </span>
                                    {renderCitationStanceBadge(hit)}
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    {hit.authors} ({hit.year})
                                    {hit.journal ? ` · ${hit.journal}` : ""}
                                    {typeof hit.citation_count === "number"
                                      ? ` · Cited by ${hit.citation_count.toLocaleString()}`
                                      : ""}
                                  </div>
                                  {hit.doi && (
                                    <div className="font-mono text-[10px] text-accent-fg">
                                      DOI: {hit.doi}
                                    </div>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  disabled={alreadyCited || litAttachingDoi === attachKey}
                                  onClick={() => void handleAttachLiteratureCitation(hit)}
                                  className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-emerald-500/40 bg-emerald-950/35 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-950/60 disabled:opacity-50 cursor-pointer"
                                >
                                  <Plus className="h-3 w-3" aria-hidden="true" />
                                  <span>
                                    {alreadyCited
                                      ? "Cited"
                                      : litAttachingDoi === attachKey
                                        ? "Verifying…"
                                        : "+ Cite in Briefing"}
                                  </span>
                                </button>
                              </div>
                              {renderAbstractDisclosure(hit)}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  {/* Graph Neighborhood Quick Jump */}
                  {connectedSignals.length > 0 && (
                    <section className="space-y-1.5 border-t border-border pt-3">
                      <h4 className="ws-eyebrow">Connected ETG Evidence Nodes</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {connectedSignals.map(({ node: peer, relation, r }) => (
                          <button
                            key={peer.uuid}
                            type="button"
                            onClick={() => setActiveNodeUuid(peer.uuid)}
                            className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-inset px-2 py-1 text-[10.5px] text-text-muted transition-colors hover:border-accent-fg hover:text-text-primary cursor-pointer"
                          >
                            <span className="font-mono text-[9.5px] text-text-subtle">
                              {relation}
                            </span>
                            <span className="max-w-44 truncate font-medium text-text-primary">
                              {peer.properties.name}
                            </span>
                            {typeof r === "number" && (
                              <span className="font-mono text-[9.5px] text-accent-fg">
                                r={r.toFixed(2)}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </dialog>
  );
}
