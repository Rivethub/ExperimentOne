import { useMemo, type ReactElement } from "react";
import { fmtPct } from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import type { QuotaAccountUx } from "./types";
import {
  distinctWindowIds,
  finiteRemaining,
  pooledAccountDisplay,
  sortAccountsById,
  windowForAccount,
} from "./pooled-window-ids";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

function SegmentBar({
  accounts,
  windowId,
  color,
  onSelect,
}: {
  accounts: QuotaAccountUx[];
  windowId: string;
  color: string;
  onSelect: (a: QuotaAccountUx) => void;
}): ReactElement {
  return (
    <div className={styles.poolWindowBar} role="group" aria-label="Account limit segments">
      {accounts.map((a) => {
        const w = windowForAccount(a, windowId);
        const rem = w?.remaining_pct;
        const has = finiteRemaining(rem);
        const remaining = has && isDefined(rem) ? Math.max(0, Math.min(100, rem)) : 0;
        const used = has ? 100 - remaining : 100;
        const empty = has && remaining <= 0.5;
        const label = `${pooledAccountDisplay(a)} · ${fmtPct(rem ?? null)} remaining`;
        return (
          <button
            key={a.id}
            type="button"
            className={cx(
              styles.poolSeg,
              empty ? styles.isEmpty : "",
              a.loaded ? "" : styles.isDown,
            )}
            title={label}
            aria-label={label}
            onClick={() => {
              onSelect(a);
            }}
          >
            <div className={styles.poolSegFill} style={{ flexGrow: Math.max(0.05, remaining) }}>
              <span className={styles.poolSegRemain} style={{ background: color }} />
            </div>
            <div
              className={styles.poolSegHatch}
              style={{ flexGrow: Math.max(0.05, used) }}
              title="Used until reset restores"
            />
          </button>
        );
      })}
    </div>
  );
}

export function PooledWindowCards({
  accounts,
  color,
  onAccountSelect,
}: {
  accounts: QuotaAccountUx[];
  color: string;
  onAccountSelect: (a: QuotaAccountUx) => void;
}): ReactElement {
  const windows = distinctWindowIds(accounts);
  const ordered = useMemo(() => sortAccountsById(accounts), [accounts]);

  return (
    <div className={styles.poolWindows}>
      {windows.map((win) => (
        <div key={win.id} className={styles.poolWindowCard}>
          <div className={styles.poolWindowHead}>
            <span className={styles.poolWindowLabel}>{win.label}</span>
            <span className={styles.poolWindowHint}>
              Segments = accounts (fixed order) · hatch = used until reset
            </span>
          </div>
          <SegmentBar
            accounts={ordered}
            windowId={win.id}
            color={color}
            onSelect={onAccountSelect}
          />
          <div className={styles.poolWindowLegend}>
            {ordered.map((a) => {
              const w = windowForAccount(a, win.id);
              return (
                <span key={a.id} className={styles.poolLegendItem}>
                  <span className={cx(styles.qaDot, styles.ok)} style={{ background: color }} />
                  {pooledAccountDisplay(a)} {fmtPct(w?.remaining_pct ?? null)}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
