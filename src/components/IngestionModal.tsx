"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Bot, Cpu, Download, ExternalLink, FileSpreadsheet, Globe2, Satellite, Send, Upload, X } from "lucide-react";
import {
  CHALLENGE_SPACE_AGENCY_RESOURCES,
  EARTH_TREND_DATASETS,
} from "@/lib/datasets";
import { attachDialogLightDismissFallback } from "@/lib/a11y/dialogLightDismiss";
import { restoreOpenerFocus, trapDialogTabKey } from "@/lib/a11y/dialogFocusTrap";
import type { ETGDatasetId, ETGNode } from "@/types/etg";

export type IngestionTabId = "dataset" | "agencies" | "mcp" | "webhook" | "community";
const INGESTION_TABS: readonly IngestionTabId[] = [
  "dataset",
  "agencies",
  "mcp",
  "webhook",
  "community",
];

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
  const contentRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const tabButtonRefs = useRef<Partial<Record<IngestionTabId, HTMLButtonElement | null>>>({});
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
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
    return attachDialogLightDismissFallback(
      dialog,
      () => dialog.close("backdrop"),
      contentRef.current,
    );
  }, []);

  const handleNativeClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    const opener = openerRef.current;
    openerRef.current = null;
    onClose();
    restoreOpenerFocus(opener);
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
    } catch (err) {
      setDsError(err instanceof Error ? err.message : "Live discovery network request failed");
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
    } catch (err) {
      setWhStatus(err instanceof Error ? err.message : "Webhook request failed");
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
    } catch (err) {
      setObsStatus(err instanceof Error ? err.message : "Observation submission failed");
    } finally {
      setRunning(false);
    }
  };

  const handleExportWorkspaceBundle = async () => {
    setRunning(true);
    setDsError("");
    setDsStatus("");
    try {
      const res = await fetch("/api/graph?format=bundle", { cache: "no-store" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setDsError(d.error || "Failed to export ETG workspace bundle.");
        return;
      }
      const bundle = await res.json();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etg-workspace-bundle-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setDsStatus("Exported ETG workspace bundle (.json).");
    } catch (err) {
      setDsError(err instanceof Error ? err.message : "Failed to export bundle.");
    } finally {
      setRunning(false);
    }
  };

  const handleImportBundleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setRunning(true);
    setDsError("");
    setDsStatus("");
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import_bundle", bundle, merge: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDsError(data.error || "Failed to import ETG workspace bundle.");
        return;
      }
      setDsStatus(
        `Imported bundle: ${data.importedNodes ?? 0} node(s), ${data.importedEdges ?? 0} edge(s).`
      );
      await onIngested();
    } catch (err) {
      setDsError(err instanceof Error ? err.message : "Invalid JSON workspace bundle.");
    } finally {
      setRunning(false);
    }
  };

  const insightNodes = nodes.filter((n) => n.label === "Insight");

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = INGESTION_TABS.indexOf(tab);
    let nextIndex = -1;
    if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % INGESTION_TABS.length;
    else if (e.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + INGESTION_TABS.length) % INGESTION_TABS.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = INGESTION_TABS.length - 1;
    if (nextIndex < 0) return;
    e.preventDefault();
    const nextTab = INGESTION_TABS[nextIndex];
    setTab(nextTab);
    tabButtonRefs.current[nextTab]?.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={handleNativeClose}
      onKeyDown={(e) => trapDialogTabKey(dialogRef.current, e)}
      className="etg-dialog"
      {...({ closedby: "any" } as Record<string, unknown>)}
    >
      <div ref={contentRef} className="flex flex-1 min-h-0 flex-col bg-surface text-text-primary">
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
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-border text-text-muted hover:text-text-primary cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab Strip (border pseudo-element indicator via .etg-tab) */}
      <div
        role="tablist"
        aria-label="Data ingestion channels"
        onKeyDown={handleTabKeyDown}
        className="etg-tablist bg-surface text-xs"
      >
        <button
          ref={(el) => {
            tabButtonRefs.current.dataset = el;
          }}
          id={`${baseId}-tab-dataset`}
          type="button"
          role="tab"
          aria-selected={tab === "dataset"}
          aria-controls={`${baseId}-panel-dataset`}
          tabIndex={tab === "dataset" ? 0 : -1}
          onClick={() => setTab("dataset")}
          className="etg-tab flex items-center gap-1.5"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          Dataset Import
        </button>
        <button
          ref={(el) => {
            tabButtonRefs.current.agencies = el;
          }}
          id={`${baseId}-tab-agencies`}
          type="button"
          role="tab"
          aria-selected={tab === "agencies"}
          aria-controls={`${baseId}-panel-agencies`}
          tabIndex={tab === "agencies" ? 0 : -1}
          onClick={() => setTab("agencies")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Satellite className="h-3.5 w-3.5" />
          Agency Hub (12)
        </button>
        <button
          ref={(el) => {
            tabButtonRefs.current.mcp = el;
          }}
          id={`${baseId}-tab-mcp`}
          type="button"
          role="tab"
          aria-selected={tab === "mcp"}
          aria-controls={`${baseId}-panel-mcp`}
          tabIndex={tab === "mcp" ? 0 : -1}
          onClick={() => setTab("mcp")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Bot className="h-3.5 w-3.5" />
          MCP &amp; OpenAPI (16)
        </button>
        <button
          ref={(el) => {
            tabButtonRefs.current.webhook = el;
          }}
          id={`${baseId}-tab-webhook`}
          type="button"
          role="tab"
          aria-selected={tab === "webhook"}
          aria-controls={`${baseId}-panel-webhook`}
          tabIndex={tab === "webhook" ? 0 : -1}
          onClick={() => setTab("webhook")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Cpu className="h-3.5 w-3.5" />
          Sensor Webhook
        </button>
        <button
          ref={(el) => {
            tabButtonRefs.current.community = el;
          }}
          id={`${baseId}-tab-community`}
          type="button"
          role="tab"
          aria-selected={tab === "community"}
          aria-controls={`${baseId}-panel-community`}
          tabIndex={tab === "community" ? 0 : -1}
          onClick={() => setTab("community")}
          className="etg-tab flex items-center gap-1.5"
        >
          <Globe2 className="h-3.5 w-3.5" />
          Field Signal
        </button>
      </div>

      {/* Scroll Body — padding lives inside child containers, never directly on [role="tabpanel"] */}
      <div className="flex-1 overflow-y-auto text-xs">
        <div
          id={`${baseId}-panel-dataset`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-dataset`}
          hidden={tab !== "dataset"}
        >
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-inset p-3">
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
                className="rounded-sm bg-accent px-3 py-2 font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                {running ? "Discovering…" : "Run Live Discovery"}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-inset p-3">
              <div>
                <div className="font-semibold text-text-primary">
                  Portable Workspace Bundle (.json)
                </div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  Export or merge a full scientific Earth Trend Graph snapshot (nodes, time-series, edges, and metadata).
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleExportWorkspaceBundle()}
                  disabled={running}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-3 py-1.5 font-medium text-text-primary hover:border-accent-fg disabled:opacity-50 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Export Bundle</span>
                </button>
                <div className="relative">
                  <input
                    id={`${baseId}-bundle-file`}
                    name="workspace_bundle_file"
                    type="file"
                    accept=".json,application/json"
                    onChange={(e) => void handleImportBundleFile(e)}
                    disabled={running}
                    className="visually-hidden"
                  />
                  <label
                    htmlFor={`${baseId}-bundle-file`}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-border-strong bg-surface-elevated px-3 py-1.5 font-medium text-text-primary hover:border-accent-fg"
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Import Bundle</span>
                  </label>
                </div>
              </div>
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
                    className="flex cursor-pointer items-center gap-2 rounded-sm border border-dashed border-border-strong bg-surface-inset px-3 py-2 text-xs text-text-muted hover:border-accent-fg hover:text-text-primary"
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
                className="rounded-sm border border-border-strong bg-surface-elevated px-3 py-2 font-semibold text-text-primary hover:border-accent-fg disabled:opacity-50 cursor-pointer"
              >
                {running ? "Analyzing & Wiring Graph…" : "Analyze Series & Wire into Knowledge Graph"}
              </button>
            </form>

            {dsStatus && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-emerald-400 bg-emerald-950 p-2.5 font-medium text-emerald-300"
              >
                {dsStatus}
              </div>
            )}
            {dsError && (
              <div
                role="alert"
                className="rounded-md border border-rose-400 bg-rose-950 p-2.5 font-medium text-rose-300"
              >
                {dsError}
              </div>
            )}
          </div>
        </div>

        <div
          id={`${baseId}-panel-agencies`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-agencies`}
          hidden={tab !== "agencies"}
        >
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-inset p-3">
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
                className="rounded-sm bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                {running ? "Syncing…" : "Ingest All Live Agency Feeds"}
              </button>
            </div>

            {dsStatus && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-emerald-400 bg-emerald-950 p-2.5 font-medium text-emerald-300"
              >
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
                        className="flex flex-col justify-between gap-2 rounded-md border border-border bg-surface-inset p-3"
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
                              className={`shrink-0 rounded-sm border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                                resItem.integrationRole === "Live API Wired"
                                  ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                                  : resItem.integrationRole === "Import Parser Ready"
                                    ? "border-sky-400 bg-sky-950 text-sky-300"
                                    : "border-amber-400 bg-amber-950 text-amber-300"
                              }`}
                            >
                              {resItem.integrationRole}
                            </span>
                          </div>
                          <p className="text-[11px] leading-relaxed text-text-muted">
                            {resItem.summary}
                          </p>
                        </div>
                        <div className="border-t border-border pt-1.5 text-[11px] text-text-subtle">
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

        <div
          id={`${baseId}-panel-mcp`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-mcp`}
          hidden={tab !== "mcp"}
        >
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
                  } else if (next === "etg_propose_insight") {
                    setMcpArgs('{\n  "name": "",\n  "description": "",\n  "summary": ""\n}');
                  } else if (next === "etg_corroborate_trend") {
                    setMcpArgs('{\n  "signal_uuid": "",\n  "insight_uuid": ""\n}');
                  } else if (next === "etg_connect_nodes") {
                    setMcpArgs('{\n  "source_uuid": "",\n  "target_uuid": "",\n  "type": "leads",\n  "optimal_lag_steps": 1,\n  "lag_unit": "days",\n  "mechanism": ""\n}');
                  } else if (next === "etg_unlink_or_update") {
                    setMcpArgs('{\n  "action": "update_node",\n  "uuid": "",\n  "patch": {\n    "domain_tags": ["solar"]\n  }\n}');
                  } else if (next === "etg_traverse_subgraph") {
                    setMcpArgs('{\n  "root_uuid": "",\n  "max_hops": 2,\n  "direction": "both"\n}');
                  } else if (next === "etg_discover_missing_links") {
                    setMcpArgs('{\n  "min_abs_r": 0.45,\n  "limit": 10\n}');
                  } else if (next === "etg_predict_from_graph") {
                    setMcpArgs('{\n  "target_uuid": "",\n  "max_hops": 2,\n  "horizon_steps": 1\n}');
                  } else if (next === "etg_scan_trend_microscope") {
                    setMcpArgs('{\n  "target_uuid": ""\n}');
                  } else if (next === "etg_ingest_open_feed") {
                    setMcpArgs('{\n  "feed": "usgs_gauge",\n  "lat": 39.74,\n  "lng": -104.99\n}');
                  } else if (next === "etg_resolve_gibs_imagery") {
                    setMcpArgs('{\n  "lat": 39.74,\n  "lng": -104.99,\n  "dataset": "nasa_power"\n}');
                  } else if (next === "etg_query_solar_graph") {
                    setMcpArgs('{\n  "start_year": 2019\n}');
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
                <option value="etg_propose_insight">etg_propose_insight</option>
                <option value="etg_corroborate_trend">etg_corroborate_trend</option>
                <option value="etg_trace_teleconnection">etg_trace_teleconnection</option>
                <option value="etg_connect_nodes">etg_connect_nodes</option>
                <option value="etg_unlink_or_update">etg_unlink_or_update</option>
                <option value="etg_traverse_subgraph">etg_traverse_subgraph</option>
                <option value="etg_discover_missing_links">etg_discover_missing_links</option>
                <option value="etg_predict_from_graph">etg_predict_from_graph</option>
                <option value="etg_scan_trend_microscope">etg_scan_trend_microscope</option>
                <option value="etg_ingest_open_feed">etg_ingest_open_feed</option>
                <option value="etg_resolve_gibs_imagery">etg_resolve_gibs_imagery</option>
                <option value="etg_query_solar_graph">etg_query_solar_graph</option>
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
              <pre
                tabIndex={0}
                role="region"
                aria-label="MCP tool execution output"
                className="max-h-56 overflow-auto rounded border border-border bg-bg p-2.5 font-mono ws-numeric text-[11px] text-emerald-300"
              >
                {mcpOutput}
              </pre>
            )}
          </div>
        </div>

        <div
          id={`${baseId}-panel-webhook`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-webhook`}
          hidden={tab !== "webhook"}
        >
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
                  className="form-input font-mono ws-numeric"
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
                  className="form-input font-mono ws-numeric"
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
                  className="form-input font-mono ws-numeric"
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
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-emerald-400 bg-emerald-950 p-2.5 font-medium text-emerald-300"
              >
                {whStatus}
              </div>
            )}
          </form>
          </div>
        </div>

        <div
          id={`${baseId}-panel-community`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-community`}
          hidden={tab !== "community"}
        >
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
                  className="form-input font-mono ws-numeric"
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
                  className="form-input font-mono ws-numeric"
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
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-emerald-400 bg-emerald-950 p-2.5 font-medium text-emerald-300"
              >
                {obsStatus}
              </div>
            )}
          </form>
          </div>
        </div>
      </div>
      </div>
    </dialog>
  );
}
