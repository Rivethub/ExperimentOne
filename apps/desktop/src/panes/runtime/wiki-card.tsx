import { createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { formatRelativeIso } from "../../lib/format-utils";
import { fmt } from "../../lib/provider-utils";
import { isDefined } from "../../lib/nullish";
import type { SettingsTab, Status } from "../../lib/types";
import { Button } from "../../ui";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeWikiCard({
  status,
  onOpenSettings,
}: {
  status: Status | null;
  onOpenSettings: (tab: SettingsTab) => void;
}): JSX.Element {
  const on = status?.workers?.wiki === true || status?.capabilities.wiki === true;
  const model =
    isDefined(status?.wiki_model) && status.wiki_model !== ""
      ? status.wiki_model
      : "structure only";
  const cursor = status?.workers?.wiki_cursor ?? undefined;
  const foot = createMemo(
    () => (
      <Button
        onClick={() => {
          onOpenSettings("intelligence");
        }}
      >
        Configure
      </Button>
    ),
    [onOpenSettings],
  );

  return (
    <RuntimePaneCard
      title="Wiki worker"
      statusLabel={on ? "on" : "off"}
      statusTone={on ? "ok" : "default"}
      foot={foot()}
    >
      <RuntimeKv label="Pages" value={fmt(status?.workers?.wiki_pages ?? 0)} />
      <RuntimeKv label="Last run" value={formatRelativeIso(cursor)} title={cursor} />
      <RuntimeKv label="Model" value={model} />
    </RuntimePaneCard>
  );
}
