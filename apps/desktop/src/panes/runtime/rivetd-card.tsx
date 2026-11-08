import { useMemo } from "react";
import { formatSynced } from "../../lib/format-utils";
import type { SettingsTab, Status } from "../../lib/types";
import { Button } from "../../ui";
import styles from "../../styles/app.module.css";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeRivetdCard({
  status,
  apiOnline,
  lastSyncedAt,
  onOpenSettings,
  onRefresh,
}: {
  status: Status | null;
  apiOnline: boolean;
  lastSyncedAt: number | null;
  onOpenSettings: (tab: SettingsTab) => void;
  onRefresh: () => void;
}): React.ReactElement {
  const foot = useMemo(
    () => (
      <>
        <Button onClick={onRefresh}>Sync now</Button>
        <Button
          onClick={() => {
            onOpenSettings("accounts");
          }}
        >
          Accounts
        </Button>
      </>
    ),
    [onOpenSettings, onRefresh],
  );

  return (
    <RuntimePaneCard
      title="rivetd"
      statusLabel={apiOnline ? "online" : "offline"}
      statusClass={apiOnline ? (styles.ok ?? "") : (styles.bad ?? "")}
      foot={foot}
    >
      <RuntimeKv label="Synced" value={formatSynced(lastSyncedAt)} />
      <RuntimeKv
        label="Wiki path"
        value={status?.wiki_dir ?? "—"}
        title={status?.wiki_dir ?? undefined}
      />
    </RuntimePaneCard>
  );
}
