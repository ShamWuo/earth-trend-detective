import { describe, expect, it } from "vitest";
import {
  DEFAULT_SATELLITE_CITY_RADIUS,
  DEFAULT_SATELLITE_METRO_RADIUS,
  DEFAULT_SATELLITE_STREET_RADIUS,
  MIN_GLOBE_CAMERA_RADIUS,
  estimateRegionalSwathKm,
  resolveActiveGibsLayer,
} from "@/lib/earth/nasaGibsRegional";
import {
  AERIAL_IMAGERY_ENDPOINT,
  AERIAL_LABELS_ENDPOINT,
  BACKDROP_AERIAL_GRID_SIZE,
  DEFAULT_AERIAL_GRID_SIZE,
  MAX_AERIAL_LABELS_ZOOM,
  MAX_AERIAL_SLIPPY_ZOOM,
  buildArcGisSlippyTileUrl,
  computeAerialSlippyMosaicSpec,
  computeRelativeMercatorPatchBounds,
  estimateCameraAltitudeKm,
  estimateSlippyGroundResolutionLabel,
  isMercatorPointComfortablyInsideMosaic,
  latLngToNormalizedMercator,
  resolveSatelliteDepthTier,
  selectAerialSlippyZoom,
  shouldRenderAerialUnderlay,
  shouldUseCloudFreeAerialPrimary,
} from "@/lib/earth/satelliteZoomTiles";

