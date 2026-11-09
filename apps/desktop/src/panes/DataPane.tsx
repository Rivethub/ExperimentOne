import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { filterMessages, relativeWhen } from "../lib/conversation-utils";
import {
  fmt,
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "../lib/provider-utils";
import { LimitRecoveryBanner, type LimitHitInfo } from "../quota";
import { filterTimeline, timelineFromCaptureEvents, TranscriptView } from "../transcript";
import type { ConversationSummary, SearchMode, CaptureEvent } from "../lib/types";
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
  messages: CaptureEvent[];
  threadQuery: string;
  onThreadQueryChange: (query: string) => void;
  busy?: boolean;
  onExportConversations?: (conversationIds: string[]) => void;
};

function ConversationRow(props: {
  conversation: ConversationSummary;
  selected: boolean;
  catalog: CatalogProvider[];
  onSelect: () => void;
}) {
  const color = createMemo(() =>
    providerColor(providerKey(props.conversation.provider), props.catalog),
  );
  return (
    <button
      type="button"
      class={cn(
        "flex w-full cursor-pointer flex-col gap-1.5 border-0 border-b border-border/60 bg-transparent px-3.5 py-3 text-left text-foreground",
        "hover:bg-accent",
        props.selected && "bg-secondary",
      )}
      onClick={() => props.onSelect()}
    >
      <div class="flex items-baseline justify-between gap-2.5">
        <strong class="truncate text-[13px] font-semibold">{props.conversation.title}</strong>
        <span class="shrink-0 text-[11px] text-muted-foreground">
          {relativeWhen(props.conversation.updated_at)}
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-[11.5px]">
        <Pill style={{ background: `${color()}22`, color: color() }}>
          {providerChipLabel(providerKey(props.conversation.provider), props.catalog)}
        </Pill>
        {props.conversation.capture_quality && props.conversation.capture_quality !== "wire" ? (
          <Pill tone={props.conversation.capture_quality === "soft" ? "warn" : "default"}>
            {props.conversation.capture_quality}
          </Pill>
        ) : null}
        {(props.conversation.agent_ids?.length ?? 0) > 0 ||
        (props.conversation.subagent_events ?? 0) > 0 ? (
          <Pill tone="ok">
            {(props.conversation.agent_ids?.length ?? 0) > 0
              ? `${props.conversation.agent_ids!.length} agent${props.conversation.agent_ids!.length === 1 ? "" : "s"}`
              : "subagents"}
          </Pill>
        ) : null}
        {(props.conversation.tool_names?.length ?? 0) > 0 ? (
          <Pill>
            {props.conversation.tool_names!.length} tool
            {props.conversation.tool_names!.length === 1 ? "" : "s"}
          </Pill>
        ) : null}
        {(props.conversation.thinking_events ?? 0) > 0 ? <Pill>thinking</Pill> : null}
        {(props.conversation.error_events ?? 0) > 0 ? <Pill tone="warn">errors</Pill> : null}
        {(props.conversation.media_count ?? 0) > 0 ? (
          <Pill>{props.conversation.media_count} media</Pill>
        ) : null}
        {props.conversation.git_branch ? <Pill>{props.conversation.git_branch}</Pill> : null}
        <span class="font-mono text-xs">{props.conversation.model ?? "—"}</span>
        <span class="text-muted-foreground">
          {props.conversation.message_count} msg · {fmt(props.conversation.tokens_in)}/
          {fmt(props.conversation.tokens_out)}
          {(props.conversation.cache_read_tokens ?? 0) > 0
            ? ` · cache ${fmt(props.conversation.cache_read_tokens!)}`
            : ""}
          {(props.conversation.thinking_tokens ?? 0) > 0
            ? ` · think ${fmt(props.conversation.thinking_tokens!)}`
            : ""}
          {props.conversation.api_format ? ` · ${props.conversation.api_format}` : ""}
        </span>
      </div>
      {props.conversation.preview ? (
        <div class="truncate text-xs text-muted-foreground">{props.conversation.preview}</div>
      ) : null}
    </button>
  );
}

