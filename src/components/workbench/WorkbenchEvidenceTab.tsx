"use client";

import React, { useEffect, useRef, useState } from "react";
import { Bot, Trash2, TrendingUp, Waypoints } from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import type { ETGNode, ETGPhenomenonType } from "@/types/etg";
import { PHENOMENON_OPTIONS } from "./workbenchShared";

export interface WorkbenchEvidenceTabProps {
  selectedNode: ETGNode;
  busy: boolean;
  localError: string | null;
  localStatus: string | null;
  onSetBusy: (busy: boolean) => void;
  onSetLocalError: (msg: string | null) => void;
  onSetLocalStatus: (msg: string | null) => void;
  onSelectNode: (node: ETGNode) => void;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
  onClose: () => void;
}

export function WorkbenchEvidenceTab({
  selectedNode,
  busy,
  localError,
  localStatus,
  onSetBusy,
  onSetLocalError,
  onSetLocalStatus,
  onSelectNode,
  onSnapshotChange,
  onClose,
}: WorkbenchEvidenceTabProps) {
  const [editName, setEditName] = useState("");
  const [editPhenom, setEditPhenom] = useState<ETGPhenomenonType>("climate_trend");
  const [editRegion, setEditRegion] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [aiBriefing, setAiBriefing] = useState<{ engine: string; briefing: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [reviseTitle, setReviseTitle] = useState("");
  const [reviseDesc, setReviseDesc] = useState("");
  const [reviseRationale, setReviseRationale] = useState("");
  const [reviseOpen, setReviseOpen] = useState(false);
  const lastNodeUuidRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastNodeUuidRef.current === selectedNode.uuid) return;
    lastNodeUuidRef.current = selectedNode.uuid;
    setEditName(selectedNode.properties.name);
    setEditPhenom(selectedNode.properties.phenomenon_type ?? "climate_trend");
    setEditRegion(selectedNode.properties.region ?? "");
    setEditTags((selectedNode.properties.domain_tags ?? []).join(", "));
    setEditDesc(selectedNode.properties.description ?? "");
    setAiBriefing(null);
    setReviseOpen(false);
  }, [selectedNode]);

  const handleSaveNodeEdits = async (e: React.FormEvent) => {
    e.preventDefault();
    onSetBusy(true);
    onSetLocalError(null);
    try {
      const tags = editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await fetch("/api/graph", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeUuid: selectedNode.uuid,
          patch: {
            name: editName.trim() || selectedNode.properties.name,
            phenomenon_type: editPhenom,
            region: editRegion.trim(),
            domain_tags: tags,
            description: editDesc.trim() || selectedNode.properties.description,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update node");
      onSnapshotChange(data.snapshot, "Saved phenomenon updates.");
      onSetLocalStatus("Saved node metadata.");
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "Update failed");
    } finally {
      onSetBusy(false);
    }
  };

  const handleDeleteNode = async () => {
    onSetBusy(true);
    onSetLocalError(null);
    try {
      const res = await fetch(`/api/graph?nodeUuid=${encodeURIComponent(selectedNode.uuid)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete node");
      onSnapshotChange(data.snapshot, `Deleted "${selectedNode.properties.name}".`);
      onClose();
    } catch (err) {
      onSetLocalError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      onSetBusy(false);
    }
  };

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
    <div className="space-y-3.5 p-3.5">
      {/* Telemetry Summary */}
      <div className="grid grid-cols-2 gap-2">
        <div className="ws-inset p-2.5">
          <div className="ws-eyebrow">Mann-Kendall p</div>
          <div className="font-mono ws-numeric text-sm font-semibold text-text-primary mt-0.5">
            {typeof selectedNode.properties.p_value === "number"
              ? selectedNode.properties.p_value.toFixed(4)
              : "n/a"}
          </div>
        </div>
        <div className="ws-inset p-2.5">
          <div className="ws-eyebrow">Theil-Sen Slope</div>
          <div className="font-mono ws-numeric text-sm font-semibold text-text-primary mt-0.5 flex items-center gap-1">
            <TrendingUp className="h-3.5 w-3.5 text-teal-400" />
            {typeof selectedNode.properties.theil_sen_slope === "number"
              ? `${selectedNode.properties.theil_sen_slope >= 0 ? "+" : ""}${selectedNode.properties.theil_sen_slope.toFixed(3)}`
              : "n/a"}
          </div>
        </div>
      </div>

      {/* Metadata Editor */}
      <form onSubmit={handleSaveNodeEdits} className="space-y-2.5 border-t border-border pt-3">
        <div className="ws-eyebrow">Edit Phenomenon Metadata</div>
        <input
          type="text"
          aria-label="Edit node title"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          className="form-input"
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label="Edit phenomenon type"
            value={editPhenom}
            onChange={(e) => setEditPhenom(e.target.value as ETGPhenomenonType)}
            className="form-input"
          >
            {PHENOMENON_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Edit region"
            placeholder="Region"
            value={editRegion}
            onChange={(e) => setEditRegion(e.target.value)}
            className="form-input"
          />
        </div>
        <input
          type="text"
          aria-label="Edit domain tags"
          placeholder="Tags (comma-separated)"
          value={editTags}
          onChange={(e) => setEditTags(e.target.value)}
          className="form-input"
        />
        <textarea
          rows={3}
          aria-label="Edit description"
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          className="form-input"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-sm bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            Save Metadata
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleDeleteNode()}
            className="inline-flex items-center gap-1 rounded-sm border border-rose-400 bg-rose-950 px-2.5 py-1.5 font-semibold text-rose-300 hover:border-rose-300 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      </form>

      {/* AI Detective Synthesis */}
      <div className="space-y-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={aiLoading}
          onClick={() => void handleAskNodeDetective()}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-3 py-2 font-semibold text-accent-fg hover:border-accent-fg cursor-pointer"
        >
          <Bot className="h-3.5 w-3.5" />
          {aiLoading ? "Synthesizing Multi-Hop Evidence…" : "Run AI Graph Detective Synthesis"}
        </button>
        {aiBriefing && (
          <div className="ws-inset p-2.5 space-y-1">
            <div className="font-mono text-[10px] text-text-subtle">{aiBriefing.engine}</div>
            <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-text-primary">
              {aiBriefing.briefing}
            </p>
          </div>
        )}
      </div>

      {/* Epistemic Belief Revision */}
      <div className="border-t border-border pt-3 space-y-2">
        <button
          type="button"
          onClick={() => setReviseOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-text-muted hover:text-text-primary cursor-pointer"
        >
          <Waypoints className="h-3.5 w-3.5 text-amber-400" />
          {reviseOpen ? "Hide Epistemic Revision" : "Revise Finding (Supersedes Edge)…"}
        </button>
        {reviseOpen && (
          <form
            onSubmit={handleReviseBelief}
            className="space-y-2 rounded-md border border-border bg-surface-inset p-2.5"
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
              className="w-full rounded-sm border border-amber-400 bg-amber-950 px-3 py-1.5 font-semibold text-amber-300 hover:border-amber-300 cursor-pointer"
            >
              Record Supersedes Revision
            </button>
          </form>
        )}
      </div>

      {localError && (
        <div
          role="alert"
          className="rounded-sm border border-rose-400 bg-rose-950 px-2.5 py-1.5 text-[11px] text-rose-300"
        >
          {localError}
        </div>
      )}
      {localStatus && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-sm border border-emerald-400 bg-emerald-950 px-2.5 py-1.5 text-[11px] text-emerald-300"
        >
          {localStatus}
        </div>
      )}
    </div>
  );
}
