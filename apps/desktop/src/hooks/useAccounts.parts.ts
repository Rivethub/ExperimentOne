import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Rivet, runApp, rivetErrorMessage } from "../effect";
import { firstHttpUrl } from "../formatUtils";
import type { HarnessWrite, LoginStatus, SettingsTab } from "../types";

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
  writeHarness: (target: "claude" | "codex", mode?: "user" | "isolated") => Promise<void>;
  loadClaude: () => Promise<void>;
  loadCodex: () => Promise<void>;
  loadMcp: () => Promise<void>;
};

export type AccountsCoreOpts = {
  refresh: () => Promise<void>;
  openSettings: (tab?: SettingsTab) => void;
  setBusy: (v: boolean) => void;
  setStatusAction: (v: string | null) => void;
  setError: (v: string | null | ((prev: string | null) => string | null)) => void;
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

export function useAccountsLogin(
  opts: AccountsCoreOpts,
  clearMultiAccountWarn: () => void,
): AccountsLoginApi {
  const { refresh, openSettings, setBusy, setStatusAction, setError } = opts;
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const openedLoginUrl = useRef<string | null>(null);

  const refreshLogin = useCallback(async () => {
    try {
      const body = await runApp(
        Effect.gen(function* pollLoginStatus() {
          yield* Rivet.requireBackend;
          return yield* Rivet.getLoginStatus;
        }),
      );
      const hasLoginSignal = body.active || body.output !== "";
      setLogin(hasLoginSignal ? body : null);
      const url = firstHttpUrl(body.output !== "" ? body.output : "");
      if (url !== null && url !== "" && url !== openedLoginUrl.current) {
        openedLoginUrl.current = url;
        try {
          const { open } = await import("@tauri-apps/plugin-shell");
          await open(url);
        } catch {
          /* browser preview / non-tauri */
        }
      }
      if (body.done && body.success) {
        openedLoginUrl.current = null;
        setShowAddAccount(false);
        void refresh();
      }
    } catch {
      /* rivetd down */
    }
  }, [refresh]);

  useEffect(() => {
    if (login === null || !login.active) {
      return () => {
        /* login idle */
      };
    }
    const id = setInterval(() => {
      void refreshLogin();
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [login, refreshLogin]);

  const startLogin = useCallback(
    async (provider: string, method?: "browser" | "device") => {
      clearMultiAccountWarn();
      setBusy(true);
      setStatusAction(`Starting ${provider} login…`);
      openedLoginUrl.current = null;
      try {
        const body = await runApp(
          Effect.gen(function* beginProviderLogin() {
            yield* Rivet.requireBackend;
            return yield* Rivet.startLogin(provider, method);
          }),
        );
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
      } catch (err) {
        setError(rivetErrorMessage(err));
      } finally {
        setBusy(false);
        setStatusAction(null);
      }
    },
    [openSettings, refreshLogin, setBusy, setStatusAction, setError, clearMultiAccountWarn],
  );

  const cancelLogin = useCallback(async () => {
    await runApp(
      Effect.gen(function* cancelActiveLogin() {
        yield* Rivet.requireBackend;
        yield* Rivet.cancelLogin;
      }),
    ).catch(() => {
      /* rivetd may be down */
    });
    await refreshLogin();
  }, [refreshLogin]);

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
  const { openSettings, setBusy, setStatusAction, setError } = opts;
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
      setError("Choose a Vertex service-account JSON path.");
      return;
    }
    setVertexPath(path);
    setBusy(true);
    setStatusAction("Importing Vertex credentials…");
    try {
      const body = await runApp(
        Effect.gen(function* importVertexCredentials() {
          yield* Rivet.requireBackend;
          return yield* Rivet.importVertex(path);
        }),
      );
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
    } catch (err) {
      setError(rivetErrorMessage(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }, [
    vertexPath,
    openSettings,
    refreshLogin,
    setBusy,
    setStatusAction,
    setError,
    setLogin,
    setShowAddAccount,
    clearMultiAccountWarn,
  ]);

  return { vertexPath, setVertexPath, importVertex };
}

export function useAccountsHarness(
  opts: Pick<AccountsCoreOpts, "setBusy" | "setError">,
): AccountsHarnessApi {
  const { setBusy, setError } = opts;
  const [harnessNote, setHarnessNote] = useState<HarnessWrite | null>(null);
  const [snippet, setSnippet] = useState("");

  const writeHarness = useCallback(
    async (target: "claude" | "codex", mode: "user" | "isolated" = "user") => {
      setBusy(true);
      try {
        const body = await runApp(
          Effect.gen(function* writeHarnessConfig() {
            yield* Rivet.requireBackend;
            const note = yield* Rivet.writeHarness(target, mode);
            let isolated = "";
            if (mode === "isolated") {
              isolated =
                target === "claude" ? yield* Rivet.getClaudeEnv : yield* Rivet.getCodexToml;
            }
            return { note, isolated };
          }),
        );
        setHarnessNote(body.note);
        setSnippet(body.isolated);
      } catch (err) {
        setError(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [setBusy, setError],
  );

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

  return { harnessNote, snippet, writeHarness, loadClaude, loadCodex, loadMcp };
}
