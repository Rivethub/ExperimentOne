import type { Account, SettingsTab, Status } from "../../lib/types";
import styles from "../../styles/app.module.css";
import { RuntimePaneInfraCards } from "./pane-infra-cards";
import { RuntimePaneWorkerCards } from "./pane-worker-cards";

export function RuntimePaneCards({
  status,
  accounts,
  apiOnline,
  lastSyncedAt,
  onCopyText,
  onOpenSettings,
  onRefresh,
}: {
  status: Status | null;
  accounts: Account[];
  apiOnline: boolean;
  lastSyncedAt: number | null;
  onCopyText: (text: string) => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onRefresh: () => void;
}): React.ReactElement {
  return (
    <div className={styles.runtimeGrid}>
      <RuntimePaneInfraCards
        status={status}
        accounts={accounts}
        apiOnline={apiOnline}
        lastSyncedAt={lastSyncedAt}
        onCopyText={onCopyText}
        onOpenSettings={onOpenSettings}
        onRefresh={onRefresh}
      />
      <RuntimePaneWorkerCards status={status} onOpenSettings={onOpenSettings} />
    </div>
  );
}
