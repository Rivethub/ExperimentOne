import { Effect } from "effect";
import { useCallback, useRef, useState } from "react";
import type { WikiInfo } from "../components/WikiBoard";
import { rivetErrorMessage, runApp, softEffect } from "../effect";
import * as Rivet from "../effect/rivet";
import { pickRivetbag } from "../lib/tauri-utils";
import type { ConversationSummary, SearchMode, Status, TrafficEvent } from "../lib/types";

export function useAppOperations(opts: {
  ensureSession: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshWiki: () => Promise<void>;
  setTrafficRows: (rows: TrafficEvent[]) => void;
  setConversations: (rows: ConversationSummary[]) => void;
  setSearchModeLabel: (label: string | null) => void;
  setBusy: (v: boolean) => void;
  setStatusAction: (v: string | null) => void;
  setError: (v: string | null | ((prev: string | null) => string | null)) => void;
  status: Status | null;
  wiki: WikiInfo | null;
  onDataMutated?: () => void;
}) {
  const {
    refresh,
    refreshWiki,
    setTrafficRows,
    setConversations,
    setSearchModeLabel,
    setBusy,
    setStatusAction,
    setError,
    status,
    wiki,
    onDataMutated,
  } = opts;

  const [proxyLog, setProxyLog] = useState("");
  const [chLog, setChLog] = useState("");
  const [bagNote, setBagNote] = useState<string | null>(null);
  const [bagPath, setBagPath] = useState<string | null>(null);
  const [embedModel, setEmbedModel] = useState("");
  const [listSearching, setListSearching] = useState(false);
  const searchGen = useRef(0);
  const [wikiModel, setWikiModel] = useState("");

  const loadLogs = useCallback(async () => {
    try {
      const [proxyRes, chRes] = await runApp(
        Effect.gen(function* loadProxyAndClickhouseLogs() {
          yield* Rivet.requireBackend;
          return yield* Effect.all(
            [softEffect(Rivet.getProxyLog(80)), softEffect(Rivet.getClickhouseLog(80))],
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
      onDataMutated?.();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, onDataMutated, setBusy, setError]);

  const importBag = useCallback(async () => {
    const path = await pickRivetbag();
    if (!path) {
      setError("File picker unavailable — choose a .rivetbag to import");
      return;
    }
    setBusy(true);
    try {
      const body = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.importBag(path);
        }),
      );
      if (body.error) throw new Error(body.error);
      setBagNote(`Imported ${body.event_count} events from ${body.path}`);
      await refresh();
      onDataMutated?.();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, onDataMutated, setBusy, setError]);

  const ingestLocal = useCallback(async () => {
    setBusy(true);
    setStatusAction("Importing local sessions…");
    try {
      const body = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.ingestLocal({});
        }),
      );
      if (body.error) throw new Error(body.error);
      setBagNote(
        `Imported local sessions — ${body.events_inserted} new, ${body.events_skipped_existing} already present (${body.events_parsed} parsed from ${body.files_scanned} files)`,
      );
      await refresh();
      onDataMutated?.();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }, [refresh, onDataMutated, setBusy, setStatusAction, setError]);

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

  const loadConversations = useCallback(async () => {
    const gen = ++searchGen.current;
    setListSearching(true);
    try {
      const rows = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.listConversations(100);
        }),
      );
      if (gen !== searchGen.current) return;
      setConversations(rows);
      setSearchModeLabel(null);
    } catch (err) {
      if (gen !== searchGen.current) return;
      setError(rivetErrorMessage(err));
    } finally {
      if (gen === searchGen.current) setListSearching(false);
    }
  }, [setConversations, setSearchModeLabel, setError]);

  const searchConversations = useCallback(
    async (query: string, mode: SearchMode) => {
      const gen = ++searchGen.current;
      setListSearching(true);
      try {
        if (!query.trim()) {
          const rows = await runApp(
            Effect.gen(function* () {
              yield* Rivet.requireBackend;
              return yield* Rivet.listConversations(100);
            }),
          );
          if (gen !== searchGen.current) return;
          setConversations(rows);
          setSearchModeLabel(null);
          return;
        }
        const body = await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            return yield* Rivet.searchConversations(query, mode);
          }),
        );
        if (gen !== searchGen.current) return;
        // Keep prior rows visible until this response lands (leading UI).
        setConversations(body.results);
        setSearchModeLabel(
          body.mode === "vector"
            ? "vector"
            : body.mode === "keyword_fallback"
              ? "keyword fallback"
              : body.mode === "keyword"
                ? "keyword"
                : null,
        );
      } catch (err) {
        if (gen !== searchGen.current) return;
        setError(rivetErrorMessage(err));
      } finally {
        if (gen === searchGen.current) setListSearching(false);
      }
    },
    [setConversations, setSearchModeLabel, setError],
  );

  const loadConversationEvents = useCallback(
    async (id: string): Promise<TrafficEvent[]> => {
      setBusy(true);
      try {
        return await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            return yield* Rivet.getConversationEvents(id);
          }),
        );
      } catch (err) {
        setError(rivetErrorMessage(err));
        return [];
      } finally {
        setBusy(false);
      }
    },
    [setBusy, setError],
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
              vector_search: Boolean(embedModel.trim() || status?.capabilities.vector_search),
              wiki: Boolean(wikiModel.trim() || status?.capabilities.wiki),
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

  const clearBagNote = useCallback(() => setBagNote(null), []);

  return {
    proxyLog,
    chLog,
    bagNote,
    clearBagNote,
    bagPath,
    embedModel,
    wikiModel,
    setWikiModel,
    listSearching,
    loadLogs,
    proxyAction,
    copyText,
    exportBag,
    importBag,
    ingestLocal,
    searchTraffic,
    loadConversations,
    searchConversations,
    loadConversationEvents,
    openWiki,
    revealExport,
    saveIntelligence,
    toggleCapability,
    runWorkers,
    hydrateModels,
  };
}
