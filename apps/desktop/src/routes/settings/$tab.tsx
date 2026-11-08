import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useApp } from "#app/context";
import { isSettingsTab } from "#lib/app-path";
import type { SettingsTab } from "#lib/types";
import { SettingsPane } from "#panes";

export const Route = createFileRoute("/settings/$tab")({
  beforeLoad: ({ params }) => {
    if (!isSettingsTab(params.tab)) {
      throw redirect({ to: "/settings/$tab", params: { tab: "accounts" } });
    }
  },
  component: SettingsPage,
});

function SettingsPage(): React.ReactElement {
  const { rivet, ops, accounts, derived, busy, openSettings } = useApp();
  const { tab } = Route.useParams();
  const settingsTab = tab as SettingsTab;
  const navigate = useNavigate();

  return (
    <SettingsPane
      settingsTab={settingsTab}
      accounts={{
        accounts: rivet.accounts,
        quotaById: derived.quotaById,
        catalog: rivet.catalog,
        busy,
        loginActive: !!accounts.login?.active,
        showAddAccount: accounts.showAddAccount,
        onToggleAddAccount: () => accounts.setShowAddAccount((v) => !v),
        login: accounts.login,
        providerAccountCount: accounts.providerAccountCount,
        onRequestLogin: accounts.requestLogin,
        onRemoveAccount: (id) => void accounts.removeAccount(id),
        onOpenHarness: () => openSettings("harness"),
        onRequestVertexImport: accounts.requestVertexImport,
        onCancelLogin: () => void accounts.cancelLogin(),
        onDismissLogin: () => accounts.setLogin(null),
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
        onOpenRuntime: () => void navigate({ to: "/runtime" }),
      }}
      harness={{
        busy,
        harnessNote: accounts.harnessNote,
        snippet: accounts.snippet,
        onWriteHarness: (target, mode) => void accounts.writeHarness(target, mode),
        onLoadClaude: () => void accounts.loadClaude(),
        onLoadCodex: () => void accounts.loadCodex(),
        onLoadMcp: () => void accounts.loadMcp(),
        onCopyText: (t) => void ops.copyText(t),
      }}
    />
  );
}
