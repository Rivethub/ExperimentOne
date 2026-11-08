import type { ReactElement } from "react";
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

function RuntimeLogPane({ title, body }: { title: string; body: string }): ReactElement {
  const text = body !== "" ? body : `No ${title.toLowerCase()} yet.`;
  return (
    <Panel className="mb-0 min-h-[220px] rounded-[14px] bg-[#101014] py-3" title={title}>
      <Snippet className="mt-0 max-h-[280px] flex-1">{text}</Snippet>
    </Panel>
  );
}

export function RuntimePane({
  status,
  accounts,
  apiOnline,
  lastSyncedAt,
  proxyLog,
  chLog,
  onCopyText,
  onOpenSettings,
  onRefresh,
  onLoadLogs,
}: RuntimePaneProps): ReactElement {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex-1 overflow-auto px-6 py-4 pb-9"
        style={{
          background:
            "radial-gradient(ellipse 70% 40% at 10% -10%, rgba(52, 211, 153, 0.06), transparent 50%), #0b0b0d",
        }}
      >
        <RuntimePaneCards
          status={status}
          accounts={accounts}
          apiOnline={apiOnline}
          lastSyncedAt={lastSyncedAt}
          onCopyText={onCopyText}
          onOpenSettings={onOpenSettings}
          onRefresh={onRefresh}
        />
        <div className="mt-4.5 flex items-center justify-between gap-3">
          <h2 className="m-0 text-sm font-semibold tracking-tight">Logs</h2>
          <Button variant="ghost" onClick={onLoadLogs}>
            Refresh logs
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <RuntimeLogPane title="Proxy log" body={proxyLog} />
          <RuntimeLogPane title="ClickHouse log" body={chLog} />
        </div>
      </div>
    </div>
  );
}
