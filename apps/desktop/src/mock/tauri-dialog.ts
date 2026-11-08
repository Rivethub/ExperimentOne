/** Vite alias target for `@tauri-apps/plugin-dialog` when `VITE_MOCK_IPC=1`. */
/* oxlint-disable eslint/no-console -- mock dialog logs to devtools */

export function open(opts?: {
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | string[] | null> {
  const first = opts?.filters?.[0];
  const ext = first?.extensions[0] ?? "json";
  const path =
    ext === "rivetbag" ? "/mock/imports/sample.rivetbag" : "/mock/credentials/vertex-sa.json";
  console.info("[mock dialog] open →", path, opts);
  return Promise.resolve(path);
}

export function ask(message: string, opts?: { title?: string; kind?: string }): Promise<boolean> {
  console.info("[mock dialog] ask", opts?.title ?? "confirm", message);
  return Promise.resolve(true);
}
