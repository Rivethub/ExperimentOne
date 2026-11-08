use serde::{Deserialize, Serialize};

use crate::paths::RivetPaths;

/// Feature flags driven by what the user has configured.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Capabilities {
    /// Keyword/SQL history via MCP always on once traffic exists.
    pub mcp: bool,
    /// Requires an embedding model routed through the proxy (or local lexical fallback).
    pub vector_search: bool,
    /// Requires a text-generation model routed through the proxy (or stub wiki pages).
    pub wiki: bool,
    /// Enterprise / multi-user (disabled in local MVP).
    pub teams: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RivetConfig {
    pub proxy_port: u16,
    pub api_port: u16,
    pub mcp_port: u16,
    pub clickhouse_http_port: u16,
    pub clickhouse_native_port: u16,
    /// Access key harnesses send to the proxy (not a provider credential).
    pub proxy_access_key: String,
    pub capabilities: Capabilities,
    /// Optional model id routed via the local proxy for embeddings.
    #[serde(default)]
    pub embedding_model: Option<String>,
    /// Optional model id routed via the local proxy for wiki generation.
    #[serde(default)]
    pub wiki_model: Option<String>,
    /// Default project bucket for wiki upserts.
    #[serde(default = "default_wiki_project")]
    pub wiki_project_id: String,
}

fn default_wiki_project() -> String {
    "default".into()
}

impl Default for RivetConfig {
    fn default() -> Self {
        Self {
            // 18317 avoids common Docker / local stacks on 8317.
            proxy_port: 18317,
            api_port: 8741,
            mcp_port: 8742,
            clickhouse_http_port: 8123,
            clickhouse_native_port: 9000,
            proxy_access_key: generate_access_key(),
            capabilities: Capabilities {
                mcp: true,
                // Lexical vectors + structured wiki run locally without models.
                vector_search: true,
                wiki: true,
                teams: false,
            },
            embedding_model: None,
            wiki_model: None,
            wiki_project_id: default_wiki_project(),
        }
    }
}

impl RivetConfig {
    pub fn load_or_init(paths: &RivetPaths) -> anyhow::Result<Self> {
        paths.ensure()?;
        let file = paths.config_file();
        if file.exists() {
            let raw = std::fs::read_to_string(file.as_std_path())?;
            let mut cfg: Self = serde_json::from_str(&raw)?;
            cfg.sync_capabilities_from_models();
            Ok(cfg)
        } else {
            let cfg = Self::default();
            cfg.save(paths)?;
            Ok(cfg)
        }
    }

    pub fn save(&self, paths: &RivetPaths) -> anyhow::Result<()> {
        paths.ensure()?;
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(paths.config_file().as_std_path(), raw)?;
        Ok(())
    }

    /// Turn on optional capabilities when models are configured.
    pub fn sync_capabilities_from_models(&mut self) {
        if self
            .embedding_model
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            self.capabilities.vector_search = true;
        }
        if self
            .wiki_model
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            self.capabilities.wiki = true;
        }
        self.capabilities.mcp = true;
    }

    pub fn proxy_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.proxy_port)
    }

    pub fn api_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.api_port)
    }

    pub fn mcp_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.mcp_port)
    }

    /// If `proxy_port` cannot be bound, pick a free localhost alternative and save.
    /// Returns `Some(new_port)` when migrated.
    pub fn ensure_available_proxy_port(&mut self, paths: &RivetPaths) -> anyhow::Result<Option<u16>> {
        if localhost_port_free(self.proxy_port) {
            return Ok(None);
        }
        let previous = self.proxy_port;
        const CANDIDATES: &[u16] = &[18317, 18741, 28417, 38417, 48417, 5817];
        for &candidate in CANDIDATES {
            if candidate == previous {
                continue;
            }
            if localhost_port_free(candidate) {
                self.proxy_port = candidate;
                self.save(paths)?;
                return Ok(Some(candidate));
            }
        }
        anyhow::bail!(
            "proxy port {previous} is busy and no fallback localhost port is free — set proxy_port in config.json"
        )
    }
}

/// True when nothing is listening / bound on 127.0.0.1:`port`.
pub fn localhost_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn generate_access_key() -> String {
    format!("rivet_{}", uuid::Uuid::new_v4().simple())
}
