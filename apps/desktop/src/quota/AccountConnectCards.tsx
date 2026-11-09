import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { Ellipsis, KeyRound, RefreshCw, Trash2 } from "lucide-solid";
import { Card, CardContent, CardFooter, CardHeader } from "#components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import { Button as ShadcnButton } from "#components/ui/button";
import { cn } from "#lib/utils";
import { isDefined } from "#lib/nullish";
import {
  fmtPct,
  formatCountdownTo,
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "#lib/provider-utils";
import { Empty } from "#ui";
import type { QuotaAccountUx } from "./types";

type AccountRow = {
  id: string;
  provider: string;
  label: string;
};

function quotaDisplayLabel(q: QuotaAccountUx | undefined, fallback: string): string {
  if (!isDefined(q)) {
    return fallback;
  }
  if (isDefined(q.email) && q.email !== "") {
    return q.email;
  }
  return q.label !== "" ? q.label : fallback;
}

export function AccountConnectCards(props: {
  accounts: AccountRow[];
  quotaById: Map<string, QuotaAccountUx>;
  catalog: CatalogProvider[];
  busy: boolean;
  loginActive: boolean;
  onReconnect: (provider: string) => void;
  onRemove: (id: string) => void;
  onOpenHarness?: () => void;
}): JSX.Element {
  return (
    <Show
      when={props.accounts.length > 0}
      fallback={<Empty>No accounts yet — use Add account to sign in.</Empty>}
    >
      <div class="mt-3 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        <For each={props.accounts}>
          {(a) => {
            const q = () => props.quotaById.get(a.id);
            const id = () => providerKey(a.provider);
            const color = () => providerColor(id(), props.catalog);
            const showHarness = () =>
              (id() === "claude" || id() === "codex") && isDefined(props.onOpenHarness);
            const displayEmail = () => quotaDisplayLabel(q(), a.label);
            const resetLabel = () => {
              const resetAt = q()?.reset_at;
              return isDefined(resetAt) && resetAt !== "" ? formatCountdownTo(resetAt) : null;
            };
            const showAltLabel = () => {
              const quota = q();
              return isDefined(quota) && a.label !== (quota.email ?? quota.label);
            };
            const remaining = () => q()?.remaining_pct ?? null;
            const depleted = () => {
              const rem = remaining();
              return rem !== null && rem < 1;
            };

            return (
              <Card
                class="gap-0 overflow-hidden bg-[#0c0c0f] py-0 shadow-none"
                style={{ "border-color": `${color()}33` }}
              >
                <CardHeader class="flex flex-row items-start gap-3 px-4 pt-4 pb-3">
                  <span
                    class="grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold"
                    style={{ background: `${color()}22`, color: color() }}
                    aria-hidden
                  >
                    {providerChipLabel(id(), props.catalog).slice(0, 1)}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0">
                        <div class="truncate text-sm font-semibold tracking-tight">
                          {providerChipLabel(id(), props.catalog)}
                        </div>
                        <div class="truncate text-xs text-muted-foreground">
                          {q()?.plan ?? "Plan unknown"}
                        </div>
                      </div>
                      <DropdownMenu placement="bottom-end">
                        <DropdownMenuTrigger
                          as={ShadcnButton}
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          class="size-8 shrink-0 text-muted-foreground opacity-70 hover:opacity-100"
                          aria-label={`Actions for ${displayEmail()}`}
                          disabled={props.busy}
                        >
                          <Ellipsis />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem
                            disabled={props.busy || props.loginActive}
                            onSelect={() => props.onReconnect(id())}
                          >
                            <RefreshCw />
                            Sign in again
                          </DropdownMenuItem>
                          <Show when={showHarness()}>
                            <DropdownMenuItem onSelect={() => props.onOpenHarness?.()}>
                              <KeyRound />
                              Harness setup
                            </DropdownMenuItem>
                          </Show>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={props.busy}
                            title="Deletes the local credential file"
                            onSelect={() => props.onRemove(a.id)}
                          >
                            <Trash2 />
                            Remove credential
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>

                <CardContent class="flex flex-1 flex-col gap-1 px-4 pb-4">
                  <div class="truncate text-[13px] font-medium">{displayEmail()}</div>
                  <Show when={showAltLabel()}>
                    <div class="truncate font-mono text-[11px] text-muted-foreground/80">
                      {a.label}
                    </div>
                  </Show>
                </CardContent>

                <CardFooter class="gap-2 px-4 pt-0 pb-4 text-xs text-muted-foreground">
                  <span
                    class={cn(
                      "inline-flex items-center rounded-md px-1.5 py-0.5 font-medium tabular-nums",
                      depleted()
                        ? "bg-destructive/15 text-red-300"
                        : "bg-secondary text-secondary-foreground",
                    )}
                  >
                    {fmtPct(remaining())} left
                  </span>
                  <Show when={resetLabel() !== null}>
                    <span>resets {resetLabel()}</span>
                  </Show>
                </CardFooter>
              </Card>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
