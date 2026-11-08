//! Shared domain types for Rivet.
//!
//! "Traffic" / exportable tokens = prompts, completions, usage, session metadata.
//! Credentials and OAuth blobs are never part of export packages.

mod config;
mod embed;
mod paths;
mod proxy_config;
mod redact;
mod traffic;

pub use config::{localhost_port_free, Capabilities, RivetConfig};
pub use embed::{cosine, lexical_embed};
pub use paths::RivetPaths;
pub use proxy_config::{
    claude_mcp_json, claude_settings_json, codex_config_toml, render_proxy_config,
    write_proxy_config,
};
pub use redact::{redact_event, redact_text};
pub use traffic::{
    ExportManifest, ProviderKind, TrafficEvent, TrafficRole, UsageTotals,
};
