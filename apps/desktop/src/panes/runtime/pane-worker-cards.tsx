import type { SettingsTab, Status } from "../../lib/types";
import { RuntimeVectorCard } from "./vector-card";
import { RuntimeWikiCard } from "./wiki-card";

export function RuntimePaneWorkerCards({
  status,
  onOpenSettings,
}: {
  status: Status | null;
  onOpenSettings: (tab: SettingsTab) => void;
}): React.ReactElement {
  return (
    <>
      <RuntimeVectorCard status={status} />
      <RuntimeWikiCard status={status} onOpenSettings={onOpenSettings} />
    </>
  );
}
