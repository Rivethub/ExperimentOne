import { useMemo } from "react";
import type { Status } from "../../lib/types";
import { Button } from "../../ui";
import styles from "../../styles/app.module.css";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeProxyCard({
  status,
  onCopyText,
}: {
  status: Status | null;
  onCopyText: (text: string) => void;
}): React.ReactElement {
  const live = status?.proxy_running === true;
  const foot = useMemo(
    () => (
      <Button
        onClick={() => {
          onCopyText(status?.proxy_base_url ?? "");
        }}
      >
        Copy URL
      </Button>
    ),
    [onCopyText, status?.proxy_base_url],
  );
  return (
    <RuntimePaneCard
      title="Proxy"
      statusLabel={live ? "live" : "stopped"}
      statusClass={live ? (styles.ok ?? "") : (styles.bad ?? "")}
      foot={foot}
    >
      <RuntimeKv label="Base URL" value={status?.proxy_base_url ?? "—"} />
      <RuntimeKv label="Access key" value={status?.access_key_hint ?? "—"} />
    </RuntimePaneCard>
  );
}
