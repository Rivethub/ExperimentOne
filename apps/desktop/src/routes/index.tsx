import { createFileRoute } from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { createMemo } from "solid-js";
import { useApp } from "#app/context";
import { validateQuotaSearch } from "#app/search";
import { useQuotaDerived } from "#hooks";
import { QuotaPane } from "#panes";

export const Route = createFileRoute("/")({
  validateSearch: validateQuotaSearch,
  component: QuotaPage,
});

function QuotaPage(): JSX.Element {
  const {
    rivet,
    accounts,
    horizon,
    setHorizon,
    hideLimitBanner,
    openSettings,
    setDetailAccount,
    limitBannerHidden,
  } = useApp();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const derived = useQuotaDerived({
    filter: () => search().filter,
    limitBannerHidden,
    catalog: () => rivet.catalog,
    accounts: () => rivet.accounts,
    quota: () => rivet.quota,
    recent: () => rivet.recent,
  });

  const limitActions = createMemo(() => ({
    onRefreshCredentials: () => void rivet.refreshCredentials(),
    onSwitchAccount: () => openSettings("accounts"),
    onWait: () => hideLimitBanner(),
  }));

  return (
    <QuotaPane
      counts={derived.counts}
      filter={search().filter}
      onFilterChange={(next) => void navigate({ search: (prev) => ({ ...prev, filter: next }) })}
      providerIds={derived.providerIds}
      catalog={rivet.catalog}
      limitHit={derived.limitHit}
      limitActions={limitActions()}
      metricMode={search().metric}
      onMetricModeChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, metric: next }) })
      }
      horizon={horizon()}
      onHorizonChange={setHorizon}
      quota={rivet.quota}
      quotaHistory={rivet.quotaHistory}
      visibleProviders={derived.visibleProviders}
      providerQuota={derived.providerQuota}
      recent={rivet.recent}
      accountsFor={derived.accountsFor}
      onAddCredentials={accounts.beginAddAccount}
      onAccountSelect={setDetailAccount}
    />
  );
}
