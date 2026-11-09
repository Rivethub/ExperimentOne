import type { JSX } from "solid-js";
import type { Account, SettingsTab, Status } from "../lib/types";
import { Button, Panel, Snippet } from "../ui";
import { RuntimePaneCards } from "./runtime/pane-cards";

export type RuntimePaneProps = {
  status: Status | null;
  accounts: Account[];
  apiOnline: boolean;
  lastSyncedAt: number | null;
  proxyLog: string;
  chLog: string;
  onCopyText: (text: string) => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onRefresh: () => void;
  onLoadLogs: () => void;
};

function RuntimeLogPane(props: { title: string; body: string }): JSX.Element {
  const text = () => (props.body !== "" ? props.body : `No ${props.title.toLowerCase()} yet.`);
  return (
    <Panel class="bg-card mb-0 min-h-[220px] py-3 shadow-none" title={props.title}>
      <Snippet class="mt-0 max-h-[280px] flex-1">{text()}</Snippet>
    </Panel>
  );
}

export function RuntimePane(props: RuntimePaneProps): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="bg-background flex-1 overflow-auto px-4 py-4 pb-9 md:px-6">
        <RuntimePaneCards
          status={props.status}
          accounts={props.accounts}
          apiOnline={props.apiOnline}
          lastSyncedAt={props.lastSyncedAt}
          onCopyText={props.onCopyText}
          onOpenSettings={props.onOpenSettings}
          onRefresh={props.onRefresh}
        />
        <div class="mt-4.5 flex items-center justify-between gap-3">
          <h2 class="m-0 text-sm font-semibold tracking-tight">Logs</h2>
          <Button variant="ghost" onClick={() => props.onLoadLogs()}>
            Refresh logs
          </Button>
        </div>
        <div class="mt-2 grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <RuntimeLogPane title="Proxy log" body={props.proxyLog} />
          <RuntimeLogPane title="ClickHouse log" body={props.chLog} />
        </div>
      </div>
    </div>
  );
}
