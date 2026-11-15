"use client";

import React, { useState } from "react";
import { Plus, X } from "lucide-react";
import { DATASET_BY_ID, EARTH_TREND_DATASETS } from "@/lib/datasets";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import type {
  ETGDatasetId,
  ETGNode,
  ETGNodeLabel,
  ETGPhenomenonType,
  ETGRelationshipType,
  TrendAnalysisSummary,
} from "@/types/etg";
import {
  PHENOMENON_OPTIONS,
  RELATIONSHIP_OPTIONS,
  parseSeriesText,
} from "./workbenchShared";

export interface WorkbenchQuickAddNodeFormProps {
  baseId: string;
  allNodes: ETGNode[];
  onCloseQuickAdd: () => void;
  onSelectNode: (node: ETGNode) => void;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
}

export function WorkbenchQuickAddNodeForm({
  baseId,
  allNodes,
  onCloseQuickAdd,
  onSelectNode,
  onSnapshotChange,
}: WorkbenchQuickAddNodeFormProps) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newLabel, setNewLabel] = useState<ETGNodeLabel>("Signal");
  const [newPhenom, setNewPhenom] = useState<ETGPhenomenonType>("climate_trend");
  const [newDataset, setNewDataset] = useState<ETGDatasetId>("nasa_power");
  const [newRegion, setNewRegion] = useState("");
  const [newLat, setNewLat] = useState("");
  const [newLng, setNewLng] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newSeriesText, setNewSeriesText] = useState("");
  const [pulledSeriesText, setPulledSeriesText] = useState("");
  const [pulledSummary, setPulledSummary] = useState<TrendAnalysisSummary | null>(null);
  const [wireTargetUuid, setWireTargetUuid] = useState("");
  const [wireRelType, setWireRelType] = useState<ETGRelationshipType>("leads");

  const handlePullNasaSeries = async () => {
    const lat = Number(newLat);
    const lng = Number(newLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setLocalError("Enter valid numeric Lat & Lng first to pull NASA series.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch(
        `/api/earth/timeseries?lat=${lat}&lng=${lng}&dataset=${encodeURIComponent(newDataset)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok || !data.primary) {
        throw new Error(data.error || "Live NASA series unavailable for these coordinates.");
      }
      const primary = data.primary as TrendAnalysisSummary;
      const formattedSeries = primary.points
        .map((p) => `${p.date},${p.value.toFixed(3)}`)
        .join("\n");
      setPulledSummary(primary);
      setPulledSeriesText(formattedSeries);
      setNewSeriesText(formattedSeries);
      if (!newName.trim()) {
        setNewName(`${DATASET_BY_ID[newDataset].shortLabel} (${lat.toFixed(1)}°, ${lng.toFixed(1)}°)`);
      }
      if (!newDesc.trim()) {
        setNewDesc(
          `${primary.parameter}: slope ${primary.theilSen.slope >= 0 ? "+" : ""}${primary.theilSen.slope.toFixed(3)} ${primary.slopeUnit}, p=${primary.mannKendall.pValue.toFixed(4)} (${primary.provenance}).`
        );
      }
      setLocalStatus(`Pulled ${primary.points.length} NASA points.`);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to pull live NASA series");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateNodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newDesc.trim()) {
      setLocalError("Node title and description are required.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      const parsedSeries = parseSeriesText(newSeriesText);
      const latNum = newLat.trim() !== "" ? Number(newLat) : undefined;
      const lngNum = newLng.trim() !== "" ? Number(newLng) : undefined;
      const validLat = latNum !== undefined && Number.isFinite(latNum) ? latNum : undefined;
      const validLng = lngNum !== undefined && Number.isFinite(lngNum) ? lngNum : undefined;
      const tags = newTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const usingUneditedPull =
        Boolean(pulledSummary) && newSeriesText.trim() === pulledSeriesText.trim();
      const datasetMeta = DATASET_BY_ID[newDataset];
      const activeSummary = usingUneditedPull
        ? pulledSummary
        : parsedSeries.length >= 3
          ? analyzeTimeSeries(parsedSeries, {
              lat: validLat ?? 0,
              lng: validLng ?? 0,
              dataset: newDataset,
              parameter: datasetMeta?.label ?? "Observation",
              unit: datasetMeta?.unit ?? "units",
              slopeUnit: datasetMeta?.slopeUnit ?? `${datasetMeta?.unit ?? "units"}/yr`,
              provenance: "Empirical Dataset (Imported)",
            })
          : null;

      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node: {
            label: newLabel,
            is_provisional: false,
            properties: {
              name: newName.trim(),
              description: newDesc.trim(),
              phenomenon_type: newPhenom,
              dataset: newDataset,
              region: newRegion.trim() || undefined,
              domain_tags: tags.length > 0 ? tags : undefined,
              authored_by: "human",
              lat: validLat,
              lng: validLng,
              unit: activeSummary?.unit || datasetMeta?.unit,
              p_value: activeSummary?.mannKendall.pValue,
              theil_sen_slope: activeSummary?.theilSen.slope,
              slope_unit: activeSummary?.slopeUnit,
              series: parsedSeries.length > 0 ? parsedSeries : undefined,
              observed_at: new Date().toISOString(),
            },
          },
          edge: wireTargetUuid
            ? {
                source_uuid: "$NEW_NODE",
                target_uuid: wireTargetUuid,
                type: wireRelType,
                authored_by: "human",
              }
            : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create node");
      onSnapshotChange(data.snapshot, `Added phenomenon "${newName.trim()}" to ETG.`);
      setNewName("");
      setNewDesc("");
      setNewRegion("");
      setNewLat("");
      setNewLng("");
      setNewTags("");
      setNewSeriesText("");
      setPulledSeriesText("");
      setPulledSummary(null);
      setWireTargetUuid("");
      onCloseQuickAdd();
      if (data.node) onSelectNode(data.node as ETGNode);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to create node");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="etg-hud-pill flex max-h-[calc(100dvh-4.25rem)] flex-col overflow-hidden rounded-md bg-surface shadow-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5 text-accent-fg" />
          <h2 className="text-[13px] font-semibold text-text-primary">Add Phenomenon to Graph</h2>
        </div>
        <button
          type="button"
          onClick={onCloseQuickAdd}
          aria-label="Close node creator"
          className="etg-hud-btn inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-band hover:text-text-primary cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        onSubmit={handleCreateNodeSubmit}
        className="flex min-h-0 flex-1 flex-col text-xs"
      >
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2.5">
        <div>
          <label htmlFor={`${baseId}-new-name`} className="ws-eyebrow mb-1 block">
            Title
          </label>
          <input
            id={`${baseId}-new-name`}
            type="text"
            required
            placeholder="e.g., Colorado Wildfire Smoke Plume or ENSO Niño 3.4"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="form-input"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={`${baseId}-new-label`} className="ws-eyebrow mb-1 block">
              Ontology Role
            </label>
            <select
              id={`${baseId}-new-label`}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value as ETGNodeLabel)}
              className="form-input"
            >
              <option value="Signal">Signal (Observation / Station)</option>
              <option value="Insight">Insight (Pattern / Mechanism)</option>
              <option value="Concept">Concept (Earth System / Index)</option>
              <option value="Rule">Rule (Verification Gate)</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${baseId}-new-phenom`} className="ws-eyebrow mb-1 block">
              Phenomenon Type
            </label>
            <select
              id={`${baseId}-new-phenom`}
              value={newPhenom}
              onChange={(e) => setNewPhenom(e.target.value as ETGPhenomenonType)}
              className="form-input"
            >
              {PHENOMENON_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={`${baseId}-new-ds`} className="ws-eyebrow mb-1 block">
              Domain / Dataset
            </label>
            <select
              id={`${baseId}-new-ds`}
              value={newDataset}
              onChange={(e) => setNewDataset(e.target.value as ETGDatasetId)}
              className="form-input"
            >
              {EARTH_TREND_DATASETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.shortLabel}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${baseId}-new-region`} className="ws-eyebrow mb-1 block">
              Region (Optional)
            </label>
            <input
              id={`${baseId}-new-region`}
              type="text"
              placeholder="e.g., Front Range, Arctic"
              value={newRegion}
              onChange={(e) => setNewRegion(e.target.value)}
              className="form-input"
            />
          </div>
        </div>

        <div className="rounded-md border border-border bg-surface-inset p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="ws-eyebrow">Coordinates &amp; Live NASA Series</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePullNasaSeries()}
              className="rounded-sm border border-sky-400 bg-sky-950 px-2 py-0.5 text-[10px] font-semibold text-sky-300 hover:border-sky-300 disabled:opacity-50 cursor-pointer"
            >
              Pull Live NASA Series
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              step="any"
              aria-label="Latitude"
              placeholder="Lat (-90..90)"
              value={newLat}
              onChange={(e) => setNewLat(e.target.value)}
              className="form-input font-mono"
            />
            <input
              type="number"
              step="any"
              aria-label="Longitude"
              placeholder="Lng (-180..180)"
              value={newLng}
              onChange={(e) => setNewLng(e.target.value)}
              className="form-input font-mono"
            />
          </div>
          <textarea
            rows={2}
            aria-label="Time-series values"
            placeholder="Optional series: 2020:1.2 (one per line) or comma-separated numbers"
            value={newSeriesText}
            onChange={(e) => setNewSeriesText(e.target.value)}
            className="form-input font-mono text-[11px]"
          />
        </div>

        <div>
          <label htmlFor={`${baseId}-new-tags`} className="ws-eyebrow mb-1 block">
            Domain Tags (comma-separated)
          </label>
          <input
            id={`${baseId}-new-tags`}
            type="text"
            placeholder="solar, microgrid, smoke, crop_yield"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            className="form-input"
          />
        </div>

        <div>
          <label htmlFor={`${baseId}-new-desc`} className="ws-eyebrow mb-1 block">
            Scientific Description
          </label>
          <textarea
            id={`${baseId}-new-desc`}
            rows={2}
            required
            placeholder="Describe the physical process, measurement, or downstream impact."
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            className="form-input"
          />
        </div>

        {allNodes.length > 0 && (
          <div className="grid grid-cols-2 gap-2 border-t border-border pt-2">
            <div>
              <label htmlFor={`${baseId}-new-wire`} className="ws-eyebrow mb-1 block">
                Link Immediately To
              </label>
              <select
                id={`${baseId}-new-wire`}
                value={wireTargetUuid}
                onChange={(e) => setWireTargetUuid(e.target.value)}
                className="form-input"
              >
                <option value="">None (Standalone)</option>
                {allNodes.map((n) => (
                  <option key={n.uuid} value={n.uuid}>
                    {n.properties.name}
                  </option>
                ))}
              </select>
            </div>
            {wireTargetUuid && (
              <div>
                <label htmlFor={`${baseId}-new-rel`} className="ws-eyebrow mb-1 block">
                  Relationship
                </label>
                <select
                  id={`${baseId}-new-rel`}
                  value={wireRelType}
                  onChange={(e) => setWireRelType(e.target.value as ETGRelationshipType)}
                  className="form-input"
                >
                  {RELATIONSHIP_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.value.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

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
        <div className="shrink-0 border-t border-border bg-surface px-2.5 py-2">
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-sm bg-accent px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            {busy ? "Publishing Phenomenon…" : "Create Node in Knowledge Graph"}
          </button>
        </div>
      </form>
    </div>
  );
}
