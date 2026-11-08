import type { CatalogProvider } from "../../lib/provider-utils";
import type { QuotaAccountUx } from "../../quota";
import type { Account, HarnessWrite, LoginStatus, SettingsTab, Status } from "../../lib/types";

export type SettingsAccountsProps = {
  accounts: Account[];
  quotaById: Map<string, QuotaAccountUx>;
  catalog: CatalogProvider[];
  busy: boolean;
  loginActive: boolean;
  showAddAccount: boolean;
  onToggleAddAccount: () => void;
  login: LoginStatus | null;
  providerAccountCount: (provider: string) => number;
  onRequestLogin: (provider: string, method?: "browser" | "device") => void;
  onRemoveAccount: (id: string) => void;
  onOpenHarness: () => void;
  onRequestVertexImport: () => void;
  onCancelLogin: () => void;
  onDismissLogin: () => void;
};

export type SettingsIntelligenceProps = {
  status: Status | null;
  embedModel: string;
  wikiModel: string;
  onWikiModelChange: (model: string) => void;
  busy: boolean;
  onToggleCapability: (key: "vector_search" | "wiki", value: boolean) => void;
  onSaveIntelligence: () => void;
  onRunWorkers: () => void;
  onOpenRuntime: () => void;
  bagNote: string | null;
};

export type SettingsHarnessProps = {
  busy: boolean;
  harnessNote: HarnessWrite | null;
  snippet: string;
  onWriteHarness: (target: "claude" | "codex", mode: "user" | "isolated") => void;
  onLoadClaude: () => void;
  onLoadCodex: () => void;
  onLoadMcp: () => void;
  onCopyText: (text: string) => void;
  onIngestLocal: () => void;
};

export type SettingsPaneProps = {
  active: boolean;
  settingsTab: SettingsTab;
  accounts: SettingsAccountsProps;
  intelligence: SettingsIntelligenceProps;
  harness: SettingsHarnessProps;
};
