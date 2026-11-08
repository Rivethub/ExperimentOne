import { costForProviderEvents, fmtUsd } from "../costEstimate";
import { accountDisplay } from "../formatUtils";
import { fmtPct, providerKey } from "../providerUtils";
import type { Series } from "../quotaSeries";
import type { ProviderQuota, QuotaAccount, TrafficEvent } from "../types";
import { QuotaChart } from "./QuotaChart";
import { PooledWindowCards } from "./pooledWindows";
import { StaleStamp } from "./StaleStamp";
import type { MetricMode, QuotaAccountUx } from "./types";
import { Button } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function QuotaProviderCard({
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
}: {
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
  recent: TrafficEvent[];
  onAddCredentials: () => void;
  onAccountSelect: (a: QuotaAccountUx) => void;
}) {
  const knownQuota = pq != null && pq.capacity_pct > 0 && Number.isFinite(pq.remaining_pct);
  const capacity = knownQuota ? pq!.capacity_pct : 0;
  const remaining = knownQuota ? pq!.remaining_pct : null;
  const costSummary = costForProviderEvents(
    providerId,
    recent.filter((e) => providerKey(e.provider) === providerId),
  );
  const headline =
    metricMode === "limits"
      ? knownQuota
        ? Number(remaining!.toFixed(0))
        : series.headline
      : metricMode === "cost"
        ? Math.round(costSummary.usd * 100) / 100
        : series.headline;
  const unit =
    metricMode === "limits"
      ? knownQuota
        ? `% / ${Math.round(capacity)}`
        : series.headlineUnit
      : metricMode === "cost"
        ? "est. USD"
        : series.headlineUnit;
  const poolEmpty = pq?.pool_empty && pq.pool_empty !== "—" ? pq.pool_empty : series.emptyAt;
  const firstEmpty = pq?.first_empty ?? "—";
  const nextReset = pq?.next_reset ?? "—";
  const burn = series.burnLabel;

  if (count === 0) {
    return (
      <section className={cx(styles.card, styles.quotaEmptyCard)}>
        <div className={styles.cardHead}>
          <div className={styles.cardTitle}>
            <div className={cx(styles.providerIco, styles[icoClass])}>{ico}</div>
            <div>
              <h2>{name}</h2>
              <div className={styles.meta}>No credentials yet</div>
            </div>
          </div>
          <Button variant="primary" onClick={onAddCredentials}>
            Add account
          </Button>
        </div>
        <p className={styles.quotaEmptyCopy}>
          Add an account to track live remaining limits and burn for {name}.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <div className={cx(styles.providerIco, styles[icoClass])}>{ico}</div>
          <div>
            <h2>{name}</h2>
            <div className={styles.meta}>
              {count} account{count === 1 ? "" : "s"}
              {pq ? ` · ${pq.known_count ?? 0}/${count} reporting` : ""}
              {knownQuota ? ` · pool ${Math.round(capacity)}%` : ""} · {metricMode}
              {observedAt ? (
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
          <div className={styles.cap}>
            {metricMode === "limits"
              ? "subscription windows"
              : metricMode === "cost"
                ? "labeled estimate"
                : pq
                  ? "live + traffic burn"
                  : "from captured traffic"}
          </div>
        </div>
      </div>
      {metricMode === "limits" && count > 0 && (
        <PooledWindowCards
          accounts={accounts.map((a) => ({
            ...a,
            windows: a.windows ?? [],
          }))}
          color={color}
          onAccountSelect={onAccountSelect}
        />
      )}
      {metricMode === "cost" && <p className={styles.costEstimateNote}>{costSummary.note}</p>}
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
          <div className={styles.v}>{metricMode === "cost" ? fmtUsd(costSummary.usd) : burn}</div>
        </div>
      </div>
      {metricMode !== "limits" || series.eventsInWindow > 0 || knownQuota ? (
        <QuotaChart
          recorded={series.recorded}
          color={color}
          empty={
            metricMode === "limits"
              ? series.eventsInWindow === 0 && !knownQuota
              : series.eventsInWindow === 0
          }
          emptyLabel={
            metricMode === "limits"
              ? `No live remaining samples in the last ${horizon} yet`
              : `No captured traffic in the last ${horizon}`
          }
          legend={
            metricMode === "limits"
              ? "Account remaining % (historical)"
              : metricMode === "cost"
                ? "Traffic volume (for cost context)"
                : "Measured traffic burn"
          }
        />
      ) : null}
      <div className={styles.quotaAccounts}>
        {accounts.map((a) => {
          const rem = a.remaining_pct;
          const empty = rem != null && rem <= 0.5;
          return (
            <div
              key={a.id}
              className={cx(
                styles.quotaAccount,
                empty ? styles.isEmpty : "",
                a.loaded ? "" : styles.isDown,
              )}
              title={
                a.cooldown_seconds ? `Cooldown ${a.cooldown_seconds}s · ${a.status}` : a.status
              }
            >
              <div className={styles.qaMain}>
                <span
                  className={cx(
                    styles.qaDot,
                    empty ? styles.empty : a.loaded ? styles.ok : styles.down,
                  )}
                />
                <span className={styles.qaEmail}>{accountDisplay(a)}</span>
                {!a.loaded && <span className={styles.qaTag}>unavailable</span>}
                {empty && <span className={cx(styles.qaTag, styles.empty)}>empty</span>}
              </div>
              <div className={styles.qaMeta}>
                <span title="Remaining quota for this credential">{fmtPct(rem ?? null)}</span>
                <span className={styles.qaSep}>·</span>
                <span title="Next reset">
                  {a.reset_at
                    ? new Date(a.reset_at).toLocaleString(undefined, {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                </span>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className={cx(styles.quotaAccount, styles.emptyRow, styles.quotaAddRow)}
          onClick={onAddCredentials}
        >
          <div className={styles.qaMain}>
            <span className={cx(styles.qaDot, styles.ok)} />
            <span className={styles.qaEmail}>Add account</span>
          </div>
        </button>
      </div>
    </section>
  );
}
