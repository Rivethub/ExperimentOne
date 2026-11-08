import { Data } from "effect";
import { hasStringMessage, isRecord, isString } from "../guards";

export { hasStringMessage } from "../guards";

/** Tauri invoke failed or returned an unexpected shape. */
export class IpcError extends Data.TaggedError("IpcError")<{
  readonly command: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const { cause } = this;
    if (cause instanceof Error) {
      return cause.message;
    }
    if (isString(cause)) {
      return cause;
    }
    return `${this.command} failed`;
  }
}

/** rivetd is not reachable / ensure_rivetd returned false. */
export class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly detail?: string;
}> {
  override get message(): string {
    return this.detail ?? "Could not reach rivetd — start it with cargo run -p rivet-runtime";
  }
}

function readApiErrorText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const errText = value["error"];
  return isString(errText) ? errText : undefined;
}

/** Control-plane `/v1` response was non-2xx or body was invalid. */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body?: string;
}> {
  override get message(): string {
    const { body } = this;
    if (body !== undefined && body !== "") {
      try {
        const parsed: unknown = JSON.parse(body);
        const errText = readApiErrorText(parsed);
        if (errText !== undefined && errText !== "") {
          return errText;
        }
      } catch {
        /* plain text */
      }
      const trimmed = body.trim();
      if (trimmed !== "") {
        return trimmed.slice(0, 240);
      }
    }
    return `${this.method} ${this.path} failed (${this.status})`;
  }
}

export type RivetError = IpcError | BackendUnavailable | ApiError;

export function rivetErrorMessage(err: unknown): string {
  if (hasStringMessage(err)) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** True when the UI should clear a transient “backend down” banner. */
export function isTransientReachabilityMessage(msg: string): boolean {
  return (
    msg.includes("Could not reach rivetd") ||
    msg.startsWith("status ") ||
    msg.includes("Failed to fetch") ||
    msg.includes("Load failed") ||
    msg.includes("NetworkError") ||
    msg.includes("BackendUnavailable")
  );
}
