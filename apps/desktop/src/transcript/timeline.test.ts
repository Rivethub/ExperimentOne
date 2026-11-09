import { describe, expect, it } from "vite-plus/test";
import { turnFromCaptureEvent } from "./parse";
import { isShellTool, timelineFromTurns } from "./timeline";
import type { CaptureEvent } from "../lib/types";

function ev(partial: Partial<CaptureEvent> & Pick<CaptureEvent, "content" | "role">): CaptureEvent {
  return {
    id: partial.id ?? "1",
    ts: partial.ts ?? new Date().toISOString(),
    provider: partial.provider ?? "claude",
    model: partial.model ?? "claude-sonnet-4-5",
    tokens_in: 1,
    tokens_out: 1,
    status_code: 200,
    ...partial,
  };
}

describe("timelineFromTurns", () => {
  it("collapses Bash tool call + result into command_execution", () => {
    const req = JSON.stringify({
      messages: [{ role: "user", content: "list files" }],
    });
    const resp = JSON.stringify({
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Use the shell." },
        { type: "text", text: "Listing now." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "ls -la" },
        },
      ],
    });
    const assistant = turnFromCaptureEvent(
      ev({ id: "a", role: "assistant", content: `${req}\n---\n${resp}` }),
    );
    const toolResult = turnFromCaptureEvent(
      ev({
        id: "b",
        role: "user",
        content: JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: JSON.stringify({ stdout: "README.md\n", exit_code: 0 }),
                },
              ],
            },
          ],
        }),
      }),
    );
    const items = timelineFromTurns([assistant, toolResult]);
    expect(items.map((i) => i.kind)).toEqual([
      "reasoning",
      "assistant_message",
      "command_execution",
    ]);
    const cmd = items.find((i) => i.kind === "command_execution");
    expect(cmd).toMatchObject({
      kind: "command_execution",
      command: "ls -la",
      output: "README.md\n",
      exitCode: 0,
    });
  });

  it("detects shell tools by command input", () => {
    expect(isShellTool("Bash", { command: "pwd" })).toBe(true);
    expect(isShellTool("semantic_search", { query: "x" })).toBe(false);
    expect(isShellTool("run", { command: "echo hi" })).toBe(true);
  });
});
