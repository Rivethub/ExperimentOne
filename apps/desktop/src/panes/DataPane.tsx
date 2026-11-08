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
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

const SEARCH_MODES = [
  ["keyword", "Keyword"],
  ["vector", "Vector"],
] as const;

export type DataPaneProps = {
  active: boolean;
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
      className={cx(styles.conversationRow, selected && styles.active)}
      onClick={onSelect}
    >
      <div className={styles.conversationRowTop}>
        <strong className={styles.conversationTitle}>{c.title}</strong>
        <span className={styles.conversationWhen}>{relativeWhen(c.updated_at)}</span>
      </div>
      <div className={styles.conversationRowMeta}>
        <Pill style={{ background: `${color}22`, color }}>
          {providerChipLabel(providerKey(c.provider), catalog)}
        </Pill>
        {c.capture_quality && c.capture_quality !== "wire" ? (
          <Pill tone={c.capture_quality === "soft" ? "warn" : "default"}>{c.capture_quality}</Pill>
        ) : null}
        {(c.agent_ids?.length ?? 0) > 0 || (c.subagent_events ?? 0) > 0 ? (
          <Pill tone="ok">
            {(c.agent_ids?.length ?? 0) > 0
              ? `${c.agent_ids!.length} agent${c.agent_ids!.length === 1 ? "" : "s"}`
              : "subagents"}
          </Pill>
        ) : null}
        {(c.tool_names?.length ?? 0) > 0 ? (
          <Pill>{c.tool_names!.length} tool{c.tool_names!.length === 1 ? "" : "s"}</Pill>
        ) : null}
        {(c.thinking_events ?? 0) > 0 ? <Pill>thinking</Pill> : null}
        {(c.error_events ?? 0) > 0 ? <Pill tone="warn">errors</Pill> : null}
        {(c.media_count ?? 0) > 0 ? <Pill>{c.media_count} media</Pill> : null}
        {c.git_branch ? <Pill>{c.git_branch}</Pill> : null}
        <span className={styles.mono}>{c.model ?? "—"}</span>
        <span className={styles.muted}>
          {c.message_count} msg · {fmt(c.tokens_in)}/{fmt(c.tokens_out)}
          {(c.cache_read_tokens ?? 0) > 0 ? ` · cache ${fmt(c.cache_read_tokens!)}` : ""}
          {(c.thinking_tokens ?? 0) > 0 ? ` · think ${fmt(c.thinking_tokens!)}` : ""}
          {c.api_format ? ` · ${c.api_format}` : ""}
        </span>
      </div>
      {c.preview ? <div className={styles.conversationPreview}>{c.preview}</div> : null}
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
      className={cx(styles.conversationList, pending && styles.conversationListPending)}
      aria-busy={pending || undefined}
    >
      <div
        className={styles.conversationVirtualInner}
        style={{ height: virtualizer.getTotalSize() }}
      >
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
              className={styles.conversationVirtualRow}
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
  active,
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
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <LimitRecoveryBanner
        hit={limitHit}
        onRefreshCredentials={limitActions.onRefreshCredentials}
        onSwitchAccount={limitActions.onSwitchAccount}
        onWait={limitActions.onWait}
      />
      <Panel
        className={styles.dataPage}
        title="Conversations"
        lede="Browse historical conversations captured through the proxy. Search the list or within a thread — vector search is available when Intelligence vectorization is on."
      >
        <div className={cx(styles.dataLayout, selected ? styles.hasThread : "")}>
          <div className={styles.dataListPane}>
            <div className={styles.dataSearchBar}>
              {vectorSearchEnabled ? (
                <div className={styles.searchSegment} role="radiogroup" aria-label="Search mode">
                  {SEARCH_MODES.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={searchMode === id}
                      className={cx(
                        styles.searchSegmentBtn,
                        searchMode === id && styles.searchSegmentActive,
                      )}
                      onClick={() => onSearchModeChange(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              <Input
                className={styles.dataSearchInput}
                tone="plain"
                placeholder="Search conversations…"
                value={listQuery}
                aria-busy={listPending || undefined}
                onChange={(e) => onListQueryChange(e.target.value)}
              />
              {searchModeLabel ? (
                <span className={styles.dataSearchMeta}>{searchModeLabel}</span>
              ) : null}
            </div>

            {conversations.length === 0 && !listPending ? (
              <div className={styles.conversationList}>
                <Empty>
                  {listQuery.trim()
                    ? "No conversations match this search."
                    : "No conversations yet — start the proxy to capture history."}
                </Empty>
              </div>
            ) : conversations.length === 0 && listPending ? (
              <div className={cx(styles.conversationList, styles.conversationListPending)}>
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

          <div className={styles.dataThreadPane}>
            {!selected ? (
              <Empty>Select a conversation to read the transcript.</Empty>
            ) : (
              <>
                <div className={styles.threadHead}>
                  <div className={styles.threadHeadCopy}>
                    <strong>{selected.title}</strong>
                    <span className={styles.muted}>
                      {providerChipLabel(providerKey(selected.provider), catalog)}
                      {selected.model ? ` · ${selected.model}` : ""}
                      {selected.project_id
                        ? ` · ${selected.project_id}`
                        : selected.cwd
                          ? ` · ${selected.cwd}`
                          : ""}
                      {(selected.agent_ids?.length ?? 0) > 0
                        ? ` · ${selected.agent_ids!.length} subagent${selected.agent_ids!.length === 1 ? "" : "s"}`
                        : (selected.subagent_events ?? 0) > 0
                          ? ` · ${selected.subagent_events} subagent turns`
                          : ""}
                      {selected.git_branch ? ` · ${selected.git_branch}` : ""}
                      {(selected.tool_names?.length ?? 0) > 0
                        ? ` · ${selected.tool_names!.slice(0, 4).join(", ")}`
                        : ""}
                      {(selected.cache_read_tokens ?? 0) > 0
                        ? ` · cache ${fmt(selected.cache_read_tokens!)}`
                        : ""}
                      {(selected.thinking_tokens ?? 0) > 0
                        ? ` · think ${fmt(selected.thinking_tokens!)}`
                        : ""}
                      {selected.api_format ? ` · ${selected.api_format}` : ""}
                      {(selected.error_events ?? 0) > 0
                        ? ` · ${selected.error_events} error${selected.error_events === 1 ? "" : "s"}`
                        : ""}
                      {(selected.media_count ?? 0) > 0
                        ? ` · ${selected.media_count} media`
                        : ""}
                    </span>
                    {(selected.agent_ids?.length ?? 0) > 0 ||
                    (selected.tool_names?.length ?? 0) > 0 ? (
                      <div className={styles.conversationRowMeta} style={{ marginTop: 6 }}>
                        {selected.agent_ids?.slice(0, 8).map((id) => (
                          <Pill key={id}>{id.length > 14 ? `${id.slice(0, 8)}…` : id}</Pill>
                        ))}
                        {selected.tool_names?.slice(0, 8).map((name) => (
                          <Pill key={name}>{name}</Pill>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <Button variant="ghost" onClick={() => onSelectConversation(null)}>
                    Close
                  </Button>
                </div>
                <div className={styles.dataSearchBar}>
                  <Input
                    className={styles.dataSearchInput}
                    tone="plain"
                    placeholder="Search in this conversation…"
                    value={threadQuery}
                    aria-busy={threadPending || undefined}
                    onChange={(e) => onThreadQueryChange(e.target.value)}
                  />
                </div>
                <div
                  className={cx(threadPending && styles.conversationListPending)}
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
              </>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
