import type { ReactElement } from "react";
import type { Account, SettingsTab, Status } from "../types";
import { Button } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";
import { RuntimePaneCards } from "./runtimePaneCards";

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

function RuntimeLogPane({
  title,
  body,
  onRefresh,
}: {
  title: string;
  body: string;
  onRefresh: () => void;
}): ReactElement {
  const text = body !== "" ? body : `No ${title.toLowerCase()} yet.`;
  return (
    <div className={styles.runtimeLogPane}>
      <div className={styles.runtimeCardHead}>
        <span>{title}</span>
        <Button variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      <pre className={styles.snippet}>{text}</pre>
    </div>
  );
}

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
}: RuntimePaneProps): ReactElement {
  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <div className={styles.runtime}>
        <RuntimePaneCards
          status={status}
          accounts={accounts}
          apiOnline={apiOnline}
          lastSyncedAt={lastSyncedAt}
          onCopyText={onCopyText}
          onOpenSettings={onOpenSettings}
          onRefresh={onRefresh}
        />
        <div className={styles.runtimeLogs}>
          <RuntimeLogPane title="Proxy log" body={proxyLog} onRefresh={onLoadLogs} />
          <RuntimeLogPane title="ClickHouse log" body={chLog} onRefresh={onLoadLogs} />
        </div>
      </div>
    </div>
  );
}
