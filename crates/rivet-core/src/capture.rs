use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::providers::normalize_provider_id;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, ToSchema, JsonSchema)]
pub enum ProviderKind {
    Claude,
    Codex,
    OpenAi,
    Gemini,
    Antigravity,
    Kimi,
    KimiAi,
    Xai,
    Meta,
    Devin,
    Vertex,
    Cursor,
    Other,
}

impl ProviderKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
            Self::Antigravity => "antigravity",
            Self::Kimi => "kimi",
            Self::KimiAi => "kimi-ai",
            Self::Xai => "xai",
            Self::Meta => "meta",
            Self::Devin => "devin",
            Self::Vertex => "vertex",
            Self::Cursor => "cursor",
            Self::Other => "other",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match normalize_provider_id(raw).as_str() {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            "openai" | "open_ai" => Self::OpenAi,
            "gemini" => Self::Gemini,
            "antigravity" => Self::Antigravity,
            "kimi" => Self::Kimi,
            "kimi-ai" => Self::KimiAi,
            "xai" => Self::Xai,
            "meta" => Self::Meta,
            "devin" => Self::Devin,
            "vertex" => Self::Vertex,
            "cursor" => Self::Cursor,
            _ => Self::Other,
        }
    }
}

/// How the event was captured / how trustworthy the session linkage is.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, ToSchema, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum CaptureQuality {
    /// Live proxy capture with a real harness session marker.
    #[default]
    Wire,
    /// Live proxy capture grouped by a soft hash (no harness session id).
    Soft,
    /// Imported from a local harness transcript on disk.
    Imported,
}

impl CaptureQuality {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Wire => "wire",
            Self::Soft => "soft",
            Self::Imported => "imported",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "soft" | "soft-id" | "soft_id" => Self::Soft,
            "imported" | "import" | "local" => Self::Imported,
            _ => Self::Wire,
        }
    }

    /// Lower fidelity wins when summarizing a conversation.
    #[must_use]
    pub const fn worse(self, other: Self) -> Self {
        match (self, other) {
            (Self::Soft, _) | (_, Self::Soft) => Self::Soft,
            (Self::Imported, _) | (_, Self::Imported) => Self::Imported,
            _ => Self::Wire,
        }
    }
}

impl Serialize for ProviderKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ProviderKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(Self::parse(&s))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CaptureRole {
    System,
    User,
    Assistant,
    Tool,
    Unknown,
}

/// One captured unit of proxy captures. Safe to export (no credentials).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
pub struct CaptureEvent {
    pub id: Uuid,
    pub ts: DateTime<Utc>,
    pub provider: ProviderKind,
    pub account_label: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    /// Hard-evidence project id only: explicit API/header field, or the harness's own project key
    /// (e.g. Claude/Cursor `projects/<id>/` folder). Never inferred from cwd or prompt text.
    pub project_id: Option<String>,
    /// Working-directory signal when present on wire or local transcript. Soft context for workers —
    /// not promoted to `project_id` by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub request_id: Option<String>,
    pub role: CaptureRole,
    pub content: Option<String>,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub latency_ms: Option<u64>,
    pub status_code: Option<u16>,
    /// Relative path under blobs/ when body was spilled to disk.
    pub body_ref: Option<String>,
    /// Capture fidelity: `wire`, `soft`, or `imported`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_quality: Option<CaptureQuality>,
    /// Soft fingerprint that this wire session supersedes (soft→wire upgrade).
    /// Not persisted to `ClickHouse` — ingest records it into meta aliases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soft_alias: Option<String>,
    /// Subagent id from proxy headers (e.g. `x-claude-code-agent-id`). Absent on main turns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Parent agent id when nested (`x-claude-code-parent-agent-id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_agent_id: Option<String>,
    /// Parent session when child uses its own session id (e.g. `OpenCode` `x-parent-session-id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// Request class: `main` | `subagent` | `workflow` | `compaction` | `auxiliary`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_class: Option<String>,
    /// Agent type / name when present (`x-claude-code-agent-type`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Anthropic / `OpenAI` cache-read tokens (also folded into `tokens_in`).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub cache_read_tokens: u32,
    /// Anthropic cache-creation tokens (also folded into `tokens_in`).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub cache_creation_tokens: u32,
    /// Thinking / reasoning tokens when reported separately.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub thinking_tokens: u32,
    /// Git branch from request `git_state` when present on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Git repo root / remote from `git_state` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_repo: Option<String>,
    /// Task lineage id from headers / body metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Turn lineage id from headers / body metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Hostname of the winning upstream attempt (credential pool).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_host: Option<String>,
    /// Number of upstream credential attempts (failover > 1).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub attempt_count: u32,
    /// Provider stop / finish reason when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// Comma-separated tool names invoked on this turn (wire parse).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<String>,
    /// Whether the captured stream looked complete (`[DONE]` / `message_stop`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_complete: Option<bool>,
    /// Client request path (`/v1/messages`, `/v1/responses`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_path: Option<String>,
    /// Wire API shape: `anthropic_messages` | `openai_chat` | `openai_responses` | `gemini` | …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
    /// Provider error type/code when status ≥ 400 or body is an error envelope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
    /// Short provider error message (redacted/truncated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Credential-pool `auth_id` from the winning upstream attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_id: Option<String>,
    /// True when thinking/reasoning blocks were present on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_thinking: Option<bool>,
    /// Count of image/file/audio/video parts seen in request/response.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub media_count: u32,
    /// Number of tool/function invocations observed on this turn.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub tool_call_count: u32,
}

