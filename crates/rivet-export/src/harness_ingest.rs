//! Import local harness transcripts (Claude Code / Codex / Cursor) into Rivet captures.
//! Read-only observation of files those tools already write — no harness plugins.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rivet_core::{redact_event, CaptureQuality, ProviderKind, CaptureEvent, CaptureRole};
use rivet_store::CaptureStore;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

const EVENT_NS: Uuid = Uuid::from_bytes([
    0x72, 0x69, 0x76, 0x65, 0x74, 0x2d, 0x69, 0x6e, 0x67, 0x65, 0x73, 0x74, 0x2d, 0x6c, 0x6f, 0x63,
]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalSource {
    Claude,
    Codex,
    Cursor,
}

impl LocalSource {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "cursor" => Some(Self::Cursor),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LocalIngestOptions {
    pub sources: Vec<LocalSource>,
    pub claude_root: Option<PathBuf>,
    pub codex_root: Option<PathBuf>,
    pub cursor_root: Option<PathBuf>,
    pub dry_run: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalSourceReport {
    pub source: String,
    pub root: String,
    pub files_scanned: u64,
    pub events_parsed: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalIngestReport {
    pub dry_run: bool,
    pub files_scanned: u64,
    pub events_parsed: u64,
    pub events_inserted: u64,
    pub events_skipped_existing: u64,
    pub sources: Vec<LocalSourceReport>,
}

pub async fn ingest_local(
    store: Arc<dyn CaptureStore>,
    opts: LocalIngestOptions,
) -> Result<LocalIngestReport> {
    let sources = if opts.sources.is_empty() {
        vec![LocalSource::Claude, LocalSource::Codex, LocalSource::Cursor]
    } else {
        opts.sources.clone()
    };

    let mut events = Vec::new();
    let mut source_reports = Vec::new();
    let mut files_scanned = 0u64;
    let limit = opts.limit.unwrap_or(usize::MAX);

    for source in sources {
        if events.len() >= limit {
            break;
        }
        let root = match source {
            LocalSource::Claude => {
                opts.claude_root.clone().unwrap_or_else(default_claude_projects_root)
            },
            LocalSource::Codex => {
                opts.codex_root.clone().unwrap_or_else(default_codex_sessions_root)
            },
            LocalSource::Cursor => {
                opts.cursor_root.clone().unwrap_or_else(default_cursor_projects_root)
            },
        };
        let before = events.len();
        let mut files = 0u64;
        if root.is_dir() {
            let mut visit = |path: &Path| {
                if events.len() >= limit {
                    return;
                }
                files += 1;
                let remaining = limit.saturating_sub(events.len());
                match source {
                    LocalSource::Claude => {
                        if let Ok(parsed) = parse_claude_jsonl(path, remaining) {
                            events.extend(parsed);
                        }
                    },
                    LocalSource::Codex => {
                        if let Ok(parsed) = parse_codex_jsonl(path, remaining) {
                            events.extend(parsed);
                        }
                    },
                    LocalSource::Cursor => {
                        if let Ok(parsed) = parse_cursor_jsonl(path, remaining) {
                            events.extend(parsed);
                        }
                    },
                }
            };
            if source == LocalSource::Cursor {
                collect_cursor_transcripts(&root, &mut visit);
            } else {
                collect_jsonl_files(&root, &mut visit);
            }
        }
        let parsed = (events.len() - before) as u64;
        files_scanned += files;
        source_reports.push(LocalSourceReport {
            source: source.as_str().into(),
            root: root.display().to_string(),
            files_scanned: files,
            events_parsed: parsed,
        });
    }

    for ev in &mut events {
        if ev.capture_quality.is_none() {
            ev.capture_quality = Some(CaptureQuality::Imported);
        }
        redact_event(ev);
    }

    let events_parsed = events.len() as u64;
    if opts.dry_run {
        return Ok(LocalIngestReport {
            dry_run: true,
            files_scanned,
            events_parsed,
            events_inserted: 0,
            events_skipped_existing: 0,
            sources: source_reports,
        });
    }

    let ids: Vec<String> = events.iter().map(|e| e.id.to_string()).collect();
    let mut existing = std::collections::HashSet::new();
    for chunk in ids.chunks(500) {
        for ev in store.get_by_ids(chunk).await? {
            existing.insert(ev.id);
        }
    }
    let new_events: Vec<_> = events.into_iter().filter(|e| !existing.contains(&e.id)).collect();
    let skipped = events_parsed.saturating_sub(new_events.len() as u64);
    let inserted = new_events.len() as u64;
    if !new_events.is_empty() {
        store.insert_batch(&new_events).await?;
    }

    Ok(LocalIngestReport {
        dry_run: false,
        files_scanned,
        events_parsed,
        events_inserted: inserted,
        events_skipped_existing: skipped,
        sources: source_reports,
    })
}

pub fn default_claude_projects_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude").join("projects")
}

pub fn default_codex_sessions_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".codex").join("sessions")
}

pub fn default_cursor_projects_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".cursor").join("projects")
}

