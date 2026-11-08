export type TranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      id: string;
      name?: string;
      output: unknown;
      isError?: boolean;
    }
  | { kind: "system"; text: string }
  | { kind: "raw"; text: string };

export type TranscriptRole = "user" | "assistant" | "tool" | "system" | "unknown";

export type TranscriptTurn = {
  id: string;
  role: TranscriptRole;
  model?: string | null;
  ts: string;
  statusCode?: number | null;
  parts: TranscriptPart[];
};

/** Flat activity items — mirrors T3 Code conversation timeline. */
export type TimelineItem =
  | {
      kind: "user_message";
      id: string;
      ts: string;
      text: string;
    }
  | {
      kind: "assistant_message";
      id: string;
      ts: string;
      text: string;
    }
  | {
      kind: "reasoning";
      id: string;
      ts: string;
      text: string;
    }
  | {
      kind: "command_execution";
      id: string;
      ts: string;
      command: string;
      output: string;
      exitCode?: number | null;
      isError?: boolean;
    }
  | {
      kind: "tool";
      id: string;
      ts: string;
      name: string;
      title: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
    }
  | {
      kind: "system";
      id: string;
      ts: string;
      text: string;
    };
