import { Context, Effect, Layer, Schema } from "effect";
import { isString } from "../lib/guards";
import type { JsonObject } from "../lib/json-types";
import { ApiError, BackendUnavailable, IpcError } from "./errors";

export type IpcResponse = {
  status: number;
  body: string;
  content_type: string;
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

type RivetIpcShape = {
  readonly ensure: Effect.Effect<void, BackendUnavailable>;
  readonly apiRequest: (
    method: string,
    path: string,
    body?: unknown,
  ) => Effect.Effect<IpcResponse, ApiError | IpcError>;
  readonly invoke: <T>(command: string, args?: JsonObject) => Effect.Effect<T, IpcError>;
};

/** Tauri IPC surface used by control-plane Effect ops. */
export class RivetIpc extends Context.Service<RivetIpc, RivetIpcShape>()("rivet/RivetIpc") {}

function makeInvokeRaw<T>(command: string, args?: JsonObject): Effect.Effect<T, IpcError> {
  return Effect.tryPromise({
    try: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>(command, args);
    },
    catch: (cause) => new IpcError({ command, cause }),
  });
}

function makeRivetIpc(): RivetIpcShape {
  const invokeRaw = <T>(command: string, args?: JsonObject) => makeInvokeRaw<T>(command, args);

  const ensure: Effect.Effect<void, BackendUnavailable> = Effect.gen(function* runEnsureRivetd() {
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
      return yield* new BackendUnavailable({});
    }
  });

  const apiRequest = (
    method: string,
    path: string,
    body?: unknown,
  ): Effect.Effect<IpcResponse, ApiError | IpcError> =>
    Effect.gen(function* runApiRequest() {
      if (!path.startsWith("/v1/")) {
        return yield* new ApiError({
          method,
          path,
          status: 400,
          body: `api path must start with /v1/ (got ${path})`,
        });
      }
      const payload = encodeBody(body);
      return yield* invokeRaw<IpcResponse>("api_request", {
        method,
        path,
        body: payload,
      });
    });

  return RivetIpc.of({ ensure, apiRequest, invoke: invokeRaw });
}

/** Live Tauri-backed IPC layer. */
export const RivetIpcLive: Layer.Layer<RivetIpc> = Layer.sync(RivetIpc, makeRivetIpc);

/** Ensure rivetd is up (spawn if needed). */
export const ensureRivetd: Effect.Effect<void, BackendUnavailable, RivetIpc> = Effect.gen(
  function* runEnsure() {
    const ipc = yield* RivetIpc;
    yield* ipc.ensure;
  },
);

export const apiRequest = (
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<IpcResponse, ApiError | IpcError, RivetIpc> =>
  Effect.gen(function* runApiRequestViaService() {
    const ipc = yield* RivetIpc;
    return yield* ipc.apiRequest(method, path, body);
  });

/** GET/POST/… that requires 2xx; returns parsed JSON. */
export const apiJson = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<T, ApiError | IpcError, RivetIpc> =>
  Effect.gen(function* runApiJson() {
    const res = yield* apiRequest(method, path, body);
    if (res.status < 200 || res.status >= 300) {
      return yield* new ApiError({ method, path, status: res.status, body: res.body });
    }
    if (res.body === "") {
      // JUSTIFICATION: empty 2xx bodies are valid for some rivetd routes; callers use T | undefined.
      return undefined as T;
    }
    return yield* Effect.try({
      try: () => {
        // JUSTIFICATION: rivetd returns JSON bodies validated by the control API contract.
        return JSON.parse(res.body) as T;
      },
      catch: (cause) =>
        new ApiError({
          method,
          path,
          status: res.status,
          body: `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
  });

/** Like `apiJson`, then `Schema.decodeUnknownEffect` on the parsed body. */
export const apiJsonSchema = <S extends Schema.Top>(
  method: string,
  path: string,
  schema: S,
  body?: unknown,
): Effect.Effect<S["Type"], ApiError | IpcError, RivetIpc | S["DecodingServices"]> =>
  Effect.gen(function* runApiJsonSchema() {
    const res = yield* apiRequest(method, path, body);
    if (res.status < 200 || res.status >= 300) {
      return yield* new ApiError({ method, path, status: res.status, body: res.body });
    }
    const raw: unknown = yield* Effect.try({
      try: () => (res.body === "" ? undefined : (JSON.parse(res.body) as unknown)),
      catch: (cause) =>
        new ApiError({
          method,
          path,
          status: res.status,
          body: `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    return yield* Effect.mapError(Schema.decodeUnknownEffect(schema)(raw), (err) => {
      return new ApiError({
        method,
        path,
        status: res.status,
        body: `schema: ${String(err)}`,
      });
    });
  });

export const apiText = (
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<string, ApiError | IpcError, RivetIpc> =>
  Effect.gen(function* runApiText() {
    const res = yield* apiRequest(method, path, body);
    if (res.status < 200 || res.status >= 300) {
      return yield* new ApiError({ method, path, status: res.status, body: res.body });
    }
    return res.body;
  });

export const invokeCommand = <T>(
  command: string,
  args?: JsonObject,
): Effect.Effect<T, IpcError, RivetIpc> =>
  Effect.gen(function* runInvokeCommand() {
    const ipc = yield* RivetIpc;
    return yield* ipc.invoke<T>(command, args);
  });
