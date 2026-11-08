# Rivet architecture

Rivet is a local-first multi-account AI proxy: harnesses talk to a localhost
proxy, Rivet captures traffic into ClickHouse, and the desktop app surfaces
quota, conversation history, wiki, and MCP.

## Goals

1. **Local by default** — one desktop installer; accounts and harnesses work on `localhost`.
2. **Enterprise-shaped components** — same crates can become Helm services later.
3. **Fast Rust control plane** — ingest, store, workers, MCP, and API in Rust.
4. **Proven proxy** — fork/embed CLIProxyAPI (Go) as `rivet-proxy`; do not rewrite providers day one.

## What is (and isn’t) traffic

**Captured / exportable traffic:** prompts, completions, tool calls, usage counts,
model IDs, latency, session/project IDs, account labels.

**Never exported as credentials:** OAuth blobs, API keys, management secrets,
provider credentials under `proxy/auth/`. Captured text may still be sensitive
after best-effort redaction.

---

## System overview

```mermaid
flowchart TB
  subgraph clients [Clients]
    Harness[Harnesses<br/>Claude Code / Codex / T3]
    UI[Desktop UI<br/>Tauri webview]
    CLI[rivet CLI]
  end

  subgraph host [Desktop host]
    Tauri[Tauri IPC host]
  end

  subgraph rivetd [rivetd — rivet-runtime]
    CtrlIPC[Control IPC<br/>UDS / named pipe]
    TCP[Loopback TCP<br/>api_port]
    API[rivet-api]
    Ingest[rivet-ingest]
    Store[rivet-store]
    Worker[rivet-worker]
    MCP[rivet-mcp]
    Export[rivet-export]
  end

  subgraph sidecars [Sidecars]
    Proxy[rivet-proxy<br/>CLIProxyAPI fork]
    CH[(ClickHouse)]
  end

  subgraph disk [Data directory]
    Meta[meta/]
    WikiFS[wiki/]
    Auth[proxy/auth/]
    Logs[proxy/logs · clickhouse/logs]
    Bags[exports/*.rivetbag]
  end

  Harness -->|OpenAI / Claude HTTP| Proxy
  Proxy -->|batched POST /v1/ingest/batch| Ingest
  Ingest --> Store
  Worker --> Store
  Worker -->|wiki index · cursors| Meta
  Worker --> WikiFS
  Store -->|traffic + embeddings| CH
  API --> Store
  API --> Meta
  MCP --> Store
  Export --> Store
  Export --> Bags

  UI --> Tauri
  Tauri -->|control IPC + X-Rivet-Key| CtrlIPC
  CtrlIPC --> API
  CLI -->|loopback HTTP + key| TCP
  TCP --> API
  TCP --> Ingest

  rivetd -->|spawn / supervise| Proxy
  rivetd -->|spawn / supervise| CH
  Proxy --> Auth
  Proxy --> Logs
  Harness -.->|optional MCP| MCP
```

**Process boundaries**

| Process | Owns |
| --- | --- |
| Desktop app | Tray, UI, starts/stops `rivetd` via Tauri |
| `rivetd` | API, ingest, workers, MCP, control IPC; supervises sidecars |
| `rivet-proxy` | Provider routing, OAuth login, quota management API |
| ClickHouse | Durable `traffic_events` |

---

## Ports, URLs, and auth

| Surface | Default | Auth |
| --- | --- | --- |
| Proxy (harnesses) | `http://127.0.0.1:18317` | Harness → proxy access key / provider OAuth as configured |
| API + ingest | `http://127.0.0.1:8741` | Loopback Host + `X-Rivet-Key` / `X-Rivet-Ingest-Key` |
| MCP | `http://127.0.0.1:8742/mcp` | Loopback Host/Origin guards |
| ClickHouse HTTP | `http://127.0.0.1:8123` | Local sidecar / `RIVET_CLICKHOUSE_URL` |
| Control IPC | `{data}/rivetd.sock` (Windows named pipe) | Host injects key; webview never sees it |

Env overrides: `RIVET_DATA_DIR`, `RIVET_CLICKHOUSE_URL`, `RIVET_PROXY_BIN`,
`RIVET_CLICKHOUSE_BIN`. Runtime sets `RIVET_INGEST_URL` / `RIVET_INGEST_KEY` when
spawning the proxy.

---

## Data flows

### 1. Model request path (harness → provider)

```mermaid
sequenceDiagram
  participant H as Harness
  participant P as rivet-proxy
  participant U as Provider upstream
  H->>P: POST /v1/messages (etc) @ :18317
  P->>P: accept → pick credential → execute
  alt first upstream fails
    P->>U: attempt 1 (e.g. api.anthropic.com)
    U-->>P: 429 / error
    P->>U: attempt 2 (e.g. Vertex)
    U-->>P: 200 stream/JSON
  else happy path
    P->>U: single upstream call
    U-->>P: 200
  end
  P-->>H: response (same path reversed)
```

