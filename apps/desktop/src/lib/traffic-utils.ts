import { isDefined } from "./nullish";
import { fmt } from "./provider-utils";
import type { TrafficEvent } from "./types";

export type SplitTrafficBody = {
  request: string;
  response: string | null;
};

export function trunc(s: string | null | undefined, n = 120): string {
  if (s === null || s === undefined || s === "") {
    return "—";
  }
  const t = s.replaceAll(/\s+/gu, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function prettyJsonChunk(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return "(empty)";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Stored traffic bodies are `request\n---\nresponse`. */
export function splitTrafficBody(raw: string | null | undefined): SplitTrafficBody {
  if (!isDefined(raw) || raw.trim() === "") {
    return { request: "(empty)", response: null };
  }
  const parts = raw.split(/\n---\n/u);
  if (parts.length >= 2) {
    return {
      request: prettyJsonChunk(parts[0] ?? ""),
      response: prettyJsonChunk(parts.slice(1).join("\n---\n")),
    };
  }
  return { request: prettyJsonChunk(raw), response: null };
}

export function filterTrafficRows(
  rows: TrafficEvent[],
  provider: string,
  status: "all" | "ok" | "error",
  providerKeyFn: (p: string) => string,
): TrafficEvent[] {
  return rows.filter((ev) => {
    if (provider !== "all" && providerKeyFn(ev.provider) !== provider) {
      return false;
    }
    if (status === "ok") {
      const code = ev.status_code ?? 0;
      if (code < 200 || code >= 400) {
        return false;
      }
    }
    if (status === "error") {
      const code = ev.status_code ?? 0;
      if (code > 0 && code < 400) {
        return false;
      }
      if (code === 0) {
        return false;
      }
    }
    return true;
  });
}

export function trafficTokenLabel(ev: TrafficEvent): string {
  const code = ev.status_code ?? 0;
  const failed = code > 0 && (code < 200 || code >= 300);
  if (failed && ev.tokens_in === 0 && ev.tokens_out === 0) {
    return "—";
  }
  return `${fmt(ev.tokens_in)}/${fmt(ev.tokens_out)}`;
}
