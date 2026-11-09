use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::paths::RivetPaths;

/// Feature flags driven by what the user has configured.
#[allow(clippy::struct_excessive_bools)] // Serde feature flags map 1:1 to config fields.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, ToSchema, JsonSchema)]
pub struct Capabilities {
    /// Keyword/SQL history via MCP always on once captures exist.
    pub mcp: bool,
    /// Lexical vector search over `ClickHouse` embeddings (on by default locally).
    pub vector_search: bool,
    /// Requires a text-generation model routed through the proxy (or stub wiki pages).
    pub wiki: bool,
    /// Enterprise / multi-user (disabled in local MVP).
    pub teams: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
pub struct RivetConfig {
    pub proxy_port: u16,
    pub api_port: u16,
    pub mcp_port: u16,
    pub clickhouse_http_port: u16,
    pub clickhouse_native_port: u16,
    /// Local NATS client port (`JetStream` job plane).
    #[serde(default = "default_nats_port")]
    pub nats_port: u16,
    /// Access key harnesses send to the proxy (not a provider credential).
    pub proxy_access_key: String,
    /// Localhost management API key for `CLIProxyAPI` credential/quota endpoints.
    #[serde(default)]
    pub management_secret: String,
    pub capabilities: Capabilities,
    /// Optional remote embedding model routed via the local proxy (`POST /v1/embeddings`).
    /// Setting this with a Codex [`Self::embedding_account_id`] enables remote search space.
    #[serde(default)]
    pub embedding_model: Option<String>,
    /// Codex account id (auth file stem) used for remote embeddings. `None` = lexical.
    #[serde(default)]
    pub embedding_account_id: Option<String>,
    /// Active `ClickHouse` embeddings space used for semantic search (`lexical` by default).
    #[serde(default = "default_embedding_space")]
    pub embedding_space: String,
    /// Optional model id routed via the local proxy for wiki / summary generation.
    #[serde(default)]
    pub wiki_model: Option<String>,
    /// Preferred account id for wiki / summary workers (proxy may still load-balance).
    #[serde(default)]
    pub wiki_account_id: Option<String>,
    /// Default project bucket for wiki upserts.
    #[serde(default = "default_wiki_project")]
    pub wiki_project_id: String,
    /// Sustained request rate for loopback API+ingest (`0` disables).
    #[serde(default = "default_rate_limit_rps")]
    pub rate_limit_rps: u32,
    /// Burst size for the loopback rate limiter.
    #[serde(default = "default_rate_limit_burst")]
    pub rate_limit_burst: u32,
    /// Expose Prometheus metrics at `GET /metrics` on the API port (loopback only).
    #[serde(default = "default_true")]
    pub metrics_enabled: bool,
}

fn default_wiki_project() -> String {
    "default".into()
}

fn default_embedding_space() -> String {
    crate::embed::LEXICAL_SPACE.into()
}

const fn default_nats_port() -> u16 {
    4222
}

const fn default_rate_limit_rps() -> u32 {
    500
}

const fn default_rate_limit_burst() -> u32 {
    1_000
}

const fn default_true() -> bool {
    true
}

const PROXY_PORT_FALLBACKS: &[u16] = &[18317, 18741, 28417, 38417, 48417, 5817];

impl Default for RivetConfig {
    fn default() -> Self {
        let key = generate_access_key();
        Self {
            // 18317 avoids common Docker / local stacks on 8317.
            proxy_port: 18317,
            api_port: 8741,
            mcp_port: 8742,
            clickhouse_http_port: 8123,
            clickhouse_native_port: 9000,
            nats_port: default_nats_port(),
            proxy_access_key: key.clone(),
            management_secret: key,
            capabilities: Capabilities {
                mcp: true,
                // Lexical vectors + structured wiki run locally without models.
                vector_search: true,
                wiki: true,
                teams: false,
            },
            embedding_model: None,
            embedding_account_id: None,
            embedding_space: default_embedding_space(),
            wiki_model: None,
            wiki_account_id: None,
            wiki_project_id: default_wiki_project(),
            rate_limit_rps: default_rate_limit_rps(),
            rate_limit_burst: default_rate_limit_burst(),
            metrics_enabled: true,
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
            cfg.ensure_management_secret();
            cfg.sync_capabilities_from_models();
            cfg.save(paths)?;
            Ok(cfg)
        } else {
            let cfg = Self::default();
            cfg.save(paths)?;
            Ok(cfg)
        }
    }

    /// Management API stays localhost-only. Prefer a distinct secret from the
    /// harness access key so leaking one does not unlock credential download.
    pub fn ensure_management_secret(&mut self) {
        if self.management_secret.trim().is_empty()
            || self.management_secret == self.proxy_access_key
        {
            self.management_secret = generate_access_key();
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
        if self.embedding_model.as_ref().is_some_and(|s| !s.trim().is_empty()) {
            self.capabilities.vector_search = true;
        }
        if self.wiki_model.as_ref().is_some_and(|s| !s.trim().is_empty()) {
            self.capabilities.wiki = true;
        }
        if self.embedding_space.trim().is_empty() {
            self.embedding_space = default_embedding_space();
        }
        self.capabilities.mcp = true;
    }

    /// Resolved search space (`lexical` when unset/blank).
    pub fn active_embedding_space(&self) -> &str {
        let s = self.embedding_space.trim();
        if s.is_empty() {
            crate::embed::LEXICAL_SPACE
        } else {
            s
        }
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
    pub fn ensure_available_proxy_port(
        &mut self,
        paths: &RivetPaths,
    ) -> anyhow::Result<Option<u16>> {
        if localhost_port_free(self.proxy_port) {
            return Ok(None);
        }
        let previous = self.proxy_port;
        for &candidate in PROXY_PORT_FALLBACKS {
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
