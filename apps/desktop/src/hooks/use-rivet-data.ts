import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { FALLBACK_PROVIDERS } from "../lib/constants";
import { rivetErrorMessage, runApp } from "../effect";
import * as Rivet from "../effect/rivet";
import type { CatalogProvider } from "../lib/provider-utils";
import type { Account, QuotaHistory, QuotaSnapshot, Status, TrafficEvent } from "../lib/types";
import {
  QUOTA_TTL_MS,
  applyHomeSnapshot,
  loadHomeSnapshot,
  pullQuotaBundle,
  refreshErrorMessage,
} from "./use-rivet-data.lib";

export type UseRivetDataResult = {
  status: Status | null;
  setStatus: (v: Status | null) => void;
  accounts: Account[];
  quota: QuotaSnapshot | null;
  setQuota: (v: QuotaSnapshot | null) => void;
  quotaHistory: QuotaHistory | null;
  catalog: CatalogProvider[];
  recent: TrafficEvent[];
  trafficRows: TrafficEvent[];
  setTrafficRows: (v: TrafficEvent[]) => void;
  apiOnline: boolean;
  lastSyncedAt: number | null;
  ensureSession: () => Promise<void>;
  fetchQuota: () => Promise<void>;
  refresh: (includeQuota?: boolean) => Promise<void>;
  refreshCredentials: () => Promise<void>;
};

function useRivetDataPolling(
  refresh: () => Promise<void>,
  fetchQuota: () => Promise<void>,
  horizon: "1h" | "3h" | "6h",
) {
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      await Effect.runPromiseExit(Rivet.requireBackend);
      await refreshRef.current();
    })();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => {
      clearInterval(id);
    };
  }, [refresh]);

  useEffect(() => {
    void fetchQuota();
  }, [horizon, fetchQuota]);
}

export function useRivetData(opts: {
  horizon: "1h" | "3h" | "6h";
  trafficQuery: string;
  setBusy: (v: boolean) => void;
  setStatusAction: (v: string | null) => void;
  setError: (v: string | null | ((prev: string | null) => string | null)) => void;
  onModelsHydrated: (embed: string, wiki: string) => void;
}): UseRivetDataResult {
  const { horizon, trafficQuery, setBusy, setStatusAction, setError, onModelsHydrated } = opts;

  const lastQuotaFetchAt = useRef(0);
  const refreshInFlight = useRef(false);
  const modelsHydrated = useRef(false);

  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [quotaHistory, setQuotaHistory] = useState<QuotaHistory | null>(null);
  const [catalog, setCatalog] = useState<CatalogProvider[]>(FALLBACK_PROVIDERS);
  const [recent, setRecent] = useState<TrafficEvent[]>([]);
  const [trafficRows, setTrafficRows] = useState<TrafficEvent[]>([]);
  const [apiOnline, setApiOnline] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const ensureSession = useCallback(async () => {
    await runApp(Rivet.requireBackend);
  }, []);

  const fetchQuota = useCallback(async () => {
    const { quota: nextQuota, history: nextHistory } = await pullQuotaBundle(horizon);
    if (nextQuota !== null) {
      setQuota(nextQuota);
      lastQuotaFetchAt.current = Date.now();
    }
    if (nextHistory !== null) {
      setQuotaHistory(nextHistory);
    }
  }, [horizon]);

  const refresh = useCallback(
    async (includeQuota?: boolean) => {
      if (refreshInFlight.current) {
        return;
      }
      refreshInFlight.current = true;
      try {
        const quotaStale =
          includeQuota === true ||
          Date.now() - lastQuotaFetchAt.current >= QUOTA_TTL_MS ||
          lastQuotaFetchAt.current === 0;
        const snapshot = await loadHomeSnapshot();
        if (quotaStale) {
          await fetchQuota();
        }
        const st = applyHomeSnapshot(snapshot, {
          trafficQuery,
          setStatus,
          setAccounts,
          setCatalog,
          setRecent,
          setTrafficRows,
          setApiOnline,
          setLastSyncedAt,
          setError,
        });
        if (!modelsHydrated.current) {
          onModelsHydrated(st.embedding_model ?? "", st.wiki_model ?? "");
          modelsHydrated.current = true;
        }
      } catch (err) {
        setApiOnline(false);
        setError(refreshErrorMessage(err));
      } finally {
        refreshInFlight.current = false;
      }
    },
    [trafficQuery, fetchQuota, setError, onModelsHydrated],
  );

  const refreshCredentials = useCallback(async () => {
    setBusy(true);
    setStatusAction("Updating credentials…");
    try {
      const body = await runApp(
        Effect.gen(function* refreshQuotaCredentials() {
          yield* Rivet.requireBackend;
          return yield* Rivet.refreshQuota;
        }),
      );
      if (body.error !== undefined && body.error !== "" && body.ok === false) {
        throw new Error(body.error);
      }
      if (body.quota !== undefined) {
        setQuota(body.quota);
        lastQuotaFetchAt.current = Date.now();
      } else {
        await fetchQuota();
      }
      await refresh();
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }, [fetchQuota, refresh, setBusy, setStatusAction, setError]);

  useRivetDataPolling(refresh, fetchQuota, horizon);

  return {
    status,
    setStatus,
    accounts,
    quota,
    setQuota,
    quotaHistory,
    catalog,
    recent,
    trafficRows,
    setTrafficRows,
    apiOnline,
    lastSyncedAt,
    ensureSession,
    fetchQuota,
    refresh,
    refreshCredentials,
  };
}
