import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  buildClimatologicalSeriesPoints,
  createBoundedSignal,
  normalizeEarthCoordinates,
  wrapLongitude,
} from "@/lib/earth/coordinates";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import {
  buildClimatologicalTrendSummary,
  clearNasaPowerSeriesCache,
  fetchEarthTimeSeries,
  fetchRegionalMultiScaleSeries,
} from "@/lib/nasa/nasaPowerClient";
import {
  clearCurrentConditionsCache,
  fetchCurrentEarthConditionsDetailed,
} from "@/lib/earth/currentConditionsClient";
import {
  buildOpenFeedClimatologicalFallback,
  clearOpenFeedsCache,
} from "@/lib/earth/openFeedsClient";
import { clearEonetCache, fetchLiveEonetSignals } from "@/lib/nasa/eonetClient";
import {
  clearGistempAndCo2Caches,
  fetchNasaGistempZonalSeriesWithFallback,
  fetchNoaaGlobalCo2SeriesWithFallback,
  fetchNsidcArcticSeaIceSeriesWithFallback,
} from "@/lib/nasa/gistempAndCo2Client";
import { clearDenverSolarCache } from "@/lib/solar/denverClimateGraph";
import { discoverGlobalEarthTrends } from "@/lib/discovery/globalTrendPipeline";
import { GET as getTimeSeriesRoute } from "@/app/api/earth/timeseries/route";
import { POST as postOpenFeedsRoute } from "@/app/api/earth/open-feeds/route";
import { POST as postEonetRoute } from "@/app/api/earth/eonet/route";
import { GET as getSolarGraphRoute } from "@/app/api/earth/solar-graph/route";
import {
  attachDialogLightDismissFallback,
  isPointOutsideRect,
} from "@/lib/a11y/dialogLightDismiss";

function makePowerMonthlyPayload(base = 285, slope = 0.08): Record<string, Record<string, number>> {
  const t2m: Record<string, number> = {};
  const t2mMax: Record<string, number> = {};
  const rh2m: Record<string, number> = {};
  const ts: Record<string, number> = {};
  const prectot: Record<string, number> = {};
  const allsky: Record<string, number> = {};
  const ws10m: Record<string, number> = {};
  const wd10m: Record<string, number> = {};

  for (let y = 2005; y <= 2025; y++) {
    let sum = 0;
    for (let m = 1; m <= 12; m++) {
      const key = `${y}${String(m).padStart(2, "0")}`;
      const val = Number((base + (y - 2005) * slope + Math.sin(m / 2) * 3).toFixed(2));
      t2m[key] = val;
      t2mMax[key] = Number((val + 4).toFixed(2));
      rh2m[key] = 52;
      ts[key] = Number((val + 1.1).toFixed(2));
      prectot[key] = 2.4;
      allsky[key] = 4.5;
      ws10m[key] = 3.8;
      wd10m[key] = 260;
      sum += val;
    }
    const annKey = `${y}13`;
    t2m[annKey] = Number((sum / 12).toFixed(2));
    t2mMax[annKey] = Number((sum / 12 + 4).toFixed(2));
    rh2m[annKey] = 52;
    ts[annKey] = Number((sum / 12 + 1.1).toFixed(2));
    prectot[annKey] = 2.4;
    allsky[annKey] = 4.5;
    ws10m[annKey] = 3.8;
    wd10m[annKey] = 260;
  }

  return {
    T2M: t2m,
    T2M_MAX: t2mMax,
    RH2M: rh2m,
    TS: ts,
    PRECTOTCORR: prectot,
    ALLSKY_SFC_SW_DWN: allsky,
    WS10M: ws10m,
    WD10M: wd10m,
  };
}

