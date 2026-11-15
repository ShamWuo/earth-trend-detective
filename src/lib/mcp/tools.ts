import { discoverGlobalEarthTrends } from "@/lib/discovery/globalTrendPipeline";
import { getEtgStore, type TemporalBucket } from "@/lib/graph/etgStore";
import { predictFromGraph, predictRegion } from "@/lib/graph/graphPredictor";
import { scanTrendMicroscopeAsync } from "@/lib/graph/trendMicroscope";
import { fetchEarthTimeSeries } from "@/lib/nasa/nasaPowerClient";
import { compareRegionalSeries } from "@/lib/stats/trendEngine";
import type {
  ETGDatasetId,
  ETGEdgeProperties,
  ETGNodeProperties,
  ETGRelationshipType,
  TraversalDirection,
} from "@/types/etg";

export interface EtgMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export const ETG_MCP_TOOLS: readonly EtgMcpToolDefinition[] = [
  {
    name: "etg_discover_global_trends",
    description:
      "Fetch live NASA GISTEMP v4, NOAA GML/CDO stations, NSIDC Sea Ice v4, KNMI indices, CSA/Geo.ca hydrology, SWOT passes, NASA EONET v3, and POWER MERRA-2 datasets, compute Hamed-Rao Mann-Kendall, OLS R², & Theil-Sen significance, corroborate multi-agency trends, and wire global dipoles.",
    inputSchema: {
      type: "object",
      properties: {
        clear_existing: {
          type: "boolean",
          description: "If true, clear existing nodes before building the live dataset Knowledge Graph.",
        },
        max_eonet_sites: {
          type: "number",
          description: "Maximum number of spatially diverse EONET regions to analyze via MERRA-2 (default 7).",
        },
      },
    },
  },
  {
    name: "etg_query_graph",
    description:
      "Query the communal Earth Trend Graph (ETG) by dataset, scientific ontology label (Concept, Signal, Insight, Rule), time range, or opposite-trend teleconnections.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: {
          type: "string",
          enum: ["all", "nasa_power", "wildfire", "ocean_temp", "air_quality", "deforestation", "hydrology", "community"],
          description: "Earth observation dataset layer filter.",
        },
        label: {
          type: "string",
          enum: ["all", "Concept", "Signal", "Insight", "Rule"],
          description: "Scientific ETG node label filter.",
        },
        search: { type: "string", description: "Keyword search across node names, regions, and descriptions." },
        only_opposite_trends: {
          type: "boolean",
          description: "When true, return only nodes participating in cross-region drives_opposite teleconnections.",
        },
        include_bundle: {
          type: "boolean",
          description: "When true, include portable etg-workspace-v1 bundle with offloaded time-series.",
        },
      },
    },
  },
  {
    name: "etg_ingest_signal",
    description:
      "Ingest a timestamped geo-pinned Earth observation Signal from an AI vision model, satellite feed, or community sensor.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Observation title." },
        description: { type: "string", description: "Scientific observation details and sensor context." },
        lat: { type: "number", description: "Latitude (-90 to 90)." },
        lng: { type: "number", description: "Longitude (-180 to 180)." },
        dataset: {
          type: "string",
          enum: ["nasa_power", "wildfire", "ocean_temp", "air_quality", "deforestation", "hydrology", "community"],
        },
        value: { type: "number", description: "Observed numeric metric." },
        unit: { type: "string", description: "Measurement unit (e.g., °C, µg/m³, NDVI)." },
        confidence: { type: "number", description: "Confidence score from 0 to 1." },
        observed_at: { type: "string", description: "ISO timestamp or YYYY-MM-DD / YYYY observation date." },
        event_uuid: {
          type: "string",
          description: "Optional existing Signal/event UUID to update in place and append telemetry to.",
        },
        series: {
          type: "array",
          description: "Optional time-series points [{ date, value }] to attach/merge for trend & correlation discovery.",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              value: { type: "number" },
            },
            required: ["date", "value"],
          },
        },
        supports_node_uuid: {
          type: "string",
          description: "Optional Insight UUID this signal corroborates.",
        },
      },
      required: ["name", "description", "lat", "lng", "dataset"],
    },
  },
  {
    name: "etg_propose_insight",
    description:
      "Propose a new Earth Trend Insight or revise an existing hypothesis via epistemic belief revision (supersedes).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Trend insight title." },
        description: { type: "string", description: "Scientific synthesis & mechanistic explanation." },
        lat: { type: "number" },
        lng: { type: "number" },
        dataset: {
          type: "string",
          enum: ["nasa_power", "wildfire", "ocean_temp", "air_quality", "deforestation", "hydrology", "community"],
        },
        supersedes_node_uuid: {
          type: "string",
          description: "Optional prior Insight UUID to mark Superseded and link with a supersedes edge.",
        },
        rationale: { type: "string", description: "Scientific rationale for the trend or belief revision." },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "etg_analyze_timeseries",
    description:
      "Query NASA POWER MERRA-2 time-series at (lat, lng) and compute Mann-Kendall p-value and Theil-Sen slope, with optional cross-region teleconnection comparison.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Primary coordinate latitude." },
        lng: { type: "number", description: "Primary coordinate longitude." },
        dataset: {
          type: "string",
          enum: ["nasa_power", "wildfire", "ocean_temp", "air_quality", "deforestation", "hydrology", "community"],
        },
        compare_lat: { type: "number", description: "Optional comparison region latitude." },
        compare_lng: { type: "number", description: "Optional comparison region longitude." },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "etg_corroborate_trend",
    description:
      "Link a supporting source to an Insight and evaluate the Multi-Source Corroboration Gate (>=2 independent sources).",
    inputSchema: {
      type: "object",
      properties: {
        source_uuid: { type: "string", description: "Supporting Signal or Concept UUID." },
        target_uuid: { type: "string", description: "Target Insight UUID." },
        relationship: {
          type: "string",
          enum: ["supports", "corroborates", "drives_opposite", "correlates_with"],
        },
        rationale: { type: "string" },
      },
      required: ["source_uuid", "target_uuid"],
    },
  },
  {
    name: "etg_trace_teleconnection",
    description:
      "Trace the shortest multi-hop scientific provenance route between any two ETG nodes or list all cross-region opposite trends.",
    inputSchema: {
      type: "object",
      properties: {
        from_uuid: { type: "string", description: "Origin node UUID." },
        to_uuid: { type: "string", description: "Destination node UUID." },
      },
    },
  },
  {
    name: "etg_connect_nodes",
    description:
      "Flexibly connect any two existing Earth Trend Graph nodes (signals, insights, physical impacts, discrete events, or climate indices) with causal/correlative relationships and automatic lead-lag statistical enrichment.",
    inputSchema: {
      type: "object",
      properties: {
        source_uuid: { type: "string", description: "Upstream driver or source node UUID." },
        target_uuid: { type: "string", description: "Downstream target or impacted node UUID." },
        relationship: {
          type: "string",
          enum: [
            "leads",
            "drives_opposite",
            "amplifies",
            "dampens",
            "advects_to",
            "triggers",
            "impacts",
            "teleconnects",
            "correlates_with",
            "corroborates",
            "supports",
            "relates_to",
            "hypothesized_link",
          ],
          description: "Causal or correlative edge type.",
        },
        mechanism: { type: "string", description: "Physical or atmospheric mechanism description." },
        rationale: { type: "string", description: "Scientific justification for this connection." },
        lag_steps: { type: "number", description: "Lead lag in time steps (days/months/years)." },
        lag_unit: { type: "string", enum: ["days", "months", "years"] },
        weight: { type: "number", description: "Normalized causal/graph edge weight (0..1)." },
        custom_label: { type: "string", description: "Optional custom human-readable edge label." },
      },
      required: ["source_uuid", "target_uuid", "relationship"],
    },
  },
  {
    name: "etg_unlink_or_update",
    description:
      "Update node or edge metadata (relationship type, weight, lag, domain tags, summary) or remove an outdated edge/node as scientific understanding evolves.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["update", "delete"], description: "Operation mode." },
        edge_uuid: { type: "string", description: "Target edge UUID to update or delete." },
        node_uuid: { type: "string", description: "Target node UUID to update or delete." },
        patch: {
          type: "object",
          description: "Fields to update on the node or edge.",
        },
      },
      required: ["operation"],
    },
  },
  {
    name: "etg_traverse_subgraph",
    description:
      "Traverse a k-hop upstream-driver and/or downstream-impact neighborhood around a root ETG node, returning hop depths, directional roles, induced subgraph, and top causal paths.",
    inputSchema: {
      type: "object",
      properties: {
        root_uuid: { type: "string", description: "Anchor node UUID to traverse from." },
        to_uuid: {
          type: "string",
          description: "Optional destination node UUID to enumerate weighted multi-hop paths toward.",
        },
        max_hops: { type: "number", description: "Neighborhood depth 1..6 (default 2)." },
        direction: { type: "string", enum: ["upstream", "downstream", "both"] },
        min_weight: { type: "number", description: "Minimum edge weight filter (0..1)." },
      },
      required: ["root_uuid"],
    },
  },
  {
    name: "etg_discover_missing_links",
    description:
      "Scan unconnected node pairs across the Earth Trend Graph to surface latent lead-lag correlations, opposite dipoles, and spatial couplings, optionally auto-wiring the top K discoveries.",
    inputSchema: {
      type: "object",
      properties: {
        anchor_uuid: {
          type: "string",
          description: "Optional anchor node UUID to scan against all other nodes.",
        },
        min_abs_r: {
          type: "number",
          description: "Minimum absolute correlation threshold (default 0.42).",
        },
        limit: { type: "number", description: "Max suggestions to return (default 12)." },
        auto_wire_top_k: {
          type: "number",
          description: "If > 0, automatically create AI-authored edges for top K discoveries.",
        },
      },
    },
  },
  {
    name: "etg_predict_from_graph",
    description:
      "Run the nonlinear & linear graph-reading predictive model on any time-series node using connected upstream ETG drivers, log/reconcile prospective forecasts on the verification ledger, or export aligned PyG/NetworkX tensors.",
    inputSchema: {
      type: "object",
      properties: {
        target_uuid: { type: "string", description: "Target ETG node UUID to forecast." },
        max_hops: { type: "number", description: "Upstream traversal hops (1..4, default 2)." },
        horizon_steps: { type: "number", description: "Forecast horizon in time steps (1..3, default 1)." },
        candidate_neighbor_uuid: {
          type: "string",
          description: "Optional unwired candidate neighbor to preview potential predictive skill lift.",
        },
        export_ml_tensor: {
          type: "boolean",
          description: "If true, export edge_index, edge_attr, and [T, N, 3] feature_tensor instead.",
        },
        export_ml_tensor_v2: {
          type: "boolean",
          description: "If true, export zero-leakage multi-scale etg-ml-v2 tensor bundle for Colab/L4 GNNs.",
        },
        lat: {
          type: "number",
          description: "Optional latitude (-90..90) to run regional forecast without an existing node UUID.",
        },
        lng: {
          type: "number",
          description: "Optional longitude (-180..180) to run regional forecast without an existing node UUID.",
        },
        dataset: {
          type: "string",
          description: "Optional Earth dataset ID (e.g. nasa_power, wildfire, hydrology, air_quality).",
        },
        log_prospective: {
          type: "boolean",
          description: "If true, log the generated live forecast onto the prospective verification ledger.",
        },
        include_ledger: {
          type: "boolean",
          description: "If true, attach prospective forecast ledger records & scored MAE/coverage summary.",
        },
        reconcile_forecasts: {
          type: "boolean",
          description: "If true, reconcile pending prospective forecasts against newly arrived observations instead of running a new fit.",
        },
        bucket: { type: "string", enum: ["day", "month", "year"] },
      },
    },
  },
  {
    name: "etg_scan_trend_microscope",
    description:
      "Run the ETG Trend Microscope (3-in-1 AI sensory organ) to detect early pre-Mann-Kendall trend inflections, score true directional lead-lag & opposite-trend couplings while suppressing seasonal/shared-drift illusions, and de-alias secular trends vs. multi-year oscillations or sensor glitches. Returns structured cue cards and a token-compact aiPerceptionBrief.",
    inputSchema: {
      type: "object",
      properties: {
        focus_uuid: {
          type: "string",
          description: "Optional ETG node UUID to center the Trend Microscope scan around.",
        },
        lat: {
          type: "number",
          description: "Optional latitude (-90..90) to scan near or fetch live NASA POWER regional context.",
        },
        lng: {
          type: "number",
          description: "Optional longitude (-180..180) to scan near or fetch live NASA POWER regional context.",
        },
        dataset: {
          type: "string",
          description: "Optional Earth dataset ID (e.g. nasa_power, wildfire, hydrology, air_quality).",
        },
        max_hops: {
          type: "number",
          description: "Neighborhood hops around focus_uuid (1..4, default 2).",
        },
        top_k: {
          type: "number",
          description: "Maximum verified couplings and suppressed illusions to return (default 8).",
        },
        compact_brief_only: {
          type: "boolean",
          description: "If true, return only the token-compact aiPerceptionBrief and summary metadata.",
        },
      },
      required: [],
    },
  },
];

