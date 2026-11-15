import { NextRequest, NextResponse } from "next/server";
import {
  classifyHttpStatusFault,
  classifyUpstreamFault,
  createTelemetryBudget,
  UpstreamTelemetryError,
  type TelemetryBudget,
} from "@/lib/earth/upstreamResilience";
import {
  GIBS_LAYERS,
  GIBS_WMS_ENDPOINT,
  resolveEffectiveSstAnomalyWmsLayer,
  type ActiveGibsLayerId,
} from "@/lib/earth/nasaGibsRegional";
import type { UpstreamFaultDetail } from "@/types/etg";

export const dynamic = "force-dynamic";

const MAX_CACHE_ENTRIES = 64;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MIN_VALID_TILE_BYTES = 2400;
const UPSTREAM_TIMEOUT_MS = 950;

interface GibsCacheEntry {
  buffer: ArrayBuffer;
  contentType: string;
  resolvedDate: string;
  expiresAt: number;
}

const gibsTileCache = new Map<string, GibsCacheEntry>();

function isValidGibsLayer(value: string | null): value is ActiveGibsLayerId {
  return Boolean(value && Object.prototype.hasOwnProperty.call(GIBS_LAYERS, value));
}

function parseBbox(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (
    minLng < -180 ||
    maxLng > 180 ||
    minLng >= maxLng ||
    minLat < -90 ||
    maxLat > 90 ||
    minLat >= maxLat
  ) {
    return null;
  }
  return `${minLng},${minLat},${maxLng},${maxLat}`;
}

function parseDimension(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(256, Math.min(2048, n));
}

