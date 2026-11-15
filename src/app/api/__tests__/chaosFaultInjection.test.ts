import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as getTimeSeries } from "@/app/api/earth/timeseries/route";
import { POST as postEonet } from "@/app/api/earth/eonet/route";
import { POST as postOpenFeeds } from "@/app/api/earth/open-feeds/route";
import { GET as getGibs } from "@/app/api/earth/gibs/route";
import { GET as getSolarGraph } from "@/app/api/earth/solar-graph/route";
import { POST as postDiscover } from "@/app/api/earth/discover/route";

import { clearCurrentConditionsCache } from "@/lib/earth/currentConditionsClient";
import { clearOpenFeedsCache } from "@/lib/earth/openFeedsClient";
import { clearEonetCache } from "@/lib/nasa/eonetClient";
import { clearGistempAndCo2Caches } from "@/lib/nasa/gistempAndCo2Client";
import { clearNasaPowerSeriesCache } from "@/lib/nasa/nasaPowerClient";
import { clearDenverSolarCache } from "@/lib/solar/denverClimateGraph";

type ChaosFaultMode = "429" | "503_html" | "truncated_json" | "hang_timeout" | "mixed";

const HTML_503_BODY =
  "<!DOCTYPE html><html><head><title>503 Service Temporarily Unavailable</title></head><body><h1>503 Service Unavailable</h1></body></html>";

function makeAbortAwareHang(signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const abortWithErr = () => {
      const reason = signal?.reason;
      if (reason instanceof Error) {
        reject(reason);
      } else {
        const err = new Error("Aborted due to upstream timeout");
        err.name = "TimeoutError";
        reject(err);
      }
    };
    if (signal?.aborted) {
      abortWithErr();
      return;
    }
    signal?.addEventListener("abort", abortWithErr, { once: true });
  });
}

function classifyUrlToFault(url: string, mode: ChaosFaultMode): Exclude<ChaosFaultMode, "mixed"> {
  if (mode !== "mixed") return mode;
  if (url.includes("power.larc.nasa.gov")) return "429";
  if (url.includes("open-meteo.com")) return "503_html";
  if (url.includes("eonet.gsfc.nasa.gov")) return "truncated_json";
  if (url.includes("waterservices.usgs.gov") || url.includes("gml.noaa.gov") || url.includes("data.giss.nasa.gov") || url.includes("nsidc.org")) {
    return "hang_timeout";
  }
  if (url.includes("gibs.earthdata.nasa.gov")) return "503_html";
  return "hang_timeout";
}

