import { useAtomValue } from "@effect/atom-solid";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { refreshTopicsAtom, topicsAtom } from "../atoms/topics";
import type {
  FlaggedJobCard,
  TagSuggestionCard,
  TopicCard,
  TidyProposalCard,
} from "../panes/TopicsPane";
import { runAppExit } from "../effect";
import * as Rivet from "../effect/rivet";
import { notify } from "../lib/notify";

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

const emptySnapshot = {
  topics: [] as TopicCard[],
  tidy: [] as TidyProposalCard[],
  tags: [] as TagSuggestionCard[],
  flagged: [] as FlaggedJobCard[],
};

/**
 * Topics via @effect/atom-solid. Call only from the topics route so the atom
 * polls while the pane is mounted.
 */
export function useTopics(): UseTopicsResult {
  const result = useAtomValue(() => topicsAtom);

  const refreshTopics = async () => {
    try {
      refreshTopicsAtom();
    } catch {
      /* soft-fail while rivetd is down */
    }
  };

  const decideTidy = async (id: string, status: "approved" | "rejected") => {
    const outcome = await runAppExit(
      Effect.gen(function* decide() {
        yield* Rivet.requireBackend;
        yield* Rivet.decideTidy(id, status);
      }),
    );
    if (!outcome.ok) {
      notify.error(outcome.error);
      return;
    }
    refreshTopicsAtom();
  };

  const decideTag = async (id: string, status: "accepted" | "rejected") => {
    const outcome = await runAppExit(
      Effect.gen(function* decide() {
        yield* Rivet.requireBackend;
        yield* Rivet.decideTag(id, status);
      }),
    );
    if (!outcome.ok) {
      notify.error(outcome.error);
      return;
    }
    refreshTopicsAtom();
  };

  const retryFlagged = async (task: string, jobKey: string) => {
    const outcome = await runAppExit(
      Effect.gen(function* retry() {
        yield* Rivet.requireBackend;
        yield* Rivet.retryFlagged(task, jobKey);
      }),
    );
    if (!outcome.ok) {
      notify.error(outcome.error);
      return;
    }
    refreshTopicsAtom();
  };

  return {
    get topics() {
      return AsyncResult.getOrElse(result(), () => emptySnapshot).topics;
    },
    get tidy() {
      return AsyncResult.getOrElse(result(), () => emptySnapshot).tidy;
    },
    get tags() {
      return AsyncResult.getOrElse(result(), () => emptySnapshot).tags;
    },
    get flagged() {
      return AsyncResult.getOrElse(result(), () => emptySnapshot).flagged;
    },
    refreshTopics,
    decideTidy,
    decideTag,
    retryFlagged,
  };
}
