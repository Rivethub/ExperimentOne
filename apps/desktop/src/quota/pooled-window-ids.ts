import { isDefined } from "../lib/nullish";
import type { QuotaAccountUx } from "./types";

const accountIdCollator = new Intl.Collator(undefined, { sensitivity: "base" });

export function pooledAccountDisplay(a: QuotaAccountUx): string {
  if (isDefined(a.email) && a.email !== "") {
    return a.email;
  }
  return a.label;
}

export function distinctWindowIds(accounts: QuotaAccountUx[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const a of accounts) {
    for (const w of a.windows) {
      if (!seen.has(w.id)) {
        seen.set(w.id, w.label !== "" ? w.label : w.id);
      }
    }
  }
  if (seen.size === 0) {
    seen.set("primary", "Primary limit");
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

export function windowForAccount(
  a: QuotaAccountUx,
  windowId: string,
): { id: string; label: string; remaining_pct?: number | null; reset_at?: string | null } | null {
  const w = a.windows.find((x) => x.id === windowId);
  if (w) {
    return w;
  }
  if (windowId === "primary") {
    return {
      id: "primary",
      label: "Primary limit",
      remaining_pct: a.remaining_pct,
      reset_at: a.reset_at,
    };
  }
  return null;
}

export function sortAccountsById(accounts: QuotaAccountUx[]): QuotaAccountUx[] {
  const copy = accounts.slice();
  copy.sort((a, b) => accountIdCollator.compare(a.id, b.id));
  return copy;
}

export function finiteRemaining(rem: number | null | undefined): boolean {
  return isDefined(rem) && Number.isFinite(rem);
}
