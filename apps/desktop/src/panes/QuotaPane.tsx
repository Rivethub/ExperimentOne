import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
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
import { Button, Chip, Panel, SegControl } from "../ui";
import { quotaMetricModeTitle } from "./quota-pane-toolbar";
import type {
  ProviderFilter,
  ProviderQuota,
  QuotaAccount,
  QuotaHistory,
  QuotaSnapshot,
  CaptureEvent,
} from "../lib/types";

const METRIC_OPTIONS = [
  { value: "limits" as const, label: "Limits", title: quotaMetricModeTitle("limits") },
  { value: "tokens" as const, label: "Tokens", title: quotaMetricModeTitle("tokens") },
  { value: "cost" as const, label: "Cost", title: quotaMetricModeTitle("cost") },
];

const HORIZON_OPTIONS = [
  { value: "1h" as const, label: "1h" },
  { value: "3h" as const, label: "3h" },
  { value: "6h" as const, label: "6h" },
];

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

export function QuotaPane(props: QuotaPaneProps): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <Show
        when={(props.counts.all ?? 0) > 0}
        fallback={
          <Panel
            class="mb-0"
            title="No accounts yet"
            lede="Live quota needs at least one signed-in account"
            actions={
              <Button variant="primary" onClick={() => props.onAddCredentials()}>
                Add account
              </Button>
            }
          >
            <p class="m-0 max-w-[56ch] text-[13px] leading-snug text-muted-foreground">
              Add a provider account to track remaining limits and burn from captures.
            </p>
          </Panel>
        }
      >
        <LimitRecoveryBanner
          hit={props.limitHit}
          onRefreshCredentials={() => props.limitActions.onRefreshCredentials()}
          onSwitchAccount={() => props.limitActions.onSwitchAccount()}
          onWait={() => props.limitActions.onWait()}
        />
        <div class="mb-3.5 flex flex-wrap gap-2">
          <Chip
            active={props.filter === "all"}
            count={props.counts.all ?? 0}
            onClick={() => {
              props.onFilterChange("all");
            }}
          >
            All
          </Chip>
          <For each={props.providerIds}>
            {(id) => (
              <Chip
                active={props.filter === id}
                dotColor={providerColor(id, props.catalog)}
                count={props.counts[id] ?? 0}
                onClick={() => {
                  props.onFilterChange(id);
                }}
              >
                {providerChipLabel(id, props.catalog)}
              </Chip>
            )}
          </For>
        </div>

        <div class="mb-4.5 flex flex-wrap items-center gap-2">
          <SegControl
            aria-label="Metric mode"
            value={props.metricMode}
            onChange={(mode) => props.onMetricModeChange(mode)}
            options={METRIC_OPTIONS}
          />
          <SegControl
            aria-label="History horizon"
            value={props.horizon}
            onChange={(horizon) => props.onHorizonChange(horizon)}
            options={HORIZON_OPTIONS}
          />
          <span class="py-2 text-[13px] text-muted-foreground" title={props.quota?.note}>
            {props.quota?.source === "management"
              ? `Live credentials · ${props.quota.credentials_loaded}/${props.quota.credentials_total} loaded · quota ≤5m · ${props.horizon} history`
              : `Local fallback · ${props.horizon} window · refresh after proxy is up`}
            {isDefined(props.quota?.observed_at) && props.quota.observed_at !== "" ? (
              <>
                {" "}
                · <StaleStamp observedAt={props.quota.observed_at} />
              </>
            ) : null}
          </span>
        </div>

        <div class="flex flex-col gap-3.5">
          <For each={props.visibleProviders}>
            {(id) => {
              const pq = () => props.providerQuota(id);
              const series = () =>
                props.metricMode === "limits"
                  ? seriesFromRemainingHistory(
                      historyPointsForProvider(props.quotaHistory, id),
                      props.horizon,
                      24,
                      pq()?.remaining_pct,
                      pq()?.capacity_pct,
                    )
                  : seriesFromEvents(props.recent, id, props.horizon, 24, pq()?.remaining_pct);
              return (
                <QuotaProviderCard
                  name={providerChipLabel(id, props.catalog)}
                  ico={providerBadge(id, props.catalog)}
                  icoClass={id === "claude" || id === "codex" ? id : "generic"}
                  color={providerColor(id, props.catalog)}
                  count={props.counts[id] ?? 0}
                  metricMode={props.metricMode}
                  series={series()}
                  pq={pq()}
                  accounts={props.accountsFor(id)}
                  horizon={props.horizon}
                  observedAt={props.quota?.observed_at}
                  providerId={id}
                  recent={props.recent}
                  onAddCredentials={() => props.onAddCredentials()}
                  onAccountSelect={(account) => props.onAccountSelect(account)}
                />
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
