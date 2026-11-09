import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { accountDisplay } from "../lib/format-utils";
import { fmtPct } from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import type { QuotaAccount } from "../lib/types";
import { Button, Panel } from "../ui";
import { cn } from "#lib/utils";
import type { QuotaAccountUx } from "./types";

const icoTone = {
  claude: "bg-[var(--claude-dim)] text-[var(--claude)]",
  codex: "bg-[var(--codex-dim)] text-[var(--codex)]",
  generic: "bg-secondary text-muted-foreground",
} as const;

export function QuotaProviderCardEmpty(props: {
  name: string;
  ico: string;
  icoClass: "claude" | "codex" | "generic";
  onAddCredentials: () => void;
}): JSX.Element {
  return (
    <Panel
      class="mb-0"
      title={
        <span class="inline-flex items-center gap-2.5">
          <span
            class={cn(
              "grid size-7 place-items-center rounded-lg text-[13px] font-bold",
              icoTone[props.icoClass],
            )}
          >
            {props.ico}
          </span>
          {props.name}
        </span>
      }
      lede="No credentials yet"
      actions={
        <Button variant="primary" onClick={() => props.onAddCredentials()}>
          Add account
        </Button>
      }
    >
      <p class="m-0 max-w-[56ch] text-[13px] leading-snug text-muted-foreground">
        Add an account to track live remaining limits and burn for {props.name}.
      </p>
    </Panel>
  );
}

function formatResetAt(resetAt: string | null | undefined): string {
  if (!isDefined(resetAt) || resetAt === "") {
    return "—";
  }
  return new Date(resetAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function accountRowTitle(a: QuotaAccount): string {
  if (isDefined(a.cooldown_seconds) && a.cooldown_seconds > 0) {
    return `Cooldown ${a.cooldown_seconds}s · ${a.status}`;
  }
  return a.status;
}

export function QuotaProviderAccountList(props: {
  accounts: QuotaAccount[];
  onAddCredentials: () => void;
  onAccountSelect: (a: QuotaAccountUx) => void;
}): JSX.Element {
  const rows = createMemo(() =>
    props.accounts.map((a) => {
      const rem = a.remaining_pct;
      const hasRem = isDefined(rem) && Number.isFinite(rem);
      const empty = hasRem && rem <= 0.5;
      return { a, rem, empty };
    }),
  );

  return (
    <div class="mt-3 flex flex-col gap-1.5 border-t border-border/60 pt-3">
      <For each={rows()}>
        {(row) => (
          <button
            type="button"
            title={accountRowTitle(row.a)}
            class={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left",
              "hover:border-border hover:bg-secondary/40",
              row.empty && "border-amber-900/40 bg-amber-950/20",
              !row.a.loaded && "opacity-70",
            )}
            onClick={() => {
              props.onAccountSelect(row.a);
            }}
          >
            <div class="flex min-w-0 items-center gap-2">
              <span
                class={cn(
                  "size-2 shrink-0 rounded-full",
                  row.empty
                    ? "bg-amber-400"
                    : row.a.loaded
                      ? "bg-emerald-400"
                      : "bg-muted-foreground/50",
                )}
                aria-hidden
              />
              <span class="truncate text-[13px] font-medium">{accountDisplay(row.a)}</span>
              <Show when={!row.a.loaded}>
                <span class="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  unavailable
                </span>
              </Show>
              <Show when={row.empty}>
                <span class="rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
                  empty
                </span>
              </Show>
            </div>
            <div class="shrink-0 text-xs text-muted-foreground">
              <span title="Remaining quota for this credential">{fmtPct(row.rem ?? null)}</span>
              <span class="mx-1 opacity-50">·</span>
              <span title="Next reset">{formatResetAt(row.a.reset_at)}</span>
            </div>
          </button>
        )}
      </For>
      <div class="px-1 pt-1">
        <Button variant="ghost" onClick={() => props.onAddCredentials()}>
          Add account
        </Button>
      </div>
    </div>
  );
}
