import { useCallback, useMemo } from "react";
import { detectLimitHit, type QuotaAccountUx } from "../quota";
import { providerKey, type CatalogProvider } from "../lib/provider-utils";
import type {
  Account,
  ProviderFilter,
  QuotaAccount,
  QuotaSnapshot,
  CaptureEvent,
} from "../lib/types";

export type UseQuotaDerivedResult = {
  providerIds: string[];
  counts: Record<string, number>;
  providerQuota: (provider: string) => QuotaSnapshot["providers"][number] | null;
  accountsFor: (provider: string) => QuotaAccount[];
  quotaById: Map<string, QuotaAccountUx>;
  limitHit: ReturnType<typeof detectLimitHit>;
  visibleProviders: string[];
};

export function useQuotaDerived(opts: {
  filter: ProviderFilter;
  limitBannerHidden: boolean;
  catalog: CatalogProvider[];
  accounts: Account[];
  quota: QuotaSnapshot | null;
  recent: CaptureEvent[];
}): UseQuotaDerivedResult {
  const { filter, limitBannerHidden, catalog, accounts, quota, recent } = opts;

  const accountSource = useMemo(() => {
    if (quota !== null && quota.accounts.length > 0) {
      return quota.accounts;
    }
    return accounts;
  }, [quota, accounts]);

  const providerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of catalog) {
      ids.add(p.id);
    }
    for (const a of accountSource) {
      ids.add(providerKey(a.provider));
    }
    if (quota !== null) {
      for (const p of quota.providers) {
        ids.add(providerKey(p.provider));
      }
    }
    for (const e of recent) {
      ids.add(providerKey(e.provider));
    }
    const ordered = [
      ...catalog.map((p) => p.id),
      ...[...ids].filter((id) => !catalog.some((p) => p.id === id) && id !== "other"),
    ];
    return ordered.filter((id, i) => ordered.indexOf(id) === i);
  }, [catalog, accountSource, quota, recent]);

  const counts = useMemo((): Record<string, number> => {
    const by: Record<string, number> = { all: accountSource.length };
    for (const id of providerIds) {
      by[id] = accountSource.filter((a) => providerKey(a.provider) === id).length;
    }
    return by;
  }, [accountSource, providerIds]);

  const providerQuota = useCallback(
    (provider: string) => {
      if (quota === null) {
        return null;
      }
      return quota.providers.find((p) => providerKey(p.provider) === provider) ?? null;
    },
    [quota],
  );

  const accountsFor = useCallback(
    (provider: string): QuotaAccount[] => {
      if (quota !== null && quota.accounts.length > 0) {
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
    if (quota !== null) {
      for (const a of quota.accounts) {
        m.set(a.id, { ...a, windows: a.windows });
      }
    }
    return m;
  }, [quota]);

  const limitHit = useMemo(() => {
    if (limitBannerHidden) {
      return null;
    }
    const providersToCheck =
      filter === "all" ? providerIds.filter((id) => (counts[id] ?? 0) > 0) : [filter];
    for (const id of providersToCheck) {
      const hit = detectLimitHit(providerQuota(id), accountsFor(id), recent, id);
      if (hit !== null) {
        return hit;
      }
    }
    const quotaAccounts = quota !== null ? quota.accounts : [];
    return detectLimitHit(null, quotaAccounts, recent);
  }, [limitBannerHidden, filter, quota, recent, providerQuota, accountsFor, providerIds, counts]);

  const visibleProviders = useMemo(() => {
    if (filter === "all") {
      const active = providerIds.filter(
        (id) => (counts[id] ?? 0) > 0 || recent.some((e) => providerKey(e.provider) === id),
      );
      return active.length > 0 ? active : catalog.map((p) => p.id).slice(0, 4);
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
