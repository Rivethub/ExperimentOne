import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import type { WikiInfo, WikiPageCard } from "../components/WikiBoard";
import { Rivet, runApp } from "../effect";

export function useWiki(opts: { page: string; ensureSession: () => Promise<void> }) {
  const { page } = opts;
  const [wiki, setWiki] = useState<WikiInfo | null>(null);

  const refreshWiki = useCallback(async () => {
    try {
      const next = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.getWiki;
        }),
      );
      setWiki((prev) => {
        if (
          prev &&
          prev.revision === next.revision &&
          prev.pages.length === next.pages.length &&
          prev.pages.every(
            (p, i) => p.id === next.pages[i]?.id && p.updated_at === next.pages[i]?.updated_at,
          )
        ) {
          return prev;
        }
        return next;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const loadWikiPage = useCallback(async (wikiPage: WikiPageCard) => {
    return runApp(Rivet.loadWikiPageContent(wikiPage));
  }, []);

  useEffect(() => {
    if (page !== "wiki") return;
    void refreshWiki();
    const id = setInterval(() => {
      void refreshWiki();
    }, 1000);
    return () => clearInterval(id);
  }, [page, refreshWiki]);

  return { wiki, refreshWiki, loadWikiPage };
}
