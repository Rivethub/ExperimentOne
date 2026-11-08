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

Requires **Rust 1.99.1** (`rust-toolchain.toml` pins it), **Bun 1.4.4**, and **Node.js 26** (`.prototools`).

Commit messages use [Conventional Commits](https://www.conventionalcommits.org/) with a required project scope (`committed.toml`). Local gate is **hk** (fast parallel hooks runner) + `committed`; CI runs the same check.

```bash
brew install hk committed
hk install

# Sidecars (rivetd + rivet-proxy + ClickHouse) into Tauri binaries/
./scripts/build-sidecars.sh

# Or run control plane alone
cargo run -p rivet-runtime

# Desktop UI (tray + auto-starts rivetd)
cd apps/desktop && bun install && bun run tauri dev
# (bun run dev for Vite-only against an already-running rivetd;
#  bun run dev:mock for browser UI with mocked IPC)
```

### Faster Rust builds

- Prefer `cargo check -p rivet-runtime` (or `-p rivet-cli`) while iterating; full `cargo build` only when you need binaries.
- Dev profile keeps line-tables debug info and strips dep debug info for faster links.
- On **Linux**, `.cargo/config.toml` links with **mold** (`sudo apt install clang mold` / `brew install mold`). macOS and Windows keep the platform linker (mold has no Mach-O/PE support).

Scopes: `api`, `charts`, `ci`, `cli`, `core`, `deps`, `desktop`, `docs`, `export`, `ingest`, `mcp`, `proxy`, `repo`, `runtime`, `scripts`, `store`, `worker`. Example: `feat(desktop): Add tray quit confirmation`. Squash merges use the PR title as `{title} (#N)`; CI lints that subject.

## Product (v1)

Local control app + `rivetd` control plane on **macOS, Linux, and Windows**.
Quota charts use live provider windows plus burn/cost from **captured local
traffic**. Traffic + embeddings live in ClickHouse (bundled sidecar or
`RIVET_CLICKHOUSE_URL`); jobs run on NATS JetStream (bundled `nats-server` or
`RIVET_NATS_URL`); meta (wiki index, quota history, summaries) is file-backed
under `meta/`. Close the window to keep Rivet in the tray; Quit from the tray
menu stops `rivetd`. Default ports: proxy **18317**, API/ingest **8741**, MCP
**8742**.

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

Supported credentials (same catalog as prox / CLIProxyAPI): Claude, Codex
(browser OAuth by default; device code optional), Antigravity, Kimi.com,
Kimi.ai, xAI, Meta, Devin (OAuth), plus Vertex AI service-account import.
Accounts live under Settings → Accounts as a list with **Add account**.

Workers (on by default, `RIVET_WORKER_ROLE=all`): **vectorize** writes lexical
64-d embeddings into ClickHouse for MCP `semantic_search`; **wiki** maintains a
markdown tree under the Rivet data directory (traffic READMEs + knowledge
pages when `wiki_model` is set); **compact** builds session summary DAGs.
Trigger immediately via `POST /v1/workers/tick` or Intelligence → Run workers
now.

## Milestones

| | Status |
| --- | --- |
| **M1** Local loop — supervise proxy, ingest, harness, login UI | Done |
| **M2** Traffic quality — rivetsink parse, redaction, export, ClickHouse primary | Done |
| **M3** Desktop polish — tray (close-to-tray), traffic browser, wiki, packaging | Done |
| **M4** Optional intelligence — vector/wiki workers + semantic MCP | Done |
| **M5** Enterprise Helm scaffold | Done (OIDC/teams later) |
| **M6** Windows + Linux desktop parity | Done |

## Control API (localhost:8741)

- `GET /v1/status`, `GET|PUT /v1/config`
- `POST /v1/proxy/start|stop`
- `POST /v1/accounts/login`, harness write, export/import
- `GET /v1/wiki`, `/v1/topics`, `/v1/conversations*`

MCP streamable HTTP (`:8742/mcp`): `search_history`, `semantic_search`,
`topic_search`, `topic_get`, `get_full`, `browse_session`, `memory_stats`.

## Agent / CLI setup

Headless install + control plane (no desktop UI):

```bash
curl -fsSL https://raw.githubusercontent.com/wSedlacek/Rivet/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
rivet setup
```

Primary commands: `rivet status`, `rivet doctor`, `rivet login <provider>`,
`rivet harness write claude`, `rivet demo seed`. Paste
[docs/agent-setup-prompt.md](docs/agent-setup-prompt.md) into an agent (or run
`rivet prompt`) for the full drop-in setup script.

Dev: `cargo run -p rivet-cli -- --help`. Installs pull archives from the latest
GitHub release (asset contract in [docs/packaging.md](docs/packaging.md)).

## Docs

- [Architecture](docs/architecture.md)
- [Packaging (macOS / Linux / Windows)](docs/packaging.md)
- [Agent setup prompt](docs/agent-setup-prompt.md)
- [ClickHouse](docs/clickhouse.md)
- [Enterprise](docs/enterprise.md)
- [Proxy fork](vendor/FORK.md)
