"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Bot,
  Check,
  Download,
  GitBranchPlus,
  Globe2,
  History,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Sun,
  Trash2,
  TrendingUp,
  Unlink,
  Waypoints,
  X,
} from "lucide-react";
import { DATASET_BY_ID, EARTH_TREND_DATASETS } from "@/lib/datasets";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import {
  ETG_LABEL_PALETTE,
  formatEdgeRelationLabel,
  resolveEtgEdgeColor,
  resolveEtgNodeColor,
} from "@/lib/graph/graphVisuals";
import type {
  CandidateLinkSuggestion,
  ETGDatasetId,
  ETGEdge,
  ETGNode,
  ETGNodeLabel,
  ETGPhenomenonType,
  ETGRelationshipType,
  GraphPredictionResult,
  NodeTrendMicroscopeCue,
  ProspectiveForecastRecord,
  ProspectiveLedgerSummary,
  TimeSeriesPoint,
  TrendAnalysisSummary,
  TrendMicroscopeRadarBadge,
  TrendMicroscopeScanResult,
} from "@/types/etg";

type WorkbenchTab = "traverse" | "predict" | "evidence";

const PHENOMENON_OPTIONS: ReadonlyArray<{ value: ETGPhenomenonType; label: string }> = [
  { value: "climate_trend", label: "Climate Trend" },
  { value: "discrete_event", label: "Discrete Event" },
  { value: "climate_index", label: "Climate Mode / Index" },
  { value: "physical_impact", label: "Physical Impact" },
  { value: "sensor_station", label: "Sensor / Hardware Station" },
  { value: "earth_system", label: "Earth System / Domain" },
];

const RELATIONSHIP_OPTIONS: ReadonlyArray<{ value: ETGRelationshipType; label: string }> = [
  { value: "leads", label: "LEADS (Upstream driver with lag)" },
  { value: "amplifies", label: "AMPLIFIES (Strengthens target trend)" },
  { value: "dampens", label: "DAMPENS (Suppresses / buffers target)" },
  { value: "advects_to", label: "ADVECTS TO (Weather / smoke / heat transport)" },
  { value: "triggers", label: "TRIGGERS (Initiates discrete event / regime)" },
  { value: "impacts", label: "IMPACTS (Physical or ecological consequence)" },
  { value: "drives_opposite", label: "OPPOSITE TELECONNECTION" },
  { value: "correlates_with", label: "CORRELATES WITH (Coupled series)" },
  { value: "supports", label: "SUPPORTS (Observational evidence)" },
  { value: "corroborates", label: "CORROBORATES (Independent confirmation)" },
  { value: "hypothesized_link", label: "HYPOTHESIS (Exploratory test edge)" },
  { value: "relates_to", label: "RELATES TO (General conceptual link)" },
  { value: "monitors", label: "MONITORS (Sensor observes target)" },
  { value: "verified_by", label: "VERIFIED BY (Rule / gate check)" },
];

function useIsLightTheme(): boolean {
  const [isLight, setIsLight] = useState(false);

  useEffect(() => {
    const sync = () => {
      setIsLight(document.documentElement.classList.contains("light"));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return isLight;
}

function parseDateToFractionalYear(dateStr: string, fallbackIndex: number): number {
  const trimmed = dateStr.trim();
  const isoMatch = trimmed.match(
    /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?Z?)?)?)?$/i
  );
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Math.min(12, Math.max(1, Number(isoMatch[2] ?? 1)));
    const day = Math.min(31, Math.max(1, Number(isoMatch[3] ?? 1)));
    const hh = Math.min(23, Math.max(0, Number(isoMatch[4] ?? 0)));
    const mm = Math.min(59, Math.max(0, Number(isoMatch[5] ?? 0)));
    const ss = Math.min(59, Math.max(0, Number(isoMatch[6] ?? 0)));
    const yearStart = Date.UTC(year, 0, 1);
    const nextYearStart = Date.UTC(year + 1, 0, 1);
    const pointMs = Date.UTC(year, month - 1, day, hh, mm, ss);
    return year + (pointMs - yearStart) / Math.max(1, nextYearStart - yearStart);
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsedMs = Date.parse(trimmed);
  if (Number.isFinite(parsedMs)) {
    const dt = new Date(parsedMs);
    const year = dt.getUTCFullYear();
    const yearStart = Date.UTC(year, 0, 1);
    const nextYearStart = Date.UTC(year + 1, 0, 1);
    return year + (parsedMs - yearStart) / Math.max(1, nextYearStart - yearStart);
  }
  return fallbackIndex;
}

