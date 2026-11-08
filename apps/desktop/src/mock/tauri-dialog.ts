/** Vite alias target for `@tauri-apps/plugin-dialog` when `VITE_MOCK_IPC=1`. */

export async function open(opts?: {
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | string[] | null> {
  const ext = opts?.filters?.[0]?.extensions?.[0] ?? "json";
  const path =
    ext === "rivetbag" ? "/mock/imports/sample.rivetbag" : "/mock/credentials/vertex-sa.json";
  console.info("[mock dialog] open →", path, opts);
  return path;
}

export async function ask(
  message: string,
  opts?: { title?: string; kind?: string },
): Promise<boolean> {
  console.info("[mock dialog] ask", opts?.title ?? "confirm", message);
  // Auto-confirm in mock so Remove / destructive flows are exercisable.
  return true;
}
