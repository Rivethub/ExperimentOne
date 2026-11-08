import { Effect } from "effect";
import type { WikiInfo, WikiPageCard } from "../components/WikiBoard";
import type { JsonObject } from "../lib/json-types";
import type { HarnessInstallTarget } from "../lib/format-utils";
import type { CatalogProvider } from "../lib/provider-utils";
import type {
  Account,
  BagResult,
  ConversationSearchResponse,
  ConversationSummary,
  HarnessWrite,
  LocalIngestReport,
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

export const listWikiArchives = (
  slug: string,
  projectId?: string,
): ApiFx<WikiArchiveList> => {
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
export const listTidy = (): ApiFx<{ proposals: TidyProposal[] }> =>
  apiJson<{ proposals: TidyProposal[] }>("GET", "/v1/topics/tidy?pending=true");
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
export const listTags = (): ApiFx<{ suggestions: TagSuggestion[] }> =>
  apiJson<{ suggestions: TagSuggestion[] }>("GET", "/v1/topics/tags");
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
export const listFlagged = (): ApiFx<{ flagged: FlaggedJob[] }> =>
  apiJson<{ flagged: FlaggedJob[] }>("GET", "/v1/workers/flagged");
export const retryFlagged = (
  task: string,
  job_key: string,
): ApiFx<{ ok: boolean }> =>
  apiJson<{ ok: boolean }>("POST", "/v1/workers/flagged", { task, job_key });

export const getMemoryStats = apiJson<Record<string, unknown>>("GET", "/v1/memory/stats");
export const getMemoryStartup = (
  topic?: string,
  q?: string,
): ApiFx<{ markdown: string }> => {
  const params = new URLSearchParams();
  if (topic) params.set("topic", topic);
  if (q) params.set("q", q);
  const qs = params.toString();
  return apiJson<{ markdown: string }>("GET", `/v1/memory/startup${qs ? `?${qs}` : ""}`);
};

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
  target: HarnessInstallTarget,
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

export const loadWikiArchiveList = (
  slug: string,
  projectId?: string,
): ApiBackendFx<string[]> =>
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
