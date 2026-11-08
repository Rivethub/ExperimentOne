import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WikiBoard, type WikiInfo, type WikiPageCard } from "./WikiBoard";

type Page = "quota" | "traffic" | "runtime" | "wiki" | "export" | "settings";

type SettingsTab = "accounts" | "intelligence" | "harness";

type MetricMode = "remaining" | "burn";

type Status = {
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

type BagResult = {
  path: string;
  event_count: number;
  note?: string;
  schema_version?: number;
};

type Account = {
  id: string;
  provider: string;
  label: string;
  limit_hint: string;
  reset_hint: string;
};

type QuotaAccount = {
  id: string;
  provider: string;
  label: string;
  email?: string | null;
  remaining_pct?: number | null;
  reset_at?: string | null;
  cooldown_seconds?: number | null;
  supports_quota: boolean;
  loaded: boolean;
  status: string;
};

type ProviderQuota = {
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

type QuotaSnapshot = {
  source: string;
  observed_at: string;
  credentials_total: number;
  credentials_loaded: number;
  providers: ProviderQuota[];
  accounts: QuotaAccount[];
  note: string;
};

type LoginStatus = {
  active: boolean;
  provider: string | null;
  output: string;
  done: boolean;
  success: boolean;
};

type HarnessWrite = {
  target: string;
  path: string;
  env_hint: string;
  note: string;
};

type TrafficEvent = {
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
};

type ProviderFilter = string; // "all" or provider id from catalog

type CatalogProvider = {
  id: string;
  label: string;
  badge: string;
  login_kind: "oauth_browser" | "oauth_device" | "file_import";
  login_flag?: string | null;
  aliases: string[];
  hint: string;
  color: string;
};

let API = "http://127.0.0.1:8741";

async function resolveApiBase() {
  const base = await invokeTauri<string>("api_base_url");
  if (base && /^https?:\/\//.test(base)) {
    API = base.replace(/\/$/, "");
  }
}

const FALLBACK_PROVIDERS: CatalogProvider[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    badge: "C",
    login_kind: "oauth_browser",
    login_flag: "claude-login",
    aliases: ["anthropic"],
    hint: "Browser OAuth",
    color: "#f97316",
  },
  {
    id: "codex",
    label: "Codex (OpenAI)",
    badge: "X",
    login_kind: "oauth_device",
    login_flag: "codex-device-login",
    aliases: ["openai"],
    hint: "Device code",
    color: "#60a5fa",
  },
];

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: "quota", label: "Quota", icon: "◈" },
  { id: "traffic", label: "Traffic", icon: "◫" },
  { id: "runtime", label: "Runtime", icon: "⏻" },
  { id: "wiki", label: "Wiki", icon: "☰" },
  { id: "export", label: "Export", icon: "⇪" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "accounts", label: "Accounts", hint: "Provider credentials" },
  { id: "intelligence", label: "Intelligence", hint: "Models & workers" },
  { id: "harness", label: "Harness", hint: "Claude / Codex config" },
];

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

async function pickRivetbag(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "Rivet traffic", extensions: ["rivetbag"] }],
    });
    if (typeof selected === "string") return selected;
    if (Array.isArray(selected) && selected[0]) return selected[0];
    return null;
  } catch {
    return null;
  }
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

function providerKey(p: string) {
  const s = String(p).toLowerCase().trim();
  if (s.includes("claude") || s === "anthropic") return "claude";
  if (s.includes("codex") || s.includes("openai") || s === "open_ai") return "codex";
  if (s.includes("antigravity")) return "antigravity";
  if (s.includes("kimi.ai") || s === "kimi-ai" || s === "kimi_ai") return "kimi-ai";
  if (s.includes("kimi") || s.includes("moonshot")) return "kimi";
  if (s.includes("xai") || s.includes("grok")) return "xai";
  if (s.includes("meta") || s.includes("llama")) return "meta";
  if (s.includes("devin")) return "devin";
  if (s.includes("vertex")) return "vertex";
  if (s.includes("gemini")) return "gemini";
  return s || "other";
}

function providerColor(id: string, catalog: CatalogProvider[]) {
  return catalog.find((p) => p.id === id)?.color
    ?? (id === "claude" ? "#f97316" : id === "codex" ? "#60a5fa" : "#a1a1aa");
}

function providerBadge(id: string, catalog: CatalogProvider[]) {
  return catalog.find((p) => p.id === id)?.badge ?? id.slice(0, 1).toUpperCase();
}

function providerLabel(id: string, catalog: CatalogProvider[]) {
  return catalog.find((p) => p.id === id)?.label ?? id;
}

/** Short chip label; keeps suffixes when two providers share a base name. */
function providerChipLabel(id: string, catalog: CatalogProvider[]) {
  if (id === "kimi") return "kimi.com";
  if (id === "kimi-ai") return "kimi.ai";
  const label = providerLabel(id, catalog);
  const match = label.match(/^(.+?)\s*\((.+)\)$/);
  if (!match) return label;
  const [, base, suffix] = match;
  const clash = catalog.some(
    (p) => p.id !== id && (p.label === base || p.label.startsWith(`${base} (`)),
  );
  return clash ? suffix : base;
}

