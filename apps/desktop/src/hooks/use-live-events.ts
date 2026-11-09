import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { refreshWikiAtom } from "../atoms/wiki";
import { runApp, softEffect } from "../effect";
import * as Rivet from "../effect/rivet";
import { queryKeys } from "../lib/query-keys";

type LiveCursor = {
  wiki_revision: number;
  capture_events: number;
  observed_at: string;
};

/**
 * Subscribe to rivetd live updates (Tauri host poll → `rivet-live` events).
 * Falls back to a light `/v1/live` poll when events are unavailable (mock / browser).
 */
export function useLiveEvents(enabled = true): void {
  const queryClient = useQueryClient();
  const last = useRef<LiveCursor | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onCursor = (cursor: LiveCursor) => {
      const prev = last.current;
      last.current = cursor;
      if (prev == null) {
        return;
      }
      if (cursor.capture_events !== prev.capture_events) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.home });
      }
      if (cursor.wiki_revision !== prev.wiki_revision) {
        refreshWikiAtom();
      }
    };

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const startFallbackPoll = () => {
      if (pollTimer != null) {
        return;
      }
      pollTimer = setInterval(() => {
        void runApp(softEffect(Rivet.getLiveCursor)).then((cursor) => {
          if (cursor != null) {
            onCursor(cursor);
          }
        });
      }, 2_500);
    };

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) {
          return;
        }
        unlisten = await listen<LiveCursor>("rivet-live", (event) => {
          onCursor(event.payload);
        });
        // Seed once so revision deltas work after the first host emit.
        const seed = await runApp(softEffect(Rivet.getLiveCursor));
        if (seed != null) {
          onCursor(seed);
        }
      } catch {
        startFallbackPoll();
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      if (pollTimer != null) {
        clearInterval(pollTimer);
      }
    };
  }, [enabled, queryClient]);
}
