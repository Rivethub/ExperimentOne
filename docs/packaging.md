# Packaging Rivet

## Platforms

| OS | Installer | Data directory |
| --- | --- | --- |
| macOS | `.dmg` / `.app` | `~/Library/Application Support/Rivet` |
| Linux | `.deb` / `.AppImage` | `~/.local/share/Rivet` |
| Windows | NSIS `.exe` | `%APPDATA%\Rivet` |

Override the data root with `RIVET_DATA_DIR`.

## Sidecars

```bash
./scripts/build-sidecars.sh
# optional explicit triple:
./scripts/build-sidecars.sh x86_64-unknown-linux-gnu
./scripts/build-sidecars.sh x86_64-pc-windows-msvc
# writes (Windows adds .exe):
#   apps/desktop/src-tauri/binaries/rivetd-$TARGET_TRIPLE
#   apps/desktop/src-tauri/binaries/rivet-proxy-$TARGET_TRIPLE
#   apps/desktop/src-tauri/binaries/clickhouse-$TARGET_TRIPLE   (~120MB)
```

ClickHouse is a pinned official single binary (`clickhouse server`). SQLite stays
the read path; inserts dual-write when the sidecar is up. See
[clickhouse.md](./clickhouse.md). Windows aarch64 skips ClickHouse (no official
binary yet) and runs SQLite-only until one is supplied via `RIVET_CLICKHOUSE_BIN`.

Default proxy port is **18317** (avoids common Docker use of 8317). If the port
is busy at startup, rivetd migrates to a free localhost port and rewrites
`config.json`.

## Dev desktop

```bash
cargo build -p rivet-runtime
./scripts/build-sidecars.sh
cd apps/desktop && bun install && bun run tauri dev
```

The app tray-launches `rivetd` if the API port is down. Closing the window hides
to the tray; **Quit Rivet** from the tray menu stops `rivetd`.

Linux packages need WebKitGTK / AppIndicator (see CI). Optional UI walkthrough:

```bash
curl -X POST http://127.0.0.1:8741/v1/demo/seed -H 'content-type: application/json' -d '{"force":true}'
```

## Release

```bash
# Host OS installer (dmg / deb+appimage / nsis)
./scripts/release.sh

# macOS-only notarized DMG (Developer ID + notary creds):
./scripts/release-dmg.sh --notarize
```

Entitlements live at `apps/desktop/src-tauri/entitlements.plist` (macOS network
client/server + user-selected files for import/export).

### Codesign notes

| Platform | Notes |
| --- | --- |
| **macOS** | Developer ID Application + notarization for Gatekeeper-clean DMGs |
| **Windows** | Optional Authenticode; unsigned builds may hit SmartScreen |
| **Linux** | No signing required for local/AppImage distribution |

CI builds the UI + `cargo check` on macOS, Linux, and Windows; notarization /
Authenticode stay manual so certs never sit in the repo.