The harness never calls providers directly. Each failover retry is an extra
`proxy → upstream` hop.

### 2. Traffic capture (proxy → ClickHouse)

Not disk log scraping. The Rivet fork wraps CPA’s request logger and **pushes**
events over HTTP.

```mermaid
flowchart LR
  A[Finalized request<br/>stream or unary] --> B[rivetsink Wrapper]
  B --> C[Bounded queue<br/>256 · drop if full]
  C --> D[Batch worker<br/>≤32 events · ≤1 MiB]
  D -->|POST /v1/ingest/batch| E[rivet-ingest]
  E --> F[RedactingStore]
  F --> G[(ClickHouse<br/>traffic_events)]
```

| Detail | Behavior |
| --- | --- |
| Trigger | Same logger hook CPA uses for request logs |
| Payload | Structured `TrafficEvent` (no credentials) |
| Disk `request-log` | **Off by default** — ClickHouse is the product store |
| Forced errors | `error-*.log` still written when the inner logger is disabled |
| Process logs | Under `logs-max-total-size-mb: 256` cleaner |

### 3. Desktop control path (UI → rivetd)

```mermaid
flowchart LR
  UI[Webview] -->|invoke api_request| Host[Tauri host]
  Host -->|HTTP/1.1 over UDS/pipe<br/>injects X-Rivet-Key| IPC[Control IPC]
  IPC --> API[rivet-api /v1/*]
  API --> Store[rivet-store]
  Store --> CH[(ClickHouse)]
  Store --> Meta[meta/]
```

Loopback TCP on `api_port` still serves the same control routes for CLI, plus
ingest for the proxy. The webview never uses TCP to `rivetd` and never sees the
raw access key.

### 4. Conversations / Data pane

```mermaid
flowchart TB
  CH[(traffic_events)] --> API["/v1/conversations<br/>/search · /events"]
  Emb[(embeddings · HNSW)] -.->|vector mode| API
  API --> UI[Data pane]
  UI --> T[Transcript view<br/>text · thinking · tools]
```

Events sharing a `session_id` become one conversation. Keyword search hits
ClickHouse content; vector search uses the ClickHouse HNSW `embeddings` index
then hydrates traffic rows.

### 5. Quota

```mermaid
flowchart LR
  UI[Quota pane] --> API["/v1/quota · /refresh · /history"]
  API --> Mgmt[Proxy management API<br/>/v8/management/credentials…]
  API --> CH[(usage from traffic)]
  API --> Hist[meta/quota_snapshots.jsonl]
  Mgmt --> Auth[proxy/auth credentials]
```

Management calls use `management_secret` (not the harness access key). History
samples live in meta JSONL, not ClickHouse.

### 6. Accounts / OAuth

```mermaid
flowchart LR
  UI[Settings · Accounts] -->|POST /v1/accounts/login| API[rivet-api]
  API --> Sup[ProxySupervisor]
  Sup -->|spawn rivet-proxy -*-login| Proxy[rivet-proxy]
  Proxy --> Browser[Browser / device code]
  Proxy --> Auth[proxy/auth/]
  UI -->|list / remove / vertex import| API
```

### 7. Harness install

```mermaid
flowchart LR
  UI[Settings · Harness] -->|POST /v1/harness/write| API
  API --> Files["~/.claude or ~/.codex<br/>backup then overlay"]
  API --> Iso["{data}/harness/* isolated"]
  Files --> ProxyURL[ANTHROPIC_BASE_URL / Codex rivet provider]
  API --> MCPJSON["/v1/harness/mcp.json → :mcp_port/mcp"]
```

### 8. Workers: wiki + embeddings

```mermaid
flowchart TB
  Tick[Worker tick ~20s] --> CH[(ClickHouse traffic)]
  CH --> WikiJob[Wiki upsert]
  CH --> VecJob[Vectorize]
  WikiJob --> WikiFS[wiki/&#123;project&#125;/*.md]
  WikiJob --> MetaW[meta/wiki_pages.json]
  VecJob --> Emb[(ClickHouse embeddings<br/>64-dim · HNSW)]
  FS[FS watcher] --> MetaW
```

MCP and Data search work with keyword SQL alone; vectors and wiki improve
quality when enabled. Legacy `meta/embeddings.json` is imported once into
ClickHouse on boot, then renamed `.migrated`.

### 9. MCP

```mermaid
flowchart LR
  Harness[Harness MCP client] -->|POST :mcp_port/mcp| MCP[rivet-mcp]
  MCP -->|search_history| CH[(traffic_events)]
  MCP -->|semantic_search| Emb[(embeddings · HNSW)]
  Emb --> CH
```

