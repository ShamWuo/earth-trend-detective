"use client";

import { Activity, TrendingDown, TrendingUp } from "lucide-react";
import type { PlainTrendDigest } from "@/lib/plainLanguage";

export interface TrendToneStyles {
  container: string;
  iconWrap: string;
  icon: string;
  headline: string;
  rate: string;
  badge: string;
  dirSymbol: "↑" | "↓" | "—";
}

/**
 * Returns semantic Tailwind classes for significant rising, falling, or steady Earth trends.
 */
export function getTrendToneStyles(
  digest: Pick<PlainTrendDigest, "isSignificant" | "tone">
): TrendToneStyles {
  if (digest.isSignificant && digest.tone === "rising") {
    return {
      container: "border-rose-400/55 bg-rose-950/45",
      iconWrap: "bg-rose-500/20 border-rose-400/40",
      icon: "text-rose-300",
      headline: "text-rose-100",
      rate: "text-rose-200",
      badge: "border-rose-400/70 bg-rose-950/90 text-rose-200",
      dirSymbol: "↑",
    };
  }
  if (digest.isSignificant && digest.tone === "falling") {
    return {
      container: "border-sky-400/55 bg-sky-950/45",
      iconWrap: "bg-sky-500/20 border-sky-400/40",
      icon: "text-sky-300",
      headline: "text-sky-100",
      rate: "text-sky-200",
      badge: "border-sky-400/70 bg-sky-950/90 text-sky-200",
      dirSymbol: "↓",
    };
  }
  return {
    container: "border-border bg-surface-inset",
    iconWrap: "bg-surface-elevated border-border",
    icon: "text-text-subtle",
    headline: "text-text-primary",
    rate: "text-text-secondary",
    badge: "border-border bg-surface-band text-text-subtle",
    dirSymbol: "—",
  };
}

/**
 * Prominent callout banner for the active spot's primary statistical trend finding.
 */
export function TrendFindingHighlight({ digest }: { digest: PlainTrendDigest }) {
  const styles = getTrendToneStyles(digest);
  const Icon = digest.isSignificant
    ? digest.tone === "rising"
      ? TrendingUp
      : TrendingDown
    : Activity;

  return (
    <div
      className={`rounded-md border px-2.5 py-2 transition-colors ${styles.container}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border ${styles.iconWrap}`}
            aria-hidden="true"
          >
            <Icon className={`h-3.5 w-3.5 ${styles.icon}`} />
          </span>
          <div className="min-w-0">
            <div className={`text-[15px] font-bold leading-tight tracking-tight ${styles.headline}`}>
              {digest.headline}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
              <span className={`ws-numeric font-mono font-semibold ${styles.rate}`}>
                {digest.ratePerDecade}
              </span>
              <span className="text-text-subtle">·</span>
              <span className="text-text-muted">{digest.periodRange}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${styles.badge}`}
          >
            {styles.dirSymbol} {digest.certaintyLabel}
          </span>
          {digest.isProxy && (
            <span className="rounded-sm border border-amber-400/70 bg-amber-950/90 px-1.5 py-0.5 text-[9.5px] font-medium text-amber-300">
              Proxy
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
