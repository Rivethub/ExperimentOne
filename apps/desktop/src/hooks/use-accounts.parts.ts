import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { rivetErrorMessage, runApp } from "../effect";
import * as Rivet from "../effect/rivet";
import { firstHttpUrl, type HarnessInstallTarget } from "../lib/format-utils";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/query-keys";
import type { HarnessWrite, LoginStatus, SettingsTab } from "../lib/types";

export type AccountsLoginApi = {
  login: LoginStatus | null;
  setLogin: Dispatch<SetStateAction<LoginStatus | null>>;
  showAddAccount: boolean;
  setShowAddAccount: Dispatch<SetStateAction<boolean>>;
  refreshLogin: () => Promise<void>;
  startLogin: (provider: string, method?: "browser" | "device") => Promise<void>;
  cancelLogin: () => Promise<void>;
};

export type AccountsVertexApi = {
  vertexPath: string;
  setVertexPath: Dispatch<SetStateAction<string>>;
  importVertex: () => Promise<void>;
};

export type AccountsHarnessApi = {
  harnessNote: HarnessWrite | null;
  snippet: string;
  writeHarness: (target: HarnessInstallTarget, mode?: "user" | "isolated") => Promise<void>;
  writeAllHarnesses: () => Promise<void>;
  loadClaude: () => Promise<void>;
  loadCodex: () => Promise<void>;
  loadMcp: () => Promise<void>;
};

export type AccountsMutations = {
  startLogin: {
    mutateAsync: (opts: {
      provider: string;
      method?: "browser" | "device";
    }) => Promise<{ message?: string; error?: string }>;
  };
  cancelLogin: { mutateAsync: () => Promise<unknown> };
  importVertex: {
    mutateAsync: (path: string) => Promise<{ message?: string; error?: string }>;
  };
  writeHarness: {
    mutateAsync: (opts: {
      target: HarnessInstallTarget;
      mode: "user" | "isolated";
    }) => Promise<HarnessWrite>;
  };
};

export type AccountsCoreOpts = {
  refresh: () => Promise<void>;
  openSettings: (tab?: SettingsTab) => void;
  setBusy: (v: boolean) => void;
  mutations: AccountsMutations;
};

function isDialogSinglePath(selected: unknown): selected is string {
  return typeof selected === "string";
}

export function pathFromDialogSelection(selected: string | string[] | null): string | null {
  if (isDialogSinglePath(selected)) {
    return selected;
  }
  if (Array.isArray(selected) && selected.length > 0) {
    const [first] = selected;
    return first ?? null;
  }
  return null;
}

async function fetchLoginStatus(): Promise<LoginStatus> {
  return runApp(
    Effect.gen(function* pollLoginStatus() {
      yield* Rivet.requireBackend;
      return yield* Rivet.getLoginStatus;
    }),
  );
}

export function useAccountsLogin(
  opts: AccountsCoreOpts,
  clearMultiAccountWarn: () => void,
): AccountsLoginApi {
  const { refresh, openSettings, setBusy, mutations } = opts;
  const queryClient = useQueryClient();
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const openedLoginUrl = useRef<string | null>(null);
  const loginActive = login?.active === true;

  const loginQuery = useQuery({
    queryKey: queryKeys.loginStatus,
    queryFn: fetchLoginStatus,
    enabled: loginActive,
    refetchInterval: loginActive ? 1000 : false,
    retry: false,
  });

  useEffect(() => {
    const body = loginQuery.data;
    if (body == null) {
      return;
    }
    const hasLoginSignal = body.active || body.output !== "";
    setLogin(hasLoginSignal ? body : null);
    const url = firstHttpUrl(body.output !== "" ? body.output : "");
    if (url !== null && url !== "" && url !== openedLoginUrl.current) {
      openedLoginUrl.current = url;
      void (async () => {
        try {
          const { open } = await import("@tauri-apps/plugin-shell");
          await open(url);
        } catch {
          /* browser preview / non-tauri */
        }
      })();
    }
    if (body.done && body.success) {
      openedLoginUrl.current = null;
      setShowAddAccount(false);
      void refresh();
    }
  }, [loginQuery.data, loginQuery.dataUpdatedAt, refresh]);

  const refreshLogin = useCallback(async () => {
    try {
      const body = await queryClient.fetchQuery({
        queryKey: queryKeys.loginStatus,
        queryFn: fetchLoginStatus,
      });
      const hasLoginSignal = body.active || body.output !== "";
      setLogin(hasLoginSignal ? body : null);
    } catch {
      /* rivetd down */
    }
  }, [queryClient]);

  const startLogin = useCallback(
    async (provider: string, method?: "browser" | "device") => {
      clearMultiAccountWarn();
      const toastId = "start-login";
      setBusy(true);
      notify.loading(`Starting ${provider} login…`, toastId);
      openedLoginUrl.current = null;
      try {
        const body = await mutations.startLogin.mutateAsync({ provider, method });
        if (body.error !== undefined && body.error !== "") {
          throw new Error(body.error);
        }
        setLogin({
          active: true,
          provider,
          output: body.message ?? "",
          done: false,
          success: false,
        });
        setShowAddAccount(false);
        openSettings("accounts");
        await refreshLogin();
        notify.dismiss(toastId);
      } catch (err) {
        notify.dismiss(toastId);
        notify.error(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [openSettings, refreshLogin, setBusy, clearMultiAccountWarn, mutations.startLogin],
  );

  const cancelLogin = useCallback(async () => {
    await mutations.cancelLogin.mutateAsync().catch(() => {
      /* rivetd may be down */
    });
    await refreshLogin();
  }, [refreshLogin, mutations.cancelLogin]);

  return {
    login,
    setLogin,
    showAddAccount,
    setShowAddAccount,
    refreshLogin,
    startLogin,
    cancelLogin,
  };
}

export function useAccountsVertex(
  opts: AccountsCoreOpts,
  loginApi: Pick<AccountsLoginApi, "setLogin" | "setShowAddAccount" | "refreshLogin">,
  clearMultiAccountWarn: () => void,
): AccountsVertexApi {
  const { openSettings, setBusy, mutations } = opts;
  const { setLogin, setShowAddAccount, refreshLogin } = loginApi;
  const [vertexPath, setVertexPath] = useState("");

  const importVertex = useCallback(async () => {
    clearMultiAccountWarn();
    let path = vertexPath.trim();
    if (path === "") {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "Service account", extensions: ["json"] }],
        });
        const fromPicker = pathFromDialogSelection(selected);
        if (fromPicker !== null) {
          path = fromPicker;
        }
      } catch {
        /* typed path fallback */
      }
    }
    if (path === "") {
      notify.error("Choose a Vertex service-account JSON path.");
      return;
    }
    setVertexPath(path);
    const toastId = "import-vertex";
    setBusy(true);
    notify.loading("Importing Vertex credentials…", toastId);
    try {
      const body = await mutations.importVertex.mutateAsync(path);
      if (body.error !== undefined && body.error !== "") {
        throw new Error(body.error);
      }
      setLogin({
        active: true,
        provider: "vertex",
        output: body.message ?? "",
        done: false,
        success: false,
      });
      setShowAddAccount(false);
      openSettings("accounts");
      await refreshLogin();
      notify.dismiss(toastId);
    } catch (err) {
      notify.dismiss(toastId);
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [
    vertexPath,
    openSettings,
    refreshLogin,
    setBusy,
    setLogin,
    setShowAddAccount,
    clearMultiAccountWarn,
    mutations.importVertex,
  ]);

  return { vertexPath, setVertexPath, importVertex };
}

