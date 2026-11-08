import { Effect } from "effect";
import { isString } from "../guards";
import type { JsonObject } from "../jsonTypes";
import { ApiError, BackendUnavailable, IpcError } from "./errors";

export type IpcResponse = {
  status: number;
  body: string;
  content_type: string;
};

export type SoftHttpResult = {
  ok: boolean;
  status: number;
  body: string;
  json: <T = unknown>() => T | undefined;
  text: () => string;
};

function encodeBody(body: unknown): string | null {
  if (body === undefined) {
    return null;
  }
  if (isString(body)) {
    return body;
  }
  return JSON.stringify(body);
}

const invokeRaw = <T>(command: string, args?: JsonObject) =>
  Effect.tryPromise({
    try: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>(command, args);
    },
    catch: (cause) => new IpcError({ command, cause }),
  });

/** Ensure rivetd is up (spawn if needed). */
export const ensureRivetd: Effect.Effect<void, BackendUnavailable> = Effect.gen(
  function* runEnsureRivetd() {
    const up = yield* Effect.tryPromise({
      try: async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        return invoke<boolean>("ensure_rivetd");
      },
      catch: (cause) =>
        new BackendUnavailable({
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    if (!up) {
      yield* Effect.fail(new BackendUnavailable({}));
    }
  },
);

export const apiRequest = (
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<IpcResponse, ApiError | IpcError> =>
  Effect.gen(function* runApiRequest() {
    if (!path.startsWith("/v1/")) {
      return yield* Effect.fail(
        new ApiError({
          method,
          path,
          status: 400,
          body: `api path must start with /v1/ (got ${path})`,
        }),
      );
    }
    const payload = encodeBody(body);
    return yield* invokeRaw<IpcResponse>("api_request", {
      method,
      path,
      body: payload,
    });
  });

/** GET/POST/… that requires 2xx; returns parsed JSON. */
export const apiJson = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<T, ApiError | IpcError> =>
  Effect.gen(function* runApiJson() {
    const res = yield* apiRequest(method, path, body);
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(new ApiError({ method, path, status: res.status, body: res.body }));
    }
    if (res.body === "") {
      // JUSTIFICATION: empty 2xx bodies are valid for some rivetd routes; callers use T | undefined.
      return undefined as T;
    }
    try {
      // JUSTIFICATION: rivetd returns JSON bodies validated by the control API contract.
      return JSON.parse(res.body) as T;
    } catch (cause) {
      return yield* Effect.fail(
        new ApiError({
          method,
          path,
          status: res.status,
          body: `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    }
  });

/** Soft read — does not fail on HTTP errors (callers inspect `ok`). */
export const apiResult = (
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<SoftHttpResult, IpcError | ApiError> =>
  Effect.gen(function* runApiResult() {
    const res = yield* apiRequest(method, path, body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body: res.body,
      json<T = unknown>() {
        if (res.body === "") {
          return undefined;
        }
        // JUSTIFICATION: callers only parse known log/status JSON shapes from rivetd.
        return JSON.parse(res.body) as T;
      },
      text() {
        return res.body;
      },
    };
  });

export const apiText = (
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<string, ApiError | IpcError> =>
  Effect.gen(function* runApiText() {
    const res = yield* apiRequest(method, path, body);
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(new ApiError({ method, path, status: res.status, body: res.body }));
    }
    return res.body;
  });

export const invokeCommand = <T>(
  command: string,
  args?: JsonObject,
): Effect.Effect<T, IpcError> => invokeRaw<T>(command, args);
