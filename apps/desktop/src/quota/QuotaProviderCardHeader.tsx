import { isDefined } from "../lib/nullish";
import type { ProviderQuota } from "../lib/types";
import type { MetricMode } from "./types";
import { StaleStamp } from "./StaleStamp";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function QuotaProviderCardHeader({
  name,
  ico,
  icoClass,
  count,
  metricMode,
  pq,
  knownQuota,
  capacity,
  observedAt,
  headline,
  unit,
  capLabel,
}: {
  name: string;
  ico: string;
  icoClass: "claude" | "codex" | "generic";
  count: number;
  metricMode: MetricMode;
  pq: ProviderQuota | null;
  knownQuota: boolean;
  capacity: number;
  observedAt?: string | null;
  headline: number;
  unit: string;
  capLabel: string;
}): React.ReactElement {
  return (
    <div className={styles.cardHead}>
      <div className={styles.cardTitle}>
        <div className={cx(styles.providerIco, styles[icoClass])}>{ico}</div>
        <div>
          <h2>{name}</h2>
          <div className={styles.meta}>
            {count} account{count === 1 ? "" : "s"}
            {pq !== null ? ` · ${pq.known_count ?? 0}/${count} reporting` : ""}
            {knownQuota ? ` · pool ${Math.round(capacity)}%` : ""} · {metricMode}
            {isDefined(observedAt) && observedAt !== "" ? (
              <>
                {" "}
                · <StaleStamp observedAt={observedAt} />
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div
        className={styles.poolStat}
        title="Sum of remaining % across loaded accounts vs capacity"
      >
        <div className={cx(styles.big, styles[icoClass])}>
          {headline}
          <span className={styles.unit}>{unit}</span>
        </div>
        <div className={styles.cap}>{capLabel}</div>
      </div>
    </div>
  );
}
