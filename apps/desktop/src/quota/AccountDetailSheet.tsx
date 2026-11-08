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

export function AccountDetailSheet({
  account,
  catalog,
  onClose,
}: {
  account: QuotaAccountUx | null;
  catalog: CatalogProvider[];
  onClose: () => void;
}): React.ReactElement {
  const id = isDefined(account) ? providerKey(account.provider) : "";
  const color = isDefined(account) ? providerColor(id, catalog) : undefined;
  const windows =
    isDefined(account) && account.windows.length > 0
      ? account.windows
      : isDefined(account)
        ? [
            {
              id: "primary",
              label: "Primary limit",
              remaining_pct: account.remaining_pct,
              reset_at: account.reset_at,
            },
          ]
        : [];

  return (
    <Sheet
      open={isDefined(account)}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[400px]">
        {isDefined(account) ? (
          <>
            <SheetHeader className="flex-row items-start gap-3 space-y-0 p-0 pb-4">
              <div
                className="grid size-7 shrink-0 place-items-center rounded-lg text-[13px] font-bold"
                style={{ background: `${color}22`, color }}
              >
                {providerChipLabel(id, catalog).slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-base">{accountDisplay(account)}</SheetTitle>
                <SheetDescription>
                  {providerChipLabel(id, catalog)}
                  {isDefined(account.plan) && account.plan !== "" ? ` · ${account.plan}` : ""}
                </SheetDescription>
              </div>
            </SheetHeader>
            <div>
              <Kv>
                <KvRow label="Remaining" value={fmtPct(account.remaining_pct ?? null)} />
                <KvRow label="Status" value={account.status} />
                <KvRow
                  label="Next reset"
                  value={
                    isDefined(account.reset_at) && account.reset_at !== ""
                      ? new Date(account.reset_at).toLocaleString()
                      : "—"
                  }
                />
                {isDefined(account.cooldown_seconds) && account.cooldown_seconds > 0 && (
                  <KvRow label="Cooldown" value={`${account.cooldown_seconds}s`} />
                )}
              </Kv>
              {windows.map((w) => (
                <div
                  key={w.id}
                  className="mt-3 rounded-lg border border-border/60 bg-background p-2.5 text-[12.5px]"
                >
                  <strong>{w.label}</strong>
                  <div className="text-xs text-muted-foreground">
                    {fmtPct(w.remaining_pct ?? null)} · reset{" "}
                    {isDefined(w.reset_at) && w.reset_at !== ""
                      ? formatCountdownTo(w.reset_at)
                      : "—"}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
