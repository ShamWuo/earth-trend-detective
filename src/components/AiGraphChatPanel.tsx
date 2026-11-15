"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { EtgGraphSnapshot } from "@/lib/graph/etgStore";
import type { ETGDatasetId, ETGNode } from "@/types/etg";
import { humanizeNodeText } from "@/lib/plainLanguage";

interface AppliedEditItem {
  type: string;
  summary: string;
  createdNodeUuid?: string;
  createdEdgeUuid?: string;
}

interface BlockedEditItem {
  type: string;
  rule: string;
  reason: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  engine?: string;
  appliedActions?: AppliedEditItem[];
  blockedActions?: BlockedEditItem[];
  citedNodes?: string[];
  error?: boolean;
}

interface DetectiveApiResponse {
  engine: string;
  briefing: string;
  citedNodes?: string[];
  appliedActions?: AppliedEditItem[];
  blockedActions?: BlockedEditItem[];
  updatedSnapshot?: EtgGraphSnapshot;
  error?: string;
}

export interface AiGraphChatPanelProps {
  open: boolean;
  onClose: () => void;
  snapshot: EtgGraphSnapshot;
  selectedNode: ETGNode | null;
  probedCoord: { lat: number; lng: number } | null;
  activeTopics: ETGDatasetId[];
  onSelectNode: (node: ETGNode) => void;
  onSnapshotChange: (next: EtgGraphSnapshot, statusMsg?: string) => void;
  onBlockedNotice?: (msg: string) => void;
  externalPromptRequest?: { id: number; prompt: string } | null;
}

