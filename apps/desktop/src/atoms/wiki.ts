import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import * as Rivet from "../effect/rivet";
import { appAtomRegistry } from "./registry";

const fetchWiki = Effect.gen(function* loadWikiSnapshot() {
  yield* Rivet.requireBackend;
  return yield* Rivet.getWiki;
});

/**
 * Wiki index atom — polls every 1s while mounted (wiki page subscribed).
 * Soft failures stay in AsyncResult; UI maps them to null.
 */
export const wikiAtom = Atom.make(fetchWiki).pipe(
  Atom.withRefresh("1 second"),
  Atom.withLabel("rivet:wiki"),
);

/** Imperative refresh for mutations (workers / config) outside the wiki page. */
export function refreshWikiAtom(): void {
  appAtomRegistry.refresh(wikiAtom);
}
