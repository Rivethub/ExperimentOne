/** Shared provider + formatting helpers for desktop UI. */

export type CatalogProvider = {
  id: string;
  label: string;
  badge: string;
  login_kind: "oauth_browser" | "oauth_device" | "file_import";
  login_flag?: string | null;
  aliases: string[];
  hint: string;
  color: string;
};

const numberFmt = new Intl.NumberFormat("en-US");

function defaultProviderColor(id: string): string {
  if (id === "claude") {
    return "#f97316";
  }
  if (id === "codex") {
    return "#60a5fa";
  }
  return "#a1a1aa";
}

export function fmt(n: number): string {
  return numberFmt.format(n);
}

export function providerKey(p: string): string {
  const s = p.toLowerCase().trim();
  if (s.includes("claude") || s === "anthropic") {
    return "claude";
  }
  if (s.includes("codex") || s.includes("openai") || s === "open_ai") {
    return "codex";
  }
  if (s.includes("antigravity")) {
    return "antigravity";
  }
  if (s.includes("kimi.ai") || s === "kimi-ai" || s === "kimi_ai") {
    return "kimi-ai";
  }
  if (s.includes("kimi") || s.includes("moonshot")) {
    return "kimi";
  }
  if (s.includes("xai") || s.includes("grok")) {
    return "xai";
  }
  if (s.includes("meta") || s.includes("llama")) {
    return "meta";
  }
  if (s.includes("devin")) {
    return "devin";
  }
  if (s.includes("vertex")) {
    return "vertex";
  }
  if (s.includes("gemini")) {
    return "gemini";
  }
  return s !== "" ? s : "other";
}

export function providerColor(id: string, catalog: CatalogProvider[]): string {
  return catalog.find((p) => p.id === id)?.color ?? defaultProviderColor(id);
}

export function providerBadge(id: string, catalog: CatalogProvider[]): string {
  return catalog.find((p) => p.id === id)?.badge ?? id.slice(0, 1).toUpperCase();
}

export function providerLabel(id: string, catalog: CatalogProvider[]): string {
  return catalog.find((p) => p.id === id)?.label ?? id;
}

export function providerChipLabel(id: string, catalog: CatalogProvider[]): string {
  if (id === "kimi") {
    return "kimi.com";
  }
  if (id === "kimi-ai") {
    return "kimi.ai";
  }
  const label = providerLabel(id, catalog);
  const match = /^(?<base>.+?)\s*\((?<suffix>.+)\)$/u.exec(label);
  if (!match?.groups) {
    return label;
  }
  const { base, suffix } = match.groups;
  if (base === undefined || suffix === undefined) {
    return label;
  }
  const clash = catalog.some(
    (p) => p.id !== id && (p.label === base || p.label.startsWith(`${base} (`)),
  );
  return clash ? suffix : base;
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) {
    return "—";
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

export function formatCheckedAgo(iso: string | null | undefined): string {
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
    return `${Math.max(1, Math.round(sec / 60))}m ago`;
  }
  if (sec < 86_400) {
    return `${Math.round(sec / 3600)}h ago`;
  }
  return `${Math.round(sec / 86_400)}d ago`;
}

export function formatCountdownTo(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") {
    return "—";
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return iso;
  }
  const sec = Math.round((t - Date.now()) / 1000);
  if (sec <= 0) {
    return "now";
  }
  if (sec < 3600) {
    return `~${Math.ceil(sec / 60)}m`;
  }
  if (sec < 86_400) {
    return `~${(sec / 3600).toFixed(1)}h`;
  }
  return `~${Math.round(sec / 86_400)}d`;
}