fn collect_jsonl_files(root: &Path, visit: &mut dyn FnMut(&Path)) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                visit(&path);
            }
        }
    }
}

/// Only Cursor agent transcript jsonl files under `*/agent-transcripts/**`.
fn collect_cursor_transcripts(root: &Path, visit: &mut dyn FnMut(&Path)) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let is_transcript = path
                .components()
                .any(|c| c.as_os_str().to_str().is_some_and(|s| s == "agent-transcripts"));
            if is_transcript {
                visit(&path);
            }
        }
    }
}

fn parse_claude_jsonl(path: &Path, limit: usize) -> Result<Vec<CaptureEvent>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    // Hard evidence: Claude's on-disk project key under ~/.claude/projects/<id>/.
    let harness_project = claude_project_key_from_path(path);
    let mut out = Vec::new();
    for line in reader.lines() {
        if out.len() >= limit {
            break;
        }
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(mut ev) = claude_line_to_event(&v) {
            if ev.project_id.is_none() {
                ev.project_id.clone_from(&harness_project);
            }
            out.push(ev);
        }
    }
    Ok(out)
}

fn claude_line_to_event(v: &Value) -> Option<CaptureEvent> {
    let ty = v.get("type")?.as_str()?;
    let role = match ty {
        "user" => CaptureRole::User,
        "assistant" => CaptureRole::Assistant,
        "system" => CaptureRole::System,
        _ => return None,
    };
    let message = v.get("message")?;
    let content = content_to_text(message.get("content")?)?;
    if content.trim().is_empty() {
        return None;
    }

    let session_id = v
        .get("sessionId")
        .or_else(|| v.get("session_id"))
        .and_then(|x| x.as_str())
        .map(str::to_string);
    // cwd is a signal; project_id only from an explicit field (or harness folder key above).
    let cwd = v.get("cwd").and_then(|x| x.as_str()).map(str::to_string);
    let project_id = v
        .get("project_id")
        .or_else(|| v.get("projectId"))
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let model = message.get("model").and_then(|x| x.as_str()).map(str::to_string);
    let ts = parse_ts(v.get("timestamp").and_then(|x| x.as_str()));
    let id = v
        .get("uuid")
        .and_then(|x| x.as_str())
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or_else(|| {
            stable_id(&format!(
                "claude:{}:{}:{}",
                session_id.as_deref().unwrap_or(""),
                ty,
                content.chars().take(64).collect::<String>()
            ))
        });

    let (tokens_in, tokens_out) = usage_from_claude(message.get("usage"));

    Some(CaptureEvent {
        id,
        ts,
        provider: ProviderKind::Claude,
        account_label: None,
        model,
        session_id,
        project_id,
        cwd,
        request_id: None,
        role,
        content: Some(content),
        tokens_in,
        tokens_out,
        latency_ms: None,
        status_code: None,
        body_ref: None,
        capture_quality: Some(CaptureQuality::Imported),
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
    })
}

