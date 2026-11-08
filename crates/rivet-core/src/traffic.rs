use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

use crate::providers::normalize_provider_id;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
            _ => Self::Other,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrafficRole {
    System,
    User,
    Assistant,
    Tool,
    Unknown,
}

/// One captured unit of proxy traffic. Safe to export (no credentials).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficEvent {
    pub id: Uuid,
    pub ts: DateTime<Utc>,
    pub provider: ProviderKind,
    pub account_label: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub request_id: Option<String>,
    pub role: TrafficRole,
    pub content: Option<String>,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub latency_ms: Option<u64>,
    pub status_code: Option<u16>,
    /// Relative path under blobs/ when body was spilled to disk.
    pub body_ref: Option<String>,
}

impl TrafficEvent {
    pub fn new(provider: ProviderKind) -> Self {
        Self {
            id: Uuid::new_v4(),
            ts: Utc::now(),
            provider,
            account_label: None,
            model: None,
            session_id: None,
            project_id: None,
            request_id: None,
            role: TrafficRole::Unknown,
            content: None,
            tokens_in: 0,
            tokens_out: 0,
            latency_ms: None,
            status_code: None,
            body_ref: None,
        }
    }

    /// Stable conversation key used by the Data pane and conversation APIs.
    pub fn conversation_id(&self) -> String {
        match self
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(sid) => sid.to_string(),
            None => format!("event:{}", self.id),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct UsageTotals {
    pub events: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

/// One historical conversation, projected from traffic events sharing a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    /// `session_id`, or `event:{uuid}` when the event has no session.
    pub id: String,
    pub title: String,
    pub preview: Option<String>,
    pub provider: ProviderKind,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub message_count: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
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
fn conversation_title_text(ev: &TrafficEvent) -> Option<String> {
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

fn conversation_preview_text(ev: &TrafficEvent) -> Option<String> {
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
        if let Some(msg) = v
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
        {
            return Some(clip_text(msg, 120));
        }
    }
    if half.starts_with('{') || half.starts_with('[') || half.starts_with("data:") {
        return None;
    }
    Some(clip_text(half, 120))
}

/// Group flat traffic events into conversation summaries (newest first).
pub fn conversations_from_events(events: &[TrafficEvent], limit: u32) -> Vec<ConversationSummary> {
    use std::collections::HashMap;

    struct Acc<'a> {
        first: &'a TrafficEvent,
        last: &'a TrafficEvent,
        title_src: &'a TrafficEvent,
        message_count: u64,
        tokens_in: u64,
        tokens_out: u64,
    }

    let mut by_id: HashMap<String, Acc<'_>> = HashMap::new();
    for ev in events {
        let id = ev.conversation_id();
        match by_id.get_mut(&id) {
            Some(acc) => {
                acc.message_count += 1;
                acc.tokens_in += u64::from(ev.tokens_in);
                acc.tokens_out += u64::from(ev.tokens_out);
                if ev.ts < acc.first.ts {
                    acc.first = ev;
                }
                if ev.ts >= acc.last.ts {
                    acc.last = ev;
                }
                // Prefer earliest user message as the title source.
                let better_title = matches!(ev.role, TrafficRole::User)
                    && (ev.ts <= acc.title_src.ts || !matches!(acc.title_src.role, TrafficRole::User));
                if better_title {
                    acc.title_src = ev;
                }
            }
            None => {
                by_id.insert(
                    id,
                    Acc {
                        first: ev,
                        last: ev,
                        title_src: ev,
                        message_count: 1,
                        tokens_in: u64::from(ev.tokens_in),
                        tokens_out: u64::from(ev.tokens_out),
                    },
                );
            }
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
                started_at: acc.first.ts,
                updated_at: acc.last.ts,
                message_count: acc.message_count,
                tokens_in: acc.tokens_in,
                tokens_out: acc.tokens_out,
            }
        })
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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

    #[test]
    fn groups_events_by_session_id() {
        let mut a = TrafficEvent::new(ProviderKind::Claude);
        a.session_id = Some("s1".into());
        a.role = TrafficRole::User;
        a.content = Some("Hello from user".into());
        a.ts = Utc::now() - Duration::minutes(2);

        let mut b = TrafficEvent::new(ProviderKind::Claude);
        b.session_id = Some("s1".into());
        b.role = TrafficRole::Assistant;
        b.content = Some("Hi there".into());
        b.ts = Utc::now() - Duration::minutes(1);

        let mut c = TrafficEvent::new(ProviderKind::Codex);
        c.session_id = Some("s2".into());
        c.role = TrafficRole::User;
        c.content = Some("Other thread".into());

        let list = conversations_from_events(&[a, b, c], 10);
        assert_eq!(list.len(), 2);
        let s1 = list.iter().find(|c| c.id == "s1").expect("s1");
        assert_eq!(s1.message_count, 2);
        assert!(s1.title.contains("Hello"));
    }
}
