import type { QuotaAccountUx } from "../quota";
import {
  currentQuota,
  currentQuotaHistory,
  currentStatus,
  getStore,
  rebuildDerivedQuota,
  type MockStore,
} from "./store";

export type MockHttpResult = {
  status: number;
  body: string;
  content_type: string;
};

function ok(data: unknown, status = 200): MockHttpResult {
  return {
    status,
    body: typeof data === "string" ? data : JSON.stringify(data),
    content_type: typeof data === "string" ? "text/plain" : "application/json",
  };
}

function err(message: string, status = 400): MockHttpResult {
  return ok({ error: message }, status);
}

function parseBody(raw: string | null | undefined): unknown {
  if (raw == null || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function pathOnly(path: string): string {
  return path.split("?")[0] ?? path;
}

function query(path: string): URLSearchParams {
  const i = path.indexOf("?");
  return new URLSearchParams(i >= 0 ? path.slice(i + 1) : "");
}

function delayLoginComplete(s: MockStore, provider: string) {
  if (s.loginTimer) clearTimeout(s.loginTimer);
  s.loginTimer = setTimeout(() => {
    if (!s.login?.active) return;
    const id = `${provider}-mock-${Date.now().toString(36)}`;
    const account: QuotaAccountUx = {
      id,
      provider,
      label: `${provider}@mock.local`,
      email: `${provider}@mock.local`,
      plan: provider === "claude" ? "Claude Pro" : provider === "codex" ? "ChatGPT Plus" : "Mock",
      remaining_pct: 100,
      reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
      cooldown_seconds: null,
      supports_quota: true,
      loaded: true,
      status: "loaded",
      windows: [
        {
          id: "primary",
          label: "Primary",
          remaining_pct: 100,
          reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
        },
      ],
    };
    s.quotaAccounts.push(account);
    rebuildDerivedQuota();
    s.login = {
      active: true,
      provider,
      output: `${s.login.output}\n\nLogin complete — credential ${id} stored (mock).`,
      done: true,
      success: true,
    };
    s.loginTimer = null;
  }, 1800);
}

export async function handleApiRequest(
  method: string,
  path: string,
  body: string | null,
): Promise<MockHttpResult> {
  const s = getStore();
  const m = method.toUpperCase();
  const base = pathOnly(path);
  const q = query(path);
  const payload = parseBody(body);

  // Status / catalog
  if (m === "GET" && base === "/v1/status") return ok(currentStatus(s));
  if (m === "GET" && base === "/v1/live") {
    return ok({
      wiki_revision: s.wiki?.revision ?? 0,
      traffic_events: s.traffic.length,
      observed_at: new Date().toISOString(),
    });
  }
  if (m === "GET" && base === "/v1/providers") return ok({ providers: s.providers });
  if (m === "GET" && base === "/v1/accounts") return ok(s.accounts);

  // Quota
  if (m === "GET" && base === "/v1/quota") return ok(currentQuota(s));
  if (m === "GET" && base === "/v1/quota/history") {
    const hours = Number(q.get("hours") ?? "3") || 3;
    return ok(currentQuotaHistory(s, hours));
  }
  if (m === "POST" && base === "/v1/quota/refresh") {
    // Nudge remaining slightly so UI refresh feels live.
    for (const a of s.quotaAccounts) {
      if (a.remaining_pct != null) {
        a.remaining_pct = Math.max(0, Math.min(100, a.remaining_pct + (Math.random() * 2 - 0.5)));
      }
      for (const w of a.windows ?? []) {
        if (w.remaining_pct != null) {
          w.remaining_pct = Math.max(0, Math.min(100, w.remaining_pct + (Math.random() * 2 - 0.5)));
        }
      }
    }
    rebuildDerivedQuota();
    return ok({ ok: true, refresh: { mock: true }, quota: currentQuota(s) });
  }

  // Traffic / conversations
  if (m === "GET" && base === "/v1/traffic/recent") {
    const limit = Number(q.get("limit") ?? "200") || 200;
    return ok(s.traffic.slice(0, limit));
  }
  if (m === "GET" && base === "/v1/traffic/search") {
    const needle = (q.get("q") ?? "").trim().toLowerCase();
    const limit = Number(q.get("limit") ?? "100") || 100;
    if (!needle) return ok(s.traffic.slice(0, limit));
    const hits = s.traffic.filter((ev) => {
      const hay =
        `${ev.content ?? ""} ${ev.model ?? ""} ${ev.account_label ?? ""} ${ev.provider} ${ev.session_id ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
    return ok(hits.slice(0, limit));
  }
  if (m === "GET" && base === "/v1/conversations") {
    const { conversationsFromEvents } = await import("../lib/conversation-utils");
    const limit = Number(q.get("limit") ?? "100") || 100;
    return ok(conversationsFromEvents(s.traffic, limit));
  }
  if (m === "GET" && base === "/v1/conversations/events") {
    const { conversationIdFor } = await import("../lib/conversation-utils");
    const id = (q.get("id") ?? "").trim();
    const limit = Number(q.get("limit") ?? "500") || 500;
    if (!id) return ok([]);
    const hits = s.traffic
      .filter((ev) => conversationIdFor(ev) === id)
      .slice()
      .sort((a, b) => +new Date(a.ts) - +new Date(b.ts))
      .slice(0, limit);
    return ok(hits);
  }
  if (m === "GET" && base === "/v1/conversations/search") {
    const { conversationsFromEvents } = await import("../lib/conversation-utils");
    const needle = (q.get("q") ?? "").trim().toLowerCase();
    const limit = Number(q.get("limit") ?? "100") || 100;
    const mode = (q.get("mode") ?? "keyword").toLowerCase();
    if (!needle) {
      return ok({ mode: "list", results: conversationsFromEvents(s.traffic, limit) });
    }
    const hits = s.traffic.filter((ev) => {
      const hay =
        `${ev.content ?? ""} ${ev.model ?? ""} ${ev.account_label ?? ""} ${ev.provider} ${ev.session_id ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
    const used = mode === "vector" ? "vector" : "keyword";
    // Mock has no real embeddings — keyword match labeled by requested mode.
    return ok({
      mode: used === "vector" ? "vector" : "keyword",
      results: conversationsFromEvents(hits, limit),
    });
  }
  if (m === "POST" && base === "/v1/demo/seed") {
    if (s.traffic.length === 0) {
      const { seedTraffic } = await import("./fixtures");
      s.traffic = seedTraffic("default");
    } else {
      s.traffic = [
        {
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          provider: "claude",
          model: "claude-sonnet-4-5",
          role: "assistant",
          content: "Freshly seeded mock event",
          tokens_in: 320,
          tokens_out: 140,
          status_code: 200,
          account_label: s.accounts[0]?.label ?? "mock",
          latency_ms: 512,
        },
        ...s.traffic,
      ];
    }
    return ok({ note: "Mock demo seed", inserted: 1, force: false });
  }

  // Proxy
  if (m === "POST" && base === "/v1/proxy/start") {
    s.proxyRunning = true;
    return ok({ ok: true });
  }
  if (m === "POST" && base === "/v1/proxy/stop") {
    s.proxyRunning = false;
    return ok({ ok: true });
  }
  if (m === "POST" && base === "/v1/proxy/restart") {
    s.proxyRunning = true;
    return ok({ ok: true });
  }

  // Accounts login
  if (m === "POST" && base === "/v1/accounts/login") {
    const bodyObj = (payload ?? {}) as { provider?: string; method?: string };
    const provider = bodyObj.provider ?? "claude";
    const method = bodyObj.method ?? "browser";
    const url = `https://mock.rivet.local/oauth/${provider}?method=${method}`;
    s.login = {
      active: true,
      provider,
      output: `Starting ${provider} login (${method})…\nOpen: ${url}\nWaiting for callback…`,
      done: false,
      success: false,
    };
    delayLoginComplete(s, provider);
    return ok({ message: s.login.output, url });
  }
  if (m === "GET" && base === "/v1/accounts/login/status") {
    return ok(
      s.login ?? {
        active: false,
        provider: null,
        output: "",
        done: false,
        success: false,
      },
    );
  }
  if (m === "POST" && base === "/v1/accounts/login/cancel") {
    if (s.loginTimer) clearTimeout(s.loginTimer);
    s.loginTimer = null;
    s.login = {
      active: false,
      provider: s.login?.provider ?? null,
      output: `${s.login?.output ?? ""}\nCancelled.`,
      done: true,
      success: false,
    };
    return ok({ ok: true });
  }
  if (m === "POST" && base === "/v1/accounts/import/vertex") {
    const bodyObj = (payload ?? {}) as { path?: string };
    const path = bodyObj.path ?? "/mock/vertex.json";
    s.login = {
      active: true,
      provider: "vertex",
      output: `Importing Vertex SA from ${path}…`,
      done: false,
      success: false,
    };
    delayLoginComplete(s, "vertex");
    return ok({ message: s.login.output });
  }
  if (m === "DELETE" && base.startsWith("/v1/accounts/")) {
    const id = decodeURIComponent(base.slice("/v1/accounts/".length));
    s.quotaAccounts = s.quotaAccounts.filter((a) => a.id !== id);
    rebuildDerivedQuota();
    return ok({ ok: true });
  }

  // Config / workers
  if (m === "PUT" && base === "/v1/config") {
    const bodyObj = (payload ?? {}) as {
      embedding_model?: string | null;
      wiki_model?: string | null;
      capabilities?: { vector_search?: boolean; wiki?: boolean };
    };
    if (bodyObj.embedding_model !== undefined) {
      s.embedModel = bodyObj.embedding_model?.trim() ? bodyObj.embedding_model : "";
    }
    if (bodyObj.wiki_model !== undefined) {
      s.wikiModel = bodyObj.wiki_model?.trim() ? bodyObj.wiki_model : null;
    }
    if (bodyObj.capabilities?.vector_search != null) {
      s.vectorEnabled = bodyObj.capabilities.vector_search;
    }
    if (bodyObj.capabilities?.wiki != null) {
      s.wikiEnabled = bodyObj.capabilities.wiki;
    }
    return ok({ ok: true });
  }
  if (m === "POST" && base === "/v1/workers/tick") {
    return ok({
      embeddings: Math.min(s.traffic.length, 12),
      wiki_pages: s.wiki.pages.length,
    });
  }

  // Wiki
  if (m === "GET" && base === "/v1/wiki") return ok(s.wiki);
  if (m === "GET" && base === "/v1/wiki/page") {
    const id = q.get("id") ?? "";
    const bodyText = s.wikiBodies[id] ?? `# Missing\n\nNo mock body for \`${id}\`.\n`;
    return ok({ id, markdown: bodyText, content: bodyText });
  }

  // Harness
  if (m === "GET" && base === "/v1/harness/claude.env") {
    return ok(
      `# Mock Claude Code env\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:18317\nexport ANTHROPIC_API_KEY=mock-key\n`,
    );
  }
  if (m === "GET" && base === "/v1/harness/codex.toml") {
    return ok(
      `# Mock Codex config\nmodel_provider = "rivet"\n\n[model_providers.rivet]\nbase_url = "http://127.0.0.1:18317/v1"\n`,
    );
  }
  if (m === "GET" && base === "/v1/harness/mcp.json") {
    return ok({
      mcpServers: {
        rivet: { url: "http://127.0.0.1:8741/mcp" },
      },
    });
  }
  if (m === "POST" && base === "/v1/harness/write") {
    const bodyObj = (payload ?? {}) as { target?: string; mode?: string };
    const target = bodyObj.target ?? "claude";
    const mode = bodyObj.mode ?? "user";
    return ok({
      target,
      path:
        mode === "isolated"
          ? `/mock/Rivet/harness/${target}`
          : target === "claude"
            ? "/mock/home/.claude"
            : "/mock/home/.codex",
      env_hint: mode === "isolated" ? `export CLAUDE_CONFIG_DIR=...` : "User overlay installed",
      note: `Mock harness write (${mode}) for ${target}`,
      backup_path: `/mock/backups/${target}-${Date.now()}.bak`,
      mode,
    });
  }

  // Export / import
  if (m === "POST" && base === "/v1/export") {
    const path = `/mock/Rivet/exports/rivet-${Date.now()}.rivetbag`;
    s.lastExportPath = path;
    return ok({
      path,
      event_count: s.traffic.length,
      note: "Mock export package",
      schema_version: 1,
    });
  }
  if (m === "POST" && base === "/v1/import") {
    const bodyObj = (payload ?? {}) as { path?: string };
    const path = bodyObj.path ?? "/mock/import.rivetbag";
    const inserted = 5;
    for (let i = 0; i < inserted; i++) {
      s.traffic.unshift({
        id: crypto.randomUUID(),
        ts: new Date(Date.now() - i * 1000).toISOString(),
        provider: "codex",
        model: "gpt-5",
        role: "user",
        content: `Imported mock event from ${path} (#${i + 1})`,
        tokens_in: 100,
        tokens_out: 40,
        status_code: 200,
        account_label: "import@mock",
        latency_ms: 300,
      });
    }
    return ok({
      path,
      event_count: inserted,
      note: "Mock import",
      schema_version: 1,
    });
  }
  if (m === "POST" && base === "/v1/ingest/local") {
    const inserted = 3;
    for (let i = 0; i < inserted; i++) {
      s.traffic.unshift({
        id: crypto.randomUUID(),
        ts: new Date(Date.now() - i * 1000).toISOString(),
        provider: i % 2 === 0 ? "claude" : "codex",
        model: i % 2 === 0 ? "claude-sonnet-4-5" : "gpt-5",
        role: "assistant",
        content: `Mock local harness ingest (#${i + 1})`,
        tokens_in: 200,
        tokens_out: 80,
        status_code: 200,
        session_id: `mock-session-${i}`,
        project_id: "/mock/project",
        account_label: "local@mock",
        latency_ms: 250,
      });
    }
    return ok({
      dry_run: false,
      files_scanned: 2,
      events_parsed: inserted,
      events_inserted: inserted,
      events_skipped_existing: 0,
      sources: [
        {
          source: "claude",
          root: "/mock/home/.claude/projects",
          files_scanned: 1,
          events_parsed: 2,
        },
        {
          source: "codex",
          root: "/mock/home/.codex/sessions",
          files_scanned: 1,
          events_parsed: 1,
        },
        {
          source: "cursor",
          root: "/mock/home/.cursor/projects",
          files_scanned: 0,
          events_parsed: 0,
        },
      ],
    });
  }

  // Logs
  if (m === "GET" && base === "/v1/logs/proxy") {
    return ok({
      text: [
        "[mock] rivet-proxy listening on :18317",
        `[mock] proxy_running=${s.proxyRunning}`,
        "[mock] accounts loaded: " + s.accounts.length,
        s.scenario === "limit-hit" ? "[mock] WARN quota empty — returning 429" : "[mock] healthy",
      ].join("\n"),
    });
  }
  if (m === "GET" && base === "/v1/logs/clickhouse") {
    return ok({
      text: [
        "[mock] ClickHouse HTTP :8123",
        "[mock] database rivet ready",
        `[mock] traffic_events rows≈${s.traffic.length}`,
      ].join("\n"),
    });
  }

  return err(`mock IPC: unhandled ${m} ${base}`, 404);
}
