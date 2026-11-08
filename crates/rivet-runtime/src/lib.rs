//! Boots the local Rivet control plane and supervises proxy + ClickHouse sidecars.

mod clickhouse;
mod control_ipc;
mod pids;
mod proxy;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use rivet_api::ApiState;
use rivet_ingest::IngestState;
use rivet_mcp::McpState;
use rivet_store::{ClickHouseTrafficStore, LocalStores};
use rivet_worker::WorkerPool;
use tokio::sync::RwLock;
use tracing::info;

pub use clickhouse::ClickHouseSupervisor;
pub use proxy::ProxySupervisor;

pub struct Runtime {
    pub paths: rivet_core::RivetPaths,
    pub config: rivet_core::RivetConfig,
    pub stores: LocalStores,
    pub proxy: Arc<ProxySupervisor>,
    pub clickhouse: Arc<ClickHouseSupervisor>,
    /// Held for process lifetime so a second rivetd cannot claim the instance.
    _instance_lock: rivet_core::pids::InstanceLock,
}

impl Runtime {
    pub fn bootstrap() -> Result<Self> {
        let paths = rivet_core::RivetPaths::discover()?;
        paths.ensure()?;
        // Lock before mutating config / writing pidfiles so a twin cannot race.
        let instance_lock = pids::try_acquire_rivetd_lock(&paths)?;
        pids::write_rivetd_pid(&paths);
        match Self::bootstrap_after_pid(paths.clone(), instance_lock) {
            Ok(rt) => Ok(rt),
            Err(err) => {
                pids::clear_rivetd_pid(&paths);
                Err(err)
            }
        }
    }

    fn bootstrap_after_pid(
        paths: rivet_core::RivetPaths,
        instance_lock: rivet_core::pids::InstanceLock,
    ) -> Result<Self> {
        ensure_wiki_seed(&paths)?;
        let mut config = rivet_core::RivetConfig::load_or_init(&paths)?;
        if let Some(new_port) = config.ensure_available_proxy_port(&paths)? {
            tracing::warn!(
                new_port,
                "proxy_port was busy — migrated to a free localhost port and saved config.json"
            );
        }
        let stores = LocalStores::open(&paths)?;
        let proxy = Arc::new(ProxySupervisor::new(paths.clone(), config.clone())?);
        let clickhouse = Arc::new(ClickHouseSupervisor::new(paths.clone(), config.clone())?);
        Ok(Self {
            paths,
            config,
            stores,
            proxy,
            clickhouse,
            _instance_lock: instance_lock,
        })
    }

    pub async fn run(self) -> Result<()> {
        let paths = self.paths.clone();
        let result = self.run_inner().await;
        pids::clear_rivetd_pid(&paths);
        result
    }

