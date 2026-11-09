import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { Link } from "@tanstack/solid-router";
import { ChevronRight } from "lucide-solid";
import { Collapsible, CollapsibleContent } from "#components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "#components/ui/sidebar";
import { fmt } from "#lib/provider-utils";
import { NAV, SETTINGS_TABS } from "../lib/constants";
import type { Page, SettingsTab } from "../lib/types";

export type AppSidebarProps = {
  page: Page;
  settingsTab: SettingsTab;
  accountCount: number;
  captureEventCount: number;
};

/** TanStack Link + Kobalte polymorphic props don't share a clean route params type. */
const RouterLink = Link as unknown as Component<Record<string, unknown>>;

function navTo(page: Page, settingsTab: SettingsTab): Record<string, unknown> {
  if (page === "quota") return { to: "/" };
  if (page === "data") return { to: "/data" };
  if (page === "topics") return { to: "/topics" };
  if (page === "runtime") return { to: "/runtime" };
  if (page === "wiki") return { to: "/wiki" };
  return { to: "/settings/$tab", params: { tab: settingsTab } };
}

export function AppSidebar(props: AppSidebarProps): JSX.Element {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              class="pointer-events-none data-[slot=sidebar-menu-button]:p-2!"
            >
              <div class="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg text-sm font-bold tracking-tight">
                R
              </div>
              <div class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-semibold">Rivet</span>
                <span class="text-sidebar-foreground/70 truncate text-xs">local data hub</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigate</SidebarGroupLabel>
          <SidebarMenu>
            <For each={NAV}>
              {(item) => {
                const Icon = item.icon;
                return (
                  <Show
                    when={item.id === "settings"}
                    fallback={
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          as={RouterLink}
                          {...navTo(item.id, props.settingsTab)}
                          isActive={props.page === item.id}
                          tooltip={item.label}
                        >
                          <Icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                        <Show when={item.id === "data" && props.captureEventCount > 0}>
                          <SidebarMenuBadge>
                            {props.captureEventCount > 99 ? "99+" : props.captureEventCount}
                          </SidebarMenuBadge>
                        </Show>
                      </SidebarMenuItem>
                    }
                  >
                    <Collapsible open={props.page === "settings"} class="group/collapsible">
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          as={RouterLink}
                          to="/settings/$tab"
                          params={{ tab: props.settingsTab }}
                          isActive={props.page === "settings"}
                          tooltip={item.label}
                        >
                          <Icon />
                          <span>{item.label}</span>
                          <ChevronRight class="ml-auto transition-transform duration-200 group-data-[expanded]:rotate-90" />
                        </SidebarMenuButton>
                        <Show when={props.accountCount > 0}>
                          <SidebarMenuBadge>{props.accountCount}</SidebarMenuBadge>
                        </Show>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            <For each={SETTINGS_TABS}>
                              {(tab) => (
                                <SidebarMenuSubItem>
                                  <SidebarMenuSubButton
                                    as={RouterLink}
                                    to="/settings/$tab"
                                    params={{ tab: tab.id }}
                                    isActive={props.settingsTab === tab.id}
                                  >
                                    <span>{tab.label}</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )}
                            </For>
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  </Show>
                );
              }}
            </For>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <Show when={props.captureEventCount > 0}>
          <p class="text-sidebar-foreground/60 truncate px-2 text-xs">
            {fmt(props.captureEventCount)} captured events
          </p>
        </Show>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
