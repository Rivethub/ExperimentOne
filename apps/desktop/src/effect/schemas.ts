import { Schema } from "effect";

const OnboardingStatusSchema = Schema.Struct({
  proxy_running: Schema.Boolean,
  has_accounts: Schema.Boolean,
  has_captures: Schema.Boolean,
  harness_ready: Schema.Boolean,
});

const WorkersSchema = Schema.Struct({
  vector_search: Schema.Boolean,
  wiki: Schema.Boolean,
  embeddings: Schema.Finite,
  wiki_pages: Schema.Finite,
  vectorize_cursor: Schema.optional(Schema.NullOr(Schema.String)),
  wiki_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const CapabilitiesSchema = Schema.Struct({
  mcp: Schema.Boolean,
  vector_search: Schema.Boolean,
  wiki: Schema.Boolean,
  teams: Schema.Boolean,
});

const UsageSchema = Schema.Struct({
  events: Schema.Finite,
  tokens_in: Schema.Finite,
  tokens_out: Schema.Finite,
});

export const StatusSchema = Schema.Struct({
  ok: Schema.Boolean,
  proxy_running: Schema.Boolean,
  proxy_base_url: Schema.String,
  mcp_url: Schema.String,
  access_key_hint: Schema.String,
  account_count: Schema.Finite,
  capture_backend: Schema.optional(Schema.String),
  wiki_dir: Schema.optional(Schema.String),
  embedding_model: Schema.optional(Schema.NullOr(Schema.String)),
  embedding_account_id: Schema.optional(Schema.NullOr(Schema.String)),
  embedding_space: Schema.optional(Schema.NullOr(Schema.String)),
  wiki_model: Schema.optional(Schema.NullOr(Schema.String)),
  wiki_account_id: Schema.optional(Schema.NullOr(Schema.String)),
  warnings: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  onboarding: Schema.optional(OnboardingStatusSchema),
  workers: Schema.optional(WorkersSchema),
  capabilities: CapabilitiesSchema,
  usage: UsageSchema,
});

export const AccountSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  limit_hint: Schema.String,
  reset_hint: Schema.String,
  siwc_status: Schema.optional(Schema.NullOr(Schema.String)),
  platform_ready: Schema.optional(Schema.Boolean),
});

export const AccountsSchema = Schema.mutable(Schema.Array(AccountSchema));

const QuotaWindowSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  remaining_pct: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const QuotaAccountUxSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  email: Schema.optional(Schema.NullOr(Schema.String)),
  plan: Schema.optional(Schema.NullOr(Schema.String)),
  remaining_pct: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_at: Schema.optional(Schema.NullOr(Schema.String)),
  cooldown_seconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  supports_quota: Schema.Boolean,
  loaded: Schema.Boolean,
  status: Schema.String,
  windows: Schema.mutable(Schema.Array(QuotaWindowSchema)),
});

const ProviderQuotaSchema = Schema.Struct({
  provider: Schema.String,
  account_count: Schema.Finite,
  known_count: Schema.optional(Schema.Finite),
  remaining_pct: Schema.Finite,
  capacity_pct: Schema.Finite,
  pool_empty: Schema.String,
  first_empty: Schema.String,
  next_reset: Schema.String,
  burn_last_horizon: Schema.String,
  burn_pct_per_hour: Schema.Finite,
});

export const QuotaSnapshotSchema = Schema.Struct({
  source: Schema.String,
  observed_at: Schema.String,
  credentials_total: Schema.Finite,
  credentials_loaded: Schema.Finite,
  providers: Schema.mutable(Schema.Array(ProviderQuotaSchema)),
  accounts: Schema.mutable(Schema.Array(QuotaAccountUxSchema)),
  note: Schema.String,
});

const WikiPageCardSchema = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  path: Schema.String,
  relative_path: Schema.String,
  folder: Schema.String,
  updated_at: Schema.String,
  preview: Schema.String,
});

