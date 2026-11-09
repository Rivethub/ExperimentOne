import type { JSX } from "solid-js";
import { costForProviderEvents } from "../lib/cost-estimate";
import { providerKey } from "../lib/provider-utils";
import type { Series } from "../lib/quota-series";
import type { ProviderQuota, QuotaAccount, CaptureEvent } from "../lib/types";
import { PooledWindowCards } from "./pooled-windows";
import type { MetricMode, QuotaAccountUx } from "./types";
import { QuotaProviderAccountList, QuotaProviderCardEmpty } from "./QuotaProviderCardParts";
import { QuotaProviderCardHeader } from "./QuotaProviderCardHeader";
import { QuotaProviderCardStats } from "./QuotaProviderCardStats";
import {
  isKnownProviderQuota,
  quotaCapLabel,
  quotaCardHeadline,
  quotaChartLegend,
  quotaPoolEmpty,
} from "./provider-card-logic";
import { Panel } from "../ui";
import styles from "../styles/app.module.css";

export type QuotaProviderCardProps = {
  name: string;
  ico: string;
  icoClass: "claude" | "codex" | "generic";
  color: string;
  count: number;
  metricMode: MetricMode;
  series: Series;
  pq: ProviderQuota | null;
  accounts: QuotaAccount[];
  horizon: string;
  observedAt?: string | null;
  providerId: string;
  recent: CaptureEvent[];
  onAddCredentials: () => void;
  onAccountSelect: (a: QuotaAccountUx) => void;
};

export function QuotaProviderCard(props: QuotaProviderCardProps): JSX.Element {
  const {
    name,
    ico,
    icoClass,
    color,
    count,
    metricMode,
    series,
    pq,
    accounts,
    horizon,
    observedAt,
    providerId,
    recent,
    onAddCredentials,
    onAccountSelect,
  } = props;

  if (count === 0) {
    return (
      <QuotaProviderCardEmpty
        name={name}
        ico={ico}
        icoClass={icoClass}
        onAddCredentials={onAddCredentials}
      />
    );
  }

  const knownQuota = isKnownProviderQuota(pq);
  const capacity = knownQuota && pq !== null ? pq.capacity_pct : 0;
  const remaining = knownQuota && pq !== null ? pq.remaining_pct : null;
  const costSummary = costForProviderEvents(
    providerId,
    recent.filter((e) => providerKey(e.provider) === providerId),
  );
  const costHeadline = Math.round(costSummary.usd * 100) / 100;
  const { headline, unit } = quotaCardHeadline({
    metricMode,
    series,
    knownQuota,
    capacity,
    remaining,
    costHeadline,
  });
  const poolEmpty = quotaPoolEmpty(pq, series.emptyAt);
  const chartEmpty =
    metricMode === "limits"
      ? series.eventsInWindow === 0 && !knownQuota
      : series.eventsInWindow === 0;

  return (
    <Panel class="mb-0">
      <QuotaProviderCardHeader
        name={name}
        ico={ico}
        icoClass={icoClass}
        count={count}
        metricMode={metricMode}
        pq={pq}
        knownQuota={knownQuota}
        capacity={capacity}
        observedAt={observedAt}
        headline={headline}
        unit={unit}
        capLabel={quotaCapLabel(metricMode, pq)}
      />
      {metricMode === "limits" && count > 0 && (
        <PooledWindowCards accounts={accounts} color={color} onAccountSelect={onAccountSelect} />
      )}
      {metricMode === "cost" && <p class={styles.costEstimateNote}>{costSummary.note}</p>}
      <QuotaProviderCardStats
        metricMode={metricMode}
        horizon={horizon}
        series={series}
        color={color}
        chartLegend={quotaChartLegend(metricMode)}
        chartEmpty={chartEmpty}
        knownQuota={knownQuota}
        costUsd={costSummary.usd}
        burn={series.burnLabel}
        poolEmpty={poolEmpty}
        firstEmpty={pq?.first_empty ?? "—"}
        nextReset={pq?.next_reset ?? "—"}
      />
      <QuotaProviderAccountList
        accounts={accounts}
        onAddCredentials={onAddCredentials}
        onAccountSelect={onAccountSelect}
      />
    </Panel>
  );
}
