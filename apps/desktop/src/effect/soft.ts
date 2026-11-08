import { Effect } from "effect";

/** Optional reads — failures become `null` so dashboards can paint partial data. */
export function softEffect<A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A | null> {
  return effect.pipe(Effect.catch(() => Effect.succeed(null)));
}
