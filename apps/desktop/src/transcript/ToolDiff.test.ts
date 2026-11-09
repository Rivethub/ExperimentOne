import { describe, expect, it } from "vite-plus/test";
import { detectToolDiff } from "./ToolDiff";

describe("detectToolDiff", () => {
  it("detects unified patches", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    expect(detectToolDiff(patch)).toEqual({ kind: "patch", patch });
  });

  it("detects old/new string pairs from tool input", () => {
    expect(
      detectToolDiff({
        path: "src/app.ts",
        old_string: "a",
        new_string: "b",
      }),
    ).toEqual({
      kind: "pair",
      pair: { name: "src/app.ts", oldContents: "a", newContents: "b" },
    });
  });

  it("returns none for ordinary tool JSON so the timeline can show a JSON trace", () => {
    expect(detectToolDiff({ query: "quota burn" })).toEqual({ kind: "none" });
    expect(detectToolDiff("plain tool output")).toEqual({ kind: "none" });
  });
});
