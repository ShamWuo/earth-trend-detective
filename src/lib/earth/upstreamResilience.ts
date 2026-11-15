import type { UpstreamFaultDetail, UpstreamFaultKind } from "@/types/etg";
import { createBoundedSignal } from "@/lib/earth/coordinates";

/** Default wall-clock budget for multi-upstream API routes so chaos outages settle well under 2s. */
export const DEFAULT_CHAOS_ROUTE_BUDGET_MS = 1450;

/** Default bounded single-request timeout when no parent budget is supplied. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 1200;

export class UpstreamTelemetryError extends Error {
  readonly source: string;
  readonly kind: UpstreamFaultKind;
  readonly httpStatus?: number;
  readonly retryable: boolean;

  constructor(detail: UpstreamFaultDetail) {
    super(detail.message);
    this.name = "UpstreamTelemetryError";
    this.source = detail.source;
    this.kind = detail.kind;
    this.httpStatus = detail.httpStatus;
    this.retryable = detail.retryable;
  }

  toDetail(): UpstreamFaultDetail {
    return {
      source: this.source,
      kind: this.kind,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isHtmlErrorSnippet(text: string): boolean {
  const head = text.trimStart().slice(0, 128).toLowerCase();
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("<title")
  );
}

export function isRetryableFaultKind(kind: UpstreamFaultKind, httpStatus?: number): boolean {
  if (kind === "malformed_payload" || kind === "timeout" || kind === "unavailable") {
    return false;
  }
  if (kind === "rate_limited") {
    return true;
  }
  if (kind === "upstream_http_error") {
    return httpStatus === undefined || httpStatus >= 500 || httpStatus === 408;
  }
  return kind === "network_error";
}

export function classifyHttpStatusFault(
  source: string,
  status: number,
  bodySnippet = ""
): UpstreamFaultDetail {
  const htmlSuffix = isHtmlErrorSnippet(bodySnippet) ? " (HTML error page)" : "";
  if (status === 429) {
    return {
      source,
      kind: "rate_limited",
      httpStatus: 429,
      message: `${source} rate-limited HTTP 429${htmlSuffix}`.trim(),
      retryable: true,
    };
  }
  if (status === 404) {
    return {
      source,
      kind: "unavailable",
      httpStatus: 404,
      message: `${source} returned HTTP 404 (no record available)${htmlSuffix}`.trim(),
      retryable: false,
    };
  }
  return {
    source,
    kind: "upstream_http_error",
    httpStatus: status,
    message: `${source} HTTP ${status}${htmlSuffix}`.trim(),
    retryable: status >= 500 || status === 408,
  };
}

export function classifyUpstreamFault(
  err: unknown,
  source: string,
  fallbackHttpStatus?: number
): UpstreamFaultDetail {
  if (err instanceof UpstreamTelemetryError) {
    return err.toDetail();
  }

  if (err && typeof err === "object") {
    const rec = err as {
      name?: unknown;
      message?: unknown;
      kind?: unknown;
      source?: unknown;
      httpStatus?: unknown;
      status?: unknown;
      retryable?: unknown;
    };
    if (
      typeof rec.kind === "string" &&
      typeof rec.source === "string" &&
      typeof rec.message === "string"
    ) {
      return {
        source: rec.source,
        kind: rec.kind as UpstreamFaultKind,
        ...(typeof rec.httpStatus === "number" ? { httpStatus: rec.httpStatus } : {}),
        message: rec.message,
        retryable: Boolean(rec.retryable),
      };
    }

    const name = typeof rec.name === "string" ? rec.name : "";
    const msg = typeof rec.message === "string" ? rec.message : String(err);
    const httpStatus =
      typeof rec.httpStatus === "number"
        ? rec.httpStatus
        : typeof rec.status === "number"
          ? rec.status
          : fallbackHttpStatus;

    if (name === "TelemetryUnavailableError" || rec.kind === "unavailable") {
      return {
        source,
        kind: "unavailable",
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        message: msg || `${source} data unavailable`,
        retryable: false,
      };
    }

    if (
      name === "TimeoutError" ||
      name === "AbortError" ||
      /timeout|timed out|aborted/i.test(msg)
    ) {
      return {
        source,
        kind: "timeout",
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        message: msg || `${source} request timed out`,
        retryable: false,
      };
    }

    if (httpStatus === 429 || /\b429\b|rate limit/i.test(msg)) {
      return classifyHttpStatusFault(source, 429, msg);
    }

    const statusMatch = msg.match(/\bHTTP\s+(\d{3})\b/i);
    if (httpStatus !== undefined || statusMatch) {
      const code = httpStatus ?? Number(statusMatch?.[1]);
      if (Number.isFinite(code) && code >= 400) {
        return classifyHttpStatusFault(source, code, msg);
      }
    }

    if (
      err instanceof SyntaxError ||
      /malformed|unexpected token|unexpected end|json|html error page|truncated/i.test(msg)
    ) {
      return {
        source,
        kind: "malformed_payload",
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        message: msg || `${source} returned malformed payload`,
        retryable: false,
      };
    }

    return {
      source,
      kind: "network_error",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      message: msg || `${source} network request failed`,
      retryable: true,
    };
  }

  return {
    source,
    kind: "network_error",
    message: String(err ?? `${source} network request failed`),
    retryable: true,
  };
}

export async function parseUpstreamJson<T = unknown>(
  res: Response,
  source: string
): Promise<T> {
  let rawText: string;
  try {
    rawText = await res.text();
  } catch (err) {
    throw new UpstreamTelemetryError(classifyUpstreamFault(err, source, res.status));
  }

  if (!res.ok) {
    throw new UpstreamTelemetryError(classifyHttpStatusFault(source, res.status, rawText));
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new UpstreamTelemetryError({
      source,
      kind: "malformed_payload",
      httpStatus: res.status,
      message: `${source} returned empty JSON body`,
      retryable: false,
    });
  }

  if (isHtmlErrorSnippet(trimmed)) {
    throw new UpstreamTelemetryError({
      source,
      kind: "malformed_payload",
      httpStatus: res.status,
      message: `${source} returned HTML instead of JSON`,
      retryable: false,
    });
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new UpstreamTelemetryError({
      source,
      kind: "malformed_payload",
      httpStatus: res.status,
      message: `${source} returned truncated or invalid JSON`,
      retryable: false,
    });
  }
}

export async function parseUpstreamText(res: Response, source: string): Promise<string> {
  let rawText: string;
  try {
    rawText = await res.text();
  } catch (err) {
    throw new UpstreamTelemetryError(classifyUpstreamFault(err, source, res.status));
  }

  if (!res.ok) {
    throw new UpstreamTelemetryError(classifyHttpStatusFault(source, res.status, rawText));
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new UpstreamTelemetryError({
      source,
      kind: "malformed_payload",
      httpStatus: res.status,
      message: `${source} returned empty body`,
      retryable: false,
    });
  }

  if (isHtmlErrorSnippet(trimmed)) {
    throw new UpstreamTelemetryError({
      source,
      kind: "malformed_payload",
      httpStatus: res.status,
      message: `${source} returned HTML error page instead of data table`,
      retryable: false,
    });
  }

  return rawText;
}

export interface TelemetryBudget {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly faults: UpstreamFaultDetail[];
  elapsedMs: () => number;
  remainingMs: () => number;
  isExhausted: () => boolean;
  signal: (capMs?: number, parentSignal?: AbortSignal) => AbortSignal;
  recordFault: (fault: UpstreamFaultDetail) => void;
  raceWithFallback: <T>(work: Promise<T>, onTimeoutFallback: () => T) => Promise<T>;
}

/**
 * Shared wall-clock budget tracker across parallel/sequential upstream fetches
 * so chaos timeouts always settle cleanly within < 2s.
 */
