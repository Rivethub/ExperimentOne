import { Activity, BookOpen, Gauge, MessagesSquare, Settings, type LucideIcon } from "lucide-react";
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

export const NAV: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: "quota", label: "Quota", icon: Gauge },
  { id: "data", label: "Data", icon: MessagesSquare },
  { id: "runtime", label: "Runtime", icon: Activity },
  { id: "wiki", label: "Wiki", icon: BookOpen },
  { id: "settings", label: "Settings", icon: Settings },
];

export const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "accounts", label: "Accounts", hint: "Provider credentials" },
  { id: "intelligence", label: "Intelligence", hint: "Models & workers" },
  { id: "harness", label: "Harness", hint: "Advanced / snippets" },
];
