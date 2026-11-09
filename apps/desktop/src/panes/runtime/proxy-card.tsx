import { createMemo } from "solid-js";
import type { JSX } from "solid-js";
import type { Status } from "../../lib/types";
import { Button } from "../../ui";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeProxyCard({
  status,
  onCopyText,
}: {
  status: Status | null;
  onCopyText: (text: string) => void;
}): JSX.Element {
  const live = status?.proxy_running === true;
  const foot = createMemo(
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
      statusTone={live ? "ok" : "bad"}
      foot={foot()}
    >
      <RuntimeKv label="Base URL" value={status?.proxy_base_url ?? "—"} />
      <RuntimeKv label="Access key" value={status?.access_key_hint ?? "—"} />
    </RuntimePaneCard>
  );
}
