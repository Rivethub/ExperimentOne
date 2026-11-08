import { useCallback, useEffect, useMemo, useState } from "react";

type Page =
  | "quota"
  | "traffic"
  | "runtime"
  | "accounts"
  | "harness"
  | "export"
  | "wiki"
  | "intelligence";

type MetricMode = "remaining" | "drain" | "burn";

type Onboarding = {
  proxy_running: boolean;
  has_accounts: boolean;
  has_traffic: boolean;
  harness_ready: boolean;
};

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
  onboarding?: Onboarding;
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

type WikiPage = {
  id: string;
  project_id: string;
  title: string;
  path: string;
  updated_at: string;
};

type WikiInfo = {
  path: string;
  project_id: string;
  pages: WikiPage[];
};

type ProviderFilter = "all" | "claude" | "codex";

const API = "http://127.0.0.1:8741";

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: "quota", label: "Quota", icon: "◈" },
  { id: "traffic", label: "Traffic", icon: "◫" },
  { id: "runtime", label: "Runtime", icon: "⏻" },
  { id: "accounts", label: "Accounts", icon: "◎" },
  { id: "harness", label: "Harness", icon: "⎇" },
  { id: "wiki", label: "Wiki", icon: "☰" },
  { id: "intelligence", label: "Intelligence", icon: "✦" },
  { id: "export", label: "Export", icon: "⇪" },
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
  const s = String(p).toLowerCase();
  if (s.includes("claude") || s === "anthropic") return "claude";
  if (s.includes("codex") || s.includes("openai") || s === "open_ai") return "codex";
  return s;
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

