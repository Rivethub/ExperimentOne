import type { Account, SettingsTab, Status } from "../types";
import { RuntimeMcpCard } from "./runtimeMcpCard";
import { RuntimeProxyCard } from "./runtimeProxyCard";
import { RuntimeRivetdCard } from "./runtimeRivetdCard";
import { RuntimeStoreCard } from "./runtimeStoreCard";

export function RuntimePaneInfraCards({
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
    <>
      <RuntimeProxyCard status={status} onCopyText={onCopyText} />
      <RuntimeStoreCard status={status} accounts={accounts} />
      <RuntimeMcpCard status={status} onCopyText={onCopyText} />
      <RuntimeRivetdCard
        status={status}
        apiOnline={apiOnline}
        lastSyncedAt={lastSyncedAt}
        onOpenSettings={onOpenSettings}
        onRefresh={onRefresh}
      />
    </>
  );
}