describe("satelliteZoomTiles — seamless globe deep zoom & ArcGIS slippy mosaics", () => {
  it("converts (lat, lng) into normalized [0..1] Web Mercator coordinates", () => {
    const equatorPrime = latLngToNormalizedMercator(0, 0);
    expect(equatorPrime.mercX).toBeCloseTo(0.5, 6);
    expect(equatorPrime.mercY).toBeCloseTo(0.5, 6);

    const denver = latLngToNormalizedMercator(39.74, -104.99);
    expect(denver.mercX).toBeCloseTo((-104.99 + 180) / 360, 5);
    expect(denver.mercY).toBeLessThan(0.5);
    expect(denver.mercY).toBeGreaterThan(0.25);

    const south = latLngToNormalizedMercator(-33.8688, 151.2093);
    expect(south.mercX).toBeGreaterThan(0.5);
    expect(south.mercY).toBeGreaterThan(0.5);
  });

  it("scales slippy zoom monotonically from z=4 down to street-level z=18", () => {
    const radii = [
      190,
      166,
      140,
      116,
      DEFAULT_SATELLITE_METRO_RADIUS,
      DEFAULT_SATELLITE_CITY_RADIUS,
      DEFAULT_SATELLITE_STREET_RADIUS,
      MIN_GLOBE_CAMERA_RADIUS,
    ];
    const zooms = radii.map((r) => selectAerialSlippyZoom(r, 39.74));
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i]).toBeGreaterThanOrEqual(zooms[i - 1]);
    }
    expect(zooms[0]).toBeGreaterThanOrEqual(4);
    expect(zooms[zooms.length - 1]).toBeGreaterThanOrEqual(17);
    expect(selectAerialSlippyZoom(MIN_GLOBE_CAMERA_RADIUS, 0)).toBe(MAX_AERIAL_SLIPPY_ZOOM);
    expect(selectAerialSlippyZoom(MIN_GLOBE_CAMERA_RADIUS, 39.74)).toBe(MAX_AERIAL_SLIPPY_ZOOM);
    expect(selectAerialSlippyZoom(195, 70)).toBe(4);
  });

  it("maps camera radius to depth tiers, altitude km, and sub-meter resolution labels", () => {
    expect(resolveSatelliteDepthTier(160)).toBe("mesoscale");
    expect(resolveSatelliteDepthTier(140)).toBe("corridor");
    expect(resolveSatelliteDepthTier(DEFAULT_SATELLITE_METRO_RADIUS)).toBe("metro");
    expect(resolveSatelliteDepthTier(DEFAULT_SATELLITE_CITY_RADIUS)).toBe("city");
    expect(resolveSatelliteDepthTier(DEFAULT_SATELLITE_STREET_RADIUS)).toBe("ground");
    expect(resolveSatelliteDepthTier(MIN_GLOBE_CAMERA_RADIUS)).toBe("ground");

    expect(estimateCameraAltitudeKm(DEFAULT_SATELLITE_CITY_RADIUS)).toBe(24);
    expect(estimateCameraAltitudeKm(DEFAULT_SATELLITE_STREET_RADIUS)).toBe(2);
    expect(estimateCameraAltitudeKm(MIN_GLOBE_CAMERA_RADIUS)).toBe(0.8);
    expect(estimateSlippyGroundResolutionLabel(14, 0)).toContain("m/px");
    expect(estimateSlippyGroundResolutionLabel(18, 40)).toBe("0.46 m/px");
    expect(estimateSlippyGroundResolutionLabel(18, 0)).toBe("0.60 m/px");
  });

  it("builds a center-outward 12x12 (3072x3072) mosaic and skips empty labels above z17", () => {
    const withLabels = computeAerialSlippyMosaicSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: DEFAULT_SATELLITE_METRO_RADIUS,
      includeLabels: true,
    });
    expect(withLabels).not.toBeNull();
    expect(withLabels!.cols).toBe(DEFAULT_AERIAL_GRID_SIZE);
    expect(withLabels!.rows).toBe(DEFAULT_AERIAL_GRID_SIZE);
    expect(withLabels!.width).toBe(3072);
    expect(withLabels!.height).toBe(3072);
    expect(withLabels!.tiles).toHaveLength(144);

    // First 4 tiles must be the central 2x2 focal square, sorted center-outward
    for (let i = 0; i < 4; i++) {
      const cell = withLabels!.tiles[i]!;
      expect([5, 6]).toContain(cell.colOffset);
      expect([5, 6]).toContain(cell.rowOffset);
    }
    let prevDistSq = -1;
    for (const cell of withLabels!.tiles) {
      const distSq = (cell.colOffset - 5.5) ** 2 + (cell.rowOffset - 5.5) ** 2;
      expect(distSq).toBeGreaterThanOrEqual(prevDistSq);
      prevDistSq = distSq;
    }

    const backdropSpec = computeAerialSlippyMosaicSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: DEFAULT_SATELLITE_METRO_RADIUS,
      includeLabels: false,
      gridSize: BACKDROP_AERIAL_GRID_SIZE,
    })!;
    expect(backdropSpec.cols).toBe(10);
    expect(backdropSpec.rows).toBe(10);
    expect(backdropSpec.width).toBe(2560);
    expect(backdropSpec.height).toBe(2560);
    expect(backdropSpec.tiles).toHaveLength(100);

    // Polar-clamped grids (yStart=0) stream rows closest to centerTileY first
    const polarSpec = computeAerialSlippyMosaicSpec({
      lat: 84,
      lng: -104.99,
      cameraRadius: 150,
      includeLabels: false,
      zoomOverride: 5,
    })!;
    expect(polarSpec.yStart).toBe(0);
    const { mercY: polarMercY } = latLngToNormalizedMercator(84, -104.99);
    const polarCenterY = Math.floor(polarMercY * (1 << 5));
    expect(Math.abs(polarSpec.tiles[0]!.y - polarCenterY)).toBeLessThanOrEqual(1);
    expect(polarSpec.tiles[0]!.y).toBeLessThanOrEqual(
      polarSpec.tiles[polarSpec.tiles.length - 1]!.y
    );

    const sample = withLabels!.tiles[0];
    expect(sample.imageryUrl).toBe(
      `${AERIAL_IMAGERY_ENDPOINT}/${sample.z}/${sample.y}/${sample.x}`
    );
    expect(sample.labelsUrl).toBe(
      `${AERIAL_LABELS_ENDPOINT}/${sample.z}/${sample.y}/${sample.x}`
    );
    expect(buildArcGisSlippyTileUrl(AERIAL_IMAGERY_ENDPOINT, 12, 853, 1554)).toBe(
      `${AERIAL_IMAGERY_ENDPOINT}/12/1554/853`
    );

    const noLabels = computeAerialSlippyMosaicSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: DEFAULT_SATELLITE_METRO_RADIUS,
      includeLabels: false,
    });
    expect(noLabels!.tiles.every((t) => t.labelsUrl === null)).toBe(true);

    const z17WithLabels = computeAerialSlippyMosaicSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: MIN_GLOBE_CAMERA_RADIUS,
      includeLabels: true,
      zoomOverride: MAX_AERIAL_LABELS_ZOOM,
    })!;
    expect(z17WithLabels.includeLabels).toBe(true);
    expect(z17WithLabels.tiles.every((t) => t.labelsUrl !== null)).toBe(true);

    const z18RequestedLabels = computeAerialSlippyMosaicSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: MIN_GLOBE_CAMERA_RADIUS,
      includeLabels: true,
      zoomOverride: 18,
    })!;
    expect(z18RequestedLabels.zoom).toBe(18);
    expect(z18RequestedLabels.includeLabels).toBe(false);
    expect(z18RequestedLabels.key.endsWith(":lbl0")).toBe(true);
    expect(z18RequestedLabels.tiles.every((t) => t.labelsUrl === null)).toBe(true);
  });

  it("wraps tile indices cleanly across the antimeridian while keeping mercBounds continuous", () => {
    const spec = computeAerialSlippyMosaicSpec({
      lat: -18.14,
      lng: 179.95,
      cameraRadius: 120,
      includeLabels: false,
    });
    expect(spec).not.toBeNull();
    const n = 1 << spec!.zoom;
    expect(spec!.mercBounds[2]).toBeGreaterThan(1.0);
    const xs = spec!.tiles.map((t) => t.x);
    expect(xs.every((x) => x >= 0 && x < n)).toBe(true);
    expect(xs).toContain(n - 1);
    expect(xs).toContain(0);

    const fijiCenter = latLngToNormalizedMercator(-18.14, 179.95);
    expect(
      isMercatorPointComfortablyInsideMosaic(fijiCenter.mercX, fijiCenter.mercY, spec!)
    ).toBe(true);
  });

  it("returns null outside regional depth or beyond Web Mercator polar limits", () => {
    expect(
      computeAerialSlippyMosaicSpec({
        lat: 87,
        lng: 10,
        cameraRadius: 116,
        includeLabels: false,
      })
    ).toBeNull();

    expect(
      computeAerialSlippyMosaicSpec({
        lat: 39.74,
        lng: -104.99,
        cameraRadius: 270,
        includeLabels: false,
      })
    ).toBeNull();
  });

  it("enforces hysteresis comfort margins inside the loaded mosaic", () => {
    const spec = computeAerialSlippyMosaicSpec({
      lat: 39.74,
      lng: -104.99,
      cameraRadius: 112,
      includeLabels: true,
    })!;
    const center = latLngToNormalizedMercator(39.74, -104.99);
    expect(
      isMercatorPointComfortablyInsideMosaic(center.mercX, center.mercY, spec)
    ).toBe(true);

    const rightNearEdgeX = spec.mercBounds[0] + 0.0001;
    expect(
      isMercatorPointComfortablyInsideMosaic(rightNearEdgeX, center.mercY, spec)
    ).toBe(false);
  });

  it("selects cloud-free aerial imagery vs NASA GIBS science overlays appropriately", () => {
    expect(resolveActiveGibsLayer("aerial", ["wildfire"])).toBeNull();
    expect(shouldUseCloudFreeAerialPrimary("aerial", ["wildfire"])).toBe(true);
    expect(shouldUseCloudFreeAerialPrimary("auto", [])).toBe(true);
    expect(shouldUseCloudFreeAerialPrimary("auto", ["nasa_power"])).toBe(true);
    expect(shouldUseCloudFreeAerialPrimary("auto", ["community"])).toBe(true);
    expect(shouldUseCloudFreeAerialPrimary("auto", ["wildfire"])).toBe(false);
    expect(shouldUseCloudFreeAerialPrimary("auto", ["ocean_temp"])).toBe(false);
    expect(shouldUseCloudFreeAerialPrimary("thermal", [])).toBe(false);

    expect(shouldRenderAerialUnderlay("off")).toBe(false);
    expect(shouldRenderAerialUnderlay("true_color")).toBe(false);
    expect(shouldRenderAerialUnderlay("night_viirs")).toBe(false);
    expect(shouldRenderAerialUnderlay("aerial")).toBe(true);
    expect(shouldRenderAerialUnderlay("thermal")).toBe(true);
    expect(shouldRenderAerialUnderlay("auto")).toBe(true);
  });

  it("computes camera-relative Mercator patch bounds near 0 across mid-latitudes and antimeridian", () => {
    const boulderSpec = computeAerialSlippyMosaicSpec({
      lat: 40.015,
      lng: -105.2705,
      cameraRadius: MIN_GLOBE_CAMERA_RADIUS,
      includeLabels: false,
      zoomOverride: 18,
    })!;
    const ref = latLngToNormalizedMercator(40.015, -105.2705);
    const [dxMin, dyMin, invSpanX, invSpanY] = computeRelativeMercatorPatchBounds(
      boulderSpec.mercBounds,
      ref
    );
    expect(Math.abs(dxMin)).toBeLessThan(7 / (1 << 18));
    expect(Math.abs(dyMin)).toBeLessThan(7 / (1 << 18));
    expect(invSpanX).toBeCloseTo((1 << 18) / DEFAULT_AERIAL_GRID_SIZE, 4);
    expect(invSpanY).toBeCloseTo((1 << 18) / DEFAULT_AERIAL_GRID_SIZE, 4);
    const centerU = (0 - dxMin) * invSpanX;
    const centerV = 1 - (0 - dyMin) * invSpanY;
    expect(centerU).toBeGreaterThan(0.3);
    expect(centerU).toBeLessThan(0.7);
    expect(centerV).toBeGreaterThan(0.3);
    expect(centerV).toBeLessThan(0.7);

    // Antimeridian continuity: ref wrapped slightly east across 180° (-179.999°) inside a z17 patch at 179.999°
    const fijiSpec = computeAerialSlippyMosaicSpec({
      lat: -18.14,
      lng: 179.999,
      cameraRadius: MIN_GLOBE_CAMERA_RADIUS,
      includeLabels: false,
      zoomOverride: 17,
    })!;
    const wrappedEastRef = latLngToNormalizedMercator(-18.14, -179.999);
    const [wDxMin, , wInvSpanX] = computeRelativeMercatorPatchBounds(
      fijiSpec.mercBounds,
      wrappedEastRef
    );
    const wrappedU = (0 - wDxMin) * wInvSpanX;
    expect(wrappedU).toBeGreaterThan(0);
    expect(wrappedU).toBeLessThan(1);
  });

  it("preserves regional swath benchmarks while scaling down cleanly to street zoom", () => {
    expect(estimateRegionalSwathKm(116)).toBe(420);
    expect(estimateRegionalSwathKm(196)).toBe(1900);
    expect(estimateRegionalSwathKm(DEFAULT_SATELLITE_CITY_RADIUS)).toBeLessThan(40);
    expect(estimateRegionalSwathKm(DEFAULT_SATELLITE_STREET_RADIUS)).toBeCloseTo(0.8, 1);
    expect(estimateRegionalSwathKm(MIN_GLOBE_CAMERA_RADIUS)).toBe(0.3);
  });
});