function installChaosFetchMock(mode: ChaosFaultMode) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const fault = classifyUrlToFault(url, mode);

    if (fault === "429") {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      });
    }

    if (fault === "503_html") {
      return new Response(HTML_503_BODY, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (fault === "truncated_json") {
      const isTextTable =
        url.includes("waterservices.usgs.gov") ||
        url.includes("gml.noaa.gov") ||
        url.includes("ZonAnn.Ts+dSST.csv") ||
        url.includes("extent_v4.0.csv") ||
        url.includes("psl.noaa.gov");
      if (isTextTable) {
        return new Response("<!DOCTYPE html><html><body>Truncated Upstream HTML</body>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response('{"properties":{"parameter":{"T2M":{"202401":', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return makeAbortAwareHang(init?.signal);
  });
}

function clearAllTelemetryCaches() {
  clearNasaPowerSeriesCache();
  clearCurrentConditionsCache();
  clearOpenFeedsCache();
  clearEonetCache();
  clearGistempAndCo2Caches();
  clearDenverSolarCache();
}

const VALID_FAULT_KINDS = new Set([
  "rate_limited",
  "upstream_http_error",
  "malformed_payload",
  "timeout",
  "network_error",
  "unavailable",
]);

describe("Stage 5: Simultaneous Upstream Chaos Fault-Injection (< 2s SLA)", () => {
  beforeEach(() => {
    clearAllTelemetryCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAllTelemetryCaches();
  });

  it.each<ChaosFaultMode>(["429", "503_html", "truncated_json", "hang_timeout", "mixed"])(
    "settles ALL core Earth API routes cleanly under <%s> simultaneous chaos in < 2000ms with zero 500s or unhandled rejections",
    async (mode) => {
      const spy = installChaosFetchMock(mode);
      const unhandledRejections: unknown[] = [];
      const onRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onRejection);

      try {
        // Unique coordinates & dates per mode so GIBS & in-memory caches stay cold
        const offset =
          mode === "429" ? 1 : mode === "503_html" ? 2 : mode === "truncated_json" ? 3 : mode === "hang_timeout" ? 4 : 5;
        const lat = 39.74 + offset * 0.13;
        const lng = -104.99 + offset * 0.13;
        const gibsDate = `2024-02-0${offset}`;
        const gibsBbox = `${(-110 + offset).toFixed(1)},35.0,${(-100 + offset).toFixed(1)},42.0`;

        const timed = async <T>(fn: () => Promise<T>) => {
          const t0 = performance.now();
          const result = await fn();
          return { result, ms: performance.now() - t0 };
        };

        const [tsOut, eonetOut, camsOut, usgsOut, glofasOut, gibsOut, solarOut, discoverOut] =
          await Promise.all([
            timed(() =>
              getTimeSeries(
                new NextRequest(
                  `http://127.0.0.1:3230/api/earth/timeseries?lat=${lat.toFixed(2)}&lng=${lng.toFixed(2)}&datasets=nasa_power,wildfire`
                )
              )
            ),
            timed(() =>
              postEonet(
                new NextRequest("http://127.0.0.1:3230/api/earth/eonet", {
                  method: "POST",
                  body: JSON.stringify({ limit: 6 }),
                  headers: { "Content-Type": "application/json" },
                })
              )
            ),
            timed(() =>
              postOpenFeeds(
                new NextRequest("http://127.0.0.1:3230/api/earth/open-feeds", {
                  method: "POST",
                  body: JSON.stringify({ feed: "cams_pm25", lat, lng }),
                  headers: { "Content-Type": "application/json" },
                })
              )
            ),
            timed(() =>
              postOpenFeeds(
                new NextRequest("http://127.0.0.1:3230/api/earth/open-feeds", {
                  method: "POST",
                  body: JSON.stringify({ feed: "usgs_gauge", lat, lng }),
                  headers: { "Content-Type": "application/json" },
                })
              )
            ),
            timed(() =>
              postOpenFeeds(
                new NextRequest("http://127.0.0.1:3230/api/earth/open-feeds", {
                  method: "POST",
                  body: JSON.stringify({ feed: "glofas_discharge", lat, lng }),
                  headers: { "Content-Type": "application/json" },
                })
              )
            ),
            timed(() =>
              getGibs(
                new NextRequest(
                  `http://127.0.0.1:3230/api/earth/gibs?layer=true_color&bbox=${encodeURIComponent(gibsBbox)}&width=512&height=512&time=${gibsDate}`
                )
              )
            ),
            timed(() =>
              getSolarGraph(
                new NextRequest(
                  "http://127.0.0.1:3230/api/earth/solar-graph?startYear=2022&endYear=2025&refresh=1"
                )
              )
            ),
            timed(() =>
              postDiscover(
                new NextRequest("http://127.0.0.1:3230/api/earth/discover", {
                  method: "POST",
                  body: JSON.stringify({ maxEonetSites: 4 }),
                  headers: { "Content-Type": "application/json" },
                })
              )
            ),
          ]);

        // 1. Strict < 2000ms settlement SLA per route even under concurrent worst-case chaos
        for (const [label, entry] of [
          ["timeseries", tsOut],
          ["eonet", eonetOut],
          ["open-feeds(cams_pm25)", camsOut],
          ["open-feeds(usgs_gauge)", usgsOut],
          ["open-feeds(glofas_discharge)", glofasOut],
          ["gibs", gibsOut],
          ["solar-graph", solarOut],
          ["discover", discoverOut],
        ] as const) {
          expect(entry.ms, `${label} exceeded 2000ms (${entry.ms.toFixed(1)}ms)`).toBeLessThan(2000);
          expect(entry.result.status, `${label} returned 500`).not.toBe(500);
        }

        // 2. Verify structured error taxonomy & honest climatological fallback on /api/earth/timeseries
        expect(tsOut.result.status).toBe(200);
        const tsJson = (await tsOut.result.json()) as {
          provenanceMode?: string;
          failureKind?: string;
          upstreamFault?: { kind: string; source: string; httpStatus?: number };
          diagnostics?: {
            current?: { weatherFaultKind?: string; airQualityFaultKind?: string };
            datasets?: Array<{ dataset: string; status: string; faultKind?: string }>;
            faults?: Array<{ kind: string }>;
          };
          climatologicalFallback?: { provenanceMode?: string };
        };
        expect(tsJson.provenanceMode).toBe("climatological_fallback");
        expect(tsJson.failureKind).toBe("failed_to_fetch");
        expect(tsJson.climatologicalFallback?.provenanceMode).toBe("climatological_fallback");
        expect(tsJson.upstreamFault).toBeDefined();
        expect(VALID_FAULT_KINDS.has(tsJson.upstreamFault!.kind)).toBe(true);
        expect(
          VALID_FAULT_KINDS.has(tsJson.diagnostics?.current?.weatherFaultKind ?? "")
        ).toBe(true);

        // 3. Verify /api/earth/eonet degrades cleanly with provenance + upstreamFault
        expect(eonetOut.result.status).toBe(200);
        const eonetJson = (await eonetOut.result.json()) as {
          provenanceMode?: string;
          degraded?: boolean;
          upstreamFault?: { kind: string };
        };
        expect(eonetJson.provenanceMode).toBe("climatological_fallback");
        expect(eonetJson.degraded).toBe(true);
        expect(VALID_FAULT_KINDS.has(eonetJson.upstreamFault?.kind ?? "")).toBe(true);

        // 4. Verify /api/earth/open-feeds settles <2s across CAMS, USGS NWIS, and GloFAS
        for (const feedRes of [camsOut.result, usgsOut.result, glofasOut.result]) {
          expect(feedRes.status).toBe(200);
          const feedJson = (await feedRes.json()) as {
            status: string;
            provenanceMode?: string;
            upstreamFault?: { kind: string };
          };
          expect(feedJson.status).toBe("ingested");
          expect(feedJson.provenanceMode).toBe("climatological_fallback");
          expect(VALID_FAULT_KINDS.has(feedJson.upstreamFault?.kind ?? "")).toBe(true);
        }

        // 5. Verify /api/earth/gibs returns structured 502 error taxonomy cleanly in < 2s
        expect(gibsOut.result.status).toBe(502);
        const gibsJson = (await gibsOut.result.json()) as {
          error: string;
          provenanceMode?: string;
          failureKind?: string;
          upstreamFault?: { kind: string; source: string };
        };
        expect(gibsJson.provenanceMode).toBe("unavailable");
        expect(gibsJson.upstreamFault?.source).toContain("GIBS");
        expect(VALID_FAULT_KINDS.has(gibsJson.upstreamFault?.kind ?? "")).toBe(true);

        // 6. Verify /api/earth/solar-graph degrades cleanly with structured faults
        expect(solarOut.result.status).toBe(200);
        const solarJson = (await solarOut.result.json()) as {
          provenanceMode?: string;
          upstreamFault?: { kind: string };
        };
        expect(["cached", "climatological_fallback"]).toContain(solarJson.provenanceMode);
        if (solarJson.provenanceMode === "climatological_fallback") {
          expect(VALID_FAULT_KINDS.has(solarJson.upstreamFault?.kind ?? "")).toBe(true);
        }

        // 7. Verify /api/earth/discover returns 200 without crashing on 10x global probe chaos
        expect(discoverOut.result.status).toBe(200);
        const discoverJson = (await discoverOut.result.json()) as {
          provenanceMode?: string;
          snapshot?: { nodes?: unknown[] };
        };
        expect(["live", "cached", "climatological_fallback"]).toContain(
          discoverJson.provenanceMode
        );
        expect(Array.isArray(discoverJson.snapshot?.nodes)).toBe(true);

        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRejection);
        spy.mockRestore();
      }
    },
    10_000
  );

  it("distinguishes exact upstream fault taxonomy classes: rate_limited (429), upstream_http_error (503 HTML), malformed_payload, and timeout", async () => {
    const assertFaultKind = async (mode: ChaosFaultMode, expectedKind: string, offset: number) => {
      clearAllTelemetryCaches();
      const spy = installChaosFetchMock(mode);
      try {
        const res = await getTimeSeries(
          new NextRequest(
            `http://127.0.0.1:3230/api/earth/timeseries?lat=${(24 + offset).toFixed(2)}&lng=${(45 + offset).toFixed(2)}&datasets=nasa_power`
          )
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          provenanceMode?: string;
          diagnostics?: {
            current?: { weatherFaultKind?: string; weatherHttpStatus?: number };
            datasets?: Array<{ dataset: string; faultKind?: string; httpStatus?: number }>;
          };
        };
        expect(json.provenanceMode).toBe("climatological_fallback");
        const nasaDiag = json.diagnostics?.datasets?.find((d) => d.dataset === "nasa_power");
        expect(nasaDiag?.faultKind).toBe(expectedKind);
        expect(json.diagnostics?.current?.weatherFaultKind).toBe(expectedKind);
      } finally {
        spy.mockRestore();
      }
    };

    await assertFaultKind("429", "rate_limited", 1);
    await assertFaultKind("503_html", "upstream_http_error", 2);
    await assertFaultKind("truncated_json", "malformed_payload", 3);
    await assertFaultKind("hang_timeout", "timeout", 4);
  });

  it("transitions cleanly across honest provenance modes: live -> cached -> climatological_fallback", async () => {
    clearAllTelemetryCaches();
    // 1) Live NASA POWER + Open-Meteo response
    const mockYears: Record<string, number> = {};
    for (let y = 2005; y <= 2024; y++) {
      for (let m = 1; m <= 12; m++) {
        mockYears[`${y}${String(m).padStart(2, "0")}`] = 14.5 + (y - 2005) * 0.08 + Math.sin(m) * 3;
      }
    }
    const liveSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            current: { time: "2026-11-15T12:00", temperature_2m: 16.4, weather_code: 1 },
            daily: { temperature_2m_max: [19], temperature_2m_min: [11] },
          }),
          { status: 200 }
        );
      }
      if (url.includes("air-quality-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            current: { time: "2026-11-15T12:00", us_aqi: 29, pm2_5: 6.8, uv_index: 3.1 },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ properties: { parameter: { T2M: mockYears } } }),
        { status: 200 }
      );
    });

    const url = "http://127.0.0.1:3230/api/earth/timeseries?lat=41.25&lng=-73.15&datasets=nasa_power";
    const liveRes = await getTimeSeries(new NextRequest(url));
    const liveJson = (await liveRes.json()) as { provenanceMode?: string };
    expect(liveJson.provenanceMode).toBe("live");
    liveSpy.mockRestore();

    // 2) Cached response while upstream is simultaneously returning 503 HTML
    const cachedChaosSpy = installChaosFetchMock("503_html");
    const cachedRes = await getTimeSeries(new NextRequest(url));
    const cachedJson = (await cachedRes.json()) as { provenanceMode?: string };
    expect(cachedJson.provenanceMode).toBe("cached");

    // 3) Clear cache while upstream stays down -> climatological_fallback
    clearAllTelemetryCaches();
    const fallbackRes = await getTimeSeries(new NextRequest(url));
    const fallbackJson = (await fallbackRes.json()) as {
      provenanceMode?: string;
      upstreamFault?: { kind: string; httpStatus?: number };
    };
    expect(fallbackJson.provenanceMode).toBe("climatological_fallback");
    expect(fallbackJson.upstreamFault?.kind).toBe("upstream_http_error");
    expect(fallbackJson.upstreamFault?.httpStatus).toBe(503);
    cachedChaosSpy.mockRestore();
  });
});
