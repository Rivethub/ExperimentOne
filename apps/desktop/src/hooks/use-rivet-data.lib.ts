import { Effect } from "effect";
import { hasStringMessage, isTransientReachabilityMessage, runApp, softEffect } from "../effect";
import * as Rivet from "../effect/rivet";
import type { CatalogProvider } from "../lib/provider-utils";
import type { Account, QuotaHistory, QuotaSnapshot, Status, TrafficEvent } from "../lib/types";

export const QUOTA_TTL_MS = 5 * 60 * 1000;

export function refreshErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (hasStringMessage(err)) {
    return err.message;
  }
  return "Could not reach rivetd — start it with cargo run -p rivet-runtime";
}

export type HomeSnapshot = {
  status: Status;
  accounts: Account[] | null;
  recent: TrafficEvent[] | null;
  providers: { providers?: CatalogProvider[] } | null;
};

type ApplySnapshotOpts = {
  trafficQuery: string;
  setStatus: (v: Status | null) => void;
  setAccounts: (v: Account[]) => void;
  setCatalog: (v: CatalogProvider[]) => void;
  setRecent: (v: TrafficEvent[]) => void;
  setTrafficRows: (v: TrafficEvent[]) => void;
  setApiOnline: (v: boolean) => void;
  setLastSyncedAt: (v: number | null) => void;
  setError: (v: string | null | ((prev: string | null) => string | null)) => void;
};

export function applyHomeSnapshot(snapshot: HomeSnapshot, opts: ApplySnapshotOpts): Status {
  const st = snapshot.status;
  opts.setStatus(st);
  if (snapshot.accounts !== null) {
    opts.setAccounts(snapshot.accounts);
  }
  const providerList = snapshot.providers?.providers;
  if (providerList !== undefined && providerList.length > 0) {
    opts.setCatalog(providerList);
  }
  if (snapshot.recent !== null) {
    opts.setRecent(snapshot.recent);
    if (opts.trafficQuery.trim() === "") {
      opts.setTrafficRows(snapshot.recent);
    }
  }
  opts.setApiOnline(true);
  opts.setLastSyncedAt(Date.now());
  opts.setError((prev) => (prev !== null && isTransientReachabilityMessage(prev) ? null : prev));
  return st;
}

export function loadHomeSnapshot(): Promise<HomeSnapshot> {
  return runApp(
    Effect.gen(function* fetchHomeSnapshot() {
      yield* Rivet.requireBackend;
      return yield* Effect.all(
        {
          status: Rivet.getStatus,
          accounts: softEffect(Rivet.getAccounts),
          recent: softEffect(Rivet.getTrafficRecent(200)),
          providers: softEffect(Rivet.getProviders),
        },
        { concurrency: "unbounded" },
      );
    }),
  );
}

export async function pullQuotaBundle(horizon: "1h" | "3h" | "6h"): Promise<{
  quota: QuotaSnapshot | null;
  history: QuotaHistory | null;
}> {
  const historyHours = { "1h": 1, "3h": 3, "6h": 6 }[horizon];
  const [nextQuota, nextHistory] = await runApp(
    Effect.all([softEffect(Rivet.getQuota), softEffect(Rivet.getQuotaHistory(historyHours))], {
      concurrency: "unbounded",
    }),
  );
  return { quota: nextQuota, history: nextHistory };
}
