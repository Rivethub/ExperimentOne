import { Effect } from "effect";
import { useCallback, useState } from "react";
import type { WikiInfo } from "../components/WikiBoard";
import { Rivet, rivetErrorMessage, runApp } from "../effect";
import { pickRivetbag } from "../tauriUtils";
import type { Page, Status, TrafficEvent } from "../types";

export function useAppOperations(opts: {
  ensureSession: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshWiki: () => Promise<void>;
  setTrafficRows: (rows: TrafficEvent[]) => void;
  setBusy: (v: boolean) => void;
  setStatusAction: (v: string | null) => void;
  setError: (v: string | null | ((prev: string | null) => string | null)) => void;
  setPage: (page: Page) => void;
  status: Status | null;
  wiki: WikiInfo | null;
  importPath: string;
  setImportPath: (v: string) => void;
}) {
  const {
    refresh,
    refreshWiki,
    setTrafficRows,
    setBusy,
    setStatusAction,
    setError,
    setPage,
    status,
    wiki,
    importPath,
    setImportPath,
  } = opts;

  const [proxyLog, setProxyLog] = useState("");
  const [chLog, setChLog] = useState("");
  const [bagNote, setBagNote] = useState<string | null>(null);
  const [bagPath, setBagPath] = useState<string | null>(null);
  const [embedModel, setEmbedModel] = useState("");
  const [wikiModel, setWikiModel] = useState("");

  const loadLogs = useCallback(async () => {
    try {
      const soft = <A>(effect: Effect.Effect<A, unknown>) =>
        effect.pipe(Effect.orElseSucceed(() => null as A | null));

      const [proxyRes, chRes] = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Effect.all(
            [soft(Rivet.getProxyLog(80)), soft(Rivet.getClickhouseLog(80))],
            {
              concurrency: "unbounded",
            },
          );
        }),
      );
      if (proxyRes?.ok) {
        setProxyLog(proxyRes.json<{ text?: string }>()?.text ?? "");
      }
      if (chRes?.ok) {
        setChLog(chRes.json<{ text?: string }>()?.text ?? "");
      }
    } catch {
      /* rivetd down */
    }
  }, []);

  const proxyAction = useCallback(
    async (path: "start" | "stop" | "restart") => {
      setBusy(true);
      setStatusAction(
        path === "restart"
          ? "Restarting proxy…"
          : path === "start"
            ? "Starting proxy…"
            : "Stopping proxy…",
      );
      try {
        await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            if (path === "restart") {
              if (status?.proxy_running) {
                yield* Rivet.proxyAction("stop");
              }
              yield* Rivet.proxyAction("start");
            } else {
              yield* Rivet.proxyAction(path);
            }
          }),
        );
        await refresh();
      } catch (err) {
        setError(rivetErrorMessage(err));
      } finally {
        setBusy(false);
        setStatusAction(null);
      }
    },
    [refresh, status?.proxy_running, setBusy, setStatusAction, setError],
  );

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        setError("Could not copy to clipboard");
      }
    },
    [setError],
  );

  const pickImport = useCallback(async () => {
    const path = await pickRivetbag();
    if (path) {
      setImportPath(path);
      setPage("export");
    } else if (!importPath) {
      setError("File picker unavailable — paste an absolute .rivetbag path");
    }
  }, [importPath, setImportPath, setPage, setError]);

  const exportBag = useCallback(async () => {
    setBusy(true);
    try {
      const body = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.exportBag;
        }),
      );
      if (body.error) throw new Error(body.error);
      setBagPath(body.path);
      setBagNote(
        `Exported ${body.event_count} events → ${body.path}${body.note ? ` — ${body.note}` : ""}`,
      );
      await refresh();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, setBusy, setError]);

  const importBag = useCallback(async () => {
    if (!importPath.trim()) {
      setError("Paste an absolute path to a .rivetbag file");
      return;
    }
    setBusy(true);
    try {
      const body = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.importBag(importPath.trim());
        }),
      );
      if (body.error) throw new Error(body.error);
      setBagNote(`Imported ${body.event_count} events from ${body.path}`);
      await refresh();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [importPath, refresh, setBusy, setError]);

  const searchTraffic = useCallback(
    async (trafficQuery: string) => {
      setBusy(true);
      try {
        const rows = await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            return yield* Rivet.searchTraffic(trafficQuery);
          }),
        );
        setTrafficRows(rows);
      } catch (err) {
        setError(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [setTrafficRows, setBusy, setError],
  );

  const openWiki = useCallback(async () => {
    const path = wiki?.path ?? status?.wiki_dir ?? null;
    if (!path) {
      setError("Wiki path unknown — is rivetd up?");
      return;
    }
    const ok = await runApp(Rivet.openWikiDir(path));
    if (ok === null) {
      setBagNote(`Wiki directory: ${path}`);
      await navigator.clipboard.writeText(path).catch(() => undefined);
    }
  }, [wiki, status, setError]);

  const revealExport = useCallback(async () => {
    const path = bagPath;
    if (!path) {
      setError("Export a package first");
      return;
    }
    const ok = await runApp(Rivet.revealPath(path));
    if (ok === null) {
      await copyText(path);
      setBagNote(`Copied path: ${path}`);
    }
  }, [bagPath, copyText, setError]);

  const saveIntelligence = useCallback(async () => {
    setBusy(true);
    try {
      await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          yield* Rivet.putConfig({
            embedding_model: embedModel,
            wiki_model: wikiModel,
            capabilities: {
              vector_search: !!embedModel.trim() || status?.capabilities.vector_search,
              wiki: !!wikiModel.trim() || status?.capabilities.wiki,
            },
          });
        }),
      );
      await refresh();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [embedModel, wikiModel, status, refresh, setBusy, setError]);

  const toggleCapability = useCallback(
    async (key: "vector_search" | "wiki", value: boolean) => {
      setBusy(true);
      try {
        await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            yield* Rivet.putConfig({ capabilities: { [key]: value } });
          }),
        );
        await refresh();
        if (key === "wiki") await refreshWiki();
      } catch (err) {
        setError(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh, refreshWiki, setBusy, setError],
  );

  const runWorkers = useCallback(async () => {
    setBusy(true);
    setStatusAction("Updating wiki & vectors…");
    try {
      const body = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.tickWorkers;
        }),
      );
      setBagNote(
        `Workers ran — ${body.embeddings ?? 0} embeddings, ${body.wiki_pages ?? 0} wiki pages`,
      );
      await refresh();
      await refreshWiki();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }, [refresh, refreshWiki, setBusy, setStatusAction, setError]);

  const hydrateModels = useCallback((embed: string, wikiModelName: string) => {
    setEmbedModel(embed);
    setWikiModel(wikiModelName);
  }, []);

  return {
    proxyLog,
    chLog,
    bagNote,
    bagPath,
    embedModel,
    wikiModel,
    setWikiModel,
    loadLogs,
    proxyAction,
    copyText,
    pickImport,
    exportBag,
    importBag,
    searchTraffic,
    openWiki,
    revealExport,
    saveIntelligence,
    toggleCapability,
    runWorkers,
    hydrateModels,
  };
}
