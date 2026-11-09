import { Outlet, useNavigate, useRouterState } from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { MultiAccountWarnModal } from "#components/MultiAccountWarnModal";
import { SidebarInset, SidebarProvider } from "#components/ui/sidebar";
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

export function AppShell(): JSX.Element {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const page = () => pageFromPathname(pathname());
  const settingsTab = () => settingsTabFromPathname(pathname());

  const [horizon, setHorizon] = createSignal<"1h" | "3h" | "6h">("3h");
  const [detailAccount, setDetailAccount] = createSignal<QuotaAccountUx | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = createSignal(isOnboardingDismissed());
  const [limitBannerHidden, setLimitBannerHidden] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);

  const onModelsHydratedRef: {
    current: (opts: {
      embedModel: string;
      wikiModel: string;
      embedAccountId?: string;
      wikiAccountId?: string;
    }) => void;
  } = {
    current: () => {},
  };

  const rivet = useRivetData({
    horizon,
    setBusy,
    onModelsHydrated: (opts) => onModelsHydratedRef.current(opts),
  });

  const ops = useAppOperations({
    horizon,
    setBusy,
    status: () => rivet.status,
    runtimeLogsEnabled: () => page() === "runtime",
  });

  onModelsHydratedRef.current = ops.hydrateModels;

  const openSettings = (tab: SettingsTab = "accounts") => {
    void navigate({ to: "/settings/$tab", params: { tab } });
  };

  const accountsHook = useAccounts({
    accounts: () => rivet.accounts,
    ensureSession: rivet.ensureSession,
    refresh: rivet.refresh,
    horizon,
    openSettings,
    setBusy,
  });

  const derived = useQuotaDerived({
    filter: () => "all",
    limitBannerHidden,
    catalog: () => rivet.catalog,
    accounts: () => rivet.accounts,
    quota: () => rivet.quota,
    recent: () => rivet.recent,
  });

  const hideLimitBanner = () => setLimitBannerHidden(true);
  const dismissOnboardingUi = () => setOnboardingDismissed(true);

  const title = () => pageTitle(page(), settingsTab());
  const subtitle = () =>
    pageSubtitle({
      page: page(),
      settingsTab: settingsTab(),
      status: rivet.status,
      quota: rivet.quota,
      accountCount: rivet.accounts.length,
      recentCount: rivet.recent.length,
      wiki: null,
    });

  const appValue = {
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
  };

  return (
    <AppProvider value={appValue}>
      <SidebarProvider class="flex h-svh min-h-[640px] flex-col overflow-hidden">
        <MockDevBar />
        <div class="flex min-h-0 w-full flex-1">
          <AppSidebar
            page={page()}
            settingsTab={settingsTab()}
            captureEventCount={rivet.status?.usage.events ?? 0}
          />

          <SidebarInset class="min-h-0 overflow-hidden">
            <AppTopbar
              title={title()}
              subtitle={subtitle()}
              page={page()}
              settingsTab={settingsTab()}
              busy={busy()}
              onRefresh={() => void rivet.refresh()}
              quota={
                page() === "quota"
                  ? {
                      onManageCredentials: () => openSettings("accounts"),
                    }
                  : undefined
              }
              wiki={
                page() === "wiki"
                  ? {
                      wikiEnabled: !!rivet.status?.capabilities.wiki,
                      onOpenSettings: () => openSettings("intelligence"),
                      onOpenFolder: () => void ops.openWiki(),
                    }
                  : undefined
              }
              runtime={
                page() === "runtime"
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
                page() === "data"
                  ? {
                      canRevealExport: !!ops.bagPath,
                      onExport: () => void ops.exportBag(),
                      onImport: () => void ops.importBag(),
                      onIngestLocal: () => void ops.ingestLocal(),
                      onRevealExport: () => void ops.revealExport(),
                    }
                  : undefined
              }
            />

            <div
              class={cn(
                "@container/main flex min-h-0 flex-1 flex-col overflow-auto px-4 pt-2 pb-5 md:px-6",
                "data-[page=data]:overflow-hidden data-[page=data]:pb-0",
                "data-[page=topics]:overflow-hidden data-[page=topics]:pb-0",
                "data-[page=wiki]:overflow-hidden data-[page=wiki]:p-0",
                "data-[page=runtime]:overflow-hidden data-[page=runtime]:p-0",
                "data-[page=settings]:overflow-hidden data-[page=settings]:p-0",
              )}
              data-page={page()}
            >
              <Outlet />
            </div>
          </SidebarInset>
        </div>

        <AppStatusBar
          syncing={syncing()}
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

        <MultiAccountWarnModal
          warn={accountsHook.multiAccountWarn}
          busy={busy()}
          catalog={rivet.catalog}
          providerAccountCount={accountsHook.providerAccountCount}
          onDismiss={() => accountsHook.setMultiAccountWarn(null)}
          onConfirm={accountsHook.confirmMultiAccountWarn}
        />

        <Show
          when={
            rivet.status?.onboarding &&
            onboardingIncomplete(rivet.status.onboarding) &&
            !onboardingDismissed()
              ? rivet.status.onboarding
              : false
          }
        >
          {(onboarding) => (
            <OnboardingOverlay
              onboarding={onboarding()}
              onDismiss={() => {
                dismissOnboarding();
                dismissOnboardingUi();
              }}
              onStartProxy={() => void ops.proxyAction("start")}
              onAddAccount={accountsHook.beginAddAccount}
              onHarness={(target) => void accountsHook.writeHarness(target, "user")}
            />
          )}
        </Show>

        <AccountDetailSheet
          account={detailAccount()}
          catalog={rivet.catalog}
          onClose={() => setDetailAccount(null)}
        />
      </SidebarProvider>
    </AppProvider>
  );
}
