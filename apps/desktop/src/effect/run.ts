import { Cause, Effect, Exit } from "effect";
import { rivetErrorMessage, type RivetError } from "./errors";
import { AppLive } from "./layers";

/** Run an Effect at the React edge as a Promise (provides AppLive). */
export function runApp<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  // AppLive covers RivetIpc / HttpClient / KeyValueStore; remaining R is caller-owned.
  return Effect.runPromise(Effect.provide(effect, AppLive) as Effect.Effect<A, E>);
}

/** Run and map any failure to a user-facing string (never throws). */
export async function runAppExit<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<{ ok: true; value: A } | { ok: false; error: string }> {
  const exit = await Effect.runPromiseExit(Effect.provide(effect, AppLive) as Effect.Effect<A, E>);
  if (Exit.isSuccess(exit)) {
    return { ok: true, value: exit.value };
  }
  return { ok: false, error: causeMessage(exit.cause) };
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const [first] = Cause.prettyErrors(cause);
  if (first !== undefined && first.message !== "") {
    return first.message;
  }
  const squashed = Cause.squash(cause);
  return rivetErrorMessage(squashed);
}

export type AppEffect<A> = Effect.Effect<A, RivetError | Error>;
