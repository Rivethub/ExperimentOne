# Enterprise path

Local desktop installers and Helm share the same crates (`rivet-runtime`,
`rivet-store`, `rivet-mcp`, `rivet-worker`, `rivet-export`). Boundaries:

| Concern | Local | Enterprise |
| --- | --- | --- |
| Deploy | Tauri (DMG / deb+AppImage / NSIS) + sidecars | `charts/rivet` |
| Traffic store | ClickHouse (bundled or URL) | Altinity ClickHouse operator via `charts/rivet` (`clickhouse` subchart) |
| Job plane | Bundled `nats-server` JetStream | External NATS (`bus.natsUrl`, required) |
| Workers | In-process Tokio (`RIVET_WORKER_ROLE=all`) | Default: same in-process on rivetd. Optional: `workers.enabled=true` → rivetd `none` + Deployments per `embed`/`compact`/`wiki` |
| Auth UI | Local only | OIDC (`teams.oidc` in values) — scaffold |
| Tenancy | Single user | Org / team namespaces (`capabilities.teams`) |

```bash
# Set bus.natsUrl to a reachable JetStream URL first (values.yaml default is a placeholder).
helm dependency update ./charts/rivet
helm install rivet ./charts/rivet
```

ClickHouse is provided by the Altinity [`clickhouse`](https://helm.altinity.com/)
chart (operator + `ClickHouseInstallation`). Override CHI settings under
`clickhouse.clickhouse` in values; set `clickhouse.operator.enabled=false` if the
operator is already installed cluster-wide, or `clickhouse.enabled=false` plus
`clickhouse.url` for an external cluster.

Worker role splits use the same `rivetd` image with `RIVET_WORKER_ROLE` set to
`embed`, `compact`, or `wiki` (skips proxy/API/MCP listeners). The control-plane
Deployment then runs with `RIVET_WORKER_ROLE=none`. Shared meta/wiki volumes are
required for split workers — wire those before enabling `workers.enabled`.

Build the control-plane image with the root `Dockerfile`. Proxy image builds from
`vendor/cliproxyapi`. Teams admin portal and OIDC login are intentionally later;
keep component boundaries so they become services without rewriting the data plane.
