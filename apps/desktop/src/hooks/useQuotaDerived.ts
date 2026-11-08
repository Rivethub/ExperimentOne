import { useCallback, useMemo } from "react";
import { detectLimitHit } from "../quota";
import type { QuotaAccountUx } from "../quota";
import type { CatalogProvider } from "../providerUtils";
import { providerKey } from "../providerUtils";
import type { Account, ProviderFilter, QuotaAccount, QuotaSnapshot, TrafficEvent } from "../types";

export function useQuotaDerived(opts: {
  filter: ProviderFilter;
  limitBannerHidden: boolean;
  catalog: CatalogProvider[];
  accounts: Account[];
  quota: QuotaSnapshot | null;
  recent: TrafficEvent[];
}) {
  const { filter, limitBannerHidden, catalog, accounts, quota, recent } = opts;

  const accountSource = quota?.accounts?.length ? quota.accounts : accounts;

  const providerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of catalog) ids.add(p.id);
    for (const a of accountSource) ids.add(providerKey(a.provider));
    for (const p of quota?.providers ?? []) ids.add(providerKey(p.provider));
    for (const e of recent) ids.add(providerKey(e.provider));
    const ordered = [
      ...catalog.map((p) => p.id),
      ...[...ids].filter((id) => !catalog.some((p) => p.id === id) && id !== "other"),
    ];
    return ordered.filter((id, i) => ordered.indexOf(id) === i);
  }, [catalog, accountSource, quota, recent]);

  const counts = useMemo(() => {
    const by: Record<string, number> = { all: accountSource.length };
    for (const id of providerIds) {
      by[id] = accountSource.filter((a) => providerKey(a.provider) === id).length;
    }
    return by;
  }, [accountSource, providerIds]);

  const providerQuota = useCallback(
    (provider: string) =>
      quota?.providers?.find((p) => providerKey(p.provider) === provider) ?? null,
    [quota],
  );

  const accountsFor = useCallback(
    (provider: string): QuotaAccount[] => {
      if (quota?.accounts?.length) {
        return quota.accounts.filter((a) => providerKey(a.provider) === provider);
      }
      return accounts
        .filter((a) => providerKey(a.provider) === provider)
        .map((a) => ({
          id: a.id,
          provider: a.provider,
          label: a.label,
          email: a.label.includes("@") ? a.label : null,
          plan: null,
          remaining_pct: null,
          reset_at: null,
          cooldown_seconds: null,
          supports_quota: false,
          loaded: true,
          status: "local",
          windows: [],
        }));
    },
    [quota, accounts],
  );

  const quotaById = useMemo(() => {
    const m = new Map<string, QuotaAccountUx>();
    for (const a of quota?.accounts ?? []) {
      m.set(a.id, { ...a, windows: a.windows ?? [] });
    }
    return m;
  }, [quota]);

  const limitHit = useMemo(() => {
    if (limitBannerHidden) return null;
    const providersToCheck =
      filter === "all" ? providerIds.filter((id) => (counts[id] ?? 0) > 0) : [filter];
    for (const id of providersToCheck) {
      const hit = detectLimitHit(
        providerQuota(id),
        accountsFor(id).map((a) => ({ ...a, windows: a.windows ?? [] })),
        recent,
        id,
      );
      if (hit) return hit;
    }
    return detectLimitHit(
      null,
      (quota?.accounts ?? []).map((a) => ({ ...a, windows: a.windows ?? [] })),
      recent,
    );
  }, [limitBannerHidden, filter, quota, recent, providerQuota, accountsFor, providerIds, counts]);

  const visibleProviders = useMemo(() => {
    if (filter === "all") {
      const active = providerIds.filter(
        (id) => (counts[id] ?? 0) > 0 || recent.some((e) => providerKey(e.provider) === id),
      );
      return active.length ? active : catalog.map((p) => p.id).slice(0, 4);
    }
    return [filter];
  }, [filter, providerIds, counts, recent, catalog]);

  return {
    providerIds,
    counts,
    providerQuota,
    accountsFor,
    quotaById,
    limitHit,
    visibleProviders,
  };
}
