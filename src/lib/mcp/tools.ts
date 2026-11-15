import { DATASET_BY_ID } from "@/lib/datasets";
import { discoverGlobalEarthTrends } from "@/lib/discovery/globalTrendPipeline";
import { validateGraphAction } from "@/lib/graph/graphGuard";
import {
  GIBS_LAYERS,
  computeGlobalBordersProxyUrl,
  computeGlobalLayerSpec,
  computeRegionalTileSpec,
  type ActiveGibsLayerId,
} from "@/lib/earth/nasaGibsRegional";
import {
  fetchCamsSurfacePm25Series,
  fetchGlofasDischargeSeries,
  fetchNearestUsgsGaugeAnnualSeries,
  type OpenFeedSeriesResult,
} from "@/lib/earth/openFeedsClient";
import { getEtgStore, type TemporalBucket } from "@/lib/graph/etgStore";
import {
  materializeDenverSolarGraphIntoEtg,
  predictFromGraph,
  predictRegion,
} from "@/lib/graph/graphPredictor";
import { scanTrendMicroscopeAsync } from "@/lib/graph/trendMicroscope";
import { fetchEarthTimeSeries } from "@/lib/nasa/nasaPowerClient";
import { sanitizeResearchDossier } from "@/lib/research/dossierUtils";
import { fetchDenverSolarClimateGraph } from "@/lib/solar/denverClimateGraph";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import type {
  ETGDatasetId,
  ETGEdgeProperties,
  ETGNodeProperties,
  ETGRelationshipType,
  ETGResearchDossier,
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
        dossier: {
          type: "object",
          description:
            "Optional structured Scientific Trend Dossier (abstract, physical_mechanism, empirical_findings[], impacts[], citations[], markdown_body).",
        },
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
          enum: ["supports", "corroborates", "contradicts", "drives_opposite", "correlates_with"],
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
            "contradicts",
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
        edge_types: {
          type: "array",
          items: { type: "string" },
          description: "Optional relationship types to traverse (e.g., leads, drives_opposite, supersedes).",
        },
        min_weight: { type: "number", description: "Minimum edge weight filter (0..1)." },
        include_superseded: {
          type: "boolean",
          description: "Whether to include superseded historical assessments (default true).",
        },
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
  {
    name: "etg_ingest_open_feed",
    description:
      "Fetch live open physical Earth feeds (Copernicus CAMS surface PM2.5, USGS river gauge discharge, or Copernicus GloFAS discharge) at lat/lng, compute Mann-Kendall & Theil-Sen statistics, and ingest into the ETG.",
    inputSchema: {
      type: "object",
      properties: {
        feed: {
          type: "string",
          enum: ["cams_pm25", "usgs_gauge", "glofas_discharge"],
          description: "Open physical Earth observation feed ID.",
        },
        lat: { type: "number", description: "Latitude (-90..90)." },
        lng: { type: "number", description: "Longitude (-180..180)." },
        start_year: { type: "number", description: "Start year (defaults to 2022 for cams_pm25, 1995 for hydrology)." },
        end_year: { type: "number", description: "End year (defaults to 2025)." },
        granularity: {
          type: "string",
          enum: ["annual", "monthly"],
          description: "Series aggregation granularity.",
        },
        label: { type: "string", description: "Optional human-readable station or observation title." },
      },
      required: ["feed", "lat", "lng"],
    },
  },
  {
    name: "etg_resolve_gibs_imagery",
    description:
      "Resolve NASA GIBS satellite WMS imagery layer metadata, temporal cadence ISO dates, and same-origin proxy URLs globally or zoomed around a regional coordinate.",
    inputSchema: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          enum: [...Object.keys(GIBS_LAYERS), "borders"],
          description: "NASA GIBS satellite layer identifier or 'borders'.",
        },
        scope: {
          type: "string",
          enum: ["global", "regional"],
          description: "Equirectangular global globe overlay or zoomed regional swatch (default global).",
        },
        lat: { type: "number", description: "Center latitude (-90..90) when scope='regional'." },
        lng: { type: "number", description: "Center longitude (-180..180) when scope='regional'." },
        camera_radius: {
          type: "number",
          description: "Optional regional camera orbital radius (1.05..3.2, default 1.65).",
        },
        cutoff_iso: {
          type: "string",
          description: "Optional timeline scrubber ISO date or year for historical satellite swath resolution.",
        },
      },
      required: ["layer"],
    },
  },
  {
    name: "etg_query_solar_graph",
    description:
      "Evaluate the Front Range / Denver Solar Climate Graph using NASA POWER & Open-Meteo irradiance/advection telemetry with 3-way forecasting, optionally materializing the station Concept/Signal nodes into the live ETG.",
    inputSchema: {
      type: "object",
      properties: {
        start_year: { type: "number", description: "Start year (2015..2023, default 2019)." },
        end_year: { type: "number", description: "End year (default current UTC year)." },
        force_refresh: { type: "boolean", description: "Bypass cached evaluation and fetch fresh telemetry." },
        materialize_into_etg: {
          type: "boolean",
          description: "If true, materialize the Front Range station nodes and causal edges into the ETG store.",
        },
      },
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

      const sigLat = typeof args.lat === "number" ? args.lat : Number(args.lat);
      const sigLng = typeof args.lng === "number" ? args.lng : Number(args.lng);
      if (
        !Number.isFinite(sigLat) ||
        sigLat < -90 ||
        sigLat > 90 ||
        !Number.isFinite(sigLng) ||
        sigLng < -180 ||
        sigLng > 180
      ) {
        throw new Error(`Invalid signal coordinates (${String(args.lat)}, ${String(args.lng)}).`);
      }
      const sigDataset = typeof args.dataset === "string" ? args.dataset : "community";
      if (!(sigDataset in DATASET_BY_ID)) {
        throw new Error(`Invalid signal dataset "${String(args.dataset)}".`);
      }
      const sigName = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "AI Agent Observation";
      const sigDesc =
        typeof args.description === "string" && args.description.trim()
          ? args.description.trim()
          : "Ingested via MCP Earth Trend Detective";
      const sigVerdict = validateGraphAction(store, {
        type: "create_node",
        label: "Signal",
        name: sigName,
        description: sigDesc,
        lat: sigLat,
        lng: sigLng,
        dataset: sigDataset as ETGDatasetId,
      });
      if (!sigVerdict.allowed) {
        throw new Error(`Blocked (${sigVerdict.rule}): ${sigVerdict.reason}`);
      }

      const node = store.createNode({
        label: "Signal",
        is_provisional: false,
        properties: {
          name: sigName,
          description: sigDesc,
          lat: sigLat,
          lng: sigLng,
          dataset: sigDataset as ETGDatasetId,
          producer_type: "ai_synthesis",
          value: typeof args.value === "number" && Number.isFinite(args.value) ? args.value : undefined,
          unit: typeof args.unit === "string" ? args.unit : undefined,
          confidence:
            typeof args.confidence === "number" &&
            Number.isFinite(args.confidence) &&
            args.confidence >= 0 &&
            args.confidence <= 1
              ? args.confidence
              : 0.85,
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
      if (typeof args.name !== "string" || typeof args.description !== "string") {
        throw new Error("etg_propose_insight requires string name and description.");
      }
      if (args.dataset !== undefined && (typeof args.dataset !== "string" || !(args.dataset in DATASET_BY_ID))) {
        throw new Error(`Invalid dataset "${String(args.dataset)}".`);
      }
      if (typeof args.supersedes_node_uuid === "string" && args.supersedes_node_uuid.trim()) {
        const revRationale =
          typeof args.rationale === "string" && args.rationale.trim()
            ? args.rationale.trim()
            : "Revised based on new multi-source evidence";
        const revVerdict = validateGraphAction(store, {
          type: "revise_belief",
          priorNodeUuid: args.supersedes_node_uuid.trim(),
          newName: args.name,
          newDescription: args.description,
          ...(args.dossier !== undefined ? { dossier: args.dossier as ETGResearchDossier } : {}),
          rationale: revRationale,
        });
        if (!revVerdict.allowed) {
          throw new Error(`Blocked (${revVerdict.rule}): ${revVerdict.reason}`);
        }
        const cleanDossier =
          args.dossier !== undefined ? sanitizeResearchDossier(args.dossier) : undefined;
        return store.reviseBelief({
          priorNodeUuid: args.supersedes_node_uuid.trim(),
          newName: args.name,
          newDescription: args.description,
          ...(cleanDossier ? { dossier: cleanDossier } : {}),
          rationale: revRationale,
          dataset: (args.dataset as ETGDatasetId) || undefined,
        });
      }
      const insightVerdict = validateGraphAction(store, {
        type: "create_insight",
        name: args.name,
        description: args.description,
        lat: args.lat as number | undefined,
        lng: args.lng as number | undefined,
        ...(args.dossier !== undefined ? { dossier: args.dossier as ETGResearchDossier } : {}),
        rationale: typeof args.rationale === "string" ? args.rationale : undefined,
      });
      if (!insightVerdict.allowed) {
        throw new Error(`Blocked (${insightVerdict.rule}): ${insightVerdict.reason}`);
      }
      const cleanDossier =
        args.dossier !== undefined ? sanitizeResearchDossier(args.dossier) : undefined;
      const node = store.createNode({
        label: "Insight",
        is_provisional: true,
        properties: {
          name: args.name,
          description: args.description,
          ...(cleanDossier ? { dossier: cleanDossier } : {}),
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
      const sourceUuid = typeof args.source_uuid === "string" ? args.source_uuid.trim() : "";
      const targetUuid = typeof args.target_uuid === "string" ? args.target_uuid.trim() : "";
      if (!sourceUuid || !targetUuid) {
        throw new Error("Both source_uuid and target_uuid are required for etg_connect_nodes.");
      }
      const edgeType = (typeof args.relationship === "string"
        ? args.relationship
        : "relates_to") as ETGRelationshipType;
      const mechanism = typeof args.mechanism === "string" ? args.mechanism : undefined;
      const rationale = typeof args.rationale === "string" ? args.rationale : undefined;

      const connectVerdict = validateGraphAction(store, {
        type: "connect_nodes",
        sourceUuid,
        targetUuid,
        edgeType,
        mechanism,
        rationale: rationale || "MCP relationship assertion",
      });
      if (!connectVerdict.allowed) {
        throw new Error(`Blocked (${connectVerdict.rule}): ${connectVerdict.reason}`);
      }

      const edge = store.createEdge({
        source_uuid: sourceUuid,
        target_uuid: targetUuid,
        type: edgeType,
        mechanism,
        rationale,
        optimal_lag_steps:
          typeof args.lag_steps === "number" && Number.isFinite(args.lag_steps)
            ? args.lag_steps
            : undefined,
        lag_unit:
          args.lag_unit === "days" || args.lag_unit === "months" || args.lag_unit === "years"
            ? args.lag_unit
            : undefined,
        weight:
          typeof args.weight === "number" && Number.isFinite(args.weight) ? args.weight : undefined,
        custom_label: typeof args.custom_label === "string" ? args.custom_label : undefined,
        authored_by: "ai",
        autoEnrichSeries: true,
      });
      return { edge, stats: store.getSnapshot().stats };
    }

    case "etg_unlink_or_update": {
      const operation = String(args.operation || "update");
      if (args.patch !== undefined && (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch))) {
        throw new Error("patch must be a plain object for etg_unlink_or_update.");
      }
      const patch = (args.patch && typeof args.patch === "object"
        ? args.patch
        : {}) as Record<string, unknown>;

      if (typeof patch.label === "string") {
        const validLabels = new Set(["Concept", "Signal", "Insight", "Rule"]);
        if (!validLabels.has(patch.label)) {
          throw new Error(`Invalid ETG node label "${patch.label}". Must be Concept, Signal, Insight, or Rule.`);
        }
      }
      if (patch.lat !== undefined && (typeof patch.lat !== "number" || !Number.isFinite(patch.lat) || patch.lat < -90 || patch.lat > 90)) {
        throw new Error("Invalid patch.lat: must be finite number between -90 and 90.");
      }
      if (patch.lng !== undefined && (typeof patch.lng !== "number" || !Number.isFinite(patch.lng) || patch.lng < -180 || patch.lng > 180)) {
        throw new Error("Invalid patch.lng: must be finite number between -180 and 180.");
      }
      if (typeof patch.dataset === "string" && !(patch.dataset in DATASET_BY_ID)) {
        throw new Error(`Invalid patch.dataset "${patch.dataset}".`);
      }

      if (typeof args.edge_uuid === "string" && args.edge_uuid) {
        const existingEdge = store
          .getSnapshot()
          .edges.find((item) => item.properties.uuid === args.edge_uuid);
        if (!existingEdge) {
          throw new Error(`Edge ${args.edge_uuid} not found.`);
        }
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
        const existingNode = store.getNode(args.node_uuid);
        if (!existingNode) {
          throw new Error(`Node ${args.node_uuid} not found.`);
        }
        if (operation === "delete") {
          if (existingNode.label === "Rule" || existingNode.properties.producer_type === "nasa_satellite") {
            throw new Error(
              `Blocked (rule-protect-agency-and-rules): Cannot delete protected ${existingNode.label} node "${existingNode.properties.name}".`
            );
          }
          const deleted = store.deleteNode(args.node_uuid);
          return { deleted, nodeUuid: args.node_uuid, stats: store.getSnapshot().stats };
        }
        const safePatch: Record<string, unknown> = { ...patch };
        if (patch.dossier !== undefined) {
          const cleanDossier = sanitizeResearchDossier(patch.dossier);
          if (!cleanDossier) {
            throw new Error("Blocked (GEO_AND_STRUCT_VALIDITY): Invalid research dossier payload.");
          }
          safePatch.dossier = cleanDossier;
        }
        const updateVerdict = validateGraphAction(store, {
          type: "update_node",
          uuid: args.node_uuid,
          ...(typeof patch.name === "string" && patch.name !== existingNode.properties.name
            ? { name: patch.name }
            : {}),
          ...(typeof patch.description === "string" &&
          patch.description !== existingNode.properties.description
            ? { description: patch.description }
            : {}),
          ...(typeof patch.region === "string" && patch.region !== existingNode.properties.region
            ? { region: patch.region }
            : {}),
          ...(safePatch.dossier ? { dossier: safePatch.dossier as ETGResearchDossier } : {}),
          rationale:
            typeof patch.rationale === "string" && patch.rationale.trim().length >= 6
              ? patch.rationale
              : "MCP scientific dossier / metadata update",
        });
        if (!updateVerdict.allowed) {
          throw new Error(`Blocked (${updateVerdict.rule}): ${updateVerdict.reason}`);
        }
        delete safePatch.rationale;
        const node = store.updateNode(
          args.node_uuid,
          safePatch as Partial<ETGNodeProperties> & { label?: string }
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
        edgeTypes: Array.isArray(args.edge_types)
          ? (args.edge_types.filter((t): t is ETGRelationshipType => typeof t === "string"))
          : undefined,
        minWeight: typeof args.min_weight === "number" ? args.min_weight : undefined,
        includeSuperseded: args.include_superseded !== false,
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

    case "etg_ingest_open_feed": {
      const feed = String(args.feed ?? "");
      const lat = Number(args.lat);
      const lng = Number(args.lng);
      if (feed !== "cams_pm25" && feed !== "usgs_gauge" && feed !== "glofas_discharge") {
        throw new Error(
          "Unsupported feed. Choose one of: cams_pm25, usgs_gauge, glofas_discharge."
        );
      }
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        throw new Error("Valid lat (-90..90) and lng (-180..180) coordinates are required.");
      }

      const startYear = Number.isFinite(Number(args.start_year))
        ? Number(args.start_year)
        : feed === "cams_pm25"
          ? 2022
          : 1995;
      const endYear = Number.isFinite(Number(args.end_year)) ? Number(args.end_year) : 2025;
      const granularity: "annual" | "monthly" =
        args.granularity === "annual" || args.granularity === "monthly"
          ? args.granularity
          : feed === "cams_pm25"
            ? "monthly"
            : "annual";

      let feedResult: OpenFeedSeriesResult | null = null;
      if (feed === "cams_pm25") {
        feedResult = await fetchCamsSurfacePm25Series(lat, lng, startYear, endYear, granularity);
      } else if (feed === "usgs_gauge") {
        feedResult = await fetchNearestUsgsGaugeAnnualSeries(lat, lng, startYear, endYear);
      } else {
        feedResult = await fetchGlofasDischargeSeries(lat, lng, startYear, endYear, granularity);
      }

      if (!feedResult || feedResult.points.length < 6) {
        throw new Error(
          feed === "usgs_gauge"
            ? `No active USGS river gauge with >= 6 years of annual discharge data found near (${lat.toFixed(2)}, ${lng.toFixed(2)}).`
            : `No sufficient observations returned from ${feed} near (${lat.toFixed(2)}, ${lng.toFixed(2)}).`
        );
      }

      const dataset: ETGDatasetId = feed === "cams_pm25" ? "air_quality" : "hydrology";
      const summaryStats = analyzeTimeSeries(feedResult.points, {
        lat: feedResult.siteInfo?.lat ?? lat,
        lng: feedResult.siteInfo?.lng ?? lng,
        dataset,
        parameter: feedResult.metricName,
        unit: feedResult.unit,
        slopeUnit: `${feedResult.unit}/yr`,
        provenance: feedResult.provenanceSource,
      });

      const latest = feedResult.points[feedResult.points.length - 1];
      const cleanLabel =
        typeof args.label === "string" && args.label.trim().length > 0
          ? args.label.trim()
          : feedResult.siteInfo
            ? `${feedResult.siteInfo.siteName} (USGS ${feedResult.siteInfo.siteNo})`
            : `${feedResult.metricName} (${lat.toFixed(2)}, ${lng.toFixed(2)})`;

      const nodeSlug = `${feed}-${lat.toFixed(2)}_${lng.toFixed(2)}-${granularity}`;
      const webhookResult = store.ingestHardwareWebhook(`openfeed-${nodeSlug}`, {
        device_id: feedResult.siteInfo?.siteNo
          ? `USGS-${feedResult.siteInfo.siteNo}`
          : `${feedResult.parameterCode}-${lat.toFixed(2)}_${lng.toFixed(2)}`,
        device_name: cleanLabel,
        title: cleanLabel,
        description: `${feedResult.provenanceSource} · ${feedResult.points.length} ${granularity} observations (${feedResult.points[0].date}..${latest.date}). ${summaryStats.verdict}. Source: ${feedResult.sourceUrl}`,
        lat: feedResult.siteInfo?.lat ?? lat,
        lng: feedResult.siteInfo?.lng ?? lng,
        dataset,
        producer_type: feed === "usgs_gauge" ? "iot_sensor" : "nasa_satellite",
        value: latest.value,
        unit: feedResult.unit,
        observed_at: latest.date,
        confidence: feed === "usgs_gauge" ? 0.96 : 0.9,
        series: feedResult.points,
      });

      return {
        status: "ingested",
        feed,
        provenance: feedResult.provenanceSource,
        sourceUrl: feedResult.sourceUrl,
        pointCount: feedResult.points.length,
        summaryStats,
        hardwareNode: webhookResult.hardwareNode,
        signalNode: webhookResult.signalNode,
        discoveredConnectionsCount: webhookResult.discoveredConnections.length,
        linkedInsightsCount: webhookResult.linkedInsights.length,
      };
    }

    case "etg_resolve_gibs_imagery": {
      const rawLayer = String(args.layer ?? "");
      if (rawLayer === "borders") {
        return {
          layer: "borders",
          scope: "global",
          wmsLayers: "Coastlines,Reference_Features",
          format: "image/png",
          proxyUrl: computeGlobalBordersProxyUrl(),
        };
      }
      if (!Object.prototype.hasOwnProperty.call(GIBS_LAYERS, rawLayer)) {
        throw new Error(
          `Unsupported NASA GIBS layer '${rawLayer}'. Valid layers: ${[...Object.keys(GIBS_LAYERS), "borders"].join(", ")}.`
        );
      }
      const layerId = rawLayer as ActiveGibsLayerId;
      let cutoffMs: number | undefined;
      if (typeof args.cutoff_iso === "string" && args.cutoff_iso.trim()) {
        const trimmed = args.cutoff_iso.trim();
        if (/^\d{4}$/.test(trimmed)) {
          cutoffMs = Date.UTC(Number(trimmed), 6, 1);
        } else {
          const parsed = Date.parse(trimmed);
          if (Number.isFinite(parsed)) cutoffMs = parsed;
        }
      }
      const globalSpec = computeGlobalLayerSpec({ layerId, cutoffMs });
      const scope = args.scope === "regional" ? "regional" : "global";
      let regionalSpec = null;
      if (scope === "regional" || (typeof args.lat === "number" && typeof args.lng === "number")) {
        const lat = Number(args.lat);
        const lng = Number(args.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          throw new Error("Regional GIBS imagery resolution requires finite lat and lng coordinates.");
        }
        regionalSpec = computeRegionalTileSpec({
          lat,
          lng,
          cameraRadius: typeof args.camera_radius === "number" ? args.camera_radius : 1.65,
          layerId,
          cutoffMs,
        });
      }
      const meta = GIBS_LAYERS[layerId];
      return {
        layer: layerId,
        label: meta.label,
        shortLabel: meta.shortLabel,
        resolutionLabel: meta.resolutionLabel,
        wmsLayers: scope === "global" ? meta.globalWmsLayers : meta.wmsLayers,
        scope,
        globalSpec,
        regionalSpec,
      };
    }

    case "etg_query_solar_graph": {
      const currentYear = new Date().getUTCFullYear();
      const startYear = Math.max(2015, Math.min(2023, Number(args.start_year) || 2019));
      const endYear = Math.max(
        startYear + 2,
        Math.min(currentYear, Number(args.end_year) || currentYear)
      );
      const forceRefresh = Boolean(args.force_refresh);
      const solarResult = await fetchDenverSolarClimateGraph(startYear, endYear, {
        forceRefresh,
      });
      if (args.materialize_into_etg === true) {
        const materialized = await materializeDenverSolarGraphIntoEtg(store);
        return {
          ...solarResult,
          materialized: {
            hubUuid: materialized.hubUuid,
            createdNodesCount: materialized.createdNodes.length,
            createdEdgesCount: materialized.createdEdges.length,
          },
        };
      }
      return solarResult;
    }

    default:
      throw new Error(`Unknown ETG MCP tool: ${toolName}`);
  }
}

export async function handleEtgMcpRpc(body: unknown): Promise<{
  status: number;
  payload: Record<string, unknown>;
}> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
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
      if (!rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params)) {
        return {
          status: 400,
          payload: {
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            error: { code: -32602, message: "Invalid params: object expected" },
          },
        };
      }
      const name = typeof rpc.params.name === "string" ? rpc.params.name : "";
      if (
        rpc.params.arguments !== undefined &&
        (!rpc.params.arguments ||
          typeof rpc.params.arguments !== "object" ||
          Array.isArray(rpc.params.arguments))
      ) {
        return {
          status: 400,
          payload: {
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            error: { code: -32602, message: "Invalid tool arguments: plain object expected" },
          },
        };
      }
      const args = (rpc.params.arguments as Record<string, unknown>) || {};
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
