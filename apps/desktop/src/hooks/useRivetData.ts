import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { FALLBACK_PROVIDERS } from "../constants";
import { isTransientReachabilityMessage, Rivet, runApp } from "../effect";
import type { CatalogProvider } from "../providerUtils";
import type { Account, QuotaHistory, QuotaSnapshot, Status, TrafficEvent } from "../types";

const QUOTA_TTL_MS = 5 * 60 * 1000;

export function useRivetData(opts: {
  horizon: "1h" | "3h" | "6h";
  trafficQuery: string;
  setBusy: (v: boolean) => void;
  setStatusAction: (v: string | null) => void;
  setError: (v: string | null | ((prev: string | null) => string | null)) => void;
  onModelsHydrated: (embed: string, wiki: string) => void;
}) {
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
    const historyHours = { "1h": 1, "3h": 3, "6h": 6 }[horizon];
    const soft = <A>(effect: Effect.Effect<A, unknown>) =>
      effect.pipe(Effect.orElseSucceed(() => null as A | null));

    const [nextQuota, nextHistory] = await runApp(
      Effect.all([soft(Rivet.getQuota), soft(Rivet.getQuotaHistory(historyHours))], {
        concurrency: "unbounded",
      }),
    );
    if (nextQuota) {
      setQuota(nextQuota);
      lastQuotaFetchAt.current = Date.now();
    }
    if (nextHistory) setQuotaHistory(nextHistory);
  }, [horizon]);

  const refresh = useCallback(
    async (includeQuota?: boolean) => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      try {
        const quotaStale =
          includeQuota === true ||
          Date.now() - lastQuotaFetchAt.current >= QUOTA_TTL_MS ||
          lastQuotaFetchAt.current === 0;

        const soft = <A>(effect: Effect.Effect<A, unknown>) =>
          effect.pipe(Effect.orElseSucceed(() => null as A | null));

        const snapshot = await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            return yield* Effect.all(
              {
                status: Rivet.getStatus,
                accounts: soft(Rivet.getAccounts),
                recent: soft(Rivet.getTrafficRecent(200)),
                providers: soft(Rivet.getProviders),
              },
              { concurrency: "unbounded" },
            );
          }),
        );

        if (quotaStale) {
          await fetchQuota();
        }

        const st = snapshot.status;
        setStatus(st);
        if (!modelsHydrated.current) {
          onModelsHydrated(st.embedding_model ?? "", st.wiki_model ?? "");
          modelsHydrated.current = true;
        }
        if (snapshot.accounts) setAccounts(snapshot.accounts);
        if (snapshot.providers?.providers?.length) {
          setCatalog(snapshot.providers.providers);
        }
        if (snapshot.recent) {
          setRecent(snapshot.recent);
          if (!trafficQuery.trim()) setTrafficRows(snapshot.recent);
        }
        setApiOnline(true);
        setLastSyncedAt(Date.now());
        setError((prev) => (prev && isTransientReachabilityMessage(prev) ? null : prev));
      } catch (err) {
        setApiOnline(false);
        setError(
          err instanceof Error
            ? err.message
            : err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : "Could not reach rivetd — start it with cargo run -p rivet-runtime",
        );
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
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.refreshQuota;
        }),
      );
      if (body.error && body.ok === false) throw new Error(body.error);
      if (body.quota) {
        setQuota(body.quota);
        lastQuotaFetchAt.current = Date.now();
      } else {
        await fetchQuota();
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }, [fetchQuota, refresh, setBusy, setStatusAction, setError]);

  useEffect(() => {
    void (async () => {
      await Effect.runPromiseExit(Rivet.requireBackend);
      await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only boot
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    void fetchQuota();
  }, [horizon, fetchQuota]);

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
