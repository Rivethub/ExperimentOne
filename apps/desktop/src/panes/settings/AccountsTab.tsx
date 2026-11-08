import { isDeviceAuthBlocked } from "../../formatUtils";
import { AccountConnectCards } from "../../quota";
import { Actions, Banner, Button, ButtonHint, Modal, Panel, Pill, Snippet } from "../../ui";
import type { SettingsAccountsProps } from "./types";
import styles from "../../styles/app.module.css";

export function AccountsTab({ hidden, ...accounts }: SettingsAccountsProps & { hidden?: boolean }) {
  const showLoginModal = !!(accounts.login && (accounts.login.active || accounts.login.output));
  const login = accounts.login;

  return (
    <Panel
      className={styles.settingsPanel}
      hidden={hidden}
      aria-hidden={hidden}
      title="Accounts"
      lede="Signed-in provider credentials. Tokens stay local and are never included in `.rivetbag` exports."
      actions={
        <Button
          variant="primary"
          disabled={accounts.busy || accounts.loginActive}
          onClick={accounts.onToggleAddAccount}
        >
          Add account
        </Button>
      }
    >
      <AccountConnectCards
        accounts={accounts.accounts}
        quotaById={accounts.quotaById}
        catalog={accounts.catalog}
        busy={accounts.busy}
        loginActive={accounts.loginActive}
        onReconnect={(provider) => accounts.onRequestLogin(provider)}
        onRemove={accounts.onRemoveAccount}
        onOpenHarness={accounts.onOpenHarness}
      />

      <Modal
        open={accounts.showAddAccount}
        onClose={accounts.onToggleAddAccount}
        title="Add account"
        titleId="add-account-title"
        wide
        footer={<Button onClick={accounts.onToggleAddAccount}>Cancel</Button>}
      >
        <p>Pick a provider to sign in. Codex opens browser OAuth by default.</p>
        <div className={styles.providerGrid}>
          {accounts.catalog.map((p) => (
            <div key={p.id} className={styles.providerAddCard}>
              <Button
                variant="provider"
                style={{ borderColor: `${p.color}55` }}
                disabled={accounts.busy || accounts.loginActive}
                title={p.hint}
                onClick={() =>
                  p.login_kind === "file_import"
                    ? accounts.onRequestVertexImport()
                    : accounts.onRequestLogin(p.id)
                }
              >
                <span
                  className={styles.providerIco}
                  style={{ background: `${p.color}22`, color: p.color }}
                >
                  {p.badge}
                </span>
                <span>
                  <strong>{p.label}</strong>
                  <ButtonHint>
                    {p.login_kind === "file_import"
                      ? "service-account JSON"
                      : p.login_kind === "oauth_device"
                        ? "device / OAuth"
                        : "browser OAuth"}
                    {accounts.providerAccountCount(p.id) > 0
                      ? ` · ${accounts.providerAccountCount(p.id)} linked`
                      : ""}
                  </ButtonHint>
                </span>
              </Button>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={showLoginModal && !!login}
        onClose={accounts.onDismissLogin}
        closeOnBackdrop={!login?.active}
        title={`Login (${login?.provider ?? "—"})`}
        titleId="login-progress-title"
        wide
        headerExtra={
          login ? (
            <Pill tone={login.success ? "ok" : login.done ? "bad" : "default"}>
              {login.active ? "in progress" : login.success ? "done" : "ended"}
            </Pill>
          ) : null
        }
        footer={
          login && !login.active ? (
            <Button onClick={accounts.onDismissLogin}>Close</Button>
          ) : undefined
        }
      >
        {login && (login.active || (login.done && !login.success)) && (
          <Actions spaced={false} style={{ marginBottom: 12 }}>
            {login.active && (
              <Button variant="danger" onClick={accounts.onCancelLogin}>
                Cancel login
              </Button>
            )}
            {login.provider === "codex" && !login.success && (
              <Button
                variant="ghost"
                disabled={accounts.busy}
                onClick={() => accounts.onRequestLogin("codex", "device")}
              >
                Use device code instead
              </Button>
            )}
          </Actions>
        )}

        {login &&
          !login.active &&
          !login.success &&
          login.provider === "codex" &&
          isDeviceAuthBlocked(login.output) && (
            <Banner tone="warn">
              <strong>ChatGPT blocked device code sign-in</strong>
              <p>
                Enable device code for Codex, Excel, PowerPoint, and Word in ChatGPT Security
                Settings, then retry device code — or use browser OAuth instead (recommended).
              </p>
              <Actions spaced={false}>
                <Button
                  variant="primary"
                  disabled={accounts.busy}
                  onClick={() => accounts.onRequestLogin("codex", "browser")}
                >
                  Sign in with browser
                </Button>
                <Button
                  disabled={accounts.busy}
                  onClick={() => accounts.onRequestLogin("codex", "device")}
                >
                  Retry device code
                </Button>
              </Actions>
            </Banner>
          )}

        <Snippet>{login?.output || "Waiting for proxy output…"}</Snippet>
      </Modal>
    </Panel>
  );
}
