import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { FileDiff, MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import type { ReactElement, ReactNode } from "react";
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

const DIFF_OPTS = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "dark",
  diffStyle: "unified",
  overflow: "wrap",
} as const;

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

function DiffShell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx(styles.t3ToolDiff, className)}>{children}</div>;
}

function PairDiff({ pair }: { pair: FilePair }): ReactElement {
  const oldFile = { name: pair.name, contents: pair.oldContents };
  const newFile = { name: pair.name, contents: pair.newContents };
  try {
    const fileDiff = parseDiffFromFile(oldFile, newFile);
    return (
      <DiffShell>
        <FileDiff fileDiff={fileDiff} options={DIFF_OPTS} disableWorkerPool />
      </DiffShell>
    );
  } catch {
    return (
      <DiffShell>
        <MultiFileDiff oldFile={oldFile} newFile={newFile} options={DIFF_OPTS} disableWorkerPool />
      </DiffShell>
    );
  }
}

function PatchView({ patch }: { patch: string }): ReactElement {
  const files = (() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return [];
    }
  })();

  if (files.length === 1 && files[0]) {
    return (
      <DiffShell>
        <FileDiff fileDiff={files[0]} options={DIFF_OPTS} disableWorkerPool />
      </DiffShell>
    );
  }

  return (
    <DiffShell>
      <PatchDiff patch={patch} options={DIFF_OPTS} disableWorkerPool />
    </DiffShell>
  );
}

/** Render a pierre diff when tool I/O looks like a file edit; otherwise null. */
export function ToolDiff({ value }: { value: unknown }): ReactElement | null {
  const detected = detectToolDiff(value);
  if (detected.kind === "pair") {
    return <PairDiff pair={detected.pair} />;
  }
  if (detected.kind === "patch") {
    return <PatchView patch={detected.patch} />;
  }
  return null;
}
