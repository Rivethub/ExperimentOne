import { SETTINGS_TABS } from "./constants";
import { fmt } from "./providerUtils";
import type { Page, QuotaSnapshot, SettingsTab, Status } from "./types";
import type { WikiInfo } from "./components/WikiBoard";

const TITLE_MAP: Record<Page, string> = {
  quota: "Quota Management",
  data: "Data",
  runtime: "Runtime",
  wiki: "Wiki",
  settings: "Settings",
};

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
    case "runtime":
      return status?.proxy_base_url ?? "Control plane · workers · logs";
    case "wiki": {
      const n = new Set(
        (wiki?.pages ?? [])
          .filter((p) => /(^|\/)README\.md$/i.test(p.relative_path))
          .map((p) => p.project_id || "project"),
      ).size;
      return `${n} project${n === 1 ? "" : "s"}`;
    }
    case "settings":
      return SETTINGS_TABS.find((t) => t.id === settingsTab)?.hint ?? "Configure Rivet";
  }
}
