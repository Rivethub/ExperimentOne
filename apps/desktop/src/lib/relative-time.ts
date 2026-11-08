export type RelativeTimeStyle = "long" | "short";
export type RelativeTimeFrom = "past" | "synced";

export type FormatRelativeTimeOpts = {
  style?: RelativeTimeStyle;
  from?: RelativeTimeFrom;
};

function parseInstant(isoOrMs: string | number): number | null {
  if (typeof isoOrMs === "number") {
    return Number.isFinite(isoOrMs) ? isoOrMs : null;
  }
  const t = Date.parse(isoOrMs);
  return Number.isFinite(t) ? t : null;
}

function formatPastLong(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 45) {
    return "just now";
  }
  if (sec < 3600) {
    return `${Math.max(1, Math.round(sec / 60))}m ago`;
  }
  if (sec < 86_400) {
    return `${Math.round(sec / 3600)}h ago`;
  }
  if (sec < 86_400 * 14) {
    return `${Math.round(sec / 86_400)}d ago`;
  }
  return new Date(ms).toLocaleDateString();
}

function formatPastShort(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatSynced(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 5) {
    return "just now";
  }
  if (sec < 60) {
    return `${sec}s ago`;
  }
  return `${Math.floor(sec / 60)}m ago`;
}

/** Relative time for ISO strings or epoch milliseconds. */
export function formatRelativeTime(
  isoOrMs: string | number | null | undefined,
  opts?: FormatRelativeTimeOpts,
): string {
  const style = opts?.style ?? "long";
  const from = opts?.from ?? "past";

  if (isoOrMs === null || isoOrMs === undefined || isoOrMs === "") {
    return from === "synced" ? "never" : "—";
  }
  if (from === "synced" && isoOrMs === 0) {
    return "never";
  }

  const ms = parseInstant(isoOrMs);
  if (ms === null) {
    return typeof isoOrMs === "string" ? isoOrMs : "—";
  }

  if (from === "synced") {
    return formatSynced(ms);
  }
  return style === "short" ? formatPastShort(ms) : formatPastLong(ms);
}

/** Countdown until a future ISO timestamp. */
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
