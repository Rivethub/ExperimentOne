import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import { Link } from "@tanstack/solid-router";
import { Ellipsis } from "lucide-solid";
import {
  Breadcrumbs,
  BreadcrumbsItem,
  BreadcrumbsLink,
  BreadcrumbList,
  BreadcrumbsSeparator,
} from "#components/ui/breadcrumbs";
import { Button } from "#components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import { Separator } from "#components/ui/separator";
import { SidebarTrigger } from "#components/ui/sidebar";
import { SETTINGS_TABS } from "#lib/constants";
import type { Page, SettingsTab } from "../lib/types";

/** TanStack Link + Kobalte polymorphic props don't share a clean route params type. */
const RouterLink = Link as unknown as Component<Record<string, unknown>>;

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
  settingsTab?: SettingsTab;
  busy: boolean;
  onRefresh: () => void;
  quota?: AppTopbarQuotaActions;
  wiki?: AppTopbarWikiActions;
  runtime?: AppTopbarRuntimeActions;
  data?: AppTopbarDataActions;
};

const PAGE_LABEL: Record<Page, string> = {
  quota: "Quota",
  data: "Data",
  topics: "Topics",
  runtime: "Runtime",
  wiki: "Wiki",
  settings: "Settings",
};

export function AppTopbar(props: AppTopbarProps): JSX.Element {
  const settingsTabLabel = () =>
    SETTINGS_TABS.find((t) => t.id === (props.settingsTab ?? "accounts"))?.label ?? "Accounts";

  return (
    <header class="bg-background flex h-14 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 md:px-6">
      <SidebarTrigger class="-ml-1" />
      <Separator orientation="vertical" class="mr-2 data-[orientation=vertical]:h-4" />

      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="min-w-0">
          <Breadcrumbs>
            <BreadcrumbList class="sm:gap-1.5">
              <BreadcrumbsItem class="hidden md:inline-flex">
                <BreadcrumbsLink as={RouterLink} to="/" class="text-muted-foreground">
                  Rivet
                </BreadcrumbsLink>
              </BreadcrumbsItem>
              <BreadcrumbsSeparator class="hidden md:block" />
              <BreadcrumbsItem>
                <Show
                  when={props.page === "settings"}
                  fallback={
                    <BreadcrumbsLink current class="text-foreground font-medium">
                      {props.title || PAGE_LABEL[props.page]}
                    </BreadcrumbsLink>
                  }
                >
                  <BreadcrumbsLink
                    as={RouterLink}
                    to="/settings/$tab"
                    params={{ tab: props.settingsTab ?? "accounts" }}
                    class="text-muted-foreground"
                  >
                    Settings
                  </BreadcrumbsLink>
                </Show>
              </BreadcrumbsItem>
              <Show when={props.page === "settings"}>
                <BreadcrumbsSeparator />
                <BreadcrumbsItem>
                  <BreadcrumbsLink current class="text-foreground font-medium">
                    {settingsTabLabel()}
                  </BreadcrumbsLink>
                </BreadcrumbsItem>
              </Show>
            </BreadcrumbList>
          </Breadcrumbs>
          <p class="text-muted-foreground truncate text-xs">{props.subtitle}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-end gap-2">
        <Show when={props.page !== "wiki"}>
          <Button variant="ghost" size="sm" disabled={props.busy} onClick={() => props.onRefresh()}>
            Refresh
          </Button>
        </Show>
        <Show when={props.page === "quota" && props.quota}>
          {(quota) => (
            <Button size="sm" disabled={props.busy} onClick={() => quota().onManageCredentials()}>
              Manage credentials
            </Button>
          )}
        </Show>
        <Show when={props.page === "data" && props.data}>
          {(data) => (
            <DropdownMenu placement="bottom-end">
              <DropdownMenuTrigger as={Button} variant="default" size="sm" disabled={props.busy}>
                Export / import
              </DropdownMenuTrigger>
              <DropdownMenuContent>
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
              <Button
                variant="ghost"
                size="sm"
                disabled={props.busy}
                onClick={() => wiki().onOpenSettings()}
              >
                {wiki().wikiEnabled ? "Settings" : "Enable wiki"}
              </Button>
              <Button size="sm" onClick={() => wiki().onOpenFolder()}>
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
                    size="sm"
                    disabled={props.busy || !runtime().apiOnline}
                    onClick={() => runtime().onProxyStart()}
                  >
                    Start proxy
                  </Button>
                }
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.busy}
                  onClick={() => runtime().onProxyStop()}
                >
                  Stop proxy
                </Button>
              </Show>
              <DropdownMenu placement="bottom-end">
                <DropdownMenuTrigger
                  as={Button}
                  variant="ghost"
                  size="icon-sm"
                  disabled={props.busy || !runtime().apiOnline}
                  aria-label="More runtime actions"
                >
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
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