### 10. Export / import

```mermaid
flowchart LR
  UI[Data · export/import] --> API["/v1/export · /v1/import"]
  API --> Exp[rivet-export]
  Exp --> CH[(ClickHouse)]
  Exp --> Bag[".rivetbag<br/>manifest + traffic_events.json"]
  Bag -->|import| CH
```

Embeddings and wiki are not packaged yet. Credentials are never included.

### 11. Logs (debug escape hatch)

```mermaid
flowchart LR
  UI[Runtime pane] --> API["/v1/logs/&#123;proxy|clickhouse&#125;"]
  API --> Files[Newest *.log under<br/>proxy/logs or clickhouse/logs]
```

### 12. Sidecar lifecycle

```mermaid
sequenceDiagram
  participant D as Desktop / rivet CLI
  participant R as rivetd
  participant P as rivet-proxy
  participant C as ClickHouse
  D->>R: start
  R->>C: spawn / connect + ensure_schema
  R->>P: spawn with RIVET_INGEST_*
  R->>R: API + ingest + MCP + workers + control IPC
  Note over R,P: watchdog restarts proxy if desired but dead
  D->>R: shutdown / Quit
  R->>P: stop
  R->>C: stop owned sidecar
```

---

## Storage model

### ClickHouse

Primary local store. Schema applied at boot (`CREATE DATABASE rivet` + tables).

| Table / artifact | Role |
| --- | --- |
| `traffic_events` | One row per captured request/stream segment |
| `embeddings` | Lexical (64-dim) vectors with HNSW `vector_similarity('hnsw', 'cosineDistance', 64)` |

`usage_rollups` and `wiki_pages` as CH tables remain sketched / optional; the
wiki **index** and quota history samples still live in meta files.

### Meta files (`{data}/meta/`)

| File | Role |
| --- | --- |
| Job cursors | Vectorize / wiki progress |
| `wiki_pages.json` | Wiki page index for the UI |
| `quota_snapshots.jsonl` | Quota history samples |
| `embeddings.json` | Legacy only — imported into CH once, then `.migrated` |

### Other directories

| Path | Role |
| --- | --- |
| `proxy/auth/` | OAuth / provider credentials (never exported) |
| `proxy/logs/` | Process + forced error logs |
| `wiki/` | Generated markdown tree |
| `exports/` | `.rivetbag` packages |
| `blobs/` | Reserved for spilled bodies (`body_ref`); content usually inline in CH today |
| `pids/` | Sidecar PID tracking |

Default data root: macOS
`~/Library/Application Support/Rivet`, Linux `~/.local/share/Rivet`, Windows
`%APPDATA%\Rivet` (`RIVET_DATA_DIR` overrides).

---

## Local vs enterprise

| Concern | Local (desktop / CLI) | Enterprise (Helm) |
| --- | --- | --- |
| Proxy | Sidecar process (`:18317`) | Deployment (chart often `:8317`) |
| ClickHouse | Bundled single-node or URL | Cluster / managed |
| Workers | In-process Tokio poll | Job pods / queue consumers |
| Bus | Polling | NATS or Redpanda later |
| UI auth | Loopback + key / control IPC | OIDC + admin portal |
| Tenancy | Single user | Org / team namespaces |

Shared contracts: ingest protocol, store schemas, MCP tools, `.rivetbag` format.

---

## Desktop UX map

| Pane | Reads | Writes |
| --- | --- | --- |
| Quota | `/v1/quota`, history, traffic burn | Refresh credentials |
| Data | Conversations / search / events | Export · import |
| Runtime | Status, sidecar health, log tails | Start/stop proxy |
| Wiki | `/v1/wiki` + pages | (generated by worker) |
| Settings | Accounts, intelligence, harness | Login, import, harness write |

Close-to-tray; Quit from tray stops `rivetd`.

---

## Security / ToS posture

- Capture is local by default.
- Export is user-initiated traffic sharing, not credential sharing.
- Multi-account pooling carries provider ToS risk (disclose in product).

## Stack locks

- Rust for Rivet backend crates
- Go only inside the forked proxy sidecar
- Tauri 2 desktop → DMG / deb+AppImage / NSIS
- ClickHouse for traffic analytics events
- No TigerBeetle; no Flink locally (Rust workers; Redpanda later for enterprise fan-out)

## Implementation notes (doc vs code)

1. **Ingest** is HTTP batch to `/v1/ingest/batch`, not Unix-socket NDJSON (`ingest.sock` path may exist unused).
2. **Embeddings** live in ClickHouse with HNSW; **wiki index** and **quota history** remain meta-file backed.
3. **`body_ref` / `blobs/`** are reserved; most bodies live in the `content` column.
4. Helm proxy port may differ from the local default `18317`.
