/** True when the web UI should fake Tauri IPC (browser `vp run dev:mock`). */

/* oxlint-disable de-clank/no-environment-access-outside-boundary -- mock env boundary */

export type MockScenario = "default" | "empty" | "limit-hit" | "fresh";

const SCENARIO_KEY = "rivet.mockScenario";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isMockScenario(value: string): value is MockScenario {
  switch (value) {
    case "default": {
      return true;
    }
    case "empty": {
      return true;
    }
    case "limit-hit": {
      return true;
    }
    case "fresh": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function isMockIpc(): boolean {
  return import.meta.env.VITE_MOCK_IPC === "1" || import.meta.env.VITE_MOCK_IPC === "true";
}

export function getMockScenario(): MockScenario {
  const fromEnv = import.meta.env.VITE_MOCK_SCENARIO;
  if (isString(fromEnv) && isMockScenario(fromEnv)) {
    return fromEnv;
  }
  try {
    const stored = localStorage.getItem(SCENARIO_KEY);
    if (stored !== null && isMockScenario(stored)) {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return "default";
}

export function setMockScenario(scenario: MockScenario): void {
  try {
    localStorage.setItem(SCENARIO_KEY, scenario);
  } catch {
    /* ignore */
  }
  globalThis.location.reload();
}
