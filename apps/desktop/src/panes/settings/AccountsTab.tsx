import { createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { isDefined } from "../../lib/nullish";
import { AccountConnectCards } from "../../quota";
import { Panel } from "../../ui";
import { AccountsTabActions } from "./AccountsTabActions";
import { AccountsTabAddModal, AccountsTabLoginModal } from "./accounts-tab-modals";
import type { SettingsAccountsProps } from "./types";

export function AccountsTab({
  hidden,
  login,
  ...accounts
}: SettingsAccountsProps & { hidden?: boolean }): JSX.Element {
  const showLoginModal = isDefined(login) && (login.active || login.output !== "");

  const panelActions = createMemo(
    () => (
      <AccountsTabActions
        busy={accounts.busy}
        loginActive={accounts.loginActive}
        onToggleAddAccount={accounts.onToggleAddAccount}
      />
    ),
    [accounts.busy, accounts.loginActive, accounts.onToggleAddAccount],
  );

  return (
    <Panel
      class="m-0"
      hidden={hidden}
      aria-hidden={hidden}
      title="Accounts"
      lede="Signed-in provider credentials. Tokens stay local and are never included in `.rivetbag` exports."
      actions={panelActions()}
    >
      <AccountConnectCards
        accounts={accounts.accounts}
        quotaById={accounts.quotaById}
        catalog={accounts.catalog}
        busy={accounts.busy}
        loginActive={accounts.loginActive}
        onReconnect={(provider) => {
          accounts.onRequestLogin(provider);
        }}
        onRemove={accounts.onRemoveAccount}
        onOpenHarness={accounts.onOpenHarness}
      />

      <AccountsTabAddModal
        open={accounts.showAddAccount}
        busy={accounts.busy}
        loginActive={accounts.loginActive}
        catalog={accounts.catalog}
        providerAccountCount={accounts.providerAccountCount}
        onToggleAddAccount={accounts.onToggleAddAccount}
        onRequestLogin={accounts.onRequestLogin}
        onRequestVertexImport={accounts.onRequestVertexImport}
      />

      <AccountsTabLoginModal
        login={login}
        busy={accounts.busy}
        showLoginModal={showLoginModal}
        onDismissLogin={accounts.onDismissLogin}
        onCancelLogin={accounts.onCancelLogin}
        onRequestLogin={accounts.onRequestLogin}
      />
    </Panel>
  );
}
