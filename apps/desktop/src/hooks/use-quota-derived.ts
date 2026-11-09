import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";
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
  filter: Accessor<ProviderFilter>;
  limitBannerHidden: Accessor<boolean>;
  catalog: Accessor<CatalogProvider[]>;
  accounts: Accessor<Account[]>;
  quota: Accessor<QuotaSnapshot | null>;
  recent: Accessor<CaptureEvent[]>;
}): UseQuotaDerivedResult {
  const accountSource = createMemo(() => {
    const q = opts.quota();
    if (q !== null && q.accounts.length > 0) {
      return q.accounts;
    }
    return opts.accounts();
  });

  const providerIds = createMemo(() => {
    const ids = new Set<string>();
    for (const p of opts.catalog()) {
      ids.add(p.id);
    }
    for (const a of accountSource()) {
      ids.add(providerKey(a.provider));
    }
    const q = opts.quota();
    if (q !== null) {
      for (const p of q.providers) {
        ids.add(providerKey(p.provider));
      }
    }
    for (const e of opts.recent()) {
      ids.add(providerKey(e.provider));
    }
    const ordered = [
      ...opts.catalog().map((p) => p.id),
      ...[...ids].filter((id) => !opts.catalog().some((p) => p.id === id) && id !== "other"),
    ];
    return ordered.filter((id, i) => ordered.indexOf(id) === i);
  });

  const counts = createMemo((): Record<string, number> => {
    const by: Record<string, number> = { all: accountSource().length };
    for (const id of providerIds()) {
      by[id] = accountSource().filter((a) => providerKey(a.provider) === id).length;
    }
    return by;
  });

  const providerQuota = (provider: string) => {
    const q = opts.quota();
    if (q === null) {
      return null;
    }
    return q.providers.find((p) => providerKey(p.provider) === provider) ?? null;
  };

  const accountsFor = (provider: string): QuotaAccount[] => {
    const q = opts.quota();
    if (q !== null && q.accounts.length > 0) {
      return q.accounts.filter((a) => providerKey(a.provider) === provider);
    }
    return opts
      .accounts()
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
  };

  const quotaById = createMemo(() => {
    const m = new Map<string, QuotaAccountUx>();
    const q = opts.quota();
    if (q !== null) {
      for (const a of q.accounts) {
        m.set(a.id, { ...a, windows: a.windows });
      }
    }
    return m;
  });

  const limitHit = createMemo(() => {
    if (opts.limitBannerHidden()) {
      return null;
    }
    const providersToCheck =
      opts.filter() === "all"
        ? providerIds().filter((id) => (counts()[id] ?? 0) > 0)
        : [opts.filter()];
    for (const id of providersToCheck) {
      const hit = detectLimitHit(providerQuota(id), accountsFor(id), opts.recent(), id);
      if (hit !== null) {
        return hit;
      }
    }
    const q = opts.quota();
    const quotaAccounts = q !== null ? q.accounts : [];
    return detectLimitHit(null, quotaAccounts, opts.recent());
  });

  const visibleProviders = createMemo(() => {
    if (opts.filter() === "all") {
      const active = providerIds().filter(
        (id) =>
          (counts()[id] ?? 0) > 0 || opts.recent().some((e) => providerKey(e.provider) === id),
      );
      return active.length > 0
        ? active
        : opts
            .catalog()
            .map((p) => p.id)
            .slice(0, 4);
    }
    return [opts.filter()];
  });

  return {
    get providerIds() {
      return providerIds();
    },
    get counts() {
      return counts();
    },
    providerQuota,
    accountsFor,
    get quotaById() {
      return quotaById();
    },
    get limitHit() {
      return limitHit();
    },
    get visibleProviders() {
      return visibleProviders();
    },
  };
}
