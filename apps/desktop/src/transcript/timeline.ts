import type { CaptureEvent } from "../lib/types";
import { partsMatchQuery, turnsFromCaptureEvents } from "./parse";
import type { TimelineItem, TranscriptPart, TranscriptTurn } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

const SHELL_NAMES =
  /^(bash|shell|terminal|run_terminal_cmd|execute_command|exec_command|run_command)$/i;

export function isShellTool(name: string, input: unknown): boolean {
  if (SHELL_NAMES.test(name)) return true;
  const rec = asRecord(input);
  return Boolean(rec && (typeof rec.command === "string" || typeof rec.cmd === "string"));
}

export function shellCommandFromInput(input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return textFromUnknown(input);
  const cmd = rec.command ?? rec.cmd ?? rec.script;
  if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
  return textFromUnknown(input);
}

export function parseShellOutput(output: unknown): {
  output: string;
  exitCode: number | null;
  isError: boolean;
} {
  if (typeof output === "string") {
    const parsed = (() => {
      try {
        return JSON.parse(output) as unknown;
      } catch {
        return null;
      }
    })();
    if (parsed) return parseShellOutput(parsed);
    return { output, exitCode: null, isError: false };
  }
  const rec = asRecord(output);
  if (!rec) {
    const text = textFromUnknown(output);
    return { output: text, exitCode: null, isError: false };
  }
  const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
  const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
  const exitRaw = rec.exit_code ?? rec.exitCode ?? rec.status ?? rec.code;
  const exitCode = typeof exitRaw === "number" ? exitRaw : null;
  const chunks = [stdout, stderr].filter(Boolean);
  const body = chunks.length ? chunks.join(stderr ? "\n" : "") : textFromUnknown(output);
  return {
    output: body,
    exitCode,
    isError: Boolean(rec.is_error) || (exitCode != null && exitCode !== 0),
  };
}

function toolTitle(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return name;
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "target_file",
    "query",
    "pattern",
    "glob",
    "url",
  ]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) {
      const short = v.length > 64 ? `${v.slice(0, 64)}…` : v;
      return `${name} · ${short}`;
    }
  }
  if (typeof rec.command === "string") return `${name} · ${rec.command.slice(0, 64)}`;
  return name;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? text;
  return line.length > 96 ? `${line.slice(0, 96)}…` : line;
}

/** Flatten turns into a T3-style activity timeline (pairs tool call + result). */
export function timelineFromTurns(turns: TranscriptTurn[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const pendingCalls = new Map<string, { itemIndex: number; name: string }>();

  const pushToolOrCommand = (
    id: string,
    ts: string,
    name: string,
    input: unknown,
    output?: unknown,
    isError?: boolean,
    agent?: TranscriptTurn["agent"],
  ) => {
    if (isShellTool(name, input)) {
      const command = shellCommandFromInput(input);
      const shell =
        output === undefined
          ? { output: "", exitCode: null as number | null, isError: false }
          : parseShellOutput(output);
      items.push({
        kind: "command_execution",
        id,
        ts,
        command,
        output: shell.output,
        exitCode: shell.exitCode,
        isError: isError || shell.isError,
        agent,
      });
      return;
    }
    items.push({
      kind: "tool",
      id,
      ts,
      name,
      title: toolTitle(name, input),
      input,
      output,
      isError,
      agent,
    });
  };

  for (const turn of turns) {
    const consumed = new Set<number>();
    const agent = turn.agent;
    for (let i = 0; i < turn.parts.length; i++) {
      if (consumed.has(i)) continue;
      const part = turn.parts[i]!;
      const id = `${turn.id}:${i}`;
      switch (part.kind) {
        case "text":
        case "raw":
          if (!part.text.trim()) break;
          items.push({
            kind: turn.role === "user" ? "user_message" : "assistant_message",
            id,
            ts: turn.ts,
            text: part.text,
            agent,
          });
          break;
        case "system":
          items.push({ kind: "system", id, ts: turn.ts, text: part.text, agent });
          break;
        case "thinking":
          items.push({ kind: "reasoning", id, ts: turn.ts, text: part.text, agent });
          break;
        case "tool_call": {
          let resultIndex = -1;
          for (let j = i + 1; j < turn.parts.length; j++) {
            const p = turn.parts[j]!;
            if (p.kind === "tool_result" && (!part.id || p.id === part.id)) {
              resultIndex = j;
              break;
            }
          }
          if (resultIndex >= 0) {
            const result = turn.parts[resultIndex] as Extract<
              TranscriptPart,
              { kind: "tool_result" }
            >;
            consumed.add(resultIndex);
            pushToolOrCommand(
              id,
              turn.ts,
              part.name,
              part.input,
              result.output,
              result.isError,
              agent,
            );
          } else if (part.id) {
            pendingCalls.set(part.id, { itemIndex: items.length, name: part.name });
            pushToolOrCommand(id, turn.ts, part.name, part.input, undefined, undefined, agent);
          } else {
            pushToolOrCommand(id, turn.ts, part.name, part.input, undefined, undefined, agent);
          }
          break;
        }
        case "tool_result": {
          const pending = part.id ? pendingCalls.get(part.id) : undefined;
          if (pending) {
            const existing = items[pending.itemIndex];
            if (existing?.kind === "command_execution") {
              const shell = parseShellOutput(part.output);
              items[pending.itemIndex] = {
                ...existing,
                output: shell.output,
                exitCode: shell.exitCode,
                isError: part.isError || shell.isError,
                agent: existing.agent ?? agent,
              };
            } else if (existing?.kind === "tool") {
              items[pending.itemIndex] = {
                ...existing,
                output: part.output,
                isError: part.isError,
                agent: existing.agent ?? agent,
              };
            }
            pendingCalls.delete(part.id);
          } else {
            // Orphan result — show as tool with empty input.
            pushToolOrCommand(
              id,
              turn.ts,
              part.name ?? "tool",
              {},
              part.output,
              part.isError,
              agent,
            );
          }
          break;
        }
      }
    }
  }

  // Merge consecutive assistant_message / reasoning stays separate (T3 shows them as discrete rows).
  return items;
}

export function timelineFromCaptureEvents(events: CaptureEvent[]): TimelineItem[] {
  return timelineFromTurns(turnsFromCaptureEvents(events));
}

export function timelineItemMatchesQuery(item: TimelineItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "system":
      return item.text.toLowerCase().includes(needle);
    case "command_execution":
      return (
        item.command.toLowerCase().includes(needle) || item.output.toLowerCase().includes(needle)
      );
    case "tool":
      return (
        item.name.toLowerCase().includes(needle) ||
        item.title.toLowerCase().includes(needle) ||
        textFromUnknown(item.input).toLowerCase().includes(needle) ||
        textFromUnknown(item.output).toLowerCase().includes(needle)
      );
  }
}

export function filterTimeline(items: TimelineItem[], query: string): TimelineItem[] {
  if (!query.trim()) return items;
  return items.filter((item) => timelineItemMatchesQuery(item, query));
}

/** Keep partsMatchQuery available via turns for search that runs before flatten. */
export function turnsMatchQuery(turns: TranscriptTurn[], query: string): boolean {
  return turns.some((t) => partsMatchQuery(t.parts, query));
}

export function reasoningPreview(text: string): string {
  const line = firstLine(text.trim());
  return line || "Thought";
}
