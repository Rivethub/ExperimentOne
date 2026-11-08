import type { ReactElement } from "react";
import {
  getMockScenario,
  isMockIpc,
  isMockScenario,
  setMockScenario,
  type MockScenario,
} from "./mode";
import { resetStore } from "./store";
import { Button } from "../ui";
import styles from "../styles/app.module.css";

const SCENARIOS: { id: MockScenario; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "limit-hit", label: "Limit hit" },
  { id: "empty", label: "Empty accounts" },
  { id: "fresh", label: "First-run" },
];

/** Floating control strip — only mounted under `VITE_MOCK_IPC`. */
export function MockDevBar(): ReactElement | null {
  if (!isMockIpc()) {
    return null;
  }
  const current = getMockScenario();

  return (
    <div className={styles.mockDevBar} role="region" aria-label="Mock IPC controls">
      <strong>Mock IPC</strong>
      <span className={styles.mockDevBarSep}>·</span>
      <label>
        Scenario
        <select
          value={current}
          onChange={(e) => {
            const next = e.target.value;
            if (isMockScenario(next)) {
              setMockScenario(next);
            }
          }}
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
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
