/** Vite alias target for `@tauri-apps/api/core` when `VITE_MOCK_IPC=1`. */

import { handleApiRequest } from "./handlers";
import { getStore } from "./store";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "ensure_rivetd":
      return true as T;
    case "api_request": {
      const method = asString(args?.method, "GET");
      const path = asString(args?.path);
      const bodyRaw = args?.body;
      const body =
        typeof bodyRaw === "string" ? bodyRaw : bodyRaw == null ? null : JSON.stringify(bodyRaw);
      const res = await handleApiRequest(method, path, body);
      return res as T;
    }
    case "open_wiki_dir": {
      const path = asString(args?.path);
      console.info("[mock IPC] open_wiki_dir", path);
      return true as T;
    }
    case "reveal_path": {
      const path = asString(args?.path);
      console.info("[mock IPC] reveal_path", path);
      getStore().lastExportPath = path;
      return true as T;
    }
    default:
      console.warn(`[mock IPC] unknown command: ${cmd}`, args);
      throw new Error(`mock IPC: unknown command ${cmd}`);
  }
}
