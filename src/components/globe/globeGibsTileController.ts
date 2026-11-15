import type React from "react";
import * as THREE from "three";
import {
  GIBS_LAYERS,
  REGIONAL_ZOOM_EXIT_RADIUS,
  buildWmtsTileUrl,
  computeGlobalBordersProxyUrl,
  computeGlobalBordersQuadrantSpecs,
  computeGlobalLayerSpec,
  computeGlobalWmtsMosaicSpec,
  computeRegionalTileSpec,
  estimateRegionalSwathKm,
  resolveGlobalFilterLayer,
  type ActiveGibsLayerId,
  type GlobalLayerSpec,
  type GlobalWmtsMosaicSpec,
  type RegionalSatelliteMode,
  type RegionalTileSpec,
} from "@/lib/earth/nasaGibsRegional";
import {
  createDynamicTextureTracker,
  vector3ToLatLng,
  type GlobalHudState,
  type RegionalHudState,
} from "@/components/globe/globeGeometryAndArcs";
import {
  BACKDROP_AERIAL_GRID_SIZE,
  DEFAULT_AERIAL_GRID_SIZE,
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
  type AerialSlippyMosaicSpec,
} from "@/lib/earth/satelliteZoomTiles";
import type { ETGDatasetId } from "@/types/etg";

export interface GlobeGibsTileController {
  syncGlobalMode: (
    mode: RegionalSatelliteMode,
    topics?: readonly ETGDatasetId[],
    cutoffMsVal?: number
  ) => void;
  syncRegionalTile: (force?: boolean) => void;
  syncMercatorOrigin: (mercRef: { mercX: number; mercY: number }) => void;
  isRegionalTexLoaded: () => boolean;
  isGlobalTexLoaded: () => boolean;
  isAerialCoarseLoaded: () => boolean;
  isAerialMidLoaded: () => boolean;
  isAerialPrevFineLoaded: () => boolean;
  isAerialFineLoaded: () => boolean;
  dispose: () => void;
}

/**
 * Coordinates NASA GIBS global WMTS mosaics, 2K fallbacks, 4K coastline borders,
 * and regional zoom swaths with bounded LRU GPU texture tracking.
 */
