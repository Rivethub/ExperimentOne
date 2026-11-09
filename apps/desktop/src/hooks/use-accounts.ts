import type { Accessor, Setter } from "solid-js";
import { createSignal } from "solid-js";
import type { MultiAccountWarnState } from "../components/MultiAccountWarnModal";
import { rivetErrorMessage } from "../effect";
import type { HarnessInstallTarget } from "../lib/format-utils";
import { notify } from "../lib/notify";
import { providerKey } from "../lib/provider-utils";
import type { Account, HarnessWrite, LoginStatus, SettingsTab } from "../lib/types";
import { useAccountsHarness, useAccountsLogin, useAccountsVertex } from "./use-accounts.parts";
import { useRivetMutations } from "./use-rivet-mutations";

type AccountsOpts = {
  accounts: Accessor<Account[]>;
  ensureSession: () => Promise<void>;
  refresh: () => Promise<void>;
  horizon: Accessor<"1h" | "3h" | "6h">;
  openSettings: (tab?: SettingsTab) => void;
  setBusy: (v: boolean) => void;
};

export type UseAccountsResult = {
  login: LoginStatus | null;
  setLogin: Setter<LoginStatus | null>;
  showAddAccount: boolean;
  setShowAddAccount: Setter<boolean>;
  multiAccountWarn: MultiAccountWarnState;
  setMultiAccountWarn: Setter<MultiAccountWarnState>;
  vertexPath: string;
  setVertexPath: Setter<string>;
  harnessNote: HarnessWrite | null;
  snippet: string;
  providerAccountCount: (provider: string) => number;
  requestLogin: (provider: string, method?: "browser" | "device") => void;
  startLogin: (provider: string, method?: "browser" | "device") => Promise<void>;
  requestVertexImport: () => void;
  importVertex: () => Promise<void>;
  beginAddAccount: () => void;
  cancelLogin: () => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  writeHarness: (target: HarnessInstallTarget, mode?: "user" | "isolated") => Promise<void>;
  writeAllHarnesses: () => Promise<void>;
  loadClaude: () => Promise<void>;
  loadCodex: () => Promise<void>;
  loadMcp: () => Promise<void>;
  confirmMultiAccountWarn: (pending: NonNullable<MultiAccountWarnState>) => void;
};

export function useAccounts(opts: AccountsOpts): UseAccountsResult {
  const { refresh, openSettings, setBusy } = opts;
  const mutations = useRivetMutations({ horizon: opts.horizon });
  const [multiAccountWarn, setMultiAccountWarn] = createSignal<MultiAccountWarnState>(null);
  const clearMultiAccountWarn = () => {
    setMultiAccountWarn(null);
  };

  const coreOpts = {
    refresh,
    openSettings,
    setBusy,
    mutations,
  };
  const loginApi = useAccountsLogin(coreOpts, clearMultiAccountWarn);
  const vertexApi = useAccountsVertex(coreOpts, loginApi, clearMultiAccountWarn);
  const harnessApi = useAccountsHarness({ setBusy, mutations });

  const providerAccountCount = (provider: string) => {
    const key = providerKey(provider);
    return opts.accounts().filter((a) => providerKey(a.provider) === key).length;
  };

  const requestLogin = (provider: string, method?: "browser" | "device") => {
    if (providerAccountCount(provider) >= 1) {
      setMultiAccountWarn({ provider, method, kind: "login" });
      return;
    }
    void loginApi.startLogin(provider, method);
  };

  const requestVertexImport = () => {
    if (providerAccountCount("vertex") >= 1) {
      setMultiAccountWarn({ provider: "vertex", kind: "vertex" });
      return;
    }
    void vertexApi.importVertex();
  };

  const beginAddAccount = () => {
    loginApi.setShowAddAccount(true);
    openSettings("accounts");
  };

  const removeAccount = async (id: string) => {
    const confirmed = await (async (): Promise<boolean> => {
      try {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        return await ask(`Remove account “${id}”? This deletes the local credential file.`, {
          title: "Remove account",
          kind: "warning",
        });
      } catch {
        notify.error("Removal requires the desktop app confirmation dialog.");
        return false;
      }
    })();
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      await mutations.removeAccount.mutateAsync(id);
      notify.success("Account removed");
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmMultiAccountWarn = (pending: NonNullable<MultiAccountWarnState>) => {
    setMultiAccountWarn(null);
    if (pending.kind === "vertex") {
      void vertexApi.importVertex();
    } else {
      void loginApi.startLogin(pending.provider, pending.method);
    }
  };

  return {
    get login() {
      return loginApi.login;
    },
    setLogin: loginApi.setLogin,
    get showAddAccount() {
      return loginApi.showAddAccount;
    },
    setShowAddAccount: loginApi.setShowAddAccount,
    get multiAccountWarn() {
      return multiAccountWarn();
    },
    setMultiAccountWarn,
    get vertexPath() {
      return vertexApi.vertexPath;
    },
    setVertexPath: vertexApi.setVertexPath,
    get harnessNote() {
      return harnessApi.harnessNote;
    },
    get snippet() {
      return harnessApi.snippet;
    },
    providerAccountCount,
    requestLogin,
    startLogin: loginApi.startLogin,
    requestVertexImport,
    importVertex: vertexApi.importVertex,
    beginAddAccount,
    cancelLogin: loginApi.cancelLogin,
    removeAccount,
    writeHarness: harnessApi.writeHarness,
    writeAllHarnesses: harnessApi.writeAllHarnesses,
    loadClaude: harnessApi.loadClaude,
    loadCodex: harnessApi.loadCodex,
    loadMcp: harnessApi.loadMcp,
    confirmMultiAccountWarn,
  };
}
