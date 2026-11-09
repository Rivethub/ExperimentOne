import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import {
  fmtPct,
  formatCountdownTo,
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import type { QuotaAccountUx } from "./types";
import { Kv, KvRow } from "../ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#components/ui/sheet";

function accountDisplay(a: QuotaAccountUx): string {
  if (isDefined(a.email) && a.email !== "") {
    return a.email;
  }
  return a.label;
}

export function AccountDetailSheet(props: {
  account: QuotaAccountUx | null;
  catalog: CatalogProvider[];
  onClose: () => void;
}): JSX.Element {
  const id = createMemo(() =>
    isDefined(props.account) ? providerKey(props.account.provider) : "",
  );
  const color = createMemo(() =>
    isDefined(props.account) ? providerColor(id(), props.catalog) : undefined,
  );
  const windows = createMemo(() => {
    const account = props.account;
    if (!isDefined(account)) {
      return [];
    }
    if (account.windows.length > 0) {
      return account.windows;
    }
    return [
      {
        id: "primary",
        label: "Primary limit",
        remaining_pct: account.remaining_pct,
        reset_at: account.reset_at,
      },
    ];
  });

  return (
    <Sheet
      open={isDefined(props.account)}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetContent side="right" class="w-full gap-0 overflow-y-auto sm:max-w-[400px]">
        <Show when={props.account}>
          {(account) => (
            <>
              <SheetHeader class="flex-row items-start gap-3 space-y-0 p-0 pb-4">
                <div
                  class="grid size-7 shrink-0 place-items-center rounded-lg text-[13px] font-bold"
                  style={{ background: `${color()}22`, color: color() }}
                >
                  {providerChipLabel(id(), props.catalog).slice(0, 1)}
                </div>
                <div class="min-w-0 flex-1">
                  <SheetTitle class="text-base">{accountDisplay(account())}</SheetTitle>
                  <SheetDescription>
                    {providerChipLabel(id(), props.catalog)}
                    {isDefined(account().plan) && account().plan !== ""
                      ? ` · ${account().plan}`
                      : ""}
                  </SheetDescription>
                </div>
              </SheetHeader>
              <div>
                <Kv>
                  <KvRow label="Remaining" value={fmtPct(account().remaining_pct ?? null)} />
                  <KvRow label="Status" value={account().status} />
                  <KvRow
                    label="Next reset"
                    value={(() => {
                      const resetAt = account().reset_at;
                      return isDefined(resetAt) && resetAt !== ""
                        ? new Date(resetAt).toLocaleString()
                        : "—";
                    })()}
                  />
                  <Show
                    when={isDefined(account().cooldown_seconds) && account().cooldown_seconds! > 0}
                  >
                    <KvRow label="Cooldown" value={`${account().cooldown_seconds}s`} />
                  </Show>
                </Kv>
                <For each={windows()}>
                  {(w) => (
                    <div class="mt-3 rounded-lg border border-border/60 bg-background p-2.5 text-[12.5px]">
                      <strong>{w.label}</strong>
                      <div class="text-xs text-muted-foreground">
                        {fmtPct(w.remaining_pct ?? null)} · reset{" "}
                        {isDefined(w.reset_at) && w.reset_at !== ""
                          ? formatCountdownTo(w.reset_at)
                          : "—"}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
      </SheetContent>
    </Sheet>
  );
}