impl CaptureEvent {
    pub fn new(provider: ProviderKind) -> Self {
        Self {
            id: Uuid::new_v4(),
            ts: Utc::now(),
            provider,
            account_label: None,
            model: None,
            session_id: None,
            project_id: None,
            cwd: None,
            request_id: None,
            role: CaptureRole::Unknown,
            content: None,
            tokens_in: 0,
            tokens_out: 0,
            latency_ms: None,
            status_code: None,
            body_ref: None,
            capture_quality: None,
            soft_alias: None,
            agent_id: None,
            parent_agent_id: None,
            parent_session_id: None,
            request_class: None,
            agent_type: None,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            thinking_tokens: 0,
            git_branch: None,
            git_repo: None,
            task_id: None,
            turn_id: None,
            upstream_host: None,
            attempt_count: 0,
            stop_reason: None,
            tool_names: None,
            stream_complete: None,
            request_path: None,
            api_format: None,
            error_type: None,
            error_message: None,
            auth_id: None,
            has_thinking: None,
            media_count: 0,
            tool_call_count: 0,
        }
    }

    /// Stable conversation key used by the Data pane and conversation APIs.
    pub fn conversation_id(&self) -> String {
        self.session_id
            .as_deref()
            .map(str::trim)
            .filter(|session| !session.is_empty())
            .map_or_else(|| format!("event:{}", self.id), str::to_string)
    }

