/**
 * Browser-only fake Tauri IPC for UI work without rivetd.
 *
 *   cd apps/desktop && bun run dev:mock
 *   # optional: VITE_MOCK_SCENARIO=limit-hit|empty|fresh|default
 *
 * Vite aliases `@tauri-apps/api/core`, `plugin-dialog`, and `plugin-shell`
 * to the mocks in this folder when `VITE_MOCK_IPC=1`.
 */
export { MockDevBar } from "./MockDevBar";
export { getMockScenario, isMockIpc, setMockScenario, type MockScenario } from "./mode";
export { getStore, resetStore } from "./store";
