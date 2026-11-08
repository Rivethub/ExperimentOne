import { providerKey } from "./provider-utils";
import { formatRelativeTime } from "./relative-time";
import type { QuotaAccount } from "./types";

/** Install target for Rivet harness / plugin setup. */
export type HarnessInstallTarget = "claude" | "codex" | "cursor";

/** Claude Code or Codex install target for a linked account provider. */
export function harnessTargetForProvider(provider: string): "claude" | "codex" | null {
  const key = providerKey(provider);
  if (key === "claude") {
    return "claude";
  }
  if (key === "codex") {
    return "codex";
  }
  return null;
}

export function harnessButtonLabel(target: "claude" | "codex"): string {
  return target === "claude" ? "Set up Claude Code" : "Set up Codex";
}

export function formatRelativeIso(iso: string | null | undefined): string {
  return formatRelativeTime(iso, { style: "long" });
}

export function formatSynced(ts: number | null): string {
  return formatRelativeTime(ts, { from: "synced" });
}

export function isDeviceAuthBlocked(output: string): boolean {
  return /Enable device code sign-in|ChatGPT Security Settings|deviceauth/iu.test(output);
}

export function firstHttpUrl(text: string): string | null {
  const m = /https?:\/\/[^\s"'<>]+/iu.exec(text);
  if (!m) {
    return null;
  }
  return m[0].replace(/[),.;]+$/u, "");
}

export function accountDisplay(a: QuotaAccount): string {
  const email = a.email ?? "";
  if (email !== "") {
    return email;
  }
  if (a.label !== "") {
    return a.label;
  }
  return a.id;
}
