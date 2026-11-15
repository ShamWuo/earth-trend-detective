import { describe, expect, it } from "vitest";
import {
  CORRIDOR_TIER_MAX_RADIUS,
  GIBS_LAYERS,
  GIBS_WMS_ENDPOINT,
  REGIONAL_ZOOM_EXIT_RADIUS,
  buildGeodesicCircleLatLng,
  buildWmtsTileUrl,
  computeGlobalBordersProxyUrl,
  computeGlobalBordersQuadrantSpecs,
  computeGlobalBordersUrl,
  computeGlobalLayerSpec,
  computeGlobalWmtsMosaicSpec,
  computeRegionalTileSpec,
  estimateRegionalSwathKm,
  getGibsLayerColorbar,
  resolveActiveGibsLayer,
  resolveGibsDateIso,
  resolveGlobalFilterLayer,
  resolveGlobalSyncSignature,
  type ActiveGibsLayerId,
} from "@/lib/earth/nasaGibsRegional";

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

describe("nasaGibsRegional", () => {
  it("resolves active GIBS layer from mode and dataset topics", () => {
    expect(resolveActiveGibsLayer("off", ["wildfire"])).toBeNull();
    expect(resolveActiveGibsLayer("ndvi", ["wildfire"])).toBe("ndvi");
    expect(resolveActiveGibsLayer("thermal", ["nasa_power"])).toBe("thermal");
    expect(resolveActiveGibsLayer("night_viirs", [])).toBe("night_viirs");

    expect(resolveActiveGibsLayer("auto", ["wildfire", "nasa_power"])).toBe(
      "thermal"
    );
    expect(resolveActiveGibsLayer("auto", ["ocean_temp"])).toBe("thermal");
    expect(resolveActiveGibsLayer("auto", ["deforestation"])).toBe("ndvi");
    expect(resolveActiveGibsLayer("auto", ["nasa_power"])).toBe("true_color");
    expect(resolveActiveGibsLayer("auto", [])).toBe("true_color");
    expect(resolveActiveGibsLayer("auto")).toBe("true_color");
  });

  it("enforces NRT lag buffers, historical cutoffs, and instrument start epochs", () => {
    const nowMs = Date.UTC(2026, 10, 15, 4, 0, 0);

    // 4-day lag for MODIS True Color, 5-day lag for Thermal, 10-day lag for 8-day NDVI
    expect(resolveGibsDateIso("true_color", undefined, nowMs)).toBe(
      "2026-11-11"
    );
    expect(resolveGibsDateIso("thermal", undefined, nowMs)).toBe("2026-11-10");
    expect(resolveGibsDateIso("ndvi", undefined, nowMs)).toBe("2026-11-05");
    expect(resolveGibsDateIso("night_viirs", undefined, nowMs)).toBe(
      "2026-11-11"
    );

    // Historical scrubber date earlier than maxSafeMs takes precedence
    const historicalMs = Date.UTC(2021, 6, 15);
    expect(resolveGibsDateIso("true_color", historicalMs, nowMs)).toBe(
      "2021-07-15"
    );

    // Too-early cutoff clamps cleanly to instrument minimum epoch
    const ancientMs = Date.UTC(1995, 4, 1);
    expect(resolveGibsDateIso("true_color", ancientMs, nowMs)).toBe(
      "2003-01-01"
    );
    expect(resolveGibsDateIso("night_viirs", ancientMs, nowMs)).toBe(
      "2012-02-01"
    );
  });

  it("computes quantized 2-tier WMS EPSG:4326 specs with pole and antimeridian safety", () => {
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);

    expect(
      computeRegionalTileSpec({
        lat: 39.74,
        lng: -104.99,
        cameraRadius: REGIONAL_ZOOM_EXIT_RADIUS + 4,
        layerId: "true_color",
        nowMs,
      })
    ).toBeNull();

    const mesoscale = computeRegionalTileSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: 175,
      layerId: "true_color",
      nowMs,
    });
    expect(mesoscale).not.toBeNull();
    expect(mesoscale?.tier).toBe("mesoscale");
    expect(mesoscale?.width).toBe(1600);
    expect(mesoscale?.height).toBe(1200);
    expect(mesoscale?.bounds).toEqual([-122, 26.5, -86, 53.5]);
    expect(mesoscale?.url.startsWith(GIBS_WMS_ENDPOINT)).toBe(true);
    expect(mesoscale?.url).toContain("SRS=EPSG:4326");
    expect(mesoscale?.url).toContain("FORMAT=image/jpeg");
    expect(mesoscale?.url).toContain("TIME=2026-11-10");

    // Nearby points within 2-deg corridor snap into the identical cache key
    const corridorA = computeRegionalTileSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: CORRIDOR_TIER_MAX_RADIUS - 10,
      layerId: "ndvi",
      nowMs,
    });
    const corridorB = computeRegionalTileSpec({
      lat: 40.45,
      lng: -104.25,
      cameraRadius: 128,
      layerId: "ndvi",
      nowMs,
    });
    expect(corridorA?.tier).toBe("corridor");
    expect(corridorA?.width).toBe(2048);
    expect(corridorA?.height).toBe(1536);
    expect(corridorA?.bounds).toEqual([-112, 34, -96, 46]);
    expect(corridorA?.key).toBe(corridorB?.key);

    // Antimeridian and polar boundary clamping never invert BBOX min/max
    const polarDateline = computeRegionalTileSpec({
      lat: 84,
      lng: -179,
      cameraRadius: 130,
      layerId: "thermal",
      nowMs,
    });
    expect(polarDateline).not.toBeNull();
    const [minLng, minLat, maxLng, maxLat] = polarDateline!.bounds;
    expect(minLng).toBeGreaterThanOrEqual(-180);
    expect(maxLng).toBeLessThanOrEqual(180);
    expect(maxLng - minLng).toBe(16);
    expect(minLat).toBeGreaterThanOrEqual(-85);
    expect(maxLat).toBeLessThanOrEqual(85);
    expect(maxLat - minLat).toBe(12);
  });

  it("generates accurate 50 km and 150 km closed geodesic rings around Denver", () => {
    const denverLat = 39.74;
    const denverLng = -104.99;

    for (const targetKm of [50, 150]) {
      const ring = buildGeodesicCircleLatLng(denverLat, denverLng, targetKm, 64);
      expect(ring).toHaveLength(65);
      for (const pt of ring) {
        expect(Number.isFinite(pt.lat)).toBe(true);
        expect(Number.isFinite(pt.lng)).toBe(true);
        const dist = haversineKm(denverLat, denverLng, pt.lat, pt.lng);
        expect(Math.abs(dist - targetKm)).toBeLessThan(0.5);
      }
      expect(Math.abs(ring[0]!.lat - ring[64]!.lat)).toBeLessThan(1e-6);
    }

    expect(estimateRegionalSwathKm(116)).toBe(420);
    expect(estimateRegionalSwathKm(196)).toBe(1900);
  });

  it("resolves global full-sphere filters and builds equirectangular GIBS specs", () => {
    expect(resolveGlobalFilterLayer("auto", [])).toBeNull();
    expect(resolveGlobalFilterLayer("off", ["wildfire"])).toBeNull();
    expect(resolveGlobalFilterLayer("multi_slice", ["wildfire"])).toBeNull();
    expect(resolveGlobalFilterLayer("winds", [])).toBe("winds");
    expect(resolveGlobalFilterLayer("auto", ["hydrology"])).toBe("precip");
    expect(resolveGlobalFilterLayer("auto", ["air_quality"])).toBe("aerosols");
    expect(resolveGlobalFilterLayer("auto", ["deforestation"])).toBe("ndvi");
    expect(resolveGlobalFilterLayer("auto", ["ocean_temp"])).toBe("sst_anomaly");
    expect(resolveGlobalFilterLayer("auto", ["nasa_power"])).toBe("air_temp");
    expect(resolveGlobalFilterLayer("auto", ["wildfire"])).toBe("thermal");

    expect(resolveActiveGibsLayer("multi_slice", [])).toBe("true_color");

    const allLayerIds: ActiveGibsLayerId[] = [
      "winds",
      "precip",
      "thermal",
      "sst_anomaly",
      "air_temp",
      "aerosols",
      "ndvi",
      "true_color",
      "night_viirs",
    ];
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    for (const layerId of allLayerIds) {
      expect(GIBS_LAYERS[layerId]).toBeDefined();
      const spec = computeGlobalLayerSpec({ layerId, nowMs });
      expect(spec.width).toBe(2048);
      expect(spec.height).toBe(1024);
      expect(spec.url).toContain("BBOX=-180,-90,180,90");
      expect(spec.proxyUrl).toContain("scope=global");
    }

    const windsSpec = computeGlobalLayerSpec({ layerId: "winds", nowMs });
    expect(windsSpec.dateIso).toBe("2026-07-01");
    expect(windsSpec.url).toContain("MERRA2_Surface_Wind_Speed_Monthly");

    const airTempSpec = computeGlobalLayerSpec({ layerId: "air_temp", nowMs });
    expect(airTempSpec.dateIso).toBe("2026-07-01");
    expect(airTempSpec.url).toContain("MERRA2_2m_Air_Temperature_Assimilated_Monthly");

    const sstSpec = computeGlobalLayerSpec({ layerId: "sst_anomaly", nowMs });
    expect(sstSpec.url).toContain("FORMAT=image/png");
    expect(sstSpec.url).toContain("TRANSPARENT=TRUE");

    const ndviSpec = computeGlobalLayerSpec({ layerId: "ndvi", nowMs });
    expect(ndviSpec.url).toContain("FORMAT=image/png");
    expect(ndviSpec.url).toContain("TRANSPARENT=TRUE");

    const bordersUrl = computeGlobalBordersUrl();
    expect(bordersUrl).toContain("Coastlines,Reference_Features");
    expect(bordersUrl).toContain("FORMAT=image/png");
    expect(bordersUrl).toContain("TRANSPARENT=TRUE");

    const bordersProxyUrl = computeGlobalBordersProxyUrl();
    expect(bordersProxyUrl).toContain("layer=borders");
    expect(bordersProxyUrl).toContain("scope=global");
  });

  it("builds 5K/2.5K WMTS mosaic specs and 4K border quadrant specs", () => {
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);

    const sstWmts = computeGlobalWmtsMosaicSpec({ layerId: "sst_anomaly", nowMs });
    expect(sstWmts.zoom).toBe(3);
    expect(sstWmts.cols).toBe(10);
    expect(sstWmts.rows).toBe(5);
    expect(sstWmts.width).toBe(5120);
    expect(sstWmts.height).toBe(2560);
    expect(sstWmts.badgeLabel).toBe("5K HD");
    expect(buildWmtsTileUrl(sstWmts.subLayers[0]!, 3, 2, 4)).toBe(
      `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/${sstWmts.primaryDateIso}/1km/3/2/4.png`
    );

    const windsWmts = computeGlobalWmtsMosaicSpec({ layerId: "winds", nowMs });
    expect(windsWmts.zoom).toBe(2);
    expect(windsWmts.cols).toBe(5);
    expect(windsWmts.rows).toBe(3);
    expect(windsWmts.width).toBe(2560);
    expect(windsWmts.height).toBe(1280);
    expect(windsWmts.badgeLabel).toBe("2.5K HD");

    const precipWmts = computeGlobalWmtsMosaicSpec({ layerId: "precip", nowMs });
    expect(precipWmts.subLayers).toHaveLength(2);
    expect(precipWmts.subLayers[0]!.dateIso).toMatch(/^\d{4}-\d{2}-01$/);
    expect(precipWmts.subLayers[1]!.dateIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(precipWmts.primaryDateIso).toBe(precipWmts.subLayers[1]!.dateIso);

    const nightWmts = computeGlobalWmtsMosaicSpec({ layerId: "night_viirs", nowMs });
    expect(nightWmts.subLayers[0]!.timeless).toBe(true);
    expect(buildWmtsTileUrl(nightWmts.subLayers[0]!, 3, 1, 2)).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_CityLights_2012/default/500m/3/1/2.jpeg"
    );

    const quads = computeGlobalBordersQuadrantSpecs();
    expect(quads).toHaveLength(4);
    expect(quads.map((q) => [q.dx, q.dy])).toEqual([
      [0, 0],
      [2048, 0],
      [0, 1024],
      [2048, 1024],
    ]);
    for (const q of quads) {
      expect(q.width).toBe(2048);
      expect(q.height).toBe(1024);
      expect(q.proxyUrl).toContain("layer=borders");
      expect(q.proxyUrl).toContain("width=2048");
      expect(q.proxyUrl).toContain("height=1024");
    }
  });

  it("exposes legible colorbar metadata for every GIBS layer including night_viirs", () => {
    expect(getGibsLayerColorbar(null)).toBeNull();

    const colorbarLayers: ActiveGibsLayerId[] = [
      "winds",
      "precip",
      "thermal",
      "sst_anomaly",
      "air_temp",
      "aerosols",
      "ndvi",
      "night_viirs",
    ];
    for (const id of colorbarLayers) {
      const cb = getGibsLayerColorbar(id);
      expect(cb).not.toBeNull();
      expect(cb!.gradientCss).toContain("linear-gradient(");
      expect(cb!.unitLabel.length).toBeGreaterThan(0);
      expect(cb!.minLabel.length).toBeGreaterThan(0);
      expect(cb!.midLabel.length).toBeGreaterThan(0);
      expect(cb!.maxLabel.length).toBeGreaterThan(0);
    }

    const nightBar = getGibsLayerColorbar("night_viirs");
    expect(nightBar!.unitLabel).toBe("nW/cm²·sr");
    expect(nightBar!.maxLabel).toBe("100+");
  });

  it("deduplicates intra-month timeline scrub ticks while tracking daily multi_slice steps", () => {
    const nowMs = Date.UTC(2026, 10, 15, 12, 0, 0);

    expect(resolveGlobalSyncSignature("off", [], Date.UTC(2024, 5, 10), nowMs)).toBe("off");

    // Monthly MERRA-2 winds stay invariant within the same UTC month
    const julyEarly = Date.UTC(2024, 6, 3);
    const julyLate = Date.UTC(2024, 6, 28);
    const augMid = Date.UTC(2024, 7, 15);
    const sigEarly = resolveGlobalSyncSignature("winds", [], julyEarly, nowMs);
    const sigLate = resolveGlobalSyncSignature("winds", [], julyLate, nowMs);
    const sigAug = resolveGlobalSyncSignature("winds", [], augMid, nowMs);
    expect(sigEarly).toBe(sigLate);
    expect(sigAug).not.toBe(sigEarly);

    // multi_slice tracks daily updates across precip and cloud layers
    const dayOne = Date.UTC(2025, 2, 10);
    const dayTwo = Date.UTC(2025, 2, 11);
    const sliceOne = resolveGlobalSyncSignature("multi_slice", [], dayOne, nowMs);
    const sliceTwo = resolveGlobalSyncSignature("multi_slice", [], dayTwo, nowMs);
    expect(sliceOne).toMatch(/^multi_slice:/);
    expect(sliceTwo).not.toBe(sliceOne);
  });

  it("routes historical pre-2019-08-01 sst_anomaly to MUR25 (2002-09-01+) and builds Zoom 0/1 WMTS previews", () => {
    const nowMs = Date.UTC(2026, 10, 15, 12, 0, 0);

    // Pre-2019-08-01 dates route to continuous 0.25-deg MUR25 (2km) at zoom 2
    const dec2010Ms = Date.UTC(2010, 11, 1);
    const dec2015Ms = Date.UTC(2015, 11, 15);
    const wmts2010 = computeGlobalWmtsMosaicSpec({
      layerId: "sst_anomaly",
      cutoffMs: dec2010Ms,
      nowMs,
    });
    expect(wmts2010.primaryDateIso).toBe("2010-12-01");
    expect(wmts2010.zoom).toBe(2);
    expect(wmts2010.badgeLabel).toBe("2.5K HD");
    expect(wmts2010.subLayers[0]!.wmtsLayer).toBe(
      "GHRSST_L4_MUR25_Sea_Surface_Temperature_Anomalies"
    );
    expect(wmts2010.subLayers[0]!.tileMatrixSet).toBe("2km");

    const wms2015 = computeGlobalLayerSpec({
      layerId: "sst_anomaly",
      cutoffMs: dec2015Ms,
      nowMs,
    });
    expect(wms2015.dateIso).toBe("2015-12-15");
    expect(wms2015.url).toContain(
      "LAYERS=GHRSST_L4_MUR25_Sea_Surface_Temperature_Anomalies"
    );

    // Pre-2002-09-01 clamps to 2002-09-01
    expect(resolveGibsDateIso("sst_anomaly", Date.UTC(1998, 0, 1), nowMs)).toBe(
      "2002-09-01"
    );

    // >= 2019-08-01 retains 1km MUR at zoom 3 (5K HD)
    const wmts2023 = computeGlobalWmtsMosaicSpec({
      layerId: "sst_anomaly",
      cutoffMs: Date.UTC(2023, 11, 15),
      nowMs,
    });
    expect(wmts2023.zoom).toBe(3);
    expect(wmts2023.badgeLabel).toBe("5K HD");
    expect(wmts2023.subLayers[0]!.wmtsLayer).toBe(
      "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies"
    );
    expect(wmts2023.subLayers[0]!.tileMatrixSet).toBe("1km");

    // Zoom 0 (2-tile) and Zoom 1 (6-tile) fast preview specs match OGC EPSG:4326 geometry
    const z0 = computeGlobalWmtsMosaicSpec({
      layerId: "sst_anomaly",
      cutoffMs: dec2015Ms,
      nowMs,
      zoomOverride: 0,
    });
    expect(z0.cols).toBe(2);
    expect(z0.rows).toBe(1);
    expect(z0.width).toBe(640);
    expect(z0.height).toBe(320);
    expect(z0.badgeLabel).toBe("Live Preview");

    const z1 = computeGlobalWmtsMosaicSpec({
      layerId: "sst_anomaly",
      cutoffMs: Date.UTC(2023, 11, 15),
      nowMs,
      zoomOverride: 1,
    });
    expect(z1.cols).toBe(3);
    expect(z1.rows).toBe(2);
    expect(z1.width).toBe(1280);
    expect(z1.height).toBe(640);
    expect(z1.badgeLabel).toBe("1.3K");
  });
});
