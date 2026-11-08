//! Boots the local Rivet control plane and supervises proxy + ClickHouse sidecars.

mod clickhouse;
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
}

impl Runtime {
    pub fn bootstrap() -> Result<Self> {
        let paths = rivet_core::RivetPaths::discover()?;
        paths.ensure()?;
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
        })
    }

    pub async fn run(self) -> Result<()> {
        match self.proxy.start() {
            Ok(()) => info!("proxy sidecar ready"),
            Err(err) => {
                tracing::warn!(?err, "proxy not started (start from UI when binary is ready)")
            }
        }

        let mut clickhouse_url = rivet_store::ClickHouseTrafficStore::from_env_url();
        match self.clickhouse.start_if_available() {
            Ok(true) => {
                let url = self.clickhouse.http_url();
                info!(%url, "clickhouse sidecar ready");
                // Prefer explicit env; otherwise point dual-write at the local sidecar.
                if clickhouse_url.is_none() {
                    clickhouse_url = Some(url.clone());
                    std::env::set_var("RIVET_CLICKHOUSE_URL", &url);
                }
                if let Ok(ch) = ClickHouseTrafficStore::new(clickhouse_url.as_deref().unwrap_or(&url))
                {
                    if let Err(err) = ch.ensure_schema().await {
                        tracing::warn!(?err, "clickhouse ensure_schema failed (will retry on insert)");
                    } else {
                        info!("clickhouse schema ready (database rivet)");
                    }
                }
            }
            Ok(false) => info!("clickhouse skipped — SQLite-only"),
            Err(err) => tracing::warn!(?err, "clickhouse failed to start — SQLite-only"),
        }

        let store = self
            .stores
            .traffic_store_with_clickhouse(clickhouse_url.clone());
        let meta = self.stores.meta.clone();
        let config = Arc::new(RwLock::new(self.config.clone()));

        let traffic_backend = if clickhouse_url.is_some() {
            "sqlite+clickhouse"
        } else {
            "sqlite"
        };
        let api_state = ApiState {
            config: config.clone(),
            store: store.clone(),
            control: self.proxy.clone(),
            paths: self.paths.clone(),
            meta: meta.clone(),
            traffic_backend,
        };
        let ingest_state = IngestState {
            store: store.clone(),
        };

        let caps = config.read().await.capabilities.clone();
        let mcp_state = McpState {
            store: store.clone(),
            meta: meta.clone(),
            vector_search: caps.vector_search,
        };

        let worker = WorkerPool::new(store, meta, self.paths.clone(), self.config.clone());
        let _worker_handle = worker.spawn();

        let api_addr: SocketAddr = format!("127.0.0.1:{}", self.config.api_port).parse()?;
        let mcp_addr: SocketAddr = format!("127.0.0.1:{}", self.config.mcp_port).parse()?;

        let merged = rivet_api::router(api_state).merge(rivet_ingest::router(ingest_state));
        let api_listener = tokio::net::TcpListener::bind(api_addr).await?;
        info!(%api_addr, "rivet control+ingest listening");
        info!(%mcp_addr, "rivet mcp listening");

        tokio::select! {
            res = axum::serve(api_listener, merged) => res.context("api serve")?,
            res = rivet_mcp::serve(mcp_addr, mcp_state) => res.context("mcp serve")?,
        }
        Ok(())
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
