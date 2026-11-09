import { useQuery, useQueryClient } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { createEffect } from "solid-js";
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
  horizon: Accessor<"1h" | "3h" | "6h">;
  setBusy: (v: boolean) => void;
  onModelsHydrated: (opts: {
    embedModel: string;
    wikiModel: string;
    embedAccountId?: string;
    wikiAccountId?: string;
  }) => void;
}): UseRivetDataResult {
  const queryClient = useQueryClient();
  const mutations = useRivetMutations({ horizon: opts.horizon });
  const modelsHydrated = { current: false };
  const lastHomeError = { current: null as string | null };
  const warned = { current: new Set<string>() };

  // Invalidate home/wiki when rivetd publishes live cursor changes.
  useLiveEvents(true);

  const homeQuery = useQuery(() => ({
    queryKey: queryKeys.home,
    queryFn: loadHomeSnapshot,
    // Live events drive most refreshes; keep a slow safety poll.
    refetchInterval: HOME_REFETCH_MS,
  }));

  const quotaQuery = useQuery(() => ({
    queryKey: queryKeys.quota(opts.horizon()),
    queryFn: () => pullQuotaBundle(opts.horizon()),
    staleTime: QUOTA_TTL_MS,
    refetchInterval: QUOTA_TTL_MS,
  }));

  createEffect(() => {
    const error = homeQuery.error;
    if (error != null) {
      const message = refreshErrorMessage(error);
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
  });

  createEffect(() => {
    const warnings = homeQuery.data?.status?.warnings ?? [];
    for (const warning of warnings) {
      if (warned.current.has(warning)) {
        continue;
      }
      warned.current.add(warning);
      notify.warning(warning);
    }
  });

  createEffect(() => {
    const st = homeQuery.data?.status;
    if (st == null || modelsHydrated.current) {
      return;
    }
    opts.onModelsHydrated({
      embedModel: st.embedding_model ?? "",
      wikiModel: st.wiki_model ?? "",
      embedAccountId: st.embedding_account_id ?? "",
      wikiAccountId: st.wiki_account_id ?? "",
    });
    modelsHydrated.current = true;
  });

  const ensureSession = async () => {
    await runApp(Rivet.requireBackend);
  };

  const fetchQuota = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.quota(opts.horizon()) });
  };

  const refresh = async (includeQuota?: boolean) => {
    const tasks = [queryClient.invalidateQueries({ queryKey: queryKeys.home })];
    if (includeQuota === true) {
      tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.quota(opts.horizon()) }));
    }
    await Promise.all(tasks);
  };

  const refreshCredentials = async () => {
    const toastId = "refresh-credentials";
    opts.setBusy(true);
    notify.loading("Updating credentials…", toastId);
    try {
      await mutations.refreshQuota.mutateAsync();
      notify.dismiss(toastId);
      notify.success("Credentials refreshed");
    } catch (err) {
      notify.dismiss(toastId);
      notify.error(rivetErrorMessage(err));
    } finally {
      opts.setBusy(false);
    }
  };

  return {
    get status() {
      return homeQuery.data?.status ?? null;
    },
    get accounts() {
      return homeQuery.data?.accounts ?? [];
    },
    get quota() {
      return quotaQuery.data?.quota ?? null;
    },
    get quotaHistory() {
      return quotaQuery.data?.history ?? null;
    },
    get catalog() {
      const providerList = homeQuery.data?.providers?.providers;
      return providerList !== undefined && providerList.length > 0
        ? providerList
        : FALLBACK_PROVIDERS;
    },
    get recent() {
      return homeQuery.data?.recent ?? [];
    },
    get apiOnline() {
      return homeQuery.isSuccess;
    },
    get lastSyncedAt() {
      return homeQuery.isSuccess ? homeQuery.dataUpdatedAt || null : null;
    },
    ensureSession,
    fetchQuota,
    refresh,
    refreshCredentials,
  };
}
