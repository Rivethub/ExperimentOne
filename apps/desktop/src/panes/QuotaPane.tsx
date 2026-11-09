import type { JSX } from "solid-js";
import {
  providerBadge,
  providerChipLabel,
  providerColor,
  type CatalogProvider,
} from "../lib/provider-utils";
import {
  QuotaProviderCard,
  LimitRecoveryBanner,
  StaleStamp,
  type LimitHitInfo,
  type MetricMode,
  type QuotaAccountUx,
} from "../quota";
import {
  historyPointsForProvider,
  seriesFromEvents,
  seriesFromRemainingHistory,
} from "../lib/quota-series";
import { isDefined } from "../lib/nullish";
import { Button, Chip, Panel } from "../ui";
import { quotaMetricModeTitle } from "./quota-pane-toolbar";
import { cn } from "#lib/utils";
import type {
  ProviderFilter,
  ProviderQuota,
  QuotaAccount,
  QuotaHistory,
  QuotaSnapshot,
  CaptureEvent,
} from "../lib/types";

export type QuotaPaneProps = {
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
  recent: CaptureEvent[];
  accountsFor: (provider: string) => QuotaAccount[];
  onAddCredentials: () => void;
  onAccountSelect: (account: QuotaAccountUx) => void;
};

function SegButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      class={cn(
        "border-0 bg-transparent px-2.5 py-1.5 text-xs font-medium text-muted-foreground",
        "[&:not(:first-child)]:border-l [&:not(:first-child)]:border-border",
        active && "bg-secondary text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function QuotaPane({
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
}: QuotaPaneProps): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {(counts.all ?? 0) > 0 ? (
        <>
          <LimitRecoveryBanner
            hit={limitHit}
            onRefreshCredentials={limitActions.onRefreshCredentials}
            onSwitchAccount={limitActions.onSwitchAccount}
            onWait={limitActions.onWait}
          />
          <div class="mb-3.5 flex flex-wrap gap-2">
            <Chip
              active={filter === "all"}
              count={counts.all ?? 0}
              onClick={() => {
                onFilterChange("all");
              }}
            >
              All
            </Chip>
            {providerIds.map((id) => (
              <Chip
                active={filter === id}
                dotColor={providerColor(id, catalog)}
                count={counts[id] ?? 0}
                onClick={() => {
                  onFilterChange(id);
                }}
              >
                {providerChipLabel(id, catalog)}
              </Chip>
            ))}
          </div>

          <div class="mb-4.5 flex flex-wrap items-center gap-2">
            <div class="inline-flex overflow-hidden rounded-lg border border-border bg-card">
              {(
                [
                  ["limits", "Limits"],
                  ["tokens", "Tokens"],
                  ["cost", "Cost"],
                ] as const
              ).map(([id, label]) => (
                <SegButton
                  active={metricMode === id}
                  title={quotaMetricModeTitle(id)}
                  onClick={() => {
                    onMetricModeChange(id);
                  }}
                >
                  {label}
                </SegButton>
              ))}
            </div>
            <div class="inline-flex overflow-hidden rounded-lg border border-border bg-card">
              {(["1h", "3h", "6h"] as const).map((h) => (
                <SegButton
                  active={horizon === h}
                  onClick={() => {
                    onHorizonChange(h);
                  }}
                >
                  {h}
                </SegButton>
              ))}
            </div>
            <span class="py-2 text-[13px] text-muted-foreground" title={quota?.note}>
              {quota?.source === "management"
                ? `Live credentials · ${quota.credentials_loaded}/${quota.credentials_total} loaded · quota ≤5m · ${horizon} history`
                : `Local fallback · ${horizon} window · refresh after proxy is up`}
              {isDefined(quota?.observed_at) && quota.observed_at !== "" ? (
                <>
                  {" "}
                  · <StaleStamp observedAt={quota.observed_at} />
                </>
              ) : null}
            </span>
          </div>

          <div class="flex flex-col gap-3.5">
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
        <Panel
          class="mb-0"
          title="No accounts yet"
          lede="Live quota needs at least one signed-in account"
          actions={
            <Button variant="primary" onClick={onAddCredentials}>
              Add account
            </Button>
          }
        >
          <p class="m-0 max-w-[56ch] text-[13px] leading-snug text-muted-foreground">
            Add a provider account to track remaining limits and burn from captures.
          </p>
        </Panel>
      )}
    </div>
  );
}
