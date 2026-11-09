import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/solid-query";
import { Effect } from "effect";
import type { Accessor } from "solid-js";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { rivetErrorMessage, runApp } from "../effect";
import * as Rivet from "../effect/rivet";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/query-keys";
import type { ConversationSummary, SearchMode, CaptureEvent } from "../lib/types";

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

async function fetchConversationEvents(id: string): Promise<CaptureEvent[]> {
  return runApp(
    Effect.gen(function* loadConversationTimeline() {
      yield* Rivet.requireBackend;
      return yield* Rivet.getConversationEvents(id);
    }),
  );
}

function useDebounced<T>(source: Accessor<T>, wait: number): Accessor<T> {
  const [debounced, setDebounced] = createSignal(source());
  createEffect(() => {
    const value = source();
    const timer = setTimeout(() => setDebounced(() => value), wait);
    onCleanup(() => clearTimeout(timer));
  });
  return debounced;
}

export function useConversations(opts: {
  enabled: Accessor<boolean>;
  query: Accessor<string>;
  mode: Accessor<SearchMode>;
  selectedId: Accessor<string | null>;
}) {
  const queryClient = useQueryClient();
  const debouncedQuery = useDebounced(opts.query, SEARCH_DEBOUNCE_MS);
  const debouncedMode = useDebounced(opts.mode, SEARCH_DEBOUNCE_MS);
  const lastListError = { current: null as unknown };
  const lastEventsError = { current: null as unknown };

  const listQuery = useQuery(() => ({
    queryKey: queryKeys.conversations(debouncedQuery(), debouncedMode()),
    queryFn: () => fetchConversations(debouncedQuery(), debouncedMode()),
    enabled: opts.enabled(),
    placeholderData: keepPreviousData,
  }));

  const eventsQuery = useQuery(() => ({
    queryKey: queryKeys.conversationEvents(opts.selectedId() ?? ""),
    queryFn: () => fetchConversationEvents(opts.selectedId()!),
    enabled: opts.selectedId() != null && opts.selectedId() !== "",
  }));

  createEffect(() => {
    const error = listQuery.error;
    if (error != null && error !== lastListError.current) {
      lastListError.current = error;
      notify.error(rivetErrorMessage(error));
    }
  });

  createEffect(() => {
    const error = eventsQuery.error;
    if (error != null && error !== lastEventsError.current) {
      lastEventsError.current = error;
      notify.error(rivetErrorMessage(error));
    }
  });

  const refreshConversations = async () => {
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  return {
    get conversations() {
      return listQuery.data?.results ?? [];
    },
    get searchModeLabel() {
      return listQuery.data?.modeLabel ?? null;
    },
    get listSearching() {
      return (
        opts.query() !== debouncedQuery() || opts.mode() !== debouncedMode() || listQuery.isFetching
      );
    },
    get messages() {
      return eventsQuery.data ?? [];
    },
    get eventsLoading() {
      return eventsQuery.isFetching;
    },
    refreshConversations,
  };
}