export const WikiInfoSchema = Schema.Struct({
  path: Schema.String,
  project_id: Schema.String,
  revision: Schema.optional(Schema.Finite),
  pages: Schema.mutable(Schema.Array(WikiPageCardSchema)),
});

export const CatalogProviderSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  badge: Schema.String,
  login_kind: Schema.Literals(["oauth_browser", "oauth_device", "file_import"]),
  login_flag: Schema.optional(Schema.NullOr(Schema.String)),
  aliases: Schema.mutable(Schema.Array(Schema.String)),
  hint: Schema.String,
  color: Schema.String,
});

export const ProvidersResponseSchema = Schema.Struct({
  providers: Schema.mutable(Schema.Array(CatalogProviderSchema)),
});

export const CaptureEventSchema = Schema.Struct({
  id: Schema.String,
  ts: Schema.String,
  provider: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tokens_in: Schema.Finite,
  tokens_out: Schema.Finite,
  status_code: Schema.optional(Schema.NullOr(Schema.Finite)),
  account_label: Schema.optional(Schema.NullOr(Schema.String)),
  latency_ms: Schema.optional(Schema.NullOr(Schema.Finite)),
  session_id: Schema.optional(Schema.NullOr(Schema.String)),
  project_id: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  body_ref: Schema.optional(Schema.NullOr(Schema.String)),
  capture_quality: Schema.optional(Schema.NullOr(Schema.Literals(["wire", "soft", "imported"]))),
  agent_id: Schema.optional(Schema.NullOr(Schema.String)),
  parent_agent_id: Schema.optional(Schema.NullOr(Schema.String)),
  parent_session_id: Schema.optional(Schema.NullOr(Schema.String)),
  request_class: Schema.optional(Schema.NullOr(Schema.String)),
  agent_type: Schema.optional(Schema.NullOr(Schema.String)),
  cache_read_tokens: Schema.optional(Schema.Finite),
  cache_creation_tokens: Schema.optional(Schema.Finite),
  thinking_tokens: Schema.optional(Schema.Finite),
  git_branch: Schema.optional(Schema.NullOr(Schema.String)),
  git_repo: Schema.optional(Schema.NullOr(Schema.String)),
  task_id: Schema.optional(Schema.NullOr(Schema.String)),
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  tool_names: Schema.optional(Schema.NullOr(Schema.String)),
  request_path: Schema.optional(Schema.NullOr(Schema.String)),
  api_format: Schema.optional(Schema.NullOr(Schema.String)),
  error_type: Schema.optional(Schema.NullOr(Schema.String)),
  error_message: Schema.optional(Schema.NullOr(Schema.String)),
  auth_id: Schema.optional(Schema.NullOr(Schema.String)),
  has_thinking: Schema.optional(Schema.NullOr(Schema.Boolean)),
  media_count: Schema.optional(Schema.Finite),
  tool_call_count: Schema.optional(Schema.Finite),
});

export const CaptureEventsSchema = Schema.mutable(Schema.Array(CaptureEventSchema));

export const ConversationSummarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preview: Schema.optional(Schema.NullOr(Schema.String)),
  provider: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  project_id: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.String,
  updated_at: Schema.String,
  message_count: Schema.Finite,
  tokens_in: Schema.Finite,
  tokens_out: Schema.Finite,
  capture_quality: Schema.optional(Schema.NullOr(Schema.Literals(["wire", "soft", "imported"]))),
  agent_ids: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  subagent_events: Schema.optional(Schema.Finite),
  cache_read_tokens: Schema.optional(Schema.Finite),
  thinking_tokens: Schema.optional(Schema.Finite),
  tool_names: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  git_branch: Schema.optional(Schema.NullOr(Schema.String)),
  thinking_events: Schema.optional(Schema.Finite),
  media_count: Schema.optional(Schema.Finite),
  error_events: Schema.optional(Schema.Finite),
  api_format: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ConversationsSchema = Schema.mutable(Schema.Array(ConversationSummarySchema));

