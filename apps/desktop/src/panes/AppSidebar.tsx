import { Link } from "@tanstack/react-router";
import { Badge } from "#components/ui/badge";
import { cn } from "#lib/utils";
import { NAV, SETTINGS_TABS } from "../lib/constants";
import type { Page, SettingsTab } from "../lib/types";

export type AppSidebarProps = {
  page: Page;
  settingsTab: SettingsTab;
  accountCount: number;
  trafficEventCount: number;
};

function navTo(page: Page, settingsTab: SettingsTab) {
  if (page === "quota") return { to: "/" as const };
  if (page === "data") return { to: "/data" as const };
  if (page === "runtime") return { to: "/runtime" as const };
  if (page === "wiki") return { to: "/wiki" as const };
  return { to: "/settings/$tab" as const, params: { tab: settingsTab } };
}

export function AppSidebar({
  page,
  settingsTab,
  accountCount,
  trafficEventCount,
}: AppSidebarProps): React.ReactElement {
  return (
    <aside
      className={cn(
        "col-start-1 row-start-1 flex w-[212px] min-h-0 flex-col gap-1 overflow-hidden border-r border-sidebar-border bg-gradient-to-b from-[#0c0c0e] to-[#09090b] px-3 py-4",
        "max-[860px]:col-start-1 max-[860px]:row-start-1 max-[860px]:h-auto max-[860px]:w-full max-[860px]:flex-row max-[860px]:flex-wrap max-[860px]:border-r-0 max-[860px]:border-b",
      )}
    >
      <div className="flex items-center gap-2.5 px-2.5 pb-[18px] pt-1.5">
        <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-zinc-50 to-zinc-400 text-[13px] font-bold tracking-tight text-zinc-950">
          R
        </div>
        <div>
          <strong className="block text-sm tracking-tight">Rivet</strong>
          <span className="text-[11px] text-muted-foreground">local data hub</span>
        </div>
      </div>
      {NAV.map((item) => {
        const link = navTo(item.id === "settings" ? "settings" : item.id, settingsTab);
        const Icon = item.icon;
        const active = page === item.id;
        return (
          <div key={item.id} className="flex flex-col gap-0.5">
            <Link
              {...link}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2.5 text-left no-underline transition-[background,color] duration-100",
                active
                  ? "bg-zinc-800 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon
                className="size-4 shrink-0 opacity-85"
                size={16}
                strokeWidth={1.75}
                aria-hidden
              />
              {item.label}
              {item.id === "settings" && accountCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-auto min-w-[18px] border-0 bg-zinc-800 px-1.5 py-px text-[11px] tabular-nums text-muted-foreground"
                >
                  {accountCount}
                </Badge>
              )}
              {item.id === "data" && trafficEventCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-auto min-w-[18px] border-0 bg-zinc-800 px-1.5 py-px text-[11px] tabular-nums text-muted-foreground"
                >
                  {trafficEventCount > 99 ? "99+" : trafficEventCount}
                </Badge>
              )}
            </Link>
            {item.id === "settings" && page === "settings" && (
              <div
                className="flex flex-col gap-px py-0.5 pr-0 pb-1.5 pl-[26px]"
                role="navigation"
                aria-label="Settings sections"
              >
                {SETTINGS_TABS.map((tab) => (
                  <Link
                    key={tab.id}
                    to="/settings/$tab"
                    params={{ tab: tab.id }}
                    className={cn(
                      "cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[12.5px] no-underline",
                      settingsTab === tab.id
                        ? "bg-zinc-900 text-foreground"
                        : "text-muted-foreground/80 hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {tab.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