function ConversationVirtualList(props: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  catalog: CatalogProvider[];
  pending: boolean;
  onSelectConversation: (id: string | null) => void;
}) {
  let parentRef: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return props.conversations.length;
    },
    getScrollElement: () => parentRef ?? null,
    estimateSize: () => 96,
    overscan: 10,
    getItemKey: (index) => props.conversations[index]?.id ?? index,
  });

  return (
    <div
      ref={(el) => {
        parentRef = el;
      }}
      class={cn(
        "mt-3 min-h-0 flex-1 overflow-auto rounded-[10px] border border-border/60 transition-opacity duration-100",
        props.pending && "opacity-55",
      )}
      aria-busy={props.pending || undefined}
    >
      {/* relative + absolute rows required by the virtualizer */}
      <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((row) => {
          const c = props.conversations[row.index]!;
          const style = {
            transform: `translateY(${row.start}px)`,
          } satisfies JSX.CSSProperties;
          return (
            <div
              data-index={row.index}
              ref={virtualizer.measureElement}
              class="absolute top-0 left-0 w-full"
              style={style}
            >
              <ConversationRow
                conversation={c}
                selected={props.selectedId === c.id}
                catalog={props.catalog}
                onSelect={() => props.onSelectConversation(c.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DataPane(props: DataPaneProps) {
  const selected = createMemo(
    () => props.conversations.find((c) => c.id === props.selectedId) ?? null,
  );
  const visibleMessages = createMemo(() => filterMessages(props.messages, props.threadQuery));
  const timeline = createMemo(() => {
    const items = timelineFromCaptureEvents(visibleMessages());
    return filterTimeline(items, props.threadQuery);
  });
  const searchActive = createMemo(() => props.listQuery.trim().length > 0);
  const canExportMatches = createMemo(
    () =>
      Boolean(props.onExportConversations) &&
      searchActive() &&
      props.conversations.length > 0 &&
      !props.listPending,
  );

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <LimitRecoveryBanner
        hit={props.limitHit}
        onRefreshCredentials={props.limitActions.onRefreshCredentials}
        onSwitchAccount={props.limitActions.onSwitchAccount}
        onWait={props.limitActions.onWait}
      />
      <Panel
        class="mb-0 flex min-h-0 flex-1 flex-col"
        title="Conversations"
        lede="Browse historical conversations captured through the proxy. Search the list or within a thread — vector search is available when Intelligence vectorization is on."
      >
        <div
          class={cn(
            "mt-3.5 grid min-h-0 flex-1 gap-3",
            selected()
              ? "grid-cols-1 md:grid-cols-[minmax(280px,1fr)_minmax(0,1.4fr)]"
              : "grid-cols-1",
          )}
        >
          <div class="flex min-h-0 min-w-0 flex-col">
            <div class="flex min-w-0 items-center gap-2">
              <Show when={props.vectorSearchEnabled}>
                <div
                  class="inline-flex shrink-0 items-stretch gap-px rounded-[9px] border border-border/60 bg-background p-0.5"
                  role="radiogroup"
                  aria-label="Search mode"
                >
                  {SEARCH_MODES.map(([id, label]) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={props.searchMode === id}
                      class={cn(
                        "cursor-pointer rounded-[7px] border-0 bg-transparent px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground",
                        "hover:bg-white/3 hover:text-foreground",
                        props.searchMode === id &&
                          "bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--border)]",
                      )}
                      onClick={() => props.onSearchModeChange(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Show>
              <Input
                class="min-w-0 flex-1"
                tone="plain"
                placeholder="Search conversations…"
                value={props.listQuery}
                aria-busy={props.listPending || undefined}
                onInput={(e) => props.onListQueryChange(e.currentTarget.value)}
              />
              <Show when={props.searchModeLabel}>
                {(label) => (
                  <span class="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
                    {label()}
                  </span>
                )}
              </Show>
            </div>
            <Show when={canExportMatches()}>
              <div class="mt-2 flex items-center justify-between gap-2">
                <span class="text-[11px] text-muted-foreground">
                  {props.conversations.length} matching conversation
                  {props.conversations.length === 1 ? "" : "s"}
                </span>
                <Button
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() =>
                    props.onExportConversations?.(
                      props.conversations.map((conversation) => conversation.id),
                    )
                  }
                >
                  Export matching
                </Button>
              </div>
            </Show>

            <Show
              when={props.conversations.length > 0}
              fallback={
                <div
                  class={cn(
                    "mt-3 min-h-0 flex-1 overflow-auto rounded-[10px] border border-border/60",
                    props.listPending && "opacity-55",
                  )}
                >
                  <Empty>
                    {props.listPending
                      ? "Searching…"
                      : props.listQuery.trim()
                        ? "No conversations match this search."
                        : "No conversations yet — start the proxy to capture history."}
                  </Empty>
                </div>
              }
            >
              <ConversationVirtualList
                conversations={props.conversations}
                selectedId={props.selectedId}
                catalog={props.catalog}
                pending={props.listPending}
                onSelectConversation={props.onSelectConversation}
              />
            </Show>
          </div>

          <Show when={selected()}>
            {(sel) => (
              <div class="flex min-h-0 min-w-0 flex-col rounded-xl border border-border bg-card/40 px-3.5 py-3">
                <div class="mb-2.5 flex items-start justify-between gap-3">
                  <div class="flex min-w-0 flex-col gap-1">
                    <strong class="text-sm">{sel().title}</strong>
                    <span class="text-muted-foreground">
                      {providerChipLabel(providerKey(sel().provider), props.catalog)}
                      {sel().model ? ` · ${sel().model}` : ""}
                      {sel().project_id
                        ? ` · ${sel().project_id}`
                        : sel().cwd
                          ? ` · ${sel().cwd}`
                          : ""}
                      {(sel().agent_ids?.length ?? 0) > 0
                        ? ` · ${sel().agent_ids!.length} subagent${sel().agent_ids!.length === 1 ? "" : "s"}`
                        : (sel().subagent_events ?? 0) > 0
                          ? ` · ${sel().subagent_events} subagent turns`
                          : ""}
                      {sel().git_branch ? ` · ${sel().git_branch}` : ""}
                      {(sel().tool_names?.length ?? 0) > 0
                        ? ` · ${sel().tool_names!.slice(0, 4).join(", ")}`
                        : ""}
                      {(sel().cache_read_tokens ?? 0) > 0
                        ? ` · cache ${fmt(sel().cache_read_tokens!)}`
                        : ""}
                      {(sel().thinking_tokens ?? 0) > 0
                        ? ` · think ${fmt(sel().thinking_tokens!)}`
                        : ""}
                      {sel().api_format ? ` · ${sel().api_format}` : ""}
                      {(sel().error_events ?? 0) > 0
                        ? ` · ${sel().error_events} error${sel().error_events === 1 ? "" : "s"}`
                        : ""}
                      {(sel().media_count ?? 0) > 0 ? ` · ${sel().media_count} media` : ""}
                    </span>
                    <Show
                      when={
                        (sel().agent_ids?.length ?? 0) > 0 || (sel().tool_names?.length ?? 0) > 0
                      }
                    >
                      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {sel()
                          .agent_ids?.slice(0, 8)
                          .map((id) => (
                            <Pill>{id.length > 14 ? `${id.slice(0, 8)}…` : id}</Pill>
                          ))}
                        {sel()
                          .tool_names?.slice(0, 8)
                          .map((name) => (
                            <Pill>{name}</Pill>
                          ))}
                      </div>
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <Show when={props.onExportConversations && props.selectedId}>
                      <Button
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => props.onExportConversations?.([props.selectedId!])}
                      >
                        Export
                      </Button>
                    </Show>
                    <Button
                      variant="ghost"
                      aria-label="Close conversation"
                      onClick={() => props.onSelectConversation(null)}
                    >
                      ✕
                    </Button>
                  </div>
                </div>
                <div class="flex min-w-0 items-center gap-2">
                  <Input
                    class="min-w-0 flex-1"
                    tone="plain"
                    placeholder="Search in this conversation…"
                    value={props.threadQuery}
                    onInput={(e) => props.onThreadQueryChange(e.currentTarget.value)}
                  />
                </div>
                <div class="mt-2 flex min-h-0 flex-1 flex-col">
                  <Show
                    when={timeline().length > 0}
                    fallback={
                      <Empty>
                        {props.threadQuery.trim()
                          ? "No messages match this search."
                          : "No messages in this conversation."}
                      </Empty>
                    }
                  >
                    <TranscriptView items={timeline()} />
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Panel>
    </div>
  );
}
