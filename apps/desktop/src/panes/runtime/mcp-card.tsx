import { useMemo } from "react";
import type { Status } from "../../lib/types";
import { Button } from "../../ui";
import styles from "../../styles/app.module.css";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeMcpCard({
  status,
  onCopyText,
}: {
  status: Status | null;
  onCopyText: (text: string) => void;
}): React.ReactElement {
  const enabled = status?.capabilities.mcp === true;
  const foot = useMemo(
    () => (
      <Button
        onClick={() => {
          onCopyText(status?.mcp_url ?? "");
        }}
      >
        Copy MCP URL
      </Button>
    ),
    [onCopyText, status?.mcp_url],
  );
  return (
    <RuntimePaneCard
      title="MCP"
      statusLabel={enabled ? "enabled" : "off"}
      statusClass={enabled ? (styles.ok ?? "") : ""}
      foot={foot}
    >
      <RuntimeKv label="Endpoint" value={status?.mcp_url ?? "—"} />
    </RuntimePaneCard>
  );
}
