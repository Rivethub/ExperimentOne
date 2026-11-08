import type { ReactElement } from "react";
import { providerLabel, type CatalogProvider } from "../providerUtils";
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
}): ReactElement {
  return (
    <Modal
      open={Boolean(warn)}
      onClose={onDismiss}
      title="Add another account?"
      titleId="multi-account-warn-title"
      footer={
        warn ? (
          <>
            <Button onClick={onDismiss}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() =>{  onConfirm(warn); }}>
              Continue anyway
            </Button>
          </>
        ) : null
      }
    >
      {warn ? (
        <p>
          You already have{" "}
          <strong>
            {providerAccountCount(warn.provider)} {providerLabel(warn.provider, catalog)}
          </strong>{" "}
          account
          {providerAccountCount(warn.provider) === 1 ? "" : "s"} linked. Pooling multiple accounts
          of the same provider may conflict with that provider&apos;s Terms of Service. Rivet does
          not encourage reselling subscription traffic as a public API.
        </p>
      ) : null}
    </Modal>
  );
}