    /// True when this event was issued by a subagent (header-detected).
    #[must_use]
    pub fn is_subagent(&self) -> bool {
        if self.agent_id.as_deref().is_some_and(|s| !s.trim().is_empty()) {
            return true;
        }
        if self.parent_session_id.as_deref().is_some_and(|s| !s.trim().is_empty()) {
            return true;
        }
        self.request_class.as_deref().is_some_and(|c| {
            matches!(c.trim().to_ascii_lowercase().as_str(), "subagent" | "workflow")
        })
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, ToSchema, JsonSchema)]
pub struct UsageTotals {
    pub events: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

/// One historical conversation, projected from capture events sharing a session.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
pub struct ConversationSummary {
    /// `session_id`, or `event:{uuid}` when the event has no session.
    pub id: String,
    pub title: String,
    pub preview: Option<String>,
    pub provider: ProviderKind,
    pub model: Option<String>,
    pub project_id: Option<String>,
    /// Latest captured cwd signal for the conversation (not a classified project).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub message_count: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// Worst fidelity seen in the conversation (`soft` < `imported` < `wire`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_quality: Option<CaptureQuality>,
    /// Distinct subagent ids observed in this conversation (from proxy headers).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_ids: Vec<String>,
    /// Events tagged as subagent / workflow turns.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub subagent_events: u64,
    /// Sum of cache-read tokens across the conversation.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub cache_read_tokens: u64,
    /// Sum of thinking / reasoning tokens across the conversation.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub thinking_tokens: u64,
    /// Distinct tool names observed on the wire.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_names: Vec<String>,
    /// Latest git branch signal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Events that included thinking/reasoning on the wire.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub thinking_events: u64,
    /// Sum of media parts across the conversation.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub media_count: u64,
    /// Events with an error envelope / non-success capture.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub error_events: u64,
    /// Latest observed API format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde `skip_serializing_if` requires `&T`
const fn is_zero_u64(n: &u64) -> bool {
    *n == 0
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde `skip_serializing_if` requires `&T`
const fn is_zero_u32(n: &u32) -> bool {
    *n == 0
}

fn clip_text(raw: &str, max: usize) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() > max {
        format!("{}…", &flat[..max])
    } else {
        flat
    }
}

/// Best-effort human title from stored request/response JSON or plain text.
fn conversation_title_text(ev: &CaptureEvent) -> Option<String> {
    let raw = ev.content.as_deref()?.split("\n---\n").next()?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(msgs) = v.get("messages").and_then(|m| m.as_array()) {
            for msg in msgs.iter().rev() {
                if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
                    continue;
                }
                if let Some(s) = msg.get("content").and_then(|c| c.as_str()) {
                    let t = s.trim();
                    if !t.is_empty() {
                        return Some(clip_text(t, 72));
                    }
                }
                if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                    for block in arr {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                let t = t.trim();
                                if !t.is_empty() {
                                    return Some(clip_text(t, 72));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Skip raw JSON blobs as titles.
    if raw.starts_with('{') || raw.starts_with('[') {
        return None;
    }
    Some(clip_text(raw, 72))
}

fn conversation_preview_text(ev: &CaptureEvent) -> Option<String> {
    let raw = ev.content.as_deref()?;
    let half = raw.split("\n---\n").nth(1).unwrap_or(raw).trim();
    if half.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(half) {
        if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
            for block in content {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        return Some(clip_text(t, 120));
                    }
                }
            }
        }
        if let Some(msg) = v.pointer("/choices/0/message/content").and_then(|c| c.as_str()) {
            return Some(clip_text(msg, 120));
        }
    }
    if half.starts_with('{') || half.starts_with('[') || half.starts_with("data:") {
        return None;
    }
    Some(clip_text(half, 120))
}

/// Group flat capture events into conversation summaries (newest first).
#[allow(clippy::too_many_lines)]
pub fn conversations_from_events(events: &[CaptureEvent], limit: u32) -> Vec<ConversationSummary> {
    use std::collections::HashMap;

    struct Acc<'a> {
        first: &'a CaptureEvent,
        last: &'a CaptureEvent,
        title_src: &'a CaptureEvent,
        message_count: u64,
        tokens_in: u64,
        tokens_out: u64,
        capture_quality: Option<CaptureQuality>,
        agent_ids: std::collections::BTreeSet<String>,
        subagent_events: u64,
        cache_read_tokens: u64,
        thinking_tokens: u64,
        tool_names: std::collections::BTreeSet<String>,
        git_branch: Option<String>,
        thinking_events: u64,
        media_count: u64,
        error_events: u64,
        api_format: Option<String>,
    }

    let mut by_id: HashMap<String, Acc<'_>> = HashMap::new();
    for ev in events {
        let id = ev.conversation_id();
        let quality = ev.capture_quality.or_else(|| {
            ev.session_id.as_deref().and_then(|session| {
                if session.starts_with("soft:") {
                    Some(CaptureQuality::Soft)
                } else {
                    None
                }
            })
        });
        let agent =
            ev.agent_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let sub = u64::from(ev.is_subagent());
        let tools = ev.tool_names.as_deref().unwrap_or("").split(',').filter_map(|s| {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        });
        let thinking_hit = u64::from(ev.has_thinking.unwrap_or(false) || ev.thinking_tokens > 0);
        let error_hit = u64::from(
            ev.error_type.as_deref().is_some_and(|s| !s.trim().is_empty())
                || ev.status_code.is_some_and(|c| c >= 400),
        );
        if let Some(acc) = by_id.get_mut(&id) {
            acc.message_count += 1;
            acc.tokens_in += u64::from(ev.tokens_in);
            acc.tokens_out += u64::from(ev.tokens_out);
            acc.subagent_events += sub;
            acc.cache_read_tokens += u64::from(ev.cache_read_tokens);
            acc.thinking_tokens += u64::from(ev.thinking_tokens);
            acc.thinking_events += thinking_hit;
            acc.media_count += u64::from(ev.media_count);
            acc.error_events += error_hit;
            for tool in tools {
                acc.tool_names.insert(tool);
            }
            if let Some(branch) = ev.git_branch.as_deref().map(str::trim).filter(|s| !s.is_empty())
            {
                acc.git_branch = Some(branch.to_string());
            }
            if let Some(fmt) = ev.api_format.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                acc.api_format = Some(fmt.to_string());
            }
            if let Some(aid) = agent {
                acc.agent_ids.insert(aid);
            }
            if ev.ts < acc.first.ts {
                acc.first = ev;
            }
            if ev.ts >= acc.last.ts {
                acc.last = ev;
            }
            // Prefer earliest user message as the title source.
            let better_title = matches!(ev.role, CaptureRole::User)
                && (ev.ts <= acc.title_src.ts || !matches!(acc.title_src.role, CaptureRole::User));
            if better_title {
                acc.title_src = ev;
            }
            acc.capture_quality = match (acc.capture_quality, quality) {
                (Some(prev), Some(next)) => Some(prev.worse(next)),
                (None, next) => next,
                (prev, None) => prev,
            };
        } else {
            let mut agent_ids = std::collections::BTreeSet::new();
            if let Some(aid) = agent {
                agent_ids.insert(aid);
            }
            let mut tool_names = std::collections::BTreeSet::new();
            for tool in tools {
                tool_names.insert(tool);
            }
            by_id.insert(
                id,
                Acc {
                    first: ev,
                    last: ev,
                    title_src: ev,
                    message_count: 1,
                    tokens_in: u64::from(ev.tokens_in),
                    tokens_out: u64::from(ev.tokens_out),
                    capture_quality: quality,
                    agent_ids,
                    subagent_events: sub,
                    cache_read_tokens: u64::from(ev.cache_read_tokens),
                    thinking_tokens: u64::from(ev.thinking_tokens),
                    tool_names,
                    git_branch: ev
                        .git_branch
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                    thinking_events: thinking_hit,
                    media_count: u64::from(ev.media_count),
                    error_events: error_hit,
                    api_format: ev
                        .api_format
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                },
            );
        }
    }

