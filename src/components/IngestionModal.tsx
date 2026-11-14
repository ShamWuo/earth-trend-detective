"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Bot, Cpu, ExternalLink, FileSpreadsheet, Globe2, Satellite, Send, Upload, X } from "lucide-react";
import {
  CHALLENGE_SPACE_AGENCY_RESOURCES,
  EARTH_TREND_DATASETS,
} from "@/lib/datasets";
import type { ETGDatasetId, ETGNode } from "@/types/etg";

export type IngestionTabId = "dataset" | "agencies" | "mcp" | "webhook" | "community";

interface IngestionModalProps {
  open: boolean;
  initialTab?: IngestionTabId;
  onClose: () => void;
  nodes: ETGNode[];
  onIngested: () => Promise<void>;
}

export function IngestionModal({
  open,
  initialTab = "dataset",
  onClose,
  nodes,
  onIngested,
}: IngestionModalProps) {
  const titleId = useId();
  const baseId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [tab, setTab] = useState<IngestionTabId>(initialTab);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  // CSV / JSON Dataset Import state
  const [dsFormat, setDsFormat] = useState<"csv" | "json">("csv");
  const [dsSourceName, setDsSourceName] = useState("");
  const [dsContent, setDsContent] = useState("");
  const [dsStatus, setDsStatus] = useState("");
  const [dsError, setDsError] = useState("");

  // MCP Runner state
  const [mcpTool, setMcpTool] = useState("etg_discover_global_trends");
  const [mcpArgs, setMcpArgs] = useState('{\n  "max_eonet_sites": 7\n}');
  const [mcpOutput, setMcpOutput] = useState<string>("");
  const [running, setRunning] = useState(false);

  // Webhook state (no hardcoded coordinates or device IDs)
  const [whNodeId, setWhNodeId] = useState("");
  const [whLat, setWhLat] = useState("");
  const [whLng, setWhLng] = useState("");
  const [whValue, setWhValue] = useState("");
  const [whUnit, setWhUnit] = useState("");
  const [whDataset, setWhDataset] = useState<ETGDatasetId>("community");
  const [whStatus, setWhStatus] = useState<string>("");

  // Community Submission state (no hardcoded coordinates)
  const [obsName, setObsName] = useState("");
  const [obsDesc, setObsDesc] = useState("");
  const [obsLat, setObsLat] = useState("");
  const [obsLng, setObsLng] = useState("");
  const [obsDataset, setObsDataset] = useState<ETGDatasetId>("community");
  const [obsSupports, setObsSupports] = useState("");
  const [obsStatus, setObsStatus] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Mandatory closedby="any" bounding-box fallback for browsers lacking HTMLDialogElement.prototype.closedBy
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) dialog.close("backdrop");
      pressedOutside = false;
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  const handleNativeClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    onClose();
  };

  const handleDatasetFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setDsContent(text);
    setDsFormat(file.name.toLowerCase().endsWith(".json") ? "json" : "csv");
    if (!dsSourceName.trim()) {
      setDsSourceName(file.name.replace(/\.(csv|json)$/i, ""));
    }
    setDsError("");
  };

  const submitDatasetImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setDsStatus("");
    setDsError("");
    try {
      const res = await fetch("/api/earth/dataset-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: dsFormat,
          sourceName: dsSourceName.trim() || undefined,
          content: dsContent,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDsStatus(
          `Imported ${data.importedNodes?.length ?? 0} trend node(s) and wired ${data.connectionsWired ?? 0} cross-region connection(s).`
        );
        await onIngested();
      } else {
        setDsError(data.error || "Dataset import failed");
      }
    } catch (err) {
      setDsError(err instanceof Error ? err.message : "Dataset import failed");
    } finally {
      setRunning(false);
    }
  };

  const runLiveDiscoveryFromModal = async () => {
    setRunning(true);
    setDsStatus("");
    setDsError("");
    try {
      const res = await fetch("/api/earth/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxEonetSites: 7 }),
      });
      const data = await res.json();
      if (res.ok) {
        setDsStatus(
          `Ingested ${data.summary?.gistempZonesIngested ?? 0} GISTEMP zones, ${data.summary?.noaaCdoStationsIngested ?? 0} NOAA CDO stations, ${data.summary?.knmiIndicesIngested ?? 0} KNMI modes, ${data.summary?.csaGeocaSeriesIngested ?? 0} CSA/Geo.ca & USGS series, ${data.summary?.swotGranulesLinked ?? 0} SWOT passes, ${data.summary?.eonetEventsIngested ?? 0} EONET events; wired ${data.summary?.oppositeDipolesWired ?? 0} opposite & ${data.summary?.coTrendingTeleconnectionsWired ?? 0} teleconnections.`
        );
        await onIngested();
      } else {
        setDsError(data.error || "Live discovery failed");
      }
    } finally {
      setRunning(false);
    }
  };

  const runMcpTool = async () => {
    setRunning(true);
    setMcpOutput("");
    try {
      const parsedArgs = JSON.parse(mcpArgs || "{}");
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: mcpTool, arguments: parsedArgs },
        }),
      });
      const json = await res.json();
      setMcpOutput(JSON.stringify(json, null, 2));
      await onIngested();
    } catch (err) {
      setMcpOutput(err instanceof Error ? err.message : "Failed to run MCP tool");
    } finally {
      setRunning(false);
    }
  };

  const sendWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setWhStatus("");
    try {
      const res = await fetch(`/api/graph/nodes/${encodeURIComponent(whNodeId.trim())}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: whNodeId.trim(),
          dataset: whDataset,
          lat: Number(whLat),
          lng: Number(whLng),
          value: Number(whValue),
          unit: whUnit.trim() || "units",
          confidence: 0.92,
        }),
      });
      const data = await res.json();
      setWhStatus(
        res.ok
          ? `Ingested Signal "${data.signalNode?.uuid}" · linked to ${data.linkedInsights?.length ?? 0} trend(s).`
          : data.error || "Webhook failed"
      );
      if (res.ok) await onIngested();
    } finally {
      setRunning(false);
    }
  };

  const submitCommunitySignal = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setObsStatus("");
    try {
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node: {
            label: "Signal",
            is_provisional: false,
            properties: {
              name: obsName,
              description: obsDesc,
              lat: Number(obsLat),
              lng: Number(obsLng),
              dataset: obsDataset,
              producer_type: "iot_sensor",
              confidence: 0.87,
            },
          },
          edge: obsSupports
            ? {
                source_uuid: "$NEW_NODE",
                target_uuid: obsSupports,
                type: "corroborates",
                source_snippet: "Community field observation",
              }
            : undefined,
        }),
      });
      if (res.ok) {
        setObsStatus("Observation published to Earth Trend Graph.");
        setObsName("");
        setObsDesc("");
        await onIngested();
      } else {
        const d = await res.json();
        setObsStatus(d.error || "Submission failed");
      }
    } finally {
      setRunning(false);
    }
  };

  const insightNodes = nodes.filter((n) => n.label === "Insight");

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={handleNativeClose}
      className="etg-dialog"
      {...({ closedby: "any" } as Record<string, unknown>)}
    >
      {/* Dialog Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface-band px-4 py-3">
        <div>
          <h2 id={titleId} className="text-sm font-semibold text-text-primary">
            Real Dataset, Hardware &amp; AI-Native Ingestion
          </h2>
          <p className="text-[11px] text-text-subtle">
            Import empirical CSV/JSON series, stream live NASA/NOAA feeds, run MCP tools, or push sensor webhooks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close("close-button")}
          aria-label="Close ingestion modal"
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-text-muted hover:text-text-primary cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab Strip (border pseudo-element indicator via .etg-tab) */}
      <div
        role="tablist"
        aria-label="Data ingestion channels"
        className="etg-tablist flex-wrap bg-surface text-xs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "dataset"}
          onClick={() => setTab("dataset")}
          className="etg-tab flex items-center gap-1.5"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          Dataset Import
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "agencies"}
          onClick={() => setTab("agencies")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Satellite className="h-3.5 w-3.5" />
          Agency Hub (12)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "mcp"}
          onClick={() => setTab("mcp")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Bot className="h-3.5 w-3.5" />
          MCP &amp; OpenAPI
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "webhook"}
          onClick={() => setTab("webhook")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Cpu className="h-3.5 w-3.5" />
          Sensor Webhook
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "community"}
          onClick={() => setTab("community")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Globe2 className="h-3.5 w-3.5" />
          Field Signal
        </button>
      </div>

      {/* Scroll Body — padding lives inside child containers, never directly on [role="tabpanel"] */}
      <div className="flex-1 overflow-y-auto text-xs">
        <div role="tabpanel" hidden={tab !== "dataset"}>
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-inset p-3">
              <div>
                <div className="font-semibold text-text-primary">
                  NASA, NOAA, KNMI &amp; CSA Live Discovery
                </div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  Queries NASA GISTEMP v4, NOAA GML/CDO, NSIDC Sea Ice v4, KNMI indices, CSA/Geo.ca hydrology, SWOT passes, NASA EONET v3, and POWER MERRA-2.
                </div>
              </div>
              <button
                type="button"
                onClick={runLiveDiscoveryFromModal}
                disabled={running}
                className="rounded-lg bg-accent px-3 py-2 font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                {running ? "Discovering…" : "Run Live Discovery"}
              </button>
            </div>

            <form onSubmit={submitDatasetImport} className="space-y-3 border-t border-border pt-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${baseId}-ds-name`} className="ws-eyebrow mb-1 block">
                    Dataset Source Name
                  </label>
                  <input
                    id={`${baseId}-ds-name`}
                    name="source_name"
                    type="text"
                    placeholder="e.g., NASA Giovanni Chlorophyll / KNMI Index"
                    value={dsSourceName}
                    onChange={(e) => setDsSourceName(e.target.value)}
                    className="form-input"
                  />
                </div>
                <div>
                  <label htmlFor={`${baseId}-ds-file`} className="ws-eyebrow mb-1 block">
                    Upload Giovanni / AppEEARS / CDO / KNMI / Geo.ca File
                  </label>
                  <label
                    htmlFor={`${baseId}-ds-file`}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-inset px-3 py-2 text-xs text-text-muted hover:border-accent-fg hover:text-text-primary"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    <span>Choose .csv, .json, .txt, .dat, or .asc</span>
                    <input
                      id={`${baseId}-ds-file`}
                      name="dataset_file"
                      type="file"
                      accept=".csv,.json,.txt,.dat,.asc,text/csv,application/json,text/plain"
                      onChange={handleDatasetFileUpload}
                      className="sr-only"
                    />
                  </label>
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label htmlFor={`${baseId}-ds-content`} className="ws-eyebrow">
                    Paste CSV or JSON Rows
                  </label>
                  <select
                    aria-label="Dataset format"
                    name="dataset_format"
                    value={dsFormat}
                    onChange={(e) => setDsFormat(e.target.value as "csv" | "json")}
                    className="rounded border border-border bg-surface-inset px-2 py-0.5 text-[11px] text-text-primary"
                  >
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                  </select>
                </div>
                <textarea
                  id={`${baseId}-ds-content`}
                  name="dataset_content"
                  rows={6}
                  required
                  placeholder={"name,lat,lng,year,value,unit,dataset\nBoreal Station,61.2,-149.9,2000,-1.2,°C,nasa_power\n..."}
                  value={dsContent}
                  onChange={(e) => setDsContent(e.target.value)}
                  className="form-input font-mono text-[11px]"
                />
              </div>

              <button
                type="submit"
                disabled={running}
                className="rounded-lg border border-border-strong bg-surface-elevated px-3 py-2 font-semibold text-text-primary hover:border-accent-fg disabled:opacity-50 cursor-pointer"
              >
                {running ? "Analyzing & Wiring Graph…" : "Analyze Series & Wire into Knowledge Graph"}
              </button>
            </form>

            {dsStatus && (
              <div role="status" className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-2.5 font-medium text-emerald-300">
                {dsStatus}
              </div>
            )}
            {dsError && (
              <div role="status" className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-2.5 font-medium text-rose-300">
                {dsError}
              </div>
            )}
          </div>
        </div>

        <div role="tabpanel" hidden={tab !== "agencies"}>
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-inset p-3">
              <div>
                <div className="font-semibold text-text-primary">
                  Official Space-Agency Challenge Resources (12)
                </div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  Released NASA, Partner (KNMI), NOAA CDO, and Canadian Space Agency (CSA RCM, Geo.ca, SWOT) datasets &amp; statistical rigor guides wired into this observatory.
                </div>
              </div>
              <button
                type="button"
                onClick={runLiveDiscoveryFromModal}
                disabled={running}
                className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                {running ? "Syncing…" : "Ingest All Live Agency Feeds"}
              </button>
            </div>

            {dsStatus && (
              <div role="status" className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-2.5 font-medium text-emerald-300">
                {dsStatus}
              </div>
            )}

            {(
              [
                "NASA Data & Resources",
                "Space Agency Partner Resources",
                "CSA (Canadian Space Agency)",
              ] as const
            ).map((groupName) => (
              <section key={groupName} className="space-y-2">
                <h3 className="ws-eyebrow">{groupName}</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CHALLENGE_SPACE_AGENCY_RESOURCES.filter((r) => r.group === groupName).map(
                    (resItem) => (
                      <div
                        key={resItem.id}
                        className="flex flex-col justify-between gap-2 rounded-xl border border-border bg-surface-inset p-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <a
                              href={resItem.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-semibold text-text-primary hover:text-accent-fg hover:underline"
                            >
                              <span>{resItem.title}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 text-text-subtle" />
                            </a>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                                resItem.integrationRole === "Live API Wired"
                                  ? "border border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                                  : resItem.integrationRole === "Import Parser Ready"
                                    ? "border border-sky-500/35 bg-sky-500/10 text-sky-400"
                                    : "border border-amber-500/35 bg-amber-500/10 text-amber-400"
                              }`}
                            >
                              {resItem.integrationRole}
                            </span>
                          </div>
                          <p className="text-[11px] leading-relaxed text-text-muted">
                            {resItem.summary}
                          </p>
                        </div>
                        <div className="border-t border-border/60 pt-1.5 text-[11px] text-text-subtle">
                          {resItem.integrationNote}
                        </div>
                      </div>
                    )
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div role="tabpanel" hidden={tab !== "mcp"}>
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="ws-inset p-2">
                <div className="ws-eyebrow">Streamable HTTP</div>
                <code className="mt-1 block font-mono text-[11px] text-accent-fg">/api/mcp</code>
              </div>
              <div className="ws-inset p-2">
                <div className="ws-eyebrow">SSE Stream</div>
                <code className="mt-1 block font-mono text-[11px] text-accent-fg">/api/mcp/sse</code>
              </div>
              <div className="ws-inset p-2">
                <div className="ws-eyebrow">OpenAPI 3.1 Spec</div>
                <a
                  href="/api/mcp/openapi"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block font-mono text-[11px] text-accent-fg hover:underline"
                >
                  /api/mcp/openapi ↗
                </a>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor={`${baseId}-mcp-tool`} className="ws-eyebrow block">
                Execute Live MCP Tool
              </label>
              <select
                id={`${baseId}-mcp-tool`}
                name="mcp_tool"
                value={mcpTool}
                onChange={(e) => {
                  const next = e.target.value;
                  setMcpTool(next);
                  if (next === "etg_discover_global_trends") {
                    setMcpArgs('{\n  "max_eonet_sites": 7\n}');
                  } else if (next === "etg_analyze_timeseries") {
                    setMcpArgs('{\n  "lat": 0,\n  "lng": 0,\n  "dataset": "nasa_power"\n}');
                  } else if (next === "etg_ingest_signal") {
                    setMcpArgs('{\n  "name": "",\n  "description": "",\n  "lat": 0,\n  "lng": 0,\n  "dataset": "community",\n  "confidence": 0.9\n}');
                  } else {
                    setMcpArgs('{\n  "only_opposite_trends": true\n}');
                  }
                }}
                className="form-input"
              >
                <option value="etg_discover_global_trends">etg_discover_global_trends</option>
                <option value="etg_query_graph">etg_query_graph</option>
                <option value="etg_analyze_timeseries">etg_analyze_timeseries</option>
                <option value="etg_ingest_signal">etg_ingest_signal</option>
                <option value="etg_trace_teleconnection">etg_trace_teleconnection</option>
              </select>

              <label htmlFor={`${baseId}-mcp-args`} className="sr-only">
                MCP tool JSON arguments
              </label>
              <textarea
                id={`${baseId}-mcp-args`}
                name="mcp_arguments"
                rows={4}
                value={mcpArgs}
                onChange={(e) => setMcpArgs(e.target.value)}
                className="form-input font-mono text-[11px]"
              />

              <button
                type="button"
                onClick={runMcpTool}
                disabled={running}
                className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover cursor-pointer"
              >
                <Send className="h-3.5 w-3.5" />
                {running ? "Executing…" : "Invoke POST /api/mcp"}
              </button>
            </div>

            {mcpOutput && (
              <pre className="max-h-56 overflow-auto rounded border border-border bg-bg p-2.5 font-mono text-[11px] text-emerald-300">
                {mcpOutput}
              </pre>
            )}
          </div>
        </div>

        <div role="tabpanel" hidden={tab !== "webhook"}>
          <div className="p-4">
          <form onSubmit={sendWebhook} className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor={`${baseId}-wh-id`} className="ws-eyebrow mb-1 block">
                  Target Device / Node ID
                </label>
                <input
                  id={`${baseId}-wh-id`}
                  name="device_id"
                  type="text"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="e.g., esp32-flux-station-01"
                  value={whNodeId}
                  onChange={(e) => setWhNodeId(e.target.value)}
                  className="form-input font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${baseId}-wh-ds`} className="ws-eyebrow mb-1 block">
                  Dataset
                </label>
                <select
                  id={`${baseId}-wh-ds`}
                  name="dataset"
                  value={whDataset}
                  onChange={(e) => setWhDataset(e.target.value as ETGDatasetId)}
                  className="form-input"
                >
                  {EARTH_TREND_DATASETS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${baseId}-wh-lat`} className="ws-eyebrow mb-1 block">
                  Latitude
                </label>
                <input
                  id={`${baseId}-wh-lat`}
                  name="lat"
                  type="number"
                  step="any"
                  required
                  placeholder="-90 to 90"
                  value={whLat}
                  onChange={(e) => setWhLat(e.target.value)}
                  className="form-input font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${baseId}-wh-lng`} className="ws-eyebrow mb-1 block">
                  Longitude
                </label>
                <input
                  id={`${baseId}-wh-lng`}
                  name="lng"
                  type="number"
                  step="any"
                  required
                  placeholder="-180 to 180"
                  value={whLng}
                  onChange={(e) => setWhLng(e.target.value)}
                  className="form-input font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${baseId}-wh-val`} className="ws-eyebrow mb-1 block">
                  Reading Value
                </label>
                <input
                  id={`${baseId}-wh-val`}
                  name="value"
                  type="number"
                  step="any"
                  required
                  placeholder="Numeric sensor reading"
                  value={whValue}
                  onChange={(e) => setWhValue(e.target.value)}
                  className="form-input font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${baseId}-wh-unit`} className="ws-eyebrow mb-1 block">
                  Unit
                </label>
                <input
                  id={`${baseId}-wh-unit`}
                  name="unit"
                  type="text"
                  required
                  placeholder="e.g., °C, ppm, µg/m³"
                  value={whUnit}
                  onChange={(e) => setWhUnit(e.target.value)}
                  className="form-input font-mono"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={running}
              className="rounded bg-accent px-3 py-2 font-semibold text-white hover:bg-accent-hover cursor-pointer"
            >
              {running ? "Streaming…" : `POST /api/graph/nodes/${whNodeId || "{nodeId}"}/webhook`}
            </button>
            {whStatus && (
              <div role="status" className="font-medium text-emerald-400">
                {whStatus}
              </div>
            )}
          </form>
          </div>
        </div>

        <div role="tabpanel" hidden={tab !== "community"}>
          <div className="p-4">
          <form onSubmit={submitCommunitySignal} className="space-y-3">
            <div>
              <label htmlFor={`${baseId}-obs-name`} className="ws-eyebrow mb-1 block">
                Observation Title
              </label>
              <input
                id={`${baseId}-obs-name`}
                name="observation_name"
                type="text"
                required
                placeholder="Observed environmental phenomenon & location"
                value={obsName}
                onChange={(e) => setObsName(e.target.value)}
                className="form-input"
              />
            </div>
            <div>
              <label htmlFor={`${baseId}-obs-desc`} className="ws-eyebrow mb-1 block">
                Scientific Context
              </label>
              <textarea
                id={`${baseId}-obs-desc`}
                name="observation_description"
                required
                rows={2}
                placeholder="Describe sensor calibration, observed anomaly, and verification source."
                value={obsDesc}
                onChange={(e) => setObsDesc(e.target.value)}
                className="form-input"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label htmlFor={`${baseId}-obs-lat`} className="ws-eyebrow mb-1 block">
                  Lat
                </label>
                <input
                  id={`${baseId}-obs-lat`}
                  name="observation_lat"
                  type="number"
                  step="any"
                  required
                  placeholder="-90..90"
                  value={obsLat}
                  onChange={(e) => setObsLat(e.target.value)}
                  className="form-input font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${baseId}-obs-lng`} className="ws-eyebrow mb-1 block">
                  Lng
                </label>
                <input
                  id={`${baseId}-obs-lng`}
                  name="observation_lng"
                  type="number"
                  step="any"
                  required
                  placeholder="-180..180"
                  value={obsLng}
                  onChange={(e) => setObsLng(e.target.value)}
                  className="form-input font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${baseId}-obs-ds`} className="ws-eyebrow mb-1 block">
                  Dataset
                </label>
                <select
                  id={`${baseId}-obs-ds`}
                  name="observation_dataset"
                  value={obsDataset}
                  onChange={(e) => setObsDataset(e.target.value as ETGDatasetId)}
                  className="form-input"
                >
                  {EARTH_TREND_DATASETS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.shortLabel}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label htmlFor={`${baseId}-obs-supports`} className="ws-eyebrow mb-1 block">
                Corroborate Existing Trend (Optional)
              </label>
              <select
                id={`${baseId}-obs-supports`}
                name="supports_insight_uuid"
                value={obsSupports}
                onChange={(e) => setObsSupports(e.target.value)}
                className="form-input"
              >
                <option value="">Standalone Signal</option>
                {insightNodes.map((ins) => (
                  <option key={ins.uuid} value={ins.uuid}>
                    {ins.properties.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={running}
              className="rounded bg-accent px-3 py-2 font-semibold text-white hover:bg-accent-hover cursor-pointer"
            >
              {running ? "Publishing…" : "Publish Signal to Earth Trend Graph"}
            </button>
            {obsStatus && (
              <div role="status" className="font-medium text-emerald-400">
                {obsStatus}
              </div>
            )}
          </form>
          </div>
        </div>
      </div>
    </dialog>
  );
}
