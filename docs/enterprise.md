# Enterprise path

Local DMG and Helm share the same crates (`rivet-runtime`, `rivet-store`,
`rivet-mcp`, `rivet-worker`, `rivet-export`). Boundaries:

| Concern | Local | Enterprise |
| --- | --- | --- |
| Deploy | Tauri DMG + sidecars | `charts/rivet` |
| Traffic store | SQLite (+ optional CH dual-write) | ClickHouse primary |
| Workers | In-process Tokio | Worker Deployment (later: NATS/Redpanda consumers) |
| Auth UI | Local only | OIDC (`teams.oidc` in values) — scaffold |
| Tenancy | Single user | Org / team namespaces (`capabilities.teams`) |

```bash
helm install rivet ./charts/rivet
```

Build the control-plane image with the root `Dockerfile`. Proxy image builds from
`vendor/cliproxyapi`. Teams admin portal and OIDC login are intentionally later;
keep component boundaries so they become services without rewriting the data plane.
