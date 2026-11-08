import { isDefined } from "../lib/nullish";
import {
  currentQuota,
  currentQuotaHistory,
  currentStatus,
  getStore,
  rebuildDerivedQuota,
} from "./store";
import { delayLoginComplete } from "./login";
import {
  err,
  ok,
  readNullableStringField,
  readOptionalBooleanField,
  readStringField,
  type MockHttpResult,
  type MockRequestContext,
} from "./http";

function nudgeQuotaPercents(): void {
  const store = getStore();
  for (const account of store.quotaAccounts) {
    if (isDefined(account.remaining_pct)) {
      account.remaining_pct = Math.max(
        0,
        Math.min(100, account.remaining_pct + (Math.random() * 2 - 0.5)),
      );
    }
    for (const window of account.windows) {
      if (isDefined(window.remaining_pct)) {
        window.remaining_pct = Math.max(
          0,
          Math.min(100, window.remaining_pct + (Math.random() * 2 - 0.5)),
        );
      }
    }
  }
}

export function matchCatalog(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "GET" && ctx.base === "/v1/status") {
    return ok(currentStatus(store));
  }
  if (ctx.m === "GET" && ctx.base === "/v1/live") {
    return ok({
      wiki_revision: store.wiki?.revision ?? 0,
      traffic_events: store.traffic.length,
      observed_at: new Date().toISOString(),
    });
  }
  if (ctx.m === "GET" && ctx.base === "/v1/providers") {
    return ok({ providers: store.providers });
  }
  if (ctx.m === "GET" && ctx.base === "/v1/accounts") {
    return ok(store.accounts);
  }
  return null;
}

export function matchQuota(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "GET" && ctx.base === "/v1/quota") {
    return ok(currentQuota(store));
  }
  if (ctx.m === "GET" && ctx.base === "/v1/quota/history") {
    const hours = Number(ctx.q.get("hours") ?? "3") || 3;
    return ok(currentQuotaHistory(store, hours));
  }
  if (ctx.m === "POST" && ctx.base === "/v1/quota/refresh") {
    nudgeQuotaPercents();
    rebuildDerivedQuota();
    return ok({ ok: true, refresh: { mock: true }, quota: currentQuota(store) });
  }
  return null;
}

export async function matchTraffic(ctx: MockRequestContext): Promise<MockHttpResult | null> {
  const store = getStore();
  if (ctx.m === "GET" && ctx.base === "/v1/traffic/recent") {
    const limit = Number(ctx.q.get("limit") ?? "200") || 200;
    return ok(store.traffic.slice(0, limit));
  }
  if (ctx.m === "GET" && ctx.base === "/v1/traffic/search") {
    const needle = (ctx.q.get("q") ?? "").trim().toLowerCase();
    const limit = Number(ctx.q.get("limit") ?? "100") || 100;
    if (needle === "") {
      return ok(store.traffic.slice(0, limit));
    }
    const hits = store.traffic.filter((ev) => {
      const hay =
        `${ev.content ?? ""} ${ev.model ?? ""} ${ev.account_label ?? ""} ${ev.provider}`.toLowerCase();
      return hay.includes(needle);
    });
    return ok(hits.slice(0, limit));
  }
  if (ctx.m === "POST" && ctx.base === "/v1/demo/seed") {
    if (store.traffic.length === 0) {
      const { seedTraffic } = await import("./fixtures");
      store.traffic = seedTraffic("default");
    } else {
      store.traffic = [
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
          account_label: store.accounts[0]?.label ?? "mock",
          latency_ms: 512,
        },
        ...store.traffic,
      ];
    }
    return ok({ note: "Mock demo seed", inserted: 1, force: false });
  }
  return null;
}

export function matchProxy(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "POST" && ctx.base === "/v1/proxy/start") {
    store.proxyRunning = true;
    return ok({ ok: true });
  }
  if (ctx.m === "POST" && ctx.base === "/v1/proxy/stop") {
    store.proxyRunning = false;
    return ok({ ok: true });
  }
  if (ctx.m === "POST" && ctx.base === "/v1/proxy/restart") {
    store.proxyRunning = true;
    return ok({ ok: true });
  }
  return null;
}

