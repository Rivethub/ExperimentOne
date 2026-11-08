import { splitTrafficBody } from "../lib/traffic-utils";
import type { TrafficEvent } from "../lib/types";
import type { TranscriptPart, TranscriptRole, TranscriptTurn } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function textFromUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function tryParseJson(raw: string | null | undefined): unknown {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Truncated JSON — try a soft recovery by finding the outermost object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function pushText(
  parts: TranscriptPart[],
  text: string,
  kind: "text" | "system" | "thinking" = "text",
) {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return;
  parts.push(
    kind === "text"
      ? { kind: "text", text: t }
      : kind === "system"
        ? { kind: "system", text: t }
        : { kind: "thinking", text: t },
  );
}

function parseClaudeBlocks(blocks: unknown, parts: TranscriptPart[]) {
  for (const block of asArray(blocks)) {
    const b = asRecord(block);
    if (!b) {
      pushText(parts, textFromUnknown(block));
      continue;
    }
    const type = asString(b.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      pushText(parts, textFromUnknown(b.text ?? b.content));
    } else if (type === "thinking" || type === "redacted_thinking") {
      pushText(parts, textFromUnknown(b.thinking ?? b.text ?? b.content), "thinking");
    } else if (type === "tool_use") {
      parts.push({
        kind: "tool_call",
        id: asString(b.id),
        name: asString(b.name, "tool"),
        input: b.input ?? {},
      });
    } else if (type === "tool_result") {
      parts.push({
        kind: "tool_result",
        id: asString(b.tool_use_id) || asString(b.id),
        output: b.content ?? b.output ?? "",
        isError: Boolean(b.is_error),
      });
    } else if (typeof b.text === "string") {
      pushText(parts, b.text);
    } else {
      pushText(parts, textFromUnknown(b));
    }
  }
}

function parseMessageContent(content: unknown, parts: TranscriptPart[]) {
  if (typeof content === "string") {
    pushText(parts, content);
    return;
  }
  if (Array.isArray(content)) {
    parseClaudeBlocks(content, parts);
    return;
  }
  const obj = asRecord(content);
  if (obj) {
    if (typeof obj.text === "string") pushText(parts, obj.text);
    else pushText(parts, textFromUnknown(content));
  }
}

function parseOpenAiToolCalls(toolCalls: unknown, parts: TranscriptPart[]) {
  for (const call of asArray(toolCalls)) {
    const c = asRecord(call);
    if (!c) continue;
    const fn = asRecord(c.function) ?? c;
    let input: unknown = fn.arguments ?? fn.input ?? {};
    if (typeof input === "string") {
      const parsed = tryParseJson(input);
      input = parsed ?? input;
    }
    parts.push({
      kind: "tool_call",
      id: asString(c.id) || asString(c.call_id),
      name: asString(fn.name) || asString(c.name, "tool"),
      input,
    });
  }
}

function parseChatMessage(msg: Record<string, unknown>, parts: TranscriptPart[]) {
  const role = asString(msg.role);
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    pushText(parts, msg.reasoning_content, "thinking");
  }
  if (role === "tool") {
    parts.push({
      kind: "tool_result",
      id: asString(msg.tool_call_id) || asString(msg.id),
      name: typeof msg.name === "string" ? msg.name : undefined,
      output: msg.content ?? "",
    });
    return;
  }
  if (role === "system") {
    parseMessageContent(msg.content, parts);
    // Relabel last text as system if needed
    const last = parts[parts.length - 1];
    if (last?.kind === "text") {
      parts[parts.length - 1] = { kind: "system", text: last.text };
    }
    return;
  }
  parseMessageContent(msg.content, parts);
  if (msg.tool_calls) parseOpenAiToolCalls(msg.tool_calls, parts);
}

