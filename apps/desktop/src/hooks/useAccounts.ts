import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MultiAccountWarnState } from "../components/MultiAccountWarnModal";
import { Rivet, runApp, rivetErrorMessage } from "../effect";
import { firstHttpUrl } from "../formatUtils";
import { providerKey } from "../providerUtils";
import type { Account, HarnessWrite, LoginStatus, SettingsTab } from "../types";

export function useAccounts(opts: {
  accounts: Account[];
  ensureSession: () => Promise<void>;
  refresh: () => Promise<void>;
  openSettings: (tab?: SettingsTab) => void;
  setBusy: (v: boolean) => void;
  setStatusAction: (v: string | null) => void;
  setError: (v: string | null | ((prev: string | null) => string | null)) => void;
}) {
  const { accounts, refresh, openSettings, setBusy, setStatusAction, setError } = opts;

  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [multiAccountWarn, setMultiAccountWarn] = useState<MultiAccountWarnState>(null);
  const [vertexPath, setVertexPath] = useState("");
  const [harnessNote, setHarnessNote] = useState<HarnessWrite | null>(null);
  const [snippet, setSnippet] = useState("");
  const openedLoginUrl = useRef<string | null>(null);

  const refreshLogin = useCallback(async () => {
    try {
      const body = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.getLoginStatus;
        }),
      );
      setLogin(body.active || body.output ? body : null);
      const url = firstHttpUrl(body.output || "");
      if (url && url !== openedLoginUrl.current) {
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
    if (!login?.active) return;
    const id = setInterval(refreshLogin, 1000);
    return () => clearInterval(id);
  }, [login?.active, refreshLogin]);

  const providerAccountCount = useCallback(
    (provider: string) => {
      const key = providerKey(provider);
      return accounts.filter((a) => providerKey(a.provider) === key).length;
    },
    [accounts],
  );

  const startLogin = useCallback(
    async (provider: string, method?: "browser" | "device") => {
      setMultiAccountWarn(null);
      setBusy(true);
      setStatusAction(`Starting ${provider} login…`);
      openedLoginUrl.current = null;
      try {
        const body = await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            return yield* Rivet.startLogin(provider, method);
          }),
        );
        if (body.error) throw new Error(body.error);
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
    [openSettings, refreshLogin, setBusy, setStatusAction, setError],
  );

  const requestLogin = useCallback(
    (provider: string, method?: "browser" | "device") => {
      if (providerAccountCount(provider) >= 1) {
        setMultiAccountWarn({ provider, method, kind: "login" });
        return;
      }
      void startLogin(provider, method);
    },
    [providerAccountCount, startLogin],
  );

  const importVertex = useCallback(async () => {
    setMultiAccountWarn(null);
    let path = vertexPath.trim();
    if (!path) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "Service account", extensions: ["json"] }],
        });
        if (typeof selected === "string") path = selected;
        else if (Array.isArray(selected) && selected[0]) path = selected[0];
      } catch {
        /* typed path fallback */
      }
    }
    if (!path) {
      setError("Choose a Vertex service-account JSON path.");
      return;
    }
    setVertexPath(path);
    setBusy(true);
    setStatusAction("Importing Vertex credentials…");
    try {
      const body = await runApp(
        Effect.gen(function* () {
          yield* Rivet.requireBackend;
          return yield* Rivet.importVertex(path);
        }),
      );
      if (body.error) throw new Error(body.error);
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
  }, [vertexPath, openSettings, refreshLogin, setBusy, setStatusAction, setError]);

  const requestVertexImport = useCallback(() => {
    if (providerAccountCount("vertex") >= 1) {
      setMultiAccountWarn({ provider: "vertex", kind: "vertex" });
      return;
    }
    void importVertex();
  }, [providerAccountCount, importVertex]);

  const beginAddAccount = useCallback(() => {
    setShowAddAccount(true);
    openSettings("accounts");
  }, [openSettings]);

  const cancelLogin = useCallback(async () => {
    await runApp(
      Effect.gen(function* () {
        yield* Rivet.requireBackend;
        yield* Rivet.cancelLogin;
      }),
    ).catch(() => undefined);
    await refreshLogin();
  }, [refreshLogin]);

  const removeAccount = useCallback(
    async (id: string) => {
      let ok = false;
      try {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        ok = await ask(`Remove account “${id}”? This deletes the local credential file.`, {
          title: "Remove account",
          kind: "warning",
        });
      } catch {
        ok = window.confirm(`Remove account “${id}”? This deletes the local credential file.`);
      }
      if (!ok) return;
      setBusy(true);
      try {
        await runApp(
          Effect.gen(function* () {
            yield* Rivet.requireBackend;
            yield* Rivet.removeAccount(id);
          }),
        );
        await refresh();
      } catch (err) {
        setError(rivetErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh, setBusy, setError],
  );

  const writeHarness = useCallback(
    async (target: "claude" | "codex", mode: "user" | "isolated" = "user") => {
      setBusy(true);
      try {
        const body = await runApp(
          Effect.gen(function* () {
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
      Effect.gen(function* () {
        yield* Rivet.requireBackend;
        return yield* Rivet.getClaudeEnv;
      }),
    );
    setSnippet(text);
    setHarnessNote(null);
  }, []);

  const loadCodex = useCallback(async () => {
    const text = await runApp(
      Effect.gen(function* () {
        yield* Rivet.requireBackend;
        return yield* Rivet.getCodexToml;
      }),
    );
    setSnippet(text);
    setHarnessNote(null);
  }, []);

  const loadMcp = useCallback(async () => {
    const text = await runApp(
      Effect.gen(function* () {
        yield* Rivet.requireBackend;
        return yield* Rivet.getMcpJson;
      }),
    );
    setSnippet(text);
    setHarnessNote(null);
  }, []);

  const confirmMultiAccountWarn = useCallback(
    (pending: NonNullable<MultiAccountWarnState>) => {
      if (pending.kind === "vertex") void importVertex();
      else void startLogin(pending.provider, pending.method);
    },
    [importVertex, startLogin],
  );

  return {
    login,
    setLogin,
    showAddAccount,
    setShowAddAccount,
    multiAccountWarn,
    setMultiAccountWarn,
    vertexPath,
    setVertexPath,
    harnessNote,
    snippet,
    providerAccountCount,
    requestLogin,
    startLogin,
    requestVertexImport,
    importVertex,
    beginAddAccount,
    cancelLogin,
    removeAccount,
    writeHarness,
    loadClaude,
    loadCodex,
    loadMcp,
    confirmMultiAccountWarn,
  };
}
