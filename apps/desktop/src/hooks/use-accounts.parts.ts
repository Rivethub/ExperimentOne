import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { Effect } from "effect";
import type { Setter } from "solid-js";
import { createEffect, createSignal } from "solid-js";
import { rivetErrorMessage, runApp } from "../effect";
import * as Rivet from "../effect/rivet";
import { firstHttpUrl, type HarnessInstallTarget } from "../lib/format-utils";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/query-keys";
import type { HarnessWrite, LoginStatus, SettingsTab } from "../lib/types";

export type AccountsLoginApi = {
  login: LoginStatus | null;
  setLogin: Setter<LoginStatus | null>;
  showAddAccount: boolean;
  setShowAddAccount: Setter<boolean>;
  refreshLogin: () => Promise<void>;
  startLogin: (provider: string, method?: "browser" | "device") => Promise<void>;
  cancelLogin: () => Promise<void>;
};

export type AccountsVertexApi = {
  vertexPath: string;
  setVertexPath: Setter<string>;
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
  const [login, setLogin] = createSignal<LoginStatus | null>(null);
  const [showAddAccount, setShowAddAccount] = createSignal(false);
  const openedLoginUrl: { current: string | null } = { current: null };

  const loginQuery = useQuery(() => ({
    queryKey: queryKeys.loginStatus,
    queryFn: fetchLoginStatus,
    enabled: login()?.active === true,
    refetchInterval: login()?.active === true ? 1000 : false,
    retry: false,
  }));

  createEffect(() => {
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
  });

  const refreshLogin = async () => {
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
  };

  const startLogin = async (provider: string, method?: "browser" | "device") => {
    clearMultiAccountWarn();
    const toastId = "start-login";
    setBusy(true);
    notify.loading(`Starting ${provider} login…`, toastId);
    openedLoginUrl.current = null;
    try {
      const body = await mutations.startLogin.mutateAsync({ provider, method });
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
  };

  const cancelLogin = async () => {
    await mutations.cancelLogin.mutateAsync().catch(() => {
      /* rivetd may be down */
    });
    await refreshLogin();
  };

  return {
    get login() {
      return login();
    },
    setLogin,
    get showAddAccount() {
      return showAddAccount();
    },
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
  const [vertexPath, setVertexPath] = createSignal("");

  const importVertex = async () => {
    clearMultiAccountWarn();
    let path = vertexPath().trim();
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
  };

  return {
    get vertexPath() {
      return vertexPath();
    },
    setVertexPath,
    importVertex,
  };
}

export function useAccountsHarness(
  opts: Pick<AccountsCoreOpts, "setBusy" | "mutations">,
): AccountsHarnessApi {
  const { setBusy, mutations } = opts;
  const [harnessNote, setHarnessNote] = createSignal<HarnessWrite | null>(null);
  const [snippet, setSnippet] = createSignal("");

  const writeHarness = async (target: HarnessInstallTarget, mode: "user" | "isolated" = "user") => {
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
  };

  const writeAllHarnesses = async () => {
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
  };

  const loadClaude = async () => {
    try {
      const text = await runApp(
        Effect.gen(function* loadClaudeHarness() {
          yield* Rivet.requireBackend;
          return yield* Rivet.getClaudeEnv;
        }),
      );
      setSnippet(text);
      setHarnessNote(null);
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    }
  };

  const loadCodex = async () => {
    try {
      const text = await runApp(
        Effect.gen(function* loadCodexHarness() {
          yield* Rivet.requireBackend;
          return yield* Rivet.getCodexToml;
        }),
      );
      setSnippet(text);
      setHarnessNote(null);
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    }
  };

  const loadMcp = async () => {
    try {
      const text = await runApp(
        Effect.gen(function* loadMcpHarness() {
          yield* Rivet.requireBackend;
          return yield* Rivet.getMcpJson;
        }),
      );
      setSnippet(text);
      setHarnessNote(null);
    } catch (err) {
      notify.error(rivetErrorMessage(err));
    }
  };

  return {
    get harnessNote() {
      return harnessNote();
    },
    get snippet() {
      return snippet();
    },
    writeHarness,
    writeAllHarnesses,
    loadClaude,
    loadCodex,
    loadMcp,
  };
}
