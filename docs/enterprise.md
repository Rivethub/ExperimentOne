# Enterprise path

Local desktop installers and Helm share the same crates (`rivet-runtime`,
`rivet-store`, `rivet-mcp`, `rivet-worker`, `rivet-export`). Boundaries:

| Concern | Local | Enterprise |
| --- | --- | --- |
| Deploy | Tauri (DMG / deb+AppImage / NSIS) + sidecars | `charts/rivet` |
| Capture store | ClickHouse (bundled or URL) | Altinity ClickHouse operator via `charts/rivet` (`clickhouse` subchart) |
| Job plane | Bundled `nats-server` JetStream | Official NATS chart via `charts/rivet` (`nats` subchart, JetStream) |
| Workers | In-process Tokio (`RIVET_WORKER_ROLE=all`) | Same — in-process on rivetd. Role-split Deployments blocked until meta locking + proxy URL exist |
| Auth UI | Local only | OIDC (`teams.oidc` in values) — scaffold |
| Tenancy | Single user | Org / team namespaces (`capabilities.teams`) |

```bash
helm dependency update ./charts/rivet
helm install rivet ./charts/rivet
```

ClickHouse is provided by the Altinity [`clickhouse`](https://helm.altinity.com/)
chart (operator + `ClickHouseInstallation`). Override CHI settings under
`clickhouse.clickhouse` in values; set `clickhouse.operator.enabled=false` if the
operator is already installed cluster-wide, or `clickhouse.enabled=false` plus
`clickhouse.url` for an external cluster.

NATS is provided by the official [`nats`](https://nats-io.github.io/k8s/helm/charts/)
chart (JetStream StatefulSet — preferred over the legacy `nats-operator`, which
lacks JetStream). Override server settings under `nats.config` in values; set
`nats.enabled=false` plus `nats.url` for an external cluster.

Build the control-plane image with the root `Dockerfile`. Proxy image builds from
`vendor/cliproxyapi`. Teams admin portal and OIDC login are intentionally later;
keep component boundaries so they become services without rewriting the data plane.
