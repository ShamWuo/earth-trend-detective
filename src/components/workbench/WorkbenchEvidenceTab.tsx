"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpenText, Bot, Sparkles, TrendingUp, Waypoints } from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import type { ETGNode } from "@/types/etg";
import { renderFormattedBriefing } from "./briefingFormatUtils";

export interface WorkbenchEvidenceTabProps {
  selectedNode: ETGNode;
  nodeById?: ReadonlyMap<string, ETGNode>;
  busy: boolean;
  localError: string | null;
  localStatus: string | null;
  onSetBusy: (busy: boolean) => void;
  onSetLocalError: (msg: string | null) => void;
  onSetLocalStatus: (msg: string | null) => void;
  onSelectNode: (node: ETGNode) => void;
  onOpenBriefing?: (nodeUuid: string) => void;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
  onClose: () => void;
}

export function WorkbenchEvidenceTab({
  selectedNode,
  nodeById,
  busy,
  localError,
  localStatus,
  onSetBusy,
  onSetLocalError,
  onSetLocalStatus,
  onSelectNode,
  onOpenBriefing,
  onSnapshotChange,
  onClose: _onClose,
}: WorkbenchEvidenceTabProps) {
  const [aiBriefing, setAiBriefing] = useState<{ engine: string; briefing: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [reviseTitle, setReviseTitle] = useState("");
  const [reviseDesc, setReviseDesc] = useState("");
  const [reviseRationale, setReviseRationale] = useState("");
  const [reviseOpen, setReviseOpen] = useState(false);
  const lastNodeUuidRef = useRef<string | null>(null);
  const resolvedNodeById = useMemo(
    () => nodeById ?? new Map<string, ETGNode>([[selectedNode.uuid, selectedNode]]),
    [nodeById, selectedNode]
  );

  useEffect(() => {
    if (lastNodeUuidRef.current === selectedNode.uuid) return;
    lastNodeUuidRef.current = selectedNode.uuid;
    setAiBriefing(null);
    setReviseOpen(false);
  }, [selectedNode]);

  const handleAskNodeDetective = async () => {
    setAiLoading(true);
    onSetLocalError(null);
    try {
      const res = await fetch("/api/ai/detective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedNodeUuid: selectedNode.uuid,
          question:
            "Analyze multi-hop drivers, teleconnections, and predictive lift around this node.",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "AI synthesis failed");
      setAiBriefing({ engine: data.engine, briefing: data.briefing });
      if (data.updatedSnapshot) {
        onSnapshotChange(
          data.updatedSnapshot,
          `AI Detective applied ${data.appliedActions?.length ?? 1} verified graph edit(s).`
        );
      }
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "AI synthesis failed");
    } finally {
      setAiLoading(false);
    }
  };

  const handleSynthesizeDossier = async () => {
    setDossierLoading(true);
    onSetLocalError(null);
    try {
      const res = await fetch("/api/ai/detective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedNodeUuid: selectedNode.uuid,
          synthesizeDossier: true,
          question: `Synthesize a structured Earth-trend research briefing with physical mechanism, linked evidence, impacts, and peer-reviewed DOIs for "${selectedNode.properties.name}".`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Dossier synthesis failed");
      if (data.updatedSnapshot) {
        onSnapshotChange(data.updatedSnapshot, "Attached scientific research briefing.");
        onSetLocalStatus("Research briefing attached to node.");
      }
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "Dossier synthesis failed");
    } finally {
      setDossierLoading(false);
    }
  };

  const handleReviseBelief = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviseTitle.trim() || !reviseRationale.trim()) return;
    onSetBusy(true);
    onSetLocalError(null);
    try {
      const res = await fetch("/api/graph/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorNodeUuid: selectedNode.uuid,
          newName: reviseTitle.trim(),
          newDescription: reviseDesc.trim() || selectedNode.properties.description,
          rationale: reviseRationale.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Belief revision failed");
      onSnapshotChange(data.snapshot, "Recorded epistemic revision with supersedes edge.");
      setReviseTitle("");
      setReviseDesc("");
      setReviseRationale("");
      setReviseOpen(false);
      const revised = (data.revisedNode ?? data.newNode) as ETGNode | undefined;
      if (revised) onSelectNode(revised);
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "Belief revision failed");
    } finally {
      onSetBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Telemetry Summary */}
      <div className="grid grid-cols-2 gap-2">
        <div className="ws-inset p-3">
          <div className="ws-eyebrow">Mann-Kendall p</div>
          <div className="mt-1 font-mono ws-numeric text-sm font-semibold text-text-primary">
            {typeof selectedNode.properties.p_value === "number"
              ? selectedNode.properties.p_value.toFixed(4)
              : "n/a"}
          </div>
        </div>
        <div className="ws-inset p-3">
          <div className="ws-eyebrow">Theil-Sen Slope</div>
          <div className="mt-1 flex items-center gap-1.5 font-mono ws-numeric text-sm font-semibold text-text-primary">
            <TrendingUp className="h-3.5 w-3.5 text-teal-400" />
            {typeof selectedNode.properties.theil_sen_slope === "number"
              ? `${selectedNode.properties.theil_sen_slope >= 0 ? "+" : ""}${selectedNode.properties.theil_sen_slope.toFixed(3)}`
              : "n/a"}
          </div>
        </div>
      </div>

      {/* Scientific Research Briefing Card */}
      <div className="ws-inset space-y-2.5 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 ws-eyebrow">
            <BookOpenText className="h-3.5 w-3.5 text-accent-fg" aria-hidden="true" />
            <span>Scientific Briefing</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedNode.properties.contested && (
              <span className="inline-flex items-center gap-1 rounded-xs border border-rose-500/45 bg-rose-950/45 px-2 py-0.5 font-mono text-[10.5px] text-rose-300">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Contested ({selectedNode.properties.contradicting_sources_count ?? 1})
              </span>
            )}
            {selectedNode.properties.dossier?.citations?.length ? (
              <span className="rounded-xs border border-emerald-400/40 bg-emerald-950/50 px-2 py-0.5 font-mono text-[10.5px] text-emerald-300">
                {selectedNode.properties.dossier.citations.filter((c) => c.doi_verified).length > 0
                  ? `${selectedNode.properties.dossier.citations.filter((c) => c.doi_verified).length}/${selectedNode.properties.dossier.citations.length} DOI Verified`
                  : `${selectedNode.properties.dossier.citations.length} DOI${selectedNode.properties.dossier.citations.length > 1 ? "s" : ""}`}
              </span>
            ) : null}
          </div>
        </div>
        {selectedNode.properties.dossier ? (
          <p className="line-clamp-3 text-xs leading-relaxed text-text-muted">
            {selectedNode.properties.dossier.abstract}
          </p>
        ) : (
          <p className="text-xs leading-relaxed text-text-subtle">
            No curated research dossier is attached yet. Open the working paper or synthesize mechanisms and DOIs with AI.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {onOpenBriefing && (
            <button
              type="button"
              onClick={() => onOpenBriefing(selectedNode.uuid)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-sm border border-border bg-transparent px-3 py-1.5 text-xs font-medium text-text-muted hover:border-border-strong hover:text-text-primary cursor-pointer"
            >
              <BookOpenText className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
              <span>{selectedNode.properties.dossier ? "Read Paper" : "Open Paper"}</span>
            </button>
          )}
          <button
            type="button"
            disabled={dossierLoading}
            onClick={() => void handleSynthesizeDossier()}
            className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-accent-fg/40 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent-fg hover:bg-accent/25 disabled:opacity-50 cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{dossierLoading ? "Synthesizing…" : "Synthesize Dossier"}</span>
          </button>
        </div>
      </div>

      {/* AI Detective Synthesis */}
      <div className="space-y-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={aiLoading}
          onClick={() => void handleAskNodeDetective()}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-3 py-2 text-xs font-semibold text-accent-fg hover:border-accent-fg cursor-pointer"
        >
          <Bot className="h-3.5 w-3.5" />
          {aiLoading ? "Synthesizing Multi-Hop Evidence…" : "Run AI Graph Detective Synthesis"}
        </button>
        {aiBriefing && (
          <div className="ws-inset space-y-1.5 p-3">
            <div className="font-mono text-[11px] text-text-subtle">{aiBriefing.engine}</div>
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-text-primary">
              {renderFormattedBriefing(aiBriefing.briefing, resolvedNodeById, onSelectNode)}
            </div>
          </div>
        )}
      </div>

      {/* Epistemic Belief Revision */}
      <div className="space-y-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setReviseOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-muted hover:text-text-primary cursor-pointer"
        >
          <Waypoints className="h-3.5 w-3.5 text-amber-400" />
          {reviseOpen ? "Hide Epistemic Revision" : "Revise Finding (Supersedes Edge)…"}
        </button>
        {reviseOpen && (
          <form
            onSubmit={handleReviseBelief}
            className="space-y-2.5 rounded-md border border-border bg-surface-inset p-3.5"
          >
            <input
              type="text"
              required
              placeholder="Revised conclusion title"
              value={reviseTitle}
              onChange={(e) => setReviseTitle(e.target.value)}
              className="form-input"
            />
            <textarea
              rows={2}
              placeholder="Updated scientific explanation"
              value={reviseDesc}
              onChange={(e) => setReviseDesc(e.target.value)}
              className="form-input"
            />
            <input
              type="text"
              required
              placeholder="Why is the prior conclusion being superseded?"
              value={reviseRationale}
              onChange={(e) => setReviseRationale(e.target.value)}
              className="form-input"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-sm border border-amber-400 bg-amber-950 px-3 py-2 text-xs font-semibold text-amber-300 hover:border-amber-300 cursor-pointer"
            >
              Record Supersedes Revision
            </button>
          </form>
        )}
      </div>

      {localError && (
        <div
          role="alert"
          className="rounded-sm border border-rose-400 bg-rose-950 px-3 py-2 text-xs leading-relaxed text-rose-300"
        >
          {localError}
        </div>
      )}
      {localStatus && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-sm border border-emerald-400 bg-emerald-950 px-3 py-2 text-xs leading-relaxed text-emerald-300"
        >
          {localStatus}
        </div>
      )}
    </div>
  );
}