function parseResponsesItems(items: unknown, parts: TranscriptPart[]) {
  for (const item of asArray(items)) {
    const it = asRecord(item);
    if (!it) continue;
    const type = asString(it.type);
    if (type === "message" || type === "input_message") {
      parseMessageContent(it.content, parts);
    } else if (type === "reasoning") {
      const summary = asArray(it.summary)
        .map((s) => {
          const row = asRecord(s);
          return row ? textFromUnknown(row.text) : textFromUnknown(s);
        })
        .filter(Boolean)
        .join("\n");
      pushText(parts, summary || textFromUnknown(it.content ?? it.text), "thinking");
    } else if (type === "function_call" || type === "custom_tool_call") {
      let input: unknown = it.arguments ?? it.input ?? {};
      if (typeof input === "string") input = tryParseJson(input) ?? input;
      parts.push({
        kind: "tool_call",
        id: asString(it.call_id) || asString(it.id),
        name: asString(it.name, "tool"),
        input,
      });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      parts.push({
        kind: "tool_result",
        id: asString(it.call_id) || asString(it.id),
        output: it.output ?? it.content ?? "",
      });
    } else if (type === "output_text" || type === "input_text" || type === "text") {
      pushText(parts, textFromUnknown(it.text));
    }
  }
}

function parseGeminiParts(partsIn: unknown, out: TranscriptPart[]) {
  for (const part of asArray(partsIn)) {
    const p = asRecord(part);
    if (!p) continue;
    if (p.thought === true || p.thought === "true") {
      pushText(out, textFromUnknown(p.text), "thinking");
      continue;
    }
    if (typeof p.text === "string") {
      pushText(out, p.text);
      continue;
    }
    const fc = asRecord(p.functionCall ?? p.function_call);
    if (fc) {
      out.push({
        kind: "tool_call",
        id: asString(fc.id),
        name: asString(fc.name, "tool"),
        input: fc.args ?? fc.arguments ?? {},
      });
      continue;
    }
    const fr = asRecord(p.functionResponse ?? p.function_response);
    if (fr) {
      out.push({
        kind: "tool_result",
        id: asString(fr.id),
        name: typeof fr.name === "string" ? fr.name : undefined,
        output: fr.response ?? fr.content ?? "",
      });
    }
  }
}

function parseSseAssistant(raw: string, parts: TranscriptPart[]) {
  const blocks = new Map<
    number,
    { type: string; text: string; id?: string; name?: string; input?: string }
  >();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const obj = asRecord(tryParseJson(data));
    if (!obj) continue;
    const type = asString(obj.type);
    const index = typeof obj.index === "number" ? obj.index : 0;
    if (type === "content_block_start") {
      const block = asRecord(obj.content_block) ?? {};
      blocks.set(index, {
        type: asString(block.type, "text"),
        text: "",
        id: typeof block.id === "string" ? block.id : undefined,
        name: typeof block.name === "string" ? block.name : undefined,
        input: "",
      });
    } else if (type === "content_block_delta") {
      const delta = asRecord(obj.delta) ?? {};
      const cur = blocks.get(index) ?? { type: "text", text: "" };
      if (typeof delta.thinking === "string") cur.text += delta.thinking;
      if (typeof delta.text === "string") cur.text += delta.text;
      if (typeof delta.partial_json === "string")
        cur.input = (cur.input ?? "") + delta.partial_json;
      blocks.set(index, cur);
    } else if (type === "response.reasoning_text.delta" || type === "response.output_text.delta") {
      const cur = blocks.get(index) ?? {
        type: type.includes("reasoning") ? "thinking" : "text",
        text: "",
      };
      cur.text += textFromUnknown(obj.delta ?? obj.text);
      blocks.set(index, cur);
    }
  }
  if (blocks.size === 0) return false;
  for (const block of [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      pushText(parts, block.text, "thinking");
    } else if (block.type === "tool_use") {
      parts.push({
        kind: "tool_call",
        id: block.id ?? "",
        name: block.name ?? "tool",
        input: tryParseJson(block.input ?? "") ?? block.input ?? {},
      });
    } else {
      pushText(parts, block.text);
    }
  }
  return parts.length > 0;
}