export function createGlobeGibsTileController(params: {
  earthMat: THREE.ShaderMaterial;
  renderer: THREE.WebGLRenderer;
  maxAnisotropy: number;
  spherical: THREE.Spherical;
  activeGibsLayerRef: React.RefObject<ActiveGibsLayerId | null>;
  satelliteModeRef: React.RefObject<RegionalSatelliteMode>;
  activeTopicsRef: React.RefObject<readonly ETGDatasetId[] | undefined>;
  showPlaceLabelsRef: React.RefObject<boolean>;
  cutoffMsRef: React.RefObject<number | undefined>;
  setGlobalHud: React.Dispatch<React.SetStateAction<GlobalHudState>>;
  setRegionalHud: React.Dispatch<React.SetStateAction<RegionalHudState>>;
}): GlobeGibsTileController {
  const {
    earthMat,
    renderer,
    maxAnisotropy,
    spherical,
    activeGibsLayerRef,
    satelliteModeRef,
    activeTopicsRef,
    showPlaceLabelsRef,
    cutoffMsRef,
    setGlobalHud,
    setRegionalHud,
  } = params;

  const gibsLoader = new THREE.TextureLoader();
  gibsLoader.setCrossOrigin("anonymous");
  const gibsCache = new Map<string, THREE.Texture>();
  const globalGibsCache = new Map<string, THREE.Texture>();
  const globalPreviewCache = new Map<string, THREE.CanvasTexture>();
  const globalWmtsCache = new Map<string, THREE.CanvasTexture>();
  const aerialMosaicCache = new Map<string, THREE.CanvasTexture>();
  type TileDrawable = ImageBitmap | HTMLImageElement;
  const slippyTileBitmapCache = new Map<string, TileDrawable>();
  const inFlightTileFetches = new Map<
    string,
    { promise: Promise<TileDrawable>; refCount: number; controller: AbortController }
  >();
  const failedTileUntil = new Map<string, number>();
  const failedGlobalUntil = new Map<string, number>();

  const closeBitmapSafely = (drawable: TileDrawable | undefined) => {
    if (
      drawable &&
      typeof ImageBitmap !== "undefined" &&
      drawable instanceof ImageBitmap
    ) {
      try {
        drawable.close();
      } catch {
        // Ignore already-closed bitmaps
      }
    }
  };

  const isTextureBoundToUniform = (tex: THREE.Texture) =>
    tex === earthMat.uniforms.uRegionalMap.value ||
    tex === earthMat.uniforms.uSatCoarseMap.value ||
    tex === earthMat.uniforms.uSatMidMap.value ||
    tex === earthMat.uniforms.uSatPrevFineMap.value ||
    tex === earthMat.uniforms.uSatFineMap.value ||
    tex === earthMat.uniforms.uGlobalLayerMap.value ||
    tex === earthMat.uniforms.uSliceWindsMap.value ||
    tex === earthMat.uniforms.uSlicePrecipMap.value ||
    tex === earthMat.uniforms.uSliceCloudsMap.value ||
    tex === earthMat.uniforms.uBordersMap.value;

  const textureTracker = createDynamicTextureTracker<THREE.Texture>(
    isTextureBoundToUniform
  );
  const inFlightTileImages = new Set<HTMLImageElement>();
  const inFlightPreviewImages = new Set<HTMLImageElement>();
  const inFlightGlobalHdImages = new Set<HTMLImageElement>();
  const abortImageSet = (imageSet: Set<HTMLImageElement>) => {
    for (const img of imageSet) {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    }
    imageSet.clear();
  };
  const abortInFlightTileImages = () => {
    abortImageSet(inFlightTileImages);
    for (const entry of inFlightTileFetches.values()) {
      entry.controller.abort();
    }
    inFlightTileFetches.clear();
  };
  const abortInFlightPreviewImages = () => abortImageSet(inFlightPreviewImages);
  const abortInFlightGlobalHdImages = () => abortImageSet(inFlightGlobalHdImages);

  let disposed = false;
  let gibsReqSeq = 0;
  let globalReqSeq = 0;
  let aerialReqSeq = 0;
  let coarseAerialReqSeq = 0;
  let midAerialReqSeq = 0;
  let regionalTexLoaded = false;
  let globalTexLoaded = false;
  let aerialCoarseLoaded = false;
  let aerialMidLoaded = false;
  let aerialPrevFineLoaded = false;
  let aerialFineLoaded = false;
  let activeCoarseSpec: AerialSlippyMosaicSpec | null = null;
  let activeMidSpec: AerialSlippyMosaicSpec | null = null;
  let activePrevFineSpec: AerialSlippyMosaicSpec | null = null;
  let activeFineSpec: AerialSlippyMosaicSpec | null = null;
  let activePrevFineTileCount = 0;
  let activeFineTileCount = 0;
  let activeAerialAbortController: AbortController | null = null;
  let currentMercRef = { mercX: 0.5, mercY: 0.5 };
  let lastZoomLevel = 0;
  let activeGlobalKey = "";
  let activeModeSignature = "";
  let desiredGlobalKey = "";
  let hdAppliedForDesired = false;
  let previewInFlight = false;
  let pendingPreviewJob: (() => Promise<void>) | null = null;
  let hdUpgradeTimer: number | null = null;
  const clearHdUpgradeTimer = () => {
    if (hdUpgradeTimer !== null) {
      window.clearTimeout(hdUpgradeTimer);
      hdUpgradeTimer = null;
    }
  };
  const enqueuePreviewJob = (job: () => Promise<void>) => {
    pendingPreviewJob = job;
    if (previewInFlight) return;
    previewInFlight = true;
    void (async () => {
      try {
        while (pendingPreviewJob && !disposed) {
          const next = pendingPreviewJob;
          pendingPreviewJob = null;
          try {
            await next();
          } catch {
            // Handled inside individual preview jobs
          }
        }
      } finally {
        previewInFlight = false;
      }
    })();
  };
  let lastCheckedTileKey = "";
  let lastRequestedTileKey = "";
  let lastRequestedAerialKey = "";
  let lastHudCenterSig = "";
  let gibsDebounceTimer: number | null = null;
  let aerialDebounceTimer: number | null = null;
  let bordersTex: THREE.Texture | null = null;
  let bordersLoading = false;
  let borders4kLoaded = false;
  let borders4kLoading = false;

  const insertWithLru = <T extends THREE.Texture>(
    cache: Map<string, T>,
    key: string,
    tex: T,
    maxEntries: number
  ) => {
    textureTracker.register(tex);
    cache.set(key, tex);
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) break;
      const oldTex = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldTex) {
        textureTracker.evictFromCache(oldTex);
      }
    }
  };

  const configureGlobalTex = <T extends THREE.Texture>(tex: T): T => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = maxAnisotropy;
    return tex;
  };

  const ensureBordersLoaded = () => {
    if (!bordersTex && !bordersLoading && !disposed) {
      bordersLoading = true;
      gibsLoader.load(
        computeGlobalBordersProxyUrl(),
        (tex) => {
          bordersLoading = false;
          if (disposed || borders4kLoaded) {
            tex.dispose();
            return;
          }
          configureGlobalTex(tex);
          textureTracker.register(tex);
          bordersTex = tex;
          earthMat.uniforms.uBordersMap.value = tex;
          earthMat.uniforms.uBordersLoaded.value = 1.0;
          textureTracker.releaseUnbound();
        },
        undefined,
        () => {
          bordersLoading = false;
        }
      );
    }

    if (!borders4kLoaded && !borders4kLoading && !disposed) {
      borders4kLoading = true;
      const quadrants = computeGlobalBordersQuadrantSpecs();
      Promise.all(
        quadrants.map(
          (q) =>
            new Promise<{ img: HTMLImageElement; dx: number; dy: number }>((resolve, reject) => {
              const img = new Image();
              img.crossOrigin = "anonymous";
              inFlightTileImages.add(img);
              img.onload = () => {
                inFlightTileImages.delete(img);
                resolve({ img, dx: q.dx, dy: q.dy });
              };
              img.onerror = () => {
                inFlightTileImages.delete(img);
                reject(new Error(`Border quadrant failed: ${q.bbox}`));
              };
              img.src = q.proxyUrl;
            })
        )
      )
        .then((loadedQuads) => {
          borders4kLoading = false;
          if (disposed) return;
          const maxGpu = renderer.capabilities.maxTextureSize || 4096;
          const targetW = maxGpu >= 4096 ? 4096 : 2048;
          const targetH = Math.round(targetW / 2);
          const scale = targetW / 4096;
          const canvas = document.createElement("canvas");
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          for (const item of loadedQuads) {
            ctx.drawImage(
              item.img,
              item.dx * scale,
              item.dy * scale,
              2048 * scale,
              1024 * scale
            );
          }
          const tex4k = configureGlobalTex(new THREE.CanvasTexture(canvas));
          textureTracker.register(tex4k);
          const oldBorders = bordersTex;
          bordersTex = tex4k;
          borders4kLoaded = true;
          earthMat.uniforms.uBordersMap.value = tex4k;
          earthMat.uniforms.uBordersLoaded.value = 1.0;
          if (oldBorders && oldBorders !== tex4k) {
            textureTracker.evictFromCache(oldBorders);
          }
          textureTracker.releaseUnbound();
        })
        .catch(() => {
          borders4kLoading = false;
        });
    }
  };

  const loadTileImage = (
    url: string,
    trackerSet: Set<HTMLImageElement> = inFlightTileImages
  ) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      trackerSet.add(img);
      img.onload = () => {
        trackerSet.delete(img);
        resolve(img);
      };
      img.onerror = () => {
        trackerSet.delete(img);
        reject(new Error(`WMTS tile failed: ${url}`));
      };
      img.src = url;
    });

  const touchSlippyCached = (url: string): TileDrawable | undefined => {
    const cached = slippyTileBitmapCache.get(url);
    if (cached) {
      slippyTileBitmapCache.delete(url);
      slippyTileBitmapCache.set(url, cached);
    }
    return cached;
  };

  const insertSlippyTileCached = (url: string, drawable: TileDrawable) => {
    slippyTileBitmapCache.set(url, drawable);
    while (slippyTileBitmapCache.size > 960) {
      const oldestKey = slippyTileBitmapCache.keys().next().value;
      if (!oldestKey) break;
      const oldDrawable = slippyTileBitmapCache.get(oldestKey);
      slippyTileBitmapCache.delete(oldestKey);
      if (oldDrawable) {
        queueMicrotask(() => closeBitmapSafely(oldDrawable));
      }
    }
  };

  const loadSlippyTileDrawableCached = (
    url: string,
    signal?: AbortSignal
  ): Promise<TileDrawable> => {
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    const cached = touchSlippyCached(url);
    if (cached) {
      return Promise.resolve(cached);
    }

    if (typeof fetch !== "function" || typeof createImageBitmap !== "function") {
      return loadTileImage(url).then((img) => {
        insertSlippyTileCached(url, img);
        return img;
      });
    }

    let entry = inFlightTileFetches.get(url);
    if (!entry) {
      const controller = new AbortController();
      const promise = (async () => {
        try {
          const res = await fetch(url, {
            mode: "cors",
            credentials: "omit",
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`);
          }
          const blob = await res.blob();
          const bitmap = await createImageBitmap(blob, {
            premultiplyAlpha: "none",
          }).catch(() => createImageBitmap(blob));
          if (disposed) {
            closeBitmapSafely(bitmap);
            throw new Error("Disposed");
          }
          insertSlippyTileCached(url, bitmap);
          return bitmap;
        } finally {
          inFlightTileFetches.delete(url);
        }
      })();
      entry = { promise, refCount: 0, controller };
      inFlightTileFetches.set(url, entry);
    }

    entry.refCount += 1;
    const sharedEntry = entry;
    return new Promise<TileDrawable>((resolve, reject) => {
      let settled = false;
      const cleanupRef = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        sharedEntry.refCount -= 1;
      };
      const onAbort = () => {
        if (settled) return;
        cleanupRef();
        if (sharedEntry.refCount <= 0 && (disposed || inFlightTileFetches.size > 64)) {
          sharedEntry.controller.abort();
        }
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      sharedEntry.promise.then(
        (drawable) => {
          if (settled) return;
          cleanupRef();
          resolve(drawable);
        },
        (err) => {
          if (settled) return;
          cleanupRef();
          reject(err);
        }
      );
    });
  };

  const configureAerialTex = (tex: THREE.CanvasTexture): THREE.CanvasTexture => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = maxAnisotropy;
    return tex;
  };

  const syncLayerRelBounds = (
    spec: AerialSlippyMosaicSpec | null,
    relUniform: THREE.IUniform
  ) => {
    if (!spec) return;
    const rel = computeRelativeMercatorPatchBounds(spec.mercBounds, currentMercRef);
    (relUniform.value as THREE.Vector4).set(rel[0], rel[1], rel[2], rel[3]);
  };

  const syncUniformRelBounds = () => {
    syncLayerRelBounds(activeCoarseSpec, earthMat.uniforms.uSatCoarseRelBounds);
    syncLayerRelBounds(activeMidSpec, earthMat.uniforms.uSatMidRelBounds);
    syncLayerRelBounds(activePrevFineSpec, earthMat.uniforms.uSatPrevFineRelBounds);
    syncLayerRelBounds(activeFineSpec, earthMat.uniforms.uSatFineRelBounds);
  };

  const streamAerialMosaic = async (
    spec: AerialSlippyMosaicSpec,
    isCancelled: () => boolean,
    signal?: AbortSignal,
    onProgress?: (tex: THREE.CanvasTexture, drawnCount: number) => void
  ): Promise<{ tex: THREE.CanvasTexture; drawnCount: number }> => {
    const cached = aerialMosaicCache.get(spec.key);
    if (cached) {
      aerialMosaicCache.delete(spec.key);
      aerialMosaicCache.set(spec.key, cached);
      onProgress?.(cached, spec.tiles.length);
      return { tex: cached, drawnCount: spec.tiles.length };
    }

    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas unavailable for satellite mosaic");
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const tex = configureAerialTex(new THREE.CanvasTexture(canvas));
    textureTracker.register(tex);

    let okCount = 0;
    let firstBatchEmitted = false;
    let lastUploadAt = 0;
    const uncachedTiles: typeof spec.tiles = [];

    // Synchronous 0ms cache pre-blit for any overlapping slippy tiles already resident in memory
    for (const cell of spec.tiles) {
      const cachedImg = touchSlippyCached(cell.imageryUrl);
      const cachedLbl = cell.labelsUrl ? touchSlippyCached(cell.labelsUrl) : null;
      if (cachedImg && (!cell.labelsUrl || cachedLbl)) {
        const dx = cell.colOffset * spec.tileSize;
        const dy = cell.rowOffset * spec.tileSize;
        ctx.drawImage(cachedImg, dx, dy, spec.tileSize, spec.tileSize);
        if (cachedLbl) {
          ctx.drawImage(cachedLbl, dx, dy, spec.tileSize, spec.tileSize);
        }
        okCount += 1;
      } else {
        uncachedTiles.push(cell);
      }
    }

    if (okCount > 0) {
      firstBatchEmitted = true;
      lastUploadAt = performance.now();
      tex.needsUpdate = true;
      onProgress?.(tex, okCount);
    }

    let cursor = 0;
    const firstBatchThreshold = Math.min(8, spec.tiles.length);
    const concurrency = 24;

    const runWorker = async () => {
      while (cursor < uncachedTiles.length) {
        if (disposed || isCancelled() || signal?.aborted) {
          throw new Error("Cancelled");
        }
        const idx = cursor++;
        const cell = uncachedTiles[idx]!;
        const [imageryDrawable, labelDrawable] = await Promise.all([
          loadSlippyTileDrawableCached(cell.imageryUrl, signal).catch(() => null),
          cell.labelsUrl
            ? loadSlippyTileDrawableCached(cell.labelsUrl, signal).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (disposed || isCancelled() || signal?.aborted) {
          throw new Error("Cancelled");
        }
        if (imageryDrawable) {
          const dx = cell.colOffset * spec.tileSize;
          const dy = cell.rowOffset * spec.tileSize;
          ctx.drawImage(imageryDrawable, dx, dy, spec.tileSize, spec.tileSize);
          if (labelDrawable) {
            ctx.drawImage(labelDrawable, dx, dy, spec.tileSize, spec.tileSize);
          }
          okCount += 1;
          const now = performance.now();
          if (!firstBatchEmitted && okCount >= firstBatchThreshold) {
            firstBatchEmitted = true;
            lastUploadAt = now;
            tex.needsUpdate = true;
            onProgress?.(tex, okCount);
          } else if (firstBatchEmitted && now - lastUploadAt >= 28) {
            lastUploadAt = now;
            tex.needsUpdate = true;
            onProgress?.(tex, okCount);
          }
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, uncachedTiles.length) }, () =>
          runWorker()
        )
      );
    } catch (err) {
      textureTracker.evictFromCache(tex);
      throw err;
    }

    if (disposed || isCancelled() || signal?.aborted) {
      textureTracker.evictFromCache(tex);
      throw new Error("Cancelled");
    }

    if (okCount < Math.min(4, spec.tiles.length)) {
      textureTracker.evictFromCache(tex);
      throw new Error(`Incomplete satellite mosaic for ${spec.key}`);
    }

    tex.needsUpdate = true;
    if (!firstBatchEmitted) {
      firstBatchEmitted = true;
      onProgress?.(tex, okCount);
    }
    if (okCount >= Math.ceil(spec.tiles.length * 0.75)) {
      insertWithLru(aerialMosaicCache, spec.key, tex, 14);
    }
    return { tex, drawnCount: okCount };
  };

  const bindAerialLayer = (
    mapUniform: THREE.IUniform,
    mercUniform: THREE.IUniform,
    relUniform: THREE.IUniform,
    tex: THREE.Texture,
    spec: AerialSlippyMosaicSpec
  ) => {
    mapUniform.value = tex;
    (mercUniform.value as THREE.Vector4).set(
      spec.mercBounds[0],
      spec.mercBounds[1],
      spec.mercBounds[2],
      spec.mercBounds[3]
    );
    syncLayerRelBounds(spec, relUniform);
  };

  const applyAerialCoarse = (
    tex: THREE.Texture,
    spec: AerialSlippyMosaicSpec
  ) => {
    activeCoarseSpec = spec;
    bindAerialLayer(
      earthMat.uniforms.uSatCoarseMap,
      earthMat.uniforms.uSatCoarseMercBounds,
      earthMat.uniforms.uSatCoarseRelBounds,
      tex,
      spec
    );
    aerialCoarseLoaded = true;
    textureTracker.releaseUnbound();
  };

  const applyAerialMid = (
    tex: THREE.Texture,
    spec: AerialSlippyMosaicSpec
  ) => {
    activeMidSpec = spec;
    bindAerialLayer(
      earthMat.uniforms.uSatMidMap,
      earthMat.uniforms.uSatMidMercBounds,
      earthMat.uniforms.uSatMidRelBounds,
      tex,
      spec
    );
    aerialMidLoaded = true;
    textureTracker.releaseUnbound();
  };

  const applyAerialPrevFine = (
    tex: THREE.Texture,
    spec: AerialSlippyMosaicSpec,
    tileCount: number
  ) => {
    activePrevFineSpec = spec;
    activePrevFineTileCount = tileCount;
    bindAerialLayer(
      earthMat.uniforms.uSatPrevFineMap,
      earthMat.uniforms.uSatPrevFineMercBounds,
      earthMat.uniforms.uSatPrevFineRelBounds,
      tex,
      spec
    );
    aerialPrevFineLoaded = true;
    textureTracker.releaseUnbound();
  };

  const applyAerialFine = (
    tex: THREE.Texture,
    spec: AerialSlippyMosaicSpec,
    tileCount: number
  ) => {
    activeFineSpec = spec;
    activeFineTileCount = tileCount;
    bindAerialLayer(
      earthMat.uniforms.uSatFineMap,
      earthMat.uniforms.uSatFineMercBounds,
      earthMat.uniforms.uSatFineRelBounds,
      tex,
      spec
    );
    aerialFineLoaded = true;
    textureTracker.releaseUnbound();
  };

  const loadWmtsMosaic = async (
    spec: GlobalWmtsMosaicSpec,
    isCancelled: () => boolean,
    trackerSet: Set<HTMLImageElement> = inFlightTileImages,
    progressiveOpts?: {
      seedCanvas?: HTMLCanvasElement;
      onProgress?: (tex: THREE.CanvasTexture) => void;
    }
  ): Promise<THREE.CanvasTexture> => {
    const targetCache = spec.zoom <= 1 ? globalPreviewCache : globalWmtsCache;
    const maxCacheEntries = spec.zoom <= 1 ? 48 : 10;
    const cached = targetCache.get(spec.key);
    if (cached) {
      targetCache.delete(spec.key);
      targetCache.set(spec.key, cached);
      return cached;
    }

    const maxGpuTex = renderer.capabilities.maxTextureSize || 4096;
    const canNative5k = renderer.capabilities.isWebGL2 && maxGpuTex >= 5120;
    const targetW =
      spec.zoom === 0
        ? renderer.capabilities.isWebGL2
          ? 640
          : 1024
        : spec.zoom === 1
          ? renderer.capabilities.isWebGL2
            ? 1280
            : 1024
          : spec.zoom === 3
            ? canNative5k
              ? 5120
              : Math.min(4096, maxGpuTex)
            : renderer.capabilities.isWebGL2
              ? 2560
              : 2048;
    const targetH = Math.round(targetW / 2);
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas unavailable for WMTS mosaic");
    }

    const scaleX = targetW / spec.width;
    const scaleY = targetH / spec.height;
    const concurrency = 24;

    const useProgressive =
      spec.subLayers.length === 1 &&
      spec.zoom >= 2 &&
      Boolean(progressiveOpts?.seedCanvas);
    let progressiveTex: THREE.CanvasTexture | null = null;
    let lastProgUploadAt = 0;
    if (useProgressive && progressiveOpts?.seedCanvas) {
      ctx.drawImage(progressiveOpts.seedCanvas, 0, 0, targetW, targetH);
      progressiveTex = configureGlobalTex(new THREE.CanvasTexture(canvas));
      textureTracker.register(progressiveTex);
    }

    const camPt = vector3ToLatLng(new THREE.Vector3().setFromSpherical(spherical), 3);
    const camCol = ((camPt.lng + 180) / 360) * spec.cols - 0.5;
    const camRow = ((90 - camPt.lat) / 180) * spec.rows - 0.5;

    try {
      for (const sub of spec.subLayers) {
        if (disposed || isCancelled()) {
          throw new Error("Cancelled");
        }
        const tasks: Array<{ row: number; col: number }> = [];
        for (let row = 0; row < spec.rows; row++) {
          for (let col = 0; col < spec.cols; col++) {
            tasks.push({ row, col });
          }
        }
        tasks.sort((a, b) => {
          const rawDa = Math.abs(a.col - camCol);
          const wrapDa = Math.min(rawDa, spec.cols - rawDa);
          const rawDb = Math.abs(b.col - camCol);
          const wrapDb = Math.min(rawDb, spec.cols - rawDb);
          const da = wrapDa * wrapDa + (a.row - camRow) ** 2;
          const db = wrapDb * wrapDb + (b.row - camRow) ** 2;
          return da - db;
        });

        let cursor = 0;
        let okCount = 0;
        let useFallback = false;

        const runWorker = async () => {
          while (cursor < tasks.length) {
            if (disposed || isCancelled()) {
              throw new Error("Cancelled");
            }
            const idx = cursor++;
            const { row, col } = tasks[idx]!;
            let img: HTMLImageElement | null = null;
            try {
              img = await loadTileImage(
                buildWmtsTileUrl(sub, spec.zoom, row, col, useFallback),
                trackerSet
              );
            } catch {
              if (
                !useFallback &&
                !sub.timeless &&
                sub.dateIso !== sub.fallbackDateIso
              ) {
                useFallback = true;
                try {
                  img = await loadTileImage(
                    buildWmtsTileUrl(sub, spec.zoom, row, col, true),
                    trackerSet
                  );
                } catch {
                  img = null;
                }
              }
            }
            if (disposed || isCancelled()) {
              throw new Error("Cancelled");
            }
            if (img) {
              if (progressiveTex) {
                const dx = Math.round(col * spec.tileSize * scaleX);
                const dy = Math.round(row * spec.tileSize * scaleY);
                const dw = Math.round((col + 1) * spec.tileSize * scaleX) - dx;
                const dh = Math.round((row + 1) * spec.tileSize * scaleY) - dy;
                ctx.clearRect(dx, dy, dw, dh);
                ctx.drawImage(img, dx, dy, dw, dh);
                const now = performance.now();
                if (now - lastProgUploadAt >= 45) {
                  lastProgUploadAt = now;
                  progressiveTex.needsUpdate = true;
                  progressiveOpts?.onProgress?.(progressiveTex);
                }
              } else {
                ctx.drawImage(
                  img,
                  col * spec.tileSize * scaleX,
                  row * spec.tileSize * scaleY,
                  spec.tileSize * scaleX,
                  spec.tileSize * scaleY
                );
              }
              okCount += 1;
            }
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(concurrency, tasks.length) }, () => runWorker())
        );
        if (okCount / tasks.length < 0.8) {
          throw new Error(`Incomplete WMTS mosaic for ${spec.key}`);
        }
      }
    } catch (err) {
      if (progressiveTex) {
        textureTracker.evictFromCache(progressiveTex);
      }
      throw err;
    }

    if (progressiveTex) {
      progressiveTex.needsUpdate = true;
      insertWithLru(targetCache, spec.key, progressiveTex, maxCacheEntries);
      return progressiveTex;
    }
    const tex = configureGlobalTex(new THREE.CanvasTexture(canvas));
    insertWithLru(targetCache, spec.key, tex, maxCacheEntries);
    return tex;
  };

  const loadGlobalTexPromise = (spec: GlobalLayerSpec): Promise<THREE.Texture> => {
    const cached = globalGibsCache.get(spec.key);
    if (cached) {
      globalGibsCache.delete(spec.key);
      globalGibsCache.set(spec.key, cached);
      return Promise.resolve(cached);
    }
    if ((failedGlobalUntil.get(spec.key) ?? 0) > Date.now()) {
      return Promise.reject(new Error("Global layer cooldown"));
    }
    return new Promise((resolve, reject) => {
      gibsLoader.load(
        spec.proxyUrl,
        (tex) => {
          if (disposed) {
            tex.dispose();
            reject(new Error("Disposed"));
            return;
          }
          failedGlobalUntil.delete(spec.key);
          configureGlobalTex(tex);
          insertWithLru(globalGibsCache, spec.key, tex, 12);
          resolve(tex);
        },
        undefined,
        () => {
          failedGlobalUntil.set(spec.key, Date.now() + 15_000);
          reject(new Error(`Failed to load ${spec.key}`));
        }
      );
    });
  };

  const syncGlobalMode = (
    mode: RegionalSatelliteMode,
    topics?: readonly ETGDatasetId[],
    cutoffMsVal?: number
  ) => {
    if (mode === "multi_slice") {
      const modeSig = "multi_slice";
      if (activeModeSignature !== modeSig) {
        activeModeSignature = modeSig;
        pendingPreviewJob = null;
        clearHdUpgradeTimer();
        abortInFlightPreviewImages();
        abortInFlightGlobalHdImages();
      }

      const windsSpec = computeGlobalLayerSpec({ layerId: "winds", cutoffMs: cutoffMsVal });
      const precipSpec = computeGlobalLayerSpec({ layerId: "precip", cutoffMs: cutoffMsVal });
      const cloudsSpec = computeGlobalLayerSpec({ layerId: "true_color", cutoffMs: cutoffMsVal });
      const windsPreview = computeGlobalWmtsMosaicSpec({
        layerId: "winds",
        cutoffMs: cutoffMsVal,
        zoomOverride: 0,
      });
      const precipPreview = computeGlobalWmtsMosaicSpec({
        layerId: "precip",
        cutoffMs: cutoffMsVal,
        zoomOverride: 0,
      });
      const cloudsPreview = computeGlobalWmtsMosaicSpec({
        layerId: "true_color",
        cutoffMs: cutoffMsVal,
        zoomOverride: 0,
      });
      const windsWmts = computeGlobalWmtsMosaicSpec({
        layerId: "winds",
        cutoffMs: cutoffMsVal,
        zoomOverride: 2,
      });
      const precipWmts = computeGlobalWmtsMosaicSpec({
        layerId: "precip",
        cutoffMs: cutoffMsVal,
        zoomOverride: 2,
      });
      const cloudsWmts = computeGlobalWmtsMosaicSpec({
        layerId: "true_color",
        cutoffMs: cutoffMsVal,
        zoomOverride: 3,
      });
      const reqKey = `multi_slice:${windsWmts.key}:${precipWmts.key}:${cloudsWmts.key}`;
      if (desiredGlobalKey === reqKey && globalTexLoaded) {
        return;
      }
      desiredGlobalKey = reqKey;
      activeGlobalKey = reqKey;
      hdAppliedForDesired = false;
      const mySeq = ++globalReqSeq;
      clearHdUpgradeTimer();
      abortInFlightGlobalHdImages();
      ensureBordersLoaded();

      const applyMultiSlice = (texW: THREE.Texture, texP: THREE.Texture, texC: THREE.Texture) => {
        earthMat.uniforms.uSliceWindsMap.value = texW;
        earthMat.uniforms.uSlicePrecipMap.value = texP;
        earthMat.uniforms.uSliceCloudsMap.value = texC;
        earthMat.uniforms.uGlobalFilterMode.value = 10.0;
        earthMat.uniforms.uGlobalDataMode.value = 1.0;
        globalTexLoaded = true;
        textureTracker.releaseUnbound();
      };

      const cachedWmW = globalWmtsCache.get(windsWmts.key);
      const cachedWmP = globalWmtsCache.get(precipWmts.key);
      const cachedWmC = globalWmtsCache.get(cloudsWmts.key);
      if (cachedWmW && cachedWmP && cachedWmC) {
        globalWmtsCache.delete(windsWmts.key);
        globalWmtsCache.set(windsWmts.key, cachedWmW);
        globalWmtsCache.delete(precipWmts.key);
        globalWmtsCache.set(precipWmts.key, cachedWmP);
        globalWmtsCache.delete(cloudsWmts.key);
        globalWmtsCache.set(cloudsWmts.key, cachedWmC);
        pendingPreviewJob = null;
        hdAppliedForDesired = true;
        applyMultiSlice(cachedWmW, cachedWmP, cachedWmC);
        setGlobalHud({
          loading: false,
          error: false,
          dateIso: cloudsWmts.primaryDateIso,
          resBadge: "5K HD",
        });
        return;
      }

      const isHdCancelled = () =>
        disposed || desiredGlobalKey !== reqKey || mySeq !== globalReqSeq;

      const scheduleMultiHdUpgrade = () => {
        clearHdUpgradeTimer();
        hdUpgradeTimer = window.setTimeout(() => {
          hdUpgradeTimer = null;
          if (isHdCancelled()) return;
          Promise.all([
            loadWmtsMosaic(windsWmts, isHdCancelled, inFlightGlobalHdImages),
            loadWmtsMosaic(precipWmts, isHdCancelled, inFlightGlobalHdImages),
            loadWmtsMosaic(cloudsWmts, isHdCancelled, inFlightGlobalHdImages),
          ])
            .then(([wmW, wmP, wmC]) => {
              if (isHdCancelled()) return;
              hdAppliedForDesired = true;
              applyMultiSlice(wmW, wmP, wmC);
              setGlobalHud({
                loading: false,
                error: false,
                dateIso: cloudsWmts.primaryDateIso,
                resBadge: "5K HD",
              });
            })
            .catch(() => {
              if (isHdCancelled()) return;
              if (globalTexLoaded) {
                setGlobalHud((prev) => ({
                  ...prev,
                  loading: false,
                  error: false,
                  resBadge: prev.resBadge === "Loading" ? "Live" : prev.resBadge.replace(/…$/, ""),
                }));
              } else {
                activeGlobalKey = "";
                desiredGlobalKey = "";
                setGlobalHud((prev) => ({
                  ...prev,
                  loading: false,
                  error: true,
                  resBadge: "",
                }));
              }
            });
        }, 380);
      };

      const cachedPreW = globalPreviewCache.get(windsPreview.key);
      const cachedPreP = globalPreviewCache.get(precipPreview.key);
      const cachedPreC = globalPreviewCache.get(cloudsPreview.key);
      if (cachedPreW && cachedPreP && cachedPreC) {
        pendingPreviewJob = null;
        applyMultiSlice(cachedPreW, cachedPreP, cachedPreC);
        setGlobalHud({
          loading: true,
          error: false,
          dateIso: cloudsPreview.primaryDateIso,
          resBadge: "Live…",
        });
        scheduleMultiHdUpgrade();
        return;
      }

      const cachedW = globalGibsCache.get(windsSpec.key);
      const cachedP = globalGibsCache.get(precipSpec.key);
      const cachedC = globalGibsCache.get(cloudsSpec.key);
      if (cachedW && cachedP && cachedC) {
        pendingPreviewJob = null;
        applyMultiSlice(cachedW, cachedP, cachedC);
        setGlobalHud({
          loading: true,
          error: false,
          dateIso: cloudsSpec.dateIso,
          resBadge: "2K…",
        });
        scheduleMultiHdUpgrade();
        return;
      }

      setGlobalHud((prev) => ({
        loading: true,
        error: false,
        dateIso: cloudsPreview.primaryDateIso,
        resBadge: prev.resBadge || "Loading",
      }));
      scheduleMultiHdUpgrade();

      const isPreviewCancelled = () =>
        disposed || activeModeSignature !== modeSig;
      enqueuePreviewJob(async () => {
        if (isPreviewCancelled()) return;
        try {
          const [pW, pP, pC] = await Promise.all([
            loadWmtsMosaic(windsPreview, isPreviewCancelled, inFlightPreviewImages),
            loadWmtsMosaic(precipPreview, isPreviewCancelled, inFlightPreviewImages),
            loadWmtsMosaic(cloudsPreview, isPreviewCancelled, inFlightPreviewImages),
          ]);
          if (isPreviewCancelled() || hdAppliedForDesired) return;
          applyMultiSlice(pW, pP, pC);
          setGlobalHud((prev) => ({
            loading: !hdAppliedForDesired && prev.loading,
            error: false,
            dateIso: cloudsPreview.primaryDateIso,
            resBadge: hdAppliedForDesired ? "5K HD" : "Live…",
          }));
        } catch {
          if (isPreviewCancelled() || desiredGlobalKey !== reqKey || hdAppliedForDesired) return;
          try {
            const [texW, texP, texC] = await Promise.all([
              loadGlobalTexPromise(windsSpec),
              loadGlobalTexPromise(precipSpec),
              loadGlobalTexPromise(cloudsSpec),
            ]);
            if (isPreviewCancelled() || hdAppliedForDesired) return;
            applyMultiSlice(texW, texP, texC);
            setGlobalHud((prev) => ({
              loading: !hdAppliedForDesired && prev.loading,
              error: false,
              dateIso: cloudsSpec.dateIso,
              resBadge: hdAppliedForDesired ? "5K HD" : "2K…",
            }));
          } catch {
            // HD timer will resolve or mark error
          }
        }
      });
      return;
    }

    const layerId = resolveGlobalFilterLayer(mode, topics);
    if (!layerId) {
      activeModeSignature = "off";
      desiredGlobalKey = "";
      activeGlobalKey = "";
      hdAppliedForDesired = false;
      globalTexLoaded = false;
      pendingPreviewJob = null;
      clearHdUpgradeTimer();
      abortInFlightPreviewImages();
      abortInFlightGlobalHdImages();
      earthMat.uniforms.uGlobalFilterMode.value = 0.0;
      setGlobalHud({ loading: false, error: false, dateIso: "", resBadge: "" });
      return;
    }

    const modeSig = `single:${layerId}`;
    if (activeModeSignature !== modeSig) {
      activeModeSignature = modeSig;
      pendingPreviewJob = null;
      clearHdUpgradeTimer();
      abortInFlightPreviewImages();
      abortInFlightGlobalHdImages();
    }

    const previewSpec = computeGlobalWmtsMosaicSpec({
      layerId,
      cutoffMs: cutoffMsVal,
      zoomOverride: 0,
    });
    const wmtsSpec = computeGlobalWmtsMosaicSpec({ layerId, cutoffMs: cutoffMsVal });
    const spec = computeGlobalLayerSpec({ layerId, cutoffMs: cutoffMsVal });

    if (desiredGlobalKey === wmtsSpec.key && globalTexLoaded) {
      return;
    }
    desiredGlobalKey = wmtsSpec.key;
    activeGlobalKey = wmtsSpec.key;
    hdAppliedForDesired = false;
    const mySeq = ++globalReqSeq;
    clearHdUpgradeTimer();
    abortInFlightGlobalHdImages();
    ensureBordersLoaded();

    const applySingleGlobal = (tex: THREE.Texture, width: number, height: number) => {
      (earthMat.uniforms.uGlobalTexSize.value as THREE.Vector2).set(width, height);
      earthMat.uniforms.uGlobalLayerMap.value = tex;
      earthMat.uniforms.uGlobalFilterMode.value = GIBS_LAYERS[layerId].shaderMode;
      earthMat.uniforms.uGlobalDataMode.value = GIBS_LAYERS[layerId].isDataLayer ? 1.0 : 0.0;
      globalTexLoaded = true;
      textureTracker.releaseUnbound();
    };

    const cachedWmts = globalWmtsCache.get(wmtsSpec.key);
    if (cachedWmts) {
      globalWmtsCache.delete(wmtsSpec.key);
      globalWmtsCache.set(wmtsSpec.key, cachedWmts);
      pendingPreviewJob = null;
      hdAppliedForDesired = true;
      const wmtsImg = cachedWmts.image as HTMLCanvasElement | undefined;
      applySingleGlobal(
        cachedWmts,
        wmtsImg?.width ?? wmtsSpec.width,
        wmtsImg?.height ?? wmtsSpec.height
      );
      setGlobalHud({
        loading: false,
        error: false,
        dateIso: wmtsSpec.primaryDateIso,
        resBadge: wmtsSpec.badgeLabel,
      });
      return;
    }

    const isHdCancelled = () =>
      disposed || desiredGlobalKey !== wmtsSpec.key || mySeq !== globalReqSeq;

    const scheduleHdUpgrade = () => {
      clearHdUpgradeTimer();
      hdUpgradeTimer = window.setTimeout(() => {
        hdUpgradeTimer = null;
        if (isHdCancelled()) return;
        const seedCanvas = globalPreviewCache.get(previewSpec.key)?.image as
          | HTMLCanvasElement
          | undefined;
        loadWmtsMosaic(wmtsSpec, isHdCancelled, inFlightGlobalHdImages, {
          seedCanvas,
          onProgress: (progTex) => {
            if (isHdCancelled()) return;
            const progImg = progTex.image as HTMLCanvasElement | undefined;
            applySingleGlobal(
              progTex,
              progImg?.width ?? wmtsSpec.width,
              progImg?.height ?? wmtsSpec.height
            );
            setGlobalHud({
              loading: true,
              error: false,
              dateIso: wmtsSpec.primaryDateIso,
              resBadge: `${wmtsSpec.badgeLabel}…`,
            });
          },
        })
          .then((wmtsTex) => {
            if (isHdCancelled()) return;
            hdAppliedForDesired = true;
            const wmtsImg = wmtsTex.image as HTMLCanvasElement | undefined;
            applySingleGlobal(
              wmtsTex,
              wmtsImg?.width ?? wmtsSpec.width,
              wmtsImg?.height ?? wmtsSpec.height
            );
            setGlobalHud({
              loading: false,
              error: false,
              dateIso: wmtsSpec.primaryDateIso,
              resBadge: wmtsSpec.badgeLabel,
            });
          })
          .catch(() => {
            if (isHdCancelled()) return;
            if (globalTexLoaded) {
              setGlobalHud((prev) => ({
                ...prev,
                loading: false,
                error: false,
                resBadge: prev.resBadge === "Loading" ? "Live" : prev.resBadge.replace(/…$/, ""),
              }));
            } else {
              activeGlobalKey = "";
              desiredGlobalKey = "";
              setGlobalHud((prev) => ({
                ...prev,
                loading: false,
                error: true,
                resBadge: "",
              }));
            }
          });
      }, 380);
    };

    const cachedPreview = globalPreviewCache.get(previewSpec.key);
    if (cachedPreview) {
      globalPreviewCache.delete(previewSpec.key);
      globalPreviewCache.set(previewSpec.key, cachedPreview);
      pendingPreviewJob = null;
      const previewImg = cachedPreview.image as HTMLCanvasElement | undefined;
      applySingleGlobal(
        cachedPreview,
        previewImg?.width ?? previewSpec.width,
        previewImg?.height ?? previewSpec.height
      );
      setGlobalHud({
        loading: true,
        error: false,
        dateIso: previewSpec.primaryDateIso,
        resBadge: "Live…",
      });
      scheduleHdUpgrade();
      return;
    }

    const cached = globalGibsCache.get(spec.key);
    if (cached) {
      globalGibsCache.delete(spec.key);
      globalGibsCache.set(spec.key, cached);
      pendingPreviewJob = null;
      applySingleGlobal(cached, 2048, 1024);
      setGlobalHud({
        loading: true,
        error: false,
        dateIso: spec.dateIso,
        resBadge: "2K…",
      });
      scheduleHdUpgrade();
      return;
    }

    setGlobalHud((prev) => ({
      loading: true,
      error: false,
      dateIso: previewSpec.primaryDateIso,
      resBadge: prev.resBadge || "Loading",
    }));
    scheduleHdUpgrade();

    const isPreviewCancelled = () =>
      disposed || activeModeSignature !== modeSig;
    enqueuePreviewJob(async () => {
      if (isPreviewCancelled()) return;
      try {
        const previewTex = await loadWmtsMosaic(
          previewSpec,
          isPreviewCancelled,
          inFlightPreviewImages
        );
        if (isPreviewCancelled() || hdAppliedForDesired) return;
        const previewImg = previewTex.image as HTMLCanvasElement | undefined;
        applySingleGlobal(
          previewTex,
          previewImg?.width ?? previewSpec.width,
          previewImg?.height ?? previewSpec.height
        );
        setGlobalHud((prev) => ({
          loading: !hdAppliedForDesired && prev.loading,
          error: false,
          dateIso: previewSpec.primaryDateIso,
          resBadge: hdAppliedForDesired ? wmtsSpec.badgeLabel : "Live…",
        }));
      } catch {
        if (isPreviewCancelled() || desiredGlobalKey !== wmtsSpec.key || hdAppliedForDesired) {
          return;
        }
        try {
          const wmsTex = await loadGlobalTexPromise(spec);
          if (isPreviewCancelled() || hdAppliedForDesired) return;
          applySingleGlobal(wmsTex, 2048, 1024);
          setGlobalHud((prev) => ({
            loading: !hdAppliedForDesired && prev.loading,
            error: false,
            dateIso: spec.dateIso,
            resBadge: hdAppliedForDesired ? wmtsSpec.badgeLabel : "2K…",
          }));
        } catch {
          // HD timer will resolve or mark error
        }
      }
    });
  };

  const applyRegionalTexture = (tex: THREE.Texture, spec: RegionalTileSpec) => {
    earthMat.uniforms.uRegionalMap.value = tex;
    (earthMat.uniforms.uRegionalBounds.value as THREE.Vector4).set(
      spec.bounds[0],
      spec.bounds[1],
      spec.bounds[2],
      spec.bounds[3]
    );
    earthMat.uniforms.uRegionalDataMode.value = GIBS_LAYERS[spec.layerId].isDataLayer
      ? 1.0
      : 0.0;
    regionalTexLoaded = true;
    textureTracker.releaseUnbound();
  };

  const loadRegionalSpec = (
    spec: RegionalTileSpec,
    swathKm: number,
    centerLat: number,
    centerLng: number
  ) => {
    const altitudeKm = estimateCameraAltitudeKm(spherical.radius);
    const depthTier = resolveSatelliteDepthTier(spherical.radius);
    const cached = gibsCache.get(spec.key);
    if (cached) {
      gibsCache.delete(spec.key);
      gibsCache.set(spec.key, cached);
      applyRegionalTexture(cached, spec);
      setRegionalHud((prev) => ({
        ...prev,
        layerId: spec.layerId,
        dateIso: spec.dateIso,
        swathKm,
        tier: spec.tier,
        aerialActive: false,
        altitudeKm,
        depthTier,
        loading: false,
        error: false,
        centerLat,
        centerLng,
      }));
      return;
    }

    if ((failedTileUntil.get(spec.key) ?? 0) > Date.now()) {
      setRegionalHud((prev) => ({
        ...prev,
        layerId: spec.layerId,
        dateIso: spec.dateIso,
        swathKm,
        tier: spec.tier,
        aerialActive: false,
        altitudeKm,
        depthTier,
        loading: false,
        error: true,
        centerLat,
        centerLng,
      }));
      return;
    }

    if (lastRequestedTileKey === spec.key) {
      return;
    }
    lastRequestedTileKey = spec.key;
    const mySeq = ++gibsReqSeq;
    setRegionalHud((prev) => ({
      ...prev,
      layerId: spec.layerId,
      dateIso: spec.dateIso,
      swathKm,
      tier: spec.tier,
      aerialActive: false,
      altitudeKm,
      depthTier,
      loading: true,
      error: false,
      centerLat,
      centerLng,
    }));

    gibsLoader.load(
      spec.proxyUrl,
      (tex) => {
        if (disposed) {
          tex.dispose();
          return;
        }
        failedTileUntil.delete(spec.key);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.anisotropy = maxAnisotropy;

        insertWithLru(gibsCache, spec.key, tex, 14);

        if (mySeq !== gibsReqSeq || activeGibsLayerRef.current !== spec.layerId) {
          return;
        }
        applyRegionalTexture(tex, spec);
        setRegionalHud((prev) => ({
          ...prev,
          layerId: spec.layerId,
          dateIso: spec.dateIso,
          aerialActive: false,
          loading: false,
          error: false,
        }));
      },
      undefined,
      () => {
        if (disposed || mySeq !== gibsReqSeq) return;
        failedTileUntil.set(spec.key, Date.now() + 15_000);
        if (lastRequestedTileKey === spec.key) {
          lastRequestedTileKey = "";
        }
        setRegionalHud((prev) => ({
          ...prev,
          loading: false,
          error: true,
        }));
      }
    );
  };

  const promoteFineToPrevFineIfReady = (nextKey: string) => {
    if (!aerialFineLoaded || !activeFineSpec || activeFineSpec.key === nextKey) {
      return;
    }
    const minPromotable = Math.min(24, Math.ceil(activeFineSpec.tiles.length * 0.25));
    if (
      !aerialPrevFineLoaded ||
      activeFineTileCount >= minPromotable ||
      activeFineTileCount > activePrevFineTileCount
    ) {
      applyAerialPrevFine(
        earthMat.uniforms.uSatFineMap.value,
        activeFineSpec,
        activeFineTileCount
      );
      earthMat.uniforms.uSatPrevFineBlend.value = 1.0;
    }
  };

  const maxAerialGpuTex = renderer.capabilities.maxTextureSize || 4096;
  const fineGridSize = maxAerialGpuTex >= 3072 ? DEFAULT_AERIAL_GRID_SIZE : 8;
  const backdropGridSize = maxAerialGpuTex >= 2560 ? BACKDROP_AERIAL_GRID_SIZE : 8;

  const triggerAerialLoad = (
    spec: AerialSlippyMosaicSpec,
    subPt: { lat: number; lng: number },
    aerialPrimary: boolean
  ) => {
    const cached = aerialMosaicCache.get(spec.key);
    if (cached) {
      aerialMosaicCache.delete(spec.key);
      aerialMosaicCache.set(spec.key, cached);
      if (activeFineSpec && activeFineSpec.key !== spec.key && aerialFineLoaded) {
        promoteFineToPrevFineIfReady(spec.key);
        earthMat.uniforms.uSatFineBlend.value = 0.0;
      }
      applyAerialFine(cached, spec, spec.tiles.length);
      lastZoomLevel = Math.max(lastZoomLevel, spec.zoom);
      if (aerialPrimary) {
        setRegionalHud((prev) => ({
          ...prev,
          layerId: null,
          aerialActive: true,
          aerialZoom: spec.zoom,
          aerialResolutionLabel: spec.resolutionLabel,
          altitudeKm: estimateCameraAltitudeKm(spherical.radius),
          depthTier: resolveSatelliteDepthTier(spherical.radius),
          swathKm: estimateRegionalSwathKm(spherical.radius),
          loading: false,
          error: false,
          centerLat: subPt.lat,
          centerLng: subPt.lng,
        }));
      }
      return;
    }

    if (lastRequestedAerialKey === spec.key) {
      return;
    }
    lastRequestedAerialKey = spec.key;
    activeAerialAbortController?.abort();
    const myAbortController = new AbortController();
    activeAerialAbortController = myAbortController;
    const mySeq = ++aerialReqSeq;
    const prevZoom = activeFineSpec?.zoom ?? lastZoomLevel;
    lastZoomLevel = spec.zoom;

    if (aerialFineLoaded && activeFineSpec && activeFineSpec.key !== spec.key) {
      promoteFineToPrevFineIfReady(spec.key);
      aerialFineLoaded = false;
      activeFineTileCount = 0;
      earthMat.uniforms.uSatFineBlend.value = 0.0;
      textureTracker.releaseUnbound();
    }

    const { mercX, mercY } = latLngToNormalizedMercator(subPt.lat, subPt.lng);
    const zCoarse = Math.max(4, spec.zoom - 5);
    const needCoarseRefresh =
      spec.zoom >= 6 &&
      (!aerialCoarseLoaded ||
        !activeCoarseSpec ||
        Math.abs(activeCoarseSpec.zoom - zCoarse) >= 2 ||
        !isMercatorPointComfortablyInsideMosaic(mercX, mercY, activeCoarseSpec));

    if (needCoarseRefresh) {
      const coarseSpec = computeAerialSlippyMosaicSpec({
        lat: subPt.lat,
        lng: subPt.lng,
        cameraRadius: spherical.radius,
        includeLabels: false,
        zoomOverride: zCoarse,
        gridSize: backdropGridSize,
      });
      if (coarseSpec && coarseSpec.key !== activeCoarseSpec?.key) {
        const cachedCoarse = aerialMosaicCache.get(coarseSpec.key);
        if (cachedCoarse) {
          applyAerialCoarse(cachedCoarse, coarseSpec);
        } else {
          const cSeq = ++coarseAerialReqSeq;
          streamAerialMosaic(
            coarseSpec,
            () => disposed || cSeq !== coarseAerialReqSeq
          )
            .then(({ tex: coarseTex }) => {
              if (disposed || cSeq !== coarseAerialReqSeq) return;
              applyAerialCoarse(coarseTex, coarseSpec);
            })
            .catch(() => {});
        }
      }
    }

    const zMid = Math.max(4, spec.zoom - 2);
    const needMidBackdrop =
      spec.zoom >= 6 &&
      (!aerialMidLoaded ||
        !activeMidSpec ||
        activeMidSpec.zoom !== zMid ||
        !isMercatorPointComfortablyInsideMosaic(mercX, mercY, activeMidSpec));

    if (needMidBackdrop) {
      const midSpec = computeAerialSlippyMosaicSpec({
        lat: subPt.lat,
        lng: subPt.lng,
        cameraRadius: spherical.radius,
        includeLabels: false,
        zoomOverride: zMid,
        gridSize: backdropGridSize,
      });
      if (midSpec && midSpec.key !== activeMidSpec?.key) {
        const cachedMid = aerialMosaicCache.get(midSpec.key);
        if (cachedMid) {
          applyAerialMid(cachedMid, midSpec);
        } else {
          const mSeq = ++midAerialReqSeq;
          streamAerialMosaic(midSpec, () => disposed || mSeq !== midAerialReqSeq)
            .then(({ tex: midTex }) => {
              if (disposed || mSeq !== midAerialReqSeq) return;
              applyAerialMid(midTex, midSpec);
            })
            .catch(() => {});
        }
      }
    }

    if (aerialPrimary) {
      setRegionalHud((prev) => ({
        ...prev,
        layerId: null,
        aerialActive: true,
        aerialZoom: spec.zoom,
        aerialResolutionLabel: spec.resolutionLabel,
        altitudeKm: estimateCameraAltitudeKm(spherical.radius),
        depthTier: resolveSatelliteDepthTier(spherical.radius),
        swathKm: estimateRegionalSwathKm(spherical.radius),
        loading: true,
        error: false,
        centerLat: subPt.lat,
        centerLng: subPt.lng,
      }));
    }

    streamAerialMosaic(
      spec,
      () => disposed || mySeq !== aerialReqSeq,
      myAbortController.signal,
      (partialTex, drawnCount) => {
        if (disposed || mySeq !== aerialReqSeq) return;
        if (!shouldRenderAerialUnderlay(satelliteModeRef.current)) return;
        if (earthMat.uniforms.uSatFineMap.value !== partialTex) {
          earthMat.uniforms.uSatFineBlend.value = 0.0;
        }
        applyAerialFine(partialTex, spec, drawnCount);
      }
    )
      .then(({ tex, drawnCount }) => {
        if (disposed || mySeq !== aerialReqSeq) return;
        if (!shouldRenderAerialUnderlay(satelliteModeRef.current)) return;
        if (earthMat.uniforms.uSatFineMap.value !== tex) {
          earthMat.uniforms.uSatFineBlend.value = 0.0;
        }
        applyAerialFine(tex, spec, drawnCount);
        if (
          shouldUseCloudFreeAerialPrimary(
            satelliteModeRef.current,
            activeTopicsRef.current
          )
        ) {
          setRegionalHud((prev) => ({
            ...prev,
            layerId: null,
            aerialActive: true,
            aerialZoom: spec.zoom,
            aerialResolutionLabel: spec.resolutionLabel,
            altitudeKm: estimateCameraAltitudeKm(spherical.radius),
            depthTier: resolveSatelliteDepthTier(spherical.radius),
            swathKm: estimateRegionalSwathKm(spherical.radius),
            loading: false,
            error: false,
          }));
        }

        // Prefetch central 4x4 tiles for z+1 (and 2x2 for z+2) when zooming inward
        if (spec.zoom >= 6 && spec.zoom < 18 && spec.zoom >= prevZoom) {
          const childSpec1 = computeAerialSlippyMosaicSpec({
            lat: subPt.lat,
            lng: subPt.lng,
            cameraRadius: spherical.radius,
            includeLabels: false,
            zoomOverride: Math.min(18, spec.zoom + 1),
            gridSize: fineGridSize,
          });
          if (childSpec1) {
            for (const cell of childSpec1.tiles.slice(0, 16)) {
              void loadSlippyTileDrawableCached(cell.imageryUrl).catch(() => {});
            }
          }
          if (spec.zoom + 2 <= 18) {
            const childSpec2 = computeAerialSlippyMosaicSpec({
              lat: subPt.lat,
              lng: subPt.lng,
              cameraRadius: spherical.radius,
              includeLabels: false,
              zoomOverride: spec.zoom + 2,
              gridSize: fineGridSize,
            });
            if (childSpec2) {
              for (const cell of childSpec2.tiles.slice(0, 4)) {
                void loadSlippyTileDrawableCached(cell.imageryUrl).catch(() => {});
              }
            }
          }
        }
      })
      .catch((err) => {
        if (disposed || mySeq !== aerialReqSeq) return;
        if (
          err instanceof Error &&
          (err.message === "Cancelled" || err.name === "AbortError")
        ) {
          return;
        }
        if (lastRequestedAerialKey === spec.key) {
          lastRequestedAerialKey = "";
        }
        if (
          shouldUseCloudFreeAerialPrimary(
            satelliteModeRef.current,
            activeTopicsRef.current
          )
        ) {
          setRegionalHud((prev) => ({
            ...prev,
            loading: false,
            error:
              !aerialCoarseLoaded &&
              !aerialMidLoaded &&
              !aerialPrevFineLoaded &&
              !aerialFineLoaded,
          }));
        }
      });
  };

  const syncRegionalTile = (force = false) => {
    if (disposed) return;
    if (spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS) return;
    const subVec = new THREE.Vector3().setFromSpherical(spherical);
    const subPt = vector3ToLatLng(subVec, 6);
    const swathKm = estimateRegionalSwathKm(spherical.radius);
    const altitudeKm = estimateCameraAltitudeKm(spherical.radius);
    const depthTier = resolveSatelliteDepthTier(spherical.radius);
    const mode = satelliteModeRef.current;
    const topics = activeTopicsRef.current;
    const includeLabels = Boolean(showPlaceLabelsRef.current);
    const aerialPrimary = shouldUseCloudFreeAerialPrimary(mode, topics);
    const useAerialUnderlay = shouldRenderAerialUnderlay(mode);
    const activeLayerId = activeGibsLayerRef.current;

    let effectiveAerialSpec: AerialSlippyMosaicSpec | null = null;
    let aerialPending = false;
    if (useAerialUnderlay && Math.abs(subPt.lat) <= 85.05) {
      const targetSpec = computeAerialSlippyMosaicSpec({
        lat: subPt.lat,
        lng: subPt.lng,
        cameraRadius: spherical.radius,
        includeLabels,
        gridSize: fineGridSize,
      });
      const { mercX, mercY } = latLngToNormalizedMercator(subPt.lat, subPt.lng);
      const keepCurrentFine =
        !force &&
        activeFineSpec !== null &&
        targetSpec !== null &&
        activeFineSpec.zoom === targetSpec.zoom &&
        activeFineSpec.includeLabels === targetSpec.includeLabels &&
        isMercatorPointComfortablyInsideMosaic(mercX, mercY, activeFineSpec);
      effectiveAerialSpec = keepCurrentFine ? activeFineSpec : targetSpec;

      if (effectiveAerialSpec) {
        const isLoaded =
          aerialFineLoaded && activeFineSpec?.key === effectiveAerialSpec.key;
        if (force || aerialMosaicCache.has(effectiveAerialSpec.key)) {
          if (aerialDebounceTimer !== null) {
            window.clearTimeout(aerialDebounceTimer);
            aerialDebounceTimer = null;
          }
          if (!isLoaded || force) {
            triggerAerialLoad(effectiveAerialSpec, subPt, aerialPrimary);
          }
        } else if (
          !keepCurrentFine &&
          effectiveAerialSpec.key !== lastRequestedAerialKey
        ) {
          aerialPending = true;
          if (aerialDebounceTimer !== null) {
            window.clearTimeout(aerialDebounceTimer);
          }
          const scheduledSpec = effectiveAerialSpec;
          aerialDebounceTimer = window.setTimeout(() => {
            aerialDebounceTimer = null;
            if (disposed || spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS) return;
            const latestVec = new THREE.Vector3().setFromSpherical(spherical);
            const latestPt = vector3ToLatLng(latestVec, 6);
            const latestSpec =
              Math.abs(latestPt.lat) <= 85.05
                ? computeAerialSlippyMosaicSpec({
                    lat: latestPt.lat,
                    lng: latestPt.lng,
                    cameraRadius: spherical.radius,
                    includeLabels: Boolean(showPlaceLabelsRef.current),
                    gridSize: fineGridSize,
                  })
                : null;
            triggerAerialLoad(latestSpec ?? scheduledSpec, latestPt, aerialPrimary);
          }, 12);
        }
      }
    } else {
      aerialReqSeq += 1;
      coarseAerialReqSeq += 1;
      midAerialReqSeq += 1;
      activeAerialAbortController?.abort();
      activeAerialAbortController = null;
      if (aerialDebounceTimer !== null) {
        window.clearTimeout(aerialDebounceTimer);
        aerialDebounceTimer = null;
      }
      aerialCoarseLoaded = false;
      aerialMidLoaded = false;
      aerialPrevFineLoaded = false;
      aerialFineLoaded = false;
      activeCoarseSpec = null;
      activeMidSpec = null;
      activePrevFineSpec = null;
      activeFineSpec = null;
      activePrevFineTileCount = 0;
      activeFineTileCount = 0;
      lastRequestedAerialKey = "";
    }

    const displayAerialSpec = effectiveAerialSpec ?? activeFineSpec;
    const aerialZoom =
      displayAerialSpec?.zoom ??
      selectAerialSlippyZoom(spherical.radius, subPt.lat);
    const aerialResolutionLabel =
      displayAerialSpec?.resolutionLabel ??
      estimateSlippyGroundResolutionLabel(aerialZoom, subPt.lat);

    if (aerialPrimary) {
      regionalTexLoaded = false;
      lastCheckedTileKey = "";
      const sigScale =
        spherical.radius < 100.5
          ? 10000
          : spherical.radius < 106
            ? 100
            : spherical.radius < 120
              ? 10
              : 2;
      const centerSig = `${Math.round(subPt.lat * sigScale)},${Math.round(subPt.lng * sigScale)},${swathKm},${altitudeKm},${depthTier},${aerialZoom},${includeLabels ? 1 : 0}`;
      if (force || centerSig !== lastHudCenterSig) {
        lastHudCenterSig = centerSig;
        const inFlightForCurrent =
          displayAerialSpec !== null &&
          lastRequestedAerialKey === displayAerialSpec.key &&
          activeFineSpec?.key !== displayAerialSpec.key;
        setRegionalHud((prev) => ({
          ...prev,
          layerId: null,
          swathKm,
          tier: depthTier === "mesoscale" ? "mesoscale" : "corridor",
          aerialActive: Math.abs(subPt.lat) <= 85.05,
          aerialZoom,
          aerialResolutionLabel,
          altitudeKm,
          depthTier,
          loading:
            Math.abs(subPt.lat) <= 85.05 &&
            (aerialPending || inFlightForCurrent),
          error:
            Math.abs(subPt.lat) > 85.05
              ? false
              : prev.error &&
                !aerialFineLoaded &&
                !aerialPrevFineLoaded &&
                !aerialMidLoaded &&
                !aerialCoarseLoaded,
          centerLat: subPt.lat,
          centerLng: subPt.lng,
        }));
      }
      return;
    }

    if (!activeLayerId) {
      regionalTexLoaded = false;
      lastCheckedTileKey = "";
      setRegionalHud((prev) => ({
        ...prev,
        layerId: null,
        swathKm,
        aerialActive: false,
        aerialZoom,
        aerialResolutionLabel,
        altitudeKm,
        depthTier,
        loading: false,
        error: false,
        centerLat: Number(subPt.lat.toFixed(2)),
        centerLng: Number(subPt.lng.toFixed(2)),
      }));
      return;
    }

    const spec = computeRegionalTileSpec({
      lat: subPt.lat,
      lng: subPt.lng,
      cameraRadius: spherical.radius,
      layerId: activeLayerId,
      cutoffMs: cutoffMsRef.current,
    });
    if (!spec) {
      setRegionalHud((prev) => ({
        ...(prev ?? {
          dateIso: new Date(cutoffMsRef.current ?? Date.now())
            .toISOString()
            .slice(0, 10),
          swathKm: 600,
        }),
        layerId: null,
        aerialActive: false,
        aerialZoom,
        aerialResolutionLabel,
        altitudeKm,
        depthTier,
        loading: false,
        error: false,
        centerLat: subPt.lat,
        centerLng: subPt.lng,
      }));
      return;
    }

    const sigScale = spherical.radius < 106 ? 100 : spherical.radius < 120 ? 10 : 2;
    const centerSig = `${Math.round(subPt.lat * sigScale)},${Math.round(subPt.lng * sigScale)},${swathKm},${altitudeKm},${depthTier}`;
    if (force || spec.key !== lastCheckedTileKey) {
      lastCheckedTileKey = spec.key;
      lastHudCenterSig = centerSig;
      if (gibsDebounceTimer !== null) {
        window.clearTimeout(gibsDebounceTimer);
        gibsDebounceTimer = null;
      }
      if (force || gibsCache.has(spec.key)) {
        loadRegionalSpec(spec, swathKm, subPt.lat, subPt.lng);
      } else {
        gibsDebounceTimer = window.setTimeout(() => {
          gibsDebounceTimer = null;
          if (!disposed) {
            loadRegionalSpec(spec, swathKm, subPt.lat, subPt.lng);
          }
        }, 85);
      }
    } else if (centerSig !== lastHudCenterSig) {
      lastHudCenterSig = centerSig;
      setRegionalHud((prev) => ({
        ...prev,
        layerId: activeLayerId,
        swathKm,
        tier: spec.tier,
        aerialActive: false,
        aerialZoom,
        aerialResolutionLabel,
        altitudeKm,
        depthTier,
        centerLat: subPt.lat,
        centerLng: subPt.lng,
      }));
    }
  };

  const syncMercatorOrigin = (mercRef: { mercX: number; mercY: number }) => {
    currentMercRef = mercRef;
    syncUniformRelBounds();
  };

  const dispose = () => {
    disposed = true;
    clearHdUpgradeTimer();
    pendingPreviewJob = null;
    activeAerialAbortController?.abort();
    activeAerialAbortController = null;
    abortInFlightTileImages();
    abortInFlightPreviewImages();
    abortInFlightGlobalHdImages();
    if (gibsDebounceTimer !== null) {
      window.clearTimeout(gibsDebounceTimer);
    }
    if (aerialDebounceTimer !== null) {
      window.clearTimeout(aerialDebounceTimer);
    }
    for (const drawable of slippyTileBitmapCache.values()) {
      closeBitmapSafely(drawable);
    }
    slippyTileBitmapCache.clear();
    gibsCache.clear();
    globalGibsCache.clear();
    globalPreviewCache.clear();
    globalWmtsCache.clear();
    aerialMosaicCache.clear();
    bordersTex = null;
    textureTracker.disposeAll();
  };

  return {
    syncGlobalMode,
    syncRegionalTile,
    syncMercatorOrigin,
    isRegionalTexLoaded: () => regionalTexLoaded,
    isGlobalTexLoaded: () => globalTexLoaded,
    isAerialCoarseLoaded: () => aerialCoarseLoaded,
    isAerialMidLoaded: () => aerialMidLoaded,
    isAerialPrevFineLoaded: () => aerialPrevFineLoaded,
    isAerialFineLoaded: () => aerialFineLoaded,
    dispose,
  };
}
