import type { OnboardingStatus } from "./types";
import type { ReactElement } from "react";
import { Button, Lede } from "../ui";
import styles from "../styles/app.module.css";

export function OnboardingOverlay({
  onboarding,
  onDismiss,
  onStartProxy,
  onAddAccount,
  onHarness,
}: {
  onboarding: OnboardingStatus;
  onDismiss: () => void;
  onStartProxy: () => void;
  onAddAccount: () => void;
  onHarness: (target: "claude" | "codex") => void;
}): ReactElement {
  const steps = [
    {
      id: "proxy",
      label: "Start proxy",
      done: onboarding.proxy_running,
      action: onStartProxy,
    },
    {
      id: "accounts",
      label: "Add account",
      done: onboarding.has_accounts,
      action: onAddAccount,
    },
    {
      id: "harness",
      label: "Set up harness",
      done: onboarding.harness_ready,
      action: () => {
        onHarness("claude");
      },
    },
  ];

  return (
    <div className={styles.onboardingOverlay} role="dialog" aria-label="Getting started">
      <div className={styles.onboardingCard}>
        <h2>Welcome to Rivet</h2>
        <Lede>Finish these steps so traffic and limits show up in the app.</Lede>
        <ol className={styles.onboardingSteps}>
          {steps.map((s) => (
            <li key={s.id} className={s.done ? "done" : ""}>
              <span className={styles.onboardingCheck}>{s.done ? "✓" : "○"}</span>
              <span>{s.label}</span>
              {!s.done && (
                <Button variant="primary" onClick={s.action}>
                  Go
                </Button>
              )}
            </li>
          ))}
        </ol>
        <div className={styles.onboardingActions}>
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          <span className={styles.meta}>
            {onboarding.has_traffic ? "Traffic captured" : "No traffic yet — start the proxy first"}
          </span>
        </div>
      </div>
    </div>
  );
}
