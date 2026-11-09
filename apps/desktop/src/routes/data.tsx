import { createFileRoute, useNavigate, useParams } from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { createEffect, createMemo } from "solid-js";
import { useApp } from "#app/context";
import { validateDataSearch } from "#app/search";
import { useConversations } from "#hooks";
import { DataPane } from "#panes";

export const Route = createFileRoute("/data")({
  validateSearch: validateDataSearch,
  component: DataLayout,
});

function DataLayout(): JSX.Element {
  const { rivet, derived, hideLimitBanner, openSettings, ops, busy } = useApp();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const rootNavigate = useNavigate();
  const params = useParams({ strict: false });
  const selectedId = () => params().conversationId ?? null;

  const vectorSearchEnabled = () => !!rivet.status?.capabilities.vector_search;

  createEffect(() => {
    if (vectorSearchEnabled() || search().mode !== "vector") {
      return;
    }
    void navigate({ search: (prev) => ({ ...prev, mode: "keyword" }) });
  });

  const conversations = useConversations({
    enabled: () => true,
    query: () => search().q,
    mode: () => search().mode,
    selectedId,
  });

  const limitActions = createMemo(() => ({
    onRefreshCredentials: () => void rivet.refreshCredentials(),
    onSwitchAccount: () => openSettings("accounts"),
    onWait: () => hideLimitBanner(),
  }));

  return (
    <DataPane
      limitHit={derived.limitHit}
      limitActions={limitActions()}
      catalog={rivet.catalog}
      listQuery={search().q}
      onListQueryChange={(next) => void navigate({ search: (prev) => ({ ...prev, q: next }) })}
      searchMode={search().mode}
      onSearchModeChange={(next) => void navigate({ search: (prev) => ({ ...prev, mode: next }) })}
      vectorSearchEnabled={vectorSearchEnabled()}
      searchModeLabel={conversations.searchModeLabel}
      listPending={conversations.listSearching}
      conversations={conversations.conversations}
      selectedId={selectedId()}
      onSelectConversation={(id) => {
        const nextSearch = { ...search(), thread: "" };
        if (id === null) {
          void rootNavigate({ to: "/data", search: nextSearch });
          return;
        }
        void rootNavigate({
          to: "/data/c/$conversationId",
          params: { conversationId: id },
          search: nextSearch,
        });
      }}
      messages={conversations.messages}
      threadQuery={search().thread}
      onThreadQueryChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, thread: next }) })
      }
      busy={busy()}
      onExportConversations={(ids) => void ops.exportBag(ids)}
    />
  );
}
