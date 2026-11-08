import { fmt } from "../../lib/provider-utils";
import type { Account, Status } from "../../lib/types";
import styles from "../../styles/app.module.css";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeStoreCard({
  status,
  accounts,
}: {
  status: Status | null;
  accounts: Account[];
}): React.ReactElement {
  return (
    <RuntimePaneCard
      title="Store"
      statusLabel={status?.traffic_backend ?? "clickhouse"}
      statusClass={styles.ok ?? ""}
    >
      <RuntimeKv label="Events" value={fmt(status?.usage.events ?? 0)} />
      <RuntimeKv
        label="Tokens"
        value={`${fmt(status?.usage.tokens_in ?? 0)} in · ${fmt(status?.usage.tokens_out ?? 0)} out`}
      />
      <RuntimeKv label="Accounts" value={fmt(status?.account_count ?? accounts.length)} />
    </RuntimePaneCard>
  );
}
