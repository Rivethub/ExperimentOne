//! Shared domain types for Rivet.
//!
//! "Traffic" / exportable tokens = prompts, completions, usage, session metadata.
//! Credentials and OAuth blobs are never part of export packages.

mod blobs;
mod chunk;
mod config;
pub mod control_ipc;
mod embed;
mod fusion;
mod harness;
mod http_guard;
mod paths;
pub mod pids;
pub mod platform;
mod project_id;
mod providers;
mod proxy_config;
mod redact;
mod scoring;
mod session_id;
mod startup;
mod traffic;
mod turns;

pub use blobs::{hydrate_event_content, hydrate_events, read_body_ref, resolve_body_ref};
pub use chunk::{chunk_text, looks_unembeddable};
pub use config::{localhost_port_free, Capabilities, RivetConfig};
pub use control_ipc::{control_endpoint, control_request, control_up, ControlIpcResponse};
pub use embed::{cosine, lexical_embed, LEXICAL_EMBED_DIMS, LEXICAL_SPACE};
pub use fusion::{
    fusion_score, gated_fused, hybrid_pool, literal_scan, passes_fusion_gate, rank_fused,
    reciprocal_rank_fusion, Fused, FusionItem, HitSource, HYBRID_RRF_K,
};
pub use scoring::{age_days_since, composite_score, recency_boost, temporal_decay};
pub use startup::{
    assemble_startup_memory, assemble_startup_memory_with_workspace, estimate_tokens,
    load_workspace_memory, trim_to_tokens, WorkspaceMemorySection, STARTUP_BUDGET_TOKENS,
    WORKSPACE_MEMORY_FILES,
};
pub use harness::{
    harness_target_for_provider, harness_user_ready, install_harness, install_harness_plugins,
    migrate_claude_connector_auth, HarnessInstallMode, HarnessInstallResult,
};
pub use http_guard::{host_is_loopback, origin_allowed};
pub use paths::RivetPaths;
pub use platform::{
    exe_name, exe_suffix, resolve_sidecar, sidecar_file_name, target_triple, which_bin,
};
pub use project_id::{encode_path_project_id, project_id_from_cwd, resolve_project_root};
pub use providers::{
    find_provider, login_flag_for, login_flag_for_method, normalize_provider_id, provider_catalog,
    LoginKind, ProviderCatalogEntry,
};
pub use proxy_config::{
    claude_mcp_json, claude_settings_json, codex_config_toml, render_proxy_config,
    write_proxy_config,
};
pub use redact::{redact_event, redact_text};
pub use session_id::{canonicalize_session_id, native_session_id};
pub use traffic::{
    conversations_from_events, CaptureQuality, ConversationSummary, ExportManifest, ProviderKind,
    TrafficEvent, TrafficRole, UsageTotals,
};
pub use turns::{normalize_event_turns, NormalizedTurn, TurnKind};
