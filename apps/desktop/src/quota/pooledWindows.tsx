import { useMemo } from "react";
import { fmtPct } from "../providerUtils";
import type { QuotaAccountUx } from "./types";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

function accountDisplay(a: QuotaAccountUx) {
  return a.email || a.label || a.id;
}

export function distinctWindowIds(accounts: QuotaAccountUx[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const a of accounts) {
    for (const w of a.windows ?? []) {
      if (!seen.has(w.id)) seen.set(w.id, w.label || w.id);
    }
  }
  if (seen.size === 0) {
    seen.set("primary", "Primary limit");
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

function windowForAccount(
  a: QuotaAccountUx,
  windowId: string,
): { id: string; label: string; remaining_pct?: number | null; reset_at?: string | null } | null {
  const w = (a.windows ?? []).find((x) => x.id === windowId);
  if (w) return w;
  if (windowId === "primary") {
    return {
      id: "primary",
      label: "Primary limit",
      remaining_pct: a.remaining_pct,
      reset_at: a.reset_at,
    };
  }
  return null;
}

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
}) {
  return (
    <div className={styles.poolWindowBar} role="group" aria-label="Account limit segments">
      {accounts.map((a) => {
        const w = windowForAccount(a, windowId);
        const rem = w?.remaining_pct;
        const has = rem != null && Number.isFinite(rem);
        const remaining = has ? Math.max(0, Math.min(100, rem)) : 0;
        const used = has ? 100 - remaining : 100;
        const empty = has && remaining <= 0.5;
        return (
          <button
            key={a.id}
            type="button"
            className={cx(
              styles.poolSeg,
              empty ? styles.isEmpty : "",
              a.loaded ? "" : styles.isDown,
            )}
            title={`${accountDisplay(a)} · ${fmtPct(rem ?? null)} remaining`}
            onClick={() => onSelect(a)}
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
}) {
  const windows = distinctWindowIds(accounts);
  const ordered = useMemo(() => [...accounts].sort((a, b) => a.id.localeCompare(b.id)), [accounts]);

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
                  {accountDisplay(a)} {fmtPct(w?.remaining_pct ?? null)}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
