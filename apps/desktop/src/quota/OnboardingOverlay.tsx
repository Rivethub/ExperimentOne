import { Check, Circle } from "lucide-solid";
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { Button, Modal } from "../ui";
import { cn } from "#lib/utils";
import type { OnboardingStatus } from "./types";

export function OnboardingOverlay(props: {
  onboarding: OnboardingStatus;
  onDismiss: () => void;
  onStartProxy: () => void;
  onAddAccount: () => void;
  onHarness: (target: "claude" | "codex") => void;
}): JSX.Element {
  const steps = () => [
    {
      id: "proxy",
      label: "Start proxy",
      done: props.onboarding.proxy_running,
      action: props.onStartProxy,
      cta: "Start",
    },
    {
      id: "accounts",
      label: "Add account",
      done: props.onboarding.has_accounts,
      action: props.onAddAccount,
      cta: "Add",
    },
    {
      id: "harness",
      label: "Set up harness",
      done: props.onboarding.harness_ready,
      action: () => {
        props.onHarness("claude");
      },
      cta: "Set up",
    },
  ];
  const next = () => steps().find((s) => !s.done) ?? null;

  return (
    <Modal
      open={true}
      onClose={props.onDismiss}
      title="Welcome to Rivet"
      titleId="onboarding-title"
    >
      <p class="mt-0 text-[13px] leading-snug text-muted-foreground">
        Finish these steps so captures and limits show up in the app.
      </p>
      <ol class="mt-4 flex list-none flex-col gap-2.5 p-0">
        <For each={steps()}>
          {(s) => (
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
                <Show when={s.done} fallback={<Circle size={14} strokeWidth={1.75} />}>
                  <Check size={14} strokeWidth={1.75} />
                </Show>
              </span>
              <span class="min-w-0 flex-1 font-medium">{s.label}</span>
              <Show
                when={s.done}
                fallback={
                  <Button variant={next()?.id === s.id ? "primary" : "ghost"} onClick={s.action}>
                    {s.cta}
                  </Button>
                }
              >
                <span class="text-xs text-muted-foreground">Done</span>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <div class="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
        <span class="text-xs text-muted-foreground">
          {props.onboarding.has_captures
            ? "Captures recorded"
            : "No captures yet — start the proxy first"}
        </span>
        <Button variant="ghost" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </div>
    </Modal>
  );
}
