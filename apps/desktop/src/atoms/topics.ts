import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import * as Rivet from "../effect/rivet";
import { appAtomRegistry } from "./registry";
import { appRuntime } from "./runtime";

export type TopicsSnapshot = {
  topics: Rivet.TopicCard[];
  tidy: Rivet.TidyProposal[];
  tags: Rivet.TagSuggestion[];
  flagged: Rivet.FlaggedJob[];
};

const fetchTopics = Effect.gen(function* loadTopicsSnapshot() {
  yield* Rivet.requireBackend;
  const snapshot = yield* Effect.all(
    {
      topics: Rivet.listTopics(),
      tidy: Rivet.listTidy,
      tags: Rivet.listTags,
      flagged: Rivet.listFlagged,
    },
    { concurrency: "unbounded" },
  );
  return {
    topics: snapshot.topics,
    tidy: snapshot.tidy.proposals,
    tags: snapshot.tags.suggestions,
    flagged: snapshot.flagged.flagged,
  } satisfies TopicsSnapshot;
});

/**
 * Topics + tidy/tags/flagged — polls while the topics route keeps the atom mounted.
 */
export const topicsAtom = appRuntime
  .atom(fetchTopics)
  .pipe(Atom.withRefresh("2 seconds"), Atom.withLabel("rivet:topics"));

export function refreshTopicsAtom(): void {
  appAtomRegistry.refresh(topicsAtom);
}
