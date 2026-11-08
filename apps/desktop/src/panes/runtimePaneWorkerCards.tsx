import type { SettingsTab, Status } from "../types";
import { RuntimeVectorCard } from "./runtimeVectorCard";
import { RuntimeWikiCard } from "./runtimeWikiCard";

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
