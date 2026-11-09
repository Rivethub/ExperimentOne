import { Check, Circle } from "lucide-solid";
import type { JSX } from "solid-js";
import { Button } from "../ui";
import { cn } from "#lib/utils";
import type { OnboardingStatus } from "./types";

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
}): JSX.Element {
  const steps = [
    {
      id: "proxy",
      label: "Start proxy",
      done: onboarding.proxy_running,
      action: onStartProxy,
      cta: "Start",
    },
    {
      id: "accounts",
      label: "Add account",
      done: onboarding.has_accounts,
      action: onAddAccount,
      cta: "Add",
    },
    {
      id: "harness",
      label: "Set up harness",
      done: onboarding.harness_ready,
      action: () => {
        onHarness("claude");
      },
      cta: "Set up",
    },
  ];
  const next = steps.find((s) => !s.done) ?? null;

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"
      role="dialog"
      aria-label="Getting started"
      aria-modal="true"
    >
      <div class="w-full max-w-md rounded-xl border border-border bg-card px-5 py-5 shadow-lg">
        <h2 class="m-0 text-lg font-semibold tracking-tight">Welcome to Rivet</h2>
        <p class="mt-1.5 text-[13px] leading-snug text-muted-foreground">
          Finish these steps so captures and limits show up in the app.
        </p>
        <ol class="mt-4 flex list-none flex-col gap-2.5 p-0">
          {steps.map((s) => (
            <li
              class={cn(
                "flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-2 text-[13.5px]",
                s.done ? "text-muted-foreground" : "border-border/70 bg-secondary/30",
              )}
            >
              <span
                class={cn(
                  "grid size-5 place-items-center",
                  s.done ? "text-emerald-400" : "text-muted-foreground",
                )}
                aria-hidden
              >
                {s.done ? (
                  <Check size={14} strokeWidth={1.75} />
                ) : (
                  <Circle size={14} strokeWidth={1.75} />
                )}
              </span>
              <span class="min-w-0 flex-1 font-medium">{s.label}</span>
              {s.done ? (
                <span class="text-xs text-muted-foreground">Done</span>
              ) : next?.id === s.id ? (
                <Button variant="primary" onClick={s.action}>
                  {s.cta}
                </Button>
              ) : (
                <Button variant="ghost" onClick={s.action}>
                  {s.cta}
                </Button>
              )}
            </li>
          ))}
        </ol>
        <div class="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <span class="text-xs text-muted-foreground">
            {onboarding.has_captures
              ? "Captures recorded"
              : "No captures yet — start the proxy first"}
          </span>
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
