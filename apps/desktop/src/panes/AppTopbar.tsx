import { Ellipsis } from "lucide-react";
import { Button as ShadcnButton } from "#components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import type { Page } from "../lib/types";
import { Button } from "../ui";

export type AppTopbarQuotaActions = {
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
  return (
    <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
      <div>
        <h1 className="m-0 text-[22px] font-semibold tracking-tight">{title}</h1>
        <div className="mt-1 text-[13px] text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {page !== "wiki" && (
          <Button variant="ghost" disabled={busy} onClick={onRefresh}>
            Refresh
          </Button>
        )}
        {page === "quota" && quota && (
          <Button variant="primary" disabled={busy} onClick={quota.onManageCredentials}>
            Manage credentials
          </Button>
        )}
        {page === "data" && data && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ShadcnButton variant="default" disabled={busy}>
                Export / import
              </ShadcnButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy} onSelect={data.onExport}>
                Export all .rivetbag
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={data.onImport}>
                Import .rivetbag
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={data.onIngestLocal}>
                Import local sessions
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy || !data.canRevealExport}
                onSelect={data.onRevealExport}
              >
                Reveal last export
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {page === "wiki" && wiki && (
          <>
            <Button variant="ghost" disabled={busy} onClick={wiki.onOpenSettings}>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ShadcnButton
                  variant="ghost"
                  size="icon"
                  disabled={busy || !runtime.apiOnline}
                  aria-label="More runtime actions"
                >
                  <Ellipsis />
                </ShadcnButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={busy || !runtime.apiOnline}
                  onSelect={runtime.onProxyRestart}
                >
                  Restart proxy
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy || !runtime.apiOnline}
                  onSelect={runtime.onRunWorkers}
                >
                  Run workers
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </header>
  );
}
