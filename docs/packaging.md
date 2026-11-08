# Packaging

Desktop builds ship:

- Tauri shell + web UI
- `rivetd` control plane
- `rivet-proxy` (CLIProxyAPI fork)
- ClickHouse single binary (`clickhouse server`) when the platform has an official build

`scripts/build-sidecars.sh` fetches pinned proxy + ClickHouse artifacts into the
app resources tree. Without ClickHouse on disk, set `RIVET_CLICKHOUSE_URL` (or
`RIVET_CLICKHOUSE_BIN`) before launching — traffic has no SQLite fallback.

## Data directory

Default OS application-support path (override with `RIVET_DATA_DIR`):

- `config.json` — app settings
- `meta/` — jobs, wiki index, embeddings, quota history
- `wiki/` — markdown pages
- `clickhouse/` — sidecar config + data
- `proxy/` — proxy config, auth files, logs
- `blobs/`, `exports/`

Legacy `rivet.sqlite` / `traffic.sqlite` are deleted on meta open if still present.
