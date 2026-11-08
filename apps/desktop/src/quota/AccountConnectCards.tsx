import {
  fmtPct,
  formatCountdownTo,
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "../providerUtils";
import type { QuotaAccountUx } from "./types";
import { Button, Empty } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

type AccountRow = {
  id: string;
  provider: string;
  label: string;
};

export function AccountConnectCards({
  accounts,
  quotaById,
  catalog,
  busy,
  loginActive,
  onReconnect,
  onRemove,
  onOpenHarness,
}: {
  accounts: AccountRow[];
  quotaById: Map<string, QuotaAccountUx>;
  catalog: CatalogProvider[];
  busy: boolean;
  loginActive: boolean;
  onReconnect: (provider: string) => void;
  onRemove: (id: string) => void;
  onOpenHarness?: () => void;
}) {
  if (accounts.length === 0) {
    return <Empty>No accounts yet — use Add account to sign in.</Empty>;
  }

  return (
    <div className={styles.connectCardGrid}>
      {accounts.map((a) => {
        const q = quotaById.get(a.id);
        const id = providerKey(a.provider);
        const color = providerColor(id, catalog);
        const showHarness = (id === "claude" || id === "codex") && !!onOpenHarness;
        return (
          <article key={a.id} className={styles.connectCard} style={{ borderColor: `${color}44` }}>
            <header className={styles.connectCardHead} style={{ borderColor: `${color}33` }}>
              <span className={styles.providerIco} style={{ background: `${color}22`, color }}>
                {providerChipLabel(id, catalog).slice(0, 1)}
              </span>
              <div>
                <strong>{providerChipLabel(id, catalog)}</strong>
                <div className={styles.meta}>{q?.plan ?? "Plan unknown"}</div>
              </div>
            </header>
            <div className={styles.connectCardBody}>
              <div className={styles.connectEmail}>{q?.email || q?.label || a.label}</div>
              <div className={styles.connectRemaining}>
                {fmtPct(q?.remaining_pct ?? null)} remaining
                {q?.reset_at ? ` · reset ${formatCountdownTo(q.reset_at)}` : ""}
              </div>
              <div className={cx(styles.mono, styles.accountLimit)}>
                {a.label !== (q?.email || q?.label) ? a.label : ""}
              </div>
            </div>
            <footer className={styles.connectCardActions}>
              {showHarness && (
                <Button variant="link" onClick={onOpenHarness}>
                  Harness setup
                </Button>
              )}
              <Button disabled={busy || loginActive} onClick={() => onReconnect(id)}>
                Reconnect
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                title="Deletes the local credential file (DELETE /v1/accounts)"
                onClick={() => onRemove(a.id)}
              >
                Remove
              </Button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
