import type { JSX } from "solid-js";
import { providerLabel, type CatalogProvider } from "../lib/provider-utils";
import { Button, Modal } from "../ui";

export type MultiAccountWarnState = {
  provider: string;
  method?: "browser" | "device";
  kind: "login" | "vertex";
} | null;

export function MultiAccountWarnModal({
  warn,
  busy,
  catalog,
  providerAccountCount,
  onDismiss,
  onConfirm,
}: {
  warn: MultiAccountWarnState;
  busy: boolean;
  catalog: CatalogProvider[];
  providerAccountCount: (provider: string) => number;
  onDismiss: () => void;
  onConfirm: (pending: NonNullable<MultiAccountWarnState>) => void;
}): JSX.Element {
  const count = warn ? providerAccountCount(warn.provider) : 0;
  const label = warn ? providerLabel(warn.provider, catalog) : "";

  return (
    <Modal
      open={Boolean(warn)}
      onClose={onDismiss}
      title="Add another account?"
      titleId="multi-account-warn-title"
      footer={
        warn ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => onConfirm(warn)}>
              Continue anyway
            </Button>
            <Button variant="primary" onClick={onDismiss}>
              Cancel
            </Button>
          </>
        ) : null
      }
    >
      {warn ? (
        <div class="space-y-2 text-[13.5px] leading-relaxed text-muted-foreground">
          <p class="m-0 text-foreground">
            You already have {count} {label} account{count === 1 ? "" : "s"} linked.
          </p>
          <p class="m-0">
            Pooling multiple accounts of the same provider may conflict with that provider&apos;s
            Terms of Service. Rivet does not encourage reselling subscription captures as a public
            API.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
