import { Effect, type Schema } from "effect";
import type { WikiPageCard } from "../components/WikiBoard";
import type { HarnessInstallTarget } from "../lib/format-utils";
import type { JsonObject } from "../lib/json-types";
import type { LocalIngestReport, SearchMode } from "../lib/types";
import type { ApiError, BackendUnavailable, IpcError } from "./errors";
import {
  apiJson,
  apiJsonSchema,
  apiResult,
  apiText,
  ensureRivetd,
  invokeCommand,
  type SoftHttpResult,
} from "./ipc";
import {
  AccountsSchema,
  BagResultSchema,
  ConfigResponseSchema,
  ConversationSearchResponseSchema,
  ConversationsSchema,
  HarnessWriteSchema,
  LiveCursorSchema,
  LoginStatusSchema,
  MessageResultSchema,
  ProvidersResponseSchema,
  QuotaHistorySchema,
  QuotaSnapshotSchema,
  RefreshQuotaResultSchema,
  StatusSchema,
  TrafficEventsSchema,
  UnknownOkSchema,
  WikiInfoSchema,
  WikiPageContentSchema,
  WorkersTickSchema,
} from "./schemas";
import { softEffect } from "./soft";

type Status = Schema.Schema.Type<typeof StatusSchema>;
type Account = Schema.Schema.Type<typeof AccountsSchema>[number];
type TrafficEvent = Schema.Schema.Type<typeof TrafficEventsSchema>[number];
type CatalogProvider = Schema.Schema.Type<typeof ProvidersResponseSchema>["providers"][number];
type QuotaSnapshot = Schema.Schema.Type<typeof QuotaSnapshotSchema>;
type QuotaHistory = Schema.Schema.Type<typeof QuotaHistorySchema>;

export { ensureRivetd as requireBackend } from "./ipc";

type ApiFx<T> = Effect.Effect<T, ApiError | IpcError>;
type ApiBackendFx<T> = Effect.Effect<T, ApiError | IpcError | BackendUnavailable>;

export const getStatus = apiJsonSchema("GET", "/v1/status", StatusSchema);
export const getAccounts = apiJsonSchema("GET", "/v1/accounts", AccountsSchema);
export const getProviders = apiJsonSchema("GET", "/v1/providers", ProvidersResponseSchema);
export const getQuota = apiJsonSchema("GET", "/v1/quota", QuotaSnapshotSchema);
export const getQuotaHistory = (hours: number) =>
  apiJsonSchema("GET", `/v1/quota/history?hours=${hours}`, QuotaHistorySchema);
export const refreshQuota = apiJsonSchema("POST", "/v1/quota/refresh", RefreshQuotaResultSchema);

export const getTrafficRecent = (limit = 200) =>
  apiJsonSchema("GET", `/v1/traffic/recent?limit=${limit}`, TrafficEventsSchema);
export const searchTraffic = (q: string, limit = 100) =>
  apiJsonSchema(
    "GET",
    `/v1/traffic/search?limit=${limit}&q=${encodeURIComponent(q.trim())}`,
    TrafficEventsSchema,
  );

export const listConversations = (limit = 100) =>
  apiJsonSchema("GET", `/v1/conversations?limit=${limit}`, ConversationsSchema);
export const getConversationEvents = (id: string, limit = 500) =>
  apiJsonSchema(
    "GET",
    `/v1/conversations/events?limit=${limit}&id=${encodeURIComponent(id)}`,
    TrafficEventsSchema,
  );
export const searchConversations = (q: string, mode: SearchMode = "keyword", limit = 100) =>
  apiJsonSchema(
    "GET",
    `/v1/conversations/search?limit=${limit}&mode=${encodeURIComponent(mode)}&q=${encodeURIComponent(q.trim())}`,
    ConversationSearchResponseSchema,
  );

export const getWiki = apiJsonSchema("GET", "/v1/wiki", WikiInfoSchema);
export const getWikiPage = (id: string) =>
  apiJsonSchema("GET", `/v1/wiki/page?${new URLSearchParams({ id })}`, WikiPageContentSchema);
export const proxyAction = (path: "start" | "stop" | "restart"): ApiFx<unknown> =>
  apiJsonSchema("POST", `/v1/proxy/${path}`, UnknownOkSchema);

export const startLogin = (
  provider: string,
  method?: "browser" | "device",
): ApiFx<{ message?: string; error?: string }> =>
  apiJsonSchema("POST", "/v1/accounts/login", MessageResultSchema, {
    provider,
    method,
  });

export const getLoginStatus = apiJsonSchema("GET", "/v1/accounts/login/status", LoginStatusSchema);
export const cancelLogin = apiJsonSchema("POST", "/v1/accounts/login/cancel", UnknownOkSchema);
export const importVertex = (path: string): ApiFx<{ message?: string; error?: string }> =>
  apiJsonSchema("POST", "/v1/accounts/import/vertex", MessageResultSchema, { path });
export const removeAccount = (id: string): ApiFx<unknown> =>
  apiJsonSchema("DELETE", `/v1/accounts/${encodeURIComponent(id)}`, UnknownOkSchema);

export const writeHarness = (
  target: HarnessInstallTarget,
  mode: "user" | "isolated",
): ApiFx<Schema.Schema.Type<typeof HarnessWriteSchema>> =>
  apiJsonSchema("POST", "/v1/harness/write", HarnessWriteSchema, { target, mode });
export const getClaudeEnv = apiText("GET", "/v1/harness/claude.env");
export const getCodexToml = apiText("GET", "/v1/harness/codex.toml");
export const getMcpJson = apiText("GET", "/v1/harness/mcp.json");

export const getLiveCursor = apiJsonSchema("GET", "/v1/live", LiveCursorSchema);

export const putConfig = (
  body: JsonObject,
): ApiFx<Schema.Schema.Type<typeof ConfigResponseSchema>> =>
  apiJsonSchema("PUT", "/v1/config", ConfigResponseSchema, body);
export const tickWorkers = apiJsonSchema("POST", "/v1/workers/tick", WorkersTickSchema);

export const exportBag = apiJsonSchema("POST", "/v1/export", BagResultSchema);
export const importBag = (path: string): ApiFx<Schema.Schema.Type<typeof BagResultSchema>> =>
  apiJsonSchema("POST", "/v1/import", BagResultSchema, { path });
export const ingestLocal = (
  body: {
    sources?: string[];
    claude_root?: string;
    codex_root?: string;
    dry_run?: boolean;
    limit?: number;
  } = {},
): ApiFx<LocalIngestReport & { error?: string }> =>
  apiJson<LocalIngestReport & { error?: string }>("POST", "/v1/ingest/local", body);

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
