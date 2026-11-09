import { Effect } from "effect";
import { hasStringMessage, runApp, softEffect } from "../effect";
import * as Rivet from "../effect/rivet";
import type { CatalogProvider } from "../lib/provider-utils";
import type { Account, QuotaHistory, QuotaSnapshot, Status, CaptureEvent } from "../lib/types";

export const QUOTA_TTL_MS = 5 * 60 * 1000;
/** Slow safety net — live cursor invalidation covers most updates. */
export const HOME_REFETCH_MS = 60_000;

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
  recent: CaptureEvent[] | null;
  providers: { providers?: CatalogProvider[] } | null;
};

export function loadHomeSnapshot(): Promise<HomeSnapshot> {
  return runApp(Rivet.homeSnapshot);
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
