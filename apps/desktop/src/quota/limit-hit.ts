import { providerKey } from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import type { LimitHitInfo, ProviderQuotaUx, QuotaAccountUx, CaptureEventUx } from "./types";

function poolSaysEmpty(pe: string): boolean {
  return (
    pe !== "" &&
    pe !== "—" &&
    !/pending|steady/iu.test(pe) &&
    (/empty|~0|0h|now/iu.test(pe) || pe.toLowerCase().includes("empty"))
  );
}

function windowLabelFromQuota(pq: ProviderQuotaUx): string {
  const pe = pq.pool_empty;
  if (poolSaysEmpty(pe)) {
    return pe;
  }
  if (pq.remaining_pct <= 0.5 && pq.capacity_pct > 0) {
    return "Pooled limit";
  }
  return "Usage limit";
}

function nearestAccountReset(accounts: QuotaAccountUx[]): {
  resetAt: string | null;
  windowLabel: string;
} {
  let resetAt: string | null = null;
  let windowLabel = "Usage limit";

  for (const a of accounts) {
    if (isDefined(a.remaining_pct) && a.remaining_pct <= 0.5) {
      resetAt = a.reset_at ?? resetAt;
      const w = a.windows.find((x) => isDefined(x.remaining_pct) && x.remaining_pct <= 0.5);
      if (w !== undefined) {
        windowLabel = w.label;
      }
    }
  }
  return { resetAt, windowLabel };
}

function quotaPoolHit(pq: ProviderQuotaUx): boolean {
  return pq.capacity_pct > 0 && pq.remaining_pct <= 0.5 && pq.pool_empty !== "—";
}

export function detectLimitHit(
  pq: ProviderQuotaUx | null,
  accounts: QuotaAccountUx[],
  recent: CaptureEventUx[],
  provider?: string,
): LimitHitInfo | null {
  const filteredRecent =
    provider !== undefined && provider !== ""
      ? recent.filter((e) => providerKey(e.provider) === provider)
      : recent;
  const recent429 = filteredRecent.find(
    (e) => e.status_code === 429 && Date.now() - Date.parse(e.ts) < 3_600_000,
  );

  let windowLabel = "Usage limit";
  if (pq !== null) {
    windowLabel = windowLabelFromQuota(pq);
  }

  const { resetAt, windowLabel: accountLabel } = nearestAccountReset(accounts);
  if (accountLabel !== "Usage limit") {
    windowLabel = accountLabel;
  }

  const accountEmpty = accounts.some((a) => isDefined(a.remaining_pct) && a.remaining_pct <= 0.5);

  const hit = recent429 !== undefined || (pq !== null && quotaPoolHit(pq)) || accountEmpty;

  if (!hit) {
    return null;
  }

  return {
    windowLabel,
    resetAt,
    reason: recent429 !== undefined ? "Recent 429 from provider" : "Quota pool at or near empty",
  };
}
