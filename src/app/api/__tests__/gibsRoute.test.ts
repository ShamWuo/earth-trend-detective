import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getGibsTile } from "@/app/api/earth/gibs/route";

describe("GET /api/earth/gibs proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when parameters are missing or invalid", async () => {
    const badLayer = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=invalid&bbox=-10,20,10,40&width=512&height=512&time=2025-07-15"
      )
    );
    expect(badLayer.status).toBe(400);

    const badBbox = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=true_color&bbox=20,40,10,20&width=512&height=512&time=2025-07-15"
      )
    );
    expect(badBbox.status).toBe(400);

    const badTime = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=true_color&bbox=-10,20,10,40&width=512&height=512&time=not-a-date"
      )
    );
    expect(badTime.status).toBe(400);
  });

  it("passes through valid upstream JPEG tiles and caches them", async () => {
    const validBytes = new Uint8Array(4096).fill(0xff);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(validBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );

    const reqUrl =
      "http://localhost:3000/api/earth/gibs?layer=true_color&bbox=-110,30,-90,45&width=512&height=512&time=2025-08-01";
    const res1 = await getGibsTile(new NextRequest(reqUrl));
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe("image/jpeg");
    expect(res1.headers.get("x-etg-gibs-date")).toBe("2025-08-01");
    expect((await res1.arrayBuffer()).byteLength).toBe(4096);

    const res2 = await getGibsTile(new NextRequest(reqUrl));
    expect(res2.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to archive 2025-07-15 when primary date returns a blank <2400B tile", async () => {
    const blankStub = new Uint8Array(1436).fill(0x00);
    const richTile = new Uint8Array(8192).fill(0xab);

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(blankStub, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        })
      )
      .mockResolvedValueOnce(
        new Response(richTile, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        })
      );

    const res = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=night_viirs&bbox=-120,25,-100,40&width=512&height=512&time=2026-11-11"
      )
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-etg-gibs-date")).toBe("2025-07-15");
    expect((await res.arrayBuffer()).byteLength).toBe(8192);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns 502 when both primary and fallback upstream requests fail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Upstream down", { status: 503 })
    );

    const res = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=thermal&bbox=-80,10,-60,30&width=512&height=512&time=2025-09-01"
      )
    );
    expect(res.status).toBe(502);
  });

  it("supports scope=global transparent PNG layers such as sst_anomaly and borders", async () => {
    const pngBytes = new Uint8Array(4096).fill(0x89);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );

    const sstRes = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=sst_anomaly&scope=global&bbox=-180,-90,180,90&width=2048&height=1024&time=2026-11-10"
      )
    );
    expect(sstRes.status).toBe(200);
    expect(sstRes.headers.get("content-type")).toBe("image/png");
    const sstUpstreamUrl = String(spy.mock.calls[0]?.[0] ?? "");
    expect(sstUpstreamUrl).toContain("FORMAT=image/png");
    expect(sstUpstreamUrl).toContain("TRANSPARENT=TRUE");

    const bordersRes = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=borders&scope=global&bbox=-180,-90,180,90&width=2048&height=1024&time=2025-07-15"
      )
    );
    expect(bordersRes.status).toBe(200);
    expect(bordersRes.headers.get("content-type")).toBe("image/png");
    const bordersUpstreamUrl = String(spy.mock.calls[1]?.[0] ?? "");
    expect(bordersUpstreamUrl).toContain("Coastlines,Reference_Features");
    expect(bordersUpstreamUrl).toContain("FORMAT=image/png");
    expect(bordersUpstreamUrl).toContain("TRANSPARENT=TRUE");

    const historicalSstRes = await getGibsTile(
      new NextRequest(
        "http://localhost:3000/api/earth/gibs?layer=sst_anomaly&scope=global&bbox=-180,-90,180,90&width=2048&height=1024&time=2015-12-15"
      )
    );
    expect(historicalSstRes.status).toBe(200);
    const historicalSstUrl = String(spy.mock.calls[2]?.[0] ?? "");
    expect(historicalSstUrl).toContain(
      "LAYERS=GHRSST_L4_MUR25_Sea_Surface_Temperature_Anomalies"
    );
  });
});
