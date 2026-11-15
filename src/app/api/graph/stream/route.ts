import { NextRequest } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<Response> {
  const encoder = new TextEncoder();
  const store = getEtgStore();

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: 5000\n: etg-live-stream connected\n\n`));

      unsubscribe = store.subscribe((ev) => {
        try {
          controller.enqueue(
            encoder.encode(`event: graph_updated\ndata: ${JSON.stringify(ev)}\n\n`)
          );
        } catch {
          cleanup();
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Ignore already closed stream
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
