export type MetricMode = "limits" | "tokens" | "cost";

export type QuotaWindow = {
  id: string;
  label: string;
  remaining_pct?: number | null;
  reset_at?: string | null;
};

export type QuotaAccountUx = {
  id: string;
  provider: string;
  label: string;
  email?: string | null;
  plan?: string | null;
  remaining_pct?: number | null;
  reset_at?: string | null;
  cooldown_seconds?: number | null;
  supports_quota: boolean;
  loaded: boolean;
  status: string;
  windows: QuotaWindow[];
};

export type ProviderQuotaUx = {
  provider: string;
  pool_empty: string;
  remaining_pct: number;
  capacity_pct: number;
  first_empty?: string;
  next_reset?: string;
};

export type OnboardingStatus = {
  proxy_running: boolean;
  has_accounts: boolean;
  has_traffic: boolean;
  harness_ready: boolean;
};

export type TrafficEventUx = {
  ts: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  status_code?: number | null;
};

export type LimitHitInfo = {
  windowLabel: string;
  resetAt: string | null;
  reason: string;
};
