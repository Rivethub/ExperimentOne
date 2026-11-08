import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import type { WikiInfo, WikiPageCard } from "../components/WikiBoard";
import { runApp } from "../effect";
import * as Rivet from "../effect/rivet";

export type UseWikiResult = {
  wiki: WikiInfo | null;
  refreshWiki: () => Promise<void>;
  loadWikiPage: (wikiPage: WikiPageCard) => Promise<string>;
};

function wikiPagesUnchanged(prev: WikiInfo, next: WikiInfo): boolean {
  if (prev.revision !== next.revision) {
    return false;
  }
  if (prev.pages.length !== next.pages.length) {
    return false;
  }
  return prev.pages.every((p, i) => {
    const n = next.pages[i];
    if (n === undefined) {
      return false;
    }
    return p.id === n.id && p.updated_at === n.updated_at;
  });
}

export function useWiki(opts: {
  page: string;
  ensureSession: () => Promise<void>;
}): UseWikiResult {
  const { page } = opts;
  const [wiki, setWiki] = useState<WikiInfo | null>(null);

  const refreshWiki = useCallback(async () => {
    try {
      const next = await runApp(
        Effect.gen(function* refreshWikiSnapshot() {
          yield* Rivet.requireBackend;
          return yield* Rivet.getWiki;
        }),
      );
      setWiki((prev) => {
        if (prev !== null && wikiPagesUnchanged(prev, next)) {
          return prev;
        }
        return next;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const loadWikiPage = useCallback(
    (wikiPage: WikiPageCard) => runApp(Rivet.loadWikiPageContent(wikiPage)),
    [],
  );

  useEffect(() => {
    if (page !== "wiki") {
      return () => {
        /* no wiki polling */
      };
    }
    void refreshWiki();
    const id = setInterval(() => {
      void refreshWiki();
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [page, refreshWiki]);

  return { wiki, refreshWiki, loadWikiPage };
}
