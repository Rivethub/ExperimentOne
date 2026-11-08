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
  try {
    const [proxyRes, chRes] = await runApp(
      Effect.gen(function* loadProxyAndClickhouseLogs() {
        yield* Rivet.requireBackend;
        return yield* Effect.all(
          [softEffect(Rivet.getProxyLog(80)), softEffect(Rivet.getClickhouseLog(80))],
          { concurrency: "unbounded" },
        );
      }),
    );
    return {
      proxyLog: proxyRes?.ok ? (proxyRes.json<{ text?: string }>()?.text ?? "") : "",
      chLog: chRes?.ok ? (chRes.json<{ text?: string }>()?.text ?? "") : "",
    };
  } catch {
    return { proxyLog: "", chLog: "" };
  }
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
  const [embedModel, setEmbedModel] = useState("");
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

  const exportBag = useCallback(async () => {
    setBusy(true);
    try {
      const body = await mutations.exportBag.mutateAsync();
      if (body.error) throw new Error(body.error);
      setBagPath(body.path);
      notify.success(
        `Exported ${body.event_count} events → ${body.path}${body.note ? ` — ${body.note}` : ""}`,
      );
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [mutations.exportBag, queryClient, setBusy]);

  const importBag = useCallback(async () => {
    const path = await pickRivetbag();
    if (!path) {
      notify.error("File picker unavailable — choose a .rivetbag to import");
      return;
    }
    setBusy(true);
    try {
      const body = await mutations.importBag.mutateAsync(path);
      if (body.error) throw new Error(body.error);
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
      if (body.error) throw new Error(body.error);
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
    setBusy(true);
    try {
      await mutations.putConfig.mutateAsync({
        embedding_model: embedModel,
        wiki_model: wikiModel,
        capabilities: {
          vector_search: Boolean(embedModel.trim() || status?.capabilities.vector_search),
          wiki: Boolean(wikiModel.trim() || status?.capabilities.wiki),
        },
      });
      notify.success("Intelligence settings saved");
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [embedModel, wikiModel, status, mutations.putConfig, setBusy]);

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

  const hydrateModels = useCallback((embed: string, wikiModelName: string) => {
    setEmbedModel(embed);
    setWikiModel(wikiModelName);
  }, []);

  return {
    proxyLog: logsQuery.data?.proxyLog ?? "",
    chLog: logsQuery.data?.chLog ?? "",
    bagPath,
    embedModel,
    wikiModel,
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
