import { discoverGlobalEarthTrends } from "@/lib/discovery/globalTrendPipeline";
import { getEtgStore } from "@/lib/graph/etgStore";
import { fetchEarthTimeSeries } from "@/lib/nasa/nasaPowerClient";
import { compareRegionalSeries } from "@/lib/stats/trendEngine";
import type { ETGDatasetId, ETGRelationshipType } from "@/types/etg";

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
