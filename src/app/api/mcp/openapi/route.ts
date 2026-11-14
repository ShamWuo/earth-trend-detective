import { NextRequest, NextResponse } from "next/server";
import { ETG_MCP_TOOLS } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;

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
