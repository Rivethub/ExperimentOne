/** Promise-facing bridge over the Effect IPC layer (React edge / legacy call sites). */

import { Effect, Exit } from "effect";
import { rivetErrorMessage } from "./effect/errors";
import { apiRequest, ensureRivetd } from "./effect/ipc";
import { runApp } from "./effect/run";

export type ApiResult = {
  ok: boolean;
  status: number;
  json: <T = unknown>() => Promise<T>;
  text: () => Promise<string>;
};

/** Ensure rivetd is up (spawn if needed). */
export async function ensureBackend(): Promise<boolean> {
  const exit = await Effect.runPromiseExit(ensureRivetd);
  return Exit.isSuccess(exit);
}

/**
 * Call a rivetd `/v1/...` route via the Tauri host.
 * Auth is injected in Rust — the webview never sees the access key or HTTP URL.
 */
export async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await runApp(apiRequest(method, path, body));
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      async json<T = unknown>() {
        if (!res.body) return undefined as T;
        return JSON.parse(res.body) as T;
      },
      async text() {
        return res.body;
      },
    };
  } catch (err) {
    throw new Error(rivetErrorMessage(err));
  }
}
