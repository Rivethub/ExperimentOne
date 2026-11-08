import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { MultiAccountWarnModal } from "./components/MultiAccountWarnModal";
import { useAccounts, useAppOperations, useQuotaDerived, useRivetData, useWiki } from "./hooks";
import { MockDevBar } from "./mock";
import {
  AppSidebar,
  AppStatusBar,
  AppTopbar,
  DataPane,
  QuotaPane,
  RuntimePane,
  SettingsPane,
  WikiPane,
} from "./panes";
import { pageSubtitle, pageTitle } from "./pageMeta";
import {
  AccountDetailSheet,
  MetricMode,
  OnboardingOverlay,
  QuotaAccountUx,
  dismissOnboarding,
  isOnboardingDismissed,
  onboardingIncomplete,
} from "./quota";
import type {
  ConversationSummary,
  Page,
  ProviderFilter,
  SearchMode,
  SettingsTab,
  TrafficEvent,
} from "./types";
import { Button } from "./ui";
import styles from "./styles/app.module.css";

export default function App() {
  const [page, setPage] = useState<Page>("quota");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("accounts");
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [horizon, setHorizon] = useState<"1h" | "3h" | "6h">("3h");
  const [metricMode, setMetricMode] = useState<MetricMode>("limits");
  const [detailAccount, setDetailAccount] = useState<QuotaAccountUx | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(isOnboardingDismissed);
  const [limitBannerHidden, setLimitBannerHidden] = useState(false);
  const [listQuery, setListQuery] = useState("");
  const deferredListQuery = useDeferredValue(listQuery);
  const [searchMode, setSearchMode] = useState<SearchMode>("keyword");
  const deferredSearchMode = useDeferredValue(searchMode);
  const [searchModeLabel, setSearchModeLabel] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationMessages, setConversationMessages] = useState<TrafficEvent[]>([]);
  const [threadQuery, setThreadQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [statusAction, setStatusAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openSettings = useCallback((tab: SettingsTab = "accounts") => {
    setSettingsTab(tab);
    setPage("settings");
  }, []);

  const onModelsHydratedRef = useRef((_embed: string, _wiki: string) => {});
  const onDataMutatedRef = useRef(() => {});

  const rivet = useRivetData({
    horizon,
    trafficQuery: "",
    setBusy,
    setStatusAction,
    setError,
    onModelsHydrated: (embed, wiki) => onModelsHydratedRef.current(embed, wiki),
  });

  const wikiHook = useWiki({ page, ensureSession: rivet.ensureSession });

  const ops = useAppOperations({
    ensureSession: rivet.ensureSession,
    refresh: rivet.refresh,
    refreshWiki: wikiHook.refreshWiki,
    setTrafficRows: rivet.setTrafficRows,
    setConversations,
    setSearchModeLabel,
    setBusy,
    setStatusAction,
    setError,
    status: rivet.status,
    wiki: wikiHook.wiki,
    onDataMutated: () => onDataMutatedRef.current(),
  });

  onModelsHydratedRef.current = ops.hydrateModels;
  onDataMutatedRef.current = () => {
    if (page === "data") void ops.searchConversations(deferredListQuery, deferredSearchMode);
  };

  const accountsHook = useAccounts({
    accounts: rivet.accounts,
    ensureSession: rivet.ensureSession,
    refresh: rivet.refresh,
    openSettings,
    setBusy,
    setStatusAction,
    setError,
  });

  const derived = useQuotaDerived({
    filter,
    limitBannerHidden,
    catalog: rivet.catalog,
    accounts: rivet.accounts,
    quota: rivet.quota,
    recent: rivet.recent,
  });

  useEffect(() => {
    void (async () => {
      await wikiHook.refreshWiki();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount wiki snapshot after rivet boot
  }, []);

  const { loadLogs, loadConversationEvents, searchConversations, listSearching } = ops;

  useEffect(() => {
    if (page === "runtime") void loadLogs();
  }, [page, loadLogs]);

  useEffect(() => {
    const id = setInterval(() => {
      if (page === "runtime") void loadLogs();
    }, 10_000);
    return () => clearInterval(id);
  }, [page, loadLogs]);

  const vectorSearchEnabled = !!rivet.status?.capabilities.vector_search;

  useEffect(() => {
    if (vectorSearchEnabled || searchMode !== "vector") return;
    setSearchMode("keyword");
  }, [vectorSearchEnabled, searchMode]);

  useEffect(() => {
    if (page !== "data") return;
    void searchConversations(deferredListQuery, deferredSearchMode);
  }, [page, deferredListQuery, deferredSearchMode, searchConversations]);

  const listPending =
    listQuery !== deferredListQuery ||
    searchMode !== deferredSearchMode ||
    listSearching;

  const selectConversation = useCallback(
    async (id: string | null) => {
      setSelectedConversationId(id);
      setThreadQuery("");
      if (!id) {
        setConversationMessages([]);
        return;
      }
      const messages = await loadConversationEvents(id);
      setConversationMessages(messages);
    },
    [loadConversationEvents],
  );

  const { refreshCredentials } = rivet;
  const limitActions = useMemo(
    () => ({
      onRefreshCredentials: () => void refreshCredentials(),
      onSwitchAccount: () => openSettings("accounts"),
      onWait: () => setLimitBannerHidden(true),
    }),
    [openSettings, refreshCredentials],
  );

  const title = pageTitle(page, settingsTab);
  const subtitle = pageSubtitle({
    page,
    settingsTab,
    status: rivet.status,
    quota: rivet.quota,
    accountCount: rivet.accounts.length,
    recentCount: conversations.length || rivet.recent.length,
    wiki: wikiHook.wiki,
  });

  return (
    <div className={styles.shell}>
      <MockDevBar />
      <AppSidebar
        page={page}
        settingsTab={settingsTab}
        accountCount={rivet.accounts.length}
        trafficEventCount={rivet.status?.usage.events ?? 0}
        onNavigate={setPage}
        onOpenSettings={openSettings}
      />

      <div className={styles.main}>
        <AppTopbar
          title={title}
          subtitle={subtitle}
          page={page}
          busy={busy}
          onRefresh={() => {
            void rivet.refresh();
            if (page === "data") void searchConversations(deferredListQuery, deferredSearchMode);
          }}
          quota={
            page === "quota"
              ? {
                  onRefreshCredentials: () => void rivet.refreshCredentials(),
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

        {error && <div className={styles.errorBanner}>{error}</div>}
        {ops.bagNote && (
          <div className={styles.noteBanner} role="status">
            <span>{ops.bagNote}</span>
            <Button variant="ghost" onClick={() => ops.clearBagNote()}>
              Dismiss
            </Button>
          </div>
        )}
        {rivet.status?.warnings?.map((w) => (
          <div key={w} className={styles.errorBanner}>
            {w}
          </div>
        ))}

        <div className={styles.content} data-page={page}>
          <QuotaPane
            active={page === "quota"}
            counts={derived.counts}
            filter={filter}
            onFilterChange={setFilter}
            providerIds={derived.providerIds}
            catalog={rivet.catalog}
            limitHit={derived.limitHit}
            limitActions={limitActions}
            metricMode={metricMode}
            onMetricModeChange={setMetricMode}
            horizon={horizon}
            onHorizonChange={setHorizon}
            quota={rivet.quota}
            quotaHistory={rivet.quotaHistory}
            visibleProviders={derived.visibleProviders}
            providerQuota={derived.providerQuota}
            recent={rivet.recent}
            accountsFor={derived.accountsFor}
            onAddCredentials={accountsHook.beginAddAccount}
            onAccountSelect={setDetailAccount}
          />
          <DataPane
            active={page === "data"}
            limitHit={derived.limitHit}
            limitActions={limitActions}
            catalog={rivet.catalog}
            listQuery={listQuery}
            onListQueryChange={setListQuery}
            searchMode={searchMode}
            onSearchModeChange={setSearchMode}
            vectorSearchEnabled={vectorSearchEnabled}
            searchModeLabel={searchModeLabel}
            listPending={listPending}
            conversations={conversations}
            selectedId={selectedConversationId}
            onSelectConversation={(id) => void selectConversation(id)}
            messages={conversationMessages}
            threadQuery={threadQuery}
            onThreadQueryChange={setThreadQuery}
          />
          <RuntimePane
            active={page === "runtime"}
            status={rivet.status}
            accounts={rivet.accounts}
            apiOnline={rivet.apiOnline}
            lastSyncedAt={rivet.lastSyncedAt}
            proxyLog={ops.proxyLog}
            chLog={ops.chLog}
            onCopyText={(t) => void ops.copyText(t)}
            onOpenSettings={openSettings}
            onRefresh={() => void rivet.refresh()}
            onLoadLogs={() => void ops.loadLogs()}
          />
          <WikiPane
            active={page === "wiki"}
            wiki={wikiHook.wiki}
            busy={busy}
            wikiEnabled={!!rivet.status?.capabilities.wiki}
            onOpenFolder={() => void ops.openWiki()}
            onEnable={() => openSettings("intelligence")}
            loadPage={wikiHook.loadWikiPage}
          />
          <SettingsPane
            active={page === "settings"}
            settingsTab={settingsTab}
            accounts={{
              accounts: rivet.accounts,
              quotaById: derived.quotaById,
              catalog: rivet.catalog,
              busy,
              loginActive: !!accountsHook.login?.active,
              showAddAccount: accountsHook.showAddAccount,
              onToggleAddAccount: () => accountsHook.setShowAddAccount((v) => !v),
              login: accountsHook.login,
              providerAccountCount: accountsHook.providerAccountCount,
              onRequestLogin: accountsHook.requestLogin,
              onRemoveAccount: (id) => void accountsHook.removeAccount(id),
              onOpenHarness: () => openSettings("harness"),
              onRequestVertexImport: accountsHook.requestVertexImport,
              onCancelLogin: () => void accountsHook.cancelLogin(),
              onDismissLogin: () => accountsHook.setLogin(null),
            }}
            intelligence={{
              status: rivet.status,
              embedModel: ops.embedModel,
              wikiModel: ops.wikiModel,
              onWikiModelChange: ops.setWikiModel,
              busy,
              onToggleCapability: (key, value) => void ops.toggleCapability(key, value),
              onSaveIntelligence: () => void ops.saveIntelligence(),
              onRunWorkers: () => void ops.runWorkers(),
              onOpenRuntime: () => setPage("runtime"),
              bagNote: ops.bagNote,
            }}
            harness={{
              busy,
              harnessNote: accountsHook.harnessNote,
              snippet: accountsHook.snippet,
              onWriteHarness: (target, mode) => void accountsHook.writeHarness(target, mode),
              onLoadClaude: () => void accountsHook.loadClaude(),
              onLoadCodex: () => void accountsHook.loadCodex(),
              onLoadMcp: () => void accountsHook.loadMcp(),
              onCopyText: (t) => void ops.copyText(t),
            }}
          />
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
        accountCount={derived.counts.all}
        status={rivet.status}
        apiOnline={rivet.apiOnline}
        onOpenRuntime={() => setPage("runtime")}
        statusAction={statusAction}
        error={error}
        onDismissError={() => setError(null)}
      />
      {rivet.status?.onboarding &&
        onboardingIncomplete(rivet.status.onboarding) &&
        !onboardingDismissed && (
          <OnboardingOverlay
            onboarding={rivet.status.onboarding}
            onDismiss={() => {
              dismissOnboarding();
              setOnboardingDismissed(true);
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
  );
}
