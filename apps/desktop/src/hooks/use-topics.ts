import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import type {
  FlaggedJobCard,
  TagSuggestionCard,
  TopicCard,
  TidyProposalCard,
} from "../panes/TopicsPane";
import { runApp } from "../effect";
import * as Rivet from "../effect/rivet";

export type UseTopicsResult = {
  topics: TopicCard[];
  tidy: TidyProposalCard[];
  tags: TagSuggestionCard[];
  flagged: FlaggedJobCard[];
  refreshTopics: () => Promise<void>;
  decideTidy: (id: string, status: "approved" | "rejected") => Promise<void>;
  decideTag: (id: string, status: "accepted" | "rejected") => Promise<void>;
  retryFlagged: (task: string, jobKey: string) => Promise<void>;
};

export function useTopics(opts: {
  page: string;
  ensureSession: () => Promise<void>;
}): UseTopicsResult {
  const { page } = opts;
  const [topics, setTopics] = useState<TopicCard[]>([]);
  const [tidy, setTidy] = useState<TidyProposalCard[]>([]);
  const [tags, setTags] = useState<TagSuggestionCard[]>([]);
  const [flagged, setFlagged] = useState<FlaggedJobCard[]>([]);

  const refreshTopics = useCallback(async () => {
    try {
      const next = await runApp(
        Effect.gen(function* refreshTopicsSnapshot() {
          yield* Rivet.requireBackend;
          const topicsFx = yield* Rivet.listTopics();
          const tidyFx = yield* Rivet.listTidy();
          const tagsFx = yield* Rivet.listTags();
          const flaggedFx = yield* Rivet.listFlagged();
          return {
            topics: topicsFx,
            tidy: tidyFx.proposals,
            tags: tagsFx.suggestions,
            flagged: flaggedFx.flagged,
          };
        }),
      );
      setTopics(next.topics);
      setTidy(next.tidy);
      setTags(next.tags);
      setFlagged(next.flagged);
    } catch {
      /* ignore */
    }
  }, []);

  const decideTidy = useCallback(
    async (id: string, status: "approved" | "rejected") => {
      try {
        await runApp(
          Effect.gen(function* decide() {
            yield* Rivet.requireBackend;
            yield* Rivet.decideTidy(id, status);
          }),
        );
        await refreshTopics();
      } catch {
        /* ignore */
      }
    },
    [refreshTopics],
  );

  const decideTag = useCallback(
    async (id: string, status: "accepted" | "rejected") => {
      try {
        await runApp(
          Effect.gen(function* decide() {
            yield* Rivet.requireBackend;
            yield* Rivet.decideTag(id, status);
          }),
        );
        await refreshTopics();
      } catch {
        /* ignore */
      }
    },
    [refreshTopics],
  );

  const retryFlagged = useCallback(
    async (task: string, jobKey: string) => {
      try {
        await runApp(
          Effect.gen(function* retry() {
            yield* Rivet.requireBackend;
            yield* Rivet.retryFlagged(task, jobKey);
          }),
        );
        await refreshTopics();
      } catch {
        /* ignore */
      }
    },
    [refreshTopics],
  );

  useEffect(() => {
    if (page !== "topics") {
      return () => {
        /* no topics polling */
      };
    }
    void refreshTopics();
    const id = setInterval(() => {
      void refreshTopics();
    }, 2000);
    return () => {
      clearInterval(id);
    };
  }, [page, refreshTopics]);

  return {
    topics,
    tidy,
    tags,
    flagged,
    refreshTopics,
    decideTidy,
    decideTag,
    retryFlagged,
  };
}
