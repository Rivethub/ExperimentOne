import { Effect } from "effect";
import type { WikiInfo, WikiPageCard } from "../components/WikiBoard";
import type { JsonObject } from "../lib/json-types";
import type { CatalogProvider } from "../lib/provider-utils";
import type {
  Account,
  BagResult,
  ConversationSearchResponse,
  ConversationSummary,
  HarnessWrite,
  LoginStatus,
  QuotaHistory,
  QuotaSnapshot,
  SearchMode,
  Status,
  TrafficEvent,
} from "../lib/types";
import type { ApiError, BackendUnavailable, IpcError } from "./errors";
import {
  apiJson,
  apiResult,
  apiText,
  ensureRivetd,
  invokeCommand,
  type SoftHttpResult,
} from "./ipc";
import { softEffect } from "./soft";

export { ensureRivetd as requireBackend } from "./ipc";

type ApiFx<T> = Effect.Effect<T, ApiError | IpcError>;
type ApiBackendFx<T> = Effect.Effect<T, ApiError | IpcError | BackendUnavailable>;

export const getStatus = apiJson<Status>("GET", "/v1/status");
export const getAccounts = apiJson<Account[]>("GET", "/v1/accounts");
export const getProviders = apiJson<{ providers: CatalogProvider[] }>("GET", "/v1/providers");
export const getQuota = apiJson<QuotaSnapshot>("GET", "/v1/quota");
export const getQuotaHistory = (hours: number): ApiFx<QuotaHistory> =>
  apiJson<QuotaHistory>("GET", `/v1/quota/history?hours=${hours}`);
export const refreshQuota = apiJson<{
  ok?: boolean;
  quota?: QuotaSnapshot;
  error?: string;
}>("POST", "/v1/quota/refresh");

export const getTrafficRecent = (limit = 200): ApiFx<TrafficEvent[]> =>
  apiJson<TrafficEvent[]>("GET", `/v1/traffic/recent?limit=${limit}`);
export const searchTraffic = (q: string, limit = 100): ApiFx<TrafficEvent[]> =>
  apiJson<TrafficEvent[]>(
    "GET",
    `/v1/traffic/search?limit=${limit}&q=${encodeURIComponent(q.trim())}`,
  );

export const listConversations = (limit = 100) =>
  apiJson<ConversationSummary[]>("GET", `/v1/conversations?limit=${limit}`);
export const getConversationEvents = (id: string, limit = 500) =>
  apiJson<TrafficEvent[]>(
    "GET",
    `/v1/conversations/events?limit=${limit}&id=${encodeURIComponent(id)}`,
  );
export const searchConversations = (q: string, mode: SearchMode = "keyword", limit = 100) =>
  apiJson<ConversationSearchResponse>(
    "GET",
    `/v1/conversations/search?limit=${limit}&mode=${encodeURIComponent(mode)}&q=${encodeURIComponent(q.trim())}`,
  );

export const getWiki = apiJson<WikiInfo>("GET", "/v1/wiki");
export const getWikiPage = (id: string): ApiFx<{ content: string }> =>
  apiJson<{ content: string }>("GET", `/v1/wiki/page?${new URLSearchParams({ id })}`);

export const proxyAction = (path: "start" | "stop" | "restart"): ApiFx<unknown> =>
  apiJson("POST", `/v1/proxy/${path}`);

export const startLogin = (
  provider: string,
  method?: "browser" | "device",
): ApiFx<{ message?: string; error?: string }> =>
  apiJson<{ message?: string; error?: string }>("POST", "/v1/accounts/login", {
    provider,
    method,
  });

export const getLoginStatus = apiJson<LoginStatus>("GET", "/v1/accounts/login/status");
export const cancelLogin = apiJson("POST", "/v1/accounts/login/cancel");
export const importVertex = (path: string): ApiFx<{ message?: string; error?: string }> =>
  apiJson<{ message?: string; error?: string }>("POST", "/v1/accounts/import/vertex", { path });
export const removeAccount = (id: string): ApiFx<unknown> =>
  apiJson("DELETE", `/v1/accounts/${encodeURIComponent(id)}`);

export const writeHarness = (
  target: "claude" | "codex",
  mode: "user" | "isolated",
): ApiFx<HarnessWrite> => apiJson<HarnessWrite>("POST", "/v1/harness/write", { target, mode });
export const getClaudeEnv = apiText("GET", "/v1/harness/claude.env");
export const getCodexToml = apiText("GET", "/v1/harness/codex.toml");
export const getMcpJson = apiText("GET", "/v1/harness/mcp.json");

export const putConfig = (body: JsonObject): ApiFx<JsonObject> =>
  apiJson<JsonObject>("PUT", "/v1/config", body);
export const tickWorkers = apiJson<{ embeddings?: number; wiki_pages?: number }>(
  "POST",
  "/v1/workers/tick",
);

export const exportBag = apiJson<BagResult & { error?: string }>("POST", "/v1/export");
export const importBag = (path: string): ApiFx<BagResult & { error?: string }> =>
  apiJson<BagResult & { error?: string }>("POST", "/v1/import", { path });

export const getProxyLog = (lines = 80): ApiFx<SoftHttpResult> =>
  apiResult("GET", `/v1/logs/proxy?lines=${lines}`);
export const getClickhouseLog = (lines = 80): ApiFx<SoftHttpResult> =>
  apiResult("GET", `/v1/logs/clickhouse?lines=${lines}`);

export const openWikiDir = (path: string): Effect.Effect<boolean | null> =>
  softEffect(invokeCommand<boolean>("open_wiki_dir", { path }));

export const revealPath = (path: string): Effect.Effect<boolean | null> =>
  softEffect(invokeCommand<boolean>("reveal_path", { path }));

export type RefreshSnapshot = {
  status: Status;
  accounts: Account[];
  recent: TrafficEvent[];
  providers: { providers: CatalogProvider[] };
  quotaBundle: [QuotaSnapshot, QuotaHistory] | null;
};

/** Parallel bootstrap payload used by the quota home refresh. */
export const refreshSnapshot = (opts: {
  includeQuota: boolean;
  historyHours: number;
}): ApiBackendFx<RefreshSnapshot> =>
  Effect.gen(function* runRefreshSnapshot() {
    yield* ensureRivetd;
    const [status, accounts, recent, providers, quotaBundle] = yield* Effect.all(
      [
        getStatus,
        getAccounts,
        getTrafficRecent(200),
        getProviders,
        opts.includeQuota
          ? Effect.all([getQuota, getQuotaHistory(opts.historyHours)], { concurrency: "unbounded" })
          : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );
    return { status, accounts, recent, providers, quotaBundle };
  });

export const loadWikiPageContent = (page: WikiPageCard): ApiBackendFx<string> =>
  Effect.gen(function* runLoadWikiPageContent() {
    yield* ensureRivetd;
    const body = yield* getWikiPage(page.id);
    return body.content;
  });
