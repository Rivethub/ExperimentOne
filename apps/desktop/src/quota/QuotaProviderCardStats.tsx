import type { JSX } from "solid-js";
import { Show, createMemo } from "solid-js";
import { fmtUsd } from "../lib/cost-estimate";
import type { Series } from "../lib/quota-series";
import type { MetricMode } from "./types";
import { QuotaChart } from "./QuotaChart";
import { styles } from "#styles";

export function QuotaProviderCardStats(props: {
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
  const showChart = createMemo(
    () => props.metricMode !== "limits" || props.series.eventsInWindow > 0 || props.knownQuota,
  );

  return (
    <>
      <div class={styles.statRow}>
        <div
          class={styles.item}
          title="Estimated time until the pooled remaining hits zero at the current burn"
        >
          <div class={styles.k}>Pool empty</div>
          <div class={styles.v}>{props.poolEmpty}</div>
        </div>
        <div class={styles.item} title="Account expected to hit empty first under shared burn">
          <div class={styles.k}>First empty</div>
          <div class={styles.v}>{props.firstEmpty}</div>
        </div>
        <div class={styles.item} title="Soonest provider reset / refill signal">
          <div class={styles.k}>Next reset</div>
          <div class={styles.v}>{props.nextReset}</div>
        </div>
        <div class={styles.item} title={`Burn over the last ${props.horizon} of captures`}>
          <div class={styles.k}>
            {props.metricMode === "cost" ? "Est. cost" : `Burn (last ${props.horizon})`}
          </div>
          <div class={styles.v}>
            {props.metricMode === "cost" ? fmtUsd(props.costUsd) : props.burn}
          </div>
        </div>
      </div>
      <Show when={showChart()}>
        <QuotaChart
          recorded={props.series.recorded}
          color={props.color}
          empty={props.chartEmpty}
          emptyLabel={
            props.metricMode === "limits"
              ? `No live remaining samples in the last ${props.horizon} yet`
              : `No captures in the last ${props.horizon}`
          }
          legend={props.chartLegend}
        />
      </Show>
    </>
  );
}
