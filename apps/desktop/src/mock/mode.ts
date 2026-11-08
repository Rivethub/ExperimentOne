/** True when the web UI should fake Tauri IPC (browser `vp run dev:mock`). */

export type MockScenario = "default" | "empty" | "limit-hit" | "fresh";

const SCENARIO_KEY = "rivet.mockScenario";

export function isMockIpc(): boolean {
  return import.meta.env.VITE_MOCK_IPC === "1" || import.meta.env.VITE_MOCK_IPC === "true";
}

export function getMockScenario(): MockScenario {
  const fromEnv = import.meta.env.VITE_MOCK_SCENARIO as string | undefined;
  if (
    fromEnv === "empty" ||
    fromEnv === "limit-hit" ||
    fromEnv === "fresh" ||
    fromEnv === "default"
  ) {
    return fromEnv;
  }
  try {
    const stored = localStorage.getItem(SCENARIO_KEY);
    if (
      stored === "empty" ||
      stored === "limit-hit" ||
      stored === "fresh" ||
      stored === "default"
    ) {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return "default";
}

export function setMockScenario(scenario: MockScenario) {
  try {
    localStorage.setItem(SCENARIO_KEY, scenario);
  } catch {
    /* ignore */
  }
  // Soft reload so fixtures re-seed cleanly.
  window.location.reload();
}