    let mut out: Vec<ConversationSummary> = by_id
        .into_iter()
        .map(|(id, acc)| {
            let title = conversation_title_text(acc.title_src).unwrap_or_else(|| {
                acc.last
                    .model
                    .clone()
                    .unwrap_or_else(|| format!("{} conversation", acc.last.provider.as_str()))
            });
            let preview = conversation_preview_text(acc.last);
            ConversationSummary {
                id,
                title,
                preview,
                provider: acc.last.provider,
                model: acc.last.model.clone(),
                project_id: acc.last.project_id.clone(),
                cwd: acc.last.cwd.clone(),
                started_at: acc.first.ts,
                updated_at: acc.last.ts,
                message_count: acc.message_count,
                tokens_in: acc.tokens_in,
                tokens_out: acc.tokens_out,
                capture_quality: acc.capture_quality,
                agent_ids: acc.agent_ids.into_iter().take(24).collect(),
                subagent_events: acc.subagent_events,
                cache_read_tokens: acc.cache_read_tokens,
                thinking_tokens: acc.thinking_tokens,
                tool_names: acc.tool_names.into_iter().take(24).collect(),
                git_branch: acc.git_branch,
                thinking_events: acc.thinking_events,
                media_count: acc.media_count,
                error_events: acc.error_events,
                api_format: acc.api_format,
            }
        })
        .collect();
    out.sort_by_key(|summary| std::cmp::Reverse(summary.updated_at));
    out.truncate(limit.max(1) as usize);
    out
}

/// Manifest inside a `.rivetbag` export. Credentials are never included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportManifest {
    pub schema_version: u32,
    pub created_at: DateTime<Utc>,
    pub event_count: u64,
    pub includes_embeddings: bool,
    pub includes_wiki: bool,
    pub note: Option<String>,
}

impl ExportManifest {
    pub const SCHEMA_VERSION: u32 = 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn groups_events_by_session_id() {
        let mut first = CaptureEvent::new(ProviderKind::Claude);
        first.session_id = Some("s1".into());
        first.role = CaptureRole::User;
        first.content = Some("Hello from user".into());
        first.ts = Utc::now() - Duration::minutes(2);

        let mut second = CaptureEvent::new(ProviderKind::Claude);
        second.session_id = Some("s1".into());
        second.role = CaptureRole::Assistant;
        second.content = Some("Hi there".into());
        second.ts = Utc::now() - Duration::minutes(1);

        let mut other = CaptureEvent::new(ProviderKind::Codex);
        other.session_id = Some("s2".into());
        other.role = CaptureRole::User;
        other.content = Some("Other thread".into());

        let list = conversations_from_events(&[first, second, other], 10);
        assert_eq!(list.len(), 2);
        let session_one = list.iter().find(|summary| summary.id == "s1").expect("s1");
        assert_eq!(session_one.message_count, 2);
        assert!(session_one.title.contains("Hello"));
    }
}
