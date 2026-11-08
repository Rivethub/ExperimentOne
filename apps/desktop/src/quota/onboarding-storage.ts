import type { OnboardingStatus } from "./types";

const ONBOARDING_DISMISS_KEY = "rivet.onboarding.dismissed";

export function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissOnboarding(): void {
  try {
    localStorage.setItem(ONBOARDING_DISMISS_KEY, "1");
  } catch {
    /* private mode */
  }
}

export function onboardingIncomplete(o: OnboardingStatus | null | undefined): boolean {
  if (!o) {
    return false;
  }
  return !(o.proxy_running && o.has_accounts && o.harness_ready);
}
