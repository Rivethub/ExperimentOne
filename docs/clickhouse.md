# ClickHouse in Rivet

## Local (DMG)

Rivet bundles a **single-node ClickHouse** sidecar when you run
`./scripts/fetch-clickhouse.sh` (also called from `build-sidecars.sh`).

At runtime `rivetd`:

1. Resolves `clickhouse-$TARGET_TRIPLE` next to the binary / Tauri sidecars
2. Writes `~/Library/Application Support/Rivet/clickhouse/config.xml`
3. Spawns `clickhouse server --config-file …` (localhost-only HTTP + native)
4. Ensures database `rivet` + `traffic_events`
5. Dual-writes inserts (SQLite remains primary for reads / MCP / export)

```bash
./scripts/fetch-clickhouse.sh          # ~120MB download, once
cargo run -p rivet-runtime             # auto-starts CH if binary found
# status.traffic_backend → "sqlite+clickhouse"
```

Override / skip:

| Env | Effect |
| --- | --- |
| `RIVET_CLICKHOUSE_BIN` | Path to the multi-tool `clickhouse` binary |
| `RIVET_CLICKHOUSE_URL` | Force dual-write URL (default `http://127.0.0.1:8123` when sidecar starts) |
| No binary present | SQLite-only (dev without fetch) |

Data lives under Application Support (`clickhouse/data`), not inside the app bundle.

## Packaging

```bash
./scripts/build-sidecars.sh
# produces:
#   apps/desktop/src-tauri/binaries/rivetd-$TRIPLE
#   apps/desktop/src-tauri/binaries/rivet-proxy-$TRIPLE
#   apps/desktop/src-tauri/binaries/clickhouse-$TRIPLE
```

`tauri.conf.json` lists `binaries/clickhouse` in `externalBin`.

macOS: the fetch script clears the quarantine xattr so Gatekeeper is less
noisy; still codesign the binary with your Developer ID for notarized DMGs.

## Enterprise

Helm chart fills a CH service; same `TrafficStore` / dual-write client. See
[enterprise.md](./enterprise.md).
