# Packaging Rivet (DMG)

## Sidecars

```bash
./scripts/build-sidecars.sh
# writes:
#   apps/desktop/src-tauri/binaries/rivetd-$TARGET_TRIPLE
#   apps/desktop/src-tauri/binaries/rivet-proxy-$TARGET_TRIPLE
#   apps/desktop/src-tauri/binaries/clickhouse-$TARGET_TRIPLE   (~120MB)
```

ClickHouse is a pinned official single binary (`clickhouse server`). SQLite stays
the read path; inserts dual-write when the sidecar is up. See
[clickhouse.md](./clickhouse.md).

Default proxy port is **18317** (avoids common Docker use of 8317). If the port
is busy at startup, rivetd migrates to a free localhost port and rewrites
`config.json`.

## Dev desktop

```bash
cargo build -p rivet-runtime
./scripts/build-sidecars.sh
cd apps/desktop && bun install && bun run tauri dev
```

The app tray-launches `rivetd` if `:8741` is down. Closing the window hides to
the tray; **Quit Rivet** from the tray menu stops `rivetd`.

Optional UI walkthrough data:

```bash
curl -X POST http://127.0.0.1:8741/v1/demo/seed -H 'content-type: application/json' -d '{"force":true}'
```

## Release DMG

```bash
./scripts/release-dmg.sh
# Gatekeeper-clean distribution (needs Developer ID Application + notary creds):
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID=you@example.com TEAM_ID=TEAMID APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  ./scripts/release-dmg.sh --notarize
```

Entitlements live at `apps/desktop/src-tauri/entitlements.plist` (network client/
server + user-selected files for import/export).

### Codesign notes

| Identity | Use |
| --- | --- |
| **Developer ID Application** | Required for notarized DMGs others can open without Gatekeeper blocks |
| Apple Development | Local/dev signing only — not suitable for public distribution |

CI builds the UI + `cargo check`; notarization stays a manual/release job so
certs never sit in the repo.
