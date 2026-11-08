/** Vite alias target for `@tauri-apps/plugin-shell` when `VITE_MOCK_IPC=1`. */
/* oxlint-disable eslint/no-console -- mock shell logs to devtools */

export function open(url: string): Promise<void> {
  console.info("[mock shell] open", url);
  try {
    globalThis.dispatchEvent(new CustomEvent("rivet:mock-open-url", { detail: { url } }));
  } catch {
    /* ignore */
  }
  return Promise.resolve();
}
