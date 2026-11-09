import type { JSX } from "solid-js";
import { Show, createMemo } from "solid-js";
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
  const knownQuota = createMemo(() => isKnownProviderQuota(props.pq));
  const capacity = createMemo(() =>
    knownQuota() && props.pq !== null ? props.pq.capacity_pct : 0,
  );
  const remaining = createMemo(() =>
    knownQuota() && props.pq !== null ? props.pq.remaining_pct : null,
  );
  const costSummary = createMemo(() =>
    costForProviderEvents(
      props.providerId,
      props.recent.filter((e) => providerKey(e.provider) === props.providerId),
    ),
  );
  const costHeadline = createMemo(() => Math.round(costSummary().usd * 100) / 100);
  const cardHeadline = createMemo(() =>
    quotaCardHeadline({
      metricMode: props.metricMode,
      series: props.series,
      knownQuota: knownQuota(),
      capacity: capacity(),
      remaining: remaining(),
      costHeadline: costHeadline(),
    }),
  );
  const poolEmpty = createMemo(() => quotaPoolEmpty(props.pq, props.series.emptyAt));
  const chartEmpty = createMemo(() =>
    props.metricMode === "limits"
      ? props.series.eventsInWindow === 0 && !knownQuota()
      : props.series.eventsInWindow === 0,
  );

  return (
    <Show
      when={props.count > 0}
      fallback={
        <QuotaProviderCardEmpty
          name={props.name}
          ico={props.ico}
          icoClass={props.icoClass}
          onAddCredentials={() => props.onAddCredentials()}
        />
      }
    >
      <Panel class="mb-0">
        <QuotaProviderCardHeader
          name={props.name}
          ico={props.ico}
          icoClass={props.icoClass}
          count={props.count}
          metricMode={props.metricMode}
          pq={props.pq}
          knownQuota={knownQuota()}
          capacity={capacity()}
          observedAt={props.observedAt}
          headline={cardHeadline().headline}
          unit={cardHeadline().unit}
          capLabel={quotaCapLabel(props.metricMode, props.pq)}
        />
        <Show when={props.metricMode === "limits" && props.count > 0}>
          <PooledWindowCards
            accounts={props.accounts}
            color={props.color}
            onAccountSelect={(a) => props.onAccountSelect(a)}
          />
        </Show>
        <Show when={props.metricMode === "cost"}>
          <p class={styles.costEstimateNote}>{costSummary().note}</p>
        </Show>
        <QuotaProviderCardStats
          metricMode={props.metricMode}
          horizon={props.horizon}
          series={props.series}
          color={props.color}
          chartLegend={quotaChartLegend(props.metricMode)}
          chartEmpty={chartEmpty()}
          knownQuota={knownQuota()}
          costUsd={costSummary().usd}
          burn={props.series.burnLabel}
          poolEmpty={poolEmpty()}
          firstEmpty={props.pq?.first_empty ?? "—"}
          nextReset={props.pq?.next_reset ?? "—"}
        />
        <QuotaProviderAccountList
          accounts={props.accounts}
          onAddCredentials={() => props.onAddCredentials()}
          onAccountSelect={(a) => props.onAccountSelect(a)}
        />
      </Panel>
    </Show>
  );
}
