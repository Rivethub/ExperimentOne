import { providerKey } from "../providerUtils";
import type { LimitHitInfo, ProviderQuotaUx, QuotaAccountUx, TrafficEventUx } from "./types";

export function detectLimitHit(
  pq: ProviderQuotaUx | null,
  accounts: QuotaAccountUx[],
  recent: TrafficEventUx[],
  provider?: string,
): LimitHitInfo | null {
  const filteredRecent = provider
    ? recent.filter((e) => providerKey(e.provider) === provider)
    : recent;
  const recent429 = filteredRecent.find(
    (e) => e.status_code === 429 && Date.now() - Date.parse(e.ts) < 3600_000,
  );

  let resetAt: string | null = null;
  let windowLabel = "Usage limit";

  if (pq) {
    const pe = pq.pool_empty ?? "";
    const poolSaysEmpty =
      pe &&
      pe !== "—" &&
      !/pending|steady/i.test(pe) &&
      (/empty|~0|0h|now/i.test(pe) || pe.toLowerCase().includes("empty"));
    if (poolSaysEmpty) {
      windowLabel = pe;
    }
    if (pq.remaining_pct <= 0.5 && pq.capacity_pct > 0) {
      windowLabel = windowLabel || "Pooled limit";
    }
    if (pq.next_reset && pq.next_reset !== "—") {
      // next_reset is human text; prefer account reset_at
    }
  }

  for (const a of accounts) {
    if (a.remaining_pct != null && a.remaining_pct <= 0.5) {
      resetAt = a.reset_at ?? resetAt;
      const w = (a.windows ?? []).find((x) => x.remaining_pct != null && x.remaining_pct <= 0.5);
      if (w) windowLabel = w.label;
    }
  }

  const hit =
    recent429 != null ||
    (pq != null && pq.capacity_pct > 0 && pq.remaining_pct <= 0.5 && pq.pool_empty !== "—") ||
    accounts.some((a) => a.remaining_pct != null && a.remaining_pct <= 0.5);

  if (!hit) return null;

  return {
    windowLabel,
    resetAt,
    reason: recent429 ? "Recent 429 from provider" : "Quota pool at or near empty",
  };
}
