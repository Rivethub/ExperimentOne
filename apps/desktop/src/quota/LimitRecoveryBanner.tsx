import { formatCountdownTo } from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
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
}): React.ReactElement | null {
  if (!isDefined(hit)) {
    return null;
  }
  const resetNote =
    isDefined(hit.resetAt) && hit.resetAt !== ""
      ? ` · Reset in ${formatCountdownTo(hit.resetAt)} (${new Date(hit.resetAt).toLocaleString()})`
      : "";
  return (
    <div className={styles.limitRecoveryBanner} role="status">
      <div className={styles.limitRecoveryCopy}>
        <strong>{hit.windowLabel}</strong>
        <span>
          {hit.reason}
          {resetNote}
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
