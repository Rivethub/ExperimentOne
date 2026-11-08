import { useEffect, useId, useRef, useState } from "react";
import type { Page } from "../lib/types";
import { Button } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export type AppTopbarQuotaActions = {
  onRefreshCredentials: () => void;
  onManageCredentials: () => void;
};

export type AppTopbarWikiActions = {
  onOpenSettings: () => void;
  onOpenFolder: () => void;
  wikiEnabled: boolean;
};

export type AppTopbarRuntimeActions = {
  proxyRunning: boolean;
  apiOnline: boolean;
  onProxyStart: () => void;
  onProxyStop: () => void;
  onProxyRestart: () => void;
  onRunWorkers: () => void;
};

export type AppTopbarDataActions = {
  canRevealExport: boolean;
  onExport: () => void;
  onImport: () => void;
  onIngestLocal: () => void;
  onRevealExport: () => void;
};

export type AppTopbarProps = {
  title: string;
  subtitle: string;
  page: Page;
  busy: boolean;
  onRefresh: () => void;
  quota?: AppTopbarQuotaActions;
  wiki?: AppTopbarWikiActions;
  runtime?: AppTopbarRuntimeActions;
  data?: AppTopbarDataActions;
};

export function AppTopbar({
  title,
  subtitle,
  page,
  busy,
  onRefresh,
  quota,
  wiki,
  runtime,
  data,
}: AppTopbarProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (page !== "data") setMenuOpen(false);
  }, [page]);

  return (
    <header className={styles.topbar}>
      <div>
        <h1>{title}</h1>
        <div className={styles.sub}>{subtitle}</div>
      </div>
      <div className={styles.topActions}>
        {page !== "wiki" && (
          <Button variant="ghost" disabled={busy} onClick={onRefresh}>
            Refresh
          </Button>
        )}
        {page === "quota" && quota && (
          <>
            <Button disabled={busy} onClick={quota.onRefreshCredentials}>
              Refresh credentials
            </Button>
            <Button variant="primary" disabled={busy} onClick={quota.onManageCredentials}>
              Manage credentials
            </Button>
          </>
        )}
        {page === "data" && data && (
          <div className={styles.topMenu} ref={menuRef}>
            <Button
              variant="primary"
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((open) => !open)}
            >
              Export / import
            </Button>
            {menuOpen && (
              <div className={styles.topMenuPanel} id={menuId} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={styles.topMenuItem}
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    data.onExport();
                  }}
                >
                  Export .rivetbag
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.topMenuItem}
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    data.onImport();
                  }}
                >
                  Import .rivetbag
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.topMenuItem}
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    data.onIngestLocal();
                  }}
                >
                  Import local sessions
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={cx(styles.topMenuItem, !data.canRevealExport ? styles.disabled : "")}
                  disabled={busy || !data.canRevealExport}
                  onClick={() => {
                    setMenuOpen(false);
                    data.onRevealExport();
                  }}
                >
                  Reveal last export
                </button>
              </div>
            )}
          </div>
        )}
        {page === "wiki" && wiki && (
          <>
            <Button disabled={busy} onClick={wiki.onOpenSettings}>
              {wiki.wikiEnabled ? "Settings" : "Enable wiki"}
            </Button>
            <Button variant="primary" onClick={wiki.onOpenFolder}>
              Open folder
            </Button>
          </>
        )}
        {page === "runtime" && runtime && (
          <>
            {runtime.proxyRunning ? (
              <Button disabled={busy} onClick={runtime.onProxyStop}>
                Stop proxy
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy || !runtime.apiOnline}
                onClick={runtime.onProxyStart}
              >
                Start proxy
              </Button>
            )}
            <Button disabled={busy || !runtime.apiOnline} onClick={runtime.onProxyRestart}>
              Restart
            </Button>
            <Button disabled={busy || !runtime.apiOnline} onClick={runtime.onRunWorkers}>
              Run workers
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
