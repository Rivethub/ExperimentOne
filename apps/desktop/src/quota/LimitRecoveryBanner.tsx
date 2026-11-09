import type { JSX } from "solid-js";
import { Show, createMemo } from "solid-js";
import { Button as ShadcnButton } from "#components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import { formatCountdownTo } from "#lib/provider-utils";
import { isDefined } from "#lib/nullish";
import { cn } from "#lib/utils";
import { Ellipsis, TriangleAlert } from "lucide-solid";
import type { LimitHitInfo } from "./types";

export function LimitRecoveryBanner(props: {
  hit: LimitHitInfo | null;
  onRefreshCredentials: () => void;
  onSwitchAccount: () => void;
  onWait: () => void;
}): JSX.Element {
  const resetNote = createMemo(() => {
    const hit = props.hit;
    if (!isDefined(hit) || !isDefined(hit.resetAt) || hit.resetAt === "") {
      return null;
    }
    return `Reset in ${formatCountdownTo(hit.resetAt)} (${new Date(hit.resetAt).toLocaleString()})`;
  });

  return (
    <Show when={props.hit}>
      {(hit) => (
        <div
          role="alert"
          class={cn(
            "mb-3.5 flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3",
            "border-amber-800/70 bg-[#1c1410] text-amber-100",
          )}
        >
          <div class="flex min-w-0 flex-1 gap-3">
            <TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
            <div class="min-w-0">
              <div class="font-medium tracking-tight text-amber-100">{hit().windowLabel}</div>
              <div class="mt-0.5 text-sm text-amber-200/90">
                <span>{hit().reason}</span>
                <Show when={resetNote() !== null}>
                  <span class="mt-1 block text-amber-200/70">{resetNote()}</span>
                </Show>
              </div>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <ShadcnButton
              size="sm"
              variant="secondary"
              onClick={() => props.onRefreshCredentials()}
            >
              Refresh credentials
            </ShadcnButton>
            <DropdownMenu placement="bottom-end">
              <DropdownMenuTrigger
                as={ShadcnButton}
                size="icon-sm"
                variant="ghost"
                aria-label="More recovery actions"
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => props.onSwitchAccount()}>
                  Switch account
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.onWait()}>
                  Dismiss until next hit
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
    </Show>
  );
}
