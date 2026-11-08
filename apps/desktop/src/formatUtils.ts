import { providerKey } from "./providerUtils";
import type { QuotaAccount } from "./types";

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
  if (iso === null || iso === undefined || iso === "") {
    return "—";
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return iso;
  }
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) {
    return "just now";
  }
  if (sec < 3600) {
    return `${Math.round(sec / 60)}m ago`;
  }
  if (sec < 86_400) {
    return `${Math.round(sec / 3600)}h ago`;
  }
  if (sec < 86_400 * 14) {
    return `${Math.round(sec / 86_400)}d ago`;
  }
  return new Date(t).toLocaleDateString();
}

export function formatSynced(ts: number | null): string {
  if (ts === null || ts === 0) {
    return "never";
  }
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) {
    return "just now";
  }
  if (sec < 60) {
    return `${sec}s ago`;
  }
  return `${Math.floor(sec / 60)}m ago`;
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