export function createTelemetryBudget(
  totalBudgetMs = DEFAULT_CHAOS_ROUTE_BUDGET_MS
): TelemetryBudget {
  const startedAt = Date.now();
  const safeBudget = Math.max(250, Math.round(totalBudgetMs));
  const deadlineAt = startedAt + safeBudget;
  const faults: UpstreamFaultDetail[] = [];

  const elapsedMs = () => Date.now() - startedAt;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  const isExhausted = () => Date.now() >= deadlineAt;

  const signal = (capMs = DEFAULT_UPSTREAM_TIMEOUT_MS, parentSignal?: AbortSignal) => {
    const rem = remainingMs();
    const boundedMs = Math.max(60, Math.min(capMs, rem > 0 ? rem : 60));
    return createBoundedSignal(boundedMs, parentSignal);
  };

  const recordFault = (fault: UpstreamFaultDetail) => {
    if (
      !faults.some(
        (existing) =>
          existing.source === fault.source &&
          existing.kind === fault.kind &&
          existing.httpStatus === fault.httpStatus
      )
    ) {
      faults.push(fault);
    }
  };

  const raceWithFallback = async <T>(
    work: Promise<T>,
    onTimeoutFallback: () => T
  ): Promise<T> => {
    const rem = remainingMs();
    if (rem <= 15) {
      return onTimeoutFallback();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => {
            recordFault({
              source: "Upstream Telemetry Pipeline",
              kind: "timeout",
              message: `Route chaos deadline (${safeBudget}ms) exceeded; using climatological fallback`,
              retryable: false,
            });
            resolve(onTimeoutFallback());
          }, rem);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    startedAt,
    deadlineAt,
    faults,
    elapsedMs,
    remainingMs,
    isExhausted,
    signal,
    recordFault,
    raceWithFallback,
  };
}
