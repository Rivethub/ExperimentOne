import { useMemo, type ReactElement } from "react";
import { accountDisplay } from "../formatUtils";
import { fmtPct } from "../providerUtils";
import { isDefined } from "../nullish";
import type { QuotaAccount } from "../types";
import { Button } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function QuotaProviderCardEmpty({
  name,
  ico,
  icoClass,
  onAddCredentials,
}: {
  name: string;
  ico: string;
  icoClass: "claude" | "codex" | "generic";
  onAddCredentials: () => void;
}): ReactElement {
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

function formatResetAt(resetAt: string | null | undefined): string {
  if (!isDefined(resetAt) || resetAt === "") {
    return "—";
  }
  return new Date(resetAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function quotaDotClass(empty: boolean, loaded: boolean): string {
  if (empty) {
    return styles.empty ?? "";
  }
  if (loaded) {
    return styles.ok ?? "";
  }
  return styles.down ?? "";
}

function accountRowTitle(a: QuotaAccount): string {
  if (isDefined(a.cooldown_seconds) && a.cooldown_seconds > 0) {
    return `Cooldown ${a.cooldown_seconds}s · ${a.status}`;
  }
  return a.status;
}

export function QuotaProviderAccountList({
  accounts,
  onAddCredentials,
}: {
  accounts: QuotaAccount[];
  onAddCredentials: () => void;
}): ReactElement {
  const rows = useMemo(
    () =>
      accounts.map((a) => {
        const rem = a.remaining_pct;
        const hasRem = isDefined(rem) && Number.isFinite(rem);
        const empty = hasRem && rem <= 0.5;
        return { a, rem, empty };
      }),
    [accounts],
  );

  return (
    <div className={styles.quotaAccounts}>
      {rows.map(({ a, rem, empty }) => (
        <div
          key={a.id}
          className={cx(
            styles.quotaAccount,
            empty ? styles.isEmpty : "",
            a.loaded ? "" : styles.isDown,
          )}
          title={accountRowTitle(a)}
        >
          <div className={styles.qaMain}>
            <span className={cx(styles.qaDot, quotaDotClass(empty, a.loaded))} />
            <span className={styles.qaEmail}>{accountDisplay(a)}</span>
            {!a.loaded && <span className={styles.qaTag}>unavailable</span>}
            {empty && <span className={cx(styles.qaTag, styles.empty)}>empty</span>}
          </div>
          <div className={styles.qaMeta}>
            <span title="Remaining quota for this credential">{fmtPct(rem ?? null)}</span>
            <span className={styles.qaSep}>·</span>
            <span title="Next reset">{formatResetAt(a.reset_at)}</span>
          </div>
        </div>
      ))}
      <button
        type="button"
        className={cx(styles.quotaAccount, styles.emptyRow, styles.quotaAddRow)}
        onClick={onAddCredentials}
        aria-label="Add account"
      >
        <div className={styles.qaMain}>
          <span className={cx(styles.qaDot, styles.ok)} />
          <span className={styles.qaEmail}>Add account</span>
        </div>
      </button>
    </div>
  );
}
