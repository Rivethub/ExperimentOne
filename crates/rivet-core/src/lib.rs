//! Shared domain types for Rivet.
//!
//! "Traffic" / exportable tokens = prompts, completions, usage, session metadata.
//! Credentials and OAuth blobs are never part of export packages.

mod config;
mod embed;
mod http_guard;
mod paths;
pub mod pids;
pub mod platform;
mod providers;
mod proxy_config;
mod redact;
mod traffic;

pub use config::{localhost_port_free, Capabilities, RivetConfig};
pub use http_guard::{host_is_loopback, origin_allowed};
pub use embed::{cosine, lexical_embed};
pub use paths::RivetPaths;
pub use platform::{
    exe_name, exe_suffix, resolve_sidecar, sidecar_file_name, target_triple, which_bin,
};
pub use providers::{
    find_provider, login_flag_for, normalize_provider_id, provider_catalog, LoginKind,
    ProviderCatalogEntry,
};
pub use proxy_config::{
    claude_mcp_json, claude_settings_json, codex_config_toml, render_proxy_config,
    write_proxy_config,
};
pub use redact::{redact_event, redact_text};
pub use traffic::{
    ExportManifest, ProviderKind, TrafficEvent, TrafficRole, UsageTotals,
};
