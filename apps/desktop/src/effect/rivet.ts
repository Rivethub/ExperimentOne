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

export type WikiArchiveList = {
  project_id: string;
  slug: string;
  files: string[];
};

export type WikiArchiveBody = {
  project_id: string;
  slug: string;
  file: string;
  content: string;
};

export const listWikiArchives = (slug: string, projectId?: string): ApiFx<WikiArchiveList> => {
  const params = new URLSearchParams({ slug });
  if (projectId) params.set("project_id", projectId);
  return apiJson<WikiArchiveList>("GET", `/v1/wiki/archives?${params}`);
};

export const getWikiArchive = (
  slug: string,
  file: string,
  projectId?: string,
): ApiFx<WikiArchiveBody> => {
  const params = new URLSearchParams({ slug, file });
  if (projectId) params.set("project_id", projectId);
  return apiJson<WikiArchiveBody>("GET", `/v1/wiki/archive?${params}`);
};

export type TopicCard = {
  slug: string;
  title: string;
  project_id?: string;
  aliases?: string[];
  tags?: string[];
  event_ids?: string[];
  session_ids?: string[];
  summary?: string | null;
  curated?: boolean;
  placement_by?: "heuristic" | "categorizer" | "you";
  decisions?: string[];
  startup_context?: string | null;
  kind?: string;
  parent_slug?: string | null;
  updated_at: string;
};

export const listTopics = (q = "", limit = 100): ApiFx<TopicCard[]> =>
  apiJson<TopicCard[]>("GET", `/v1/topics?limit=${limit}&q=${encodeURIComponent(q.trim())}`);
export const getTopic = (slug: string): ApiFx<TopicCard> =>
  apiJson<TopicCard>("GET", `/v1/topics/item?${new URLSearchParams({ slug })}`);
export type TidyProposal = {
  id: string;
  action: string;
  from_slug?: string | null;
  to_slug?: string | null;
  title?: string | null;
  reason: string;
  status: string;
  created_at: string;
};
export const listTidy = apiJson<{ proposals: TidyProposal[] }>(
  "GET",
  "/v1/topics/tidy?pending=true",
);
export const decideTidy = (
  id: string,
  status: "approved" | "rejected",
): ApiFx<{ proposal: TidyProposal }> =>
  apiJson<{ proposal: TidyProposal }>("POST", "/v1/topics/tidy", { id, status });

export type TagSuggestion = {
  id: string;
  session_id: string;
  tag: string;
  status: string;
  created_at: string;
};
export const listTags = apiJson<{ suggestions: TagSuggestion[] }>("GET", "/v1/topics/tags");
export const decideTag = (
  id: string,
  status: "accepted" | "rejected",
): ApiFx<{ suggestion: TagSuggestion }> =>
  apiJson<{ suggestion: TagSuggestion }>("POST", "/v1/topics/tags", { id, status });

export type FlaggedJob = {
  job_key: string;
  task: string;
  status: string;
  attempts?: number;
  last_error?: string | null;
  updated_at?: string;
};
export const listFlagged = apiJson<{ flagged: FlaggedJob[] }>("GET", "/v1/workers/flagged");
export const retryFlagged = (task: string, job_key: string): ApiFx<{ ok: boolean }> =>
  apiJson<{ ok: boolean }>("POST", "/v1/workers/flagged", { task, job_key });

export const getMemoryStats = apiJson<Record<string, unknown>>("GET", "/v1/memory/stats");
export const getMemoryStartup = (topic?: string, q?: string): ApiFx<{ markdown: string }> => {
  const params = new URLSearchParams();
  if (topic) params.set("topic", topic);
  if (q) params.set("q", q);
  const qs = params.toString();
  return apiJson<{ markdown: string }>("GET", `/v1/memory/startup${qs ? `?${qs}` : ""}`);
};
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

export const exportBag = (
  conversationIds?: string[],
): ApiFx<Schema.Schema.Type<typeof BagResultSchema>> =>
  apiJsonSchema(
    "POST",
    "/v1/export",
    BagResultSchema,
    conversationIds && conversationIds.length > 0
      ? { conversation_ids: conversationIds }
      : undefined,
  );
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

export const loadWikiArchiveList = (slug: string, projectId?: string): ApiBackendFx<string[]> =>
  Effect.gen(function* runLoadWikiArchiveList() {
    yield* ensureRivetd;
    const body = yield* listWikiArchives(slug, projectId);
    return body.files;
  });

export const loadWikiArchiveContent = (
  slug: string,
  file: string,
  projectId?: string,
): ApiBackendFx<string> =>
  Effect.gen(function* runLoadWikiArchiveContent() {
    yield* ensureRivetd;
    const body = yield* getWikiArchive(slug, file, projectId);
    return body.content;
  });
