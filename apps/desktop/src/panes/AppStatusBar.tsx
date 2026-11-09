import { RefreshCw } from "lucide-react";
import { cn } from "#lib/utils";
import { fmt } from "../lib/provider-utils";
import type { Status } from "../lib/types";
import { AppStatusBarProxyPill } from "./app-status-bar-meta";

export type AppStatusBarProps = {
  syncing: boolean;
  onSync: () => void;
  accountCount: number;
  status: Status | null;
  apiOnline: boolean;
  onOpenRuntime: () => void;
};

function StatusBarSyncButton({
  syncing,
  onSync,
}: {
  syncing: boolean;
  onSync: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={cn(
        "m-0 inline-flex shrink-0 items-center justify-center rounded-none border-0 bg-transparent p-0.5 leading-none text-muted-foreground/80 opacity-85 hover:bg-accent hover:text-foreground hover:opacity-100 disabled:opacity-65",
        syncing && "text-foreground opacity-100",
      )}
      disabled={syncing}
      onClick={onSync}
      title="Sync status"
      aria-label="Sync status"
    >
      <RefreshCw
        size={12}
        strokeWidth={1.75}
        aria-hidden
        className={cn(syncing && "animate-spin")}
      />
    </button>
  );
}

export function AppStatusBar({
  syncing,
  onSync,
  accountCount,
  status,
  apiOnline,
  onOpenRuntime,
}: AppStatusBarProps): React.ReactElement {
  return (
    <footer
      className={cn(
        "@container col-span-full row-start-2 z-20 flex h-7 max-h-7 min-h-7 flex-nowrap items-center justify-between gap-1.5 overflow-hidden whitespace-nowrap border-t border-border bg-[#0a0a0c] pr-2.5 pl-0 text-[11.5px] text-muted-foreground",
        "max-[860px]:col-span-1 max-[860px]:row-start-3 max-[860px]:pr-2",
      )}
      aria-label="Server status"
    >
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden">
        <StatusBarSyncButton syncing={syncing} onSync={onSync} />
        <span
          className="mr-0.5 inline-flex min-w-0 shrink items-center overflow-hidden whitespace-nowrap p-0 text-[11.5px] text-muted-foreground tabular-nums"
          title="Accounts · events · wiki pages · embeddings"
        >
          <span>
            {accountCount} acct{accountCount === 1 ? "" : "s"}
          </span>
          <span className="@max-[720px]:hidden">
            <span className="mx-1.5 text-muted-foreground/80" aria-hidden>
              ·
            </span>
            {fmt(status?.usage.events ?? 0)} events
          </span>
          <span className="@max-[860px]:hidden">
            <span className="mx-1.5 text-muted-foreground/80" aria-hidden>
              ·
            </span>
            {status?.workers?.wiki_pages ?? 0} wiki
          </span>
          <span className="@max-[860px]:hidden">
            <span className="mx-1.5 text-muted-foreground/80" aria-hidden>
              ·
            </span>
            {status?.workers?.embeddings ?? 0} vec
          </span>
        </span>
        <button
          type="button"
          className="inline-flex max-w-none shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border-0 bg-transparent px-1.5 py-1 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={apiOnline ? "rivetd control plane reachable" : "rivetd unreachable"}
          onClick={onOpenRuntime}
        >
          <span
            className={cn(
              "size-[7px] shrink-0 rounded-full",
              apiOnline ? "bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.16)]" : "bg-red-400",
            )}
          />
          <span className="@max-[860px]:hidden">rivetd {apiOnline ? "online" : "offline"}</span>
          <span className="hidden @max-[860px]:inline">{apiOnline ? "api" : "api↓"}</span>
        </button>
        <AppStatusBarProxyPill
          proxyRunning={status?.proxy_running}
          proxyBaseUrl={status?.proxy_base_url}
          onOpenRuntime={onOpenRuntime}
        />
        <span
          className="inline-flex max-w-none shrink-0 cursor-default items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border-0 bg-transparent px-1.5 py-1 text-[11.5px] text-muted-foreground @max-[720px]:hidden"
          title="Capture store backend"
        >
          <span className="size-[7px] shrink-0 rounded-full bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.16)]" />
          <span className="@max-[860px]:hidden">{status?.capture_backend ?? "clickhouse"}</span>
          <span className="hidden @max-[860px]:inline">ch</span>
        </span>
      </div>
    </footer>
  );
}
