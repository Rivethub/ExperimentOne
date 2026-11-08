import type { CatalogProvider } from "../providerUtils";
import type { Account, QuotaHistory, QuotaSnapshot, Status, TrafficEvent } from "../types";
import type { QuotaAccountUx } from "../quota";
import type { WikiInfo } from "../components/WikiBoard";
import type { MockScenario } from "./mode";

export const MOCK_PROVIDERS: CatalogProvider[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    badge: "C",
    login_kind: "oauth_browser",
    login_flag: "claude-login",
    aliases: ["anthropic"],
    hint: "Browser OAuth — complete sign-in in the opened window.",
    color: "#f97316",
  },
  {
    id: "codex",
    label: "Codex (OpenAI)",
    badge: "X",
    login_kind: "oauth_browser",
    login_flag: "codex-login",
    aliases: ["openai", "open_ai"],
    hint: "Browser OAuth — complete ChatGPT sign-in in the opened window.",
    color: "#60a5fa",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    badge: "A",
    login_kind: "oauth_browser",
    login_flag: "antigravity-login",
    aliases: ["google", "gemini"],
    hint: "Browser OAuth for Antigravity / Google Cloud Code credentials.",
    color: "#a78bfa",
  },
  {
    id: "kimi",
    label: "Kimi (kimi.com)",
    badge: "K",
    login_kind: "oauth_device",
    login_flag: "kimi-login",
    aliases: ["kimi.com", "moonshot"],
    hint: "Device / OAuth login for kimi.com.",
    color: "#d97706",
  },
  {
    id: "kimi-ai",
    label: "Kimi (kimi.ai)",
    badge: "キ",
    login_kind: "oauth_device",
    login_flag: "kimi-ai-login",
    aliases: ["kimi.ai"],
    hint: "Device / OAuth login for kimi.ai.",
    color: "#b45309",
  },
  {
    id: "xai",
    label: "xAI",
    badge: "χ",
    login_kind: "oauth_device",
    login_flag: "xai-login",
    aliases: ["grok"],
    hint: "Device / OAuth login for xAI (Grok).",
    color: "#e4e4e7",
  },
  {
    id: "meta",
    label: "Meta",
    badge: "M",
    login_kind: "oauth_device",
    login_flag: "meta-login",
    aliases: ["llama"],
    hint: "Device / OAuth login for Meta AI credentials.",
    color: "#3b82f6",
  },
  {
    id: "devin",
    label: "Devin",
    badge: "D",
    login_kind: "oauth_browser",
    login_flag: "devin-login",
    aliases: [],
    hint: "Browser OAuth for Devin credentials.",
    color: "#22d3ee",
  },
  {
    id: "vertex",
    label: "Vertex AI",
    badge: "V",
    login_kind: "file_import",
    login_flag: null,
    aliases: ["gcp"],
    hint: "Import a Google Cloud service-account JSON.",
    color: "#34d399",
  },
];

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function minutesFromNow(m: number): string {
  return new Date(Date.now() + m * 60_000).toISOString();
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function seedQuotaAccounts(scenario: MockScenario): QuotaAccountUx[] {
  if (scenario === "empty" || scenario === "fresh") return [];

  const limitHit = scenario === "limit-hit";
  return [
    {
      id: "claude-alice",
      provider: "claude",
      label: "alice@example.com",
      email: "alice@example.com",
      plan: "Claude Pro",
      remaining_pct: limitHit ? 0.4 : 62.5,
      reset_at: minutesFromNow(limitHit ? 18 : 140),
      cooldown_seconds: limitHit ? 1080 : null,
      supports_quota: true,
      loaded: true,
      status: "loaded",
      windows: [
        {
          id: "5h",
          label: "5-hour",
          remaining_pct: limitHit ? 0.4 : 48,
          reset_at: minutesFromNow(limitHit ? 18 : 95),
        },
        {
          id: "7d",
          label: "Weekly",
          remaining_pct: limitHit ? 12 : 71,
          reset_at: minutesFromNow(60 * 36),
        },
      ],
    },
    {
      id: "claude-bob",
      provider: "claude",
      label: "bob@example.com",
      email: "bob@example.com",
      plan: "Claude Pro",
      remaining_pct: limitHit ? 0 : 81,
      reset_at: minutesFromNow(200),
      cooldown_seconds: limitHit ? 3600 : null,
      supports_quota: true,
      loaded: true,
      status: "loaded",
      windows: [
        {
          id: "5h",
          label: "5-hour",
          remaining_pct: limitHit ? 0 : 74,
          reset_at: minutesFromNow(200),
        },
        {
          id: "7d",
          label: "Weekly",
          remaining_pct: limitHit ? 8 : 88,
          reset_at: minutesFromNow(60 * 40),
        },
      ],
    },
    {
      id: "codex-main",
      provider: "codex",
      label: "main@openai.example",
      email: "main@openai.example",
      plan: "ChatGPT Plus",
      remaining_pct: limitHit ? 2 : 55,
      reset_at: minutesFromNow(45),
      cooldown_seconds: null,
      supports_quota: true,
      loaded: true,
      status: "loaded",
      windows: [
        {
          id: "primary",
          label: "Primary",
          remaining_pct: limitHit ? 2 : 55,
          reset_at: minutesFromNow(45),
        },
        {
          id: "secondary",
          label: "Secondary",
          remaining_pct: 90,
          reset_at: minutesFromNow(60 * 12),
        },
      ],
    },
  ];
}

export function accountsFromQuota(quotaAccounts: QuotaAccountUx[]): Account[] {
  return quotaAccounts.map((a) => ({
    id: a.id,
    provider: a.provider,
    label: a.email || a.label || a.id,
    limit_hint: a.remaining_pct != null ? `${a.remaining_pct.toFixed(0)}% left` : "—",
    reset_hint: a.reset_at ? `resets ${new Date(a.reset_at).toLocaleTimeString()}` : "—",
  }));
}

export function buildProviderQuota(quotaAccounts: QuotaAccountUx[]): QuotaSnapshot["providers"] {
  const by = new Map<string, QuotaAccountUx[]>();
  for (const a of quotaAccounts) {
    by.set(a.provider, [...(by.get(a.provider) ?? []), a]);
  }
  const out: QuotaSnapshot["providers"] = [];
  for (const [provider, list] of by) {
    const known = list.filter((a) => a.remaining_pct != null);
    const remaining = known.reduce((s, a) => s + (a.remaining_pct ?? 0), 0);
    const capacity = known.length * 100;
    const empty = remaining < 1;
    out.push({
      provider,
      account_count: list.length,
      known_count: known.length,
      remaining_pct: remaining,
      capacity_pct: capacity,
      pool_empty: empty ? "Empty" : "Steady",
      first_empty: empty ? `est. ${list[0]?.label ?? provider} · soon` : "—",
      next_reset: list[0]?.reset_at
        ? `resets ${new Date(list[0].reset_at!).toLocaleString()}`
        : "—",
      burn_last_horizon: "12.4k tok/h",
      burn_pct_per_hour: 4.2,
    });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}

export function seedQuotaHistory(quotaAccounts: QuotaAccountUx[], hours: number): QuotaHistory {
  const providers = [...new Set(quotaAccounts.map((a) => a.provider))];
  return {
    hours,
    note: "Mock remaining-% samples",
    providers: providers.map((provider) => {
      const accts = quotaAccounts.filter((a) => a.provider === provider);
      const base = accts.reduce((s, a) => s + (a.remaining_pct ?? 50), 0);
      const points = [];
      const steps = Math.max(6, hours * 4);
      for (let i = steps; i >= 0; i--) {
        const wobble = Math.sin(i / 3) * 4;
        points.push({
          ts: hoursAgo(i / (steps / hours)),
          remaining_pct: Math.max(
            0,
            Math.min(accts.length * 100, base + wobble - (steps - i) * 0.8),
          ),
          account_count: accts.length,
        });
      }
      return { provider, points };
    }),
  };
}

export function seedTraffic(scenario: MockScenario): TrafficEvent[] {
  if (scenario === "empty" || scenario === "fresh") return [];
  const limitHit = scenario === "limit-hit";
  const rows: TrafficEvent[] = [];
  const models = [
    { provider: "claude", model: "claude-sonnet-4-5", account: "alice@example.com" },
    { provider: "claude", model: "claude-opus-4", account: "bob@example.com" },
    { provider: "codex", model: "gpt-5", account: "main@openai.example" },
  ];
  for (let i = 0; i < 48; i++) {
    const m = models[i % models.length]!;
    const fail = limitHit && i < 6;
    const role = i % 3 === 0 ? "user" : "assistant";
    rows.push({
      id: uuid(i + 1),
      ts: hoursAgo(i * 0.12),
      provider: m.provider,
      model: m.model,
      role,
      content: fail
        ? `rate_limit_error: ${m.provider} quota exhausted for window`
        : `Mock ${role} turn about Rivet traffic event #${i + 1}`,
      tokens_in: fail ? 0 : 400 + (i % 7) * 90,
      tokens_out: fail ? 0 : 120 + (i % 5) * 40,
      status_code: fail ? 429 : 200,
      account_label: m.account,
      latency_ms: fail ? 80 : 450 + (i % 9) * 60,
    });
  }
  return rows;
}

export function seedWiki(): WikiInfo {
  const now = new Date().toISOString();
  return {
    path: "/mock/Rivet/wiki",
    project_id: "default",
    revision: 3,
    pages: [
      {
        id: "rivet/README",
        project_id: "rivet",
        title: "Rivet",
        path: "wiki/rivet/README.md",
        relative_path: "README.md",
        folder: "",
        updated_at: now,
        preview: "Local AI proxy — traffic hub and quota board.",
      },
      {
        id: "rivet/architecture",
        project_id: "rivet",
        title: "Architecture",
        path: "wiki/rivet/architecture.md",
        relative_path: "architecture.md",
        folder: "",
        updated_at: hoursAgo(5),
        preview: "ClickHouse traffic, file meta, Tauri IPC.",
      },
      {
        id: "demo/README",
        project_id: "demo",
        title: "Demo project",
        path: "wiki/demo/README.md",
        relative_path: "README.md",
        folder: "",
        updated_at: hoursAgo(20),
        preview: "Sample wiki project for mock IPC walks.",
      },
    ],
  };
}

export function wikiPageBodies(): Record<string, string> {
  return {
    "rivet/README": `# Rivet\n\nLocal AI proxy — see [Architecture](architecture.md).\n`,
    "rivet/architecture": `# Architecture\n\n- ClickHouse traffic\n- File meta under \`meta/\`\n- Desktop GUI over Tauri IPC\n`,
    "demo/README": `# Demo\n\nMock wiki page for browser-only UI work.\n`,
  };
}

export function seedStatus(
  scenario: MockScenario,
  opts: {
    accounts: Account[];
    traffic: TrafficEvent[];
    proxyRunning: boolean;
    wikiEnabled: boolean;
    vectorEnabled: boolean;
    embedModel: string | null;
    wikiModel: string | null;
  },
): Status {
  const events = opts.traffic.length;
  const tokens_in = opts.traffic.reduce((s, e) => s + e.tokens_in, 0);
  const tokens_out = opts.traffic.reduce((s, e) => s + e.tokens_out, 0);
  const hasAccounts = opts.accounts.length > 0;
  return {
    ok: true,
    proxy_running: opts.proxyRunning,
    proxy_base_url: "http://127.0.0.1:18317",
    mcp_url: "http://127.0.0.1:8741/mcp",
    access_key_hint: "mock…key",
    account_count: opts.accounts.length,
    traffic_backend: "clickhouse",
    wiki_dir: "/mock/Rivet/wiki",
    embedding_model: opts.embedModel,
    wiki_model: opts.wikiModel,
    warnings:
      scenario === "limit-hit" ? ["Mock: quota pool empty — recovery banners should show"] : [],
    onboarding: {
      proxy_running: opts.proxyRunning,
      has_accounts: hasAccounts,
      has_traffic: events > 0,
      harness_ready: hasAccounts && opts.proxyRunning,
    },
    workers: {
      vector_search: opts.vectorEnabled,
      wiki: opts.wikiEnabled,
      embeddings: Math.min(events, 24),
      wiki_pages: 3,
      vectorize_cursor: events > 0 ? (opts.traffic[0]?.id ?? null) : null,
      wiki_cursor: "demo/README",
    },
    capabilities: {
      mcp: true,
      vector_search: opts.vectorEnabled,
      wiki: opts.wikiEnabled,
      teams: false,
    },
    usage: { events, tokens_in, tokens_out },
  };
}