fn parse_cursor_jsonl(path: &Path, limit: usize) -> Result<Vec<CaptureEvent>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    let session_id = cursor_session_id(path);
    // Hard evidence: Cursor's project slug under ~/.cursor/projects/<slug>/ (as-is, not decoded).
    let project_id = cursor_project_key_from_path(path);
    let file_mtime =
        fs::metadata(path).ok().and_then(|m| m.modified().ok()).map(DateTime::<Utc>::from);
    let mut out = Vec::new();
    for (idx, line) in reader.lines().enumerate() {
        if out.len() >= limit {
            break;
        }
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let role_str = v.get("role").and_then(|x| x.as_str()).unwrap_or("");
        let role = match role_str {
            "user" => CaptureRole::User,
            "assistant" => CaptureRole::Assistant,
            "system" => CaptureRole::System,
            "tool" => CaptureRole::Tool,
            _ => continue,
        };
        let message = v.get("message").unwrap_or(&v);
        let content = message
            .get("content")
            .or_else(|| v.get("content"))
            .map_or_else(String::new, |c| content_to_text(c).unwrap_or_default());
        if content.trim().is_empty() {
            continue;
        }
        let ts = extract_timestamp_from_text(&content).or(file_mtime).unwrap_or_else(Utc::now)
            + chrono::Duration::milliseconds(i64::try_from(idx).unwrap_or(i64::MAX));
        let id = stable_id(&format!("cursor:{session_id}:{idx}:{role_str}"));
        out.push(CaptureEvent {
            id,
            ts,
            provider: ProviderKind::Cursor,
            account_label: Some("cursor".into()),
            model: None,
            session_id: Some(session_id.clone()),
            project_id: project_id.clone(),
            cwd: None,
            request_id: None,
            role,
            content: Some(content),
            tokens_in: 0,
            tokens_out: 0,
            latency_ms: None,
            status_code: None,
            body_ref: None,
            capture_quality: Some(CaptureQuality::Imported),
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
        });
    }
    Ok(out)
}

fn cursor_session_id(path: &Path) -> String {
    // .../agent-transcripts/<agent-id>/<file>.jsonl or .../subagents/<id>.jsonl
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("cursor");
    if let Some(parent) = path.parent() {
        let name = parent.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.starts_with("agent-") {
            return name.to_string();
        }
        if name == "subagents" {
            if let Some(agent) =
                parent.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str())
            {
                return format!("{agent}/{stem}");
            }
        }
    }
    stem.to_string()
}

/// Hard evidence: directory name immediately under a harness `projects/` folder.
fn harness_project_key_from_path(path: &Path) -> Option<String> {
    let parts: Vec<_> = path.iter().filter_map(|s| s.to_str()).collect();
    parts.windows(2).find_map(|w| {
        if w[0] == "projects" && !w[1].is_empty() && w[1] != "." && w[1] != ".." {
            Some(w[1].to_string())
        } else {
            None
        }
    })
}

fn claude_project_key_from_path(path: &Path) -> Option<String> {
    harness_project_key_from_path(path)
}

/// Cursor project slug under `~/.cursor/projects/<slug>/…` — as stored by Cursor (not path-decoded).
fn cursor_project_key_from_path(path: &Path) -> Option<String> {
    harness_project_key_from_path(path)
}

fn extract_timestamp_from_text(text: &str) -> Option<DateTime<Utc>> {
    let start = text.find("<timestamp>")? + "<timestamp>".len();
    let end = text[start..].find("</timestamp>")? + start;
    let raw = text[start..end].trim();
    // e.g. Friday, Nov 6, 2026, 10:56 PM (UTC-8) — fall back to now if unparseable.
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    None
}

fn usage_from_claude(usage: Option<&Value>) -> (u32, u32) {
    let Some(usage) = usage else {
        return (0, 0);
    };
    let input = as_u32(usage.get("input_tokens"))
        + as_u32(usage.get("cache_read_input_tokens"))
        + as_u32(usage.get("cache_creation_input_tokens"));
    let output = as_u32(usage.get("output_tokens"));
    (input, output)
}

