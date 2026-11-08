import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { refreshWikiAtom, wikiAtom } from "../atoms/wiki";
import type { WikiInfo, WikiPageCard } from "../components/WikiBoard";
import { runApp } from "../effect";
import * as Rivet from "../effect/rivet";

export type UseWikiResult = {
  wiki: WikiInfo | null;
  refreshWiki: () => Promise<void>;
  loadWikiPage: (wikiPage: WikiPageCard) => Promise<string>;
};

/**
 * Wiki data via @effect/atom-react (spike vs TanStack Query).
 * Call only from the wiki route so `wikiAtom` polls while mounted.
 */
export function useWiki(): UseWikiResult {
  const result = useAtomValue(wikiAtom);

  const refreshWiki = useCallback(async () => {
    try {
      refreshWikiAtom();
    } catch {
      /* soft-fail — same as previous Query catch */
    }
  }, []);

  const loadWikiPage = useCallback(
    (wikiPage: WikiPageCard) => runApp(Rivet.loadWikiPageContent(wikiPage)),
    [],
  );

  return {
    wiki: AsyncResult.getOrElse(result, () => null),
    refreshWiki,
    loadWikiPage,
  };
}
