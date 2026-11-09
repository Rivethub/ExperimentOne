import type { JSX } from "solid-js";
import {
  getMockScenario,
  isMockIpc,
  isMockScenario,
  setMockScenario,
  type MockScenario,
} from "./mode";
import { resetStore } from "./store";
import { Button } from "../ui";

const SCENARIOS: { id: MockScenario; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "limit-hit", label: "Limit hit" },
  { id: "empty", label: "Empty accounts" },
  { id: "fresh", label: "First-run" },
];

/** Floating control strip — only mounted under `VITE_MOCK_IPC`. */
export function MockDevBar(): JSX.Element | null {
  if (!isMockIpc()) {
    return null;
  }
  const current = getMockScenario();

  return (
    <div
      class="fixed top-2.5 right-3 z-[80] flex items-center gap-2 rounded-lg border border-orange-500/45 bg-[color-mix(in_srgb,#18181b_92%,#f97316)] px-2.5 py-1.5 text-xs text-foreground shadow-lg"
      role="region"
      aria-label="Mock IPC controls"
    >
      <strong class="font-semibold tracking-wide">Mock IPC</strong>
      <span class="opacity-45">·</span>
      <label class="inline-flex items-center gap-1.5">
        Scenario
        <select
          class="rounded-md border border-white/12 bg-black/25 px-1.5 py-0.5 text-inherit"
          value={current}
          onChange={(e) => {
            const next = e.target.value;
            if (isMockScenario(next)) {
              setMockScenario(next);
            }
          }}
        >
          {SCENARIOS.map((s) => (
            <option value={s.id}>{s.label}</option>
          ))}
        </select>
      </label>
      <Button
        variant="ghost"
        onClick={() => {
          resetStore(current);
          globalThis.location.reload();
        }}
      >
        Reseed
      </Button>
    </div>
  );
}