function formatRelativeIso(iso: string | null | undefined) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 14) return `${Math.round(sec / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

function horizonMs(h: "1h" | "3h" | "6h") {
  return ({ "1h": 1, "3h": 3, "6h": 6 }[h] * 60 * 60 * 1000);
}

function inHorizon(ev: TrafficEvent, horizon: "1h" | "3h" | "6h") {
  const ts = Date.parse(ev.ts);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts <= horizonMs(horizon);
}

type Series = {
  recorded: number[];
  projected: number[];
  headline: number;
  headlineUnit: string;
  emptyAt: string;
  burnLabel: string;
  eventsInWindow: number;
};

/** Build chart series from measured traffic burn (not invented remaining history). */
function seriesFromEvents(
  events: TrafficEvent[],
  provider: string,
  horizon: "1h" | "3h" | "6h",
  mode: MetricMode,
  points = 24,
  liveRemainingPct?: number | null,
  liveCapacityPct?: number | null,
): Series {
  const filtered = events
    .filter((e) => providerKey(e.provider) === provider && inHorizon(e, horizon))
    .slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const hours = { "1h": 1, "3h": 3, "6h": 6 }[horizon];
  const bucketMs = (horizonMs(horizon) / points) || 1;
  const now = Date.now();
  const tokensPerBucket: number[] = Array.from({ length: points }, () => 0);

  for (const e of filtered) {
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) continue;
    const idx = Math.min(
      points - 1,
      Math.max(0, Math.floor((ts - (now - horizonMs(horizon))) / bucketMs)),
    );
    tokensPerBucket[idx] += e.tokens_in + e.tokens_out;
  }

  const totalTokens = tokensPerBucket.reduce((a, b) => a + b, 0);
  // Divide by the span actually covered by samples (not the full horizon if truncated).
  const sampleTs = filtered
    .map((e) => Date.parse(e.ts))
    .filter((t) => !Number.isNaN(t));
  const sampleSpanH =
    sampleTs.length >= 2
      ? Math.max(0.05, (Math.max(...sampleTs) - Math.min(...sampleTs)) / 3_600_000)
      : hours;
  const burnPerHour = sampleSpanH > 0 ? totalTokens / sampleSpanH : totalTokens;
  const capacity = Math.max(0, liveCapacityPct ?? 0);
  const endRemaining =
    liveRemainingPct != null && Number.isFinite(liveRemainingPct)
      ? Math.max(0, liveRemainingPct)
      : null;

  const burnSeries = tokensPerBucket.slice();
  const maxBurn = Math.max(1, ...burnSeries);
  const normalize = (vals: number[], max: number) =>
    vals.map((v) => Number(((v / max) * 100).toFixed(1)));

  // Chart always shows measured token burn. Live remaining is headline-only.
  const recorded = normalize(burnSeries, maxBurn);
  const projected = recorded.slice(); // no fabricated forward curve
  let headline: number;
  let headlineUnit: string;
  if (mode === "remaining" && endRemaining != null && capacity > 0) {
    headline = Number(endRemaining.toFixed(0));
    headlineUnit = `% / ${Math.round(capacity)}`;
  } else {
    headline = Math.round(burnPerHour);
    headlineUnit = mode === "remaining" ? "tok/h · no live %" : "tok/h";
  }

  // remaining_pct is the sum of per-account percentages.
  const remainingTokens =
    endRemaining != null ? (endRemaining / 100) * 80_000 : null;
  let emptyAt = "—";
  if (remainingTokens != null && burnPerHour > 1) {
    const hoursLeft = remainingTokens / burnPerHour;
    emptyAt =
      hoursLeft < 1
        ? `est. ~${Math.round(hoursLeft * 60)}m @ 80k/acct`
        : `est. ~${hoursLeft.toFixed(1)}h @ 80k/acct`;
  } else if (filtered.length === 0 && endRemaining == null) {
    emptyAt = "Sign in to track";
  } else {
    emptyAt = "Steady";
  }

  return {
    recorded,
    projected,
    headline,
    headlineUnit,
    emptyAt,
    burnLabel: `${fmt(Math.round(burnPerHour))} tok/h`,
    eventsInWindow: filtered.length,
  };
}

function fmtPct(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

function accountDisplay(a: QuotaAccount) {
  return a.email || a.label || a.id;
}

function QuotaChart({
  recorded,
  color,
  empty,
  emptyLabel,
}: {
  recorded: number[];
  projected?: number[];
  color: string;
  empty?: boolean;
  emptyLabel?: string;
}) {
  if (empty) {
    return (
      <div className="chart-wrap chart-wrap-empty">
        <p>{emptyLabel ?? "No captured traffic in this window"}</p>
      </div>
    );
  }

  const w = 640;
  const h = 160;
  const pad = 8;
  // "Now" is the latest measured bucket — never clip the historical series.
  const nowIdx = Math.max(0, recorded.length - 1);

  const toPath = (vals: number[], from: number, to: number) => {
    const slice = vals.slice(from, to + 1);
    return slice
      .map((v, i) => {
        const x = pad + ((from + i) / (vals.length - 1)) * (w - pad * 2);
        const y = pad + (1 - v / 100) * (h - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const area = (() => {
    const line = toPath(recorded, 0, nowIdx);
    const x0 = pad;
    const x1 = pad + (nowIdx / (recorded.length - 1)) * (w - pad * 2);
    const yBase = h - pad;
    return `${line} L${x1},${yBase} L${x0},${yBase} Z`;
  })();

  const nowX = pad + (nowIdx / (recorded.length - 1)) * (w - pad * 2);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {[0, 25, 50, 75, 100].map((tick) => {
          const y = pad + (1 - tick / 100) * (h - pad * 2);
          return (
            <line
              key={tick}
              x1={pad}
              x2={w - pad}
              y1={y}
              y2={y}
              stroke="#1f1f23"
              strokeWidth="1"
            />
          );
        })}
        <path d={area} fill={color} opacity="0.12" />
        <path
          d={toPath(recorded, 0, nowIdx)}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line
          x1={nowX}
          x2={nowX}
          y1={pad}
          y2={h - pad}
          stroke="#fafafa"
          strokeWidth="1"
          opacity="0.35"
        />
        <text
          x={Math.max(pad, nowX - 28)}
          y={pad + 10}
          fill="#a1a1aa"
          fontSize="10"
          fontFamily="DM Sans, sans-serif"
        >
          Now
        </text>
      </svg>
      <div className="chart-legend" style={{ color }}>
        <span>
          <i className="swatch" /> Measured traffic burn
        </span>
      </div>
    </div>
  );
}

function trunc(s: string | null | undefined, n = 120) {
  if (!s) return "—";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function prettyJsonChunk(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Stored traffic bodies are `request\\n---\\nresponse`. */
function splitTrafficBody(raw: string | null | undefined): { request: string; response: string | null } {
  if (!raw?.trim()) return { request: "(empty)", response: null };
  const parts = raw.split(/\n---\n/);
  if (parts.length >= 2) {
    return {
      request: prettyJsonChunk(parts[0] ?? ""),
      response: prettyJsonChunk(parts.slice(1).join("\n---\n")),
    };
  }
  return { request: prettyJsonChunk(raw), response: null };
}

function trafficTokenLabel(ev: TrafficEvent): string {
  const code = ev.status_code ?? 0;
  const failed = code > 0 && (code < 200 || code >= 300);
  if (failed && ev.tokens_in === 0 && ev.tokens_out === 0) return "—";
  return `${fmt(ev.tokens_in)}/${fmt(ev.tokens_out)}`;
}

function QuotaProviderCard({
  name,
  ico,
  icoClass,
  color,
  count,
  metricMode,
  series,
  pq,
  accounts,
  horizon,
  onAddCredentials,
}: {
  name: string;
  ico: string;
  icoClass: string;
  color: string;
  count: number;
  metricMode: MetricMode;
  series: Series;
  pq: ProviderQuota | null;
  accounts: QuotaAccount[];
  horizon: string;
  onAddCredentials: () => void;
}) {
  const knownQuota =
    pq != null && pq.capacity_pct > 0 && Number.isFinite(pq.remaining_pct);
  const capacity = knownQuota ? pq!.capacity_pct : 0;
  const remaining = knownQuota ? pq!.remaining_pct : null;
  const headline =
    metricMode === "remaining"
      ? knownQuota
        ? Number(remaining!.toFixed(0))
        : series.headline
      : series.headline;
  const unit =
    metricMode === "remaining"
      ? knownQuota
        ? `% / ${Math.round(capacity)}`
        : series.headlineUnit
      : series.headlineUnit;
  const poolEmpty = pq?.pool_empty && pq.pool_empty !== "—" ? pq.pool_empty : series.emptyAt;
  const firstEmpty = pq?.first_empty ?? "—";
  const nextReset = pq?.next_reset ?? "—";
  // Always match the selected horizon label — backend burn_last_horizon is fixed 3h.
  const burn = series.burnLabel;

  if (count === 0) {
    return (
      <section className="card quota-empty-card">
        <div className="card-head">
          <div className="card-title">
            <div className={`provider-ico ${icoClass}`}>{ico}</div>
            <div>
              <h2>{name}</h2>
              <div className="meta">No credentials yet</div>
            </div>
          </div>
          <button type="button" className="btn primary" onClick={onAddCredentials}>
            Add credentials
          </button>
        </div>
        <p className="quota-empty-copy">
          Sign in under Settings → Accounts to track live quota and burn for {name}.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <div className={`provider-ico ${icoClass}`}>{ico}</div>
          <div>
            <h2>{name}</h2>
            <div className="meta">
              {count} account{count === 1 ? "" : "s"}
              {pq
                ? ` · ${(pq.known_count ?? 0)}/${count} reporting`
                : ""}
              {knownQuota ? ` · pool ${Math.round(capacity)}%` : ""} · {metricMode}
            </div>
          </div>
        </div>
        <div className="pool-stat" title="Sum of remaining % across loaded accounts vs capacity">
          <div className={`big ${icoClass}`}>
            {headline}
            <span className="unit">{unit}</span>
          </div>
          <div className="cap">
            {pq ? "live + traffic burn" : "from captured traffic"}
          </div>
        </div>
      </div>
      <div className="stat-row">
        <div className="item" title="Estimated time until the pooled remaining hits zero at the current burn">
          <div className="k">Pool empty</div>
          <div className="v">{poolEmpty}</div>
        </div>
        <div className="item" title="Account expected to hit empty first under shared burn">
          <div className="k">First empty</div>
          <div className="v">{firstEmpty}</div>
        </div>
        <div className="item" title="Soonest provider reset / refill signal">
          <div className="k">Next reset</div>
          <div className="v">{nextReset}</div>
        </div>
        <div className="item" title={`Burn over the last ${horizon} of captured traffic`}>
          <div className="k">Burn (last {horizon})</div>
          <div className="v">{burn}</div>
        </div>
      </div>
      <QuotaChart
        recorded={series.recorded}
        color={color}
        empty={!knownQuota && series.eventsInWindow === 0}
        emptyLabel={`No captured traffic in the last ${horizon}`}
      />
      <div className="quota-accounts">
        {accounts.map((a) => {
          const rem = a.remaining_pct;
          const empty = rem != null && rem <= 0.5;
          return (
            <div
              key={a.id}
              className={`quota-account ${empty ? "is-empty" : ""} ${a.loaded ? "" : "is-down"}`}
              title={
                a.cooldown_seconds
                  ? `Cooldown ${a.cooldown_seconds}s · ${a.status}`
                  : a.status
              }
            >
              <div className="qa-main">
                <span className={`qa-dot ${empty ? "empty" : a.loaded ? "ok" : "down"}`} />
                <span className="qa-email">{accountDisplay(a)}</span>
                {!a.loaded && <span className="qa-tag">unavailable</span>}
                {empty && <span className="qa-tag empty">empty</span>}
              </div>
              <div className="qa-meta">
                <span title="Remaining quota for this credential">{fmtPct(rem ?? null)}</span>
                <span className="qa-sep">·</span>
                <span title="Next reset">
                  {a.reset_at
                    ? new Date(a.reset_at).toLocaleString(undefined, {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("quota");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("accounts");

  const openSettings = useCallback((tab: SettingsTab = "accounts") => {
    setSettingsTab(tab);
    setPage("settings");
  }, []);
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [horizon, setHorizon] = useState<"1h" | "3h" | "6h">("3h");
  const [metricMode, setMetricMode] = useState<MetricMode>("remaining");
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [catalog, setCatalog] = useState<CatalogProvider[]>(FALLBACK_PROVIDERS);
  const [recent, setRecent] = useState<TrafficEvent[]>([]);
  const [trafficQuery, setTrafficQuery] = useState("");
  const [trafficRows, setTrafficRows] = useState<TrafficEvent[]>([]);
  const [trafficProvider, setTrafficProvider] = useState<ProviderFilter>("all");
  const [trafficStatus, setTrafficStatus] = useState<"all" | "ok" | "error">("all");
  const [proxyLog, setProxyLog] = useState("");
  const [chLog, setChLog] = useState("");
  const [snippet, setSnippet] = useState("");
  const [harnessNote, setHarnessNote] = useState<HarnessWrite | null>(null);
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [apiOnline, setApiOnline] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [statusAction, setStatusAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tosAck, setTosAck] = useState(false);
  const [vertexPath, setVertexPath] = useState("");
  const [bagNote, setBagNote] = useState<string | null>(null);
  const [bagPath, setBagPath] = useState<string | null>(null);
  const [importPath, setImportPath] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [wikiModel, setWikiModel] = useState("");
  const modelsHydrated = useRef(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [wiki, setWiki] = useState<WikiInfo | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TrafficEvent | null>(null);
  const refreshInFlight = useRef(false);
  const apiKeyRef = useRef<string | null>(null);
  apiKeyRef.current = apiKey;

  const authHeaders = useCallback((extra?: HeadersInit): HeadersInit => {
    const headers: Record<string, string> = {};
    if (extra) {
      const h = new Headers(extra);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    if (apiKeyRef.current) headers["X-Rivet-Key"] = apiKeyRef.current;
    return headers;
  }, []);

  const ensureSession = useCallback(async () => {
    if (apiKeyRef.current) return apiKeyRef.current;
    const res = await fetch(`${API}/v1/session`);
    if (!res.ok) throw new Error(`session ${res.status}`);
    const body = (await res.json()) as { api_key: string };
    setApiKey(body.api_key);
    apiKeyRef.current = body.api_key;
    return body.api_key;
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      await ensureSession();
      const hdrs = authHeaders();
      const [statusRes, accountsRes, recentRes, quotaRes, providersRes] = await Promise.all([
        fetch(`${API}/v1/status`),
        fetch(`${API}/v1/accounts`, { headers: hdrs }),
        fetch(`${API}/v1/traffic/recent?limit=200`, { headers: hdrs }),
        fetch(`${API}/v1/quota`, { headers: hdrs }),
        fetch(`${API}/v1/providers`, { headers: hdrs }),
      ]);
      if (!statusRes.ok) throw new Error(`status ${statusRes.status}`);
      const st: Status = await statusRes.json();
      setStatus(st);
      if (!modelsHydrated.current) {
        setEmbedModel(st.embedding_model ?? "");
        setWikiModel(st.wiki_model ?? "");
        modelsHydrated.current = true;
      }
      if (accountsRes.ok) setAccounts(await accountsRes.json());
      if (quotaRes.ok) setQuota(await quotaRes.json());
      if (providersRes.ok) {
        const body = await providersRes.json();
        if (Array.isArray(body.providers) && body.providers.length) {
          setCatalog(body.providers);
        }
      }
      if (recentRes.ok) {
        const rows: TrafficEvent[] = await recentRes.json();
        setRecent(rows);
        if (!trafficQuery.trim()) setTrafficRows(rows);
      }
      setApiOnline(true);
      setLastSyncedAt(Date.now());
      // Clear connectivity banners only; leave user-action errors until dismissed.
      setError((prev) =>
        prev &&
        (prev.includes("Could not reach rivetd") ||
          prev.startsWith("status ") ||
          prev.includes("Failed to fetch") ||
          prev.includes("Load failed") ||
          prev.includes("NetworkError"))
          ? null
          : prev,
      );
    } catch (err) {
      setApiOnline(false);
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach rivetd — start it with cargo run -p rivet-runtime",
      );
    } finally {
      refreshInFlight.current = false;
    }
  }, [trafficQuery, ensureSession]);

  async function refreshCredentials() {
    setBusy(true);
    setStatusAction("Updating credentials…");
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/quota/refresh`, {
        method: "POST",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `refresh failed (${res.status})`);
      if (body.quota) setQuota(body.quota);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }

  const refreshLogin = useCallback(async () => {
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/accounts/login/status`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const body: LoginStatus = await res.json();
      setLogin(body.active || body.output ? body : null);
      if (body.done && body.success) refresh();
    } catch {
      /* rivetd down */
    }
  }, [refresh, ensureSession, authHeaders]);

  const refreshWiki = useCallback(async () => {
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/wiki`, { headers: authHeaders() });
      if (res.ok) setWiki(await res.json());
    } catch {
      /* ignore */
    }
  }, [ensureSession, authHeaders]);

  const loadWikiPage = useCallback(
    async (page: WikiPageCard) => {
      await ensureSession();
      const qs = new URLSearchParams({ id: page.id });
      const res = await fetch(`${API}/v1/wiki/page?${qs}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as { content: string };
      return body.content;
    },
    [ensureSession, authHeaders],
  );

  // Boot rivetd once — not on every page change or traffic-search keystroke.
  useEffect(() => {
    void (async () => {
      await resolveApiBase();
      await invokeTauri("ensure_rivetd");
      await resolveApiBase();
      await refresh();
      await refreshWiki();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only boot
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      refresh();
      if (page === "wiki") refreshWiki();
      if (page === "runtime") void loadLogs();
    }, 3000);
    return () => clearInterval(id);
  }, [refresh, refreshWiki, page]);

  useEffect(() => {
    if (page === "runtime") void loadLogs();
  }, [page]);

  useEffect(() => {
    if (!login?.active) return;
    const id = setInterval(refreshLogin, 1000);
    return () => clearInterval(id);
  }, [login?.active, refreshLogin]);

  const accountSource = quota?.accounts?.length ? quota.accounts : accounts;

  const providerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of catalog) ids.add(p.id);
    for (const a of accountSource) ids.add(providerKey(a.provider));
    for (const p of quota?.providers ?? []) ids.add(providerKey(p.provider));
    for (const e of recent) ids.add(providerKey(e.provider));
    // Prefer catalog order, then extras.
    const ordered = [
      ...catalog.map((p) => p.id),
      ...[...ids].filter((id) => !catalog.some((p) => p.id === id) && id !== "other"),
    ];
    return ordered.filter((id, i) => ordered.indexOf(id) === i);
  }, [catalog, accountSource, quota, recent]);

  const counts = useMemo(() => {
    const by: Record<string, number> = { all: accountSource.length };
    for (const id of providerIds) {
      by[id] = accountSource.filter((a) => providerKey(a.provider) === id).length;
    }
    return by;
  }, [accountSource, providerIds]);

  const providerQuota = useCallback(
    (provider: string) =>
      quota?.providers?.find((p) => providerKey(p.provider) === provider) ?? null,
    [quota],
  );

  const accountsFor = useCallback(
    (provider: string): QuotaAccount[] => {
      if (quota?.accounts?.length) {
        return quota.accounts.filter((a) => providerKey(a.provider) === provider);
      }
      return accounts
        .filter((a) => providerKey(a.provider) === provider)
        .map((a) => ({
          id: a.id,
          provider: a.provider,
          label: a.label,
          email: a.label.includes("@") ? a.label : null,
          remaining_pct: null,
          reset_at: null,
          cooldown_seconds: null,
          supports_quota: false,
          loaded: true,
          status: "local",
        }));
    },
    [quota, accounts],
  );

  const visibleProviders = useMemo(() => {
    if (filter === "all") {
      // Show providers that have accounts/traffic, else the full catalog.
      const active = providerIds.filter(
        (id) => (counts[id] ?? 0) > 0 || recent.some((e) => providerKey(e.provider) === id),
      );
      return active.length ? active : catalog.map((p) => p.id).slice(0, 4);
    }
    return [filter];
  }, [filter, providerIds, counts, recent, catalog]);

  async function proxyAction(path: "start" | "stop" | "restart") {
    setBusy(true);
    setStatusAction(path === "restart" ? "Restarting proxy…" : path === "start" ? "Starting proxy…" : "Stopping proxy…");
    try {
      await ensureSession();
      if (path === "restart") {
        if (status?.proxy_running) {
          const stop = await fetch(`${API}/v1/proxy/stop`, { method: "POST", headers: authHeaders() });
          const stopBody = await stop.json().catch(() => ({}));
          if (!stop.ok) throw new Error(stopBody.error ?? "proxy stop failed");
        }
        const start = await fetch(`${API}/v1/proxy/start`, { method: "POST", headers: authHeaders() });
        const startBody = await start.json().catch(() => ({}));
        if (!start.ok) throw new Error(startBody.error ?? "proxy start failed");
      } else {
        const res = await fetch(`${API}/v1/proxy/${path}`, { method: "POST", headers: authHeaders() });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `proxy ${path} failed`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }

  async function loadClaude() {
    await ensureSession();
    const res = await fetch(`${API}/v1/harness/claude.env`, { headers: authHeaders() });
    setSnippet(await res.text());
    setHarnessNote(null);
  }

  async function loadCodex() {
    await ensureSession();
    const res = await fetch(`${API}/v1/harness/codex.toml`, { headers: authHeaders() });
    setSnippet(await res.text());
    setHarnessNote(null);
  }

  async function loadMcp() {
    await ensureSession();
    const res = await fetch(`${API}/v1/harness/mcp.json`, { headers: authHeaders() });
    setSnippet(await res.text());
    setHarnessNote(null);
  }

  async function writeHarness(target: "claude" | "codex") {
    setBusy(true);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/harness/write`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ target }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "write failed");
      setHarnessNote(body);
      setSnippet(
        target === "claude"
          ? await (await fetch(`${API}/v1/harness/claude.env`, { headers: authHeaders() })).text()
          : await (await fetch(`${API}/v1/harness/codex.toml`, { headers: authHeaders() })).text(),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startLogin(provider: string) {
    if (!tosAck) {
      setError("Acknowledge the ToS note before signing in.");
      return;
    }
    setBusy(true);
    setStatusAction(`Starting ${provider} login…`);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/accounts/login`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ provider }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "login failed");
      setLogin({
        active: true,
        provider,
        output: body.message ?? "",
        done: false,
        success: false,
      });
      openSettings("accounts");
      await refreshLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }

  async function importVertex() {
    if (!tosAck) {
      setError("Acknowledge the ToS note before importing.");
      return;
    }
    let path = vertexPath.trim();
    if (!path) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "Service account", extensions: ["json"] }],
        });
        if (typeof selected === "string") path = selected;
        else if (Array.isArray(selected) && selected[0]) path = selected[0];
      } catch {
        /* typed path fallback */
      }
    }
    if (!path) {
      setError("Choose a Vertex service-account JSON path.");
      return;
    }
    setVertexPath(path);
    setBusy(true);
    setStatusAction("Importing Vertex credentials…");
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/accounts/import/vertex`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "vertex import failed");
      setLogin({
        active: true,
        provider: "vertex",
        output: body.message ?? "",
        done: false,
        success: false,
      });
      openSettings("accounts");
      await refreshLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }

  async function cancelLogin() {
    await ensureSession();
    await fetch(`${API}/v1/accounts/login/cancel`, { method: "POST", headers: authHeaders() });
    await refreshLogin();
  }

  async function removeAccount(id: string) {
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(`Remove account “${id}”? This deletes the local credential file.`, {
        title: "Remove account",
        kind: "warning",
      });
    } catch {
      // Browser/dev fallback when the Tauri dialog plugin is unavailable.
      ok = window.confirm(`Remove account “${id}”? This deletes the local credential file.`);
    }
    if (!ok) return;
    setBusy(true);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/accounts/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "remove failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pickImport() {
    const path = await pickRivetbag();
    if (path) {
      setImportPath(path);
      setPage("export");
    } else if (!importPath) {
      setError("File picker unavailable — paste an absolute .rivetbag path");
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  async function exportBag() {
    setBusy(true);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/export`, { method: "POST", headers: authHeaders() });
      const body: BagResult & { error?: string } = await res.json();
      if (!res.ok) throw new Error(body.error ?? "export failed");
      setBagPath(body.path);
      setBagNote(
        `Exported ${body.event_count} events → ${body.path}${body.note ? ` — ${body.note}` : ""}`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function importBag() {
    if (!importPath.trim()) {
      setError("Paste an absolute path to a .rivetbag file");
      return;
    }
    setBusy(true);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/import`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path: importPath.trim() }),
      });
      const body: BagResult & { error?: string } = await res.json();
      if (!res.ok) throw new Error(body.error ?? "import failed");
      setBagNote(`Imported ${body.event_count} events from ${body.path}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function searchTraffic() {
    setBusy(true);
    try {
      await ensureSession();
      const q = encodeURIComponent(trafficQuery.trim());
      const res = await fetch(`${API}/v1/traffic/search?limit=100&q=${q}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("search failed");
      setTrafficRows(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function seedDemo() {
    setBusy(true);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/demo/seed`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ force: false }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "seed failed");
      setBagNote(`${body.note} (+${body.inserted} events)`);
      await refresh();
      setPage("traffic");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const titleMap: Record<Page, string> = {
    quota: "Quota Management",
    traffic: "Traffic",
    runtime: "Runtime",
    wiki: "Wiki",
    export: "Export / import",
    settings: "Settings",
  };
  const title = titleMap[page];

  const credentialCount =
    quota?.credentials_total ?? status?.account_count ?? accounts.length;
  const subtitle =
    page === "quota"
      ? credentialCount === 0
        ? `No credentials · proxy ${status?.proxy_running ? "running" : "stopped"}`
        : `${credentialCount} credential${credentialCount === 1 ? "" : "s"} · ${
            quota?.source === "management" ? "live quota" : "local estimates"
          } · proxy ${status?.proxy_running ? "running" : "stopped"}`
      : page === "traffic"
        ? `${fmt(status?.usage.events ?? recent.length)} captured events`
        : page === "runtime"
          ? status?.proxy_base_url ?? "Control plane · workers · logs"
          : page === "wiki"
            ? (() => {
                const n = new Set(
                  (wiki?.pages ?? [])
                    .filter((p) => /(^|\/)README\.md$/i.test(p.relative_path))
                    .map((p) => p.project_id || "project"),
                ).size;
                return `${n} project${n === 1 ? "" : "s"}`;
              })()
            : page === "settings"
              ? SETTINGS_TABS.find((t) => t.id === settingsTab)?.hint ?? "Configure Rivet"
              : `${fmt(status?.usage.events ?? 0)} events ready · credentials excluded`;

  async function openWiki() {
    const path = wiki?.path ?? (status?.wiki_dir ? `${status.wiki_dir}/default` : null);
    if (!path) {
      setError("Wiki path unknown — is rivetd up?");
      return;
    }
    const ok = await invokeTauri("open_wiki_dir", { path });
    if (ok === null) {
      setBagNote(`Wiki directory: ${path}`);
      await navigator.clipboard.writeText(path).catch(() => undefined);
    }
  }

  async function revealExport() {
    const path = bagPath;
    if (!path) {
      setError("Export a package first");
      return;
    }
    const ok = await invokeTauri("reveal_path", { path });
    if (ok === null) {
      await copyText(path);
      setBagNote(`Copied path: ${path}`);
    }
  }

  async function saveIntelligence() {
    setBusy(true);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/config`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          embedding_model: embedModel,
          wiki_model: wikiModel,
          capabilities: {
            vector_search: !!embedModel.trim() || status?.capabilities.vector_search,
            wiki: !!wikiModel.trim() || status?.capabilities.wiki,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "config save failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCapability(key: "vector_search" | "wiki", value: boolean) {
    setBusy(true);
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/config`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ capabilities: { [key]: value } }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "config save failed");
      }
      await refresh();
      if (key === "wiki") await refreshWiki();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runWorkers() {
    setBusy(true);
    setStatusAction("Updating wiki & vectors…");
    try {
      await ensureSession();
      const res = await fetch(`${API}/v1/workers/tick`, { method: "POST", headers: authHeaders() });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "worker tick failed");
      setBagNote(
        `Workers ran — ${body.embeddings ?? 0} embeddings, ${body.wiki_pages ?? 0} wiki pages`,
      );
      await refresh();
      await refreshWiki();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStatusAction(null);
    }
  }

  function formatSynced(ts: number | null) {
    if (!ts) return "never";
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    return `${Math.floor(sec / 60)}m ago`;
  }

  async function loadLogs() {
    try {
      await ensureSession();
      const hdrs = authHeaders();
      const [proxyRes, chRes] = await Promise.all([
        fetch(`${API}/v1/logs/proxy?lines=80`, { headers: hdrs }),
        fetch(`${API}/v1/logs/clickhouse?lines=80`, { headers: hdrs }),
      ]);
      if (proxyRes.ok) {
        const body = await proxyRes.json();
        setProxyLog(body.text ?? "");
      }
      if (chRes.ok) {
        const body = await chRes.json();
        setChLog(body.text ?? "");
      }
    } catch {
      /* rivetd down */
    }
  }

  const filteredTraffic = useMemo(() => {
    return trafficRows.filter((ev) => {
      if (trafficProvider !== "all" && providerKey(ev.provider) !== trafficProvider) {
        return false;
      }
      if (trafficStatus === "ok") {
        const code = ev.status_code ?? 0;
        if (code < 200 || code >= 400) return false;
      }
      if (trafficStatus === "error") {
        const code = ev.status_code ?? 0;
        if (code > 0 && code < 400) return false;
        if (code === 0) return false;
      }
      return true;
    });
  }, [trafficRows, trafficProvider, trafficStatus]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div className="brand-copy">
            <strong>Rivet</strong>
            <span>local traffic hub</span>
          </div>
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-btn ${page === item.id ? "active" : ""}`}
            onClick={() => setPage(item.id)}
          >
            <span className="ico">{item.icon}</span>
            {item.label}
            {item.id === "settings" && accounts.length > 0 && (
              <span className="badge">{accounts.length}</span>
            )}
            {item.id === "traffic" && (status?.usage.events ?? 0) > 0 && (
              <span className="badge">
                {(status?.usage.events ?? 0) > 99 ? "99+" : status?.usage.events}
              </span>
            )}
          </button>
        ))}
        <div className="sidebar-foot">
          Multi-account pooling may conflict with provider ToS. Rivet does not
          encourage reselling subscription traffic as a public API.
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            <div className="sub">{subtitle}</div>
          </div>
          <div className="top-actions">
            <button className="btn ghost" disabled={busy} onClick={refresh}>
              Refresh
            </button>
            {page === "quota" && (
              <>
                <button className="btn" disabled={busy} onClick={() => void refreshCredentials()}>
                  Refresh credentials
                </button>
                <button className="btn primary" disabled={busy} onClick={() => openSettings("accounts")}>
                  Manage credentials
                </button>
              </>
            )}
            {page === "wiki" && (
              <>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => openSettings("intelligence")}
                >
                  {status?.capabilities.wiki ? "Settings" : "Enable wiki"}
                </button>
                <button className="btn primary" onClick={openWiki}>
                  Open folder
                </button>
              </>
            )}
            {page === "runtime" && (
              <>
                {status?.proxy_running ? (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => proxyAction("stop")}
                  >
                    Stop proxy
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    disabled={busy || !apiOnline}
                    onClick={() => proxyAction("start")}
                  >
                    Start proxy
                  </button>
                )}
                <button
                  className="btn"
                  disabled={busy || !apiOnline}
                  onClick={() => proxyAction("restart")}
                >
                  Restart
                </button>
                <button className="btn" disabled={busy || !apiOnline} onClick={runWorkers}>
                  Run workers
                </button>
              </>
            )}
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}
        {status?.warnings?.map((w) => (
          <div key={w} className="error-banner">
            {w}
          </div>
        ))}

        <div className="content">
          {page === "quota" && (
            <>
              {counts.all > 0 ? (
                <>
                  <div className="filters">
                    <button
                      className={`chip ${filter === "all" ? "active" : ""}`}
                      onClick={() => setFilter("all")}
                    >
                      All
                      <span className="count">{counts.all ?? 0}</span>
                    </button>
                    {providerIds.map((id) => (
                      <button
                        key={id}
                        className={`chip ${filter === id ? "active" : ""}`}
                        onClick={() => setFilter(id)}
                      >
                        <span className="dot" style={{ background: providerColor(id, catalog) }} />
                        {providerChipLabel(id, catalog)}
                        <span className="count">{counts[id] ?? 0}</span>
                      </button>
                    ))}
                  </div>

                  <div className="toolbar">
                    <div className="seg">
                      {(
                        [
                          ["remaining", "Remaining"],
                          ["burn", "Burn rate"],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          className={metricMode === id ? "active" : ""}
                          onClick={() => setMetricMode(id)}
                          title={
                            id === "remaining"
                              ? "Live remaining % when available; chart shows measured burn"
                              : "Token burn from captured traffic (sample span)"
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="seg">
                      {(["1h", "3h", "6h"] as const).map((h) => (
                        <button
                          key={h}
                          className={horizon === h ? "active" : ""}
                          onClick={() => setHorizon(h)}
                        >
                          {h}
                        </button>
                      ))}
                    </div>
                    <span className="empty" title={quota?.note}>
                      {quota?.source === "management"
                        ? `Live credentials · ${quota.credentials_loaded}/${quota.credentials_total} loaded · ${horizon} burn`
                        : `Local fallback · ${horizon} window · refresh after proxy is up`}
                    </span>
                  </div>

                  <div className="stack">
                    {visibleProviders.map((id) => {
                      const pq = providerQuota(id);
                      const series = seriesFromEvents(
                        recent,
                        id,
                        horizon,
                        metricMode,
                        24,
                        pq?.remaining_pct,
                        pq?.capacity_pct,
                      );
                      return (
                        <QuotaProviderCard
                          key={id}
                          name={providerChipLabel(id, catalog)}
                          ico={providerBadge(id, catalog)}
                          icoClass={id === "claude" || id === "codex" ? id : "generic"}
                          color={providerColor(id, catalog)}
                          count={counts[id] ?? 0}
                          metricMode={metricMode}
                          series={series}
                          pq={pq}
                          accounts={accountsFor(id)}
                          horizon={horizon}
                          onAddCredentials={() => openSettings("accounts")}
                        />
                      );
                    })}
                  </div>
                </>
              ) : (
                <section className="card quota-empty-card">
                  <div className="card-head">
                    <div className="card-title">
                      <div>
                        <h2>No credentials yet</h2>
                        <div className="meta">Live quota needs at least one signed-in account</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => openSettings("accounts")}
                    >
                      Add credentials
                    </button>
                  </div>
                  <p className="quota-empty-copy">
                    Sign in under Settings → Accounts. Burn and remaining charts appear once
                    credentials (and traffic) land.
                  </p>
                </section>
              )}
            </>
          )}

          {page === "traffic" && (
            <section className="panel-block traffic-page">
              <h2>Captured requests</h2>
              <p className="lede">
                Search local traffic history. Bodies get best-effort secret redaction before
                store and export.
              </p>
              <div className="filters" style={{ marginBottom: 10 }}>
                <button
                  className={`chip ${trafficProvider === "all" ? "active" : ""}`}
                  onClick={() => setTrafficProvider("all")}
                >
                  All
                </button>
                {providerIds.map((id) => (
                  <button
                    key={id}
                    className={`chip ${trafficProvider === id ? "active" : ""}`}
                    onClick={() => setTrafficProvider(id)}
                  >
                    <span className="dot" style={{ background: providerColor(id, catalog) }} />
                    {providerChipLabel(id, catalog)}
                  </button>
                ))}
                <div className="seg" style={{ marginLeft: 4 }}>
                  {(
                    [
                      ["all", "Any status"],
                      ["ok", "2xx"],
                      ["error", "4xx/5xx"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={trafficStatus === id ? "active" : ""}
                      onClick={() => setTrafficStatus(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="import-row" style={{ marginTop: 0 }}>
                <input
                  className="path-input"
                  placeholder="Search content, model, session…"
                  value={trafficQuery}
                  onChange={(e) => setTrafficQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchTraffic();
                  }}
                />
                <button className="btn primary" disabled={busy} onClick={searchTraffic}>
                  Search
                </button>
                {(status?.usage.events ?? 0) === 0 && (
                  <button className="btn" disabled={busy} onClick={seedDemo}>
                    Load demo
                  </button>
                )}
              </div>
              <div className={`traffic-layout ${selectedEvent ? "has-detail" : ""}`}>
                <div className="traffic-table">
                  <div className="traffic-head">
                    <span>When</span>
                    <span>Provider</span>
                    <span>Model</span>
                    <span className="traffic-tokens">Tokens</span>
                    <span>Preview</span>
                  </div>
                  {filteredTraffic.length === 0 ? (
                    <p className="empty">
                      {trafficRows.length === 0
                        ? "No events yet — start the proxy or load demo traffic."
                        : "No events match these filters."}
                    </p>
                  ) : (
                    filteredTraffic.map((ev) => (
                      <button
                        key={ev.id}
                        className={`traffic-row ${selectedEvent?.id === ev.id ? "active" : ""}`}
                        onClick={() => setSelectedEvent(ev)}
                      >
                        <span className="mono">
                          {new Date(ev.ts).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span className="traffic-provider">
                          <span
                            className="pill"
                            style={{
                              background: `${providerColor(providerKey(ev.provider), catalog)}22`,
                              color: providerColor(providerKey(ev.provider), catalog),
                            }}
                          >
                            {providerChipLabel(providerKey(ev.provider), catalog)}
                          </span>
                          {ev.status_code != null && ev.status_code >= 400 && (
                            <span className="pill bad">{ev.status_code}</span>
                          )}
                        </span>
                        <span className="mono">{ev.model ?? "—"}</span>
                        <span className="mono traffic-tokens">{trafficTokenLabel(ev)}</span>
                        <span className="preview">{trunc(ev.content, 80)}</span>
                      </button>
                    ))
                  )}
                </div>
                {selectedEvent && (() => {
                  const bodies = splitTrafficBody(selectedEvent.content);
                  return (
                  <div className="event-detail">
                    <div className="event-detail-head">
                      <div className="event-detail-title">
                        <strong>
                          {providerChipLabel(providerKey(selectedEvent.provider), catalog)}
                        </strong>
                        <span className="mono">{selectedEvent.model ?? "—"}</span>
                        <span className="event-detail-when">
                          {new Date(selectedEvent.ts).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => setSelectedEvent(null)}
                      >
                        Close
                      </button>
                    </div>
                    <div className="event-detail-meta">
                      <div className="item">
                        <span className="k">Status</span>
                        <span className="v">{selectedEvent.status_code ?? "—"}</span>
                      </div>
                      <div className="item">
                        <span className="k">Latency</span>
                        <span className="v">
                          {selectedEvent.latency_ms != null
                            ? `${selectedEvent.latency_ms} ms`
                            : "—"}
                        </span>
                      </div>
                      <div className="item">
                        <span className="k">Account</span>
                        <span className="v">{selectedEvent.account_label ?? "—"}</span>
                      </div>
                      <div className="item">
                        <span className="k">Role</span>
                        <span className="v">{selectedEvent.role ?? "—"}</span>
                      </div>
                    </div>
                    <div className="event-detail-bodies">
                      <div className="event-body-block">
                        <div className="event-body-label">Request</div>
                        <pre className="snippet">{bodies.request}</pre>
                      </div>
                      {bodies.response != null && (
                        <div className="event-body-block">
                          <div className="event-body-label">Response</div>
                          <pre className="snippet">{bodies.response}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                  );
                })()}
              </div>
            </section>
          )}

          {page === "runtime" && (
            <div className="runtime">
              <div className="runtime-grid">
                <div className="runtime-card">
                  <div className="runtime-card-head">
                    <span>Proxy</span>
                    <span className={`pill ${status?.proxy_running ? "ok" : "bad"}`}>
                      {status?.proxy_running ? "live" : "stopped"}
                    </span>
                  </div>
                  <div className="runtime-card-body">
                    <div className="kv-row">
                      <span className="k">Base URL</span>
                      <span className="v">{status?.proxy_base_url ?? "—"}</span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Access key</span>
                      <span className="v">{status?.access_key_hint ?? "—"}</span>
                    </div>
                  </div>
                  <div className="runtime-card-foot">
                    <button className="btn" onClick={() => copyText(status?.proxy_base_url ?? "")}>
                      Copy URL
                    </button>
                  </div>
                </div>

                <div className="runtime-card">
                  <div className="runtime-card-head">
                    <span>Store</span>
                    <span className="pill ok">{status?.traffic_backend ?? "sqlite"}</span>
                  </div>
                  <div className="runtime-card-body">
                    <div className="kv-row">
                      <span className="k">Events</span>
                      <span className="v">{fmt(status?.usage.events ?? 0)}</span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Tokens</span>
                      <span className="v">
                        {fmt(status?.usage.tokens_in ?? 0)} in · {fmt(status?.usage.tokens_out ?? 0)}{" "}
                        out
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Accounts</span>
                      <span className="v">{fmt(status?.account_count ?? accounts.length)}</span>
                    </div>
                  </div>
                </div>

                <div className="runtime-card">
                  <div className="runtime-card-head">
                    <span>MCP</span>
                    <span className={`pill ${status?.capabilities.mcp ? "ok" : ""}`}>
                      {status?.capabilities.mcp ? "enabled" : "off"}
                    </span>
                  </div>
                  <div className="runtime-card-body">
                    <div className="kv-row">
                      <span className="k">Endpoint</span>
                      <span className="v">{status?.mcp_url ?? "—"}</span>
                    </div>
                  </div>
                  <div className="runtime-card-foot">
                    <button className="btn" onClick={() => copyText(status?.mcp_url ?? "")}>
                      Copy MCP URL
                    </button>
                  </div>
                </div>

                <div className="runtime-card">
                  <div className="runtime-card-head">
                    <span>Vector worker</span>
                    <span
                      className={`pill ${
                        status?.workers?.vector_search || status?.capabilities.vector_search
                          ? "ok"
                          : ""
                      }`}
                    >
                      {status?.workers?.vector_search || status?.capabilities.vector_search
                        ? "on"
                        : "off"}
                    </span>
                  </div>
                  <div className="runtime-card-body">
                    <div className="kv-row">
                      <span className="k">Embeddings</span>
                      <span className="v">{fmt(status?.workers?.embeddings ?? 0)}</span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Last run</span>
                      <span
                        className="v"
                        title={status?.workers?.vectorize_cursor ?? undefined}
                      >
                        {formatRelativeIso(status?.workers?.vectorize_cursor)}
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Model</span>
                      <span className="v">{status?.embedding_model || "lexical (v1)"}</span>
                    </div>
                  </div>
                </div>

                <div className="runtime-card">
                  <div className="runtime-card-head">
                    <span>Wiki worker</span>
                    <span
                      className={`pill ${
                        status?.workers?.wiki || status?.capabilities.wiki ? "ok" : ""
                      }`}
                    >
                      {status?.workers?.wiki || status?.capabilities.wiki ? "on" : "off"}
                    </span>
                  </div>
                  <div className="runtime-card-body">
                    <div className="kv-row">
                      <span className="k">Pages</span>
                      <span className="v">{fmt(status?.workers?.wiki_pages ?? 0)}</span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Last run</span>
                      <span className="v" title={status?.workers?.wiki_cursor ?? undefined}>
                        {formatRelativeIso(status?.workers?.wiki_cursor)}
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Model</span>
                      <span className="v">{status?.wiki_model || "structure only"}</span>
                    </div>
                  </div>
                  <div className="runtime-card-foot">
                    <button className="btn" onClick={() => openSettings("intelligence")}>
                      Configure
                    </button>
                  </div>
                </div>

                <div className="runtime-card">
                  <div className="runtime-card-head">
                    <span>rivetd</span>
                    <span className={`pill ${apiOnline ? "ok" : "bad"}`}>
                      {apiOnline ? "online" : "offline"}
                    </span>
                  </div>
                  <div className="runtime-card-body">
                    <div className="kv-row">
                      <span className="k">Synced</span>
                      <span className="v">{formatSynced(lastSyncedAt)}</span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Wiki path</span>
                      <span className="v" title={status?.wiki_dir ?? undefined}>
                        {status?.wiki_dir ?? "—"}
                      </span>
                    </div>
                  </div>
                  <div className="runtime-card-foot">
                    <button className="btn" onClick={() => void refresh()}>
                      Sync now
                    </button>
                    <button className="btn" onClick={() => openSettings("accounts")}>
                      Accounts
                    </button>
                  </div>
                </div>
              </div>

              <div className="runtime-logs">
                <div className="runtime-log-pane">
                  <div className="runtime-card-head">
                    <span>Proxy log</span>
                    <button className="btn ghost" onClick={loadLogs}>
                      Refresh
                    </button>
                  </div>
                  <pre className="snippet">{proxyLog || "No proxy log yet."}</pre>
                </div>
                <div className="runtime-log-pane">
                  <div className="runtime-card-head">
                    <span>ClickHouse log</span>
                    <button className="btn ghost" onClick={loadLogs}>
                      Refresh
                    </button>
                  </div>
                  <pre className="snippet">{chLog || "No ClickHouse log yet."}</pre>
                </div>
              </div>
            </div>
          )}

          {page === "wiki" && (
            <WikiBoard
              wiki={wiki}
              busy={busy}
              wikiEnabled={!!status?.capabilities.wiki}
              onOpenFolder={openWiki}
              onEnable={() => openSettings("intelligence")}
              loadPage={loadWikiPage}
            />
          )}

          {page === "settings" && (
            <div className="settings">
              <div className="settings-tabs" role="tablist" aria-label="Settings sections">
                {SETTINGS_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === tab.id}
                    className={`settings-tab ${settingsTab === tab.id ? "active" : ""}`}
                    onClick={() => setSettingsTab(tab.id)}
                  >
                    <strong>{tab.label}</strong>
                    <span>{tab.hint}</span>
                  </button>
                ))}
              </div>

              {settingsTab === "accounts" && (
                <section className="panel-block settings-panel">
                  <h2>Provider sign-in</h2>
                  <p className="lede">
                    Triggers rivet-proxy OAuth / device flows. Tokens stay under Application
                    Support and are never included in `.rivetbag` exports.
                  </p>
                  <label className={`tos ${tosAck ? "" : "tos-gated"}`}>
                    <input
                      type="checkbox"
                      checked={tosAck}
                      onChange={(e) => setTosAck(e.target.checked)}
                    />
                    <span>
                      I understand multi-account pooling may conflict with provider Terms of
                      Service. Rivet does not encourage reselling subscription traffic as a
                      public API.
                      {!tosAck && (
                        <em className="tos-hint"> Check this to unlock provider sign-in.</em>
                      )}
                    </span>
                  </label>
                  <div className="provider-grid">
                    {catalog
                      .filter((p) => p.login_kind !== "file_import")
                      .map((p) => (
                        <button
                          key={p.id}
                          className="btn provider-login"
                          style={{ borderColor: `${p.color}55` }}
                          disabled={busy || !tosAck || !!login?.active}
                          title={p.hint}
                          onClick={() => void startLogin(p.id)}
                        >
                          <span
                            className="provider-ico"
                            style={{ background: `${p.color}22`, color: p.color }}
                          >
                            {p.badge}
                          </span>
                          <span>
                            <strong>{p.label}</strong>
                            <span className="hint">
                              {p.login_kind === "oauth_device" ? "device / OAuth" : "browser OAuth"}
                            </span>
                          </span>
                        </button>
                      ))}
                  </div>
                  <div className="vertex-import">
                    <div className="lede" style={{ marginBottom: 8 }}>
                      Vertex AI — import a Google Cloud service-account JSON (same as rivet-proxy
                      `-vertex-import`).
                    </div>
                    <div className="import-row">
                      <input
                        className="path-input"
                        placeholder="/path/to/service-account.json"
                        value={vertexPath}
                        onChange={(e) => setVertexPath(e.target.value)}
                      />
                      <button
                        className="btn"
                        disabled={busy || !tosAck || !!login?.active}
                        onClick={() => void importVertex()}
                      >
                        Import Vertex
                      </button>
                    </div>
                  </div>
                  <div className="actions">
                    {login?.active && (
                      <button className="btn danger" onClick={cancelLogin}>
                        Cancel login
                      </button>
                    )}
                  </div>

                  {accounts.length === 0 ? (
                    <p className="empty">No accounts yet — sign in above.</p>
                  ) : (
                    <ul className="account-list">
                      {accounts.map((a) => (
                        <li key={a.id}>
                          <div>
                            <strong>{a.label}</strong>
                            <div className="mono">{a.provider}</div>
                          </div>
                          <div className="account-actions">
                            <span className="mono">
                              limit {a.limit_hint} · reset {a.reset_hint}
                            </span>
                            <button
                              className="btn danger"
                              disabled={busy}
                              onClick={() => removeAccount(a.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {login && (login.active || login.output) && (
                    <div style={{ marginTop: 16 }}>
                      <div className="kv-row" style={{ border: 0, padding: 0 }}>
                        <span className="k">Login log ({login.provider ?? "—"})</span>
                        <span
                          className={`pill ${login.success ? "ok" : login.done ? "bad" : ""}`}
                        >
                          {login.active ? "in progress" : login.success ? "done" : "ended"}
                        </span>
                      </div>
                      <pre className="snippet">
                        {login.output || "Waiting for proxy output…"}
                      </pre>
                    </div>
                  )}
                </section>
              )}

              {settingsTab === "intelligence" && (
                <section className="panel-block settings-panel">
                  <h2>Intelligence</h2>
                  <p className="lede">
                    Choose which workers run and which models they use. Live worker status lives on
                    the Runtime dashboard.
                  </p>
                  <div className="settings-toggle-row">
                    <div>
                      <strong>Vector search</strong>
                      <p>Lexical embeddings for MCP search (offline, no remote model required).</p>
                    </div>
                    <button
                      type="button"
                      className={`toggle-pill ${status?.capabilities.vector_search ? "on" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        toggleCapability(
                          "vector_search",
                          !status?.capabilities.vector_search,
                        )
                      }
                    >
                      <span className="toggle-dot" aria-hidden />
                      {status?.capabilities.vector_search ? "Enabled" : "Disabled"}
                    </button>
                  </div>
                  <div className="settings-toggle-row">
                    <div>
                      <strong>Wiki worker</strong>
                      <p>Keep the markdown tree updated from captured traffic.</p>
                    </div>
                    <button
                      type="button"
                      className={`toggle-pill ${status?.capabilities.wiki ? "on" : ""}`}
                      disabled={busy}
                      onClick={() => toggleCapability("wiki", !status?.capabilities.wiki)}
                    >
                      <span className="toggle-dot" aria-hidden />
                      {status?.capabilities.wiki ? "Enabled" : "Disabled"}
                    </button>
                  </div>
                  <div className="settings-fields">
                    <label>
                      <span>
                        Embedding model <em className="field-badge">v1 lexical</em>
                      </span>
                      <input
                        className="path-input"
                        placeholder="reserved — v1 uses lexical vectors"
                        value={embedModel}
                        disabled
                        readOnly
                        title="Reserved for a future remote-embedding release; search stays lexical."
                      />
                    </label>
                    <label>
                      <span>Wiki text model</span>
                      <input
                        className="path-input"
                        placeholder="optional, e.g. claude-sonnet-4-5"
                        value={wikiModel}
                        onChange={(e) => setWikiModel(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="actions">
                    <button className="btn primary" disabled={busy} onClick={saveIntelligence}>
                      Save models
                    </button>
                    <button className="btn" disabled={busy} onClick={runWorkers}>
                      Run workers once
                    </button>
                    <button className="btn" onClick={() => setPage("runtime")}>
                      Open Runtime
                    </button>
                  </div>
                  <p className="note">
                    Lexical embeddings stay consistent with MCP search. The embedding model field is
                    reserved for a later remote-vector release.
                  </p>
                  {bagNote && <p className="note">{bagNote}</p>}
                </section>
              )}

              {settingsTab === "harness" && (
                <section className="panel-block settings-panel">
                  <h2>Point harnesses at Rivet</h2>
                  <p className="lede">
                    Copy snippets or write isolated config directories so default Claude / Codex
                    installs stay untouched.
                  </p>
                  <div className="actions">
                    <button className="btn" onClick={loadClaude}>
                      Claude settings.json
                    </button>
                    <button className="btn" onClick={loadCodex}>
                      Codex config.toml
                    </button>
                    <button className="btn" onClick={loadMcp}>
                      MCP servers.json
                    </button>
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => writeHarness("claude")}
                    >
                      Write Claude config dir
                    </button>
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => writeHarness("codex")}
                    >
                      Write Codex config dir
                    </button>
                  </div>
                  {harnessNote && (
                    <div style={{ marginTop: 16 }}>
                      <p className="note">{harnessNote.note}</p>
                      <div className="kv">
                        <div className="kv-row">
                          <span className="k">Path</span>
                          <span className="v">{harnessNote.path}</span>
                        </div>
                        <div className="kv-row">
                          <span className="k">Env</span>
                          <span className="v">{harnessNote.env_hint}</span>
                        </div>
                      </div>
                      <div className="actions">
                        <button className="btn" onClick={() => copyText(harnessNote.env_hint)}>
                          Copy env export
                        </button>
                      </div>
                    </div>
                  )}
                  {snippet && (
                    <div style={{ marginTop: 12 }}>
                      <div className="actions">
                        <button className="btn" onClick={() => copyText(snippet)}>
                          Copy snippet
                        </button>
                      </div>
                      <pre className="snippet">{snippet}</pre>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {page === "export" && (
            <div className="xfer">
              <div className="xfer-grid">
                <section className="xfer-card export">
                  <div className="xfer-card-top">
                    <span className="xfer-glyph" aria-hidden>
                      ⇪
                    </span>
                    <div>
                      <h3>Export</h3>
                      <p>Write a traffic package from the local store.</p>
                    </div>
                  </div>
                  <ul className="xfer-bullets">
                    <li>OAuth dirs and proxy secrets excluded</li>
                    <li>Bodies redacted best-effort before pack</li>
                    <li>Saved under the local Rivet data directory / exports</li>
                  </ul>
                  <div className="xfer-actions">
                    <button className="btn primary" disabled={busy} onClick={exportBag}>
                      Export .rivetbag
                    </button>
                    <button className="btn" disabled={busy || !bagPath} onClick={revealExport}>
                      Reveal last
                    </button>
                  </div>
                  {bagPath && (
                    <div className="xfer-path" title={bagPath}>
                      <span>Last export</span>
                      <code>{bagPath}</code>
                    </div>
                  )}
                </section>

                <section className="xfer-card import">
                  <div className="xfer-card-top">
                    <span className="xfer-glyph" aria-hidden>
                      ⇩
                    </span>
                    <div>
                      <h3>Import</h3>
                      <p>Merge a package into this Rivet store.</p>
                    </div>
                  </div>
                  <div className="xfer-drop">
                    <input
                      className="path-input"
                      placeholder="/absolute/path/to/file.rivetbag"
                      value={importPath}
                      onChange={(e) => setImportPath(e.target.value)}
                    />
                    <div className="xfer-actions">
                      <button className="btn" disabled={busy} onClick={pickImport}>
                        Choose file
                      </button>
                      <button
                        className="btn primary"
                        disabled={busy || !importPath.trim()}
                        onClick={importBag}
                      >
                        Import
                      </button>
                    </div>
                  </div>
                </section>
              </div>

              {bagNote && (
                <div className="xfer-toast" role="status">
                  <span className="xfer-toast-dot" />
                  {bagNote}
                </div>
              )}

              <aside className="xfer-note">
                Captured prompt/completion text can still hold secrets. Redaction is pattern
                matching — treat bags as sensitive.
              </aside>
            </div>
          )}
        </div>
      </div>

      <footer className="statusbar" aria-label="Server status">
        <div className="sb-group">
          <button
            type="button"
            className={`sb-sync${syncing ? " spinning" : ""}`}
            disabled={syncing}
            onClick={() => {
              void (async () => {
                setSyncing(true);
                try {
                  await refresh();
                } finally {
                  setSyncing(false);
                }
              })();
            }}
            title="Sync status"
            aria-label="Sync status"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
              />
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 3v5h-5"
              />
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
              />
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H3v5"
              />
            </svg>
          </button>
          <span className="sb-counts" title="Accounts · events · wiki pages · embeddings">
            <span>{counts.all} acct{counts.all === 1 ? "" : "s"}</span>
            <span>{fmt(status?.usage.events ?? 0)} events</span>
            <span>{status?.workers?.wiki_pages ?? 0} wiki</span>
            <span>{status?.workers?.embeddings ?? 0} vec</span>
          </span>
          <button
            type="button"
            className="sb-pill"
            title={apiOnline ? "rivetd control plane reachable" : "rivetd unreachable"}
            onClick={() => setPage("runtime")}
          >
            <span className={`sb-dot ${apiOnline ? "on" : "off"}`} />
            rivetd {apiOnline ? "online" : "offline"}
          </button>
          <button
            type="button"
            className="sb-pill"
            title={status?.proxy_base_url ?? "Proxy"}
            onClick={() => setPage("runtime")}
          >
            <span className={`sb-dot ${status?.proxy_running ? "on" : "off"}`} />
            proxy {status?.proxy_running ? "live" : "stopped"}
            {status?.proxy_base_url ? (
              <span className="sb-muted">{status.proxy_base_url.replace("http://", "")}</span>
            ) : null}
          </button>
          <span className="sb-pill static" title="Traffic store backend">
            <span className={`sb-dot ${status?.traffic_backend?.includes("clickhouse") ? "on" : "idle"}`} />
            {status?.traffic_backend ?? "sqlite"}
          </span>
        </div>

        {(statusAction || error) && (
          <div className="sb-meta">
            {statusAction ? (
              <span className="sb-action">{statusAction}</span>
            ) : (
              <button type="button" className="sb-action bad" onClick={() => setError(null)} title={error!}>
                {trunc(error!, 64)}
              </button>
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