function parseSeriesText(raw: string): TimeSeriesPoint[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  // Single-line comma-separated plain numbers fallback (only when all tokens are numbers)
  if (lines.length === 1 && !lines[0].includes(":") && lines[0].includes(",")) {
    const rawTokens = lines[0].split(",").map((s) => s.trim()).filter(Boolean);
    const nums = rawTokens.map((s) => Number(s)).filter((n) => Number.isFinite(n));
    if (nums.length >= 2 && nums.length === rawTokens.length) {
      const startYear = new Date().getUTCFullYear() - nums.length + 1;
      return nums.map((value, idx) => ({
        date: String(startYear + idx),
        t: startYear + idx,
        value,
      }));
    }
  }

  const parsed: Array<{ point: TimeSeriesPoint; idx: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const delimParts = line.split(/[\t,;]+/).map((p) => p.trim()).filter(Boolean);
    let dateStr: string | null = null;
    let val: number | null = null;

    if (delimParts.length >= 2) {
      dateStr = delimParts[0];
      const n = Number(delimParts[delimParts.length - 1]);
      if (Number.isFinite(n)) val = n;
    } else {
      const colonSpace = line.match(/^(.+?):\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
      const whitespacePair = line.match(/^(\S+)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
      if (colonSpace) {
        dateStr = colonSpace[1].trim();
        val = Number(colonSpace[2]);
      } else if (whitespacePair) {
        dateStr = whitespacePair[1].trim();
        val = Number(whitespacePair[2]);
      } else {
        const single = Number(line);
        if (Number.isFinite(single)) {
          const y = 2015 + i;
          parsed.push({ point: { date: String(y), t: y, value: single }, idx: i });
          continue;
        }
      }
    }

    if (dateStr && val !== null && Number.isFinite(val)) {
      const t = parseDateToFractionalYear(dateStr, i);
      parsed.push({ point: { date: dateStr, t, value: val }, idx: i });
    }
  }

  parsed.sort((a, b) => (a.point.t !== b.point.t ? a.point.t - b.point.t : a.idx - b.idx));
  return parsed.map((entry) => entry.point);
}

function BacktestChart({
  backtest,
  isLightTheme,
}: {
  backtest: GraphPredictionResult["backtest"];
  isLightTheme: boolean;
}) {
  if (backtest.length < 2) return null;
  const w = 340;
  const h = 112;
  const pad = 10;
  const allVals = backtest.flatMap((b) => [b.actual, b.selfOnly, b.graphAware]);
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const span = Math.max(1e-6, maxV - minV);
  const xAt = (i: number) => pad + (i / (backtest.length - 1)) * (w - pad * 2);
  const yAt = (v: number) => h - pad - ((v - minV) / span) * (h - pad * 2);
  const line = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

  return (
    <div className="space-y-1.5">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-28 rounded-lg border border-border bg-surface-inset"
        aria-label="Out-of-sample holdout prediction comparison chart"
      >
        <path
          d={line(backtest.map((b) => b.selfOnly))}
          fill="none"
          stroke={isLightTheme ? "#52525b" : "#94a3b8"}
          strokeWidth={1.3}
          strokeDasharray="3 3"
        />
        <path
          d={line(backtest.map((b) => b.actual))}
          fill="none"
          stroke={isLightTheme ? "#18181b" : "#f8fafc"}
          strokeWidth={1.75}
        />
        <path
          d={line(backtest.map((b) => b.graphAware))}
          fill="none"
          stroke={isLightTheme ? "#0284c7" : "#38bdf8"}
          strokeWidth={2}
        />
      </svg>
      <div className="flex items-center justify-between text-[10px] text-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 bg-text-primary inline-block" /> Actual
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 bg-sky-400 inline-block" /> Graph Model
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 border-b border-dashed border-slate-400 inline-block" /> Self AR
        </span>
      </div>
    </div>
  );
}

interface GraphNodeWorkbenchPanelProps {
  allNodes: ETGNode[];
  allEdges: ETGEdge[];
  selectedNode: ETGNode | null;
  selectedEdge: ETGEdge | null;
  pendingConnectPair: { sourceUuid: string; targetUuid: string } | null;
  quickAddOpen: boolean;
  candidateLinks: CandidateLinkSuggestion[];
  microscopeScan?: TrendMicroscopeScanResult | null;
  microscopeByNode?: Record<string, NodeTrendMicroscopeCue>;
  traversalHistory: Array<{ uuid: string; name: string }>;
  maxHops: number;
  onSelectNode: (node: ETGNode) => void;
  onSelectEdge: (edge: ETGEdge) => void;
  onClearPendingConnect: () => void;
  onCloseQuickAdd: () => void;
  onStartQuickConnect: (sourceNode: ETGNode, targetNode?: ETGNode) => void;
  onDiscoverLinksForNode: (anchorUuid: string) => Promise<void>;
  onAcceptCandidateLink: (suggestion: CandidateLinkSuggestion) => Promise<void>;
  onMaterializeSolarGraph: () => Promise<void>;
  onLocateOnGlobe?: (node: ETGNode) => void;
  onSnapshotChange: (snapshot: EtgGraphSnapshot, toast?: string) => void;
  onClose: () => void;
}

export function GraphNodeWorkbenchPanel({
  allNodes,
  allEdges,
  selectedNode,
  selectedEdge,
  pendingConnectPair,
  quickAddOpen,
  candidateLinks,
  microscopeScan = null,
  microscopeByNode,
  traversalHistory,
  maxHops,
  onSelectNode,
  onSelectEdge,
  onClearPendingConnect,
  onCloseQuickAdd,
  onStartQuickConnect,
  onDiscoverLinksForNode,
  onAcceptCandidateLink,
  onMaterializeSolarGraph,
  onLocateOnGlobe,
  onSnapshotChange,
  onClose,
}: GraphNodeWorkbenchPanelProps) {
  const baseId = useId();
  const isLightTheme = useIsLightTheme();
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("traverse");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  // Quick Node Creator state
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

  // Edge Composer / Editor state
  const [edgeSourceUuid, setEdgeSourceUuid] = useState("");
  const [edgeTargetUuid, setEdgeTargetUuid] = useState("");
  const [edgeType, setEdgeType] = useState<ETGRelationshipType>("leads");
  const [edgeCustomLabel, setEdgeCustomLabel] = useState("");
  const [edgeLagSteps, setEdgeLagSteps] = useState("1");
  const [edgeLagUnit, setEdgeLagUnit] = useState<"days" | "months" | "years">("days");
  const [edgeWeight, setEdgeWeight] = useState(0.75);
  const [edgeMechanism, setEdgeMechanism] = useState("");
  const [edgeRationale, setEdgeRationale] = useState("");

  useEffect(() => {
    if (selectedEdge) {
      setEdgeSourceUuid(selectedEdge.source_uuid);
      setEdgeTargetUuid(selectedEdge.target_uuid);
      setEdgeType(selectedEdge.type);
      setEdgeCustomLabel(selectedEdge.properties.custom_label ?? "");
      setEdgeLagSteps(String(selectedEdge.properties.optimal_lag_steps ?? 0));
      setEdgeLagUnit(selectedEdge.properties.lag_unit ?? "days");
      setEdgeWeight(selectedEdge.properties.weight ?? 0.75);
      setEdgeMechanism(selectedEdge.properties.mechanism ?? "");
      setEdgeRationale(selectedEdge.properties.rationale ?? "");
      setLocalError(null);
      setLocalStatus(null);
    } else if (pendingConnectPair) {
      setEdgeSourceUuid(pendingConnectPair.sourceUuid);
      setEdgeTargetUuid(pendingConnectPair.targetUuid);
      setEdgeType("leads");
      setEdgeCustomLabel("");
      setEdgeLagSteps("1");
      setEdgeLagUnit("days");
      setEdgeWeight(0.75);
      setEdgeMechanism("");
      setEdgeRationale("");
      setLocalError(null);
      setLocalStatus(null);
    }
  }, [selectedEdge, pendingConnectPair]);

  // Traverse inline link selector
  const [quickWireTargetUuid, setQuickWireTargetUuid] = useState("");

  // Predict tab state
  const [prediction, setPrediction] = useState<GraphPredictionResult | null>(null);
  const [predictLoading, setPredictLoading] = useState(false);
  const [predictError, setPredictError] = useState<string | null>(null);
  const [candidatePreviewUuid, setCandidatePreviewUuid] = useState("");
  const [horizonSteps, setHorizonSteps] = useState<1 | 2 | 3>(1);
  const [exportingMl, setExportingMl] = useState(false);
  const [ledgerRecords, setLedgerRecords] = useState<ProspectiveForecastRecord[]>([]);
  const [ledgerSummary, setLedgerSummary] = useState<ProspectiveLedgerSummary | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);

  // Evidence & Edit state
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

  useEffect(() => {
    if (!selectedNode) return;
    setEditName(selectedNode.properties.name);
    setEditPhenom(selectedNode.properties.phenomenon_type ?? "climate_trend");
    setEditRegion(selectedNode.properties.region ?? "");
    setEditTags((selectedNode.properties.domain_tags ?? []).join(", "));
    setEditDesc(selectedNode.properties.description ?? "");
    setAiBriefing(null);
    setCandidatePreviewUuid("");
    setHorizonSteps(1);
    setReviseOpen(false);
    setLocalError(null);
    setLocalStatus(null);
  }, [selectedNode]);

  // Load Graph Prediction + Prospective Ledger when Predict tab is active
  const loadLedger = useCallback(async () => {
    if (!selectedNode) return;
    try {
      const res = await fetch(
        `/api/graph/predict?format=ledger&targetUuid=${encodeURIComponent(selectedNode.uuid)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          records?: ProspectiveForecastRecord[];
          summary?: ProspectiveLedgerSummary;
        };
        setLedgerRecords(Array.isArray(data.records) ? data.records : []);
        setLedgerSummary(data.summary ?? null);
      }
    } catch {
      // Non-fatal ledger fetch
    }
  }, [selectedNode]);

  const loadPrediction = useCallback(async () => {
    if (!selectedNode) return;
    setPredictLoading(true);
    setPredictError(null);
    try {
      const params = new URLSearchParams({
        targetUuid: selectedNode.uuid,
        maxHops: String(Math.max(1, maxHops)),
        horizonSteps: String(horizonSteps),
      });
      if (candidatePreviewUuid) {
        params.set("candidateNeighborUuid", candidatePreviewUuid);
      }
      const res = await fetch(`/api/graph/predict?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setPrediction(null);
        setPredictError(data.error || "Unable to fit graph predictor on this node.");
      } else {
        setPrediction(data as GraphPredictionResult);
      }
    } catch (err) {
      setPredictError(err instanceof Error ? err.message : "Prediction request failed");
    } finally {
      setPredictLoading(false);
    }
    await loadLedger();
  }, [selectedNode, maxHops, horizonSteps, candidatePreviewUuid, loadLedger]);

  useEffect(() => {
    if (selectedNode && activeTab === "predict" && !quickAddOpen && !pendingConnectPair && !selectedEdge) {
      void loadPrediction();
    }
  }, [selectedNode, activeTab, quickAddOpen, pendingConnectPair, selectedEdge, loadPrediction]);

  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.uuid, n])), [allNodes]);

  const incomingLinks = useMemo(() => {
    if (!selectedNode) return [];
    return allEdges
      .filter((e) => e.target_uuid === selectedNode.uuid)
      .map((edge) => ({ edge, node: nodeById.get(edge.source_uuid) }))
      .filter((item): item is { edge: ETGEdge; node: ETGNode } => Boolean(item.node));
  }, [allEdges, selectedNode, nodeById]);

  const outgoingLinks = useMemo(() => {
    if (!selectedNode) return [];
    return allEdges
      .filter((e) => e.source_uuid === selectedNode.uuid)
      .map((edge) => ({ edge, node: nodeById.get(edge.target_uuid) }))
      .filter((item): item is { edge: ETGEdge; node: ETGNode } => Boolean(item.node));
  }, [allEdges, selectedNode, nodeById]);

  const nodeCandidates = useMemo(() => {
    if (!selectedNode) return candidateLinks;
    const anchored = candidateLinks.filter(
      (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
    );
    return anchored.length > 0 ? anchored : candidateLinks;
  }, [candidateLinks, selectedNode]);

  const unlinkedSeriesPeers = useMemo(() => {
    if (!selectedNode) return [];
    const connected = new Set<string>([selectedNode.uuid]);
    for (const e of allEdges) {
      if (e.source_uuid === selectedNode.uuid) connected.add(e.target_uuid);
      if (e.target_uuid === selectedNode.uuid) connected.add(e.source_uuid);
    }
    return allNodes.filter(
      (n) =>
        !connected.has(n.uuid) &&
        ((n.properties.series_count ?? 0) >= 6 ||
          (n.properties.sparkline_preview?.length ?? 0) >= 3)
    );
  }, [allNodes, allEdges, selectedNode]);

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

  const handleSaveEdge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edgeSourceUuid || !edgeTargetUuid || edgeSourceUuid === edgeTargetUuid) {
      setLocalError("Choose two distinct Source and Target nodes.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      if (selectedEdge) {
        const res = await fetch("/api/graph", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            edgeUuid: selectedEdge.properties.uuid,
            patch: {
              source_uuid: edgeSourceUuid,
              target_uuid: edgeTargetUuid,
              type: edgeType,
              custom_label: edgeCustomLabel.trim() || undefined,
              optimal_lag_steps: Number(edgeLagSteps) || 0,
              lag_unit: edgeLagUnit,
              weight: edgeWeight,
              mechanism: edgeMechanism.trim() || undefined,
              rationale: edgeRationale.trim() || undefined,
            },
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to update connection");
        onSnapshotChange(data.snapshot, "Updated causal connection.");
        if (data.edge) onSelectEdge(data.edge as ETGEdge);
      } else {
        const res = await fetch("/api/graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "connect",
            source_uuid: edgeSourceUuid,
            target_uuid: edgeTargetUuid,
            type: edgeType,
            custom_label: edgeCustomLabel.trim() || undefined,
            optimal_lag_steps: Number(edgeLagSteps) || 0,
            lag_unit: edgeLagUnit,
            weight: edgeWeight,
            mechanism: edgeMechanism.trim() || undefined,
            rationale: edgeRationale.trim() || undefined,
            authored_by: "human",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to create connection");
        onSnapshotChange(data.snapshot, "Connected phenomena in Knowledge Graph.");
        onClearPendingConnect();
        if (data.edge) onSelectEdge(data.edge as ETGEdge);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to save edge");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEdge = async (edgeUuid: string) => {
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch(`/api/graph?edgeUuid=${encodeURIComponent(edgeUuid)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to unlink edge");
      onSnapshotChange(data.snapshot, "Unlinked connection from Knowledge Graph.");
      if (selectedEdge?.properties.uuid === edgeUuid) {
        onClose();
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Unlink failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveNodeEdits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode) return;
    setBusy(true);
    setLocalError(null);
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
      setLocalStatus("Saved node metadata.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteNode = async () => {
    if (!selectedNode) return;
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch(`/api/graph?nodeUuid=${encodeURIComponent(selectedNode.uuid)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete node");
      onSnapshotChange(data.snapshot, `Deleted "${selectedNode.properties.name}".`);
      onClose();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const handleLogProspectiveForecast = async () => {
    if (!selectedNode) return;
    setLedgerBusy(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/graph/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "log_forecast",
          targetUuid: selectedNode.uuid,
          maxHops: Math.max(1, maxHops),
          horizonSteps,
          candidateNeighborUuid: candidatePreviewUuid || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to log forecast");
      if (json.ledger) {
        setLedgerRecords(Array.isArray(json.ledger.records) ? json.ledger.records : []);
        setLedgerSummary(json.ledger.summary ?? null);
      }
      setLocalStatus(
        `Logged prospective forecast for ${json.loggedForecast?.target_period ?? "next step"}.`
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to log forecast");
    } finally {
      setLedgerBusy(false);
    }
  };

  const handleReconcileForecasts = async () => {
    if (!selectedNode) return;
    setLedgerBusy(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/graph/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reconcile_forecasts",
          targetUuid: selectedNode.uuid,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to score actuals");
      if (json.ledger) {
        setLedgerRecords(Array.isArray(json.ledger.records) ? json.ledger.records : []);
        setLedgerSummary(json.ledger.summary ?? null);
      }
      setLocalStatus(
        json.scoredNow > 0
          ? `Scored ${json.scoredNow} pending forecast(s) against new observations.`
          : "All pending forecasts are still awaiting future observations."
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to reconcile forecasts");
    } finally {
      setLedgerBusy(false);
    }
  };

  const handleExportMlJson = async () => {
    if (!selectedNode) return;
    setExportingMl(true);
    setLocalError(null);
    try {
      const res = await fetch(
        `/api/graph/predict?format=ml_export&rootUuid=${encodeURIComponent(selectedNode.uuid)}&maxHops=${Math.max(2, maxHops)}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "ML export failed");
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etg-ml-graph-${selectedNode.uuid.slice(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLocalStatus("Downloaded PyG / Python ML tensor JSON.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportingMl(false);
    }
  };

  const handleExportMlV2Json = async () => {
    if (!selectedNode) return;
    setExportingMl(true);
    setLocalError(null);
    try {
      const res = await fetch(
        `/api/graph/predict?format=ml_export_v2&rootUuid=${encodeURIComponent(selectedNode.uuid)}&maxHops=${Math.max(2, maxHops)}&horizonSteps=${horizonSteps}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "v2 ML export failed");
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etg-ml-v2-${selectedNode.uuid.slice(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLocalStatus("Downloaded etg-ml-v2 multi-scale bundle for Colab Blackwell / L4.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "v2 export failed");
    } finally {
      setExportingMl(false);
    }
  };

  const handleAskNodeDetective = async () => {
    if (!selectedNode) return;
    setAiLoading(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/ai/detective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedNodeUuid: selectedNode.uuid,
          question: "Analyze multi-hop drivers, teleconnections, and predictive lift around this node.",
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
      setLocalError(err instanceof Error ? err.message : "AI synthesis failed");
    } finally {
      setAiLoading(false);
    }
  };

  const handleReviseBelief = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !reviseTitle.trim() || !reviseRationale.trim()) return;
    setBusy(true);
    setLocalError(null);
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
      setLocalError(err instanceof Error ? err.message : "Belief revision failed");
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: WorkbenchTab; label: string }> = [
    { id: "traverse", label: "Traverse & Links" },
    { id: "predict", label: "Predict & ML" },
    { id: "evidence", label: "Evidence & Edit" },
  ];

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      setActiveTab(tabs[nextIdx].id);
      tabRefs.current[nextIdx]?.focus();
    }
  };

  /* ── Mode A: Quick Phenomenon Node Creator ─────────────────────────────── */
  if (quickAddOpen) {
    return (
      <div className="etg-hud-pill max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-md bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-accent-fg" />
            <h2 className="text-sm font-semibold text-text-primary">Add Phenomenon to Graph</h2>
          </div>
          <button
            type="button"
            onClick={onCloseQuickAdd}
            aria-label="Close node creator"
            className="rounded-sm p-1 text-text-muted hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleCreateNodeSubmit} className="space-y-3 p-3.5 text-xs">
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

          {localError && <div className="text-[11px] text-rose-400">{localError}</div>}
          {localStatus && <div className="text-[11px] text-emerald-400">{localStatus}</div>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-sm bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
          >
            {busy ? "Publishing Phenomenon…" : "Create Node in Knowledge Graph"}
          </button>
        </form>
      </div>
    );
  }

  /* ── Mode B: Edge Connection Composer / Editor ─────────────────────────── */
  if (pendingConnectPair || selectedEdge) {
    const srcNode = nodeById.get(edgeSourceUuid);
    const tgtNode = nodeById.get(edgeTargetUuid);

    return (
      <div className="etg-hud-pill max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-md bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <GitBranchPlus className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-text-primary">
              {selectedEdge ? "Edit Graph Connection" : "Connect Phenomena"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              onClearPendingConnect();
              if (selectedEdge && !pendingConnectPair) onClose();
            }}
            aria-label="Close connection composer"
            className="rounded-sm p-1 text-text-muted hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSaveEdge} className="space-y-3 p-3.5 text-xs">
          {/* Directed Endpoints + Swap */}
          <div className="rounded-md border border-border bg-surface-inset p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={`${baseId}-edge-src`} className="ws-eyebrow block">
                  Upstream Source
                </label>
                <select
                  id={`${baseId}-edge-src`}
                  value={edgeSourceUuid}
                  onChange={(e) => setEdgeSourceUuid(e.target.value)}
                  className="form-input mt-1"
                >
                  {allNodes.map((n) => (
                    <option key={n.uuid} value={n.uuid}>
                      {n.properties.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => {
                  const prevSrc = edgeSourceUuid;
                  setEdgeSourceUuid(edgeTargetUuid);
                  setEdgeTargetUuid(prevSrc);
                }}
                title="Swap causal direction"
                aria-label="Swap source and target direction"
                className="mt-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-surface text-text-muted hover:border-amber-400 hover:text-amber-300 cursor-pointer"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
              </button>
              <div className="min-w-0 flex-1">
                <label htmlFor={`${baseId}-edge-tgt`} className="ws-eyebrow block">
                  Downstream Target
                </label>
                <select
                  id={`${baseId}-edge-tgt`}
                  value={edgeTargetUuid}
                  onChange={(e) => setEdgeTargetUuid(e.target.value)}
                  className="form-input mt-1"
                >
                  {allNodes.map((n) => (
                    <option key={n.uuid} value={n.uuid}>
                      {n.properties.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {srcNode && tgtNode && (
              <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <span className="truncate font-medium text-text-primary">{srcNode.properties.name}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-amber-400" />
                <span className="truncate font-medium text-text-primary">{tgtNode.properties.name}</span>
              </div>
            )}
          </div>

          <div>
            <label htmlFor={`${baseId}-edge-type`} className="ws-eyebrow mb-1 block">
              Causal / Scientific Relationship
            </label>
            <select
              id={`${baseId}-edge-type`}
              value={edgeType}
              onChange={(e) => setEdgeType(e.target.value as ETGRelationshipType)}
              className="form-input"
            >
              {RELATIONSHIP_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor={`${baseId}-edge-lag`} className="ws-eyebrow mb-1 block">
                Lead Lag
              </label>
              <input
                id={`${baseId}-edge-lag`}
                type="number"
                min={0}
                value={edgeLagSteps}
                onChange={(e) => setEdgeLagSteps(e.target.value)}
                className="form-input font-mono"
              />
            </div>
            <div>
              <label htmlFor={`${baseId}-edge-unit`} className="ws-eyebrow mb-1 block">
                Lag Unit
              </label>
              <select
                id={`${baseId}-edge-unit`}
                value={edgeLagUnit}
                onChange={(e) => setEdgeLagUnit(e.target.value as "days" | "months" | "years")}
                className="form-input"
              >
                <option value="days">days</option>
                <option value="months">months</option>
                <option value="years">years</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${baseId}-edge-weight`} className="ws-eyebrow mb-1 block">
                Weight ({edgeWeight.toFixed(2)})
              </label>
              <input
                id={`${baseId}-edge-weight`}
                type="range"
                min={0.1}
                max={1.0}
                step={0.05}
                value={edgeWeight}
                onChange={(e) => setEdgeWeight(Number(e.target.value))}
                className="mt-2 w-full accent-accent"
              />
            </div>
          </div>

          <div>
            <label htmlFor={`${baseId}-edge-custom`} className="ws-eyebrow mb-1 block">
              Custom Label Override (Optional)
            </label>
            <input
              id={`${baseId}-edge-custom`}
              type="text"
              placeholder="e.g., Upwind Advection, Grid Load Spike"
              value={edgeCustomLabel}
              onChange={(e) => setEdgeCustomLabel(e.target.value)}
              className="form-input"
            />
          </div>

          <div>
            <label htmlFor={`${baseId}-edge-mech`} className="ws-eyebrow mb-1 block">
              Physical Mechanism
            </label>
            <input
              id={`${baseId}-edge-mech`}
              type="text"
              placeholder="e.g., Westerly cloud-cover transport over Front Range"
              value={edgeMechanism}
              onChange={(e) => setEdgeMechanism(e.target.value)}
              className="form-input"
            />
          </div>

          <div>
            <label htmlFor={`${baseId}-edge-rat`} className="ws-eyebrow mb-1 block">
              Hypothesis / Scientific Rationale
            </label>
            <textarea
              id={`${baseId}-edge-rat`}
              rows={2}
              placeholder="Why should a forecasting model read this link?"
              value={edgeRationale}
              onChange={(e) => setEdgeRationale(e.target.value)}
              className="form-input"
            />
          </div>

          {selectedEdge?.properties.correlation_r !== undefined && (
            <div className="flex items-center justify-between rounded-sm border border-border bg-surface-inset px-2.5 py-1.5 font-mono text-[11px] text-text-muted">
              <span>Pearson r: {selectedEdge.properties.correlation_r.toFixed(3)}</span>
              {selectedEdge.properties.predictive_lift_pct !== undefined && (
                <span className="text-emerald-400">
                  Lift: +{selectedEdge.properties.predictive_lift_pct.toFixed(1)}%
                </span>
              )}
            </div>
          )}

          {localError && <div className="text-[11px] text-rose-400">{localError}</div>}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-sm bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
            >
              <Check className="h-3.5 w-3.5" />
              {selectedEdge ? "Save Edge Changes" : "Wire Causal Link"}
            </button>
            {selectedEdge && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleDeleteEdge(selectedEdge.properties.uuid)}
                className="inline-flex items-center gap-1 rounded-sm border border-rose-400 bg-rose-950 px-3 py-2 text-xs font-semibold text-rose-300 hover:border-rose-300 disabled:opacity-50 cursor-pointer"
              >
                <Unlink className="h-3.5 w-3.5" />
                Unlink
              </button>
            )}
          </div>
        </form>
      </div>
    );
  }

  if (!selectedNode) return null;

  /* ── Mode C: Selected Node 3-Tab Workbench ─────────────────────────────── */
  const nodeColor = resolveEtgNodeColor(selectedNode);
  const labelStyle = ETG_LABEL_PALETTE[selectedNode.label];
  const isHuman = selectedNode.properties.authored_by === "human";
  const lightPillColors: Record<ETGNode["label"], string> = {
    Concept: "#0369a1",
    Signal: "#b45309",
    Insight: "#6b21a8",
    Rule: "#047857",
  };
  const pillColor =
    selectedNode.properties.status === "Superseded"
      ? isLightTheme
        ? "#475569"
        : "#94a3b8"
      : isLightTheme
        ? lightPillColors[selectedNode.label]
        : nodeColor;

  return (
    <div className="etg-hud-pill flex max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-md bg-surface shadow-2xl">
      {/* Workbench Header */}
      <div className="border-b border-border px-4 py-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10px] font-semibold"
                style={{
                  backgroundColor: isLightTheme ? labelStyle.pillBgLight : labelStyle.pillBgDark,
                  color: pillColor,
                }}
              >
                {selectedNode.label}
              </span>
              <span className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 font-mono text-[10px] text-text-muted">
                {isHuman
                  ? "Human"
                  : selectedNode.properties.authored_by === "ai"
                    ? "AI Synthesis"
                    : "NASA / Sensor"}
              </span>
              {selectedNode.properties.phenomenon_type && (
                <span className="rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[10px] text-text-subtle">
                  {selectedNode.properties.phenomenon_type.replaceAll("_", " ")}
                </span>
              )}
            </div>
            <h2 className="truncate text-sm font-semibold text-text-primary">
              {selectedNode.properties.name}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close node workbench"
            className="rounded-sm p-1 text-text-muted hover:bg-surface-band hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onStartQuickConnect(selectedNode)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-amber-400 bg-amber-950 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:border-amber-300 cursor-pointer"
          >
            <GitBranchPlus className="h-3 w-3" aria-hidden="true" />
            <span>Connect From Here</span>
          </button>
          <button
            type="button"
            onClick={() => void onDiscoverLinksForNode(selectedNode.uuid)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-purple-400 bg-purple-950 px-2.5 py-1 text-[11px] font-semibold text-purple-300 hover:border-purple-300 cursor-pointer"
          >
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            <span>Discover Links</span>
          </button>
          {typeof selectedNode.properties.lat === "number" &&
            typeof selectedNode.properties.lng === "number" &&
            onLocateOnGlobe && (
              <button
                type="button"
                onClick={() => onLocateOnGlobe(selectedNode)}
                className="inline-flex items-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-2.5 py-1 text-[11px] font-semibold text-sky-300 hover:border-sky-300 cursor-pointer"
              >
                <Globe2 className="h-3 w-3" aria-hidden="true" />
                <span>Locate on 3D Earth</span>
              </button>
            )}
        </div>
      </div>

      {/* Single-Row Accessible Tablist (.etg-tablist / .etg-tab) */}
      <div role="tablist" aria-label="Node workbench sections" className="etg-tablist px-2">
        {tabs.map((tab, idx) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            id={`${baseId}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
            className="etg-tab"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scrollable Body — Zero padding/margins/borders on [role="tabpanel"] itself */}
      <div className="flex-1 overflow-y-auto text-xs">
        {/* TAB 1: TRAVERSE & LINKS */}
        <div
          id={`${baseId}-panel-traverse`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-traverse`}
          hidden={activeTab !== "traverse"}
        >
          <div className="space-y-3.5 p-3.5">
            {(() => {
              const cue = microscopeByNode?.[selectedNode.uuid];
              if (!cue) return null;
              const badgeStyles: Record<
                TrendMicroscopeRadarBadge,
                { label: string; cls: string }
              > = {
                EARLY_ONSET: {
                  label: "Early Onset",
                  cls: "border-amber-400 bg-amber-950 text-amber-300",
                },
                SECULAR_ACCELERATION: {
                  label: "Secular Accel",
                  cls: "border-emerald-400 bg-emerald-950 text-emerald-300",
                },
                FALSE_TREND_CYCLE: {
                  label: "Cycle Alias",
                  cls: "border-purple-400 bg-purple-950 text-purple-300",
                },
                SENSOR_GLITCH_RISK: {
                  label: "Sensor Glitch Risk",
                  cls: "border-rose-400 bg-rose-950 text-rose-300",
                },
                NOMINAL: {
                  label: "Nominal",
                  cls: "border-border bg-surface text-text-muted",
                },
              };
              const secPct = Math.round(cue.dealiasing.secularShare * 100);
              const cycPct = Math.round(cue.dealiasing.oscillationShare * 100);
              const artPct = Math.max(0, 100 - secPct - cycPct);
              const relCoupling = microscopeScan?.verifiedCouplings.find(
                (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
              );
              const relIllusion = microscopeScan?.suppressedIllusions.find(
                (c) => c.sourceUuid === selectedNode.uuid || c.targetUuid === selectedNode.uuid
              );
              return (
                <div className="space-y-1.5 rounded-md border border-border bg-surface-inset p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="ws-eyebrow flex items-center gap-1 text-sky-300">
                      <Sparkles className="h-3 w-3" />
                      AI Trend Microscope
                    </span>
                    <div className="flex items-center gap-1">
                      {cue.preMannKendallAlert && (
                        <span className="rounded-xs border border-amber-400 bg-amber-950 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-300">
                          PRE-MK
                        </span>
                      )}
                      <span
                        className={`rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold ${badgeStyles[cue.radarBadge].cls}`}
                      >
                        {badgeStyles[cue.radarBadge].label}
                      </span>
                    </div>
                  </div>
                  <div className="ws-numeric flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-text-muted">
                    <span>Onset {Math.round(cue.onsetProb * 100)}%</span>
                    {cue.leadStepsAhead > 0 && (
                      <span>Lead ~{cue.leadStepsAhead.toFixed(1)} steps</span>
                    )}
                    <span>Trust {Math.round(cue.trustGate * 100)}%</span>
                  </div>
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface">
                    <div className="bg-emerald-400" style={{ width: `${secPct}%` }} />
                    <div className="bg-purple-400" style={{ width: `${cycPct}%` }} />
                    <div className="bg-rose-400" style={{ width: `${artPct}%` }} />
                  </div>
                  <div className="ws-numeric flex justify-between font-mono text-[9px] text-text-subtle">
                    <span>Secular {secPct}%</span>
                    <span>Cycle {cycPct}%</span>
                    <span>Noise/Drift {artPct}%</span>
                  </div>
                  {relCoupling && (
                    <div className="text-[10px] text-emerald-300">
                      Coupling: {relCoupling.sourceName} → {relCoupling.targetName} (
                      {relCoupling.polarity}, lag={relCoupling.optimalLagSteps}, P=
                      {Math.round(relCoupling.trueCouplingProb * 100)}%)
                    </div>
                  )}
                  {relIllusion && (
                    <div className="text-[10px] text-amber-300">
                      Suppressed Illusion: {relIllusion.sourceName} ↔ {relIllusion.targetName}{" "}
                      (P_illusion={Math.round(relIllusion.confounderProb * 100)}%)
                    </div>
                  )}
                </div>
              );
            })()}

            {traversalHistory.length > 1 && (
              <div className="space-y-1">
                <div className="ws-eyebrow flex items-center gap-1">
                  <History className="h-3 w-3" />
                  Traversal Trail
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {traversalHistory.slice(-5).map((crumb, idx, arr) => {
                    const target = nodeById.get(crumb.uuid);
                    const isCurrent = crumb.uuid === selectedNode.uuid;
                    return (
                      <React.Fragment key={`${crumb.uuid}-${idx}`}>
                        <button
                          type="button"
                          disabled={!target || isCurrent}
                          onClick={() => target && onSelectNode(target)}
                          className={`rounded-xs px-1.5 py-0.5 text-[10px] ${
                            isCurrent
                              ? "border border-accent-fg bg-amber-950 font-semibold text-amber-300"
                              : "bg-surface-inset text-text-muted hover:text-text-primary cursor-pointer"
                          }`}
                        >
                          {crumb.name.slice(0, 16)}
                        </button>
                        {idx < arr.length - 1 && (
                          <span className="text-[10px] text-text-subtle">→</span>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Upstream Drivers */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="ws-eyebrow text-sky-400">
                  Upstream Drivers ({incomingLinks.length})
                </span>
              </div>
              {incomingLinks.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-text-muted">
                  No incoming driver edges yet. Wire one or click Discover Links.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {incomingLinks.map(({ edge, node }) => (
                    <div
                      key={edge.properties.uuid}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-inset px-2.5 py-2"
                    >
                      <button
                        type="button"
                        onClick={() => onSelectNode(node)}
                        className="min-w-0 flex-1 text-left cursor-pointer group"
                      >
                        <div className="truncate font-medium text-text-primary group-hover:text-accent-fg">
                          {node.properties.name}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-text-muted">
                          <span style={{ color: resolveEtgEdgeColor(edge.type) }}>
                            {formatEdgeRelationLabel(edge.type, edge.properties.custom_label)}
                          </span>
                          {typeof edge.properties.optimal_lag_steps === "number" &&
                            edge.properties.optimal_lag_steps > 0 && (
                              <span>
                                · Δt={edge.properties.optimal_lag_steps} {edge.properties.lag_unit}
                              </span>
                            )}
                          {edge.properties.correlation_r !== undefined && (
                            <span>· r={edge.properties.correlation_r.toFixed(2)}</span>
                          )}
                        </div>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onSelectEdge(edge)}
                          title="Edit connection"
                          aria-label={`Edit edge from ${node.properties.name}`}
                          className="rounded p-1 text-text-muted hover:text-text-primary cursor-pointer"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteEdge(edge.properties.uuid)}
                          title="Unlink"
                          aria-label={`Unlink ${node.properties.name}`}
                          className="rounded p-1 text-text-muted hover:text-rose-400 cursor-pointer"
                        >
                          <Unlink className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Downstream Effects */}
            <div className="space-y-1.5">
              <span className="ws-eyebrow block text-amber-400">
                Downstream Effects ({outgoingLinks.length})
              </span>
              {outgoingLinks.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-text-muted">
                  No outgoing downstream edges yet.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {outgoingLinks.map(({ edge, node }) => (
                    <div
                      key={edge.properties.uuid}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-inset px-2.5 py-2"
                    >
                      <button
                        type="button"
                        onClick={() => onSelectNode(node)}
                        className="min-w-0 flex-1 text-left cursor-pointer group"
                      >
                        <div className="truncate font-medium text-text-primary group-hover:text-accent-fg">
                          → {node.properties.name}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-text-muted">
                          <span style={{ color: resolveEtgEdgeColor(edge.type) }}>
                            {formatEdgeRelationLabel(edge.type, edge.properties.custom_label)}
                          </span>
                          {edge.properties.correlation_r !== undefined && (
                            <span>· r={edge.properties.correlation_r.toFixed(2)}</span>
                          )}
                        </div>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onSelectEdge(edge)}
                          aria-label={`Edit edge to ${node.properties.name}`}
                          className="rounded p-1 text-text-muted hover:text-text-primary cursor-pointer"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteEdge(edge.properties.uuid)}
                          aria-label={`Unlink ${node.properties.name}`}
                          className="rounded p-1 text-text-muted hover:text-rose-400 cursor-pointer"
                        >
                          <Unlink className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Quick Inline Wire */}
            {allNodes.length > 1 && (
              <div className="space-y-1.5 border-t border-border pt-3">
                <label htmlFor={`${baseId}-quick-wire`} className="ws-eyebrow block">
                  Quick Wire To Another Node
                </label>
                <div className="flex gap-1.5">
                  <select
                    id={`${baseId}-quick-wire`}
                    value={quickWireTargetUuid}
                    onChange={(e) => setQuickWireTargetUuid(e.target.value)}
                    className="form-input flex-1"
                  >
                    <option value="">Choose target node…</option>
                    {allNodes
                      .filter((n) => n.uuid !== selectedNode.uuid)
                      .map((n) => (
                        <option key={n.uuid} value={n.uuid}>
                          {n.properties.name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!quickWireTargetUuid}
                    onClick={() => {
                      const target = nodeById.get(quickWireTargetUuid);
                      if (target) {
                        onStartQuickConnect(selectedNode, target);
                        setQuickWireTargetUuid("");
                      }
                    }}
                    className="rounded-sm bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-45 cursor-pointer"
                  >
                    Wire
                  </button>
                </div>
              </div>
            )}

            {/* Latent Candidate Links */}
            {nodeCandidates.length > 0 && (
              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="ws-eyebrow flex items-center gap-1 text-purple-300">
                  <Sparkles className="h-3 w-3" />
                  Latent Connection Suggestions ({nodeCandidates.length})
                </div>
                <div className="space-y-1.5">
                  {nodeCandidates.slice(0, 5).map((cand) => (
                    <div
                      key={cand.id}
                      className="rounded-md border border-purple-400 bg-purple-950 p-2.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-text-primary truncate">
                          {cand.sourceName} → {cand.targetName}
                        </span>
                        <button
                          type="button"
                          onClick={() => void onAcceptCandidateLink(cand)}
                          className="shrink-0 inline-flex items-center gap-1 rounded-sm bg-violet-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-violet-400 cursor-pointer"
                        >
                          <Link2 className="h-2.5 w-2.5" />
                          Wire
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-purple-300">
                        <span>
                          {cand.suggestedType.toUpperCase()} · {cand.mechanism}
                          {cand.pearsonR !== undefined ? ` (r=${cand.pearsonR.toFixed(2)})` : ""}
                          {cand.fdrQValue !== undefined ? ` · q=${cand.fdrQValue.toFixed(3)}` : ""}
                        </span>
                        {cand.isSecularDriftOnly && (
                          <span className="rounded-sm border border-amber-400 bg-amber-950 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">
                            Shared secular drift
                          </span>
                        )}
                        {cand.microscopeCouplingProb !== undefined && (
                          <span
                            className={`rounded-sm border px-1.5 py-0.5 text-[9px] font-semibold ${
                              (cand.confounderProb ?? 0) >= 0.55
                                ? "border-amber-400 bg-amber-950 text-amber-300"
                                : "border-emerald-400 bg-emerald-950 text-emerald-300"
                            }`}
                          >
                            {(cand.confounderProb ?? 0) >= 0.55
                              ? `Illusion Risk ${Math.round((cand.confounderProb ?? 0) * 100)}%`
                              : `Microscope ${Math.round(cand.microscopeCouplingProb * 100)}%`}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* TAB 2: PREDICT & ML */}
        <div
          id={`${baseId}-panel-predict`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-predict`}
          hidden={activeTab !== "predict"}
        >
          <div className="space-y-3.5 p-3.5">
            {/* What-If Neighbor Preview */}
            <div className="space-y-1">
              <label htmlFor={`${baseId}-whatif`} className="ws-eyebrow block">
                What-If Candidate Neighbor Preview
              </label>
              <select
                id={`${baseId}-whatif`}
                value={candidatePreviewUuid}
                onChange={(e) => setCandidatePreviewUuid(e.target.value)}
                className="form-input"
              >
                <option value="">Existing graph neighborhood only</option>
                {unlinkedSeriesPeers.map((peer) => (
                  <option key={peer.uuid} value={peer.uuid}>
                    + Preview adding: {peer.properties.name}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="space-y-1.5">
              <legend className="ws-eyebrow">Forecast Horizon</legend>
              <div className="grid grid-cols-3 gap-1.5">
                {([1, 2, 3] as const).map((step) => {
                  const radioId = `${baseId}-horizon-${step}`;
                  const active = horizonSteps === step;
                  return (
                    <div key={step} className="relative">
                      <input
                        id={radioId}
                        type="radio"
                        name={`${baseId}-horizon`}
                        value={step}
                        checked={active}
                        onChange={() => setHorizonSteps(step)}
                        className="visually-hidden"
                      />
                      <label
                        htmlFor={radioId}
                        className={`flex cursor-pointer items-center justify-center rounded-sm border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                          active
                            ? "border-sky-400 bg-sky-950 text-sky-300"
                            : "border-border bg-surface-inset text-text-muted hover:text-text-primary"
                        }`}
                      >
                        +{step} step{step > 1 ? "s" : ""}
                      </label>
                    </div>
                  );
                })}
              </div>
            </fieldset>

            {predictLoading && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface-inset p-3 text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                <span>Fitting leak-free Ridge model over {maxHops}-hop neighborhood…</span>
              </div>
            )}

            {predictError && !predictLoading && (
              <div className="space-y-2.5 rounded-md border border-amber-400 bg-amber-950 p-3 text-[11px] text-amber-300">
                <p>{predictError}</p>
                <p className="text-text-muted">
                  Need a multi-node continuous daily graph to benchmark? Load the 7-node Denver Front
                  Range irradiance graph directly into ETG.
                </p>
                <button
                  type="button"
                  onClick={() => void onMaterializeSolarGraph()}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-amber-500 px-2.5 py-1.5 font-semibold text-black hover:bg-amber-400 cursor-pointer"
                >
                  <Sun className="h-3.5 w-3.5" />
                  Load 7-Node Solar Predictive Graph
                </button>
              </div>
            )}

            {prediction && !predictLoading && (
              <>
                {/* Next Forecast Highlight */}
                <div className="rounded-md border border-sky-400 bg-sky-950 p-3 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="ws-eyebrow text-sky-300">
                      Next {prediction.bucket} forecast ({prediction.nextForecast.nextPeriodLabel})
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(prediction.engineUsed === "l4_inductive_gnn" ||
                        prediction.engineUsed === "local_inductive_gnn") && (
                        <span className="rounded-sm border border-cyan-400 bg-cyan-950 px-2 py-0.5 text-[9px] font-semibold text-cyan-300">
                          {prediction.engineUsed === "l4_inductive_gnn"
                            ? "L4 Neural GNN"
                            : "Inductive Weights v2"}
                        </span>
                      )}
                      {prediction.activeGraphArchitecture && (
                        <span className="rounded-sm border border-purple-400 bg-purple-950 px-2 py-0.5 text-[9px] font-semibold text-purple-300">
                          {prediction.activeGraphArchitecture === "stacked_ensemble"
                            ? "Stacked Ensemble"
                            : prediction.activeGraphArchitecture === "nonlinear_interaction"
                              ? "Nonlinear Interaction"
                              : "Linear Graph Ridge"}
                        </span>
                      )}
                      <span
                        className={`rounded-sm border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                          prediction.skillLiftVsSelfPct > 0
                            ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                            : "border-border bg-surface text-text-muted"
                        }`}
                      >
                        Graph Lift {prediction.skillLiftVsSelfPct >= 0 ? "+" : ""}
                        {prediction.skillLiftVsSelfPct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xl font-bold text-text-primary">
                      {prediction.nextForecast.graphAwarePred.toFixed(2)} {prediction.unit}
                    </span>
                    <span className="font-mono text-[11px] text-text-muted">
                      ± {prediction.nextForecast.ci95HalfWidth.toFixed(2)} (95% CI)
                    </span>
                  </div>
                  {prediction.quantiles && (
                    <div className="font-mono text-[10px] text-sky-300">
                      Quantiles: P10 {prediction.quantiles.p10.toFixed(2)} · P50{" "}
                      {prediction.quantiles.p50.toFixed(2)} · P90 {prediction.quantiles.p90.toFixed(2)}{" "}
                      {prediction.unit}
                    </div>
                  )}
                  <div className="font-mono text-[10px] text-text-muted">
                    Self AR: {prediction.nextForecast.selfOnlyPred.toFixed(2)} · Persistence:{" "}
                    {prediction.nextForecast.persistencePred.toFixed(2)}
                    {typeof prediction.nonlinearSkillGainPct === "number" &&
                    Math.abs(prediction.nonlinearSkillGainPct) >= 0.1
                      ? ` · NL Gain: ${prediction.nonlinearSkillGainPct >= 0 ? "+" : ""}${prediction.nonlinearSkillGainPct.toFixed(1)}%`
                      : ""}
                  </div>
                  {(prediction.trendForecast || (prediction.scalesUsed && prediction.scalesUsed.length > 0)) && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {prediction.trendForecast && (
                        <span
                          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                            prediction.trendForecast.direction === "increasing"
                              ? "border-amber-400 bg-amber-950 text-amber-300"
                              : prediction.trendForecast.direction === "decreasing"
                                ? "border-sky-400 bg-sky-950 text-sky-300"
                                : "border-border bg-surface text-text-muted"
                          }`}
                        >
                          Trend: {prediction.trendForecast.direction} · Regime shift{" "}
                          {(prediction.trendForecast.regimeShiftProb * 100).toFixed(0)}%
                        </span>
                      )}
                      {prediction.scalesUsed?.map((sc) => (
                        <span
                          key={sc}
                          className="rounded-sm border border-border-strong bg-surface-inset px-1.5 py-0.5 font-mono text-[9px] text-text-muted"
                        >
                          scale:{sc}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {prediction.communityImpact &&
                  (prediction.communityImpact.communityNodesActive > 0 ||
                    prediction.communityImpact.trustGatedCount > 0) && (
                    <div className="rounded-md border border-emerald-500/40 bg-surface-inset px-2.5 py-2 text-[11px] flex flex-wrap items-center justify-between gap-1.5">
                      <span className="text-text-secondary">
                        Community Graph: <strong>{prediction.communityImpact.communityNodesActive}</strong>{" "}
                        active · <strong>{prediction.communityImpact.trustGatedCount}</strong> trust-gated
                      </span>
                      <span
                        className={`font-mono text-[10px] font-semibold ${
                          prediction.communityImpact.marginalCommunityLiftPct > 0
                            ? "text-emerald-300"
                            : "text-text-muted"
                        }`}
                      >
                        Community Lift{" "}
                        {prediction.communityImpact.marginalCommunityLiftPct >= 0 ? "+" : ""}
                        {prediction.communityImpact.marginalCommunityLiftPct.toFixed(1)}%
                      </span>
                    </div>
                  )}

                {/* Model Recommendation & Guardrail Banner */}
                <div
                  role="status"
                  className={`rounded-md border p-2.5 text-[11px] space-y-1 ${
                    prediction.reliabilityWarning
                      ? "border-amber-400 bg-amber-950 text-amber-300"
                      : "border-emerald-400 bg-emerald-950 text-emerald-300"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      {prediction.reliabilityWarning ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                      ) : (
                        <TrendingUp className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" />
                      )}
                      <span>
                        Recommended:{" "}
                        {prediction.recommendedModel === "graph_aware"
                          ? "Graph Model"
                          : prediction.recommendedModel === "self_ar"
                            ? "Self-Only AR"
                            : "Persistence"}
                      </span>
                    </span>
                    <span className="font-mono">
                      {prediction.recommendedForecastValue.toFixed(2)} {prediction.unit}
                    </span>
                  </div>
                  {prediction.reliabilityWarning && (
                    <p className="leading-relaxed text-amber-300">
                      {prediction.reliabilityWarning}
                    </p>
                  )}
                </div>

                {/* 3-Way Holdout Benchmark */}
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <div className="ws-inset p-2">
                    <div className="text-[10px] text-text-muted">Persistence</div>
                    <div className="font-mono text-xs font-semibold text-text-primary">
                      RMSE {prediction.persistence.rmse.toFixed(3)}
                    </div>
                    <div className="font-mono text-[10px] text-text-subtle">
                      R² {prediction.persistence.r2.toFixed(2)}
                    </div>
                  </div>
                  <div className="ws-inset p-2">
                    <div className="text-[10px] text-text-muted">Self-Only AR</div>
                    <div className="font-mono text-xs font-semibold text-text-primary">
                      RMSE {prediction.selfOnly.rmse.toFixed(3)}
                    </div>
                    <div className="font-mono text-[10px] text-text-subtle">
                      R² {prediction.selfOnly.r2.toFixed(2)}
                    </div>
                  </div>
                  <div className="rounded-md border border-sky-400 bg-sky-950 p-2">
                    <div className="text-[10px] font-semibold text-sky-300">Graph Model</div>
                    <div className="font-mono text-xs font-bold text-text-primary">
                      RMSE {prediction.graphAware.rmse.toFixed(3)}
                    </div>
                    <div className="font-mono text-[10px] text-emerald-300">
                      R² {prediction.graphAware.r2.toFixed(2)}
                    </div>
                  </div>
                </div>

                <BacktestChart backtest={prediction.backtest} isLightTheme={isLightTheme} />

                {/* Neighbor Contributions */}
                <div className="space-y-1.5">
                  <div className="ws-eyebrow">
                    Graph Feature Attribution ({prediction.neighborContributions.length} signals)
                  </div>
                  {prediction.neighborContributions.length === 0 ? (
                    <div className="rounded-sm border border-dashed border-border p-2 text-[11px] text-text-muted">
                      No overlapping neighbor time series linked yet. Wire another series node above!
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {prediction.neighborContributions.slice(0, 6).map((c) => {
                        const target = nodeById.get(c.nodeUuid);
                        return (
                          <div key={`${c.nodeUuid}-${c.lagSteps}`} className="ws-inset p-2 space-y-1">
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <button
                                type="button"
                                disabled={!target}
                                onClick={() => target && onSelectNode(target)}
                                className="truncate font-medium text-text-primary hover:text-accent-fg cursor-pointer text-left"
                              >
                                {c.nodeName}
                                {c.isCandidatePreview ? " (Preview)" : ""}
                              </button>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {c.ablationLiftPct !== undefined && (
                                  <span
                                    className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                                      c.ablationLiftPct > 0
                                        ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                                        : c.ablationLiftPct < 0
                                          ? "border-amber-400 bg-amber-950 text-amber-300"
                                          : "border-border bg-surface text-text-muted"
                                    }`}
                                  >
                                    {c.ablationLiftPct >= 0 ? "+" : ""}
                                    {c.ablationLiftPct.toFixed(1)}%{" "}
                                    {c.ablationLiftPct >= 0 ? "lift" : "overfit"}
                                  </span>
                                )}
                                <span className="font-mono text-[10px] text-sky-300">
                                  {c.sharePct.toFixed(1)}% · lag {c.lagSteps}
                                </span>
                              </div>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-xs bg-surface">
                              <div
                                className={`h-full rounded-xs ${
                                  c.isCandidatePreview ? "bg-purple-400" : "bg-sky-400"
                                }`}
                                style={{ width: `${Math.min(100, Math.max(4, c.sharePct))}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {candidatePreviewUuid && (
                  <button
                    type="button"
                    onClick={() => {
                      const peer = nodeById.get(candidatePreviewUuid);
                      if (peer) onStartQuickConnect(peer, selectedNode);
                    }}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm bg-violet-500 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-400 cursor-pointer"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    Wire Previewed Neighbor into Graph
                  </button>
                )}

                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={ledgerBusy}
                    onClick={() => void handleLogProspectiveForecast()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-sm bg-sky-500 px-2.5 py-2 text-[11px] font-semibold text-black hover:bg-sky-400 disabled:opacity-50 cursor-pointer"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Log Live Forecast</span>
                  </button>
                  <button
                    type="button"
                    disabled={ledgerBusy}
                    onClick={() => void handleReconcileForecasts()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-2.5 py-2 text-[11px] font-medium text-text-primary hover:border-accent-fg disabled:opacity-50 cursor-pointer"
                  >
                    <History className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Score Actuals</span>
                  </button>
                </div>

                {/* Prospective Verification Ledger */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h4 id={`${baseId}-ledger-heading`} className="ws-eyebrow">
                      Prospective Verification Ledger ({ledgerSummary?.total_logged ?? ledgerRecords.length})
                    </h4>
                    {ledgerSummary && ledgerSummary.scored_count > 0 && (
                      <span className="font-mono text-[10px] text-emerald-300">
                        MAE {ledgerSummary.mean_abs_error?.toFixed(3)} · CI95 {ledgerSummary.ci95_coverage_pct}%
                      </span>
                    )}
                  </div>

                  {ledgerRecords.length === 0 ? (
                    <div className="rounded-sm border border-dashed border-border p-2 text-[11px] text-text-muted">
                      Log a forecast now; when new readings arrive for that period, the store automatically scores MAE and 95% CI coverage.
                    </div>
                  ) : (
                    <div
                      tabIndex={0}
                      role="region"
                      aria-labelledby={`${baseId}-ledger-heading`}
                      className="etg-table-wrapper"
                    >
                      <table
                        className="etg-table"
                        style={
                          {
                            "--label-1": '"Target"',
                            "--label-2": '"Forecast"',
                            "--label-3": '"Actual"',
                            "--label-4": '"Outcome"',
                          } as React.CSSProperties
                        }
                      >
                        <thead>
                          <tr>
                            <th scope="col">Target</th>
                            <th scope="col">Forecast</th>
                            <th scope="col">Actual</th>
                            <th scope="col">Outcome</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ledgerRecords.slice(0, 8).map((rec) => (
                            <tr key={rec.id}>
                              <th scope="row" className="font-mono text-text-primary">
                                {rec.target_period}
                              </th>
                              <td className="font-mono text-text-primary">
                                {rec.predicted_value.toFixed(2)} ± {rec.ci95_half_width.toFixed(2)}
                              </td>
                              <td className="font-mono text-text-muted">
                                {rec.status === "scored" && typeof rec.actual_value === "number"
                                  ? `${rec.actual_value.toFixed(2)} ${rec.unit}`
                                  : "Awaiting"}
                              </td>
                              <td>
                                {rec.status === "scored" ? (
                                  <span
                                    className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                                      rec.covered_by_ci95
                                        ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                                        : "border-amber-400 bg-amber-950 text-amber-300"
                                    }`}
                                  >
                                    {rec.covered_by_ci95 ? "✓ " : "Miss "}
                                    MAE {rec.abs_error?.toFixed(2)}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[9px] font-semibold text-text-muted">
                                    Pending
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-1.5">
                  <button
                    type="button"
                    disabled={exportingMl}
                    onClick={() => void handleExportMlV2Json()}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm border border-sky-400 bg-sky-950 px-3 py-2 text-xs font-medium text-sky-300 hover:border-sky-300 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    {exportingMl ? "Exporting ML Tensor…" : "Export etg-ml-v2 Multi-Scale Bundle (Colab / Blackwell)"}
                  </button>
                  <button
                    type="button"
                    disabled={exportingMl}
                    onClick={() => void handleExportMlJson()}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-surface-inset px-3 py-2 text-xs font-medium text-text-primary hover:border-accent-fg cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    {exportingMl ? "Exporting ML Tensor…" : "Export PyG / Python ML Dataset (.json)"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* TAB 3: EVIDENCE & EDIT */}
        <div
          id={`${baseId}-panel-evidence`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-evidence`}
          hidden={activeTab !== "evidence"}
        >
          <div className="space-y-3.5 p-3.5">
            {/* Telemetry Summary */}
            <div className="grid grid-cols-2 gap-2">
              <div className="ws-inset p-2.5">
                <div className="ws-eyebrow">Mann-Kendall p</div>
                <div className="font-mono text-sm font-semibold text-text-primary mt-0.5">
                  {typeof selectedNode.properties.p_value === "number"
                    ? selectedNode.properties.p_value.toFixed(4)
                    : "n/a"}
                </div>
              </div>
              <div className="ws-inset p-2.5">
                <div className="ws-eyebrow">Theil-Sen Slope</div>
                <div className="font-mono text-sm font-semibold text-text-primary mt-0.5 flex items-center gap-1">
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
                <form onSubmit={handleReviseBelief} className="space-y-2 rounded-md border border-border bg-surface-inset p-2.5">
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
                    className="w-full rounded-sm bg-amber-500 px-3 py-1.5 font-semibold text-black hover:bg-amber-400 cursor-pointer"
                  >
                    Record Supersedes Revision
                  </button>
                </form>
              )}
            </div>

            {localError && <div className="text-[11px] text-rose-400">{localError}</div>}
            {localStatus && <div className="text-[11px] text-emerald-400">{localStatus}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
