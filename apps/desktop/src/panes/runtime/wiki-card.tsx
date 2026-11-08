import { useMemo } from "react";
import { formatRelativeIso } from "../../lib/format-utils";
import { fmt } from "../../lib/provider-utils";
import { isDefined } from "../../lib/nullish";
import type { SettingsTab, Status } from "../../lib/types";
import { Button } from "../../ui";
import styles from "../../styles/app.module.css";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeWikiCard({
  status,
  onOpenSettings,
}: {
  status: Status | null;
  onOpenSettings: (tab: SettingsTab) => void;
}): React.ReactElement {
  const on = status?.workers?.wiki === true || status?.capabilities.wiki === true;
  const model =
    isDefined(status?.wiki_model) && status.wiki_model !== "" ? status.wiki_model : "structure only";
  const cursor = status?.workers?.wiki_cursor ?? undefined;
  const foot = useMemo(
    () => <Button onClick={() => { onOpenSettings("intelligence"); }}>Configure</Button>,
    [onOpenSettings],
  );

  return (
    <RuntimePaneCard
      title="Wiki worker"
      statusLabel={on ? "on" : "off"}
      statusClass={on ? (styles.ok ?? "") : ""}
      foot={foot}
    >
      <RuntimeKv label="Pages" value={fmt(status?.workers?.wiki_pages ?? 0)} />
      <RuntimeKv label="Last run" value={formatRelativeIso(cursor)} title={cursor} />
      <RuntimeKv label="Model" value={model} />
    </RuntimePaneCard>
  );
}
