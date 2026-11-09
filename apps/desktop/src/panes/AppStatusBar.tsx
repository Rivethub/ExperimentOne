import type { JSX } from "solid-js";
import { RefreshCw } from "lucide-solid";
import { Button } from "#components/ui/button";
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

export function AppStatusBar(props: AppStatusBarProps): JSX.Element {
  return (
    <footer
      class="@container bg-background text-muted-foreground z-20 flex h-7 max-h-7 min-h-7 flex-nowrap items-center justify-between gap-1.5 overflow-hidden whitespace-nowrap border-t border-border pr-2.5 pl-1 text-[11.5px]"
      aria-label="Server status"
    >
      <div class="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          class="size-6 shrink-0 text-muted-foreground/80 hover:text-foreground"
          disabled={props.syncing}
          onClick={() => props.onSync()}
          title="Sync status"
          aria-label="Sync status"
        >
          <RefreshCw
            size={12}
            strokeWidth={1.75}
            aria-hidden
            class={cn(props.syncing && "animate-spin")}
          />
        </Button>
        <span
          class="mr-0.5 inline-flex min-w-0 shrink items-center overflow-hidden whitespace-nowrap p-0 text-[11.5px] text-muted-foreground tabular-nums"
          title="Accounts · events · wiki pages · embeddings"
        >
          <span>
            {props.accountCount} acct{props.accountCount === 1 ? "" : "s"}
          </span>
          <span class="@max-[720px]:hidden">
            <span class="mx-1.5 text-muted-foreground/80" aria-hidden>
              ·
            </span>
            {fmt(props.status?.usage.events ?? 0)} events
          </span>
          <span class="@max-[860px]:hidden">
            <span class="mx-1.5 text-muted-foreground/80" aria-hidden>
              ·
            </span>
            {props.status?.workers?.wiki_pages ?? 0} wiki
          </span>
          <span class="@max-[860px]:hidden">
            <span class="mx-1.5 text-muted-foreground/80" aria-hidden>
              ·
            </span>
            {props.status?.workers?.embeddings ?? 0} vec
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="h-6 max-w-none shrink-0 gap-1.5 px-1.5 text-[11.5px] text-muted-foreground"
          title={props.apiOnline ? "rivetd control plane reachable" : "rivetd unreachable"}
          onClick={() => props.onOpenRuntime()}
        >
          <span
            class={cn(
              "size-[7px] shrink-0 rounded-full",
              props.apiOnline
                ? "bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.16)]"
                : "bg-red-400",
            )}
          />
          <span class="@max-[860px]:hidden">rivetd {props.apiOnline ? "online" : "offline"}</span>
          <span class="hidden @max-[860px]:inline">{props.apiOnline ? "api" : "api↓"}</span>
        </Button>
        <AppStatusBarProxyPill
          proxyRunning={props.status?.proxy_running}
          proxyBaseUrl={props.status?.proxy_base_url}
          onOpenRuntime={() => props.onOpenRuntime()}
        />
        <span
          class="inline-flex max-w-none shrink-0 cursor-default items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border-0 bg-transparent px-1.5 py-1 text-[11.5px] text-muted-foreground @max-[720px]:hidden"
          title="Capture store backend"
        >
          <span class="size-[7px] shrink-0 rounded-full bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.16)]" />
          <span class="@max-[860px]:hidden">{props.status?.capture_backend ?? "clickhouse"}</span>
          <span class="hidden @max-[860px]:inline">ch</span>
        </span>
      </div>
    </footer>
  );
}
