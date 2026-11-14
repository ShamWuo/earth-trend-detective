"use client";

import React from "react";
import { Layers } from "lucide-react";
import { EARTH_TREND_DATASETS } from "@/lib/datasets";
import type { ETGDatasetId, ETGNode } from "@/types/etg";

interface DatasetSelectorProps {
  activeTopics: ETGDatasetId[];
  onToggleTopic: (dataset: ETGDatasetId) => void;
  onResetTopics: () => void;
  nodes: ETGNode[];
}

export function DatasetSelector({
  activeTopics,
  onToggleTopic,
  onResetTopics,
  nodes,
}: DatasetSelectorProps) {
  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const n of nodes) {
      if (n.label !== "Rule" && n.properties.dataset) {
        map.set(n.properties.dataset, (map.get(n.properties.dataset) ?? 0) + 1);
      }
    }
    return map;
  }, [nodes]);

  const allSelected = activeTopics.length === 0;

  return (
    <section aria-labelledby="dataset-selector-heading" className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-accent-fg" aria-hidden="true" />
          <h2 id="dataset-selector-heading" className="ws-eyebrow">
            Topics to Show
          </h2>
        </div>
        {!allSelected && (
          <button
            type="button"
            onClick={onResetTopics}
            className="text-[11px] font-medium text-accent-fg hover:underline cursor-pointer"
          >
            Show all
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={allSelected}
          onClick={onResetTopics}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
            allSelected
              ? "border-accent-fg/60 bg-accent/18 font-semibold text-text-primary"
              : "border-border bg-surface-inset text-text-muted hover:border-border-strong hover:text-text-primary"
          }`}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-accent-fg" aria-hidden="true" />
          <span>All topics</span>
          <span className="ws-numeric text-[10px] text-text-subtle">
            {nodes.filter((n) => n.label !== "Rule").length}
          </span>
        </button>

        {EARTH_TREND_DATASETS.map((ds) => {
          const active = activeTopics.includes(ds.id);
          const count = counts.get(ds.id) ?? 0;
          return (
            <button
              key={ds.id}
              type="button"
              aria-pressed={active}
              onClick={() => onToggleTopic(ds.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                active
                  ? "border-accent-fg/60 bg-accent/18 font-semibold text-text-primary"
                  : "border-border bg-surface-inset text-text-muted hover:border-border-strong hover:text-text-primary"
              }`}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: ds.color }}
                aria-hidden="true"
              />
              <span>{ds.shortLabel}</span>
              <span className="ws-numeric text-[10px] text-text-subtle">{count}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
