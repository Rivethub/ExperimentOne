import type { JSX } from "solid-js";
import type { Account, SettingsTab, Status } from "../../lib/types";
import { RuntimeMcpCard } from "./mcp-card";
import { RuntimeProxyCard } from "./proxy-card";
import { RuntimeRivetdCard } from "./rivetd-card";
import { RuntimeStoreCard } from "./store-card";

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
}): JSX.Element {
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
