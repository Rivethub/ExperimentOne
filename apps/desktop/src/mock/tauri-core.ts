/** Vite alias target for `@tauri-apps/api/core` when `VITE_MOCK_IPC=1`. */
/* oxlint-disable eslint/no-console -- mock IPC logs to devtools */

import type { JsonObject } from "../jsonTypes";
import { isDefined } from "../nullish";
import { handleApiRequest, type MockHttpResult } from "./handlers";
import { getStore } from "./store";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function asString(value: unknown, fallback = ""): string {
  return isString(value) ? value : fallback;
}

function serializeBody(bodyRaw: unknown): string | null {
  if (isString(bodyRaw)) {
    return bodyRaw;
  }
  if (!isDefined(bodyRaw)) {
    return null;
  }
  return JSON.stringify(bodyRaw);
}

export function invoke(
  cmd: "ensure_rivetd" | "open_wiki_dir" | "reveal_path",
  args?: JsonObject,
): Promise<boolean>;
export function invoke(cmd: "api_request", args?: JsonObject): Promise<MockHttpResult>;
export function invoke(cmd: string, args?: JsonObject): Promise<boolean | MockHttpResult>;
export function invoke(cmd: string, args?: JsonObject): Promise<boolean | MockHttpResult> {
  switch (cmd) {
    case "ensure_rivetd": {
      return Promise.resolve(true);
    }
    case "api_request": {
      const method = asString(args?.method, "GET");
      const path = asString(args?.path);
      const bodyArg: unknown = args?.body;
      const body = serializeBody(bodyArg);
      return handleApiRequest(method, path, body);
    }
    case "open_wiki_dir": {
      const wikiPath = asString(args?.path);
      console.info("[mock IPC] open_wiki_dir", wikiPath);
      return Promise.resolve(true);
    }
    case "reveal_path": {
      const revealPath = asString(args?.path);
      console.info("[mock IPC] reveal_path", revealPath);
      getStore().lastExportPath = revealPath;
      return Promise.resolve(true);
    }
    default: {
      console.warn(`[mock IPC] unknown command: ${cmd}`, args);
      return Promise.reject(new Error(`mock IPC: unknown command ${cmd}`));
    }
  }
}