#[allow(clippy::too_many_lines)]
fn parse_codex_jsonl(path: &Path, limit: usize) -> Result<Vec<CaptureEvent>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut model: Option<String> = None;
    let mut pending_usage: Option<(u32, u32)> = None;

    for line in reader.lines() {
        if out.len() >= limit {
            break;
        }
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let payload = v.get("payload").cloned().unwrap_or(Value::Null);
        let ts = parse_ts(v.get("timestamp").and_then(|x| x.as_str()));

        match ty {
            "session_meta" => {
                session_id = payload
                    .get("session_id")
                    .or_else(|| payload.get("id"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .or(session_id);
                // Capture cwd as a signal; workers classify project later.
                cwd = payload.get("cwd").and_then(|x| x.as_str()).map(str::to_string).or(cwd);
                if let Some(m) = payload.get("model_provider").and_then(|x| x.as_str()) {
                    let _ = m; // provider is always Codex for these files
                }
            },
            "event_msg" => {
                let et = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if et == "thread_settings_applied" {
                    if let Some(settings) = payload.get("thread_settings") {
                        model = settings
                            .get("model")
                            .and_then(|x| x.as_str())
                            .map(str::to_string)
                            .or(model);
                        cwd = settings
                            .get("cwd")
                            .and_then(|x| x.as_str())
                            .map(str::to_string)
                            .or(cwd);
                        session_id = payload
                            .get("thread_id")
                            .and_then(|x| x.as_str())
                            .map(str::to_string)
                            .or(session_id);
                    }
                } else if et == "token_count" {
                    if let Some(info) = payload.get("info") {
                        let last = info.get("last_token_usage").unwrap_or(info);
                        let input = as_u32(last.get("input_tokens"))
                            + as_u32(last.get("cached_input_tokens"))
                            + as_u32(last.get("cache_write_input_tokens"));
                        let output = as_u32(last.get("output_tokens"))
                            + as_u32(last.get("reasoning_output_tokens"));
                        pending_usage = Some((input, output));
                    }
                }
            },
            "response_item" => {
                let item_type = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match item_type {
                    "message" => {
                        let role_str = payload.get("role").and_then(|x| x.as_str()).unwrap_or("");
                        let role = match role_str {
                            "user" => CaptureRole::User,
                            "assistant" => CaptureRole::Assistant,
                            "developer" | "system" => CaptureRole::System,
                            _ => continue,
                        };
                        // Skip huge developer tool catalogs / base instructions noise when empty text.
                        let content = payload
                            .get("content")
                            .map_or_else(String::new, |c| content_to_text(c).unwrap_or_default());
                        if content.trim().is_empty() {
                            continue;
                        }
                        // Drop very large system/developer bootstrap dumps (>64KiB) — keep user/assistant.
                        if matches!(role, CaptureRole::System) && content.len() > 64 * 1024 {
                            continue;
                        }
                        let id = payload.get("id").and_then(|x| x.as_str()).map_or_else(
                            || {
                                stable_id(&format!(
                                    "codex:{}:{}:{}",
                                    session_id.as_deref().unwrap_or(""),
                                    role_str,
                                    content.chars().take(64).collect::<String>()
                                ))
                            },
                            |s| stable_id(&format!("codex:{s}")),
                        );
                        let (tokens_in, tokens_out) = if role == CaptureRole::Assistant {
                            pending_usage.take().unwrap_or((0, 0))
                        } else {
                            (0, 0)
                        };
                        out.push(CaptureEvent {
                            id,
                            ts,
                            provider: ProviderKind::Codex,
                            account_label: None,
                            model: model.clone(),
                            session_id: session_id.clone(),
                            project_id: None,
                            cwd: cwd.clone(),
                            request_id: None,
                            role,
                            content: Some(content),
                            tokens_in,
                            tokens_out,
                            latency_ms: None,
                            status_code: None,
                            body_ref: None,
                            capture_quality: Some(CaptureQuality::Imported),
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
                        });
                    },
                    "custom_tool_call" => {
                        let name = payload.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
                        let input = payload.get("input").and_then(|x| x.as_str()).unwrap_or("");
                        let content = format!("tool_call {name}\n{input}");
                        let id = payload.get("id").and_then(|x| x.as_str()).map_or_else(
                            || {
                                stable_id(&format!(
                                    "codex:tool:{}:{}",
                                    session_id.as_deref().unwrap_or(""),
                                    name
                                ))
                            },
                            |s| stable_id(&format!("codex:{s}")),
                        );
                        out.push(CaptureEvent {
                            id,
                            ts,
                            provider: ProviderKind::Codex,
                            account_label: None,
                            model: model.clone(),
                            session_id: session_id.clone(),
                            project_id: None,
                            cwd: cwd.clone(),
                            request_id: payload
                                .get("call_id")
                                .and_then(|x| x.as_str())
                                .map(str::to_string),
                            role: CaptureRole::Tool,
                            content: Some(content),
                            tokens_in: 0,
                            tokens_out: 0,
                            latency_ms: None,
                            status_code: None,
                            body_ref: None,
                            capture_quality: Some(CaptureQuality::Imported),
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
                        });
                    },
                    "custom_tool_call_output" => {
                        let content = payload
                            .get("output")
                            .map_or_else(String::new, |o| content_to_text(o).unwrap_or_default());
                        if content.trim().is_empty() {
                            continue;
                        }
                        let id = payload.get("id").and_then(|x| x.as_str()).map_or_else(
                            || {
                                stable_id(&format!(
                                    "codex:tool_out:{}:{}",
                                    session_id.as_deref().unwrap_or(""),
                                    content.chars().take(32).collect::<String>()
                                ))
                            },
                            |s| stable_id(&format!("codex:{s}")),
                        );
                        out.push(CaptureEvent {
                            id,
                            ts,
                            provider: ProviderKind::Codex,
                            account_label: None,
                            model: model.clone(),
                            session_id: session_id.clone(),
                            project_id: None,
                            cwd: cwd.clone(),
                            request_id: payload
                                .get("call_id")
                                .and_then(|x| x.as_str())
                                .map(str::to_string),
                            role: CaptureRole::Tool,
                            content: Some(content),
                            tokens_in: 0,
                            tokens_out: 0,
                            latency_ms: None,
                            status_code: None,
                            body_ref: None,
                            capture_quality: Some(CaptureQuality::Imported),
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
                        });
                    },
                    _ => {},
                }
            },
            "token_usage_record" => {
                let input = as_u32(payload.get("input_tokens"))
                    + as_u32(payload.get("cached_input_tokens"))
                    + as_u32(payload.get("cache_write_input_tokens"));
                let output = as_u32(payload.get("output_tokens"))
                    + as_u32(payload.get("reasoning_output_tokens"));
                if input > 0 || output > 0 {
                    pending_usage = Some((input, output));
                }
            },
            _ => {},
        }
    }
    Ok(out)
}

fn content_to_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                    parts.push(t.to_string());
                    continue;
                }
                if let Some(t) = item.as_str() {
                    parts.push(t.to_string());
                    continue;
                }
                // Anthropic tool_use / tool_result blocks
                if let Some(ty) = item.get("type").and_then(|x| x.as_str()) {
                    match ty {
                        "tool_use" => {
                            let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
                            let input =
                                item.get("input").map(ToString::to_string).unwrap_or_default();
                            parts.push(format!("tool_use {name}\n{input}"));
                        },
                        "tool_result" => {
                            let inner = item
                                .get("content")
                                .and_then(content_to_text)
                                .unwrap_or_else(|| item.to_string());
                            parts.push(format!("tool_result\n{inner}"));
                        },
                        "thinking" => {
                            if let Some(t) = item.get("thinking").and_then(|x| x.as_str()) {
                                parts.push(format!("thinking\n{t}"));
                            }
                        },
                        _ => {},
                    }
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        },
        Value::Object(_) => Some(content.to_string()),
        _ => None,
    }
}

