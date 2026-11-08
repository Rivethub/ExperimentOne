# Rivet

Local-first multi-account AI proxy, traffic database, and optional knowledge layer.

Install the desktop app (macOS, Linux, or Windows), sign in your provider
accounts, point Claude Code / Codex / other harnesses at the local proxy. Rivet
captures every request and response, gives you stats and limits, and lets you
export/import **traffic data** (never OAuth, API keys, or proxy secrets).

## Layout

```
apps/desktop     Tauri 2 control app (tray + installers)
crates/          Rust control plane, store, workers, MCP
vendor/          Forked CLIProxyAPI (Go sidecar)
charts/rivet     Helm chart (enterprise)
docs/            Architecture, packaging, ClickHouse, enterprise
```

## Dev

Requires **Rust 1.90** (`rust-toolchain.toml` pins it).

```bash
# Sidecars (rivetd + rivet-proxy + ClickHouse) into Tauri binaries/
./scripts/build-sidecars.sh

# Or run control plane alone
cargo run -p rivet-runtime

# Desktop UI (tray + auto-starts rivetd)
cd apps/desktop && bun install && bun run tauri dev
# (bun run dev for Vite-only against an already-running rivetd)
```

## Product (v1.0)

Local control app + `rivetd` control plane on **macOS, Linux, and Windows**.
Quota charts and burn/drain metrics use **captured local traffic** (honest
estimates until live provider quota APIs). ClickHouse dual-write when the
bundled sidecar is present. Close the window to keep Rivet in the tray; Quit
from the tray menu stops `rivetd`. Default proxy port is **18317**
(auto-migrates if busy).

Data directory: macOS `~/Library/Application Support/Rivet`, Linux
`~/.local/share/Rivet`, Windows `%APPDATA%\Rivet` (override with
`RIVET_DATA_DIR`).

```bash
./scripts/build-sidecars.sh
cd apps/desktop && bun install && bun run tauri dev
# optional: POST http://127.0.0.1:8741/v1/demo/seed  → sample traffic for UI walkthrough
# release: ./scripts/release.sh            # host OS installer
#          ./scripts/release-dmg.sh        # macOS DMG (+ --notarize)
```

First-run: **Start proxy → Sign in (any prox provider) → Write harness → run traffic.**

Supported credentials (same catalog as prox / CLIProxyAPI): Claude, Codex,
Antigravity, Kimi.com, Kimi.ai, xAI, Meta, Devin (OAuth), plus Vertex AI
service-account import.

Workers (on by default): **vectorize** embeds traffic for MCP `semantic_search`
(lexical locally, or proxy embeddings when `embedding_model` is set); **wiki**
writes markdown under the local Rivet data directory (plus an LLM overview when
`wiki_model` is set). Trigger immediately via `POST /v1/workers/tick` or
Intelligence → Run workers now.

## Milestones

| | Status |
| --- | --- |
| **M1** Local loop — supervise proxy, ingest, harness, login UI | Done |
| **M2** Traffic quality — rivetsink parse, redaction, export, CH dual-write path | Done |
| **M3** Desktop polish — tray (close-to-tray), traffic browser, wiki, packaging | Done |
| **M4** Optional intelligence — vector/wiki workers + semantic MCP | Done |
| **M5** Enterprise Helm scaffold | Done (OIDC/teams later) |
| **M6** Windows + Linux desktop parity | Done |

## Control API (localhost:8741)

- `GET /v1/status`, `GET|PUT /v1/config`
- `POST /v1/proxy/start|stop`
- `POST /v1/accounts/login`, harness write, export/import
- `GET /v1/wiki`

MCP (`:8742`): `search_history`; `semantic_search` when vectors enabled.

## Docs

- [Architecture](docs/architecture.md)
- [Packaging (macOS / Linux / Windows)](docs/packaging.md)
- [ClickHouse](docs/clickhouse.md)
- [Enterprise](docs/enterprise.md)
- [Proxy fork](vendor/FORK.md)