export function AiGraphChatPanel({
  open,
  onClose,
  snapshot,
  selectedNode,
  probedCoord,
  activeTopics,
  onSelectNode,
  onSnapshotChange,
  onBlockedNotice,
  externalPromptRequest,
}: AiGraphChatPanelProps) {
  const textareaId = useId();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastExternalIdRef = useRef<number | null>(null);

  const nodeById = useMemo(
    () => new Map(snapshot.nodes.map((n) => [n.uuid, n])),
    [snapshot.nodes]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, busy, open]);

  const submitPrompt = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed || busy) return;

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "user",
        content: trimmed,
      };

      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setDraft("");
      setBusy(true);

      try {
        const res = await fetch("/api/ai/detective", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextHistory.slice(-10).map((m) => ({
              role: m.role,
              content: m.content,
            })),
            question: trimmed,
            selectedNodeUuid: selectedNode?.uuid,
            lat: probedCoord?.lat,
            lng: probedCoord?.lng,
            dataset:
              selectedNode?.properties.dataset || activeTopics[0] || "nasa_power",
            applyEdits: true,
          }),
        });

        const data = (await res.json()) as DetectiveApiResponse;
        if (!res.ok) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }

        const assistantMsg: ChatMessage = {
          id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "assistant",
          content: data.briefing || "Done.",
          engine: data.engine,
          appliedActions: data.appliedActions,
          blockedActions: data.blockedActions,
          citedNodes: data.citedNodes,
        };
        setMessages((prev) => [...prev, assistantMsg]);

        if (data.updatedSnapshot) {
          onSnapshotChange(
            data.updatedSnapshot,
            `AI Graph Studio applied ${data.appliedActions?.length ?? 1} verified graph edit(s).`
          );
        } else if (data.blockedActions && data.blockedActions.length > 0) {
          onBlockedNotice?.(
            `Integrity Guard blocked ${data.blockedActions.length} harmful/invalid graph edit(s).`
          );
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            content:
              err instanceof Error
                ? `Could not complete request: ${err.message}`
                : "Could not complete AI request.",
            error: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [
      activeTopics,
      busy,
      messages,
      onBlockedNotice,
      onSnapshotChange,
      probedCoord,
      selectedNode,
    ]
  );

  useEffect(() => {
    if (
      externalPromptRequest &&
      externalPromptRequest.id !== lastExternalIdRef.current
    ) {
      lastExternalIdRef.current = externalPromptRequest.id;
      void submitPrompt(externalPromptRequest.prompt);
    }
  }, [externalPromptRequest, submitPrompt]);

  const starterChips = useMemo(() => {
    const fourth = selectedNode
      ? `Summarize & propose an Insight for ${humanizeNodeText(selectedNode.properties.name).slice(0, 32)}`
      : "Create a Concept node for ENSO Pacific Teleconnection";
    return [
      "Add live Boulder wildfire VPD & Niwot hydrology signals and connect them",
      "Find and wire missing teleconnection links in the graph",
      "Explain the strongest opposite-trend dipole right now",
      fourth,
    ];
  }, [selectedNode]);

  if (!open) return null;

  return (
    <aside
      aria-label="AI Graph Studio"
      className="max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(360px,calc(100dvw-1rem))] max-md:shadow-2xl md:relative md:z-20 md:w-[350px] lg:w-[380px] flex h-full shrink-0 flex-col border-r border-border bg-surface"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-header px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-accent-fg" aria-hidden="true" />
          <h2 className="truncate font-outfit text-xs font-semibold uppercase tracking-wider text-text-primary">
            AI Graph Studio
          </h2>
          <span className="ws-numeric shrink-0 rounded-xs border border-border bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
            {snapshot.nodes.length}N · {snapshot.edges.length}E
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setMessages([])}
              title="Reset chat history"
              aria-label="Reset chat history"
              className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-elevated px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span>Reset</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close AI Graph Studio"
            aria-label="Close AI Graph Studio"
            className="rounded-sm p-1 text-text-subtle hover:bg-surface-elevated hover:text-text-primary cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Active Scope & Guard Indicator */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-b border-border-subtle bg-surface-inset px-3 py-1.5 text-[11px]">
        <div className="min-w-0 truncate text-text-muted">
          {selectedNode ? (
            <span>
              Focus:{" "}
              <strong className="font-medium text-text-primary">
                {humanizeNodeText(selectedNode.properties.name).slice(0, 30)}
              </strong>
            </span>
          ) : probedCoord ? (
            <span className="ws-numeric font-mono">
              Pin: {probedCoord.lat.toFixed(2)}°, {probedCoord.lng.toFixed(2)}°
            </span>
          ) : (
            <span>Scope: Global Earth Graph</span>
          )}
        </div>
        <span
          title="Protects agency baselines, checks statistics, and blocks vandalism"
          className="inline-flex shrink-0 items-center gap-1 rounded-xs border border-emerald-500/30 bg-emerald-950/60 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
        >
          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
          <span>Integrity Guard</span>
        </span>
      </div>

      {/* Scrollable Message Log */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="AI Graph Studio conversation"
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-surface-inset p-3 text-xs leading-relaxed text-text-muted">
              <p className="font-medium text-text-primary">
                Chat naturally or edit the Knowledge Graph directly.
              </p>
              <p className="mt-1 text-[11px] text-text-subtle">
                Ask quick questions, ingest live NASA/NOAA coordinates, create Concept/Insight
                nodes, wire teleconnections, or revise hypotheses. Destructive or unscientific edits
                are blocked automatically.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                Try a prompt
              </div>
              {starterChips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={busy}
                  onClick={() => void submitPrompt(chip)}
                  className="w-full rounded-sm border border-border bg-surface-elevated px-2.5 py-2 text-left text-[11px] leading-snug text-text-primary transition-colors hover:border-accent-fg disabled:opacity-50 cursor-pointer"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[88%] rounded-md border border-border-strong bg-surface-elevated px-3 py-2 text-xs leading-relaxed text-text-primary whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              );
            }

            const createdIds = (msg.appliedActions ?? [])
              .map((a) => a.createdNodeUuid)
              .filter((id): id is string => Boolean(id));
            const citedList = Array.from(
              new Set([...createdIds, ...(msg.citedNodes ?? [])])
            ).slice(0, 5);

            return (
              <div
                key={msg.id}
                className={`space-y-2 rounded-md border p-3 text-xs leading-relaxed ${
                  msg.error
                    ? "border-rose-500/40 bg-rose-950/30 text-rose-200"
                    : "border-border bg-surface-inset text-text-primary"
                }`}
              >
                {msg.engine && (
                  <div className="font-mono text-[10px] text-text-faint truncate">
                    {msg.engine}
                  </div>
                )}

                <div className="whitespace-pre-wrap">{msg.content}</div>

                {msg.appliedActions && msg.appliedActions.length > 0 && (
                  <div className="space-y-1 rounded border border-emerald-500/30 bg-emerald-950/40 p-2 text-[11px] text-emerald-300">
                    <div className="flex items-center gap-1 font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Applied Graph Edits ({msg.appliedActions.length})</span>
                    </div>
                    {msg.appliedActions.map((a, idx) => (
                      <div key={idx} className="font-mono text-[10px] leading-snug">
                        + {a.summary}
                      </div>
                    ))}
                  </div>
                )}

                {msg.blockedActions && msg.blockedActions.length > 0 && (
                  <div className="space-y-1 rounded border border-rose-500/30 bg-rose-950/40 p-2 text-[11px] text-rose-300">
                    <div className="flex items-center gap-1 font-semibold">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Blocked by Integrity Guard ({msg.blockedActions.length})</span>
                    </div>
                    {msg.blockedActions.map((b, idx) => (
                      <div key={idx} className="font-mono text-[10px] leading-snug">
                        [{b.rule}] {b.reason}
                      </div>
                    ))}
                  </div>
                )}

                {citedList.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {citedList.map((uuid) => {
                      const target = nodeById.get(uuid);
                      if (!target) return null;
                      return (
                        <button
                          key={uuid}
                          type="button"
                          onClick={() => onSelectNode(target)}
                          className="rounded-sm border border-border bg-surface px-2 py-0.5 font-mono text-[10px] text-accent-fg hover:border-accent-fg cursor-pointer"
                        >
                          {humanizeNodeText(target.properties.name).slice(0, 26)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}

        {busy && (
          <div className="rounded-md border border-border bg-surface-inset px-3 py-2 font-mono text-[11px] text-text-muted">
            Thinking &amp; verifying graph integrity…
          </div>
        )}
      </div>

      {/* Flexible Multi-Line Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitPrompt(draft);
        }}
        className="shrink-0 border-t border-border bg-header p-2.5"
      >
        <label htmlFor={textareaId} className="sr-only">
          Message AI Graph Studio
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={textareaId}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
                  return;
                }
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask anything, or tell AI to add signals, create insights, or connect nodes…"
            className="form-input etg-chat-textarea flex-1"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            title="Send message (Enter)"
            aria-label="Send message"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent text-white transition-colors hover:bg-accent-hover disabled:opacity-45 cursor-pointer"
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-text-faint">
          <span>Enter to send · Shift+Enter for newline</span>
          <span>Live NASA + ETG Guard</span>
        </div>
      </form>
    </aside>
  );
}
