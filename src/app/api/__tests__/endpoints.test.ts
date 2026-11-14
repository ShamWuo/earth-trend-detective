import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import { GET as getGraph, POST as postGraph } from "@/app/api/graph/route";
import { GET as getGraphStream } from "@/app/api/graph/stream/route";
import { POST as postRevise } from "@/app/api/graph/revise/route";
import { POST as postWebhook } from "@/app/api/graph/nodes/[nodeId]/webhook/route";
import { POST as postDatasetImport } from "@/app/api/earth/dataset-import/route";
import { GET as getTimeSeries } from "@/app/api/earth/timeseries/route";
import { POST as postDetective } from "@/app/api/ai/detective/route";
import { POST as postMcp } from "@/app/api/mcp/route";

describe("Earth Trend Detective API & MCP Endpoints", () => {
  beforeEach(() => {
    getEtgStore().clearGraph(false);
  });

  it("GET /api/graph starts empty and POST /api/graph creates Earth Signal", async () => {
    const resEmpty = await getGraph(new NextRequest("http://localhost:3000/api/graph"));
    expect(resEmpty.status).toBe(200);
    const jsonEmpty = (await resEmpty.json()) as { nodes: unknown[] };
    expect(jsonEmpty.nodes.length).toBe(0);

    const resPost = await postGraph(
      new NextRequest("http://localhost:3000/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Signal",
          properties: {
            name: "Buoy Anomaly Test",
            description: "Verification signal",
            lat: 10.5,
            lng: -80.2,
            dataset: "ocean_temp",
            value: 1.9,
            unit: "°C",
          },
        }),
      })
    );
    expect(resPost.status).toBe(201);
  });

  it("POST /api/earth/dataset-import analyzes empirical CSV series and auto-wires opposite-trend edges", async () => {
    const csvRows = [
      "name,lat,lng,year,value,unit,dataset",
      ...Array.from({ length: 12 }, (_, i) => `Station North,68.2,15.4,${2014 + i},${(1.0 + i * 0.25).toFixed(2)},°C,ocean_temp`),
      ...Array.from({ length: 12 }, (_, i) => `Station South,-68.2,-120.4,${2014 + i},${(2.8 - i * 0.22).toFixed(2)},°C,ocean_temp`),
    ].join("\n");

    const importRes = await postDatasetImport(
      new NextRequest("http://localhost:3000/api/earth/dataset-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "csv",
          sourceName: "Polar Comparison Test",
          content: csvRows,
        }),
      })
    );
    expect(importRes.status).toBe(201);
    const importJson = (await importRes.json()) as {
      connectionsWired: number;
      snapshot: {
        oppositeTrendPairs: Array<{ correlationR?: number }>;
        nodes: Array<{ uuid: string }>;
      };
    };
    expect(importJson.connectionsWired).toBeGreaterThanOrEqual(1);
    expect(importJson.snapshot.oppositeTrendPairs.length).toBeGreaterThanOrEqual(1);

    const firstInsight = importJson.snapshot.nodes.find((n) => n.uuid.startsWith("insight-"));
    expect(firstInsight).toBeDefined();

    // GET /api/earth/timeseries evaluates embedded empirical node series without network
    const tsRes = await getTimeSeries(
      new NextRequest(
        `http://localhost:3000/api/earth/timeseries?node_uuid=${encodeURIComponent(firstInsight!.uuid)}`
      )
    );
    expect(tsRes.status).toBe(200);
    const tsData = (await tsRes.json()) as {
      primary: { mannKendall: { significant: boolean; pValue: number }; theilSen: { slope: number } };
    };
    expect(tsData.primary.mannKendall.significant).toBe(true);
    expect(tsData.primary.mannKendall.pValue).toBeLessThan(0.05);
  });

  it("POST /api/graph/revise and POST webhook execute full scientific lifecycle", async () => {
    const insight = getEtgStore().createNode({
      label: "Insight",
      is_provisional: false,
      properties: {
        name: "Boreal Wildfire Assessment",
        description: "Baseline fire regime",
        lat: 57.2,
        lng: -115.4,
        dataset: "wildfire",
      },
    });

    const reviseRes = await postRevise(
      new NextRequest("http://localhost:3000/api/graph/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorNodeUuid: insight.uuid,
          newName: "Boreal Vapor-Pressure Escalation",
          newDescription: "Revised thermal escalation mechanism.",
          rationale: "Verified with airborne fuel moisture anomaly.",
        }),
      })
    );
    expect(reviseRes.status).toBe(201);
    const reviseJson = (await reviseRes.json()) as {
      priorNode: { properties: { status: string } };
      supersedesEdge: { type: string };
    };
    expect(reviseJson.priorNode.properties.status).toBe("Superseded");
    expect(reviseJson.supersedesEdge.type).toBe("supersedes");

    const webhookRes = await postWebhook(
      new NextRequest(
        "http://localhost:3000/api/graph/nodes/esp32-ridge-09/webhook?value_path=pm25&dataset=air_quality",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pm25: 88.4, lat: 57.3, lng: -115.3 }),
        }
      ),
      { params: Promise.resolve({ nodeId: "esp32-ridge-09" }) }
    );
    expect(webhookRes.status).toBe(201);
  });

  it("POST /api/ai/detective synthesizes grounded scientific briefing on empirical node", async () => {
    const csvRows = [
      "name,lat,lng,year,value,unit,dataset",
      ...Array.from({ length: 10 }, (_, i) => `Tropical Buoy,1.5,-140.0,${2015 + i},${(25.2 + i * 0.18).toFixed(2)},°C,ocean_temp`),
    ].join("\n");

    const importRes = await postDatasetImport(
      new NextRequest("http://localhost:3000/api/earth/dataset-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "csv", content: csvRows }),
      })
    );
    const importJson = (await importRes.json()) as { importedNodes: Array<{ uuid: string }> };

    const res = await postDetective(
      new NextRequest("http://localhost:3000/api/ai/detective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedNodeUuid: importJson.importedNodes[0].uuid,
          question: "Summarize significance and provenance.",
        }),
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { briefing: string; engine: string };
    expect(json.briefing.length).toBeGreaterThan(40);
  });

  it("POST /api/mcp lists etg_discover_global_trends and executes JSON-RPC tools", async () => {
    const listRes = await postMcp(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      })
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = listJson.result.tools.map((t) => t.name);
    expect(names).toContain("etg_discover_global_trends");
    expect(names).toContain("etg_query_graph");
    expect(names).toContain("etg_analyze_timeseries");

    const callRes = await postMcp(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "etg_query_graph",
            arguments: { only_opposite_trends: true },
          },
        }),
      })
    );
    expect(callRes.status).toBe(200);
    const callJson = (await callRes.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(callJson.result.isError).toBeFalsy();
    expect(callJson.result.content[0].text).toContain("oppositeTrendPairs");
  });

  it("GET /api/graph/stream broadcasts live graph_updated SSE events when mutations occur", async () => {
    const controller = new AbortController();
    const res = await getGraphStream(
      new NextRequest("http://localhost:3000/api/graph/stream", {
        signal: controller.signal,
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read initial connected comment
    const initial = await reader.read();
    expect(decoder.decode(initial.value)).toContain("etg-live-stream connected");

    // Trigger a live webhook mutation
    await postWebhook(
      new NextRequest("http://localhost:3000/api/graph/nodes/live-stream-buoy/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 27.4, unit: "°C", lat: 14.2, lng: -61.1 }),
      }),
      { params: Promise.resolve({ nodeId: "live-stream-buoy" }) }
    );

    const updateChunk = await reader.read();
    const text = decoder.decode(updateChunk.value);
    expect(text).toContain("event: graph_updated");
    expect(text).toContain("live-stream-buoy");

    controller.abort();
    await reader.cancel();
  });

  it("MCP etg_ingest_signal updates an existing event via event_uuid and auto-connects nearby nodes", async () => {
    const insight = getEtgStore().createNode({
      label: "Insight",
      is_provisional: true,
      properties: {
        name: "Andes Glacier Melt",
        description: "Baseline elevation warming",
        lat: -13.5,
        lng: -71.9,
        dataset: "hydrology",
        producer_type: "nasa_satellite",
        source_system: "NASA SWOT",
      },
    });

    const initialCall = await postMcp(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "etg_ingest_signal",
            arguments: {
              name: "Andes Field Station",
              description: "Initial station observation",
              lat: -13.55,
              lng: -71.95,
              dataset: "hydrology",
              value: 4.2,
              unit: "°C",
              observed_at: "2025-06-01",
            },
          },
        }),
      })
    );
    expect(initialCall.status).toBe(200);
    const initialJson = (await initialCall.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const parsedInitial = JSON.parse(initialJson.result.content[0].text) as {
      signal: { uuid: string };
      autoConnections: { linkedInsights: Array<{ uuid: string }> };
    };
    expect(parsedInitial.autoConnections.linkedInsights.map((n) => n.uuid)).toContain(insight.uuid);

    // Update that exact event_uuid via MCP
    const updateCall = await postMcp(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "etg_ingest_signal",
            arguments: {
              event_uuid: parsedInitial.signal.uuid,
              name: "Andes Field Station (Updated)",
              description: "Follow-up field reading",
              lat: -13.55,
              lng: -71.95,
              dataset: "hydrology",
              value: 4.8,
              unit: "°C",
              observed_at: "2025-07-01",
            },
          },
        }),
      })
    );
    expect(updateCall.status).toBe(200);
    const updateJson = (await updateCall.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const parsedUpdate = JSON.parse(updateJson.result.content[0].text) as {
      signal: { uuid: string; properties: { value: number; series_count: number } };
    };
    expect(parsedUpdate.signal.uuid).toBe(parsedInitial.signal.uuid);
    expect(parsedUpdate.signal.properties.value).toBe(4.8);
    expect(parsedUpdate.signal.properties.series_count).toBe(2);
  });
});