describe("Stage 5: Agency Resilience, Boundary Coordinates & Dialog UX", () => {
  beforeEach(() => {
    getEtgStore().clearGraph(false);
    clearNasaPowerSeriesCache();
    clearCurrentConditionsCache();
    clearOpenFeedsCache();
    clearEonetCache();
    clearGistempAndCo2Caches();
    clearDenverSolarCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("Coordinate Normalization & Statistical Engine Edge-Cases", () => {
    it("wraps longitudes across antimeridian and clamps poles & invalid inputs safely", () => {
      expect(wrapLongitude(180)).toBe(180);
      expect(wrapLongitude(-180)).toBe(-180);
      expect(wrapLongitude(185)).toBe(-175);
      expect(wrapLongitude(-185)).toBe(175);
      expect(wrapLongitude(540)).toBe(-180);
      expect(wrapLongitude(-0)).toBe(0);
      expect(wrapLongitude(Number.NaN)).toBe(0);

      const northPole = normalizeEarthCoordinates(90, 180);
      expect(northPole.lat).toBe(90);
      expect(northPole.lng).toBe(180);
      expect(northPole.apiLat).toBe(89.5);
      expect(northPole.apiLng).toBe(179.5);
      expect(northPole.isPolar).toBe(true);
      expect(northPole.isAntimeridian).toBe(true);
      expect(northPole.isValidInput).toBe(true);

      const wrappedOver = normalizeEarthCoordinates(-102, 195);
      expect(wrappedOver.lat).toBe(-90);
      expect(wrappedOver.lng).toBe(-165);
      expect(wrappedOver.wasAdjusted).toBe(true);

      const invalid = normalizeEarthCoordinates(Number.NaN, Number.POSITIVE_INFINITY);
      expect(invalid.isValidInput).toBe(false);
      expect(invalid.lat).toBe(0);
      expect(invalid.lng).toBe(0);
    });

    it("handles empty, single-point, two-point, NaN-polluted, and constant time-series without crashing", () => {
      const common = {
        lat: 90,
        lng: 185,
        dataset: "nasa_power" as const,
        parameter: "T2M",
        unit: "°C",
        slopeUnit: "°C/yr",
        provenance: "NASA POWER MERRA-2 (Live)" as const,
        alpha: 99, // invalid alpha clamped safely
      };

      const empty = analyzeTimeSeries([], common);
      expect(empty.lat).toBe(90);
      expect(empty.lng).toBe(-175);
      expect(empty.points).toHaveLength(0);
      expect(empty.mannKendall.direction).toBe("no_trend");
      expect(empty.mannKendall.pValue).toBe(1);

      const single = analyzeTimeSeries([{ date: "2020", t: 2020, value: 12.5 }], common);
      expect(single.points).toHaveLength(1);
      expect(single.theilSen.slope).toBe(0);
      expect(single.mannKendall.pValue).toBe(1);

      const twoPts = analyzeTimeSeries(
        [
          { date: "2020", t: 2020, value: 10 },
          { date: "2021", t: 2021, value: 11 },
        ],
        common
      );
      expect(twoPts.points).toHaveLength(2);
      expect(Number.isFinite(twoPts.theilSen.slope)).toBe(true);

      const constant = analyzeTimeSeries(
        Array.from({ length: 12 }, (_, idx) => ({
          date: `${2010 + idx}`,
          t: 2010 + idx,
          value: 4.25,
        })),
        common
      );
      expect(constant.theilSen.slope).toBe(0);
      expect(constant.mannKendall.direction).toBe("no_trend");
      expect(constant.mannKendall.pValue).toBe(1);

      const withNan = analyzeTimeSeries(
        [
          { date: "2019", t: Number.NaN, value: 1 },
          { date: "2020", t: 2020, value: Number.POSITIVE_INFINITY },
          { date: "2021", t: 2021, value: 2 },
          { date: "2022", t: 2022, value: 3 },
        ],
        common
      );
      expect(withNan.points).toHaveLength(2);

      const comp = compareRegionalSeries(
        [
          { date: "2020", t: Number.NaN, value: 1 },
          { date: "2021", t: 2021, value: 2 },
        ],
        [{ date: "2021", t: 2021, value: 2 }],
        { latA: -90, lngA: -180, datasetA: "nasa_power", latB: 90, lngB: 180, datasetB: "ocean_temp" }
      );
      expect(Number.isFinite(comp.pearsonR)).toBe(true);
      expect(Number.isFinite(comp.pValue)).toBe(true);
    });

    it("generates deterministic climatological baseline points across open ocean & poles", () => {
      const a = buildClimatologicalSeriesPoints(-89.9, 179.9, "ocean_temp", 2000, 2024);
      const b = buildClimatologicalSeriesPoints(-89.9, 179.9, "ocean_temp", 2000, 2024);
      expect(a.points).toHaveLength(25);
      expect(a.points).toEqual(b.points);

      const summary = buildClimatologicalTrendSummary(-30, -140, "nasa_power");
      expect(summary.provenanceMode).toBe("climatological_fallback");
      expect(summary.points.length).toBeGreaterThan(20);
      expect(createBoundedSignal(1000)).toBeInstanceOf(AbortSignal);
    });
  });

  describe("Upstream 429/503/Timeout/Malformed Resilience", () => {
    it("retries HTTP 429 on NASA POWER and reports live then cached provenanceMode", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("Rate Limited", { status: 429, statusText: "Too Many Requests" }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ properties: { parameter: makePowerMonthlyPayload(12) } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      vi.stubGlobal("fetch", fetchMock);

      const first = await fetchEarthTimeSeries(89.9, 180, "nasa_power");
      expect(first.provenanceMode).toBe("live");
      expect(first.points.length).toBeGreaterThan(10);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const second = await fetchEarthTimeSeries(89.9, 180, "nasa_power");
      expect(second.provenanceMode).toBe("cached");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("falls back cleanly without throwing when Open-Meteo and NASA POWER time out or fail at poles/open ocean", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));
      vi.stubGlobal("fetch", fetchMock);

      const currentRes = await fetchCurrentEarthConditionsDetailed(-90, -180);
      expect(currentRes.current).toBeNull();
      expect(currentRes.diagnostics.weatherStatus).toBe("failed_to_fetch");

      const multiScale = await fetchRegionalMultiScaleSeries(0, -150, "ocean_temp");
      expect(multiScale.summary.provenanceMode).toBe("climatological_fallback");
      expect(multiScale.annual.length).toBeGreaterThan(15);
    });

    it("returns climatological fallback on /api/earth/timeseries when upstreams are offline while preserving failureKind", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const res = await getTimeSeriesRoute(
        new NextRequest("http://localhost:3000/api/earth/timeseries?lat=-90&lng=195&dataset=nasa_power")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        provenanceMode: string;
        failureKind: string;
        primary: { lat: number; lng: number; provenanceMode: string } | null;
        climatologicalFallback: { provenanceMode: string } | null;
      };
      expect(body.provenanceMode).toBe("climatological_fallback");
      expect(body.failureKind).toBe("failed_to_fetch");
      expect(body.primary?.lat).toBe(-90);
      expect(body.primary?.lng).toBe(-165);
      expect(body.climatologicalFallback?.provenanceMode).toBe("climatological_fallback");
    });

    it("hardens /api/earth/open-feeds against 503/offline outages and preserves 404 out-of-US usgs_gauge contract", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Service Unavailable", { status: 503 })));

      const fallbackFeed = buildOpenFeedClimatologicalFallback("cams_pm25", 48.85, 2.35, 2022, 2025, "monthly");
      expect(fallbackFeed.provenanceMode).toBe("climatological_fallback");
      expect(fallbackFeed.points.length).toBeGreaterThanOrEqual(12);

      const okFallbackRes = await postOpenFeedsRoute(
        new NextRequest("http://localhost:3000/api/earth/open-feeds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feed: "cams_pm25", lat: 48.85, lng: 2.35 }),
        })
      );
      expect(okFallbackRes.status).toBe(200);
      const okJson = (await okFallbackRes.json()) as { provenanceMode: string; pointCount: number };
      expect(okJson.provenanceMode).toBe("climatological_fallback");
      expect(okJson.pointCount).toBeGreaterThanOrEqual(6);

      const nonUsRes = await postOpenFeedsRoute(
        new NextRequest("http://localhost:3000/api/earth/open-feeds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feed: "usgs_gauge", lat: 48.85, lng: 2.35 }),
        })
      );
      expect(nonUsRes.status).toBe(404);
    });

    it("hardens /api/earth/eonet and fetchLiveEonetSignals against malformed payloads, HTTP 503, and caches live hits", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("<html>Gateway Error</html>", { status: 503 }))
      );

      const eonetOut = await fetchLiveEonetSignals(5);
      expect(eonetOut.provenanceMode).toBe("climatological_fallback");
      expect(eonetOut.signals).toEqual([]);

      const routeRes = await postEonetRoute(
        new NextRequest("http://localhost:3000/api/earth/eonet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 5 }),
        })
      );
      expect(routeRes.status).toBe(200);
      const routeJson = (await routeRes.json()) as {
        degraded: boolean;
        provenanceMode: string;
        signals: unknown[];
      };
      expect(routeJson.degraded).toBe(true);
      expect(routeJson.provenanceMode).toBe("climatological_fallback");
      expect(routeJson.signals).toEqual([]);
    });

    it("degrades /api/earth/solar-graph cleanly to climatological baseline during total network outage", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const res = await getSolarGraphRoute(
        new NextRequest("http://localhost:3000/api/earth/solar-graph?startYear=2019")
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        provenanceMode: string;
        nodes: unknown[];
        tomorrow: { graphPred: number };
      };
      expect(data.provenanceMode).toBe("climatological_fallback");
      expect(data.nodes).toHaveLength(7);
      expect(Number.isFinite(data.tomorrow.graphPred)).toBe(true);
    });

    it("recovers GISTEMP, NOAA CO2, NSIDC Sea Ice, and discoverGlobalEarthTrends under offline fetch failures", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network offline")));

      const [gistemp, co2, seaIce] = await Promise.all([
        fetchNasaGistempZonalSeriesWithFallback(1995, 2025),
        fetchNoaaGlobalCo2SeriesWithFallback(),
        fetchNsidcArcticSeaIceSeriesWithFallback(),
      ]);
      expect(gistemp.provenanceMode).toBe("climatological_fallback");
      expect(gistemp.zones.length).toBeGreaterThanOrEqual(6);
      expect(gistemp.globalSeries.length).toBeGreaterThan(20);
      expect(co2.provenanceMode).toBe("climatological_fallback");
      expect(co2.points.length).toBeGreaterThan(20);
      expect(seaIce.provenanceMode).toBe("climatological_fallback");
      expect(seaIce.points.length).toBeGreaterThan(20);

      const discovery = await discoverGlobalEarthTrends(getEtgStore(), { maxEonetSites: 2 });
      expect(discovery.summary.gistempZonesIngested).toBeGreaterThanOrEqual(1);
    });
  });

  describe("WCAG Dialog Light-Dismiss Geometry & Drag-Out Protection", () => {
    it("isPointOutsideRect accurately classifies interior, edge, outside, NaN, and empty bounds", () => {
      const rect = { left: 100, right: 500, top: 80, bottom: 480 };
      expect(isPointOutsideRect(300, 200, rect)).toBe(false);
      expect(isPointOutsideRect(100, 80, rect)).toBe(false);
      expect(isPointOutsideRect(500, 480, rect)).toBe(false);
      expect(isPointOutsideRect(99, 200, rect)).toBe(true);
      expect(isPointOutsideRect(501, 200, rect)).toBe(true);
      expect(isPointOutsideRect(300, 79, rect)).toBe(true);
      expect(isPointOutsideRect(300, 481, rect)).toBe(true);
      expect(isPointOutsideRect(Number.NaN, 200, rect)).toBe(false);
      expect(isPointOutsideRect(10, 10, { left: 0, right: 0, top: 0, bottom: 0 })).toBe(false);
    });

    it("dismisses ONLY when press and release are both outside, ignoring drag-out selections and keyboard (0,0) clicks", () => {
      const target = new EventTarget();
      const mockDialog = Object.assign(target, {
        open: true,
        getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 400 }),
      }) as unknown as HTMLDialogElement;
      const onDismiss = vi.fn();

      const detach = attachDialogLightDismissFallback(mockDialog, onDismiss);

      const firePointerDown = (clientX: number, clientY: number) => {
        const ev = Object.assign(new Event("pointerdown"), { button: 0, clientX, clientY });
        target.dispatchEvent(ev);
      };
      const fireClick = (clientX: number, clientY: number, detail = 1) => {
        const ev = Object.assign(new Event("click"), { clientX, clientY, detail });
        target.dispatchEvent(ev);
      };

      // Case 1: Drag-out text selection starting inside and releasing on backdrop -> MUST NOT dismiss
      firePointerDown(250, 250);
      fireClick(20, 20, 1);
      expect(onDismiss).not.toHaveBeenCalled();

      // Case 2: Press outside and release inside -> MUST NOT dismiss
      firePointerDown(20, 20);
      fireClick(250, 250, 1);
      expect(onDismiss).not.toHaveBeenCalled();

      // Case 3: Keyboard synthesized click (detail === 0) at (0,0) -> MUST NOT dismiss
      firePointerDown(20, 20);
      fireClick(0, 0, 0);
      expect(onDismiss).not.toHaveBeenCalled();

      // Case 4: Both pointerdown and click outside dialog content -> DISMISSES cleanly
      firePointerDown(20, 20);
      fireClick(25, 25, 1);
      expect(onDismiss).toHaveBeenCalledTimes(1);

      detach();
    });
  });
});
