"use client";

import React, { useId, useState } from "react";
import { HelpCircle, Layers, X } from "lucide-react";
import { EARTH_TREND_DATASETS } from "@/lib/datasets";
import type { ETGDatasetId, ETGNode } from "@/types/etg";

interface VariableGuidePopoverButtonProps {
  label?: string;
  compact?: boolean;
}

export function VariableGuidePopoverButton({
  label = "? Variable Guide",
  compact = false,
}: VariableGuidePopoverButtonProps) {
  const guideId = useId();
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        popoverTarget={guideId}
        aria-expanded={guideOpen}
        title="Plain-English guide to every NASA satellite and physical Earth variable"
        className={
          compact
            ? "etg-guide-trigger inline-flex items-center gap-1 rounded-sm border border-border bg-surface-elevated px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
            : "etg-guide-trigger inline-flex items-center gap-1 rounded-sm border border-border bg-surface-inset px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
        }
      >
        <HelpCircle className="h-3 w-3 text-accent-fg" aria-hidden="true" />
        <span>{label}</span>
      </button>

      <div
        id={guideId}
        popover="auto"
        role="dialog"
        aria-labelledby={`${guideId}-title`}
        onToggle={(e) => {
          const state = (e.nativeEvent as { newState?: string }).newState;
          setGuideOpen(state === "open");
        }}
        className="etg-guide-popover w-[min(25rem,calc(100vw-2rem))] rounded-md border border-border-strong bg-surface p-3.5 text-left text-text-primary shadow-2xl"
      >
        <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-border pb-2">
          <div>
            <h3 id={`${guideId}-title`} className="text-xs font-semibold text-text-primary">
              Student Variable Guide
            </h3>
            <p className="text-[11px] text-text-subtle">
              Plain-English guide to every satellite &amp; sensor metric
            </p>
          </div>
          <button
            type="button"
            popoverTarget={guideId}
            popoverTargetAction="hide"
            aria-label="Close variable guide"
            className="rounded-sm p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <dl className="max-h-72 space-y-2.5 overflow-y-auto pr-1 text-[11px]">
          {EARTH_TREND_DATASETS.map((ds) => (
            <div key={ds.id} className="rounded-sm border border-border bg-surface-inset p-2">
              <dt className="flex items-center justify-between gap-2 font-semibold text-text-primary">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: ds.color }}
                    aria-hidden="true"
                  />
                  <span>{ds.shortLabel}</span>
                </span>
                <span className="font-mono text-[10px] font-normal text-text-subtle">
                  {ds.unit}
                </span>
              </dt>
              <dd className="mt-1 leading-relaxed text-text-muted">{ds.studentPlainSummary}</dd>
              <dd className="etg-tone-warm mt-0.5 text-[10px] font-medium leading-relaxed">
                Why it matters: {ds.whyItMatters}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-accent-fg" aria-hidden="true" />
          <h2 id="dataset-selector-heading" className="ws-eyebrow">
            Topics to Show
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <VariableGuidePopoverButton />
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
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={allSelected}
          onClick={onResetTopics}
          className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
            allSelected
              ? "border-accent-fg bg-amber-950 font-semibold text-amber-300"
              : "border-border bg-surface-inset text-text-muted hover:border-border-strong hover:text-text-primary"
          }`}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-accent-fg" aria-hidden="true" />
          <span>All datasets</span>
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
              className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                active
                  ? "border-accent-fg bg-amber-950 font-semibold text-amber-300"
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