export const ConversationSearchResponseSchema = Schema.Struct({
  mode: Schema.String,
  results: ConversationsSchema,
});

export const LoginStatusSchema = Schema.Struct({
  active: Schema.Boolean,
  provider: Schema.NullOr(Schema.String),
  output: Schema.String,
  done: Schema.Boolean,
  success: Schema.Boolean,
});

const QuotaHistoryPointSchema = Schema.Struct({
  ts: Schema.String,
  remaining_pct: Schema.Finite,
  account_count: Schema.Finite,
});

export const QuotaHistorySchema = Schema.Struct({
  hours: Schema.Finite,
  providers: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        points: Schema.mutable(Schema.Array(QuotaHistoryPointSchema)),
      }),
    ),
  ),
  note: Schema.String,
});

export const WikiPageContentSchema = Schema.Struct({
  content: Schema.String,
});

export const MessageResultSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export const RefreshQuotaResultSchema = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  quota: Schema.optional(QuotaSnapshotSchema),
  error: Schema.optional(Schema.String),
});

export const HarnessWriteSchema = Schema.Struct({
  target: Schema.String,
  path: Schema.String,
  env_hint: Schema.String,
  note: Schema.String,
  backup_path: Schema.optional(Schema.NullOr(Schema.String)),
  mode: Schema.optional(Schema.String),
});

export const BagResultSchema = Schema.Struct({
  path: Schema.String,
  event_count: Schema.Finite,
  note: Schema.optional(Schema.String),
  schema_version: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
});

export const WorkersTickSchema = Schema.Struct({
  embeddings: Schema.optional(Schema.Finite),
  embedding_space: Schema.optional(Schema.String),
  wiki_pages: Schema.optional(Schema.Finite),
});

export const WorkersReembedSchema = Schema.Struct({
  ok: Schema.Boolean,
  needs_siwc: Schema.optional(Schema.Boolean),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
  embedding_model: Schema.optional(Schema.String),
  embedding_space: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});

export const LoginStartSchema = Schema.Struct({
  provider: Schema.String,
  message: Schema.String,
  hint: Schema.optional(Schema.NullOr(Schema.String)),
});

/** Empty 2xx bodies decode as `undefined`; non-empty bodies stay untyped. */
export const UnknownOkSchema = Schema.UndefinedOr(Schema.Unknown);

/** Mirrors Rust `PublicConfig` / OpenAPI `PublicConfig` (no secrets). */
export const PublicConfigSchema = Schema.Struct({
  proxy_port: Schema.Finite,
  api_port: Schema.Finite,
  mcp_port: Schema.Finite,
  clickhouse_http_port: Schema.Finite,
  clickhouse_native_port: Schema.Finite,
  access_key_hint: Schema.String,
  management_configured: Schema.Boolean,
  capabilities: CapabilitiesSchema,
  embedding_model: Schema.optional(Schema.NullOr(Schema.String)),
  embedding_account_id: Schema.optional(Schema.NullOr(Schema.String)),
  embedding_space: Schema.optional(Schema.String),
  wiki_model: Schema.optional(Schema.NullOr(Schema.String)),
  wiki_account_id: Schema.optional(Schema.NullOr(Schema.String)),
  wiki_project_id: Schema.String,
  rate_limit_rps: Schema.optional(Schema.Finite),
  rate_limit_burst: Schema.optional(Schema.Finite),
  metrics_enabled: Schema.optional(Schema.Boolean),
});

export const ConfigResponseSchema = PublicConfigSchema;

/** Mirrors Rust `LiveCursor` — cheap poll/SSE sync token. */
export const LiveCursorSchema = Schema.Struct({
  wiki_revision: Schema.Finite,
  capture_events: Schema.Finite,
  observed_at: Schema.String,
});
