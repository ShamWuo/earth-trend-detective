import { NextRequest, NextResponse } from "next/server";
import { GIBS_LAYERS } from "@/lib/earth/nasaGibsRegional";
import { ETG_MCP_TOOLS } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const gibsLayerEnum = [...Object.keys(GIBS_LAYERS), "borders"];

  const paths: Record<string, unknown> = {
    "/api/mcp": {
      post: {
        tags: ["MCP JSON-RPC"],
        summary: "Streamable HTTP MCP JSON-RPC 2.0 Endpoint",
        operationId: "etgMcpRpc",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  jsonrpc: { type: "string", enum: ["2.0"] },
                  id: { type: "number" },
                  method: { type: "string", enum: ["initialize", "tools/list", "tools/call"] },
                  params: { type: "object" },
                },
                required: ["jsonrpc", "method"],
              },
            },
          },
        },
        responses: {
          "200": { description: "JSON-RPC 2.0 response" },
        },
      },
    },
    "/api/earth/discover": {
      post: {
        tags: ["Live Global Discovery"],
        summary: "Ingest live NASA GISTEMP v4, NOAA CO₂, EONET v3, and NASA POWER MERRA-2 and wire ETG connections",
        operationId: "discoverGlobalEarthTrends",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  clearExisting: { type: "boolean" },
                  maxEonetSites: { type: "number" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Discovery summary and populated ETG snapshot" } },
      },
    },
    "/api/earth/dataset-import": {
      post: {
        tags: ["Dataset Import"],
        summary: "Import real CSV or JSON time-series datasets and correlate against the ETG",
        operationId: "importEmpiricalDataset",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  format: { type: "string", enum: ["csv", "json"] },
                  content: { type: "string" },
                  sourceName: { type: "string" },
                },
                required: ["content"],
              },
            },
          },
        },
        responses: { "201": { description: "Empirical series analyzed and wired into ETG" } },
      },
    },
    "/api/earth/open-feeds": {
      post: {
        tags: ["Open Physical Feeds"],
        summary: "Fetch CAMS PM2.5, USGS river gauge, or GloFAS discharge series, analyze significance, and ingest into ETG",
        operationId: "ingestOpenEarthFeed",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  feed: { type: "string", enum: ["cams_pm25", "usgs_gauge", "glofas_discharge"] },
                  lat: { type: "number" },
                  lng: { type: "number" },
                  startYear: { type: "integer" },
                  endYear: { type: "integer" },
                  granularity: { type: "string", enum: ["annual", "monthly"] },
                  label: { type: "string" },
                },
                required: ["feed", "lat", "lng"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Open feed series analyzed and ingested into ETG" },
          "400": { description: "Invalid feed or coordinates" },
          "404": { description: "No sufficient station or grid observations available" },
        },
      },
    },
    "/api/earth/gibs": {
      get: {
        tags: ["NASA GIBS Satellite Imagery"],
        summary: "Same-origin proxy for NASA GIBS EPSG:4326 satellite WMS textures and vector borders",
        operationId: "getNasaGibsImagery",
        parameters: [
          { name: "layer", in: "query", required: true, schema: { type: "string", enum: gibsLayerEnum } },
          { name: "scope", in: "query", schema: { type: "string", enum: ["global", "regional"] } },
          { name: "bbox", in: "query", required: true, schema: { type: "string", description: "minLng,minLat,maxLng,maxLat" } },
          { name: "width", in: "query", schema: { type: "integer", default: 1024 } },
          { name: "height", in: "query", schema: { type: "integer", default: 768 } },
          { name: "time", in: "query", required: true, schema: { type: "string", description: "YYYY-MM-DD satellite swath date" } },
        ],
        responses: {
          "200": { description: "NASA GIBS image/jpeg or image/png texture with X-ETG-GIBS-Date header" },
          "400": { description: "Invalid GIBS query parameters" },
        },
      },
    },
    "/api/earth/solar-graph": {
      get: {
        tags: ["Denver Solar Climate Graph"],
        summary: "Evaluate Front Range NASA POWER + Open-Meteo solar irradiance & evening advection graph with 3-way forecasts",
        operationId: "getDenverSolarClimateGraph",
        parameters: [
          { name: "startYear", in: "query", schema: { type: "integer", minimum: 2015, maximum: 2023 } },
          { name: "endYear", in: "query", schema: { type: "integer" } },
          { name: "refresh", in: "query", schema: { type: "string", enum: ["0", "1", "true", "false"] } },
        ],
        responses: {
          "200": { description: "Front Range solar graph nodes, advection telemetry, and 3-way out-of-sample evaluation" },
        },
      },
    },
    "/api/graph/nodes/{nodeId}/webhook": {
      post: {
        tags: ["Hardware Webhooks"],
        summary: "Ingest live sensor, camera, or weather station telemetry",
        operationId: "ingestHardwareWebhook",
        parameters: [
          {
            name: "nodeId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Target ETG hardware Concept UUID (auto-created if new).",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  lat: { type: "number" },
                  lng: { type: "number" },
                  dataset: { type: "string" },
                  device_id: { type: "string" },
                  value: { type: "number" },
                  unit: { type: "string" },
                  observed_at: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Signal ingested and corroboration evaluated" },
        },
      },
    },
    "/api/graph/traverse": {
      get: {
        tags: ["Graph Traversal & Link Discovery"],
        summary: "Traverse k-hop upstream/downstream neighborhoods, weighted causal paths, or discover latent missing links",
        operationId: "traverseEtgSubgraphGet",
        parameters: [
          { name: "mode", in: "query", schema: { type: "string", enum: ["subgraph", "paths", "discover_links"] } },
          { name: "rootUuid", in: "query", schema: { type: "string" } },
          { name: "fromUuid", in: "query", schema: { type: "string" } },
          { name: "toUuid", in: "query", schema: { type: "string" } },
          { name: "anchorUuid", in: "query", schema: { type: "string" } },
          { name: "maxHops", in: "query", schema: { type: "integer" } },
          { name: "direction", in: "query", schema: { type: "string", enum: ["upstream", "downstream", "both"] } },
          { name: "edgeTypes", in: "query", schema: { type: "string", description: "Comma-separated relationship types" } },
          { name: "minWeight", in: "query", schema: { type: "number" } },
          { name: "minAbsR", in: "query", schema: { type: "number" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "includeSuperseded", in: "query", schema: { type: "boolean", default: true } },
        ],
        responses: {
          "200": { description: "Subgraph traversal, paths, or candidate link suggestions" },
          "400": { description: "Missing or invalid traversal arguments" },
        },
      },
      post: {
        tags: ["Graph Traversal & Link Discovery"],
        summary: "Traverse k-hop neighborhoods, causal paths, or latent link suggestions via JSON body",
        operationId: "traverseEtgSubgraphPost",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: ["subgraph", "paths", "discover_links"] },
                  rootUuid: { type: "string" },
                  fromUuid: { type: "string" },
                  toUuid: { type: "string" },
                  anchorUuid: { type: "string" },
                  maxHops: { type: "integer" },
                  direction: { type: "string", enum: ["upstream", "downstream", "both"] },
                  edgeTypes: { type: "array", items: { type: "string" } },
                  minWeight: { type: "number" },
                  minAbsR: { type: "number" },
                  limit: { type: "integer" },
                  includeSuperseded: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Subgraph traversal, paths, or candidate link suggestions" },
        },
      },
    },
    "/api/graph/predict": {
      get: {
        tags: ["Graph-Reading Predictor & ML Export"],
        summary: "Run live 3-way Graph-Aware forecast, inspect prospective ledger, or export PyG / etg-ml-v2 tensor bundle",
        operationId: "predictFromEtgGraphGet",
        parameters: [
          { name: "format", in: "query", schema: { type: "string", enum: ["prediction", "ml_export", "ml_export_v2", "ledger"] } },
          { name: "targetUuid", in: "query", schema: { type: "string" } },
          { name: "rootUuid", in: "query", schema: { type: "string" } },
          { name: "lat", in: "query", schema: { type: "number" } },
          { name: "lng", in: "query", schema: { type: "number" } },
          { name: "dataset", in: "query", schema: { type: "string" } },
          { name: "maxHops", in: "query", schema: { type: "integer" } },
          { name: "horizonSteps", in: "query", schema: { type: "integer" } },
          { name: "candidateNeighborUuid", in: "query", schema: { type: "string" } },
          { name: "bucket", in: "query", schema: { type: "string", enum: ["day", "month", "year"] } },
        ],
        responses: {
          "200": { description: "3-way forecast comparison, prospective ledger, or ML tensor export" },
        },
      },
      post: {
        tags: ["Graph-Reading Predictor & ML Export"],
        summary: "Run forecast, log/reconcile prospective verification ledger entries, or sync incremental L4 training bundle",
        operationId: "predictFromEtgGraphPost",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  format: { type: "string", enum: ["prediction", "ml_export", "ml_export_v2", "ledger"] },
                  action: { type: "string", enum: ["log_forecast", "reconcile_forecasts", "sync_l4_finetune"] },
                  targetUuid: { type: "string" },
                  rootUuid: { type: "string" },
                  lat: { type: "number" },
                  lng: { type: "number" },
                  dataset: { type: "string" },
                  persistRegionNode: { type: "boolean" },
                  maxHops: { type: "integer" },
                  horizonSteps: { type: "integer" },
                  candidateNeighborUuid: { type: "string" },
                  bucket: { type: "string", enum: ["day", "month", "year"] },
                  persistMetrics: { type: "boolean" },
                  logProspective: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Forecast result, logged/reconciled ledger summary, or L4 sync status" },
        },
      },
    },
    "/api/graph/microscope": {
      get: {
        tags: ["AI Trend Microscope"],
        summary:
          "Scan the ETG with the 3-in-1 AI Trend Microscope for early pre-Mann-Kendall trend inflections, directional lead-lag vs. confounder illusions, and secular vs. cycle/glitch de-aliasing.",
        operationId: "scanEtgTrendMicroscopeGet",
        parameters: [
          { name: "focusUuid", in: "query", schema: { type: "string" } },
          { name: "lat", in: "query", schema: { type: "number" } },
          { name: "lng", in: "query", schema: { type: "number" } },
          { name: "dataset", in: "query", schema: { type: "string" } },
          { name: "maxHops", in: "query", schema: { type: "integer" } },
          { name: "topK", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description:
              "Node and link perceptual cue cards plus compact aiPerceptionBrief",
          },
        },
      },
      post: {
        tags: ["AI Trend Microscope"],
        summary:
          "Execute an AI Trend Microscope scan via JSON request body for early inflections, verified couplings, and cycle/artifact de-aliasing.",
        operationId: "scanEtgTrendMicroscopePost",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  focusUuid: { type: "string" },
                  lat: { type: "number" },
                  lng: { type: "number" },
                  dataset: { type: "string" },
                  maxHops: { type: "integer" },
                  topK: { type: "integer" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Node and link perceptual cue cards plus compact aiPerceptionBrief",
          },
        },
      },
    },
  };

  for (const tool of ETG_MCP_TOOLS) {
    paths[`/api/mcp/messages?tool=${tool.name}`] = {
      post: {
        tags: ["ETG Tools"],
        summary: tool.description,
        operationId: tool.name,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema,
            },
          },
        },
        responses: {
          "200": { description: "Tool executed successfully" },
        },
      },
    };
  }

  return NextResponse.json(
    {
      openapi: "3.1.0",
      info: {
        title: "Earth Trend Detective (ETG) — Communal AI & Sensor API",
        version: "1.0.0",
        description:
          "OpenAPI 3.1.0 specification for querying, corroborating, and revising the communal Earth Trend Graph (ETG), streaming hardware webhooks, and running NASA POWER Mann-Kendall / Theil-Sen analyses.",
      },
      servers: [{ url: origin, description: "Earth Trend Detective Host" }],
      paths,
    },
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    }
  );
}
