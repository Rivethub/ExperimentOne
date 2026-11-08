import { SETTINGS_TABS } from "#lib/constants";
import { fmt } from "#lib/provider-utils";
import type { Page, QuotaSnapshot, SettingsTab, Status } from "#lib/types";
import type { WikiInfo } from "#components/WikiBoard";

const TITLE_MAP: Record<Page, string> = {
  quota: "Quota Management",
  data: "Data",
  topics: "Topics",
  runtime: "Runtime",
  wiki: "Wiki",
  settings: "Settings",
};

export function pageFromPathname(pathname: string): Page {
  if (pathname.startsWith("/data")) return "data";
  if (pathname.startsWith("/topics")) return "topics";
  if (pathname.startsWith("/runtime")) return "runtime";
  if (pathname.startsWith("/wiki")) return "wiki";
  if (pathname.startsWith("/settings")) return "settings";
  return "quota";
}

export function settingsTabFromPathname(pathname: string): SettingsTab {
  const match = /^\/settings\/([^/]+)/.exec(pathname);
  const tab = match?.[1];
  return tab === "accounts" || tab === "intelligence" || tab === "harness" ? tab : "accounts";
}

export function pageTitle(page: Page, settingsTab: SettingsTab): string {
  if (page === "settings") {
    return SETTINGS_TABS.find((t) => t.id === settingsTab)?.label ?? "Settings";
  }
  return TITLE_MAP[page];
}

export function pageSubtitle(opts: {
  page: Page;
  settingsTab: SettingsTab;
  status: Status | null;
  quota: QuotaSnapshot | null;
  accountCount: number;
  recentCount: number;
  wiki: WikiInfo | null;
}): string {
  const { page, settingsTab, status, quota, accountCount, recentCount, wiki } = opts;
  const credentialCount = quota?.credentials_total ?? status?.account_count ?? accountCount;
  const proxyLabel = status?.proxy_running ? "running" : "stopped";

  switch (page) {
    case "quota":
      if (credentialCount === 0) return `No credentials · proxy ${proxyLabel}`;
      return `${credentialCount} credential${credentialCount === 1 ? "" : "s"} · ${
        quota?.source === "management" ? "live quota" : "local estimates"
      } · proxy ${proxyLabel}`;
    case "data":
      return `${fmt(status?.usage.events ?? recentCount)} messages across conversations`;
    case "topics":
      return "Durable subjects across sessions and tools";
    case "runtime":
      return status?.proxy_base_url ?? "Control plane · workers · logs";
    case "wiki": {
      if (wiki !== null) {
        const n = new Set(
          wiki.pages
            .filter((p) => /(^|\/)README\.md$/i.test(p.relative_path))
            .map((p) => p.project_id || "project"),
        ).size;
        return `${n} project${n === 1 ? "" : "s"}`;
      }
      const pages = status?.workers?.wiki_pages ?? 0;
      return `${pages} page${pages === 1 ? "" : "s"}`;
    }
    case "settings":
      return SETTINGS_TABS.find((t) => t.id === settingsTab)?.hint ?? "Configure Rivet";
  }
}
