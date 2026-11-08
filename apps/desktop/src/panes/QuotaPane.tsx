import {
  providerBadge,
  providerChipLabel,
  providerColor,
  type CatalogProvider,
} from "../providerUtils";
import { QuotaProviderCard } from "../quota";
import {
  historyPointsForProvider,
  seriesFromEvents,
  seriesFromRemainingHistory,
} from "../quotaSeries";
import {
  LimitRecoveryBanner,
  StaleStamp,
  type LimitHitInfo,
  type MetricMode,
  type QuotaAccountUx,
} from "../quota";
import { Button, Chip } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";
import type {
  ProviderFilter,
  ProviderQuota,
  QuotaAccount,
  QuotaHistory,
  QuotaSnapshot,
  TrafficEvent,
} from "../types";

export type QuotaPaneProps = {
  active: boolean;
  counts: Record<string, number>;
  filter: ProviderFilter;
  onFilterChange: (filter: ProviderFilter) => void;
  providerIds: string[];
  catalog: CatalogProvider[];
  limitHit: LimitHitInfo | null;
  limitActions: {
    onRefreshCredentials: () => void;
    onSwitchAccount: () => void;
    onWait: () => void;
  };
  metricMode: MetricMode;
  onMetricModeChange: (mode: MetricMode) => void;
  horizon: "1h" | "3h" | "6h";
  onHorizonChange: (horizon: "1h" | "3h" | "6h") => void;
  quota: QuotaSnapshot | null;
  quotaHistory: QuotaHistory | null;
  visibleProviders: string[];
  providerQuota: (provider: string) => ProviderQuota | null;
  recent: TrafficEvent[];
  accountsFor: (provider: string) => QuotaAccount[];
  onAddCredentials: () => void;
  onAccountSelect: (account: QuotaAccountUx) => void;
};

export function QuotaPane({
  active,
  counts,
  filter,
  onFilterChange,
  providerIds,
  catalog,
  limitHit,
  limitActions,
  metricMode,
  onMetricModeChange,
  horizon,
  onHorizonChange,
  quota,
  quotaHistory,
  visibleProviders,
  providerQuota,
  recent,
  accountsFor,
  onAddCredentials,
  onAccountSelect,
}: QuotaPaneProps) {
  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      {counts.all > 0 ? (
        <>
          <LimitRecoveryBanner
            hit={limitHit}
            onRefreshCredentials={limitActions.onRefreshCredentials}
            onSwitchAccount={limitActions.onSwitchAccount}
            onWait={limitActions.onWait}
          />
          <div className={styles.filters}>
            <Chip active={filter === "all"} count={counts.all ?? 0} onClick={() => onFilterChange("all")}>
              All
            </Chip>
            {providerIds.map((id) => (
              <Chip
                key={id}
                active={filter === id}
                dotColor={providerColor(id, catalog)}
                count={counts[id] ?? 0}
                onClick={() => onFilterChange(id)}
              >
                {providerChipLabel(id, catalog)}
              </Chip>
            ))}
          </div>

          <div className={styles.toolbar}>
            <div className={cx(styles.seg, styles.metricCtl)}>
              {(
                [
                  ["limits", "L"],
                  ["tokens", "T"],
                  ["cost", "C"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={metricMode === id ? "active" : ""}
                  onClick={() => onMetricModeChange(id)}
                  title={
                    id === "limits"
                      ? "Subscription windows + remaining history"
                      : id === "tokens"
                        ? "Token burn from captured traffic"
                        : "Estimated API-equivalent cost (labeled rates)"
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.seg}>
              {(["1h", "3h", "6h"] as const).map((h) => (
                <button
                  key={h}
                  className={horizon === h ? "active" : ""}
                  onClick={() => onHorizonChange(h)}
                >
                  {h}
                </button>
              ))}
            </div>
            <span className={styles.empty} title={quota?.note}>
              {quota?.source === "management"
                ? `Live credentials · ${quota.credentials_loaded}/${quota.credentials_total} loaded · quota ≤5m · ${horizon} history`
                : `Local fallback · ${horizon} window · refresh after proxy is up`}
              {quota?.observed_at ? (
                <>
                  {" "}
                  · <StaleStamp observedAt={quota.observed_at} />
                </>
              ) : null}
            </span>
          </div>

          <div className={styles.stack}>
            {visibleProviders.map((id) => {
              const pq = providerQuota(id);
              const series =
                metricMode === "limits"
                  ? seriesFromRemainingHistory(
                      historyPointsForProvider(quotaHistory, id),
                      horizon,
                      24,
                      pq?.remaining_pct,
                      pq?.capacity_pct,
                    )
                  : seriesFromEvents(recent, id, horizon, 24, pq?.remaining_pct);
              return (
                <QuotaProviderCard
                  key={id}
                  name={providerChipLabel(id, catalog)}
                  ico={providerBadge(id, catalog)}
                  icoClass={id === "claude" || id === "codex" ? id : "generic"}
                  color={providerColor(id, catalog)}
                  count={counts[id] ?? 0}
                  metricMode={metricMode}
                  series={series}
                  pq={pq}
                  accounts={accountsFor(id)}
                  horizon={horizon}
                  observedAt={quota?.observed_at}
                  providerId={id}
                  recent={recent}
                  onAddCredentials={onAddCredentials}
                  onAccountSelect={onAccountSelect}
                />
              );
            })}
          </div>
        </>
      ) : (
        <section className={cx(styles.card, styles.quotaEmptyCard)}>
          <div className={styles.cardHead}>
            <div className={styles.cardTitle}>
              <div>
                <h2>No accounts yet</h2>
                <div className={styles.meta}>Live quota needs at least one signed-in account</div>
              </div>
            </div>
            <Button variant="primary" onClick={onAddCredentials}>
              Add account
            </Button>
          </div>
          <p className={styles.quotaEmptyCopy}>
            Add a provider account to track remaining limits and burn from captured traffic.
          </p>
        </section>
      )}
    </div>
  );
}
