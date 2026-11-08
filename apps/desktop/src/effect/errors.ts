import { Data } from "effect";

/** Tauri invoke failed or returned an unexpected shape. */
export class IpcError extends Data.TaggedError("IpcError")<{
  readonly command: string;
  readonly cause: unknown;
}> {
  get message(): string {
    const c = this.cause;
    if (c instanceof Error) return c.message;
    if (typeof c === "string") return c;
    return `${this.command} failed`;
  }
}

/** rivetd is not reachable / ensure_rivetd returned false. */
export class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly detail?: string;
}> {
  get message(): string {
    return this.detail ?? "Could not reach rivetd — start it with cargo run -p rivet-runtime";
  }
}

/** Control-plane `/v1` response was non-2xx or body was invalid. */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body?: string;
}> {
  get message(): string {
    if (this.body) {
      try {
        const parsed = JSON.parse(this.body) as { error?: string };
        if (parsed.error) return parsed.error;
      } catch {
        /* plain text */
      }
      if (this.body.trim()) return this.body.trim().slice(0, 240);
    }
    return `${this.method} ${this.path} failed (${this.status})`;
  }
}

export type RivetError = IpcError | BackendUnavailable | ApiError;

export function rivetErrorMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  if (err instanceof Error) return err.message;
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
