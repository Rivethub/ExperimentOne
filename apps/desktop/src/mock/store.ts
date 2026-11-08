import type { LoginStatus } from "../types";
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
  if (!store) store = createStore(getMockScenario());
  return store;
}

export function resetStore(scenario?: MockScenario) {
  if (store?.loginTimer) clearTimeout(store.loginTimer);
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

export function rebuildDerivedQuota(s: MockStore) {
  s.accounts = accountsFromQuota(s.quotaAccounts);
}

export function currentStatus(s: MockStore) {
  return seedStatus(s.scenario, {
    accounts: s.accounts,
    traffic: s.traffic,
    proxyRunning: s.proxyRunning,
    wikiEnabled: s.wikiEnabled,
    vectorEnabled: s.vectorEnabled,
    embedModel: s.embedModel,
    wikiModel: s.wikiModel,
  });
}

export function currentQuota(s: MockStore) {
  return {
    source: "management",
    observed_at: new Date().toISOString(),
    credentials_total: s.quotaAccounts.length,
    credentials_loaded: s.quotaAccounts.filter((a) => a.loaded).length,
    providers: buildProviderQuota(s.quotaAccounts),
    accounts: s.quotaAccounts,
    note: "Mock IPC — remaining sums are fixture data; burn is illustrative.",
  };
}

export function currentQuotaHistory(s: MockStore, hours: number) {
  return seedQuotaHistory(s.quotaAccounts, hours);
}