async function fetchGibsUpstream(
  wmsLayers: string,
  bbox: string,
  width: number,
  height: number,
  dateIso: string,
  format: "image/jpeg" | "image/png" = "image/jpeg",
  budget?: TelemetryBudget,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): Promise<{ ok: true; buffer: ArrayBuffer; contentType: string } | { ok: false; fault: UpstreamFaultDetail }> {
  const transparentPart = format === "image/png" ? "&TRANSPARENT=TRUE" : "";
  const upstreamUrl =
    `${GIBS_WMS_ENDPOINT}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
    `&LAYERS=${wmsLayers}&STYLES=&FORMAT=${format}${transparentPart}&SRS=EPSG:4326` +
    `&BBOX=${bbox}&WIDTH=${width}&HEIGHT=${height}&TIME=${dateIso}`;

  try {
    const res = await fetch(upstreamUrl, {
      headers: {
        "User-Agent": "EarthTrendDetective/1.0 (NASA Space Apps; GIBS Swath Proxy)",
      },
      signal: budget ? budget.signal(timeoutMs) : AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) {
      const snippet = await res.text().catch(() => "");
      const fault = classifyHttpStatusFault("NASA GIBS WMS", res.status, snippet);
      budget?.recordFault(fault);
      return { ok: false, fault };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      const fault: UpstreamFaultDetail = {
        source: "NASA GIBS WMS",
        kind: "malformed_payload",
        httpStatus: res.status,
        message: `NASA GIBS WMS returned non-image content-type "${contentType || "unknown"}"`,
        retryable: false,
      };
      budget?.recordFault(fault);
      return { ok: false, fault };
    }
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < MIN_VALID_TILE_BYTES) {
      const fault: UpstreamFaultDetail = {
        source: "NASA GIBS WMS",
        kind: "unavailable",
        httpStatus: res.status,
        message: `NASA GIBS imagery blank or truncated (${buffer.byteLength} bytes < ${MIN_VALID_TILE_BYTES})`,
        retryable: false,
      };
      budget?.recordFault(fault);
      return { ok: false, fault };
    }
    return { ok: true, buffer, contentType };
  } catch (err) {
    const fault =
      err instanceof UpstreamTelemetryError
        ? err.toDetail()
        : classifyUpstreamFault(err, "NASA GIBS WMS");
    budget?.recordFault(fault);
    return { ok: false, fault };
  }
}

export async function GET(req: NextRequest) {
  const budget = createTelemetryBudget(1550);
  const sp = req.nextUrl.searchParams;
  const layerParam = sp.get("layer");
  const scopeParam = sp.get("scope");
  const isBorders = layerParam === "borders";
  const isGlobal = scopeParam === "global";
  const bboxParam = parseBbox(sp.get("bbox"));
  const widthParam = parseDimension(sp.get("width"), 1024);
  const heightParam = parseDimension(sp.get("height"), 768);
  const timeParam = sp.get("time");

  if (
    (!isBorders && !isValidGibsLayer(layerParam)) ||
    !bboxParam ||
    widthParam === null ||
    heightParam === null ||
    !timeParam ||
    !/^\d{4}-\d{2}-\d{2}$/.test(timeParam)
  ) {
    return NextResponse.json(
      { error: "Invalid GIBS query parameters (expected layer, bbox, width, height, time)." },
      { status: 400 }
    );
  }

  const cacheKey = `${layerParam}:${isGlobal ? "global" : "regional"}:${bboxParam}:${widthParam}:${heightParam}:${timeParam}`;
  const now = Date.now();
  const cached = gibsTileCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Refresh LRU order
    gibsTileCache.delete(cacheKey);
    gibsTileCache.set(cacheKey, cached);
    return new NextResponse(cached.buffer, {
      status: 200,
      headers: {
        "Content-Type": cached.contentType,
        "Cache-Control": "public, max-age=900",
        "X-ETG-GIBS-Date": cached.resolvedDate,
        "X-ETG-Provenance": "cached",
      },
    });
  }
  if (cached) {
    gibsTileCache.delete(cacheKey);
  }

  const layer = isBorders ? null : GIBS_LAYERS[layerParam as ActiveGibsLayerId];
  const baseWmsLayers = isBorders
    ? "Coastlines,Reference_Features"
    : isGlobal
      ? layer!.globalWmsLayers
      : layer!.wmsLayers;
  const wmsLayers = isBorders
    ? baseWmsLayers
    : resolveEffectiveSstAnomalyWmsLayer(
        layerParam as ActiveGibsLayerId,
        timeParam,
        baseWmsLayers
      );
  const format: "image/jpeg" | "image/png" = isBorders
    ? "image/png"
    : isGlobal
      ? layer!.globalFormat
      : "image/jpeg";
  const isMonthly = isBorders
    ? false
    : isGlobal
      ? Boolean(layer!.globalMonthly ?? layer!.monthly)
      : Boolean(layer!.monthly);

  const fallbackDate = isMonthly ? "2025-07-01" : "2025-07-15";
  const singleAttempt = isBorders || timeParam === fallbackDate;
  const primaryTimeoutMs = singleAttempt ? 1450 : UPSTREAM_TIMEOUT_MS;

  let resolvedDate = timeParam;
  let primaryOutcome = await fetchGibsUpstream(
    wmsLayers,
    bboxParam,
    widthParam,
    heightParam,
    timeParam,
    format,
    budget,
    primaryTimeoutMs
  );

  if (!primaryOutcome.ok && !isBorders && budget.remainingMs() > 150) {
    if (timeParam !== fallbackDate) {
      resolvedDate = fallbackDate;
      primaryOutcome = await fetchGibsUpstream(
        wmsLayers,
        bboxParam,
        widthParam,
        heightParam,
        fallbackDate,
        format,
        budget,
        Math.max(UPSTREAM_TIMEOUT_MS, budget.remainingMs())
      );
    }
  }

  if (!primaryOutcome.ok) {
    const primaryFault = primaryOutcome.fault;
    return NextResponse.json(
      {
        error: "NASA GIBS imagery unavailable",
        failureKind: primaryFault.kind === "unavailable" ? "unavailable" : "failed_to_fetch",
        provenanceMode: "unavailable",
        upstreamFault: primaryFault,
        upstreamFaults: budget.faults.length > 0 ? budget.faults : [primaryFault],
        elapsedMs: budget.elapsedMs(),
      },
      { status: 502 }
    );
  }

  const fetched = primaryOutcome;
  gibsTileCache.set(cacheKey, {
    buffer: fetched.buffer,
    contentType: fetched.contentType,
    resolvedDate,
    expiresAt: now + CACHE_TTL_MS,
  });
  while (gibsTileCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = gibsTileCache.keys().next().value;
    if (!oldestKey) break;
    gibsTileCache.delete(oldestKey);
  }

  return new NextResponse(fetched.buffer, {
    status: 200,
    headers: {
      "Content-Type": fetched.contentType,
      "Cache-Control": "public, max-age=900",
      "X-ETG-GIBS-Date": resolvedDate,
      "X-ETG-Provenance": "live",
    },
  });
}