export async function executeEtgMcpTool(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const store = getEtgStore();

  switch (toolName) {
    case "etg_discover_global_trends": {
      const result = await discoverGlobalEarthTrends(store, {
        clearExisting: Boolean(args.clear_existing),
        maxEonetSites:
          typeof args.max_eonet_sites === "number" ? args.max_eonet_sites : 7,
      });
      return {
        summary: result.summary,
        stats: result.snapshot.stats,
        oppositeTrendPairs: result.snapshot.oppositeTrendPairs.map((p) => ({
          edgeUuid: p.edgeUuid,
          source: p.source.properties.name,
          target: p.target.properties.name,
          correlationR: p.correlationR,
          rationale: p.rationale,
        })),
      };
    }

    case "etg_query_graph": {
      const snap = store.queryGraph({
        dataset: (args.dataset as ETGDatasetId | "all") ?? "all",
        label: (args.label as any) ?? "all",
        search: typeof args.search === "string" ? args.search : undefined,
        onlyOppositeTrends: Boolean(args.only_opposite_trends),
      });
      return {
        stats: snap.stats,
        nodes: snap.nodes,
        edges: snap.edges,
        oppositeTrendPairs: snap.oppositeTrendPairs.map((p) => ({
          edgeUuid: p.edgeUuid,
          source: p.source.properties.name,
          target: p.target.properties.name,
          correlationR: p.correlationR,
          rationale: p.rationale,
        })),
        ...(args.include_bundle ? { bundle: store.exportWorkspaceBundle() } : {}),
      };
    }

    case "etg_ingest_signal": {
      if (typeof args.event_uuid === "string" && args.event_uuid.trim()) {
        const updated = store.ingestHardwareWebhook(args.event_uuid.trim(), {
          title: typeof args.name === "string" ? args.name : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          lat: typeof args.lat === "number" ? args.lat : undefined,
          lng: typeof args.lng === "number" ? args.lng : undefined,
          dataset: (args.dataset as ETGDatasetId) || undefined,
          producer_type: "ai_synthesis",
          value: typeof args.value === "number" ? args.value : undefined,
          unit: typeof args.unit === "string" ? args.unit : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          observed_at: typeof args.observed_at === "string" ? args.observed_at : undefined,
          series: Array.isArray(args.series) ? args.series : undefined,
        });
        let audit = null;
        if (typeof args.supports_node_uuid === "string" && args.supports_node_uuid) {
          store.createEdge({
            source_uuid: updated.signalNode.uuid,
            target_uuid: args.supports_node_uuid,
            type: "supports",
            source_snippet: "MCP AI-agent signal corroboration",
          });
          audit = store.evaluateCorroboration(args.supports_node_uuid);
        }
        return {
          signal: updated.signalNode,
          hardwareNode: updated.hardwareNode,
          corroborationAudit: audit,
          autoConnections: {
            linkedInsights: updated.linkedInsights,
            linkedSignals: updated.linkedSignals,
            corroborationAudits: updated.corroborationAudits,
            discoveredConnections: updated.discoveredConnections,
          },
        };
      }

      const parseDateToT = (rawDate: string): number => {
        const trimmed = rawDate.trim();
        if (/^\d{4}$/.test(trimmed)) return Number(trimmed);
        const ym = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
        if (ym) return Number((Number(ym[1]) + (Number(ym[2]) - 1) / 12).toFixed(6));
        const ms = Date.parse(trimmed);
        if (Number.isFinite(ms)) {
          const d = new Date(ms);
          const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
          return Number((d.getUTCFullYear() + (ms - yearStart) / (365.25 * 86_400_000)).toFixed(6));
        }
        return 0;
      };

      const obsAt =
        typeof args.observed_at === "string" && args.observed_at.trim()
          ? args.observed_at.trim()
          : new Date().toISOString();

      let rawSeries = Array.isArray(args.series)
        ? args.series
            .filter(
              (pt): pt is { date: string; value: number; t?: number } =>
                Boolean(pt) &&
                typeof pt === "object" &&
                typeof (pt as { date?: unknown }).date === "string" &&
                typeof (pt as { value?: unknown }).value === "number"
            )
            .map((pt) => {
              const trimmed = pt.date.trim();
              const tVal =
                typeof pt.t === "number" && Number.isFinite(pt.t) ? pt.t : parseDateToT(trimmed);
              return {
                date: trimmed,
                t: tVal,
                value: pt.value,
              };
            })
        : undefined;

      if ((!rawSeries || rawSeries.length === 0) && typeof args.value === "number" && Number.isFinite(args.value)) {
        rawSeries = [{ date: obsAt, t: parseDateToT(obsAt), value: args.value }];
      }

      const node = store.createNode({
        label: "Signal",
        is_provisional: false,
        properties: {
          name: String(args.name || "AI Agent Observation"),
          description: String(args.description || "Ingested via MCP"),
          lat: Number(args.lat),
          lng: Number(args.lng),
          dataset: (args.dataset as ETGDatasetId) || "community",
          producer_type: "ai_synthesis",
          value: typeof args.value === "number" ? args.value : undefined,
          unit: typeof args.unit === "string" ? args.unit : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : 0.85,
          observed_at: obsAt,
          series: rawSeries,
        },
      });
      let audit = null;
      if (typeof args.supports_node_uuid === "string" && args.supports_node_uuid) {
        store.createEdge({
          source_uuid: node.uuid,
          target_uuid: args.supports_node_uuid,
          type: "supports",
          source_snippet: "MCP AI-agent signal corroboration",
        });
        audit = store.evaluateCorroboration(args.supports_node_uuid);
      }
      const autoConnections = store.autoConnectNode(node.uuid, true);
      return {
        signal: store.getNode(node.uuid) ?? node,
        corroborationAudit: audit,
        autoConnections,
      };
    }

    case "etg_propose_insight": {
      if (typeof args.supersedes_node_uuid === "string" && args.supersedes_node_uuid) {
        return store.reviseBelief({
          priorNodeUuid: args.supersedes_node_uuid,
          newName: String(args.name),
          newDescription: String(args.description),
          rationale: String(args.rationale || "Revised based on new multi-source evidence"),
          dataset: (args.dataset as ETGDatasetId) || undefined,
        });
      }
      const node = store.createNode({
        label: "Insight",
        is_provisional: true,
        properties: {
          name: String(args.name),
          description: String(args.description),
          lat: typeof args.lat === "number" ? args.lat : undefined,
          lng: typeof args.lng === "number" ? args.lng : undefined,
          dataset: (args.dataset as ETGDatasetId) || "nasa_power",
          producer_type: "ai_synthesis",
        },
      });
      return { insight: node, status: "Provisional until corroborated by >=2 independent sources" };
    }

    case "etg_analyze_timeseries": {
      const lat = Number(args.lat);
      const lng = Number(args.lng);
      const dataset = ((args.dataset as ETGDatasetId) || "nasa_power");
      const primary = await fetchEarthTimeSeries(lat, lng, dataset);

      let comparison = null;
      if (args.compare_lat !== undefined && args.compare_lng !== undefined) {
        const secondary = await fetchEarthTimeSeries(
          Number(args.compare_lat),
          Number(args.compare_lng),
          dataset
        );
        comparison = {
          secondarySummary: {
            lat: secondary.lat,
            lng: secondary.lng,
            verdict: secondary.verdict,
            mannKendall: secondary.mannKendall,
            theilSen: secondary.theilSen,
          },
          crossRegion: compareRegionalSeries(
            primary.points.map((p) => ({ date: p.date, t: p.t, value: p.value })),
            secondary.points.map((p) => ({ date: p.date, t: p.t, value: p.value }))
          ),
        };
      }
      return { primary, comparison };
    }

    case "etg_corroborate_trend": {
      const edge = store.createEdge({
        source_uuid: String(args.source_uuid),
        target_uuid: String(args.target_uuid),
        type: ((args.relationship as ETGRelationshipType) || "corroborates"),
        rationale: typeof args.rationale === "string" ? args.rationale : undefined,
      });
      const audit = store.evaluateCorroboration(String(args.target_uuid));
      return { edge, audit };
    }

    case "etg_trace_teleconnection": {
      if (typeof args.from_uuid === "string" && typeof args.to_uuid === "string") {
        const path = store.traceShortestPath(args.from_uuid, args.to_uuid);
        return { path, found: Boolean(path) };
      }
      return { oppositeTrendPairs: store.getOppositeTrendPairs() };
    }

    case "etg_connect_nodes": {
      const edge = store.createEdge({
        source_uuid: String(args.source_uuid),
        target_uuid: String(args.target_uuid),
        type: (args.relationship as ETGRelationshipType) || "relates_to",
        mechanism: typeof args.mechanism === "string" ? args.mechanism : undefined,
        rationale: typeof args.rationale === "string" ? args.rationale : undefined,
        optimal_lag_steps: typeof args.lag_steps === "number" ? args.lag_steps : undefined,
        lag_unit:
          args.lag_unit === "days" || args.lag_unit === "months" || args.lag_unit === "years"
            ? args.lag_unit
            : undefined,
        weight: typeof args.weight === "number" ? args.weight : undefined,
        custom_label: typeof args.custom_label === "string" ? args.custom_label : undefined,
        authored_by: "ai",
        autoEnrichSeries: true,
      });
      return { edge, stats: store.getSnapshot().stats };
    }

    case "etg_unlink_or_update": {
      const operation = String(args.operation || "update");
      const patch = (args.patch && typeof args.patch === "object"
        ? args.patch
        : {}) as Record<string, unknown>;

      if (typeof args.edge_uuid === "string" && args.edge_uuid) {
        if (operation === "delete") {
          const deleted = store.deleteEdge(args.edge_uuid);
          return { deleted, edgeUuid: args.edge_uuid, stats: store.getSnapshot().stats };
        }
        const edge = store.updateEdge(
          args.edge_uuid,
          patch as Partial<ETGEdgeProperties> & { type?: ETGRelationshipType }
        );
        return { edge, updated: Boolean(edge) };
      }

      if (typeof args.node_uuid === "string" && args.node_uuid) {
        if (operation === "delete") {
          const deleted = store.deleteNode(args.node_uuid);
          return { deleted, nodeUuid: args.node_uuid, stats: store.getSnapshot().stats };
        }
        const node = store.updateNode(
          args.node_uuid,
          patch as Partial<ETGNodeProperties> & { label?: string }
        );
        return { node, updated: Boolean(node) };
      }

      throw new Error("Provide edge_uuid or node_uuid for etg_unlink_or_update.");
    }

    case "etg_traverse_subgraph": {
      const rootUuid = String(args.root_uuid);
      if (typeof args.to_uuid === "string" && args.to_uuid.trim()) {
        const paths = store.findAllPaths(
          rootUuid,
          args.to_uuid.trim(),
          typeof args.max_hops === "number" ? args.max_hops : 5
        );
        return { rootUuid, toUuid: args.to_uuid.trim(), paths };
      }
      return store.traverseSubgraph({
        rootUuid,
        maxHops: typeof args.max_hops === "number" ? args.max_hops : 2,
        direction: (args.direction as TraversalDirection) || "both",
        minWeight: typeof args.min_weight === "number" ? args.min_weight : undefined,
      });
    }

    case "etg_discover_missing_links": {
      const suggestions = store.discoverCandidateLinks({
        anchorUuid: typeof args.anchor_uuid === "string" ? args.anchor_uuid : undefined,
        minAbsR: typeof args.min_abs_r === "number" ? args.min_abs_r : undefined,
        limit: typeof args.limit === "number" ? args.limit : 12,
      });
      const autoWireK =
        typeof args.auto_wire_top_k === "number" ? Math.max(0, Math.floor(args.auto_wire_top_k)) : 0;
      const wiredEdges = [];
      for (const s of suggestions.slice(0, autoWireK)) {
        wiredEdges.push(
          store.createEdge({
            source_uuid: s.sourceUuid,
            target_uuid: s.targetUuid,
            type: s.suggestedType,
            correlation_r: s.pearsonR,
            detrended_r: s.detrendedR,
            optimal_lag_steps: s.optimalLagSteps,
            lag_unit: s.lagUnit,
            mechanism: s.mechanism,
            rationale: s.rationale,
            weight: s.score,
            authored_by: "ai",
          })
        );
      }
      return { suggestions, wiredEdges };
    }

    case "etg_predict_from_graph": {
      if (args.export_ml_tensor_v2) {
        return store.exportMlGraphDatasetV2({
          rootUuid: typeof args.target_uuid === "string" ? args.target_uuid : undefined,
          maxHops: typeof args.max_hops === "number" ? args.max_hops : 2,
          bucket: (args.bucket as TemporalBucket | undefined) || undefined,
          horizonSteps: typeof args.horizon_steps === "number" ? args.horizon_steps : 1,
        });
      }
      if (args.export_ml_tensor) {
        return store.exportMlGraphDataset({
          rootUuid: typeof args.target_uuid === "string" ? args.target_uuid : undefined,
          maxHops: typeof args.max_hops === "number" ? args.max_hops : 2,
          bucket: (args.bucket as TemporalBucket | undefined) || undefined,
        });
      }
      if (args.reconcile_forecasts) {
        return store.reconcileProspectiveForecasts(
          typeof args.target_uuid === "string" && args.target_uuid
            ? args.target_uuid
            : undefined
        );
      }
      const hasCoords = typeof args.lat === "number" && typeof args.lng === "number";
      if ((typeof args.target_uuid !== "string" || !args.target_uuid) && !hasCoords) {
        if (args.include_ledger) {
          return store.getProspectiveLedger();
        }
        throw new Error(
          "target_uuid or (lat, lng) is required unless export_ml_tensor=true, export_ml_tensor_v2=true, reconcile_forecasts=true, or include_ledger=true."
        );
      }
      const prediction = hasCoords
        ? await predictRegion(store, {
            targetUuid: typeof args.target_uuid === "string" ? args.target_uuid : undefined,
            lat: args.lat as number,
            lng: args.lng as number,
            dataset: typeof args.dataset === "string" ? (args.dataset as ETGDatasetId) : undefined,
            maxHops: typeof args.max_hops === "number" ? args.max_hops : 2,
            horizonSteps: typeof args.horizon_steps === "number" ? args.horizon_steps : 1,
            candidateNeighborUuid:
              typeof args.candidate_neighbor_uuid === "string"
                ? args.candidate_neighbor_uuid
                : undefined,
          })
        : predictFromGraph(store, {
            targetUuid: args.target_uuid as string,
            maxHops: typeof args.max_hops === "number" ? args.max_hops : 2,
            horizonSteps: typeof args.horizon_steps === "number" ? args.horizon_steps : 1,
            candidateNeighborUuid:
              typeof args.candidate_neighbor_uuid === "string"
                ? args.candidate_neighbor_uuid
                : undefined,
          });
      const loggedForecast = args.log_prospective
        ? store.logProspectiveForecast(prediction)
        : undefined;
      if (loggedForecast || args.include_ledger) {
        return {
          ...prediction,
          ...(loggedForecast ? { loggedForecast } : {}),
          ledger: store.getProspectiveLedger(prediction.targetUuid),
        };
      }
      return prediction;
    }

    case "etg_scan_trend_microscope": {
      const scan = await scanTrendMicroscopeAsync(store, {
        focusNodeUuid:
          typeof args.focus_uuid === "string" ? args.focus_uuid : undefined,
        lat: typeof args.lat === "number" ? args.lat : undefined,
        lng: typeof args.lng === "number" ? args.lng : undefined,
        dataset:
          typeof args.dataset === "string"
            ? (args.dataset as ETGDatasetId)
            : undefined,
        maxHops: typeof args.max_hops === "number" ? args.max_hops : undefined,
        topK: typeof args.top_k === "number" ? args.top_k : undefined,
      });
      if (args.compact_brief_only === true) {
        return {
          schemaVersion: scan.schemaVersion,
          engineUsed: scan.engineUsed,
          nodeCount: scan.nodeCount,
          aiPerceptionBrief: scan.aiPerceptionBrief,
        };
      }
      return scan;
    }

    default:
      throw new Error(`Unknown ETG MCP tool: ${toolName}`);
  }
}

export async function handleEtgMcpRpc(body: unknown): Promise<{
  status: number;
  payload: Record<string, unknown>;
}> {
  if (!body || typeof body !== "object") {
    return {
      status: 400,
      payload: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      },
    };
  }

  const rpc = body as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };

  const id = rpc.id ?? null;

  switch (rpc.method) {
    case "initialize":
      return {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: {
              name: "Earth Trend Detective ETG",
              version: "1.0.0",
            },
          },
        },
      };

    case "notifications/initialized":
    case "ping":
      return {
        status: 200,
        payload: { jsonrpc: "2.0", id, result: {} },
      };

    case "tools/list":
      return {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          id,
          result: { tools: ETG_MCP_TOOLS },
        },
      };

    case "tools/call": {
      const name = String(rpc.params?.name || "");
      const args = (rpc.params?.arguments as Record<string, unknown>) || {};
      try {
        const data = await executeEtgMcpTool(name, args);
        return {
          status: 200,
          payload: {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            },
          },
        };
      } catch (err) {
        return {
          status: 200,
          payload: {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: err instanceof Error ? err.message : "Tool execution failed",
                },
              ],
            },
          },
        };
      }
    }

    default:
      return {
        status: 404,
        payload: {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        },
      };
  }
}
