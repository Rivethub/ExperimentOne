import { formatCountdownTo } from "../providerUtils";
import type { LimitHitInfo } from "./types";
import { Button } from "../ui";
import styles from "../styles/app.module.css";

export function LimitRecoveryBanner({
  hit,
  onRefreshCredentials,
  onSwitchAccount,
  onWait,
}: {
  hit: LimitHitInfo | null;
  onRefreshCredentials: () => void;
  onSwitchAccount: () => void;
  onWait: () => void;
}) {
  if (!hit) return null;
  return (
    <div className={styles.limitRecoveryBanner} role="status">
      <div className={styles.limitRecoveryCopy}>
        <strong>{hit.windowLabel}</strong>
        <span>
          {hit.reason}
          {hit.resetAt
            ? ` · Reset in ${formatCountdownTo(hit.resetAt)} (${new Date(hit.resetAt).toLocaleString()})`
            : ""}
        </span>
      </div>
      <div className={styles.limitRecoveryActions}>
        <Button onClick={onRefreshCredentials}>Refresh credentials</Button>
        <Button onClick={onSwitchAccount}>Switch account</Button>
        <Button variant="ghost" onClick={onWait}>
          Wait
        </Button>
      </div>
    </div>
  );
}
