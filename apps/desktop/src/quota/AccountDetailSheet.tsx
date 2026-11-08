import {
  fmtPct,
  formatCountdownTo,
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import type { QuotaAccountUx } from "./types";
import { Button, Kv, KvRow } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

function accountDisplay(a: QuotaAccountUx): string {
  if (isDefined(a.email) && a.email !== "") {
    return a.email;
  }
  return a.label;
}

export function AccountDetailSheet({
  account,
  catalog,
  onClose,
}: {
  account: QuotaAccountUx | null;
  catalog: CatalogProvider[];
  onClose: () => void;
}): React.ReactElement | null {
  if (!isDefined(account)) {
    return null;
  }
  const id = providerKey(account.provider);
  const color = providerColor(id, catalog);
  const windows =
    account.windows.length > 0
      ? account.windows
      : [
          {
            id: "primary",
            label: "Primary limit",
            remaining_pct: account.remaining_pct,
            reset_at: account.reset_at,
          },
        ];
  return (
    <>
      <div className={styles.sheetBackdrop} onClick={onClose} role="presentation" />
      <aside className={styles.accountSheet} aria-label="Account details">
        <header className={styles.accountSheetHead}>
          <div className={styles.cardTitle}>
            <div
              className={cx(styles.providerIco, styles.generic)}
              style={{ background: `${color}22`, color }}
            >
              {providerChipLabel(id, catalog).slice(0, 1)}
            </div>
            <div>
              <h3>{accountDisplay(account)}</h3>
              <div className={styles.meta}>
                {providerChipLabel(id, catalog)}
                {isDefined(account.plan) && account.plan !== "" ? ` · ${account.plan}` : ""}
              </div>
            </div>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        <div>
          <Kv>
            <KvRow label="Remaining" value={fmtPct(account.remaining_pct ?? null)} />
            <KvRow label="Status" value={account.status} />
            <KvRow
              label="Next reset"
              value={
                isDefined(account.reset_at) && account.reset_at !== ""
                  ? new Date(account.reset_at).toLocaleString()
                  : "—"
              }
            />
            {isDefined(account.cooldown_seconds) && account.cooldown_seconds > 0 && (
              <KvRow label="Cooldown" value={`${account.cooldown_seconds}s`} />
            )}
          </Kv>
          {windows.map((w) => (
            <div key={w.id} className={styles.sheetWindow}>
              <strong>{w.label}</strong>
              <div className={styles.meta}>
                {fmtPct(w.remaining_pct ?? null)} · reset{" "}
                {isDefined(w.reset_at) && w.reset_at !== "" ? formatCountdownTo(w.reset_at) : "—"}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
