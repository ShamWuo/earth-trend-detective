import React from "react";
import katex from "katex";
import type { ETGNode } from "@/types/etg";
import { humanizeNodeText } from "@/lib/plainLanguage";

const ETG_SLUG_PREFIX_RE = /^(?:signal|insight|concept|rule|edge)-/i;

/**
 * Formats an unresolved internal ETG identifier slug into a readable label
 * so UI prose never exposes raw `[signal-...]` or UUID tokens.
 */
export function humanizeCitationSlug(rawId: string): string {
  const trimmed = rawId.trim();
  const withoutPrefix = trimmed.replace(ETG_SLUG_PREFIX_RE, "");
  if (!withoutPrefix) return trimmed;
  return withoutPrefix
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^(?:nasa|noaa|nsidc|gistemp|gibs|modis|viirs|merra2?|ndvi|sst|enso|pdo|nao|iod|amoc|co2|vpd|pm25|pm2\.5)$/i.test(part)) {
        return part.toUpperCase();
      }
      if (/^\d+(?:\.\d+)?[nswe]$/i.test(part)) {
        return `${part.slice(0, -1)}°${part.slice(-1).toUpperCase()}`;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/**
 * Parses inline markdown bold spans (`**text**`) and `[node-uuid]` evidence
 * references into formatted text nodes and clickable node citation pills.
 */
export interface RenderBriefingOptions {
  variant?: "pill" | "wikilink" | "paper";
}

export function renderFormattedBriefing(
  text: string,
  nodeById: ReadonlyMap<string, ETGNode>,
  onSelectNode?: (node: ETGNode) => void,
  options?: RenderBriefingOptions
): React.ReactNode {
  const variant = options?.variant ?? "pill";
  const isWikilink = variant === "wikilink";
  const isPaper = variant === "paper";
  // Strip stray backticks that LLMs sometimes wrap around `[node-uuid]` citations
  const normalizedText = text.replace(
    /`(\[[a-zA-Z0-9][a-zA-Z0-9._:-]{1,80}\])`/g,
    "$1"
  );
  const tokenRegex =
    /(\[[a-zA-Z0-9][a-zA-Z0-9._:-]{1,80}\]|\*\*[^*\n]+\*\*|`[^`\n]+`|\$(?!\d+(?:[.,]\d+)?\b)(?:[^$\n\\]|\\.)+?\$)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRegex.exec(normalizedText)) !== null) {
    if (match.index > lastIndex) {
      parts.push(normalizedText.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong
          key={key++}
          className={
            isPaper
              ? "font-semibold text-[var(--paper-ink)]"
              : isWikilink
                ? "font-semibold text-[var(--wiki-heading)]"
                : "font-semibold text-text-primary"
          }
        >
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      parts.push(
        <code
          key={key++}
          className="rounded-xs bg-surface-elevated px-1 py-px font-mono text-[0.9em] text-text-primary"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("$") && token.endsWith("$") && token.length > 2) {
      const expr = token.slice(1, -1).trim();
      if (expr) {
        const html = katex.renderToString(expr, {
          throwOnError: false,
          displayMode: false,
        });
        parts.push(
          <span
            key={key++}
            className="inline-block align-baseline"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      } else {
        parts.push(token);
      }
    } else if (token.startsWith("[") && token.endsWith("]")) {
      const targetUuid = token.slice(1, -1);
      const target = nodeById.get(targetUuid);
      if (target) {
        const displayName = humanizeNodeText(target.properties.name);
        const tooltip = target.properties.region
          ? `Inspect cited node: ${displayName} — ${target.properties.region}`
          : `Inspect cited node: ${displayName}`;
        if (onSelectNode) {
          parts.push(
            <button
              key={`${targetUuid}-${key++}`}
              type="button"
              onClick={() => onSelectNode(target)}
              title={tooltip}
              className={
                isPaper
                  ? "etg-paper-cite"
                  : isWikilink
                    ? "etg-wiki-link"
                    : "mx-0.5 inline-flex items-baseline rounded-xs border border-accent-fg/40 bg-accent/15 px-1.5 py-px text-[11px] font-medium text-accent-fg transition-colors hover:border-accent-fg hover:bg-accent/25 cursor-pointer"
              }
            >
              {displayName}
            </button>
          );
        } else {
          parts.push(
            <span
              key={`${targetUuid}-${key++}`}
              title={tooltip}
              className={
                isPaper
                  ? "etg-paper-cite cursor-default"
                  : isWikilink
                    ? "font-medium text-[var(--wiki-link)]"
                    : "mx-0.5 inline-flex items-baseline rounded-xs border border-accent-fg/35 bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent-fg"
              }
            >
              {displayName}
            </span>
          );
        }
      } else if (ETG_SLUG_PREFIX_RE.test(targetUuid)) {
        const resolvedLabel = humanizeCitationSlug(targetUuid);
        parts.push(
          <span
            key={`${targetUuid}-${key++}`}
            title={isPaper || isWikilink ? `Unlinked ETG entity: ${targetUuid}` : undefined}
            className={
              isPaper
                ? "etg-paper-cite-unresolved"
                : isWikilink
                  ? "etg-wiki-link-unresolved"
                  : "mx-0.5 inline-flex items-baseline rounded-xs border border-border bg-surface-inset px-1.5 py-px text-[11px] font-medium text-text-primary"
            }
          >
            {resolvedLabel}
          </span>
        );
      } else {
        parts.push(token);
      }
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < normalizedText.length) {
    parts.push(normalizedText.slice(lastIndex));
  }
  return parts;
}
