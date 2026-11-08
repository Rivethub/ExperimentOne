import { isDefined } from "../lib/nullish";
import { trunc } from "../lib/traffic-utils";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function AppStatusBarMeta({
  statusAction,
  error,
  onDismissError,
}: {
  statusAction: string | null;
  error: string | null;
  onDismissError: () => void;
}): React.ReactElement | null {
  const hasAction = isDefined(statusAction) && statusAction !== "";
  const hasError = isDefined(error) && error !== "";
  if (!hasAction && !hasError) {
    return null;
  }

  return (
    <div className={styles.sbMeta}>
      {hasAction ? (
        <span className={styles.sbAction}>{statusAction}</span>
      ) : (
        <button
          type="button"
          className={cx(styles.sbAction, styles.bad)}
          onClick={onDismissError}
          title={error ?? undefined}
        >
          {trunc(error ?? "", 64)}
        </button>
      )}
    </div>
  );
}

export function AppStatusBarProxyPill({
  proxyRunning,
  proxyBaseUrl,
  onOpenRuntime,
}: {
  proxyRunning: boolean | undefined;
  proxyBaseUrl: string | undefined;
  onOpenRuntime: () => void;
}): React.ReactElement {
  const live = proxyRunning === true;
  const url = isDefined(proxyBaseUrl) && proxyBaseUrl !== "" ? proxyBaseUrl : null;

  return (
    <button type="button" className={styles.sbPill} title={url ?? "Proxy"} onClick={onOpenRuntime}>
      <span className={cx(styles.sbDot, live ? styles.on : styles.off)} />
      <span className={styles.sbFull}>proxy {live ? "live" : "stopped"}</span>
      <span className={styles.sbShort}>{live ? "proxy" : "proxy↓"}</span>
      {url !== null ? <span className={styles.sbMuted}>{url.replace("http://", "")}</span> : null}
    </button>
  );
}