function partsFromAssistantPayload(payload: unknown, rawFallback: string): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  const obj = asRecord(payload);
  if (!obj) {
    if (rawFallback.includes("data:")) {
      if (parseSseAssistant(rawFallback, parts)) return parts;
    }
    pushText(parts, rawFallback);
    return parts;
  }

  // Claude message
  if (obj.type === "message" || (obj.role === "assistant" && obj.content != null)) {
    parseClaudeBlocks(obj.content, parts);
    return parts;
  }

  // OpenAI chat.completion
  const choice0 = asRecord(asArray(obj.choices)[0]);
  if (choice0) {
    const message = asRecord(choice0.message) ?? asRecord(choice0.delta);
    if (message) parseChatMessage(message, parts);
    if (parts.length) return parts;
  }

  // Responses API
  const response = asRecord(obj.response) ?? obj;
  if (response.output || obj.type === "response.completed") {
    parseResponsesItems(response.output, parts);
    if (parts.length) return parts;
  }

  // Gemini
  const cand0 = asRecord(asArray(obj.candidates)[0]);
  const content = asRecord(cand0?.content);
  if (content?.parts) {
    parseGeminiParts(content.parts, parts);
    if (parts.length) return parts;
  }

  if (rawFallback.includes("data:")) {
    if (parseSseAssistant(rawFallback, parts)) return parts;
  }

  pushText(parts, textFromUnknown(payload));
  return parts;
}

function lastMessageOfRole(messages: unknown[], role: string): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = asRecord(messages[i]);
    if (msg && asString(msg.role) === role) return msg;
  }
  return null;
}

function partsFromRequestForRole(
  request: unknown,
  role: TranscriptRole,
  raw: string,
): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  const obj = asRecord(request);
  if (!obj) {
    pushText(parts, raw);
    return parts;
  }

  // Chat-style messages
  const messages = asArray(obj.messages);
  if (messages.length) {
    if (role === "user" || role === "unknown") {
      const lastUser = lastMessageOfRole(messages, "user");
      if (lastUser) {
        parseChatMessage(lastUser, parts);
        // Claude packs tool_result under user; keep as-is in parts.
        return parts.length ? parts : [{ kind: "raw", text: raw }];
      }
    }
    if (role === "assistant") {
      const lastAsst = lastMessageOfRole(messages, "assistant");
      if (lastAsst) {
        parseChatMessage(lastAsst, parts);
        return parts;
      }
    }
    if (role === "tool") {
      const lastTool = lastMessageOfRole(messages, "tool");
      if (lastTool) {
        parseChatMessage(lastTool, parts);
        return parts;
      }
    }
    if (role === "system") {
      const lastSys = lastMessageOfRole(messages, "system");
      if (lastSys) {
        parseChatMessage(lastSys, parts);
        return parts;
      }
    }
  }

  // Responses input list
  const input = asArray(obj.input);
  if (input.length) {
    // Take trailing contiguous items that match this hop.
    const trailing: unknown[] = [];
    for (let i = input.length - 1; i >= 0; i--) {
      trailing.unshift(input[i]);
      const it = asRecord(input[i]);
      const type = asString(it?.type);
      if (role === "user" && (type === "message" || type === "input_text")) break;
      if (
        role === "assistant" &&
        (type === "message" || type === "reasoning" || type === "function_call")
      ) {
        // keep collecting adjacent assistant artifacts then stop at user
        const prev = asRecord(input[i - 1]);
        if (prev && asString(prev.type) === "message" && asString(prev.role) === "user") break;
        continue;
      }
      if (role === "tool" && type.includes("output")) break;
      if (trailing.length > 6) break;
    }
    parseResponsesItems(trailing, parts);
    if (parts.length) return parts;
  }

  // Gemini contents
  const contents = asArray(obj.contents);
  if (contents.length) {
    const last = asRecord(contents[contents.length - 1]);
    if (last?.parts) {
      parseGeminiParts(last.parts, parts);
      if (parts.length) return parts;
    }
  }

  if (typeof obj.system === "string" && role === "system") {
    pushText(parts, obj.system, "system");
    return parts;
  }

  pushText(parts, raw);
  return parts;
}

