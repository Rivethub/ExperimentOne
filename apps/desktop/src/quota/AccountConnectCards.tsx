import type { JSX } from "solid-js";
import { Ellipsis, KeyRound, RefreshCw, Trash2 } from "lucide-solid";
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

export function AccountConnectCards({
  accounts,
  quotaById,
  catalog,
  busy,
  loginActive,
  onReconnect,
  onRemove,
  onOpenHarness,
}: {
  accounts: AccountRow[];
  quotaById: Map<string, QuotaAccountUx>;
  catalog: CatalogProvider[];
  busy: boolean;
  loginActive: boolean;
  onReconnect: (provider: string) => void;
  onRemove: (id: string) => void;
  onOpenHarness?: () => void;
}): JSX.Element {
  if (accounts.length === 0) {
    return <Empty>No accounts yet — use Add account to sign in.</Empty>;
  }

  return (
    <div class="mt-3 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
      {accounts.map((a) => {
        const q = quotaById.get(a.id);
        const id = providerKey(a.provider);
        const color = providerColor(id, catalog);
        const showHarness = (id === "claude" || id === "codex") && isDefined(onOpenHarness);
        const displayEmail = quotaDisplayLabel(q, a.label);
        const resetLabel =
          isDefined(q?.reset_at) && q.reset_at !== "" ? formatCountdownTo(q.reset_at) : null;
        const showAltLabel = isDefined(q) && a.label !== (q.email ?? q.label);
        const remaining = q?.remaining_pct ?? null;
        const depleted = remaining !== null && remaining < 1;

        return (
          <article
            class={cn(
              "group relative flex flex-col overflow-hidden rounded-xl border bg-[#0c0c0f]",
              "border-border/80",
            )}
            style={{ "border-color": `${color}33` }}
          >
            <div class="flex items-start gap-3 px-4 pt-4 pb-3">
              <span
                class="grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold"
                style={{ background: `${color}22`, color }}
                aria-hidden
              >
                {providerChipLabel(id, catalog).slice(0, 1)}
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="truncate text-sm font-semibold tracking-tight">
                      {providerChipLabel(id, catalog)}
                    </div>
                    <div class="truncate text-xs text-muted-foreground">
                      {q?.plan ?? "Plan unknown"}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <ShadcnButton
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        class="size-8 shrink-0 text-muted-foreground opacity-70 hover:opacity-100"
                        aria-label={`Actions for ${displayEmail}`}
                        disabled={busy}
                      >
                        <Ellipsis />
                      </ShadcnButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={busy || loginActive}
                        onSelect={() => onReconnect(id)}
                      >
                        <RefreshCw />
                        Sign in again
                      </DropdownMenuItem>
                      {showHarness && (
                        <DropdownMenuItem onSelect={() => onOpenHarness()}>
                          <KeyRound />
                          Harness setup
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={busy}
                        title="Deletes the local credential file"
                        onSelect={() => onRemove(a.id)}
                      >
                        <Trash2 />
                        Remove credential
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>

            <div class="flex flex-1 flex-col gap-1 px-4 pb-4">
              <div class="truncate text-[13px] font-medium">{displayEmail}</div>
              {showAltLabel && (
                <div class="truncate font-mono text-[11px] text-muted-foreground/80">{a.label}</div>
              )}
              <div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  class={cn(
                    "inline-flex items-center rounded-md px-1.5 py-0.5 font-medium tabular-nums",
                    depleted
                      ? "bg-destructive/15 text-red-300"
                      : "bg-secondary text-secondary-foreground",
                  )}
                >
                  {fmtPct(remaining)} left
                </span>
                {resetLabel !== null && <span>resets {resetLabel}</span>}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
