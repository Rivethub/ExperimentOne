import type { OnboardingStatus, QuotaAccountUx } from "../quota";

export type { CatalogProvider } from "./provider-utils";
export type { OnboardingStatus, QuotaAccountUx as QuotaAccount, QuotaWindow } from "../quota";

export type Page = "quota" | "data" | "runtime" | "wiki" | "settings";

export type SettingsTab = "accounts" | "intelligence" | "harness";

export type Status = {
  ok: boolean;
  proxy_running: boolean;
  proxy_base_url: string;
  mcp_url: string;
  access_key_hint: string;
  account_count: number;
  traffic_backend?: string;
  wiki_dir?: string;
  embedding_model?: string | null;
  wiki_model?: string | null;
  warnings?: string[];
  onboarding?: OnboardingStatus;
  workers?: {
    vector_search: boolean;
    wiki: boolean;
    embeddings: number;
    wiki_pages: number;
    vectorize_cursor?: string | null;
    wiki_cursor?: string | null;
  };
  capabilities: {
    mcp: boolean;
    vector_search: boolean;
    wiki: boolean;
    teams: boolean;
  };
  usage: {
    events: number;
    tokens_in: number;
    tokens_out: number;
  };
};

export type BagResult = {
  path: string;
  event_count: number;
  note?: string;
  schema_version?: number;
};

export type LocalIngestReport = {
  dry_run: boolean;
  files_scanned: number;
  events_parsed: number;
  events_inserted: number;
  events_skipped_existing: number;
  sources: Array<{
    source: string;
    root: string;
    files_scanned: number;
    events_parsed: number;
  }>;
};

export type Account = {
  id: string;
  provider: string;
  label: string;
  limit_hint: string;
  reset_hint: string;
};

export type ProviderQuota = {
  provider: string;
  account_count: number;
  known_count?: number;
  remaining_pct: number;
  capacity_pct: number;
  pool_empty: string;
  first_empty: string;
  next_reset: string;
  burn_last_horizon: string;
  burn_pct_per_hour: number;
};

export type QuotaSnapshot = {
  source: string;
  observed_at: string;
  credentials_total: number;
  credentials_loaded: number;
  providers: ProviderQuota[];
  accounts: QuotaAccountUx[];
  note: string;
};

export type QuotaHistoryPoint = {
  ts: string;
  remaining_pct: number;
  account_count: number;
};

export type QuotaHistory = {
  hours: number;
  providers: { provider: string; points: QuotaHistoryPoint[] }[];
  note: string;
};

export type LoginStatus = {
  active: boolean;
  provider: string | null;
  output: string;
  done: boolean;
  success: boolean;
};

export type HarnessWrite = {
  target: string;
  path: string;
  env_hint: string;
  note: string;
  backup_path?: string | null;
  mode?: string;
};

export type TrafficEvent = {
  id: string;
  ts: string;
  provider: string;
  model?: string | null;
  role?: string;
  content?: string | null;
  tokens_in: number;
  tokens_out: number;
  status_code?: number | null;
  account_label?: string | null;
  latency_ms?: number | null;
  session_id?: string | null;
  /** Hard-evidence project id (explicit field/header or harness projects/<id> key). */
  project_id?: string | null;
  /** Captured working-directory signal — not promoted to project_id alone. */
  cwd?: string | null;
  /** Relative path under Rivet blobs/ when full body was spilled. */
  body_ref?: string | null;
  /** `wire` | `soft` | `imported` */
  capture_quality?: "wire" | "soft" | "imported" | null;
};

export type ConversationSummary = {
  id: string;
  title: string;
  preview?: string | null;
  provider: string;
  model?: string | null;
  project_id?: string | null;
  cwd?: string | null;
  started_at: string;
  updated_at: string;
  message_count: number;
  tokens_in: number;
  tokens_out: number;
  capture_quality?: "wire" | "soft" | "imported" | null;
};

export type ConversationSearchResponse = {
  mode: string;
  results: ConversationSummary[];
};

export type SearchMode = "keyword" | "vector";

export type ProviderFilter = string;
