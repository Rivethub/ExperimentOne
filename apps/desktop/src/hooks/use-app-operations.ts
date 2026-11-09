import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useCallback, useState } from "react";
import { refreshWikiAtom } from "../atoms/wiki";
import { rivetErrorMessage, runApp, softEffect } from "../effect";
import * as Rivet from "../effect/rivet";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/query-keys";
import { pickRivetbag } from "../lib/tauri-utils";
import type { Status } from "../lib/types";
import { useRivetMutations } from "./use-rivet-mutations";

export type RuntimeLogs = {
  proxyLog: string;
  chLog: string;
};

async function fetchRuntimeLogs(): Promise<RuntimeLogs> {
  const [proxyRes, chRes] = await runApp(
    Effect.gen(function* loadProxyAndClickhouseLogs() {
      yield* Rivet.requireBackend;
      return yield* Effect.all(
        [softEffect(Rivet.getProxyLog(80)), softEffect(Rivet.getClickhouseLog(80))],
        { concurrency: "unbounded" },
      );
    }),
  ).catch(() => [null, null] as const);
  return {
    proxyLog: proxyRes?.text ?? "",
    chLog: chRes?.text ?? "",
  };
}

/** Poll login/SIWC bind until the prox child exits (or timeout). */
async function waitForLoginSuccess(timeoutMs = 5 * 60 * 1000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await runApp(
        Effect.gen(function* pollLogin() {
          yield* Rivet.requireBackend;
          return yield* Rivet.getLoginStatus;
        }),
      );
      if (status.done) {
        return status.success;
      }
    } catch {
      /* rivetd briefly unavailable */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

export function useAppOperations(opts: {
  horizon: "1h" | "3h" | "6h";
  setBusy: (v: boolean) => void;
  status: Status | null;
  runtimeLogsEnabled: boolean;
}) {
  const { horizon, setBusy, status, runtimeLogsEnabled } = opts;

  const queryClient = useQueryClient();
  const mutations = useRivetMutations({ horizon });
  const [bagPath, setBagPath] = useState<string | null>(null);
  const [embedAccountId, setEmbedAccountId] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [wikiAccountId, setWikiAccountId] = useState("");
  const [wikiModel, setWikiModel] = useState("");

  const logsQuery = useQuery({
    queryKey: queryKeys.runtimeLogs,
    queryFn: fetchRuntimeLogs,
    enabled: runtimeLogsEnabled,
    refetchInterval: runtimeLogsEnabled ? 10_000 : false,
  });

  const loadLogs = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeLogs });
  }, [queryClient]);

  const proxyAction = useCallback(
    async (path: "start" | "stop" | "restart") => {
      const toastId = "proxy-action";
      setBusy(true);
      notify.loading(
        path === "restart"
          ? "Restarting proxy…"
          : path === "start"
            ? "Starting proxy…"
            : "Stopping proxy…",
        toastId,
      );
      try {
        if (path === "restart") {
          if (status?.proxy_running) {
            await mutations.proxyAction.mutateAsync("stop");
          }
          await mutations.proxyAction.mutateAsync("start");
        } else {
          await mutations.proxyAction.mutateAsync(path);
        }
        notify.dismiss(toastId);
        notify.success(
          path === "restart"
            ? "Proxy restarted"
            : path === "start"
              ? "Proxy started"
              : "Proxy stopped",
        );
      } catch (err) {
        notify.dismiss(toastId);
        notify.error(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [mutations.proxyAction, status?.proxy_running, setBusy],
  );

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify.success("Copied to clipboard");
    } catch {
      notify.error("Could not copy to clipboard");
    }
  }, []);

  const exportBag = useCallback(
    async (conversationIds?: string[]) => {
      setBusy(true);
      try {
        const body = await mutations.exportBag.mutateAsync(conversationIds);
        setBagPath(body.path);
        const scope =
          conversationIds && conversationIds.length > 0
            ? conversationIds.length === 1
              ? "1 conversation"
              : `${conversationIds.length} conversations`
            : null;
        notify.success(
          `Exported ${body.event_count} events${scope ? ` (${scope})` : ""} → ${body.path}${body.note ? ` — ${body.note}` : ""}`,
        );
        await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } catch (err) {
        notify.error(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [mutations.exportBag, queryClient, setBusy],
  );

  const importBag = useCallback(async () => {
    const path = await pickRivetbag();
    if (!path) {
      notify.error("File picker unavailable — choose a .rivetbag to import");
      return;
    }
    setBusy(true);
    try {
      const body = await mutations.importBag.mutateAsync(path);
      notify.success(`Imported ${body.event_count} events from ${body.path}`);
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [mutations.importBag, queryClient, setBusy]);

  const ingestLocal = useCallback(async () => {
    const toastId = "ingest-local";
    setBusy(true);
    notify.loading("Importing local sessions…", toastId);
    try {
      const body = await runApp(
        Effect.gen(function* importLocalSessions() {
          yield* Rivet.requireBackend;
          return yield* Rivet.ingestLocal({});
        }),
      );
      notify.dismiss(toastId);
      notify.success(
        `Imported local sessions — ${body.events_inserted} new, ${body.events_skipped_existing} already present (${body.events_parsed} parsed from ${body.files_scanned} files)`,
      );
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      notify.dismiss(toastId);
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [queryClient, setBusy]);

  const openWiki = useCallback(async () => {
    const path = status?.wiki_dir ?? null;
    if (!path) {
      notify.error("Wiki path unknown — is rivetd up?");
      return;
    }
    const ok = await runApp(Rivet.openWikiDir(path));
    if (ok === null) {
      await navigator.clipboard.writeText(path).catch(() => undefined);
      notify.info(`Wiki directory: ${path}`);
    }
  }, [status]);

  const revealExport = useCallback(async () => {
    const path = bagPath;
    if (!path) {
      notify.error("Export a package first");
      return;
    }
    const ok = await runApp(Rivet.revealPath(path));
    if (ok === null) {
      await navigator.clipboard.writeText(path).catch(() => undefined);
      notify.info(`Copied path: ${path}`);
    }
  }, [bagPath]);

  const saveIntelligence = useCallback(async () => {
    const toastId = "save-workers";
    setBusy(true);
    const useCodexEmbed = embedAccountId.trim().length > 0;
    const model = useCodexEmbed ? embedModel.trim() || "text-embedding-3-small" : embedModel.trim();
    if (useCodexEmbed && model !== embedModel) {
      setEmbedModel(model);
    }
    notify.loading(
      useCodexEmbed ? "Saving workers & enabling Codex embeddings…" : "Saving workers…",
      toastId,
    );
    try {
      await mutations.putConfig.mutateAsync({
        embedding_model: useCodexEmbed ? model : "",
        embedding_account_id: embedAccountId.trim(),
        ...(useCodexEmbed ? {} : { embedding_space: "lexical" }),
        wiki_model: wikiModel,
        wiki_account_id: wikiAccountId.trim(),
        capabilities: {
          vector_search: useCodexEmbed ? true : Boolean(status?.capabilities.vector_search),
          wiki: Boolean(wikiModel.trim() || wikiAccountId.trim() || status?.capabilities.wiki),
        },
      });

      if (!useCodexEmbed) {
        notify.dismiss(toastId);
        notify.success("Workers saved — embeddings stay lexical");
        return;
      }

      let body = await mutations.reembedWorkers.mutateAsync();
      if (body.needs_siwc === true) {
        notify.loading("Opening Sign in with ChatGPT for Platform embeddings…", toastId);
        await mutations.startSiwcBind.mutateAsync(body.account_id ?? embedAccountId);
        const ok = await waitForLoginSuccess();
        if (!ok) {
          notify.dismiss(toastId);
          notify.error("SIWC bind did not finish — save workers again after signing in");
          return;
        }
        notify.loading("SIWC ready — enabling remote embeddings…", toastId);
        body = await mutations.reembedWorkers.mutateAsync();
        if (body.needs_siwc === true) {
          notify.dismiss(toastId);
          notify.error(
            body.note ?? "Platform access still missing — confirm SIWC completed, then save again",
          );
          return;
        }
      }
      notify.dismiss(toastId);
      notify.success(
        body.note ??
          `Workers saved — remote embeddings queued for ${body.embedding_space ?? "remote space"}`,
      );
    } catch (err) {
      notify.dismiss(toastId);
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [
    embedAccountId,
    embedModel,
    wikiAccountId,
    wikiModel,
    status,
    mutations.putConfig,
    mutations.reembedWorkers,
    mutations.startSiwcBind,
    setBusy,
  ]);

  const toggleCapability = useCallback(
    async (key: "vector_search" | "wiki", value: boolean) => {
      setBusy(true);
      try {
        await mutations.putConfig.mutateAsync({ capabilities: { [key]: value } });
        if (key === "wiki") {
          try {
            refreshWikiAtom();
          } catch {
            /* soft-fail */
          }
        }
      } catch (err) {
        notify.error(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [mutations.putConfig, setBusy],
  );

  const runWorkers = useCallback(async () => {
    const toastId = "run-workers";
    setBusy(true);
    notify.loading("Updating wiki & vectors…", toastId);
    try {
      const body = await mutations.tickWorkers.mutateAsync();
      notify.dismiss(toastId);
      notify.success(
        `Workers ran — ${body.embeddings ?? 0} embeddings, ${body.wiki_pages ?? 0} wiki pages`,
      );
    } catch (err) {
      notify.dismiss(toastId);
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [mutations.tickWorkers, setBusy]);

  const hydrateModels = useCallback(
    (opts: {
      embedModel: string;
      wikiModel: string;
      embedAccountId?: string;
      wikiAccountId?: string;
    }) => {
      setEmbedModel(opts.embedModel);
      setWikiModel(opts.wikiModel);
      setEmbedAccountId(opts.embedAccountId ?? "");
      setWikiAccountId(opts.wikiAccountId ?? "");
    },
    [],
  );

  return {
    proxyLog: logsQuery.data?.proxyLog ?? "",
    chLog: logsQuery.data?.chLog ?? "",
    bagPath,
    embedAccountId,
    embedModel,
    wikiAccountId,
    wikiModel,
    setEmbedAccountId,
    setEmbedModel,
    setWikiAccountId,
    setWikiModel,
    loadLogs,
    proxyAction,
    copyText,
    exportBag,
    importBag,
    ingestLocal,
    openWiki,
    revealExport,
    saveIntelligence,
    toggleCapability,
    runWorkers,
    hydrateModels,
  };
}
