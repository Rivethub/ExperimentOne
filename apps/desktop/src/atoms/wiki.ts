import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import * as Rivet from "../effect/rivet";
import { appAtomRegistry } from "./registry";
import { appRuntime } from "./runtime";

const fetchWiki = Effect.gen(function* loadWikiSnapshot() {
  yield* Rivet.requireBackend;
  return yield* Rivet.getWiki;
});

/**
 * Wiki index atom — slow safety poll while mounted; `useLiveEvents` refreshes
 * on wiki_revision bumps from rivetd.
 * Soft failures stay in AsyncResult; UI maps them to null.
 */
export const wikiAtom = appRuntime
  .atom(fetchWiki)
  .pipe(Atom.withRefresh("30 seconds"), Atom.withLabel("rivet:wiki"));

/** Imperative refresh for mutations (workers / config) outside the wiki page. */
export function refreshWikiAtom(): void {
  appAtomRegistry.refresh(wikiAtom);
}
