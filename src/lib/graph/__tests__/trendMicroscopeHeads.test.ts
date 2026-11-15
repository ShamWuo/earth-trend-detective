import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  extractNodeMicroscopeFeatures,
  extractPairMicroscopeFeatures,
  scanTrendMicroscope,
} from "@/lib/graph/trendMicroscope";
import { executeEtgMcpTool } from "@/lib/mcp/tools";
import {
  GET as microscopeGET,
  POST as microscopePOST,
} from "@/app/api/graph/microscope/route";
import { POST as detectivePOST } from "@/app/api/ai/detective/route";
import type { TimeSeriesPoint, TrendMicroscopeScanResult } from "@/types/etg";

function seededRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gauss(rng: () => number, sigma = 1): number {
  const u1 = Math.max(1e-7, rng());
  const u2 = rng();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function toMonthlyPoints(vals: number[], startYear = 2020): TimeSeriesPoint[] {
  return vals.map((v, i) => {
    const year = startYear + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, "0");
    return {
      date: `${year}-${month}-01`,
      t: Number((year + (i % 12) / 12).toFixed(4)),
      value: Number(v.toFixed(4)),
    };
  });
}

describe("ETG Trend Microscope — 3-in-1 Perceptual Heads, MCP & API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    getEtgStore().clearGraph(false);
  });

  it("extracts exact 20-dim node and 12-dim pair features with strict pre-t causal invariance", () => {
    const base = Array.from(
      { length: 36 },
      (_, k) => Math.sin((2 * Math.PI * k) / 12) + 0.04 * k
    );
    const peer = Array.from(
      { length: 36 },
      (_, k) => Math.cos((2 * Math.PI * k) / 12) - 0.02 * k
    );

    const fPrefix = extractNodeMicroscopeFeatures(base.slice(0, 24), {
      scale: "month",
      lat: 40,
      lng: -105,
      fullLen: 24,
    });
    const fMutatedFuture = extractNodeMicroscopeFeatures(
      [...base.slice(0, 24), 9999, -9999].slice(0, 24),
      {
        scale: "month",
        lat: 40,
        lng: -105,
        fullLen: 24,
      }
    );

    expect(fPrefix).toHaveLength(20);
    expect(fMutatedFuture).toEqual(fPrefix);

    const fPair = extractPairMicroscopeFeatures(base.slice(0, 24), peer.slice(0, 24), {
      uLat: 40,
      uLng: -105,
      vLat: -33,
      vLng: -70,
      scale: "month",
    });
    expect(fPair).toHaveLength(12);
  });

  it("detects pre-MK early onset, rejects seasonal illusions, verifies lagged opposite dipole, de-aliases cycles, and gates noisy community sensors", async () => {
    const store = getEtgStore();
    store.clearGraph(false);
    const rng = seededRng(123);
    const T = 60;

    // 1. NH & SH opposite-hemisphere seasonal illusion pair (zero coupled anomaly)
    const nh = Array.from(
      { length: T },
      (_, t) => 2.5 * Math.sin((2 * Math.PI * t) / 12) + 0.12 * gauss(rng, 1)
    );
    const sh = Array.from(
      { length: T },
      (_, t) => -2.5 * Math.sin((2 * Math.PI * t) / 12) + 0.12 * gauss(rng, 1)
    );

    // 2. Stochastic ENSO driver -> lag-2 drives_opposite Basin responder
    const drvInnov = Array.from({ length: T }, () => gauss(rng, 0.55));
    for (let t = 1; t < T; t++) {
      drvInnov[t] = 0.55 * drvInnov[t - 1] + gauss(rng, 0.45);
    }
    const enso = Array.from(
      { length: T },
      (_, t) => 0.35 * Math.sin((2 * Math.PI * t) / 12) + drvInnov[t]
    );
    const basin = Array.from(
      { length: T },
      (_, t) =>
        0.35 * Math.sin((2 * Math.PI * t) / 12 + 1.1) -
        1.25 * drvInnov[Math.max(0, t - 2)] +
        gauss(rng, 0.22)
    );

    // 3. Fresh pre-Mann-Kendall break over last 4 steps
    const freshBreak = Array.from(
      { length: T },
      (_, t) =>
        0.45 * Math.sin((2 * Math.PI * t) / 12 + 0.5) +
        0.18 * Math.cos(t * 1.7) +
        (t >= T - 5 ? 0.6 * (t - (T - 5) + 1) : 0)
    );

    // 4. Multi-year 30-month oscillation cycle (false-trend cycle aliasing)
    const cycle = Array.from(
      { length: T },
      (_, t) => 2.2 * Math.sin((2 * Math.PI * t) / 30 + 3.4) + 0.12 * Math.cos(t * 2.1)
    );

    // 5. Uncorroborated noisy DIY community sensor with step jump glitch
    const glitch = Array.from(
      { length: T },
      (_, t) => gauss(rng, 0.2) + (t >= T - 4 ? 2.9 : 0)
    );

    const addNode = (
      name: string,
      vals: number[],
      opts: {
        lat: number;
        lng: number;
        corroborated: boolean;
        confidence: number;
        authoredBy?: "satellite_pipeline" | "iot_sensor" | "human";
        isCommunity?: boolean;
      }
    ) =>
      store.createNode({
        label: "Signal",
        properties: {
          name,
          description: `${name} series`,
          phenomenon_type: opts.isCommunity ? "sensor_station" : "climate_trend",
          lat: opts.lat,
          lng: opts.lng,
          dataset: opts.isCommunity ? "community" : "nasa_power",
          source_system: opts.isCommunity ? "Community IoT" : "NASA MERRA-2",
          corroborated: opts.corroborated,
          confidence: opts.confidence,
          trust_score: opts.confidence,
          authored_by:
            opts.authoredBy ?? (opts.isCommunity ? "iot_sensor" : "satellite_pipeline"),
          producer_type: opts.isCommunity ? "iot_sensor" : "nasa_satellite",
          observed_at: "2024-12-01T00:00:00Z",
          series: toMonthlyPoints(vals),
        },
      });

    const nNh = addNode("NH Seasonal Grid", nh, {
      lat: 52,
      lng: 10,
      corroborated: true,
      confidence: 0.9,
    });
    const nSh = addNode("SH Seasonal Grid", sh, {
      lat: -42,
      lng: -65,
      corroborated: true,
      confidence: 0.9,
    });
    const nEnso = addNode("Equatorial ENSO Mode", enso, {
      lat: 0,
      lng: -140,
      corroborated: true,
      confidence: 0.95,
    });
    const nBasin = addNode("Opposite Teleconnected Basin", basin, {
      lat: 38,
      lng: -110,
      corroborated: true,
      confidence: 0.9,
    });
    const nFresh = addNode("Fresh Break Sentinel", freshBreak, {
      lat: 44,
      lng: -90,
      corroborated: true,
      confidence: 0.92,
    });
    const nCycle = addNode("Decadal Cycle Node", cycle, {
      lat: 20,
      lng: -30,
      corroborated: true,
      confidence: 0.9,
    });
    const nGlitch = addNode("Noisy DIY Sensor", glitch, {
      lat: 35,
      lng: 5,
      corroborated: false,
      confidence: 0.14,
      authoredBy: "iot_sensor",
      isCommunity: true,
    });

    const scan = scanTrendMicroscope(store, { topK: 16 });
    expect(scan.schemaVersion).toBe("etg-trend-microscope-v1");
    expect(scan.nodeCount).toBe(7);

    const byId = new Map(scan.nodes.map((c) => [c.uuid, c]));

    // Early pre-MK onset on fresh break
    const freshCue = byId.get(nFresh.uuid)!;
    expect(freshCue.mkAbsZ).toBeLessThan(1.96);
    expect(freshCue.onsetProb).toBeGreaterThanOrEqual(0.55);
    expect(freshCue.preMannKendallAlert).toBe(true);
    expect(freshCue.radarBadge).toBe("EARLY_ONSET");

    // Cycle aliasing detection
    const cycCue = byId.get(nCycle.uuid)!;
    expect(cycCue.dealiasing.oscillationShare).toBeGreaterThan(0.45);
    expect(cycCue.dealiasing.falseTrendProb).toBeGreaterThan(0.5);

    // Trust gate downweighting for uncorroborated DIY glitch
    const glitchCue = byId.get(nGlitch.uuid)!;
    expect(glitchCue.trustGate).toBeLessThan(0.12);
    expect(glitchCue.dealiasing.falseTrendProb).toBeGreaterThan(0.5);

    // Seasonal illusion suppression vs. true lagged opposite dipole
    const nhShIllusion = scan.suppressedIllusions.find(
      (l) => l.sourceUuid === nNh.uuid && l.targetUuid === nSh.uuid
    );
    expect(nhShIllusion).toBeDefined();
    expect(Math.abs(nhShIllusion!.rawPeakR)).toBeGreaterThan(0.8);
    expect(nhShIllusion!.confounderProb).toBeGreaterThan(0.6);

    const ensoBasin = scan.verifiedCouplings.find(
      (l) => l.sourceUuid === nEnso.uuid && l.targetUuid === nBasin.uuid
    );
    expect(ensoBasin).toBeDefined();
    expect(ensoBasin!.polarity).toBe("drives_opposite");
    expect(ensoBasin!.optimalLagSteps).toBeGreaterThanOrEqual(1);

    // MCP tool execution (compact_brief_only + full)
    const mcpBrief = (await executeEtgMcpTool("etg_scan_trend_microscope", {
      compact_brief_only: true,
    })) as { schemaVersion: string; nodeCount: number; aiPerceptionBrief: string };
    expect(mcpBrief.schemaVersion).toBe("etg-trend-microscope-v1");
    expect(mcpBrief.nodeCount).toBe(7);
    expect(mcpBrief.aiPerceptionBrief).toContain("ETG Trend Microscope");

    const mcpFull = (await executeEtgMcpTool("etg_scan_trend_microscope", {
      focus_uuid: nFresh.uuid,
      top_k: 6,
    })) as TrendMicroscopeScanResult;
    expect(mcpFull.nodes.length).toBe(7);

    // REST GET & POST /api/graph/microscope
    const getRes = await microscopeGET(
      new NextRequest("http://localhost:3000/api/graph/microscope?topK=6")
    );
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as TrendMicroscopeScanResult;
    expect(getJson.nodeCount).toBe(7);

    const postRes = await microscopePOST(
      new NextRequest("http://localhost:3000/api/graph/microscope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focusUuid: nEnso.uuid, topK: 5 }),
      })
    );
    expect(postRes.status).toBe(200);
    const postJson = (await postRes.json()) as TrendMicroscopeScanResult;
    expect(postJson.verifiedCouplings.length).toBeGreaterThanOrEqual(1);

    // AI Detective deterministic briefing carries microscopeSummary
    const detRes = await detectivePOST(
      new NextRequest("http://localhost:3000/api/ai/detective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedNodeUuid: nFresh.uuid,
          question: "Which signals are emerging trends vs seasonal illusions or cycles?",
        }),
      })
    );
    expect(detRes.status).toBe(200);
    const detJson = (await detRes.json()) as {
      briefing: string;
      microscopeSummary?: {
        nodeCount: number;
        verifiedCouplingsCount: number;
        suppressedIllusionsCount: number;
        brief: string;
      };
    };
    expect(detJson.microscopeSummary).toBeDefined();
    expect(detJson.microscopeSummary!.nodeCount).toBe(7);
    expect(detJson.briefing).toContain("AI Trend Microscope");
  });
});
