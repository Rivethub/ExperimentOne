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
  listArchives: (projectId: string, slug: string) => Promise<string[]>;
  loadArchive: (projectId: string, slug: string, file: string) => Promise<string>;
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

  const listArchives = useCallback(
    (projectId: string, slug: string) => runApp(Rivet.loadWikiArchiveList(slug, projectId)),
    [],
  );

  const loadArchive = useCallback(
    (projectId: string, slug: string, file: string) =>
      runApp(Rivet.loadWikiArchiveContent(slug, file, projectId)),
    [],
  );

  return {
    wiki: AsyncResult.getOrElse(result, () => null),
    refreshWiki,
    loadWikiPage,
    listArchives,
    loadArchive,
  };
}
