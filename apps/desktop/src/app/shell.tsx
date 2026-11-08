import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { MultiAccountWarnModal } from "#components/MultiAccountWarnModal";
import { useAccounts, useAppOperations, useQuotaDerived, useRivetData } from "#hooks";
import type { SettingsTab } from "#lib/types";
import { cn } from "#lib/utils";
import { MockDevBar } from "#mock";
import { AppSidebar, AppStatusBar, AppTopbar } from "#panes";
import {
  AccountDetailSheet,
  OnboardingOverlay,
  dismissOnboarding,
  isOnboardingDismissed,
  onboardingIncomplete,
  type QuotaAccountUx,
} from "#quota";
import { AppProvider } from "./context";
import { pageFromPathname, pageSubtitle, pageTitle, settingsTabFromPathname } from "./route-meta";

export function AppShell(): React.ReactElement {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const page = pageFromPathname(pathname);
  const settingsTab = settingsTabFromPathname(pathname);

  const [horizon, setHorizon] = useState<"1h" | "3h" | "6h">("3h");
  const [detailAccount, setDetailAccount] = useState<QuotaAccountUx | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(isOnboardingDismissed);
  const [limitBannerHidden, setLimitBannerHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const onModelsHydratedRef = useRef((_embed: string, _wiki: string) => {});

  const rivet = useRivetData({
    horizon,
    setBusy,
    onModelsHydrated: (embed, wiki) => onModelsHydratedRef.current(embed, wiki),
  });

  const ops = useAppOperations({
    horizon,
    setBusy,
    status: rivet.status,
    runtimeLogsEnabled: page === "runtime",
  });

  onModelsHydratedRef.current = ops.hydrateModels;

  const openSettings = useCallback(
    (tab: SettingsTab = "accounts") => {
      void navigate({ to: "/settings/$tab", params: { tab } });
    },
    [navigate],
  );

  const accountsHook = useAccounts({
    accounts: rivet.accounts,
    ensureSession: rivet.ensureSession,
    refresh: rivet.refresh,
    horizon,
    openSettings,
    setBusy,
  });

  const derived = useQuotaDerived({
    filter: "all",
    limitBannerHidden,
    catalog: rivet.catalog,
    accounts: rivet.accounts,
    quota: rivet.quota,
    recent: rivet.recent,
  });

  const hideLimitBanner = useCallback(() => setLimitBannerHidden(true), []);
  const dismissOnboardingUi = useCallback(() => setOnboardingDismissed(true), []);

  const title = pageTitle(page, settingsTab);
  const subtitle = pageSubtitle({
    page,
    settingsTab,
    status: rivet.status,
    quota: rivet.quota,
    accountCount: rivet.accounts.length,
    recentCount: rivet.recent.length,
    wiki: null,
  });

  const appValue = useMemo(
    () => ({
      rivet,
      ops,
      accounts: accountsHook,
      derived,
      busy,
      horizon,
      setHorizon,
      limitBannerHidden,
      hideLimitBanner,
      detailAccount,
      setDetailAccount,
      onboardingDismissed,
      dismissOnboardingUi,
      openSettings,
    }),
    [
      rivet,
      ops,
      accountsHook,
      derived,
      busy,
      horizon,
      limitBannerHidden,
      hideLimitBanner,
      detailAccount,
      onboardingDismissed,
      dismissOnboardingUi,
      openSettings,
    ],
  );

  return (
    <AppProvider value={appValue}>
      <div
        className={cn(
          "grid h-screen min-h-[640px] grid-cols-[212px_1fr] grid-rows-[1fr_auto]",
          "max-[860px]:grid-cols-1 max-[860px]:grid-rows-[auto_1fr_auto]",
        )}
      >
        <MockDevBar />
        <AppSidebar
          page={page}
          settingsTab={settingsTab}
          accountCount={rivet.accounts.length}
          trafficEventCount={rivet.status?.usage.events ?? 0}
        />

        <div
          className={cn(
            "col-start-2 row-start-1 flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
            "max-[860px]:col-start-1 max-[860px]:row-start-2 max-[860px]:h-auto max-[860px]:min-h-0",
          )}
        >
          <AppTopbar
            title={title}
            subtitle={subtitle}
            page={page}
            busy={busy}
            onRefresh={() => void rivet.refresh()}
            quota={
              page === "quota"
                ? {
                    onManageCredentials: () => openSettings("accounts"),
                  }
                : undefined
            }
            wiki={
              page === "wiki"
                ? {
                    wikiEnabled: !!rivet.status?.capabilities.wiki,
                    onOpenSettings: () => openSettings("intelligence"),
                    onOpenFolder: () => void ops.openWiki(),
                  }
                : undefined
            }
            runtime={
              page === "runtime"
                ? {
                    proxyRunning: !!rivet.status?.proxy_running,
                    apiOnline: rivet.apiOnline,
                    onProxyStart: () => void ops.proxyAction("start"),
                    onProxyStop: () => void ops.proxyAction("stop"),
                    onProxyRestart: () => void ops.proxyAction("restart"),
                    onRunWorkers: () => void ops.runWorkers(),
                  }
                : undefined
            }
            data={
              page === "data"
                ? {
                    canRevealExport: !!ops.bagPath,
                    onExport: () => void ops.exportBag(),
                    onImport: () => void ops.importBag(),
                    onRevealExport: () => void ops.revealExport(),
                  }
                : undefined
            }
          />

          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-auto px-6 pt-2 pb-5",
              "data-[page=data]:overflow-hidden data-[page=data]:pb-0",
              "data-[page=wiki]:overflow-hidden data-[page=wiki]:p-0",
              "data-[page=runtime]:overflow-hidden data-[page=runtime]:p-0",
              "data-[page=settings]:overflow-hidden data-[page=settings]:p-0",
            )}
            data-page={page}
          >
            <Outlet />
          </div>
        </div>

        <MultiAccountWarnModal
          warn={accountsHook.multiAccountWarn}
          busy={busy}
          catalog={rivet.catalog}
          providerAccountCount={accountsHook.providerAccountCount}
          onDismiss={() => accountsHook.setMultiAccountWarn(null)}
          onConfirm={accountsHook.confirmMultiAccountWarn}
        />

        <AppStatusBar
          syncing={syncing}
          onSync={() => {
            void (async () => {
              setSyncing(true);
              try {
                await rivet.refresh();
              } finally {
                setSyncing(false);
              }
            })();
          }}
          accountCount={derived.counts.all ?? 0}
          status={rivet.status}
          apiOnline={rivet.apiOnline}
          onOpenRuntime={() => void navigate({ to: "/runtime" })}
        />
        {rivet.status?.onboarding &&
          onboardingIncomplete(rivet.status.onboarding) &&
          !onboardingDismissed && (
            <OnboardingOverlay
              onboarding={rivet.status.onboarding}
              onDismiss={() => {
                dismissOnboarding();
                dismissOnboardingUi();
              }}
              onStartProxy={() => void ops.proxyAction("start")}
              onAddAccount={accountsHook.beginAddAccount}
              onHarness={(target) => void accountsHook.writeHarness(target, "user")}
            />
          )}

        <AccountDetailSheet
          account={detailAccount}
          catalog={rivet.catalog}
          onClose={() => setDetailAccount(null)}
        />
      </div>
    </AppProvider>
  );
}
