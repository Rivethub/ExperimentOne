import type { SettingsTab } from "./types";

const SETTINGS_TABS = new Set<SettingsTab>(["accounts", "intelligence", "harness"]);

export function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TABS.has(value as SettingsTab);
}
