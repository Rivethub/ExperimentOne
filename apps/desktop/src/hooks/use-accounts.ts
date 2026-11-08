import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { MultiAccountWarnState } from "../components/MultiAccountWarnModal";
import { rivetErrorMessage } from "../effect";
import { notify } from "../lib/notify";
import { providerKey } from "../lib/provider-utils";
import type { Account, HarnessWrite, LoginStatus, SettingsTab } from "../lib/types";
import { useAccountsHarness, useAccountsLogin, useAccountsVertex } from "./use-accounts.parts";
import { useRivetMutations } from "./use-rivet-mutations";

type AccountsOpts = {
  accounts: Account[];
  ensureSession: () => Promise<void>;
  refresh: () => Promise<void>;
  horizon?: "1h" | "3h" | "6h";
  openSettings: (tab?: SettingsTab) => void;
  setBusy: (v: boolean) => void;
};

export type UseAccountsResult = {
  login: LoginStatus | null;
  setLogin: Dispatch<SetStateAction<LoginStatus | null>>;
  showAddAccount: boolean;
  setShowAddAccount: Dispatch<SetStateAction<boolean>>;
  multiAccountWarn: MultiAccountWarnState;
  setMultiAccountWarn: Dispatch<SetStateAction<MultiAccountWarnState>>;
  vertexPath: string;
  setVertexPath: Dispatch<SetStateAction<string>>;
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
  writeHarness: (target: "claude" | "codex", mode?: "user" | "isolated") => Promise<void>;
  loadClaude: () => Promise<void>;
  loadCodex: () => Promise<void>;
  loadMcp: () => Promise<void>;
  confirmMultiAccountWarn: (pending: NonNullable<MultiAccountWarnState>) => void;
};

export function useAccounts(opts: AccountsOpts): UseAccountsResult {
  const { accounts, refresh, horizon = "1h", openSettings, setBusy } = opts;
  const mutations = useRivetMutations({ horizon });
  const [multiAccountWarn, setMultiAccountWarn] = useState<MultiAccountWarnState>(null);
  const clearMultiAccountWarn = useCallback(() => {
    setMultiAccountWarn(null);
  }, []);

  const coreOpts = {
    refresh,
    openSettings,
    setBusy,
    mutations,
  };
  const loginApi = useAccountsLogin(coreOpts, clearMultiAccountWarn);
  const vertexApi = useAccountsVertex(coreOpts, loginApi, clearMultiAccountWarn);
  const harnessApi = useAccountsHarness({ setBusy, mutations });

  const providerAccountCount = useCallback(
    (provider: string) => {
      const key = providerKey(provider);
      return accounts.filter((a) => providerKey(a.provider) === key).length;
    },
    [accounts],
  );

  const requestLogin = useCallback(
    (provider: string, method?: "browser" | "device") => {
      if (providerAccountCount(provider) >= 1) {
        setMultiAccountWarn({ provider, method, kind: "login" });
        return;
      }
      void loginApi.startLogin(provider, method);
    },
    [providerAccountCount, loginApi],
  );

  const requestVertexImport = useCallback(() => {
    if (providerAccountCount("vertex") >= 1) {
      setMultiAccountWarn({ provider: "vertex", kind: "vertex" });
      return;
    }
    void vertexApi.importVertex();
  }, [providerAccountCount, vertexApi]);

  const beginAddAccount = useCallback(() => {
    loginApi.setShowAddAccount(true);
    openSettings("accounts");
  }, [openSettings, loginApi]);

  const removeAccount = useCallback(
    async (id: string) => {
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
    },
    [mutations.removeAccount, setBusy],
  );
  const confirmMultiAccountWarn = useCallback(
    (pending: NonNullable<MultiAccountWarnState>) => {
      setMultiAccountWarn(null);
      if (pending.kind === "vertex") {
        void vertexApi.importVertex();
      } else {
        void loginApi.startLogin(pending.provider, pending.method);
      }
    },
    [vertexApi, loginApi],
  );

  return {
    login: loginApi.login,
    setLogin: loginApi.setLogin,
    showAddAccount: loginApi.showAddAccount,
    setShowAddAccount: loginApi.setShowAddAccount,
    multiAccountWarn,
    setMultiAccountWarn,
    vertexPath: vertexApi.vertexPath,
    setVertexPath: vertexApi.setVertexPath,
    harnessNote: harnessApi.harnessNote,
    snippet: harnessApi.snippet,
    providerAccountCount,
    requestLogin,
    startLogin: loginApi.startLogin,
    requestVertexImport,
    importVertex: vertexApi.importVertex,
    beginAddAccount,
    cancelLogin: loginApi.cancelLogin,
    removeAccount,
    writeHarness: harnessApi.writeHarness,
    loadClaude: harnessApi.loadClaude,
    loadCodex: harnessApi.loadCodex,
    loadMcp: harnessApi.loadMcp,
    confirmMultiAccountWarn,
  };
}
