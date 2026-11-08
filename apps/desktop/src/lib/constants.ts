import type { CatalogProvider } from "./provider-utils";
import type { Page, SettingsTab } from "./types";

export const FALLBACK_PROVIDERS: CatalogProvider[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    badge: "C",
    login_kind: "oauth_browser",
    login_flag: "claude-login",
    aliases: ["anthropic"],
    hint: "Browser OAuth",
    color: "#f97316",
  },
  {
    id: "codex",
    label: "Codex (OpenAI)",
    badge: "X",
    login_kind: "oauth_browser",
    login_flag: "codex-login",
    aliases: ["openai"],
    hint: "Browser OAuth",
    color: "#60a5fa",
  },
];

export const NAV: { id: Page; label: string; icon: string }[] = [
  { id: "quota", label: "Quota", icon: "◈" },
  { id: "data", label: "Data", icon: "◫" },
  { id: "topics", label: "Topics", icon: "◉" },
  { id: "runtime", label: "Runtime", icon: "⏻" },
  { id: "wiki", label: "Wiki", icon: "☰" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "accounts", label: "Accounts", hint: "Provider credentials" },
  { id: "intelligence", label: "Intelligence", hint: "Models & workers" },
  { id: "harness", label: "Harness", hint: "Advanced / snippets" },
];
