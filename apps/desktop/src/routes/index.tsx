import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useApp } from "#app/context";
import { validateQuotaSearch } from "#app/search";
import { useQuotaDerived } from "#hooks";
import { QuotaPane } from "#panes";

export const Route = createFileRoute("/")({
  validateSearch: validateQuotaSearch,
  component: QuotaPage,
});

function QuotaPage(): React.ReactElement {
  const {
    rivet,
    accounts,
    busy: _busy,
    horizon,
    setHorizon,
    hideLimitBanner,
    openSettings,
    setDetailAccount,
    limitBannerHidden,
  } = useApp();
  const { filter, metric } = Route.useSearch();
  const navigate = Route.useNavigate();

  const derived = useQuotaDerived({
    filter,
    limitBannerHidden,
    catalog: rivet.catalog,
    accounts: rivet.accounts,
    quota: rivet.quota,
    recent: rivet.recent,
  });

  const limitActions = useMemo(
    () => ({
      onRefreshCredentials: () => void rivet.refreshCredentials(),
      onSwitchAccount: () => openSettings("accounts"),
      onWait: () => hideLimitBanner(),
    }),
    [rivet, openSettings, hideLimitBanner],
  );

  return (
    <QuotaPane
      counts={derived.counts}
      filter={filter}
      onFilterChange={(next) => void navigate({ search: (prev) => ({ ...prev, filter: next }) })}
      providerIds={derived.providerIds}
      catalog={rivet.catalog}
      limitHit={derived.limitHit}
      limitActions={limitActions}
      metricMode={metric}
      onMetricModeChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, metric: next }) })
      }
      horizon={horizon}
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
