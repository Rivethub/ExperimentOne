import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import { Effect } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import type { OnboardingStatus } from "./types";

const ONBOARDING_DISMISS_KEY = "rivet.onboarding.dismissed";

const withLocalStorage = <A, E>(effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>) =>
  Effect.provide(effect, BrowserKeyValueStore.layerLocalStorage);

/** Read dismiss flag via Effect KeyValueStore (localStorage). */
export function isOnboardingDismissed(): boolean {
  return Effect.runSync(
    withLocalStorage(
      Effect.gen(function* readDismissed() {
        const kv = yield* KeyValueStore.KeyValueStore;
        const value = yield* kv.get(ONBOARDING_DISMISS_KEY);
        return value === "1";
      }),
    ).pipe(Effect.orElseSucceed(() => false)),
  );
}

/** Persist dismiss flag via Effect KeyValueStore (localStorage). */
export function dismissOnboarding(): void {
  Effect.runSync(
    withLocalStorage(
      Effect.gen(function* writeDismissed() {
        const kv = yield* KeyValueStore.KeyValueStore;
        yield* kv.set(ONBOARDING_DISMISS_KEY, "1");
      }),
    ).pipe(Effect.orElseSucceed(() => undefined)),
  );
}

export function onboardingIncomplete(o: OnboardingStatus | null | undefined): boolean {
  if (!o) {
    return false;
  }
  return !(o.proxy_running && o.has_accounts && o.harness_ready);
}
