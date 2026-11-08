import { describe, expect, it } from "vite-plus/test";
import { turnFromTrafficEvent } from "./parse";
import type { TrafficEvent } from "../types";

function ev(partial: Partial<TrafficEvent> & Pick<TrafficEvent, "content" | "role">): TrafficEvent {
  return {
    id: partial.id ?? "1",
    ts: partial.ts ?? new Date().toISOString(),
    provider: partial.provider ?? "claude",
    model: partial.model ?? "claude-sonnet-4-5",
    tokens_in: partial.tokens_in ?? 1,
    tokens_out: partial.tokens_out ?? 1,
    status_code: partial.status_code ?? 200,
    ...partial,
  };
}

describe("turnFromTrafficEvent", () => {
  it("parses Claude thinking + tool_use from response", () => {
    const req = JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "run pwd" }],
    });
    const resp = JSON.stringify({
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need shell access." },
        { type: "text", text: "Running pwd." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } },
      ],
    });
    const turn = turnFromTrafficEvent(ev({ role: "assistant", content: `${req}\n---\n${resp}` }));
    expect(turn.parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool_call"]);
    expect(turn.parts[0]).toMatchObject({ kind: "thinking", text: "Need shell access." });
    expect(turn.parts[2]).toMatchObject({ kind: "tool_call", name: "Bash" });
  });

  it("parses Claude tool_result under user role as tool turn", () => {
    const req = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "/tmp" }],
        },
      ],
    });
    const turn = turnFromTrafficEvent(ev({ role: "user", content: req }));
    expect(turn.role).toBe("tool");
    expect(turn.parts).toEqual([
      { kind: "tool_result", id: "toolu_1", output: "/tmp", isError: false },
    ]);
  });

  it("parses OpenAI reasoning_content and tool_calls", () => {
    const resp = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Looking up weather.",
            reasoning_content: "Call the weather tool.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
    });
    const turn = turnFromTrafficEvent(
      ev({ role: "assistant", provider: "codex", content: `{}\n---\n${resp}` }),
    );
    expect(turn.parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool_call"]);
    expect(turn.parts[2]).toMatchObject({
      kind: "tool_call",
      name: "get_weather",
      input: { city: "Paris" },
    });
  });

  it("falls back to plain text for demo content", () => {
    const turn = turnFromTrafficEvent(
      ev({ role: "user", content: "How do I inspect conversation history?" }),
    );
    expect(turn.parts).toEqual([{ kind: "text", text: "How do I inspect conversation history?" }]);
  });
});
