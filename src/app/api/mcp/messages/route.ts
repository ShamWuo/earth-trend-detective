import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedMcpRequest } from "@/lib/mcp/auth";
import { executeEtgMcpTool, handleEtgMcpRpc } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Supports both JSON-RPC 2.0 MCP messages and direct OpenAPI REST tool invocation
 * via `?tool=<toolName>` (or plain arguments body when `tool` query param is set).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedMcpRequest(req)) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid ETG_API_KEY" },
      { status: 401 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const directTool = searchParams.get("tool");

  if (directTool && !("jsonrpc" in body)) {
    try {
      const result = await executeEtgMcpTool(directTool, body);
      return NextResponse.json({ tool: directTool, result }, { status: 200 });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Tool execution failed" },
        { status: 400 }
      );
    }
  }

  const { status, payload } = await handleEtgMcpRpc(body);
  return NextResponse.json(payload, { status });
}
