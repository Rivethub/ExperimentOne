import { Effect } from "effect";

/** Last soft-failure cause (tests/diagnostics); dashboards only need null. */
let lastSoftFailure: unknown;

export function peekSoftFailure(): unknown {
  return lastSoftFailure;
}

/** Optional reads — failures become `null` so dashboards can paint partial data. */
export function softEffect<A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A | null> {
  return effect.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => {
        lastSoftFailure = cause;
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
}
