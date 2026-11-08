import type { Page } from "../types";
import { Button } from "../ui";
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

export type AppTopbarProps = {
  title: string;
  subtitle: string;
  page: Page;
  busy: boolean;
  onRefresh: () => void;
  quota?: AppTopbarQuotaActions;
  wiki?: AppTopbarWikiActions;
  runtime?: AppTopbarRuntimeActions;
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
}: AppTopbarProps) {
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
