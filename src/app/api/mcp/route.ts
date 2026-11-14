import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedMcpRequest } from "@/lib/mcp/auth";
import { handleEtgMcpRpc } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const TRANSPORT_HEADERS: Record<string, string> = {
  "MCP-Protocol-Version": DEFAULT_PROTOCOL_VERSION,
  Allow: "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

export async function POST(req: NextRequest): Promise<Response> {
  if (!isAuthorizedMcpRequest(req)) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized: Invalid ETG_API_KEY" },
      },
      { status: 401, headers: TRANSPORT_HEADERS }
    );
  }

  const sessionId = req.headers.get("mcp-session-id") || crypto.randomUUID();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: TRANSPORT_HEADERS }
    );
  }

  const { status, payload } = await handleEtgMcpRpc(body);
  const headers = new Headers(TRANSPORT_HEADERS);
  headers.set("Mcp-Session-Id", sessionId);
  headers.set(
    "Access-Control-Expose-Headers",
    "MCP-Protocol-Version, Mcp-Session-Id"
  );

  const acceptHeader = req.headers.get("accept") || "";
  if (acceptHeader.includes("text/event-stream") && !acceptHeader.includes("application/json")) {
    const sseChunk = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache, no-transform");
    return new Response(new TextEncoder().encode(sseChunk), { status, headers });
  }

  return NextResponse.json(payload, { status, headers });
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!isAuthorizedMcpRequest(req)) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid ETG_API_KEY" },
      { status: 401, headers: TRANSPORT_HEADERS }
    );
  }

  const origin = new URL(req.url).origin;
  const sessionId = req.headers.get("mcp-session-id") || crypto.randomUUID();

  return NextResponse.json(
    {
      jsonrpc: "2.0",
      result: {
        status: "connected",
        transport: "streamable-http",
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        serverInfo: {
          name: "Earth Trend Detective ETG",
          version: "1.0.0",
          description: "Communal, AI-native Earth Trend Graph & NASA Telemetry MCP Server",
        },
        endpoint: `${origin}/api/mcp`,
        sse_endpoint: `${origin}/api/mcp/sse`,
        openapi_endpoint: `${origin}/api/mcp/openapi`,
      },
    },
    {
      status: 200,
      headers: {
        ...TRANSPORT_HEADERS,
        "Mcp-Session-Id": sessionId,
      },
    }
  );
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.headers.get("mcp-session-id");
  const headers = new Headers(TRANSPORT_HEADERS);
  if (sessionId) headers.set("Mcp-Session-Id", sessionId);
  return new NextResponse(null, { status: 204, headers });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...TRANSPORT_HEADERS,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id",
    },
  });
}
