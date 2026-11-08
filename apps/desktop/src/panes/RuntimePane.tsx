import { formatRelativeIso, formatSynced } from "../formatUtils";
import { fmt } from "../providerUtils";
import type { Account, SettingsTab, Status } from "../types";
import { Button } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export type RuntimePaneProps = {
  active: boolean;
  status: Status | null;
  accounts: Account[];
  apiOnline: boolean;
  lastSyncedAt: number | null;
  proxyLog: string;
  chLog: string;
  onCopyText: (text: string) => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onRefresh: () => void;
  onLoadLogs: () => void;
};

export function RuntimePane({
  active,
  status,
  accounts,
  apiOnline,
  lastSyncedAt,
  proxyLog,
  chLog,
  onCopyText,
  onOpenSettings,
  onRefresh,
  onLoadLogs,
}: RuntimePaneProps) {
  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <div className={styles.runtime}>
        <div className={styles.runtimeGrid}>
          <div className={styles.runtimeCard}>
            <div className={styles.runtimeCardHead}>
              <span>Proxy</span>
              <span className={cx(styles.pill, status?.proxy_running ? styles.ok : styles.bad)}>
                {status?.proxy_running ? "live" : "stopped"}
              </span>
            </div>
            <div className={styles.runtimeCardBody}>
              <div className={styles.kvRow}>
                <span className={styles.k}>Base URL</span>
                <span className={styles.v}>{status?.proxy_base_url ?? "—"}</span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Access key</span>
                <span className={styles.v}>{status?.access_key_hint ?? "—"}</span>
              </div>
            </div>
            <div className={styles.runtimeCardFoot}>
              <Button onClick={() => onCopyText(status?.proxy_base_url ?? "")}>
                Copy URL
              </Button>
            </div>
          </div>

          <div className={styles.runtimeCard}>
            <div className={styles.runtimeCardHead}>
              <span>Store</span>
              <span className={cx(styles.pill, styles.ok)}>
                {status?.traffic_backend ?? "clickhouse"}
              </span>
            </div>
            <div className={styles.runtimeCardBody}>
              <div className={styles.kvRow}>
                <span className={styles.k}>Events</span>
                <span className={styles.v}>{fmt(status?.usage.events ?? 0)}</span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Tokens</span>
                <span className={styles.v}>
                  {fmt(status?.usage.tokens_in ?? 0)} in · {fmt(status?.usage.tokens_out ?? 0)} out
                </span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Accounts</span>
                <span className={styles.v}>{fmt(status?.account_count ?? accounts.length)}</span>
              </div>
            </div>
          </div>

          <div className={styles.runtimeCard}>
            <div className={styles.runtimeCardHead}>
              <span>MCP</span>
              <span className={cx(styles.pill, status?.capabilities.mcp ? styles.ok : "")}>
                {status?.capabilities.mcp ? "enabled" : "off"}
              </span>
            </div>
            <div className={styles.runtimeCardBody}>
              <div className={styles.kvRow}>
                <span className={styles.k}>Endpoint</span>
                <span className={styles.v}>{status?.mcp_url ?? "—"}</span>
              </div>
            </div>
            <div className={styles.runtimeCardFoot}>
              <Button onClick={() => onCopyText(status?.mcp_url ?? "")}>
                Copy MCP URL
              </Button>
            </div>
          </div>

          <div className={styles.runtimeCard}>
            <div className={styles.runtimeCardHead}>
              <span>Vector worker</span>
              <span
                className={cx(
                  styles.pill,
                  status?.workers?.vector_search || status?.capabilities.vector_search
                    ? styles.ok
                    : "",
                )}
              >
                {status?.workers?.vector_search || status?.capabilities.vector_search
                  ? "on"
                  : "off"}
              </span>
            </div>
            <div className={styles.runtimeCardBody}>
              <div className={styles.kvRow}>
                <span className={styles.k}>Embeddings</span>
                <span className={styles.v}>{fmt(status?.workers?.embeddings ?? 0)}</span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Last run</span>
                <span className={styles.v} title={status?.workers?.vectorize_cursor ?? undefined}>
                  {formatRelativeIso(status?.workers?.vectorize_cursor)}
                </span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Model</span>
                <span className={styles.v}>{status?.embedding_model || "lexical (v1)"}</span>
              </div>
            </div>
          </div>

          <div className={styles.runtimeCard}>
            <div className={styles.runtimeCardHead}>
              <span>Wiki worker</span>
              <span
                className={cx(
                  styles.pill,
                  status?.workers?.wiki || status?.capabilities.wiki ? styles.ok : "",
                )}
              >
                {status?.workers?.wiki || status?.capabilities.wiki ? "on" : "off"}
              </span>
            </div>
            <div className={styles.runtimeCardBody}>
              <div className={styles.kvRow}>
                <span className={styles.k}>Pages</span>
                <span className={styles.v}>{fmt(status?.workers?.wiki_pages ?? 0)}</span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Last run</span>
                <span className={styles.v} title={status?.workers?.wiki_cursor ?? undefined}>
                  {formatRelativeIso(status?.workers?.wiki_cursor)}
                </span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Model</span>
                <span className={styles.v}>{status?.wiki_model || "structure only"}</span>
              </div>
            </div>
            <div className={styles.runtimeCardFoot}>
              <Button onClick={() => onOpenSettings("intelligence")}>
                Configure
              </Button>
            </div>
          </div>

          <div className={styles.runtimeCard}>
            <div className={styles.runtimeCardHead}>
              <span>rivetd</span>
              <span className={cx(styles.pill, apiOnline ? styles.ok : styles.bad)}>
                {apiOnline ? "online" : "offline"}
              </span>
            </div>
            <div className={styles.runtimeCardBody}>
              <div className={styles.kvRow}>
                <span className={styles.k}>Synced</span>
                <span className={styles.v}>{formatSynced(lastSyncedAt)}</span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.k}>Wiki path</span>
                <span className={styles.v} title={status?.wiki_dir ?? undefined}>
                  {status?.wiki_dir ?? "—"}
                </span>
              </div>
            </div>
            <div className={styles.runtimeCardFoot}>
              <Button onClick={onRefresh}>
                Sync now
              </Button>
              <Button onClick={() => onOpenSettings("accounts")}>
                Accounts
              </Button>
            </div>
          </div>
        </div>

        <div className={styles.runtimeLogs}>
          <div className={styles.runtimeLogPane}>
            <div className={styles.runtimeCardHead}>
              <span>Proxy log</span>
              <Button variant="ghost" onClick={onLoadLogs}>
                Refresh
              </Button>
            </div>
            <pre className={styles.snippet}>{proxyLog || "No proxy log yet."}</pre>
          </div>
          <div className={styles.runtimeLogPane}>
            <div className={styles.runtimeCardHead}>
              <span>ClickHouse log</span>
              <Button variant="ghost" onClick={onLoadLogs}>
                Refresh
              </Button>
            </div>
            <pre className={styles.snippet}>{chLog || "No ClickHouse log yet."}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
