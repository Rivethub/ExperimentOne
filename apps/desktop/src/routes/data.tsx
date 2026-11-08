import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useApp } from "#app/context";
import { validateDataSearch } from "#app/search";
import { useConversations } from "#hooks";
import { DataPane } from "#panes";

export const Route = createFileRoute("/data")({
  validateSearch: validateDataSearch,
  component: DataLayout,
});

function DataLayout(): React.ReactElement {
  const { rivet, derived, hideLimitBanner, openSettings } = useApp();
  const search = Route.useSearch();
  const { q, mode, thread } = search;
  const navigate = Route.useNavigate();
  const rootNavigate = useNavigate();
  const { conversationId } = useParams({ strict: false });
  const selectedId = conversationId ?? null;

  const vectorSearchEnabled = !!rivet.status?.capabilities.vector_search;

  useEffect(() => {
    if (vectorSearchEnabled || mode !== "vector") return;
    void navigate({ search: (prev) => ({ ...prev, mode: "keyword" }) });
  }, [vectorSearchEnabled, mode, navigate]);

  const conversations = useConversations({
    enabled: true,
    query: q,
    mode,
    selectedId,
  });

  const limitActions = useMemo(
    () => ({
      onRefreshCredentials: () => void rivet.refreshCredentials(),
      onSwitchAccount: () => openSettings("accounts"),
      onWait: () => hideLimitBanner(),
    }),
    [rivet, openSettings, hideLimitBanner],
  );

  return (
    <DataPane
      limitHit={derived.limitHit}
      limitActions={limitActions}
      catalog={rivet.catalog}
      listQuery={q}
      onListQueryChange={(next) => void navigate({ search: (prev) => ({ ...prev, q: next }) })}
      searchMode={mode}
      onSearchModeChange={(next) => void navigate({ search: (prev) => ({ ...prev, mode: next }) })}
      vectorSearchEnabled={vectorSearchEnabled}
      searchModeLabel={conversations.searchModeLabel}
      listPending={conversations.listSearching}
      conversations={conversations.conversations}
      selectedId={selectedId}
      onSelectConversation={(id) => {
        const nextSearch = { ...search, thread: "" };
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
      threadQuery={thread}
      onThreadQueryChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, thread: next }) })
      }
    />
  );
}
