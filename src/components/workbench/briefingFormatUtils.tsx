import React from "react";
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
      if (/^(?:nasa|noaa|gistemp|gibs|modis|viirs|merra2?|ndvi|sst|enso|pdo|nao|iod|amoc|co2|vpd|pm25|pm2\.5)$/i.test(part)) {
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
export function renderFormattedBriefing(
  text: string,
  nodeById: ReadonlyMap<string, ETGNode>,
  onSelectNode?: (node: ETGNode) => void
): React.ReactNode {
  const tokenRegex = /(\[[a-zA-Z0-9][a-zA-Z0-9._:-]{1,80}\]|\*\*[^*\n]+\*\*)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-text-primary">
          {token.slice(2, -2)}
        </strong>
      );
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
              className="mx-0.5 inline-flex items-baseline rounded-xs border border-accent-fg/40 bg-accent/15 px-1.5 py-px text-[11px] font-medium text-accent-fg transition-colors hover:border-accent-fg hover:bg-accent/25 cursor-pointer"
            >
              {displayName}
            </button>
          );
        } else {
          parts.push(
            <span
              key={`${targetUuid}-${key++}`}
              title={tooltip}
              className="mx-0.5 inline-flex items-baseline rounded-xs border border-accent-fg/35 bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent-fg"
            >
              {displayName}
            </span>
          );
        }
      } else if (ETG_SLUG_PREFIX_RE.test(targetUuid)) {
        parts.push(
          <span
            key={`${targetUuid}-${key++}`}
            className="mx-0.5 inline-flex items-baseline rounded-xs border border-border bg-surface-inset px-1.5 py-px text-[11px] font-medium text-text-primary"
          >
            {humanizeCitationSlug(targetUuid)}
          </span>
        );
      } else {
        parts.push(token);
      }
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}
