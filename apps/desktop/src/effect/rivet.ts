import { Effect, type Schema } from "effect";
import type { WikiPageCard } from "../components/WikiBoard";
import type { HarnessInstallTarget } from "../lib/format-utils";
import type { JsonObject } from "../lib/json-types";
import type { SearchMode } from "../lib/types";
import { ApiError, type BackendUnavailable, type IpcError } from "./errors";
import { apiJsonSchema, apiText, ensureRivetd, invokeCommand, type RivetIpc } from "./ipc";
import {
  AccountsSchema,
  BagResultSchema,
  ConfigResponseSchema,
  ConversationSearchResponseSchema,
  ConversationsSchema,
  FlaggedListSchema,
  FlaggedRetrySchema,
  HarnessWriteSchema,
  LiveCursorSchema,
  LocalIngestReportSchema,
  LoginStatusSchema,
  LogTailSchema,
  MemoryStartupSchema,
  MemoryStatsSchema,
  MessageResultSchema,
  ProvidersResponseSchema,
  QuotaHistorySchema,
  QuotaSnapshotSchema,
  RefreshQuotaResultSchema,
  StatusSchema,
  CaptureEventsSchema,
  TagDecideSchema,
  TagListSchema,
  TidyDecideSchema,
  TidyListSchema,
  TopicCardSchema,
  TopicsSchema,
  UnknownOkSchema,
  WikiArchiveBodySchema,
  WikiArchiveListSchema,
  WikiInfoSchema,
  WikiPageContentSchema,
  LoginStartSchema,
  WorkersReembedSchema,
  WorkersTickSchema,
} from "./schemas";
import { softEffect } from "./soft";

type Status = Schema.Schema.Type<typeof StatusSchema>;
type Account = Schema.Schema.Type<typeof AccountsSchema>[number];
type CaptureEvent = Schema.Schema.Type<typeof CaptureEventsSchema>[number];
type CatalogProvider = Schema.Schema.Type<typeof ProvidersResponseSchema>["providers"][number];
type QuotaSnapshot = Schema.Schema.Type<typeof QuotaSnapshotSchema>;
type QuotaHistory = Schema.Schema.Type<typeof QuotaHistorySchema>;

export { ensureRivetd as requireBackend } from "./ipc";

type ApiFx<T> = Effect.Effect<T, ApiError | IpcError, RivetIpc>;
type ApiBackendFx<T> = Effect.Effect<T, ApiError | IpcError | BackendUnavailable, RivetIpc>;

/** Promote soft `{ error }` bodies (HTTP 2xx) onto the Effect failure channel. */
function rejectSoftError<A extends { readonly error?: string }>(
  method: string,
  path: string,
  body: A,
): Effect.Effect<A, ApiError> {
  const msg = body.error;
  if (msg !== undefined && msg !== "") {
    return Effect.fail(new ApiError({ method, path, status: 400, body: msg }));
  }
  return Effect.succeed(body);
}

export const getStatus = apiJsonSchema("GET", "/v1/status", StatusSchema);
export const getAccounts = apiJsonSchema("GET", "/v1/accounts", AccountsSchema);
export const getProviders = apiJsonSchema("GET", "/v1/providers", ProvidersResponseSchema);
export const getQuota = apiJsonSchema("GET", "/v1/quota", QuotaSnapshotSchema);
export const getQuotaHistory = (hours: number) =>
  apiJsonSchema("GET", `/v1/quota/history?hours=${hours}`, QuotaHistorySchema);
export const refreshQuota: ApiFx<Schema.Schema.Type<typeof RefreshQuotaResultSchema>> = Effect.gen(
  function* runRefreshQuota() {
    const body = yield* apiJsonSchema("POST", "/v1/quota/refresh", RefreshQuotaResultSchema);
    if (body.error !== undefined && body.error !== "" && body.ok === false) {
      return yield* new ApiError({
        method: "POST",
        path: "/v1/quota/refresh",
        status: 400,
        body: body.error,
      });
    }
    return body;
  },
);

export const getCapturesRecent = (limit = 200) =>
  apiJsonSchema("GET", `/v1/captures/recent?limit=${limit}`, CaptureEventsSchema);
export const searchCaptures = (q: string, limit = 100) =>
  apiJsonSchema(
    "GET",
    `/v1/captures/search?limit=${limit}&q=${encodeURIComponent(q.trim())}`,
    CaptureEventsSchema,
  );

export const listConversations = (limit = 100) =>
  apiJsonSchema("GET", `/v1/conversations?limit=${limit}`, ConversationsSchema);