function normalizeRole(role: string | undefined | null): TranscriptRole {
  switch ((role ?? "").toLowerCase()) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case "system":
      return "system";
    default:
      return "unknown";
  }
}

function hasStructuredParts(parts: TranscriptPart[]): boolean {
  return parts.some((p) => p.kind !== "raw" && !(p.kind === "text" && !p.text.trim()));
}

/** Expand one captured traffic hop into a T3-style transcript turn. */
export function turnFromTrafficEvent(ev: TrafficEvent): TranscriptTurn {
  const role = normalizeRole(ev.role);
  const bodies = splitTrafficBody(ev.content);
  const requestJson = tryParseJson(bodies.request === "(empty)" ? "" : bodies.request);
  const responseRaw = bodies.response ?? "";
  const responseJson = tryParseJson(responseRaw);

  let parts: TranscriptPart[] = [];

  if (role === "assistant" || (role === "unknown" && responseRaw)) {
    parts = partsFromAssistantPayload(responseJson, responseRaw || bodies.request);
    if (!hasStructuredParts(parts) && requestJson) {
      parts = partsFromRequestForRole(requestJson, "assistant", bodies.request);
    }
  } else {
    parts = partsFromRequestForRole(
      requestJson,
      role,
      bodies.request === "(empty)" ? (ev.content ?? "") : bodies.request,
    );
    // If the "user" hop is actually tool_result-only, keep role as user but parts as tool_result —
    // T3 still shows them as tool cards. If role was unknown and we found tool results, mark tool.
  }

  if (!hasStructuredParts(parts)) {
    const fallback = messageFallback(ev, bodies);
    parts = [{ kind: "text", text: fallback }];
  }

  // Promote pure tool_result turns.
  let displayRole = role;
  if (displayRole === "user" && parts.length > 0 && parts.every((p) => p.kind === "tool_result")) {
    displayRole = "tool";
  }

  const agent =
    ev.agent_id || ev.parent_agent_id || ev.request_class || ev.agent_type
      ? {
          agent_id: ev.agent_id,
          parent_agent_id: ev.parent_agent_id,
          request_class: ev.request_class,
          agent_type: ev.agent_type,
        }
      : undefined;

  return {
    id: ev.id,
    role: displayRole,
    model: ev.model,
    ts: ev.ts,
    statusCode: ev.status_code,
    parts,
    agent,
  };
}

function messageFallback(
  ev: TrafficEvent,
  bodies: { request: string; response: string | null },
): string {
  if (ev.role === "assistant" && bodies.response) return bodies.response;
  if (ev.role === "user") return bodies.request;
  if (bodies.response) return `${bodies.request}\n\n---\n\n${bodies.response}`;
  return bodies.request;
}

export function turnsFromTrafficEvents(events: TrafficEvent[]): TranscriptTurn[] {
  return events.map(turnFromTrafficEvent);
}

export function partsMatchQuery(parts: TranscriptPart[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.some((p) => {
    switch (p.kind) {
      case "text":
      case "thinking":
      case "system":
      case "raw":
        return p.text.toLowerCase().includes(needle);
      case "tool_call":
        return (
          p.name.toLowerCase().includes(needle) ||
          textFromUnknown(p.input).toLowerCase().includes(needle)
        );
      case "tool_result":
        return (
          (p.name ?? "").toLowerCase().includes(needle) ||
          textFromUnknown(p.output).toLowerCase().includes(needle)
        );
    }
  });
}
