import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { FALLBACK_PROVIDERS } from "../lib/constants";
import { isTransientReachabilityMessage, rivetErrorMessage, runApp } from "../effect";
import * as Rivet from "../effect/rivet";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/query-keys";
import type { CatalogProvider } from "../lib/provider-utils";
import type { Account, QuotaHistory, QuotaSnapshot, Status, CaptureEvent } from "../lib/types";
import { useLiveEvents } from "./use-live-events";
import {
  HOME_REFETCH_MS,
  QUOTA_TTL_MS,
  loadHomeSnapshot,
  pullQuotaBundle,
  refreshErrorMessage,
} from "./use-rivet-data.lib";
import { useRivetMutations } from "./use-rivet-mutations";

export type UseRivetDataResult = {
  status: Status | null;
  accounts: Account[];
  quota: QuotaSnapshot | null;
  quotaHistory: QuotaHistory | null;
  catalog: CatalogProvider[];
  recent: CaptureEvent[];
  apiOnline: boolean;
  lastSyncedAt: number | null;
  ensureSession: () => Promise<void>;
  fetchQuota: () => Promise<void>;
  refresh: (includeQuota?: boolean) => Promise<void>;
  refreshCredentials: () => Promise<void>;
};

export function useRivetData(opts: {
  horizon: "1h" | "3h" | "6h";
  setBusy: (v: boolean) => void;
  onModelsHydrated: (embed: string, wiki: string) => void;
}): UseRivetDataResult {
  const { horizon, setBusy, onModelsHydrated } = opts;
  const queryClient = useQueryClient();
  const mutations = useRivetMutations({ horizon });
  const modelsHydrated = useRef(false);
  const lastHomeError = useRef<string | null>(null);
  const warned = useRef(new Set<string>());

  // Invalidate home/wiki when rivetd publishes live cursor changes.
  useLiveEvents(true);

  const homeQuery = useQuery({
    queryKey: queryKeys.home,
    queryFn: loadHomeSnapshot,
    // Live events drive most refreshes; keep a slow safety poll.
    refetchInterval: HOME_REFETCH_MS,
  });

  const quotaQuery = useQuery({
    queryKey: queryKeys.quota(horizon),
    queryFn: () => pullQuotaBundle(horizon),
    staleTime: QUOTA_TTL_MS,
    refetchInterval: QUOTA_TTL_MS,
  });

  useEffect(() => {
    if (homeQuery.error != null) {
      const message = refreshErrorMessage(homeQuery.error);
      if (lastHomeError.current !== message) {
        lastHomeError.current = message;
        notify.error(message);
      }
      return;
    }
    if (homeQuery.isSuccess && lastHomeError.current !== null) {
      if (isTransientReachabilityMessage(lastHomeError.current)) {
        lastHomeError.current = null;
      }
    }
  }, [homeQuery.error, homeQuery.isSuccess]);

  useEffect(() => {
    const warnings = homeQuery.data?.status?.warnings ?? [];
    for (const warning of warnings) {
      if (warned.current.has(warning)) continue;
      warned.current.add(warning);
      notify.warning(warning);
    }
  }, [homeQuery.data?.status?.warnings]);

  useEffect(() => {
    const st = homeQuery.data?.status;
    if (st == null || modelsHydrated.current) {
      return;
    }
    onModelsHydrated(st.embedding_model ?? "", st.wiki_model ?? "");
    modelsHydrated.current = true;
  }, [homeQuery.data?.status, onModelsHydrated]);

  const ensureSession = useCallback(async () => {
    await runApp(Rivet.requireBackend);
  }, []);

  const fetchQuota = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.quota(horizon) });
  }, [queryClient, horizon]);

  const refresh = useCallback(
    async (includeQuota?: boolean) => {
      const tasks = [queryClient.invalidateQueries({ queryKey: queryKeys.home })];
      if (includeQuota === true) {
        tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.quota(horizon) }));
      }
      await Promise.all(tasks);
    },
    [queryClient, horizon],
  );

  const refreshCredentials = useCallback(async () => {
    const toastId = "refresh-credentials";
    setBusy(true);
    notify.loading("Updating credentials…", toastId);
    try {
      const body = await mutations.refreshQuota.mutateAsync();
      if (body.error !== undefined && body.error !== "" && body.ok === false) {
        throw new Error(body.error);
      }
      notify.dismiss(toastId);
      notify.success("Credentials refreshed");
    } catch (err) {
      notify.dismiss(toastId);
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [mutations.refreshQuota, setBusy]);

  const snapshot = homeQuery.data;
  const accounts = snapshot?.accounts ?? [];
  const recent = snapshot?.recent ?? [];
  const providerList = snapshot?.providers?.providers;
  const catalog =
    providerList !== undefined && providerList.length > 0 ? providerList : FALLBACK_PROVIDERS;

  return {
    status: snapshot?.status ?? null,
    accounts,
    quota: quotaQuery.data?.quota ?? null,
    quotaHistory: quotaQuery.data?.history ?? null,
    catalog,
    recent,
    apiOnline: homeQuery.isSuccess,
    lastSyncedAt: homeQuery.isSuccess ? homeQuery.dataUpdatedAt || null : null,
    ensureSession,
    fetchQuota,
    refresh,
    refreshCredentials,
  };
}
