import { fmt } from "../providerUtils";
import { trunc } from "../trafficUtils";
import type { Status } from "../types";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export type AppStatusBarProps = {
  syncing: boolean;
  onSync: () => void;
  accountCount: number;
  status: Status | null;
  apiOnline: boolean;
  onOpenRuntime: () => void;
  statusAction: string | null;
  error: string | null;
  onDismissError: () => void;
};

export function AppStatusBar({
  syncing,
  onSync,
  accountCount,
  status,
  apiOnline,
  onOpenRuntime,
  statusAction,
  error,
  onDismissError,
}: AppStatusBarProps) {
  return (
    <footer className={styles.statusbar} aria-label="Server status">
      <div className={styles.sbGroup}>
        <button
          type="button"
          className={cx(styles.sbSync, syncing ? styles.spinning : "")}
          disabled={syncing}
          onClick={onSync}
          title="Sync status"
          aria-label="Sync status"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 3v5h-5"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 16H3v5"
            />
          </svg>
        </button>
        <span className={styles.sbCounts} title="Accounts · events · wiki pages · embeddings">
          <span>
            {accountCount} acct{accountCount === 1 ? "" : "s"}
          </span>
          <span>{fmt(status?.usage.events ?? 0)} events</span>
          <span>{status?.workers?.wiki_pages ?? 0} wiki</span>
          <span>{status?.workers?.embeddings ?? 0} vec</span>
        </span>
        <button
          type="button"
          className={styles.sbPill}
          title={apiOnline ? "rivetd control plane reachable" : "rivetd unreachable"}
          onClick={onOpenRuntime}
        >
          <span className={cx(styles.sbDot, apiOnline ? styles.on : styles.off)} />
          <span className={styles.sbFull}>rivetd {apiOnline ? "online" : "offline"}</span>
          <span className={styles.sbShort}>{apiOnline ? "api" : "api↓"}</span>
        </button>
        <button
          type="button"
          className={styles.sbPill}
          title={status?.proxy_base_url ?? "Proxy"}
          onClick={onOpenRuntime}
        >
          <span className={cx(styles.sbDot, status?.proxy_running ? styles.on : styles.off)} />
          <span className={styles.sbFull}>proxy {status?.proxy_running ? "live" : "stopped"}</span>
          <span className={styles.sbShort}>{status?.proxy_running ? "proxy" : "proxy↓"}</span>
          {status?.proxy_base_url ? (
            <span className={styles.sbMuted}>{status.proxy_base_url.replace("http://", "")}</span>
          ) : null}
        </button>
        <span
          className={cx(styles.sbPill, styles.static, styles.sbBackend)}
          title="Traffic store backend"
        >
          <span className={cx(styles.sbDot, styles.on)} />
          <span className={styles.sbFull}>{status?.traffic_backend ?? "clickhouse"}</span>
          <span className={styles.sbShort}>ch</span>
        </span>
      </div>

      {(statusAction || error) && (
        <div className={styles.sbMeta}>
          {statusAction ? (
            <span className={styles.sbAction}>{statusAction}</span>
          ) : (
            <button
              type="button"
              className={cx(styles.sbAction, styles.bad)}
              onClick={onDismissError}
              title={error!}
            >
              {trunc(error!, 64)}
            </button>
          )}
        </div>
      )}
    </footer>
  );
}
