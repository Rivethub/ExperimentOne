import type { JSX } from "solid-js";
import { Button } from "../../ui";

export function AccountsTabActions({
  busy,
  loginActive,
  onToggleAddAccount,
}: {
  busy: boolean;
  loginActive: boolean;
  onToggleAddAccount: () => void;
}): JSX.Element {
  return (
    <Button variant="primary" disabled={busy || loginActive} onClick={onToggleAddAccount}>
      Add account
    </Button>
  );
}
