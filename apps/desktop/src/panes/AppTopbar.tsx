import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Ellipsis } from "lucide-solid";
import { Button as ShadcnButton } from "#components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import type { Page } from "../lib/types";
import { Button } from "../ui";

export type AppTopbarQuotaActions = {
  onManageCredentials: () => void;
};

export type AppTopbarWikiActions = {
  onOpenSettings: () => void;
  onOpenFolder: () => void;
  wikiEnabled: boolean;
};

export type AppTopbarRuntimeActions = {
  proxyRunning: boolean;
  apiOnline: boolean;
  onProxyStart: () => void;
  onProxyStop: () => void;
  onProxyRestart: () => void;
  onRunWorkers: () => void;
};

export type AppTopbarDataActions = {
  canRevealExport: boolean;
  onExport: () => void;
  onImport: () => void;
  onIngestLocal: () => void;
  onRevealExport: () => void;
};

export type AppTopbarProps = {
  title: string;
  subtitle: string;
  page: Page;
  busy: boolean;
  onRefresh: () => void;
  quota?: AppTopbarQuotaActions;
  wiki?: AppTopbarWikiActions;
  runtime?: AppTopbarRuntimeActions;
  data?: AppTopbarDataActions;
};

export function AppTopbar(props: AppTopbarProps): JSX.Element {
  return (
    <header class="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
      <div>
        <h1 class="m-0 text-[22px] font-semibold tracking-tight">{props.title}</h1>
        <div class="mt-1 text-[13px] text-muted-foreground">{props.subtitle}</div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Show when={props.page !== "wiki"}>
          <Button variant="ghost" disabled={props.busy} onClick={() => props.onRefresh()}>
            Refresh
          </Button>
        </Show>
        <Show when={props.page === "quota" && props.quota}>
          {(quota) => (
            <Button
              variant="primary"
              disabled={props.busy}
              onClick={() => quota().onManageCredentials()}
            >
              Manage credentials
            </Button>
          )}
        </Show>
        <Show when={props.page === "data" && props.data}>
          {(data) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ShadcnButton variant="default" disabled={props.busy}>
                  Export / import
                </ShadcnButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={props.busy} onSelect={() => data().onExport()}>
                  Export all .rivetbag
                </DropdownMenuItem>
                <DropdownMenuItem disabled={props.busy} onSelect={() => data().onImport()}>
                  Import .rivetbag
                </DropdownMenuItem>
                <DropdownMenuItem disabled={props.busy} onSelect={() => data().onIngestLocal()}>
                  Import local sessions
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={props.busy || !data().canRevealExport}
                  onSelect={() => data().onRevealExport()}
                >
                  Reveal last export
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </Show>
        <Show when={props.page === "wiki" && props.wiki}>
          {(wiki) => (
            <>
              <Button variant="ghost" disabled={props.busy} onClick={() => wiki().onOpenSettings()}>
                {wiki().wikiEnabled ? "Settings" : "Enable wiki"}
              </Button>
              <Button variant="primary" onClick={() => wiki().onOpenFolder()}>
                Open folder
              </Button>
            </>
          )}
        </Show>
        <Show when={props.page === "runtime" && props.runtime}>
          {(runtime) => (
            <>
              <Show
                when={runtime().proxyRunning}
                fallback={
                  <Button
                    variant="primary"
                    disabled={props.busy || !runtime().apiOnline}
                    onClick={() => runtime().onProxyStart()}
                  >
                    Start proxy
                  </Button>
                }
              >
                <Button disabled={props.busy} onClick={() => runtime().onProxyStop()}>
                  Stop proxy
                </Button>
              </Show>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <ShadcnButton
                    variant="ghost"
                    size="icon"
                    disabled={props.busy || !runtime().apiOnline}
                    aria-label="More runtime actions"
                  >
                    <Ellipsis />
                  </ShadcnButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={props.busy || !runtime().apiOnline}
                    onSelect={() => runtime().onProxyRestart()}
                  >
                    Restart proxy
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={props.busy || !runtime().apiOnline}
                    onSelect={() => runtime().onRunWorkers()}
                  >
                    Run workers
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </Show>
      </div>
    </header>
  );
}
