import type { Account, SettingsTab, Status } from "../../lib/types";
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
    <div className="mb-4.5 grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
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
