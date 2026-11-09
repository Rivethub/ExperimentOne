# rivet-proxy (CLIProxyAPI fork)

Upstream: https://github.com/router-for-me/CLIProxyAPI

## Rivet changes

- `internal/rivetsink` — when `RIVET_INGEST_URL` is set (e.g. `http://127.0.0.1:8741`), every logged request/response is POSTed to Rivet ingest as a `CaptureEvent`. No credentials are included.
- Wired in `internal/api/server_options.go` via `defaultRequestLoggerFactory`.
- `internal/logging/redact_hook.go` — global logrus hook that masks Bearer/API keys, JWTs, and sensitive structured fields before logs hit stdout/files.

## Build

```bash
cd vendor/cliproxyapi
PATH="/usr/local/go/bin:$PATH" go build -o ../../apps/desktop/src-tauri/binaries/rivet-proxy-aarch64-apple-darwin ./cmd/server
```

Runtime writes `~/Library/Application Support/Rivet/proxy/config.yaml`, sets
`RIVET_INGEST_URL` when spawning the sidecar, and supervises start/stop plus
`-claude-login` / `-codex-device-login` from the control API.
