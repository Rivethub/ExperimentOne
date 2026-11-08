# Packaging

Desktop builds ship:

- Tauri shell + web UI
- `rivetd` control plane
- `rivet-proxy` (CLIProxyAPI fork)
- ClickHouse single binary (`clickhouse server`) when the platform has an official build
- `nats-server` (JetStream job plane)

`scripts/build-sidecars.sh` fetches pinned proxy + ClickHouse + NATS artifacts
into the app resources tree (`externalBin` in Tauri). Without ClickHouse on
disk, set `RIVET_CLICKHOUSE_URL` (or `RIVET_CLICKHOUSE_BIN`). Without NATS,
set `RIVET_NATS_URL` (or `RIVET_NATS_BIN`). Traffic has no SQLite fallback.

## Agent / headless CLI

Agents and headless hosts use the `rivet` CLI (`crates/rivet-cli`), not the
desktop installer. Bootstrap:

```bash
curl -fsSL https://raw.githubusercontent.com/wSedlacek/Rivet/main/scripts/install.sh | bash
rivet setup
```

Drop-in agent instructions: [agent-setup-prompt.md](agent-setup-prompt.md)
(`rivet prompt` prints the same text).

### GitHub release asset contract

Publish one archive per target triple (release workflow TBD):

| Asset | Contents (`bin/`) |
| --- | --- |
| `rivet-{version}-{triple}.tar.gz` | `rivet`, `rivetd`, `rivet-proxy`, `clickhouse` (when available), `nats-server` |
| `rivet-{version}-{triple}.zip` | Same, for Windows |

Triples match `rivet_core::target_triple()` (e.g. `aarch64-apple-darwin`,
`x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`). Install root defaults to
`~/.local/share/rivet/install` (override with `RIVET_INSTALL_DIR`). Runtime data
still uses the normal Rivet data directory / `RIVET_DATA_DIR`.

Dev without a published release: build sidecars, then
`RIVET_BIN_DIR=apps/desktop/src-tauri/binaries rivet start`.

## Data directory

Default OS application-support path (override with `RIVET_DATA_DIR`):

- `config.json` — app settings
- `meta/` — job cursors, wiki index, topics, summaries, quota history
- `wiki/` — markdown pages
- `clickhouse/` — sidecar config + data
- `nats/` — JetStream store + config
- `proxy/` — proxy config, auth files, logs
- `blobs/`, `exports/`, `plugins/`, `pids/`

