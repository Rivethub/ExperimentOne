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
}): React.ReactElement {
  const showChart = metricMode !== "limits" || series.eventsInWindow > 0 || knownQuota;

  return (
    <>
      <div className={styles.statRow}>
        <div
          className={styles.item}
          title="Estimated time until the pooled remaining hits zero at the current burn"
        >
          <div className={styles.k}>Pool empty</div>
          <div className={styles.v}>{poolEmpty}</div>
        </div>
        <div className={styles.item} title="Account expected to hit empty first under shared burn">
          <div className={styles.k}>First empty</div>
          <div className={styles.v}>{firstEmpty}</div>
        </div>
        <div className={styles.item} title="Soonest provider reset / refill signal">
          <div className={styles.k}>Next reset</div>
          <div className={styles.v}>{nextReset}</div>
        </div>
        <div className={styles.item} title={`Burn over the last ${horizon} of captured traffic`}>
          <div className={styles.k}>
            {metricMode === "cost" ? "Est. cost" : `Burn (last ${horizon})`}
          </div>
          <div className={styles.v}>{metricMode === "cost" ? fmtUsd(costUsd) : burn}</div>
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
              : `No captured traffic in the last ${horizon}`
          }
          legend={chartLegend}
        />
      ) : null}
    </>
  );
}