fn parse_ts(raw: Option<&str>) -> DateTime<Utc> {
    raw.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map_or_else(Utc::now, |dt| dt.with_timezone(&Utc))
}

fn as_u32(v: Option<&Value>) -> u32 {
    match v {
        Some(Value::Number(n)) => {
            u32::try_from(n.as_u64().unwrap_or(0).min(u64::from(u32::MAX))).unwrap_or(u32::MAX)
        },
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

fn stable_id(key: &str) -> Uuid {
    Uuid::new_v5(&EVENT_NS, key.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use rivet_core::UsageTotals;
    use std::sync::Mutex;

    struct MemStore {
        events: Mutex<Vec<CaptureEvent>>,
    }

    #[async_trait]
    impl CaptureStore for MemStore {
        async fn insert_event(&self, event: &CaptureEvent) -> Result<()> {
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
        async fn insert_batch(&self, events: &[CaptureEvent]) -> Result<()> {
            self.events.lock().unwrap().extend_from_slice(events);
            Ok(())
        }
        async fn recent(&self, limit: u32) -> Result<Vec<CaptureEvent>> {
            let ev = self.events.lock().unwrap();
            Ok(ev.iter().rev().take(limit as usize).cloned().collect())
        }
        async fn search_keyword(&self, _q: &str, limit: u32) -> Result<Vec<CaptureEvent>> {
            self.recent(limit).await
        }
        async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<CaptureEvent>> {
            let set: std::collections::HashSet<_> = ids.iter().cloned().collect();
            Ok(self
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| set.contains(&e.id.to_string()))
                .cloned()
                .collect())
        }
        async fn export_all(&self) -> Result<Vec<CaptureEvent>> {
            Ok(self.events.lock().unwrap().clone())
        }
        async fn usage_totals(&self) -> Result<UsageTotals> {
            Ok(UsageTotals::default())
        }
    }

    #[test]
    fn claude_line_extracts_session_and_usage() {
        let line = serde_json::json!({
            "type": "assistant",
            "sessionId": "83f2c964-2b75-4c57-9d71-a4340048da17",
            "cwd": "/tmp/proj",
            "timestamp": "2026-11-04T05:44:17.807Z",
            "uuid": "53927903-59f2-4d31-b07a-5075cd306660",
            "message": {
                "role": "assistant",
                "model": "claude-sonnet-4-5",
                "content": [{"type": "text", "text": "hello"}],
                "usage": {
                    "input_tokens": 10,
                    "cache_read_input_tokens": 100,
                    "output_tokens": 5
                }
            }
        });
        let ev = claude_line_to_event(&line).expect("event");
        assert_eq!(ev.session_id.as_deref(), Some("83f2c964-2b75-4c57-9d71-a4340048da17"));
        assert_eq!(ev.cwd.as_deref(), Some("/tmp/proj"));
        assert!(ev.project_id.is_none(), "cwd alone is not hard project evidence");
        assert_eq!(ev.tokens_in, 110);
        assert_eq!(ev.tokens_out, 5);
        assert_eq!(ev.content.as_deref(), Some("hello"));
    }

    #[test]
    fn harness_project_key_is_folder_under_projects() {
        let claude = PathBuf::from("/home/u/.claude/projects/-Users-u-code/sess.jsonl");
        assert_eq!(claude_project_key_from_path(&claude).as_deref(), Some("-Users-u-code"));
        let cursor = PathBuf::from(
            "/home/u/.cursor/projects/Users-u-code/agent-transcripts/agent-1/t.jsonl",
        );
        assert_eq!(cursor_project_key_from_path(&cursor).as_deref(), Some("Users-u-code"));
        // Must not invent a project from a random path or by decoding slugs into cwd-like paths.
        assert!(harness_project_key_from_path(Path::new("/tmp/sess.jsonl")).is_none());
    }

    #[tokio::test]
    async fn ingest_skips_existing_ids() {
        let dir = std::env::temp_dir().join(format!(
            "rivet-harness-ingest-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let projects = dir.join("projects").join("demo");
        fs::create_dir_all(&projects).unwrap();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let path = projects.join(format!("{session}.jsonl"));
        fs::write(
            &path,
            format!(
                r#"{{"type":"user","sessionId":"{session}","cwd":"/tmp/x","timestamp":"2026-11-04T05:43:58.923Z","uuid":"11111111-1111-1111-1111-111111111111","message":{{"role":"user","content":"hi"}}}}
"#
            ),
        )
        .unwrap();

        let store: Arc<dyn CaptureStore> = Arc::new(MemStore { events: Mutex::new(vec![]) });
        let opts = LocalIngestOptions {
            sources: vec![LocalSource::Claude],
            claude_root: Some(dir.join("projects")),
            codex_root: Some(dir.join("missing-codex")),
            cursor_root: Some(dir.join("missing-cursor")),
            dry_run: false,
            limit: None,
        };
        let first = ingest_local(store.clone(), opts.clone()).await.unwrap();
        assert_eq!(first.events_inserted, 1);
        let stored = store.recent(10).await.unwrap();
        assert_eq!(stored[0].project_id.as_deref(), Some("demo"));
        assert_eq!(stored[0].cwd.as_deref(), Some("/tmp/x"));
        let second = ingest_local(store.clone(), opts).await.unwrap();
        assert_eq!(second.events_inserted, 0);
        assert_eq!(second.events_skipped_existing, 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
