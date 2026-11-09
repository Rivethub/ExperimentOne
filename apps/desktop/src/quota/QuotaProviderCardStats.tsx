import type { JSX } from "solid-js";
import { fmtUsd } from "../lib/cost-estimate";
import type { Series } from "../lib/quota-series";
import type { MetricMode } from "./types";
import { QuotaChart } from "./QuotaChart";
import styles from "../styles/app.module.css";

export function QuotaProviderCardStats({
  metricMode,
  horizon,
  series,
  color,
  chartLegend,
  chartEmpty,
  knownQuota,
  costUsd,
  burn,
  poolEmpty,
  firstEmpty,
  nextReset,
}: {
  metricMode: MetricMode;
  horizon: string;
  series: Series;
  color: string;
  chartLegend: string;
  chartEmpty: boolean;
  knownQuota: boolean;
  costUsd: number;
  burn: string;
  poolEmpty: string;
  firstEmpty: string;
  nextReset: string;
}): JSX.Element {
  const showChart = metricMode !== "limits" || series.eventsInWindow > 0 || knownQuota;

  return (
    <>
      <div class={styles.statRow}>
        <div
          class={styles.item}
          title="Estimated time until the pooled remaining hits zero at the current burn"
        >
          <div class={styles.k}>Pool empty</div>
          <div class={styles.v}>{poolEmpty}</div>
        </div>
        <div class={styles.item} title="Account expected to hit empty first under shared burn">
          <div class={styles.k}>First empty</div>
          <div class={styles.v}>{firstEmpty}</div>
        </div>
        <div class={styles.item} title="Soonest provider reset / refill signal">
          <div class={styles.k}>Next reset</div>
          <div class={styles.v}>{nextReset}</div>
        </div>
        <div class={styles.item} title={`Burn over the last ${horizon} of captures`}>
          <div class={styles.k}>
            {metricMode === "cost" ? "Est. cost" : `Burn (last ${horizon})`}
          </div>
          <div class={styles.v}>{metricMode === "cost" ? fmtUsd(costUsd) : burn}</div>
        </div>
      </div>
      {showChart ? (
        <QuotaChart
          recorded={series.recorded}
          color={color}
          empty={chartEmpty}
          emptyLabel={
            metricMode === "limits"
              ? `No live remaining samples in the last ${horizon} yet`
              : `No captures in the last ${horizon}`
          }
          legend={chartLegend}
        />
      ) : null}
    </>
  );
}
