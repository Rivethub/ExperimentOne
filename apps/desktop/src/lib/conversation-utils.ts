import { turnFromTrafficEvent } from "../transcript/parse";
import { formatRelativeTime } from "./relative-time";
import { splitTrafficBody, trunc } from "./traffic-utils";
import type { ConversationSummary, TrafficEvent } from "./types";

function titleFromEvent(ev: TrafficEvent): string {
  const turn = turnFromTrafficEvent(ev);
  const text = turn.parts
    .filter((p) => p.kind === "text" || p.kind === "system")
    .map((p) => ("text" in p ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return trunc(text, 72);
  const tool = turn.parts.find((p) => p.kind === "tool_call");
  if (tool && tool.kind === "tool_call") return trunc(`Tool: ${tool.name}`, 72);
  return trunc(ev.model ?? `${ev.provider} conversation`, 72);
}

export function conversationIdFor(ev: TrafficEvent): string {
  const sid = ev.session_id?.trim();
  if (sid) return sid;
  return `event:${ev.id}`;
}

export function conversationsFromEvents(
  events: TrafficEvent[],
  limit = 100,
): ConversationSummary[] {
  type Acc = {
    first: TrafficEvent;
    last: TrafficEvent;
    titleSrc: TrafficEvent;
    message_count: number;
    tokens_in: number;
    tokens_out: number;
  };
  const byId = new Map<string, Acc>();
  for (const ev of events) {
    const id = conversationIdFor(ev);
    const acc = byId.get(id);
    if (!acc) {
      byId.set(id, {
        first: ev,
        last: ev,
        titleSrc: ev,
        message_count: 1,
        tokens_in: ev.tokens_in,
        tokens_out: ev.tokens_out,
      });
      continue;
    }
    acc.message_count += 1;
    acc.tokens_in += ev.tokens_in;
    acc.tokens_out += ev.tokens_out;
    if (ev.ts < acc.first.ts) acc.first = ev;
    if (ev.ts >= acc.last.ts) acc.last = ev;
    const betterTitle =
      ev.role === "user" && (ev.ts <= acc.titleSrc.ts || acc.titleSrc.role !== "user");
    if (betterTitle) acc.titleSrc = ev;
  }

  const out: ConversationSummary[] = [...byId.entries()].map(([id, acc]) => {
    const title = titleFromEvent(acc.titleSrc);
    const lastTurn = turnFromTrafficEvent(acc.last);
    const previewText = lastTurn.parts
      .map((p) => {
        if (p.kind === "text" || p.kind === "thinking" || p.kind === "system" || p.kind === "raw") {
          return p.text;
        }
        if (p.kind === "tool_call") return `⚙ ${p.name}`;
        if (p.kind === "tool_result") return `↳ ${p.name ?? p.id}`;
        return "";
      })
      .filter(Boolean)
      .join(" · ");
    const preview = previewText ? trunc(previewText, 120) : null;
    return {
      id,
      title,
      preview,
      provider: acc.last.provider,
      model: acc.last.model,
      project_id: acc.last.project_id,
      started_at: acc.first.ts,
      updated_at: acc.last.ts,
      message_count: acc.message_count,
      tokens_in: acc.tokens_in,
      tokens_out: acc.tokens_out,
    };
  });
  out.sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at));
  return out.slice(0, Math.max(1, limit));
}

/** Display text for a transcript bubble (T3-style role message). */
export function messageTextFor(ev: TrafficEvent): string {
  const bodies = splitTrafficBody(ev.content);
  if (ev.role === "assistant" && bodies.response) return bodies.response;
  if (ev.role === "user") return bodies.request;
  if (bodies.response) return `${bodies.request}\n\n---\n\n${bodies.response}`;
  return bodies.request;
}

export function filterMessages(events: TrafficEvent[], query: string): TrafficEvent[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return events;
  return events.filter((ev) => {
    const hay =
      `${ev.content ?? ""} ${ev.model ?? ""} ${ev.role ?? ""} ${ev.account_label ?? ""}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function relativeWhen(iso: string): string {
  return formatRelativeTime(iso, { style: "short" });
}