export function useAccountsHarness(
  opts: Pick<AccountsCoreOpts, "setBusy" | "mutations">,
): AccountsHarnessApi {
  const { setBusy, mutations } = opts;
  const [harnessNote, setHarnessNote] = useState<HarnessWrite | null>(null);
  const [snippet, setSnippet] = useState("");

  const writeHarness = useCallback(
    async (target: HarnessInstallTarget, mode: "user" | "isolated" = "user") => {
      setBusy(true);
      try {
        const note = await mutations.writeHarness.mutateAsync({ target, mode });
        let isolated = "";
        if (mode === "isolated") {
          if (target === "claude" || target === "codex") {
            isolated = await runApp(
              Effect.gen(function* loadIsolatedHarness() {
                yield* Rivet.requireBackend;
                return target === "claude" ? yield* Rivet.getClaudeEnv : yield* Rivet.getCodexToml;
              }),
            );
          }
        }
        setHarnessNote(note);
        setSnippet(isolated);
        notify.success(note.note || `Wrote ${target} harness`);
      } catch (err) {
        notify.error(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [setBusy, mutations.writeHarness],
  );

  const writeAllHarnesses = useCallback(async () => {
    setBusy(true);
    try {
      const notes = await runApp(
        Effect.gen(function* writeAllHarnessConfigs() {
          yield* Rivet.requireBackend;
          const targets: HarnessInstallTarget[] = ["claude", "codex", "cursor"];
          const out: HarnessWrite[] = [];
          for (const target of targets) {
            out.push(yield* Rivet.writeHarness(target, "user"));
          }
          return out;
        }),
      );
      const paths = notes.map((n) => n.path).join("; ");
      const backup = notes
        .map((n) => n.backup_path)
        .find((p) => p !== null && p !== undefined && p !== "");
      const note =
        "Installed Rivet into ~/.claude, ~/.codex, and ~/.cursor (proxy, plugins/hooks, MCP). Restart Claude Code, Codex, and Cursor so the new config loads.";
      setHarnessNote({
        target: "all",
        path: paths,
        env_hint: "",
        note,
        backup_path: backup ?? null,
        mode: "user",
      });
      setSnippet("");
      notify.success(note);
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [setBusy]);

  const loadClaude = useCallback(async () => {
    const text = await runApp(
      Effect.gen(function* loadClaudeHarness() {
        yield* Rivet.requireBackend;
        return yield* Rivet.getClaudeEnv;
      }),
    );
    setSnippet(text);
    setHarnessNote(null);
  }, []);

  const loadCodex = useCallback(async () => {
    const text = await runApp(
      Effect.gen(function* loadCodexHarness() {
        yield* Rivet.requireBackend;
        return yield* Rivet.getCodexToml;
      }),
    );
    setSnippet(text);
    setHarnessNote(null);
  }, []);

  const loadMcp = useCallback(async () => {
    const text = await runApp(
      Effect.gen(function* loadMcpHarness() {
        yield* Rivet.requireBackend;
        return yield* Rivet.getMcpJson;
      }),
    );
    setSnippet(text);
    setHarnessNote(null);
  }, []);

  return { harnessNote, snippet, writeHarness, writeAllHarnesses, loadClaude, loadCodex, loadMcp };
}
