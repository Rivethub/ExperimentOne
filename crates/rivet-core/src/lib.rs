//! Shared domain types for Rivet.
//!
//! "Traffic" / exportable tokens = prompts, completions, usage, session metadata.
//! Credentials and OAuth blobs are never part of export packages.

mod blobs;
mod config;
pub mod control_ipc;
mod embed;
mod harness;
mod http_guard;
mod paths;
pub mod pids;
pub mod platform;
mod providers;
mod proxy_config;
mod redact;
mod traffic;

pub use blobs::{hydrate_event_content, hydrate_events, read_body_ref, resolve_body_ref};
pub use config::{localhost_port_free, Capabilities, RivetConfig};
pub use control_ipc::{control_endpoint, control_request, control_up, ControlIpcResponse};
pub use embed::{cosine, lexical_embed, LEXICAL_EMBED_DIMS, LEXICAL_SPACE};
pub use harness::{
    harness_target_for_provider, harness_user_ready, install_harness,
    migrate_claude_connector_auth, HarnessInstallMode, HarnessInstallResult,
};
pub use http_guard::{host_is_loopback, origin_allowed};
pub use paths::RivetPaths;
pub use platform::{
    exe_name, exe_suffix, resolve_sidecar, sidecar_file_name, target_triple, which_bin,
};
pub use providers::{
    find_provider, login_flag_for, login_flag_for_method, normalize_provider_id, provider_catalog,
    LoginKind, ProviderCatalogEntry,
};
pub use proxy_config::{
    claude_mcp_json, claude_settings_json, codex_config_toml, render_proxy_config,
    write_proxy_config,
};
pub use redact::{redact_event, redact_text};
pub use traffic::{
    conversations_from_events, CaptureQuality, ConversationSummary, ExportManifest, ProviderKind,
    TrafficEvent, TrafficRole, UsageTotals,
};
