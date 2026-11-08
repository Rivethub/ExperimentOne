import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useCallback, useEffect, useRef } from "react";
import { rivetErrorMessage, runApp } from "../effect";
import * as Rivet from "../effect/rivet";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/query-keys";
import type { ConversationSummary, SearchMode, TrafficEvent } from "../lib/types";

export type ConversationSearchResult = {
  results: ConversationSummary[];
  modeLabel: string | null;
};

const SEARCH_DEBOUNCE_MS = 250;

async function fetchConversations(
  query: string,
  mode: SearchMode,
): Promise<ConversationSearchResult> {
  return runApp(
    Effect.gen(function* loadOrSearchConversations() {
      yield* Rivet.requireBackend;
      if (!query.trim()) {
        const rows = yield* Rivet.listConversations(100);
        return { results: rows, modeLabel: null };
      }
      const body = yield* Rivet.searchConversations(query, mode);
      const modeLabel =
        body.mode === "vector"
          ? "vector"
          : body.mode === "keyword_fallback"
            ? "keyword fallback"
            : body.mode === "keyword"
              ? "keyword"
              : null;
      return { results: body.results, modeLabel };
    }),
  );
}

async function fetchConversationEvents(id: string): Promise<TrafficEvent[]> {
  return runApp(
    Effect.gen(function* loadConversationTimeline() {
      yield* Rivet.requireBackend;
      return yield* Rivet.getConversationEvents(id);
    }),
  );
}

export function useConversations(opts: {
  enabled: boolean;
  query: string;
  mode: SearchMode;
  selectedId: string | null;
}) {
  const { enabled, query, mode, selectedId } = opts;
  const queryClient = useQueryClient();
  const [debouncedQuery] = useDebouncedValue(query, { wait: SEARCH_DEBOUNCE_MS });
  const [debouncedMode] = useDebouncedValue(mode, { wait: SEARCH_DEBOUNCE_MS });
  const lastListError = useRef<unknown>(null);
  const lastEventsError = useRef<unknown>(null);

  const listQuery = useQuery({
    queryKey: queryKeys.conversations(debouncedQuery, debouncedMode),
    queryFn: () => fetchConversations(debouncedQuery, debouncedMode),
    enabled,
    placeholderData: keepPreviousData,
  });

  const eventsQuery = useQuery({
    queryKey: queryKeys.conversationEvents(selectedId ?? ""),
    queryFn: () => fetchConversationEvents(selectedId!),
    enabled: selectedId != null && selectedId !== "",
  });

  useEffect(() => {
    if (listQuery.error != null && listQuery.error !== lastListError.current) {
      lastListError.current = listQuery.error;
      notify.error(rivetErrorMessage(listQuery.error));
    }
  }, [listQuery.error]);

  useEffect(() => {
    if (eventsQuery.error != null && eventsQuery.error !== lastEventsError.current) {
      lastEventsError.current = eventsQuery.error;
      notify.error(rivetErrorMessage(eventsQuery.error));
    }
  }, [eventsQuery.error]);

  const refreshConversations = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }, [queryClient]);

  const searchPending = query !== debouncedQuery || mode !== debouncedMode;

  return {
    conversations: listQuery.data?.results ?? [],
    searchModeLabel: listQuery.data?.modeLabel ?? null,
    listSearching: searchPending || listQuery.isFetching,
    messages: eventsQuery.data ?? [],
    eventsLoading: eventsQuery.isFetching,
    refreshConversations,
  };
}
