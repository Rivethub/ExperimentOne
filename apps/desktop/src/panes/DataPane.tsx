import { useDeferredValue, useMemo, useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { filterMessages, relativeWhen } from "../lib/conversation-utils";
import {
  fmt,
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "../lib/provider-utils";
import { LimitRecoveryBanner, type LimitHitInfo } from "../quota";
import { filterTimeline, timelineFromTrafficEvents, TranscriptView } from "../transcript";
import type { ConversationSummary, SearchMode, TrafficEvent } from "../lib/types";
import { Button, Empty, Input, Panel, Pill } from "../ui";
import { cn } from "#lib/utils";

const SEARCH_MODES = [
  ["keyword", "Keyword"],
  ["vector", "Vector"],
] as const;

export type DataPaneProps = {
  limitHit: LimitHitInfo | null;
  limitActions: {
    onRefreshCredentials: () => void;
    onSwitchAccount: () => void;
    onWait: () => void;
  };
  catalog: CatalogProvider[];
  listQuery: string;
  onListQueryChange: (query: string) => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  vectorSearchEnabled: boolean;
  searchModeLabel: string | null;
  listPending: boolean;
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelectConversation: (id: string | null) => void;
  messages: TrafficEvent[];
  threadQuery: string;
  onThreadQueryChange: (query: string) => void;
};

function ConversationRow({
  conversation: c,
  selected,
  catalog,
  onSelect,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  catalog: CatalogProvider[];
  onSelect: () => void;
}) {
  const color = providerColor(providerKey(c.provider), catalog);
  return (
    <button
      type="button"
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1.5 border-0 border-b border-border/60 bg-transparent px-3.5 py-3 text-left text-foreground",
        "hover:bg-accent",
        selected && "bg-secondary",
      )}
      onClick={onSelect}
    >
      <div className="flex items-baseline justify-between gap-2.5">
        <strong className="truncate text-[13px] font-semibold">{c.title}</strong>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {relativeWhen(c.updated_at)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <Pill style={{ background: `${color}22`, color }}>
          {providerChipLabel(providerKey(c.provider), catalog)}
        </Pill>
        <span className="font-mono text-xs">{c.model ?? "—"}</span>
        <span className="text-muted-foreground">
          {c.message_count} msg · {fmt(c.tokens_in)}/{fmt(c.tokens_out)}
        </span>
      </div>
      {c.preview ? <div className="truncate text-xs text-muted-foreground">{c.preview}</div> : null}
    </button>
  );
}

function ConversationVirtualList({
  conversations,
  selectedId,
  catalog,
  pending,
  onSelectConversation,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  catalog: CatalogProvider[];
  pending: boolean;
  onSelectConversation: (id: string | null) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 10,
    getItemKey: (index) => conversations[index]?.id ?? index,
  });

  return (
    <div
      ref={parentRef}
      className={cn(
        "mt-3 min-h-0 flex-1 overflow-auto rounded-[10px] border border-border/60 transition-opacity duration-100",
        pending && "opacity-55",
      )}
      aria-busy={pending || undefined}
    >
      {/* relative + absolute rows required by the virtualizer */}
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const c = conversations[row.index]!;
          const style = {
            transform: `translateY(${row.start}px)`,
          } satisfies CSSProperties;
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={style}
            >
              <ConversationRow
                conversation={c}
                selected={selectedId === c.id}
                catalog={catalog}
                onSelect={() => onSelectConversation(c.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DataPane({
  limitHit,
  limitActions,
  catalog,
  listQuery,
  onListQueryChange,
  searchMode,
  onSearchModeChange,
  vectorSearchEnabled,
  searchModeLabel,
  listPending,
  conversations,
  selectedId,
  onSelectConversation,
  messages,
  threadQuery,
  onThreadQueryChange,
}: DataPaneProps) {
  const deferredThreadQuery = useDeferredValue(threadQuery);
  const threadPending = threadQuery !== deferredThreadQuery;

  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  const visibleMessages = filterMessages(messages, deferredThreadQuery);
  const timeline = useMemo(() => {
    const items = timelineFromTrafficEvents(visibleMessages);
    return filterTimeline(items, deferredThreadQuery);
  }, [visibleMessages, deferredThreadQuery]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <LimitRecoveryBanner
        hit={limitHit}
        onRefreshCredentials={limitActions.onRefreshCredentials}
        onSwitchAccount={limitActions.onSwitchAccount}
        onWait={limitActions.onWait}
      />
      <Panel
        className="mb-0 flex min-h-0 flex-1 flex-col"
        title="Conversations"
        lede="Browse historical conversations captured through the proxy. Search the list or within a thread — vector search is available when Intelligence vectorization is on."
      >
        <div
          className={cn(
            "mt-3.5 grid min-h-0 flex-1 gap-3",
            selected
              ? "grid-cols-1 md:grid-cols-[minmax(280px,1fr)_minmax(0,1.4fr)]"
              : "grid-cols-1",
          )}
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2">
              {vectorSearchEnabled ? (
                <div
                  className="inline-flex shrink-0 items-stretch gap-px rounded-[9px] border border-border/60 bg-background p-0.5"
                  role="radiogroup"
                  aria-label="Search mode"
                >
                  {SEARCH_MODES.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={searchMode === id}
                      className={cn(
                        "cursor-pointer rounded-[7px] border-0 bg-transparent px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground",
                        "hover:bg-white/3 hover:text-foreground",
                        searchMode === id &&
                          "bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--border)]",
                      )}
                      onClick={() => onSearchModeChange(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              <Input
                className="min-w-0 flex-1"
                tone="plain"
                placeholder="Search conversations…"
                value={listQuery}
                aria-busy={listPending || undefined}
                onChange={(e) => onListQueryChange(e.target.value)}
              />
              {searchModeLabel ? (
                <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
                  {searchModeLabel}
                </span>
              ) : null}
            </div>

            {conversations.length === 0 && !listPending ? (
              <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-[10px] border border-border/60">
                <Empty>
                  {listQuery.trim()
                    ? "No conversations match this search."
                    : "No conversations yet — start the proxy to capture history."}
                </Empty>
              </div>
            ) : conversations.length === 0 && listPending ? (
              <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-[10px] border border-border/60 opacity-55">
                <Empty>Searching…</Empty>
              </div>
            ) : (
              <ConversationVirtualList
                conversations={conversations}
                selectedId={selectedId}
                catalog={catalog}
                pending={listPending}
                onSelectConversation={onSelectConversation}
              />
            )}
          </div>

          {selected ? (
            <div className="flex min-h-0 min-w-0 flex-col rounded-xl border border-border bg-card/40 px-3.5 py-3">
              <div className="mb-2.5 flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <strong className="text-sm">{selected.title}</strong>
                  <span className="text-muted-foreground">
                    {providerChipLabel(providerKey(selected.provider), catalog)}
                    {selected.model ? ` · ${selected.model}` : ""}
                    {selected.project_id ? ` · ${selected.project_id}` : ""}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  aria-label="Close conversation"
                  onClick={() => onSelectConversation(null)}
                >
                  ✕
                </Button>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  className="min-w-0 flex-1"
                  tone="plain"
                  placeholder="Search in this conversation…"
                  value={threadQuery}
                  aria-busy={threadPending || undefined}
                  onChange={(e) => onThreadQueryChange(e.target.value)}
                />
              </div>
              <div
                className={cn("mt-2 flex min-h-0 flex-1 flex-col", threadPending && "opacity-55")}
                aria-busy={threadPending || undefined}
              >
                {timeline.length === 0 ? (
                  <Empty>
                    {deferredThreadQuery.trim()
                      ? "No messages match this search."
                      : "No messages in this conversation."}
                  </Empty>
                ) : (
                  <TranscriptView items={timeline} />
                )}
              </div>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
