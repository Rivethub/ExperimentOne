import { useMemo } from "react";
import { isDeviceAuthBlocked } from "../../lib/format-utils";
import { isDefined } from "../../lib/nullish";
import type { CatalogProvider } from "../../lib/provider-utils";
import type { LoginStatus } from "../../lib/types";
import { Actions, Banner, Button, ButtonHint, Modal, Pill, Snippet } from "../../ui";
import styles from "../../styles/app.module.css";

function loginKindHint(loginKind: string): string {
  if (loginKind === "file_import") {
    return "service-account JSON";
  }
  if (loginKind === "oauth_device") {
    return "device / OAuth";
  }
  return "browser OAuth";
}

function loginPillLabel(login: LoginStatus): string {
  if (login.active) {
    return "in progress";
  }
  if (login.success) {
    return "done";
  }
  return "ended";
}

function loginPillTone(login: LoginStatus): "ok" | "bad" | "default" {
  if (login.success) {
    return "ok";
  }
  if (login.done) {
    return "bad";
  }
  return "default";
}

export function AccountsTabAddModal({
  open,
  busy,
  loginActive,
  catalog,
  providerAccountCount,
  onToggleAddAccount,
  onRequestLogin,
  onRequestVertexImport,
}: {
  open: boolean;
  busy: boolean;
  loginActive: boolean;
  catalog: CatalogProvider[];
  providerAccountCount: (provider: string) => number;
  onToggleAddAccount: () => void;
  onRequestLogin: (provider: string) => void;
  onRequestVertexImport: () => void;
}): React.ReactElement {
  const footer = useMemo(
    () => <Button onClick={onToggleAddAccount}>Cancel</Button>,
    [onToggleAddAccount],
  );

  return (
    <Modal
      open={open}
      onClose={onToggleAddAccount}
      title="Add account"
      titleId="add-account-title"
      wide
      footer={footer}
    >
      <p>Pick a provider to sign in. Codex opens browser OAuth by default.</p>
      <div className={styles.providerGrid}>
        {catalog.map((p) => {
          const linked = providerAccountCount(p.id);
          const hint = loginKindHint(p.login_kind);
          const linkedSuffix = linked > 0 ? ` · ${linked} linked` : "";
          return (
            <div key={p.id} className={styles.providerAddCard}>
              <Button
                variant="provider"
                style={{ borderColor: `${p.color}55` }}
                disabled={busy || loginActive}
                title={p.hint}
                onClick={() => {
                  if (p.login_kind === "file_import") {
                    onRequestVertexImport();
                  } else {
                    onRequestLogin(p.id);
                  }
                }}
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
                    {hint}
                    {linkedSuffix}
                  </ButtonHint>
                </span>
              </Button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function AccountsTabLoginModal({
  login,
  busy,
  showLoginModal,
  onDismissLogin,
  onCancelLogin,
  onRequestLogin,
}: {
  login: LoginStatus | null;
  busy: boolean;
  showLoginModal: boolean;
  onDismissLogin: () => void;
  onCancelLogin: () => void;
  onRequestLogin: (provider: string, method?: "browser" | "device") => void;
}): React.ReactElement | null {
  const headerExtra = useMemo(() => {
    if (!isDefined(login)) {
      return null;
    }
    return <Pill tone={loginPillTone(login)}>{loginPillLabel(login)}</Pill>;
  }, [login]);
  const footer = useMemo(() => {
    if (!isDefined(login) || login.active) {
      return null;
    }
    return <Button onClick={onDismissLogin}>Close</Button>;
  }, [login, onDismissLogin]);

  if (!isDefined(login)) {
    return null;
  }

  const outputText = login.output !== "" ? login.output : "Waiting for proxy output…";
  const showDeviceBanner =
    !login.active &&
    !login.success &&
    login.provider === "codex" &&
    isDeviceAuthBlocked(login.output);

  return (
    <Modal
      open={showLoginModal}
      onClose={onDismissLogin}
      closeOnBackdrop={!login.active}
      title={`Login (${login.provider})`}
      titleId="login-progress-title"
      wide
      headerExtra={headerExtra}
      footer={footer}
    >
      {(login.active || (login.done && !login.success)) && (
        <Actions spaced={false} style={{ marginBottom: 12 }}>
          {login.active && (
            <Button variant="danger" onClick={onCancelLogin}>
              Cancel login
            </Button>
          )}
          {login.provider === "codex" && !login.success && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onRequestLogin("codex", "device");
              }}
            >
              Use device code instead
            </Button>
          )}
        </Actions>
      )}

      {showDeviceBanner && (
        <Banner tone="warn">
          <strong>ChatGPT blocked device code sign-in</strong>
          <p>
            Enable device code for Codex, Excel, PowerPoint, and Word in ChatGPT Security Settings,
            then retry device code — or use browser OAuth instead (recommended).
          </p>
          <Actions spaced={false}>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                onRequestLogin("codex", "browser");
              }}
            >
              Sign in with browser
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                onRequestLogin("codex", "device");
              }}
            >
              Retry device code
            </Button>
          </Actions>
        </Banner>
      )}

      <Snippet>{outputText}</Snippet>
    </Modal>
  );
}
