/** Vite alias target for `@tauri-apps/plugin-shell` when `VITE_MOCK_IPC=1`. */

export async function open(url: string): Promise<void> {
  console.info("[mock shell] open", url);
  // Surface the URL in-page for OAuth flows without leaving the mock UI.
  try {
    window.dispatchEvent(new CustomEvent("rivet:mock-open-url", { detail: { url } }));
  } catch {
    /* ignore */
  }
}
