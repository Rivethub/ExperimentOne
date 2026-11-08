import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { refreshWikiAtom } from "../atoms/wiki";
import { runApp } from "../effect";
import * as Rivet from "../effect/rivet";
import type { JsonObject } from "../lib/json-types";
import { queryKeys } from "../lib/query-keys";
import type { QuotaHistory, QuotaSnapshot } from "../lib/types";

type QuotaBundle = {
  quota: QuotaSnapshot | null;
  history: QuotaHistory | null;
};

function withBackend<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return runApp(
    Effect.gen(function* runWithBackend() {
      yield* Rivet.requireBackend;
      return yield* effect;
    }),
  );
}

export function useRivetMutations(opts: { horizon: "1h" | "3h" | "6h" }) {
  const { horizon } = opts;
  const queryClient = useQueryClient();

  const invalidateHome = () => queryClient.invalidateQueries({ queryKey: queryKeys.home });
  const invalidateQuota = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.quota(horizon) });
  const invalidateWiki = () => {
    refreshWikiAtom();
  };
  const invalidateConversations = () =>
    queryClient.invalidateQueries({ queryKey: ["conversations"] });

  const proxyAction = useMutation({
    mutationFn: async (path: "start" | "stop" | "restart") => {
      const result = await withBackend(Rivet.proxyAction(path));
      await invalidateHome();
      return result;
    },
  });

  const refreshQuota = useMutation({
    mutationFn: async () => {
      const body = await withBackend(Rivet.refreshQuota);
      if (body.quota !== undefined) {
        queryClient.setQueryData(
          queryKeys.quota(horizon),
          (prev: QuotaBundle | undefined): QuotaBundle => ({
            quota: body.quota ?? null,
            history: prev?.history ?? null,
          }),
        );
      } else {
        await invalidateQuota();
      }
      await invalidateHome();
      return body;
    },
  });

  const exportBag = useMutation({
    mutationFn: async () => {
      const result = await withBackend(Rivet.exportBag);
      await Promise.all([invalidateHome(), invalidateConversations()]);
      return result;
    },
  });

  const importBag = useMutation({
    mutationFn: async (path: string) => {
      const result = await withBackend(Rivet.importBag(path));
      await Promise.all([invalidateHome(), invalidateConversations()]);
      return result;
    },
  });

  const putConfig = useMutation({
    mutationFn: async (body: JsonObject) => {
      const result = await withBackend(Rivet.putConfig(body));
      await invalidateHome();
      return result;
    },
  });

  const tickWorkers = useMutation({
    mutationFn: async () => {
      const result = await withBackend(Rivet.tickWorkers);
      await Promise.all([invalidateHome(), invalidateWiki()]);
      return result;
    },
  });

  const removeAccount = useMutation({
    mutationFn: async (id: string) => {
      const result = await withBackend(Rivet.removeAccount(id));
      await invalidateHome();
      return result;
    },
  });

  const startLogin = useMutation({
    mutationFn: async (opts: { provider: string; method?: "browser" | "device" }) => {
      const result = await withBackend(Rivet.startLogin(opts.provider, opts.method));
      await queryClient.invalidateQueries({ queryKey: queryKeys.loginStatus });
      return result;
    },
  });

  const cancelLogin = useMutation({
    mutationFn: async () => {
      const result = await withBackend(Rivet.cancelLogin);
      await queryClient.invalidateQueries({ queryKey: queryKeys.loginStatus });
      return result;
    },
  });

  const importVertex = useMutation({
    mutationFn: async (path: string) => {
      const result = await withBackend(Rivet.importVertex(path));
      await queryClient.invalidateQueries({ queryKey: queryKeys.loginStatus });
      return result;
    },
  });

  const writeHarness = useMutation({
    mutationFn: async (opts: { target: "claude" | "codex"; mode: "user" | "isolated" }) =>
      withBackend(Rivet.writeHarness(opts.target, opts.mode)),
  });

  return {
    proxyAction,
    refreshQuota,
    exportBag,
    importBag,
    putConfig,
    tickWorkers,
    removeAccount,
    startLogin,
    cancelLogin,
    importVertex,
    writeHarness,
  };
}
