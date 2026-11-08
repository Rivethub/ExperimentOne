import { Cause, Effect, Exit } from "effect";
import { rivetErrorMessage, type RivetError } from "./errors";

/** Run an Effect at the React edge as a Promise. */
export function runApp<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/** Run and map any failure to a user-facing string (never throws). */
export async function runAppExit<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<{ ok: true; value: A } | { ok: false; error: string }> {
  const exit = await Effect.runPromiseExit(effect);
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