/** Build chart series from real local traffic for the selected metric. */
function seriesFromEvents(
  events: TrafficEvent[],
  provider: "claude" | "codex",
  horizon: "1h" | "3h" | "6h",
  mode: MetricMode,
  points = 24,
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
  const burnPerHour = hours > 0 ? totalTokens / hours : totalTokens;
  // Soft pool assumption for remaining % until live provider quota APIs exist.
  const assumedPool = Math.max(80_000, totalTokens * 2.2 + 40_000);

  let remainingCursor = 100;
  const remaining: number[] = [];
  const burnSeries: number[] = [];
  const drainSeries: number[] = [];
  let prevRemaining = 100;

  for (let i = 0; i < points; i++) {
    const burn = tokensPerBucket[i];
    burnSeries.push(burn);
    remainingCursor = Math.max(
      0,
      Number((remainingCursor - (burn / assumedPool) * 100).toFixed(2)),
    );
    remaining.push(remainingCursor);
    drainSeries.push(Number(Math.max(0, prevRemaining - remainingCursor).toFixed(2)));
    prevRemaining = remainingCursor;
  }

  const maxBurn = Math.max(1, ...burnSeries);
  const normalize = (vals: number[], max: number) =>
    vals.map((v) => Number(((v / max) * 100).toFixed(1)));

  let recorded: number[];
  let headline: number;
  let headlineUnit: string;

  if (mode === "burn") {
    recorded = normalize(burnSeries, maxBurn);
    headline = Math.round(burnPerHour);
    headlineUnit = "tok/h";
  } else if (mode === "drain") {
    const maxDrain = Math.max(1, ...drainSeries);
    recorded = normalize(drainSeries, maxDrain);
    headline = Number(drainSeries.reduce((a, b) => a + b, 0).toFixed(1));
    headlineUnit = "% pts";
  } else {
    recorded = remaining;
    headline = Number((remaining.at(-1) ?? 100).toFixed(0));
    headlineUnit = "% left";
  }

  const last = recorded[recorded.length - 1] ?? 40;
  const projected = recorded.map((_, i) => {
    if (i < points - 6) return recorded[i];
    const t = (i - (points - 6)) / 6;
    if (mode === "remaining") {
      return Math.max(0, Number((last * (1 - t * 0.55)).toFixed(1)));
    }
    return Math.max(0, Number((last * (1 - t * 0.25)).toFixed(1)));
  });

  let emptyAt = "—";
  if (mode === "remaining" && burnPerHour > 0) {
    const leftTokens = (assumedPool * (remaining.at(-1) ?? 0)) / 100;
    const hoursLeft = leftTokens / burnPerHour;
    if (hoursLeft < 1) emptyAt = `~${Math.round(hoursLeft * 60)}m`;
    else emptyAt = `~${hoursLeft.toFixed(1)}h`;
  } else if (filtered.length === 0) {
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

function QuotaChart({
  recorded,
  projected,
  color,
}: {
  recorded: number[];
  projected: number[];
  color: string;
}) {
  const w = 640;
  const h = 160;
  const pad = 8;
  const nowIdx = Math.floor(recorded.length * 0.72);

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
        <path
          d={toPath(projected, nowIdx, projected.length - 1)}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeDasharray="5 5"
          strokeLinecap="round"
          opacity="0.85"
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
          x={nowX + 4}
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
          <i className="swatch" /> Recorded
        </span>
        <span>
          <i className="swatch dashed" /> Projected
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

export default function App() {
  const [page, setPage] = useState<Page>("quota");
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [horizon, setHorizon] = useState<"1h" | "3h" | "6h">("3h");
  const [metricMode, setMetricMode] = useState<MetricMode>("remaining");
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
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
  const [error, setError] = useState<string | null>(null);
  const [tosAck, setTosAck] = useState(false);
  const [bagNote, setBagNote] = useState<string | null>(null);
  const [importPath, setImportPath] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [wikiModel, setWikiModel] = useState("");
  const [wiki, setWiki] = useState<WikiInfo | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TrafficEvent | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [statusRes, accountsRes, recentRes] = await Promise.all([
        fetch(`${API}/v1/status`),
        fetch(`${API}/v1/accounts`),
        fetch(`${API}/v1/traffic/recent?limit=200`),
      ]);
      if (!statusRes.ok) throw new Error(`status ${statusRes.status}`);
      const st: Status = await statusRes.json();
      setStatus(st);
      setEmbedModel(st.embedding_model ?? "");
      setWikiModel(st.wiki_model ?? "");
      if (accountsRes.ok) setAccounts(await accountsRes.json());
      if (recentRes.ok) {
        const rows: TrafficEvent[] = await recentRes.json();
        setRecent(rows);
        if (!trafficQuery.trim()) setTrafficRows(rows);
      }
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach rivetd — start it with cargo run -p rivet-runtime",
      );
    }
  }, [trafficQuery]);

  const refreshLogin = useCallback(async () => {
    try {
      const res = await fetch(`${API}/v1/accounts/login/status`);
      if (!res.ok) return;
      const body: LoginStatus = await res.json();
      setLogin(body.active || body.output ? body : null);
      if (body.done && body.success) refresh();
    } catch {
      /* rivetd down */
    }
  }, [refresh]);

  const refreshWiki = useCallback(async () => {
    try {
      const res = await fetch(`${API}/v1/wiki`);
      if (res.ok) setWiki(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await invokeTauri("ensure_rivetd");
      await refresh();
      await refreshWiki();
    })();
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

  const counts = useMemo(() => {
    const claude = accounts.filter((a) => providerKey(a.provider) === "claude").length;
    const codex = accounts.filter((a) => providerKey(a.provider) === "codex").length;
    return { all: accounts.length, claude, codex };
  }, [accounts]);

  const claudeSeries = useMemo(
    () => seriesFromEvents(recent, "claude", horizon, metricMode),
    [recent, horizon, metricMode],
  );
  const codexSeries = useMemo(
    () => seriesFromEvents(recent, "codex", horizon, metricMode),
    [recent, horizon, metricMode],
  );

  async function proxyAction(path: "start" | "stop") {
    setBusy(true);
    try {
      const res = await fetch(`${API}/v1/proxy/${path}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `proxy ${path} failed`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadClaude() {
    const res = await fetch(`${API}/v1/harness/claude.env`);
    setSnippet(await res.text());
    setHarnessNote(null);
  }

  async function loadCodex() {
    const res = await fetch(`${API}/v1/harness/codex.toml`);
    setSnippet(await res.text());
    setHarnessNote(null);
  }

  async function loadMcp() {
    const res = await fetch(`${API}/v1/harness/mcp.json`);
    setSnippet(await res.text());
    setHarnessNote(null);
  }

  async function writeHarness(target: "claude" | "codex") {
    setBusy(true);
    try {
      const res = await fetch(`${API}/v1/harness/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "write failed");
      setHarnessNote(body);
      setSnippet(
        target === "claude"
          ? await (await fetch(`${API}/v1/harness/claude.env`)).text()
          : await (await fetch(`${API}/v1/harness/codex.toml`)).text(),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startLogin(provider: "claude" | "codex") {
    setBusy(true);
    try {
      const res = await fetch(`${API}/v1/accounts/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      setPage("accounts");
      await refreshLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelLogin() {
    await fetch(`${API}/v1/accounts/login/cancel`, { method: "POST" });
    await refreshLogin();
  }

  async function removeAccount(id: string) {
    if (!confirm(`Remove account “${id}”? This deletes the local credential file.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/v1/accounts/${encodeURIComponent(id)}`, {
        method: "DELETE",
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
      const res = await fetch(`${API}/v1/export`, { method: "POST" });
      const body: BagResult & { error?: string } = await res.json();
      if (!res.ok) throw new Error(body.error ?? "export failed");
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
      const res = await fetch(`${API}/v1/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const q = encodeURIComponent(trafficQuery.trim());
      const res = await fetch(`${API}/v1/traffic/search?limit=100&q=${q}`);
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
      const res = await fetch(`${API}/v1/demo/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    accounts: "Accounts",
    harness: "Harness",
    wiki: "Wiki",
    intelligence: "Intelligence",
    export: "Export / import",
  };
  const title = titleMap[page];

  const subtitle =
    page === "quota"
      ? `${status?.account_count ?? accounts.length} credentials · proxy ${status?.proxy_running ? "running" : "stopped"}`
      : page === "traffic"
        ? `${fmt(status?.usage.events ?? recent.length)} captured events`
        : page === "runtime"
          ? status?.proxy_base_url ?? "rivetd control plane"
          : page === "accounts"
            ? "OAuth stays local — never exported"
            : page === "harness"
              ? "Isolated config dirs for Claude Code / Codex"
              : page === "wiki"
                ? wiki?.path ?? status?.wiki_dir ?? "Project markdown tree"
                : page === "intelligence"
                  ? "Vectors + wiki workers (optional)"
                  : "Traffic packages only — no secrets";

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
    const match = bagNote?.match(/→\s+(\/\S+\.rivetbag)/);
    const path = match?.[1];
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
      const res = await fetch(`${API}/v1/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
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
      const res = await fetch(`${API}/v1/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
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
    try {
      const res = await fetch(`${API}/v1/workers/tick`, { method: "POST" });
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
    }
  }

  async function loadLogs() {
    try {
      const [proxyRes, chRes] = await Promise.all([
        fetch(`${API}/v1/logs/proxy?lines=80`),
        fetch(`${API}/v1/logs/clickhouse?lines=80`),
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

  const showClaude = filter === "all" || filter === "claude";
  const showCodex = filter === "all" || filter === "codex";
  const onboard = status?.onboarding;
  const needsOnboarding =
    !!status &&
    (!onboard?.proxy_running || !onboard?.has_accounts || !onboard?.harness_ready);

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
            {item.id === "accounts" && (
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
              <button className="btn primary" disabled={busy} onClick={() => setPage("accounts")}>
                Manage credentials
              </button>
            )}
            {page === "wiki" && (
              <button className="btn primary" onClick={openWiki}>
                Open wiki
              </button>
            )}
            {page === "runtime" && (
              <>
                <button
                  className="btn primary"
                  disabled={busy || !!status?.proxy_running}
                  onClick={() => proxyAction("start")}
                >
                  Start proxy
                </button>
                <button
                  className="btn danger"
                  disabled={busy || !status?.proxy_running}
                  onClick={() => proxyAction("stop")}
                >
                  Stop proxy
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

        {needsOnboarding && (page === "quota" || page === "runtime" || page === "accounts") && (
          <div className="onboard">
            <div>
              <strong>First-run checklist</strong>
              <ol className="onboard-steps">
                <li className={onboard?.proxy_running ? "done" : ""}>
                  Start proxy {onboard?.proxy_running ? "✓" : ""}
                </li>
                <li className={onboard?.has_accounts ? "done" : ""}>
                  Sign in Claude or Codex {onboard?.has_accounts ? "✓" : ""}
                </li>
                <li className={onboard?.harness_ready ? "done" : ""}>
                  Write harness config {onboard?.harness_ready ? "✓" : ""}
                </li>
                <li className={onboard?.has_traffic ? "done" : ""}>
                  Capture traffic {onboard?.has_traffic ? "✓" : ""}
                </li>
              </ol>
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button
                className="btn primary"
                disabled={busy || !!onboard?.proxy_running}
                onClick={() => proxyAction("start")}
              >
                Start proxy
              </button>
              <button className="btn" disabled={busy} onClick={() => setPage("accounts")}>
                Sign in
              </button>
              <button className="btn" disabled={busy} onClick={() => setPage("harness")}>
                Harness
              </button>
              <button className="btn" disabled={busy} onClick={seedDemo}>
                Load demo traffic
              </button>
            </div>
          </div>
        )}

        <div className="content">
          {page === "quota" && (
            <>
              <div className="filters">
                {(
                  [
                    ["all", "All", counts.all],
                    ["claude", "Claude", counts.claude],
                    ["codex", "Codex", counts.codex],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    className={`chip ${filter === id ? "active" : ""}`}
                    onClick={() => setFilter(id)}
                  >
                    {id !== "all" && (
                      <span
                        className="dot"
                        style={{
                          background: id === "claude" ? "var(--claude)" : "var(--codex)",
                        }}
                      />
                    )}
                    {label}
                    <span className="count">{count}</span>
                  </button>
                ))}
              </div>

              <div className="toolbar">
                <div className="seg">
                  {(
                    [
                      ["remaining", "Remaining"],
                      ["drain", "Drain rate"],
                      ["burn", "Burn rate"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={metricMode === id ? "active" : ""}
                      onClick={() => setMetricMode(id)}
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
                <span className="empty">
                  Local capture · {horizon} window · estimates until live quota APIs
                </span>
              </div>

              <div className="metric-grid">
                <div className="metric">
                  <div className="label">Proxy</div>
                  <div className="value">
                    <span
                      className={`status-dot ${status?.proxy_running ? "on" : "off"}`}
                    />
                    {status?.proxy_running ? "Live" : "Down"}
                  </div>
                  <div className="hint">{status?.proxy_base_url ?? "—"}</div>
                </div>
                <div className="metric">
                  <div className="label">Events</div>
                  <div className="value">{fmt(status?.usage.events ?? 0)}</div>
                  <div className="hint">{status?.traffic_backend ?? "sqlite"}</div>
                </div>
                <div className="metric">
                  <div className="label">Tokens in</div>
                  <div className="value">{fmt(status?.usage.tokens_in ?? 0)}</div>
                  <div className="hint">captured via rivetsink</div>
                </div>
                <div className="metric">
                  <div className="label">Tokens out</div>
                  <div className="value">{fmt(status?.usage.tokens_out ?? 0)}</div>
                  <div className="hint">
                    MCP {status?.capabilities.mcp ? "on" : "off"}
                  </div>
                </div>
              </div>

              <div className="stack">
                {showClaude && (
                  <section className="card">
                    <div className="card-head">
                      <div className="card-title">
                        <div className="provider-ico claude">C</div>
                        <div>
                          <h2>Claude</h2>
                          <div className="meta">
                            {counts.claude} account{counts.claude === 1 ? "" : "s"} · local{" "}
                            {metricMode}
                          </div>
                        </div>
                      </div>
                      <div className="pool-stat">
                        <div className="big claude">
                          {claudeSeries.headline}
                          <span className="unit">{claudeSeries.headlineUnit}</span>
                        </div>
                        <div className="cap">from captured traffic</div>
                      </div>
                    </div>
                    <div className="stat-row">
                      <div className="item">
                        <div className="k">Pool empty</div>
                        <div className="v">{claudeSeries.emptyAt}</div>
                      </div>
                      <div className="item">
                        <div className="k">Traffic events</div>
                        <div className="v">{claudeSeries.eventsInWindow} in {horizon}</div>
                      </div>
                      <div className="item">
                        <div className="k">Burn</div>
                        <div className="v">{claudeSeries.burnLabel}</div>
                      </div>
                      <div className="item">
                        <div className="k">Source</div>
                        <div className="v">local rivetsink</div>
                      </div>
                    </div>
                    <QuotaChart
                      recorded={claudeSeries.recorded}
                      projected={claudeSeries.projected}
                      color="#f97316"
                    />
                  </section>
                )}

                {showCodex && (
                  <section className="card">
                    <div className="card-head">
                      <div className="card-title">
                        <div className="provider-ico codex">X</div>
                        <div>
                          <h2>Codex</h2>
                          <div className="meta">
                            {counts.codex} account{counts.codex === 1 ? "" : "s"} · local{" "}
                            {metricMode}
                          </div>
                        </div>
                      </div>
                      <div className="pool-stat">
                        <div className="big codex">
                          {codexSeries.headline}
                          <span className="unit">{codexSeries.headlineUnit}</span>
                        </div>
                        <div className="cap">from captured traffic</div>
                      </div>
                    </div>
                    <div className="stat-row">
                      <div className="item">
                        <div className="k">Pool empty</div>
                        <div className="v">{codexSeries.emptyAt}</div>
                      </div>
                      <div className="item">
                        <div className="k">Traffic events</div>
                        <div className="v">{codexSeries.eventsInWindow} in {horizon}</div>
                      </div>
                      <div className="item">
                        <div className="k">Burn</div>
                        <div className="v">{codexSeries.burnLabel}</div>
                      </div>
                      <div className="item">
                        <div className="k">Source</div>
                        <div className="v">local rivetsink</div>
                      </div>
                    </div>
                    <QuotaChart
                      recorded={codexSeries.recorded}
                      projected={codexSeries.projected}
                      color="#60a5fa"
                    />
                  </section>
                )}
              </div>
            </>
          )}

          {page === "traffic" && (
            <section className="panel-block">
              <h2>Captured requests</h2>
              <p className="lede">
                Search local traffic history. Bodies are redacted for obvious secrets before
                store and export.
              </p>
              <div className="filters" style={{ marginBottom: 10 }}>
                {(
                  [
                    ["all", "All"],
                    ["claude", "Claude"],
                    ["codex", "Codex"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={`chip ${trafficProvider === id ? "active" : ""}`}
                    onClick={() => setTrafficProvider(id)}
                  >
                    {label}
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
              <div className="traffic-table">
                <div className="traffic-head">
                  <span>When</span>
                  <span>Provider</span>
                  <span>Model</span>
                  <span>Tokens</span>
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
                      <span>
                        <span
                          className={`pill ${providerKey(ev.provider) === "claude" ? "claude" : "codex"}`}
                        >
                          {providerKey(ev.provider)}
                        </span>
                        {ev.status_code != null && ev.status_code >= 400 && (
                          <span className="pill bad" style={{ marginLeft: 6 }}>
                            {ev.status_code}
                          </span>
                        )}
                      </span>
                      <span className="mono">{ev.model ?? "—"}</span>
                      <span className="mono">
                        {fmt(ev.tokens_in)}/{fmt(ev.tokens_out)}
                      </span>
                      <span className="preview">{trunc(ev.content, 80)}</span>
                    </button>
                  ))
                )}
              </div>
              {selectedEvent && (
                <div className="event-detail">
                  <div className="kv">
                    <div className="kv-row">
                      <span className="k">Status</span>
                      <span className="v">{selectedEvent.status_code ?? "—"}</span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Latency</span>
                      <span className="v">
                        {selectedEvent.latency_ms != null
                          ? `${selectedEvent.latency_ms} ms`
                          : "—"}
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Account</span>
                      <span className="v">{selectedEvent.account_label ?? "—"}</span>
                    </div>
                    <div className="kv-row">
                      <span className="k">Role</span>
                      <span className="v">{selectedEvent.role ?? "—"}</span>
                    </div>
                  </div>
                  <pre className="snippet">{selectedEvent.content || "(empty)"}</pre>
                </div>
              )}
            </section>
          )}

          {page === "runtime" && (
            <section className="panel-block">
              <h2>Control plane</h2>
              <p className="lede">
                rivetd supervises the Go proxy sidecar, ClickHouse (when bundled), ingest, and
                MCP on localhost.
              </p>
              <div className="kv">
                <div className="kv-row">
                  <span className="k">Proxy</span>
                  <span className="v">
                    <span
                      className={`status-dot ${status?.proxy_running ? "on" : "off"}`}
                    />
                    {status?.proxy_running ? "running" : "stopped"}
                  </span>
                </div>
                <div className="kv-row">
                  <span className="k">Base URL</span>
                  <span className="v">{status?.proxy_base_url ?? "—"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Access key</span>
                  <span className="v">{status?.access_key_hint ?? "—"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">MCP</span>
                  <span className="v">{status?.mcp_url ?? "—"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Store</span>
                  <span className="v">{status?.traffic_backend ?? "sqlite"}</span>
                </div>
              </div>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={busy || !!status?.proxy_running}
                  onClick={() => proxyAction("start")}
                >
                  Start proxy
                </button>
                <button
                  className="btn"
                  disabled={busy || !status?.proxy_running}
                  onClick={() => proxyAction("stop")}
                >
                  Stop proxy
                </button>
                <button
                  className="btn"
                  onClick={() => copyText(status?.proxy_base_url ?? "")}
                >
                  Copy base URL
                </button>
                <button className="btn" onClick={loadLogs}>
                  Refresh logs
                </button>
              </div>
              <h2 style={{ marginTop: 20 }}>Proxy log</h2>
              <pre className="snippet">{proxyLog || "No proxy log yet."}</pre>
              <h2 style={{ marginTop: 16 }}>ClickHouse log</h2>
              <pre className="snippet">{chLog || "No ClickHouse log yet."}</pre>
            </section>
          )}

          {page === "accounts" && (
            <section className="panel-block">
              <h2>Provider sign-in</h2>
              <p className="lede">
                Triggers rivet-proxy OAuth / device flows. Tokens stay under Application
                Support and are never included in `.rivetbag` exports.
              </p>
              <label className="tos">
                <input
                  type="checkbox"
                  checked={tosAck}
                  onChange={(e) => setTosAck(e.target.checked)}
                />
                <span>
                  I understand multi-account pooling may conflict with provider Terms of
                  Service. Rivet does not encourage reselling subscription traffic as a
                  public API.
                </span>
              </label>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={busy || !tosAck || !!login?.active}
                  onClick={() => startLogin("claude")}
                >
                  Sign in Claude
                </button>
                <button
                  className="btn"
                  disabled={busy || !tosAck || !!login?.active}
                  onClick={() => startLogin("codex")}
                >
                  Sign in Codex (device)
                </button>
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
                      {login.active
                        ? "in progress"
                        : login.success
                          ? "done"
                          : "ended"}
                    </span>
                  </div>
                  <pre className="snippet">
                    {login.output || "Waiting for proxy output…"}
                  </pre>
                </div>
              )}
            </section>
          )}

          {page === "harness" && (
            <section className="panel-block">
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
                    <button
                      className="btn"
                      onClick={() => copyText(harnessNote.env_hint)}
                    >
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

          {page === "wiki" && (
            <section className="panel-block">
              <h2>Project wiki</h2>
              <p className="lede">
                Markdown tree under Application Support. Workers refresh overview pages when
                the wiki capability is on.
              </p>
              <div className="kv">
                <div className="kv-row">
                  <span className="k">Path</span>
                  <span className="v">{wiki?.path ?? `${status?.wiki_dir ?? "—"}/default`}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Capability</span>
                  <span className="v">
                    {status?.capabilities.wiki ? "enabled" : "off (seed README only)"}
                  </span>
                </div>
                <div className="kv-row">
                  <span className="k">Pages</span>
                  <span className="v">{wiki?.pages.length ?? 0}</span>
                </div>
              </div>
              <div className="actions">
                <button className="btn primary" onClick={openWiki}>
                  Open wiki
                </button>
                <button
                  className="btn"
                  disabled={busy || !!status?.capabilities.wiki}
                  onClick={() => toggleCapability("wiki", true)}
                >
                  Enable wiki worker
                </button>
                <button className="btn" disabled={busy} onClick={runWorkers}>
                  Refresh wiki now
                </button>
              </div>
              {wiki && wiki.pages.length > 0 ? (
                <ul className="account-list">
                  {wiki.pages.map((p) => (
                    <li key={p.id}>
                      <div>
                        <strong>{p.title}</strong>
                        <div className="mono">{p.path}</div>
                      </div>
                      <div className="mono">{new Date(p.updated_at).toLocaleString()}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">
                  No indexed pages yet — enable the worker or open the folder to add
                  markdown.
                </p>
              )}
            </section>
          )}

          {page === "intelligence" && (
            <section className="panel-block">
              <h2>Workers</h2>
              <p className="lede">
                The vectorize worker embeds traffic for MCP semantic search (lexical locally,
                or via the proxy when an embedding model is set). The wiki worker writes a
                markdown tree from traffic; set a wiki model to also generate an LLM overview.
              </p>
              <div className="kv">
                <div className="kv-row">
                  <span className="k">Vector worker</span>
                  <span className="v">
                    {status?.workers?.vector_search || status?.capabilities.vector_search
                      ? "on"
                      : "off"}{" "}
                    · {fmt(status?.workers?.embeddings ?? 0)} embeddings
                  </span>
                </div>
                <div className="kv-row">
                  <span className="k">Wiki worker</span>
                  <span className="v">
                    {status?.workers?.wiki || status?.capabilities.wiki ? "on" : "off"} ·{" "}
                    {fmt(status?.workers?.wiki_pages ?? 0)} pages
                  </span>
                </div>
                <div className="kv-row">
                  <span className="k">Last vectorize</span>
                  <span className="v">{status?.workers?.vectorize_cursor ?? "—"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Last wiki</span>
                  <span className="v">{status?.workers?.wiki_cursor ?? "—"}</span>
                </div>
              </div>
              <div className="import-row" style={{ marginTop: 14 }}>
                <input
                  className="path-input"
                  placeholder="embedding model id (optional, e.g. text-embedding-3-small)"
                  value={embedModel}
                  onChange={(e) => setEmbedModel(e.target.value)}
                />
              </div>
              <div className="import-row">
                <input
                  className="path-input"
                  placeholder="wiki text-gen model id (optional, e.g. claude-sonnet-4-5)"
                  value={wikiModel}
                  onChange={(e) => setWikiModel(e.target.value)}
                />
              </div>
              <div className="actions">
                <button className="btn primary" disabled={busy} onClick={saveIntelligence}>
                  Save models
                </button>
                <button className="btn primary" disabled={busy} onClick={runWorkers}>
                  Run workers now
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    toggleCapability(
                      "vector_search",
                      !status?.capabilities.vector_search,
                    )
                  }
                >
                  Toggle vectors
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => toggleCapability("wiki", !status?.capabilities.wiki)}
                >
                  Toggle wiki
                </button>
              </div>
              <p className="note">
                Lexical embeddings work offline. Proxy models need the proxy running and a
                signed-in account. Toggling vectors updates MCP immediately — no restart.
              </p>
              {bagNote && <p className="note">{bagNote}</p>}
            </section>
          )}

          {page === "export" && (
            <section className="panel-block">
              <h2>Traffic packages</h2>
              <p className="lede">
                `.rivetbag` contains traffic only — never OAuth, API keys, or proxy secrets.
                Content is redacted for obvious credential patterns before store and export.
              </p>
              <div className="actions">
                <button className="btn primary" disabled={busy} onClick={exportBag}>
                  Export .rivetbag
                </button>
                <button className="btn" disabled={busy || !bagNote} onClick={revealExport}>
                  Reveal last export
                </button>
              </div>
              <div className="import-row">
                <input
                  className="path-input"
                  placeholder="/absolute/path/to/file.rivetbag"
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                />
                <button className="btn" disabled={busy} onClick={pickImport}>
                  Choose file
                </button>
                <button className="btn" disabled={busy} onClick={importBag}>
                  Import
                </button>
              </div>
              {bagNote && <p className="note">{bagNote}</p>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
