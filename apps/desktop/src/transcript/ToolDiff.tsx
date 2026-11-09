import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

type FilePair = {
  name: string;
  oldContents: string;
  newContents: string;
};

type ToolDiffKind =
  | { kind: "pair"; pair: FilePair }
  | { kind: "patch"; patch: string }
  | { kind: "none" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function looksLikeUnifiedDiff(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("diff --git ") || t.startsWith("--- ") || t.startsWith("+++ ")) {
    return true;
  }
  return /^@@\s+-\d+/mu.test(t) && (t.includes("\n-") || t.includes("\n+"));
}

function fileNameFrom(record: Record<string, unknown>, fallback = "file"): string {
  return (
    stringField(record, "path", "file_path", "filePath", "file", "filename", "name") ?? fallback
  );
}

function pairFromRecord(record: Record<string, unknown>): FilePair | null {
  const oldString = stringField(record, "old_string", "oldString", "before", "old", "old_content");
  const newString = stringField(record, "new_string", "newString", "after", "new", "new_content");
  if (oldString === null || newString === null) {
    return null;
  }
  return {
    name: fileNameFrom(record),
    oldContents: oldString,
    newContents: newString,
  };
}

function detectToolDiff(value: unknown): ToolDiffKind {
  if (typeof value === "string" && looksLikeUnifiedDiff(value)) {
    return { kind: "patch", patch: value };
  }

  const record = asRecord(value);
  if (!record) {
    return { kind: "none" };
  }

  const pair = pairFromRecord(record);
  if (pair) {
    return { kind: "pair", pair };
  }

  const patch = stringField(record, "diff", "patch", "unified_diff", "unifiedDiff");
  if (patch !== null && looksLikeUnifiedDiff(patch)) {
    return { kind: "patch", patch };
  }

  return { kind: "none" };
}

function DiffShell(props: { class?: string; children: JSX.Element }): JSX.Element {
  return <div class={cx(styles.t3ToolDiff, props.class)}>{props.children}</div>;
}

function PairDiff(props: { pair: FilePair }): JSX.Element {
  return (
    <DiffShell>
      <div class={styles.t3ToolCaption}>{props.pair.name}</div>
      <pre
        class={styles.t3ToolPre}
      >{`--- a/${props.pair.name}\n+++ b/${props.pair.name}\n@@\n${props.pair.oldContents
        .split("\n")
        .map((line) => `-${line}`)
        .join("\n")}\n${props.pair.newContents
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}`}</pre>
    </DiffShell>
  );
}

function PatchView(props: { patch: string }): JSX.Element {
  return (
    <DiffShell>
      <pre class={styles.t3ToolPre}>{props.patch}</pre>
    </DiffShell>
  );
}

/** Render a text diff when tool I/O looks like a file edit; otherwise null. */
export function ToolDiff(props: { value: unknown }): JSX.Element {
  const detected = () => detectToolDiff(props.value);
  return (
    <Show when={detected().kind !== "none"} fallback={null}>
      <Show when={detected().kind === "pair"}>
        <PairDiff pair={(detected() as { kind: "pair"; pair: FilePair }).pair} />
      </Show>
      <Show when={detected().kind === "patch"}>
        <PatchView patch={(detected() as { kind: "patch"; patch: string }).patch} />
      </Show>
    </Show>
  );
}
