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
import type { ETGDatasetId } from "@/types/etg";

export interface GlobeGibsTileController {
  syncGlobalMode: (
    mode: RegionalSatelliteMode,
    topics?: readonly ETGDatasetId[],
    cutoffMsVal?: number
  ) => void;
  syncRegionalTile: (force?: boolean) => void;
  isRegionalTexLoaded: () => boolean;
  isGlobalTexLoaded: () => boolean;
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
    cutoffMsRef,
    setGlobalHud,
    setRegionalHud,
  } = params;

  const gibsLoader = new THREE.TextureLoader();
  gibsLoader.setCrossOrigin("anonymous");
  const gibsCache = new Map<string, THREE.Texture>();
  const globalGibsCache = new Map<string, THREE.Texture>();
  const globalWmtsCache = new Map<string, THREE.CanvasTexture>();
  const failedTileUntil = new Map<string, number>();
  const failedGlobalUntil = new Map<string, number>();

  const isTextureBoundToUniform = (tex: THREE.Texture) =>
    tex === earthMat.uniforms.uRegionalMap.value ||
    tex === earthMat.uniforms.uGlobalLayerMap.value ||
    tex === earthMat.uniforms.uSliceWindsMap.value ||
    tex === earthMat.uniforms.uSlicePrecipMap.value ||
    tex === earthMat.uniforms.uSliceCloudsMap.value ||
    tex === earthMat.uniforms.uBordersMap.value;

  const textureTracker = createDynamicTextureTracker<THREE.Texture>(
    isTextureBoundToUniform
  );
  const inFlightTileImages = new Set<HTMLImageElement>();
  const abortInFlightTileImages = () => {
    for (const img of inFlightTileImages) {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    }
    inFlightTileImages.clear();
  };

  let disposed = false;
  let gibsReqSeq = 0;
  let globalReqSeq = 0;
  let regionalTexLoaded = false;
  let globalTexLoaded = false;
  let activeGlobalKey = "";
  let lastCheckedTileKey = "";
  let lastRequestedTileKey = "";
  let lastHudCenterSig = "";
  let gibsDebounceTimer: number | null = null;
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

  const loadTileImage = (url: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      inFlightTileImages.add(img);
      img.onload = () => {
        inFlightTileImages.delete(img);
        resolve(img);
      };
      img.onerror = () => {
        inFlightTileImages.delete(img);
        reject(new Error(`WMTS tile failed: ${url}`));
      };
      img.src = url;
    });

  const loadWmtsMosaic = async (
    spec: GlobalWmtsMosaicSpec,
    isCancelled: () => boolean
  ): Promise<THREE.CanvasTexture> => {
    const cached = globalWmtsCache.get(spec.key);
    if (cached) {
      globalWmtsCache.delete(spec.key);
      globalWmtsCache.set(spec.key, cached);
      return cached;
    }

    const maxGpuTex = renderer.capabilities.maxTextureSize || 4096;
    const canNative5k = renderer.capabilities.isWebGL2 && maxGpuTex >= 5120;
    const targetW =
      spec.zoom === 3
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
    const concurrency = 12;

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
              buildWmtsTileUrl(sub, spec.zoom, row, col, useFallback)
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
                  buildWmtsTileUrl(sub, spec.zoom, row, col, true)
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
            ctx.drawImage(
              img,
              col * spec.tileSize * scaleX,
              row * spec.tileSize * scaleY,
              spec.tileSize * scaleX,
              spec.tileSize * scaleY
            );
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

    const tex = configureGlobalTex(new THREE.CanvasTexture(canvas));
    insertWithLru(globalWmtsCache, spec.key, tex, 6);
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
      const windsSpec = computeGlobalLayerSpec({ layerId: "winds", cutoffMs: cutoffMsVal });
      const precipSpec = computeGlobalLayerSpec({ layerId: "precip", cutoffMs: cutoffMsVal });
      const cloudsSpec = computeGlobalLayerSpec({ layerId: "true_color", cutoffMs: cutoffMsVal });
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
      if (activeGlobalKey === reqKey && globalTexLoaded) {
        return;
      }
      activeGlobalKey = reqKey;
      const mySeq = ++globalReqSeq;
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
        applyMultiSlice(cachedWmW, cachedWmP, cachedWmC);
        setGlobalHud({
          loading: false,
          error: false,
          dateIso: cloudsWmts.primaryDateIso,
          resBadge: "5K HD",
        });
        return;
      }

      const isCancelled = () =>
        disposed || mySeq !== globalReqSeq || activeGlobalKey !== reqKey;
      let multiWmtsApplied = false;
      let multiStage1Ready = false;
      let multiStage1Failed = false;
      let multiStage2Failed = false;

      const cachedW = globalGibsCache.get(windsSpec.key);
      const cachedP = globalGibsCache.get(precipSpec.key);
      const cachedC = globalGibsCache.get(cloudsSpec.key);
      if (cachedW && cachedP && cachedC) {
        applyMultiSlice(cachedW, cachedP, cachedC);
        multiStage1Ready = true;
        setGlobalHud({
          loading: true,
          error: false,
          dateIso: cloudsSpec.dateIso,
          resBadge: "2K…",
        });
      } else {
        setGlobalHud({
          loading: true,
          error: false,
          dateIso: cloudsSpec.dateIso,
          resBadge: "Loading",
        });
        Promise.all([
          loadGlobalTexPromise(windsSpec),
          loadGlobalTexPromise(precipSpec),
          loadGlobalTexPromise(cloudsSpec),
        ])
          .then(([texW, texP, texC]) => {
            if (isCancelled() || multiWmtsApplied) return;
            applyMultiSlice(texW, texP, texC);
            multiStage1Ready = true;
            setGlobalHud({
              loading: !multiStage2Failed,
              error: false,
              dateIso: cloudsSpec.dateIso,
              resBadge: multiStage2Failed ? "2K" : "2K…",
            });
          })
          .catch(() => {
            multiStage1Failed = true;
            if (isCancelled() || multiWmtsApplied) return;
            if (multiStage2Failed) {
              activeGlobalKey = "";
              setGlobalHud((prev) => ({
                ...prev,
                loading: false,
                error: true,
                resBadge: "",
              }));
            }
          });
      }

      Promise.all([
        loadWmtsMosaic(windsWmts, isCancelled),
        loadWmtsMosaic(precipWmts, isCancelled),
        loadWmtsMosaic(cloudsWmts, isCancelled),
      ])
        .then(([wmW, wmP, wmC]) => {
          if (isCancelled()) return;
          multiWmtsApplied = true;
          applyMultiSlice(wmW, wmP, wmC);
          setGlobalHud({
            loading: false,
            error: false,
            dateIso: cloudsWmts.primaryDateIso,
            resBadge: "5K HD",
          });
        })
        .catch(() => {
          multiStage2Failed = true;
          if (isCancelled()) return;
          if (multiStage1Ready) {
            setGlobalHud((prev) => ({
              ...prev,
              loading: false,
              error: false,
              resBadge: "2K",
            }));
          } else if (multiStage1Failed) {
            activeGlobalKey = "";
            setGlobalHud((prev) => ({
              ...prev,
              loading: false,
              error: true,
              resBadge: "",
            }));
          }
        });
      return;
    }

    const layerId = resolveGlobalFilterLayer(mode, topics);
    if (!layerId) {
      activeGlobalKey = "";
      globalTexLoaded = false;
      earthMat.uniforms.uGlobalFilterMode.value = 0.0;
      setGlobalHud({ loading: false, error: false, dateIso: "", resBadge: "" });
      return;
    }

    const spec = computeGlobalLayerSpec({ layerId, cutoffMs: cutoffMsVal });
    const wmtsSpec = computeGlobalWmtsMosaicSpec({ layerId, cutoffMs: cutoffMsVal });
    if (activeGlobalKey === wmtsSpec.key && globalTexLoaded) {
      return;
    }
    activeGlobalKey = wmtsSpec.key;
    const mySeq = ++globalReqSeq;
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

    const isCancelled = () =>
      disposed || mySeq !== globalReqSeq || activeGlobalKey !== wmtsSpec.key;
    let wmtsApplied = false;
    let stage1Ready = false;
    let stage1Failed = false;
    let stage2Failed = false;

    const cached = globalGibsCache.get(spec.key);
    if (cached) {
      globalGibsCache.delete(spec.key);
      globalGibsCache.set(spec.key, cached);
      applySingleGlobal(cached, 2048, 1024);
      stage1Ready = true;
      setGlobalHud({
        loading: true,
        error: false,
        dateIso: spec.dateIso,
        resBadge: "2K…",
      });
    } else {
      setGlobalHud({
        loading: true,
        error: false,
        dateIso: spec.dateIso,
        resBadge: "Loading",
      });
      loadGlobalTexPromise(spec)
        .then((tex) => {
          if (isCancelled() || wmtsApplied) return;
          applySingleGlobal(tex, 2048, 1024);
          stage1Ready = true;
          setGlobalHud({
            loading: !stage2Failed,
            error: false,
            dateIso: spec.dateIso,
            resBadge: stage2Failed ? "2K" : "2K…",
          });
        })
        .catch(() => {
          stage1Failed = true;
          if (isCancelled() || wmtsApplied) return;
          if (stage2Failed) {
            activeGlobalKey = "";
            setGlobalHud((prev) => ({
              ...prev,
              loading: false,
              error: true,
              resBadge: "",
            }));
          }
        });
    }

    loadWmtsMosaic(wmtsSpec, isCancelled)
      .then((wmtsTex) => {
        if (isCancelled()) return;
        wmtsApplied = true;
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
        stage2Failed = true;
        if (isCancelled()) return;
        if (stage1Ready) {
          setGlobalHud((prev) => ({
            ...prev,
            loading: false,
            error: false,
            resBadge: "2K",
          }));
        } else if (stage1Failed) {
          activeGlobalKey = "";
          setGlobalHud((prev) => ({
            ...prev,
            loading: false,
            error: true,
            resBadge: "",
          }));
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
    const cached = gibsCache.get(spec.key);
    if (cached) {
      gibsCache.delete(spec.key);
      gibsCache.set(spec.key, cached);
      applyRegionalTexture(cached, spec);
      setRegionalHud({
        layerId: spec.layerId,
        dateIso: spec.dateIso,
        swathKm,
        tier: spec.tier,
        loading: false,
        error: false,
        centerLat,
        centerLng,
      });
      return;
    }

    if ((failedTileUntil.get(spec.key) ?? 0) > Date.now()) {
      setRegionalHud({
        layerId: spec.layerId,
        dateIso: spec.dateIso,
        swathKm,
        tier: spec.tier,
        loading: false,
        error: true,
        centerLat,
        centerLng,
      });
      return;
    }

    if (lastRequestedTileKey === spec.key) {
      return;
    }
    lastRequestedTileKey = spec.key;
    const mySeq = ++gibsReqSeq;
    setRegionalHud({
      layerId: spec.layerId,
      dateIso: spec.dateIso,
      swathKm,
      tier: spec.tier,
      loading: true,
      error: false,
      centerLat,
      centerLng,
    });

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

  const syncRegionalTile = (force = false) => {
    if (disposed) return;
    if (spherical.radius > REGIONAL_ZOOM_EXIT_RADIUS) return;
    const subVec = new THREE.Vector3().setFromSpherical(spherical);
    const subPt = vector3ToLatLng(subVec);
    const swathKm = estimateRegionalSwathKm(spherical.radius);
    const activeLayerId = activeGibsLayerRef.current;

    if (!activeLayerId) {
      regionalTexLoaded = false;
      lastCheckedTileKey = "";
      setRegionalHud((prev) => ({
        ...prev,
        layerId: null,
        swathKm,
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
        loading: false,
        error: false,
        centerLat: subPt.lat,
        centerLng: subPt.lng,
      }));
      return;
    }

    const centerSig = `${Math.round(subPt.lat * 2)},${Math.round(subPt.lng * 2)},${Math.round(swathKm / 40)}`;
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
        }, 180);
      }
    } else if (centerSig !== lastHudCenterSig) {
      lastHudCenterSig = centerSig;
      setRegionalHud((prev) => ({
        ...prev,
        layerId: activeLayerId,
        swathKm,
        tier: spec.tier,
        centerLat: subPt.lat,
        centerLng: subPt.lng,
      }));
    }
  };

  const dispose = () => {
    disposed = true;
    abortInFlightTileImages();
    if (gibsDebounceTimer !== null) {
      window.clearTimeout(gibsDebounceTimer);
    }
    gibsCache.clear();
    globalGibsCache.clear();
    globalWmtsCache.clear();
    bordersTex = null;
    textureTracker.disposeAll();
  };

  return {
    syncGlobalMode,
    syncRegionalTile,
    isRegionalTexLoaded: () => regionalTexLoaded,
    isGlobalTexLoaded: () => globalTexLoaded,
    dispose,
  };
}
