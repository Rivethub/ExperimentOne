import { createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { formatSynced } from "../../lib/format-utils";
import type { SettingsTab, Status } from "../../lib/types";
import { Button } from "../../ui";
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
}): JSX.Element {
  const foot = createMemo(
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
      statusTone={apiOnline ? "ok" : "bad"}
      foot={foot()}
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
