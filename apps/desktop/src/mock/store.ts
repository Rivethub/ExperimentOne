import type { LoginStatus, QuotaHistory, QuotaSnapshot, Status } from "../lib/types";
import {
  MOCK_PROVIDERS,
  accountsFromQuota,
  buildProviderQuota,
  seedQuotaAccounts,
  seedQuotaHistory,
  seedStatus,
  seedTraffic,
  seedWiki,
  wikiPageBodies,
} from "./fixtures";
import { getMockScenario, type MockScenario } from "./mode";

export type MockStore = {
  scenario: MockScenario;
  proxyRunning: boolean;
  wikiEnabled: boolean;
  vectorEnabled: boolean;
  embedModel: string | null;
  wikiModel: string | null;
  quotaAccounts: ReturnType<typeof seedQuotaAccounts>;
  accounts: ReturnType<typeof accountsFromQuota>;
  traffic: ReturnType<typeof seedTraffic>;
  wiki: ReturnType<typeof seedWiki>;
  wikiBodies: Record<string, string>;
  login: LoginStatus | null;
  loginTimer: ReturnType<typeof setTimeout> | null;
  lastExportPath: string | null;
  providers: typeof MOCK_PROVIDERS;
};

let store: MockStore | null = null;

export function getStore(): MockStore {
  store ??= createStore(getMockScenario());
  return store;
}

export function resetStore(scenario?: MockScenario): MockStore {
  if (store?.loginTimer) {
    clearTimeout(store.loginTimer);
  }
  store = createStore(scenario ?? getMockScenario());
  return store;
}

function createStore(scenario: MockScenario): MockStore {
  const quotaAccounts = seedQuotaAccounts(scenario);
  const accounts = accountsFromQuota(quotaAccounts);
  const traffic = seedTraffic(scenario);
  const proxyRunning = scenario !== "fresh";
  const wikiEnabled = scenario !== "fresh";
  const vectorEnabled = scenario === "default" || scenario === "limit-hit";
  return {
    scenario,
    proxyRunning,
    wikiEnabled,
    vectorEnabled,
    embedModel: vectorEnabled ? "" : null,
    wikiModel: wikiEnabled ? "claude-sonnet-4-5" : null,
    quotaAccounts,
    accounts,
    traffic,
    wiki: seedWiki(),
    wikiBodies: wikiPageBodies(),
    login: null,
    loginTimer: null,
    lastExportPath: null,
    providers: MOCK_PROVIDERS,
  };
}

export function rebuildDerivedQuota(): void {
  const active = getStore();
  active.accounts = accountsFromQuota(active.quotaAccounts);
}

export function currentStatus(snapshot: MockStore): Status {
  return seedStatus(snapshot.scenario, {
    accounts: snapshot.accounts,
    traffic: snapshot.traffic,
    proxyRunning: snapshot.proxyRunning,
    wikiEnabled: snapshot.wikiEnabled,
    vectorEnabled: snapshot.vectorEnabled,
    embedModel: snapshot.embedModel,
    wikiModel: snapshot.wikiModel,
  });
}

export function currentQuota(snapshot: MockStore): QuotaSnapshot {
  return {
    source: "management",
    observed_at: new Date().toISOString(),
    credentials_total: snapshot.quotaAccounts.length,
    credentials_loaded: snapshot.quotaAccounts.filter((a) => a.loaded).length,
    providers: buildProviderQuota(snapshot.quotaAccounts),
    accounts: snapshot.quotaAccounts,
    note: "Mock IPC — remaining sums are fixture data; burn is illustrative.",
  };
}

export function currentQuotaHistory(snapshot: MockStore, hours: number): QuotaHistory {
  return seedQuotaHistory(snapshot.quotaAccounts, hours);
}