export const getConversationEvents = (id: string, limit = 500) =>
  apiJsonSchema(
    "GET",
    `/v1/conversations/events?limit=${limit}&id=${encodeURIComponent(id)}`,
    CaptureEventsSchema,
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

export type WikiArchiveList = Schema.Schema.Type<typeof WikiArchiveListSchema>;
export type WikiArchiveBody = Schema.Schema.Type<typeof WikiArchiveBodySchema>;

export const listWikiArchives = (slug: string, projectId?: string): ApiFx<WikiArchiveList> => {
  const params = new URLSearchParams({ slug });
  if (projectId) params.set("project_id", projectId);
  return apiJsonSchema("GET", `/v1/wiki/archives?${params}`, WikiArchiveListSchema);
};

export const getWikiArchive = (
  slug: string,
  file: string,
  projectId?: string,
): ApiFx<WikiArchiveBody> => {
  const params = new URLSearchParams({ slug, file });
  if (projectId) params.set("project_id", projectId);
  return apiJsonSchema("GET", `/v1/wiki/archive?${params}`, WikiArchiveBodySchema);
};

export type TopicCard = Schema.Schema.Type<typeof TopicCardSchema>;
export type TidyProposal = Schema.Schema.Type<typeof TidyListSchema>["proposals"][number];
export type TagSuggestion = Schema.Schema.Type<typeof TagListSchema>["suggestions"][number];
export type FlaggedJob = Schema.Schema.Type<typeof FlaggedListSchema>["flagged"][number];

export const listTopics = (q = "", limit = 100): ApiFx<TopicCard[]> =>
  apiJsonSchema("GET", `/v1/topics?limit=${limit}&q=${encodeURIComponent(q.trim())}`, TopicsSchema);
export const getTopic = (slug: string): ApiFx<TopicCard> =>
  apiJsonSchema("GET", `/v1/topics/item?${new URLSearchParams({ slug })}`, TopicCardSchema);

export const listTidy = apiJsonSchema("GET", "/v1/topics/tidy?pending=true", TidyListSchema);
export const decideTidy = (
  id: string,
  status: "approved" | "rejected",
): ApiFx<Schema.Schema.Type<typeof TidyDecideSchema>> =>
  apiJsonSchema("POST", "/v1/topics/tidy", TidyDecideSchema, { id, status });

export const listTags = apiJsonSchema("GET", "/v1/topics/tags", TagListSchema);
export const decideTag = (
  id: string,
  status: "accepted" | "rejected",
): ApiFx<Schema.Schema.Type<typeof TagDecideSchema>> =>
  apiJsonSchema("POST", "/v1/topics/tags", TagDecideSchema, { id, status });

export const listFlagged = apiJsonSchema("GET", "/v1/workers/flagged", FlaggedListSchema);
export const retryFlagged = (
  task: string,
  job_key: string,
): ApiFx<Schema.Schema.Type<typeof FlaggedRetrySchema>> =>
  apiJsonSchema("POST", "/v1/workers/flagged", FlaggedRetrySchema, { task, job_key });

export const getMemoryStats = apiJsonSchema("GET", "/v1/memory/stats", MemoryStatsSchema);
export const getMemoryStartup = (
  topic?: string,
  q?: string,
): ApiFx<Schema.Schema.Type<typeof MemoryStartupSchema>> => {
  const params = new URLSearchParams();
  if (topic) params.set("topic", topic);
  if (q) params.set("q", q);
  const qs = params.toString();
  return apiJsonSchema("GET", `/v1/memory/startup${qs ? `?${qs}` : ""}`, MemoryStartupSchema);
};
export const proxyAction = (path: "start" | "stop" | "restart"): ApiFx<unknown> =>
  apiJsonSchema("POST", `/v1/proxy/${path}`, UnknownOkSchema);

export const startLogin = (
  provider: string,
  method?: "browser" | "device",
): ApiFx<Schema.Schema.Type<typeof MessageResultSchema>> =>
  Effect.gen(function* runStartLogin() {
    const body = yield* apiJsonSchema("POST", "/v1/accounts/login", MessageResultSchema, {
      provider,
      method,
    });
    return yield* rejectSoftError("POST", "/v1/accounts/login", body);
  });

export const getLoginStatus = apiJsonSchema("GET", "/v1/accounts/login/status", LoginStatusSchema);
export const cancelLogin = apiJsonSchema("POST", "/v1/accounts/login/cancel", UnknownOkSchema);
export const importVertex = (path: string): ApiFx<Schema.Schema.Type<typeof MessageResultSchema>> =>
  Effect.gen(function* runImportVertex() {
    const body = yield* apiJsonSchema("POST", "/v1/accounts/import/vertex", MessageResultSchema, {
      path,
    });
    return yield* rejectSoftError("POST", "/v1/accounts/import/vertex", body);
  });
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
export const reembedWorkers = apiJsonSchema("POST", "/v1/workers/reembed", WorkersReembedSchema);
export const startSiwcBind = (
  accountId?: string | null,
): ApiFx<Schema.Schema.Type<typeof LoginStartSchema>> =>
  apiJsonSchema("POST", "/v1/accounts/siwc/bind", LoginStartSchema, {
    account_id: accountId ?? undefined,
  });

export const exportBag = (
  conversationIds?: string[],
): ApiFx<Schema.Schema.Type<typeof BagResultSchema>> =>
  Effect.gen(function* runExportBag() {
    const body = yield* apiJsonSchema(
      "POST",
      "/v1/export",
      BagResultSchema,
      conversationIds && conversationIds.length > 0
        ? { conversation_ids: conversationIds }
        : undefined,
    );
    return yield* rejectSoftError("POST", "/v1/export", body);
  });
export const importBag = (path: string): ApiFx<Schema.Schema.Type<typeof BagResultSchema>> =>
  Effect.gen(function* runImportBag() {
    const body = yield* apiJsonSchema("POST", "/v1/import", BagResultSchema, { path });
    return yield* rejectSoftError("POST", "/v1/import", body);
  });
export const ingestLocal = (
  body: {
    sources?: string[];
    claude_root?: string;
    codex_root?: string;
    dry_run?: boolean;
    limit?: number;
  } = {},
): ApiFx<Schema.Schema.Type<typeof LocalIngestReportSchema>> =>
  Effect.gen(function* runIngestLocal() {
    const report = yield* apiJsonSchema("POST", "/v1/ingest/local", LocalIngestReportSchema, body);
    return yield* rejectSoftError("POST", "/v1/ingest/local", report);
  });

export type LogTail = Schema.Schema.Type<typeof LogTailSchema>;

export const getProxyLog = (lines = 80): ApiFx<LogTail> =>
  apiJsonSchema("GET", `/v1/logs/proxy?lines=${lines}`, LogTailSchema);
export const getClickhouseLog = (lines = 80): ApiFx<LogTail> =>
  apiJsonSchema("GET", `/v1/logs/clickhouse?lines=${lines}`, LogTailSchema);

export const openWikiDir = (path: string): Effect.Effect<boolean | null, never, RivetIpc> =>
  softEffect(invokeCommand<boolean>("open_wiki_dir", { path }));

export const revealPath = (path: string): Effect.Effect<boolean | null, never, RivetIpc> =>
  softEffect(invokeCommand<boolean>("reveal_path", { path }));

export type HomeSnapshot = {
  status: Status;
  accounts: Account[] | null;
  recent: CaptureEvent[] | null;
  providers: { providers: CatalogProvider[] } | null;
};

/** Home bootstrap — status is hard; satellite reads soft-fail to null. */
export const homeSnapshot: ApiBackendFx<HomeSnapshot> = Effect.gen(function* runHomeSnapshot() {
  yield* ensureRivetd;
  return yield* Effect.all(
    {
      status: getStatus,
      accounts: softEffect(getAccounts),
      recent: softEffect(getCapturesRecent(200)),
      providers: softEffect(getProviders),
    },
    { concurrency: "unbounded" },
  );
});

export type RefreshSnapshot = HomeSnapshot & {
  quotaBundle: readonly [QuotaSnapshot, QuotaHistory] | null;
};

/** Parallel bootstrap payload used by the quota home refresh. */
export const refreshSnapshot = (opts: {
  includeQuota: boolean;
  historyHours: number;
}): ApiBackendFx<RefreshSnapshot> =>
  Effect.gen(function* runRefreshSnapshot() {
    const home = yield* homeSnapshot;
    let quotaBundle: RefreshSnapshot["quotaBundle"] = null;
    if (opts.includeQuota) {
      const [quota, history] = yield* Effect.all(
        [softEffect(getQuota), softEffect(getQuotaHistory(opts.historyHours))],
        { concurrency: "unbounded" },
      );
      if (quota !== null && history !== null) {
        quotaBundle = [quota, history];
      }
    }
    return { ...home, quotaBundle };
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
