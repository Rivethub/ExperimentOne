import type { JSX } from "solid-js";
import { Show, createMemo } from "solid-js";
import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
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
        <Alert
          class={cn(
            "mb-3.5 grid-cols-[auto_1fr_auto] items-start gap-x-3",
            "border-amber-800/70 bg-[#1c1410] text-amber-100 [&>svg]:text-amber-300",
            "*:data-[slot=alert-description]:text-amber-200/90",
          )}
        >
          <TriangleAlert aria-hidden />
          <div class="min-w-0">
            <AlertTitle class="text-amber-100">{hit().windowLabel}</AlertTitle>
            <AlertDescription>
              <span>{hit().reason}</span>
              <Show when={resetNote() !== null}>
                <span class="mt-1 block text-amber-200/70">{resetNote()}</span>
              </Show>
            </AlertDescription>
          </div>
          <div class="col-start-3 row-span-2 flex shrink-0 items-center gap-2 self-start">
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
        </Alert>
      )}
    </Show>
  );
}