    async fn run_inner(self) -> Result<()> {
        match self.proxy.start() {
            Ok(()) => info!("proxy sidecar ready"),
            Err(err) => {
                tracing::warn!(
                    ?err,
                    "proxy not started (start from UI when binary is ready)"
                )
            }
        }

        let mut clickhouse_url = rivet_store::ClickHouseTrafficStore::from_env_url();
        match self.clickhouse.start_if_available() {
            Ok(true) => {
                let url = self.clickhouse.http_url();
                info!(%url, "clickhouse sidecar ready");
                if clickhouse_url.is_none() {
                    clickhouse_url = Some(url.clone());
                    std::env::set_var("RIVET_CLICKHOUSE_URL", &url);
                }
                if let Ok(ch) =
                    ClickHouseTrafficStore::new(clickhouse_url.as_deref().unwrap_or(&url))
                {
                    if let Err(err) = ch.ensure_schema().await {
                        tracing::warn!(
                            ?err,
                            "clickhouse ensure_schema failed (will retry on insert)"
                        );
                    } else {
                        info!("clickhouse schema ready (database rivet)");
                    }
                }
            }
            Ok(false) => {
                if clickhouse_url.is_none() {
                    anyhow::bail!(
                        "ClickHouse required: sidecar binary missing and RIVET_CLICKHOUSE_URL unset"
                    );
                }
                info!("bundled clickhouse skipped — using RIVET_CLICKHOUSE_URL");
            }
            Err(err) => {
                if clickhouse_url.is_none() {
                    return Err(err)
                        .context("ClickHouse sidecar failed and no RIVET_CLICKHOUSE_URL");
                }
                tracing::warn!(
                    ?err,
                    "bundled clickhouse failed — using RIVET_CLICKHOUSE_URL"
                );
            }
        }

        let store = self
            .stores
            .traffic_store_with_clickhouse(clickhouse_url.clone())?;
        let meta = self.stores.meta.clone();
        let config = Arc::new(RwLock::new(self.config.clone()));

        let traffic_backend = "clickhouse";
        let wiki_revision = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let worker = Arc::new(WorkerPool::new(
            store.clone(),
            meta.clone(),
            self.paths.clone(),
            config.clone(),
            wiki_revision.clone(),
        ));
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let api_state = ApiState {
            config: config.clone(),
            store: store.clone(),
            control: self.proxy.clone(),
            paths: self.paths.clone(),
            meta: meta.clone(),
            traffic_backend,
            workers: Some(worker.clone()),
            wiki_revision,
            shutdown: shutdown_tx,
        };
        let ingest_state = IngestState {
            store: store.clone(),
            ingest_key: self.config.proxy_access_key.clone(),
        };

        let mcp_state = McpState {
            store: store.clone(),
            meta: meta.clone(),
            config: config.clone(),
        };

        let _worker_handles = worker.spawn();

        // Keep the proxy up if the user/boot asked for it.
        let proxy_watch = self.proxy.clone();
        let _watch_handle = tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tick.tick().await;
                if let Err(err) = proxy_watch.ensure_desired() {
                    tracing::warn!(?err, "proxy watchdog restart failed");
                }
            }
        });

        let api_addr: SocketAddr = format!("127.0.0.1:{}", self.config.api_port).parse()?;
        let mcp_addr: SocketAddr = format!("127.0.0.1:{}", self.config.mcp_port).parse()?;

        // TCP keeps ingest (proxy → rivetd) + optional CLI curl on loopback.
        // Desktop never uses TCP — it talks control IPC (UDS / named pipe).
        let control_router = rivet_api::router(api_state.clone());
        let tcp_router = rivet_api::router(api_state).merge(rivet_ingest::router(ingest_state));
        let api_listener = tokio::net::TcpListener::bind(api_addr).await?;
        info!(%api_addr, "rivet ingest+control loopback listening");
        info!(%mcp_addr, "rivet mcp listening");

        let control_paths = self.paths.clone();
        let control_serve = control_ipc::serve_control(control_paths, control_router);

        let proxy = self.proxy.clone();
        let clickhouse = self.clickhouse.clone();
        let mut api_shutdown_rx = shutdown_rx;
        let shutdown = async move {
            tokio::select! {
                _ = wait_for_shutdown_signal() => {}
                _ = async {
                    loop {
                        if *api_shutdown_rx.borrow() {
                            break;
                        }
                        if api_shutdown_rx.changed().await.is_err() {
                            break;
                        }
                    }
                } => {}
            }
        };

        let serve_result = tokio::select! {
            res = axum::serve(api_listener, tcp_router) => res.context("api serve"),
            res = control_serve => res.context("control ipc serve"),
            res = rivet_mcp::serve(mcp_addr, mcp_state) => res.context("mcp serve"),
            _ = shutdown => {
                info!("shutdown signaled — stopping sidecars");
                Ok(())
            }
        };
        let _ = proxy.stop();
        let _ = clickhouse.stop();
        // Best-effort cleanup of the unix control socket.
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(self.paths.control_sock().as_std_path());
        }
        serve_result
    }
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => {}
            _ = sigint.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn ensure_wiki_seed(paths: &rivet_core::RivetPaths) -> Result<()> {
    let dir = paths.wiki_dir().join("default");
    std::fs::create_dir_all(dir.as_std_path())?;
    let readme = dir.join("README.md");
    if !readme.exists() {
        std::fs::write(
            readme.as_std_path(),
            "# Rivet wiki\n\nEmpty project wiki. Enable the wiki capability (or set `wiki_model`) to auto-update this tree from traffic.\n",
        )?;
    }
    Ok(())
}