export function matchAccounts(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "POST" && ctx.base === "/v1/accounts/login") {
    const provider = readStringField(ctx.payload, "provider") ?? "claude";
    const loginMethod = readStringField(ctx.payload, "method") ?? "browser";
    const url = `https://mock.rivet.local/oauth/${provider}?method=${loginMethod}`;
    store.login = {
      active: true,
      provider,
      output: `Starting ${provider} login (${loginMethod})…\nOpen: ${url}\nWaiting for callback…`,
      done: false,
      success: false,
    };
    delayLoginComplete(provider);
    return ok({ message: store.login.output, url });
  }
  if (ctx.m === "GET" && ctx.base === "/v1/accounts/login/status") {
    return ok(
      store.login ?? {
        active: false,
        provider: null,
        output: "",
        done: false,
        success: false,
      },
    );
  }
  if (ctx.m === "POST" && ctx.base === "/v1/accounts/login/cancel") {
    if (store.loginTimer) {
      clearTimeout(store.loginTimer);
    }
    store.loginTimer = null;
    store.login = {
      active: false,
      provider: store.login?.provider ?? null,
      output: `${store.login?.output ?? ""}\nCancelled.`,
      done: true,
      success: false,
    };
    return ok({ ok: true });
  }
  if (ctx.m === "POST" && ctx.base === "/v1/accounts/import/vertex") {
    const importPath = readStringField(ctx.payload, "path") ?? "/mock/vertex.json";
    store.login = {
      active: true,
      provider: "vertex",
      output: `Importing Vertex SA from ${importPath}…`,
      done: false,
      success: false,
    };
    delayLoginComplete("vertex");
    return ok({ message: store.login.output });
  }
  if (ctx.m === "DELETE" && ctx.base.startsWith("/v1/accounts/")) {
    const id = decodeURIComponent(ctx.base.slice("/v1/accounts/".length));
    store.quotaAccounts = store.quotaAccounts.filter((a) => a.id !== id);
    rebuildDerivedQuota();
    return ok({ ok: true });
  }
  return null;
}

function normalizeOptionalModel(value: string | null | undefined): string | null {
  if (!isDefined(value)) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function matchConfig(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m !== "PUT" || ctx.base !== "/v1/config") {
    return null;
  }
  const embeddingModel = readNullableStringField(ctx.payload, "embedding_model");
  if (embeddingModel !== undefined) {
    store.embedModel = normalizeOptionalModel(embeddingModel) ?? "";
  }
  const wikiModel = readNullableStringField(ctx.payload, "wiki_model");
  if (wikiModel !== undefined) {
    store.wikiModel = normalizeOptionalModel(wikiModel);
  }
  const vectorSearch = readOptionalBooleanField(ctx.payload, "capabilities", "vector_search");
  if (isDefined(vectorSearch)) {
    store.vectorEnabled = vectorSearch;
  }
  const wikiCap = readOptionalBooleanField(ctx.payload, "capabilities", "wiki");
  if (isDefined(wikiCap)) {
    store.wikiEnabled = wikiCap;
  }
  return ok({ ok: true });
}

export function matchWorkers(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "POST" && ctx.base === "/v1/workers/tick") {
    return ok({
      embeddings: Math.min(store.traffic.length, 12),
      wiki_pages: store.wiki.pages.length,
    });
  }
  return null;
}

export function matchWiki(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "GET" && ctx.base === "/v1/wiki") {
    return ok(store.wiki);
  }
  if (ctx.m === "GET" && ctx.base === "/v1/wiki/page") {
    const id = ctx.q.get("id") ?? "";
    const bodyText = store.wikiBodies[id] ?? `# Missing\n\nNo mock body for \`${id}\`.\n`;
    return ok({ id, markdown: bodyText, content: bodyText });
  }
  if (ctx.m === "GET" && ctx.base === "/v1/wiki/archives") {
    const slug = ctx.q.get("slug") ?? "";
    const project = ctx.q.get("project_id") ?? store.wiki.project_id;
    const files = store.wikiArchives[`${project}/${slug}`] ?? store.wikiArchives[slug] ?? [];
    return ok({ project_id: project, slug, files });
  }
  if (ctx.m === "GET" && ctx.base === "/v1/wiki/archive") {
    const slug = ctx.q.get("slug") ?? "";
    const file = ctx.q.get("file") ?? "";
    const project = ctx.q.get("project_id") ?? store.wiki.project_id;
    const key = `${project}/${slug}/${file}`;
    const content =
      store.wikiArchiveBodies[key] ??
      store.wikiArchiveBodies[`${slug}/${file}`] ??
      `# Archive · ${slug} · ${file}\n\nMock overflow segment.\n`;
    return ok({ project_id: project, slug, file, content });
  }
  return null;
}

