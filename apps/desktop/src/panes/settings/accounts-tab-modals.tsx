import { useMemo } from "react";
import { isDeviceAuthBlocked } from "../../lib/format-utils";
import { isDefined } from "../../lib/nullish";
import type { CatalogProvider } from "../../lib/provider-utils";
import type { LoginStatus } from "../../lib/types";
import { cn } from "#lib/utils";
import { Actions, Button, ButtonHint, Modal, Pill, Snippet } from "../../ui";

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
      <p className="m-0 text-[13.5px] text-muted-foreground">
        Pick a provider to sign in. Codex opens browser OAuth by default.
      </p>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {catalog.map((p) => {
          const linked = providerAccountCount(p.id);
          const hint = loginKindHint(p.login_kind);
          const linkedSuffix = linked > 0 ? ` · ${linked} linked` : "";
          return (
            <Button
              key={p.id}
              variant="provider"
              className="justify-start text-left"
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
                className="grid size-8 shrink-0 place-items-center rounded-lg text-sm font-semibold"
                style={{ background: `${p.color}22`, color: p.color }}
              >
                {p.badge}
              </span>
              <span className="min-w-0">
                <strong className="block text-[13px] font-semibold">{p.label}</strong>
                <ButtonHint>
                  {hint}
                  {linkedSuffix}
                </ButtonHint>
              </span>
            </Button>
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
        <Actions spaced={false} className="mb-3">
          {login.active && (
            <Button variant="danger" onClick={onCancelLogin}>
              Cancel login
            </Button>
          )}
          {login.provider === "codex" && !login.success && !showDeviceBanner && (
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
        <div
          role="alert"
          className={cn(
            "mb-3 flex flex-wrap items-start justify-between gap-3 rounded-lg border px-3.5 py-3",
            "border-amber-800/70 bg-[#1c1410] text-amber-100",
          )}
        >
          <div className="min-w-0 max-w-[52ch]">
            <div className="font-medium tracking-tight">ChatGPT blocked device code sign-in</div>
            <p className="mt-1 m-0 text-[13px] leading-snug text-amber-200/85">
              Enable device code for Codex in ChatGPT Security Settings, then retry — or use browser
              OAuth instead (recommended).
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
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
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onRequestLogin("codex", "device");
              }}
            >
              Retry device code
            </Button>
          </div>
        </div>
      )}

      <Snippet>{outputText}</Snippet>
    </Modal>
  );
}
