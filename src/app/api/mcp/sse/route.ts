import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import { isAuthorizedMcpRequest } from "@/lib/mcp/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  if (!isAuthorizedMcpRequest(req)) {
    return new Response("Unauthorized: Invalid ETG_API_KEY", { status: 401 });
  }

  const origin = new URL(req.url).origin;
  const sessionId = crypto.randomUUID();
  const messagesEndpoint = `${origin}/api/mcp/messages?session_id=${sessionId}`;
  const encoder = new TextEncoder();
  const store = getEtgStore();

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${messagesEndpoint}\n\n`));
      controller.enqueue(encoder.encode(`: etg-mcp-session ${sessionId}\n\n`));

      unsubscribe = store.subscribe((ev) => {
        try {
          const notification = {
            jsonrpc: "2.0",
            method: "notifications/etg/graph_updated",
            params: ev,
          };
          controller.enqueue(
            encoder.encode(`event: message\ndata: ${JSON.stringify(notification)}\n\n`)
          );
        } catch {
          // Stream closed
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Mcp-Session-Id": sessionId,
    },
  });
}