function harnessWritePath(target: string, mode: string): string {
  if (mode === "isolated") {
    return `/mock/Rivet/harness/${target}`;
  }
  if (target === "claude") {
    return "/mock/home/.claude";
  }
  return "/mock/home/.codex";
}

export function matchHarness(ctx: MockRequestContext): MockHttpResult | null {
  if (ctx.m === "GET" && ctx.base === "/v1/harness/claude.env") {
    return ok(
      `# Mock Claude Code env\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:18317\nexport ANTHROPIC_API_KEY=mock-key\n`,
    );
  }
  if (ctx.m === "GET" && ctx.base === "/v1/harness/codex.toml") {
    return ok(
      `# Mock Codex config\nmodel_provider = "rivet"\n\n[model_providers.rivet]\nbase_url = "http://127.0.0.1:18317/v1"\n`,
    );
  }
  if (ctx.m === "GET" && ctx.base === "/v1/harness/mcp.json") {
    return ok({
      mcpServers: {
        rivet: { url: "http://127.0.0.1:8741/mcp" },
      },
    });
  }
  if (ctx.m === "POST" && ctx.base === "/v1/harness/write") {
    const target = readStringField(ctx.payload, "target") ?? "claude";
    const mode = readStringField(ctx.payload, "mode") ?? "user";
    const path = harnessWritePath(target, mode);
    return ok({
      target,
      path,
      env_hint: mode === "isolated" ? `export CLAUDE_CONFIG_DIR=...` : "User overlay installed",
      note: `Mock harness write (${mode}) for ${target}`,
      backup_path: `/mock/backups/${target}-${Date.now()}.bak`,
      mode,
    });
  }
  return null;
}

export function matchBagExchange(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "POST" && ctx.base === "/v1/export") {
    const exportPath = `/mock/Rivet/exports/rivet-${Date.now()}.rivetbag`;
    store.lastExportPath = exportPath;
    return ok({
      path: exportPath,
      event_count: store.traffic.length,
      note: "Mock export package",
      schema_version: 1,
    });
  }
  if (ctx.m === "POST" && ctx.base === "/v1/import") {
    const importPath = readStringField(ctx.payload, "path") ?? "/mock/import.rivetbag";
    const inserted = 5;
    for (let i = 0; i < inserted; i += 1) {
      store.traffic.unshift({
        id: crypto.randomUUID(),
        ts: new Date(Date.now() - i * 1000).toISOString(),
        provider: "codex",
        model: "gpt-5",
        role: "user",
        content: `Imported mock event from ${importPath} (#${i + 1})`,
        tokens_in: 100,
        tokens_out: 40,
        status_code: 200,
        account_label: "import@mock",
        latency_ms: 300,
      });
    }
    return ok({
      path: importPath,
      event_count: inserted,
      note: "Mock import",
      schema_version: 1,
    });
  }
  return null;
}

export function matchLogs(ctx: MockRequestContext): MockHttpResult | null {
  const store = getStore();
  if (ctx.m === "GET" && ctx.base === "/v1/logs/proxy") {
    return ok({
      text: [
        "[mock] rivet-proxy listening on :18317",
        `[mock] proxy_running=${store.proxyRunning}`,
        `[mock] accounts loaded: ${store.accounts.length}`,
        store.scenario === "limit-hit"
          ? "[mock] WARN quota empty — returning 429"
          : "[mock] healthy",
      ].join("\n"),
    });
  }
  if (ctx.m === "GET" && ctx.base === "/v1/logs/clickhouse") {
    return ok({
      text: [
        "[mock] ClickHouse HTTP :8123",
        "[mock] database rivet ready",
        `[mock] traffic_events rows≈${store.traffic.length}`,
      ].join("\n"),
    });
  }
  return null;
}

export function unhandled(ctx: MockRequestContext): MockHttpResult {
  return err(`mock IPC: unhandled ${ctx.m} ${ctx.base}`, 404);
}
