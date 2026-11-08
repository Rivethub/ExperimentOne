//! Best-effort turn normalization over captured traffic content.
//!
//! Proxy events often store `request\n---\nresponse` JSON. Agents and the UI
//! prefer discrete user / assistant / tool turns when that shape is parseable.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::traffic::{TrafficEvent, TrafficRole};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnKind {
    System,
    User,
    Assistant,
    Tool,
    Thinking,
    Unknown,
}

impl TurnKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
            Self::Thinking => "thinking",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedTurn {
    pub kind: TurnKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_args: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<String>,
}

/// Split one traffic event into zero or more normalized turns.
#[must_use]
pub fn normalize_event_turns(event: &TrafficEvent) -> Vec<NormalizedTurn> {
    let Some(raw) = event.content.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return vec![NormalizedTurn {
            kind: role_to_kind(event.role),
            text: String::new(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
        }];
    };

    let (req, resp) = match raw.split_once("\n---\n") {
        Some((a, b)) => (a.trim(), b.trim()),
        None => ("", raw),
    };

    let mut turns = Vec::new();
    if !req.is_empty() {
        turns.extend(parse_request_half(req));
    }
    if !resp.is_empty() {
        turns.extend(parse_response_half(resp));
    }
    if turns.is_empty() {
        turns.push(NormalizedTurn {
            kind: role_to_kind(event.role),
            text: clip(raw, 8_000),
            tool_name: None,
            tool_args: None,
            tool_result: None,
        });
    }
    turns
}

const fn role_to_kind(role: TrafficRole) -> TurnKind {
    match role {
        TrafficRole::System => TurnKind::System,
        TrafficRole::User => TurnKind::User,
        TrafficRole::Assistant => TurnKind::Assistant,
        TrafficRole::Tool => TurnKind::Tool,
        TrafficRole::Unknown => TurnKind::Unknown,
    }
}

fn parse_request_half(raw: &str) -> Vec<NormalizedTurn> {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return vec![NormalizedTurn {
            kind: TurnKind::User,
            text: clip(raw, 8_000),
            tool_name: None,
            tool_args: None,
            tool_result: None,
        }];
    };
    let mut turns = Vec::new();
    if let Some(system) = v.get("system").and_then(Value::as_str) {
        let t = system.trim();
        if !t.is_empty() {
            turns.push(NormalizedTurn {
                kind: TurnKind::System,
                text: clip(t, 4_000),
                tool_name: None,
                tool_args: None,
                tool_result: None,
            });
        }
    }
    if let Some(msgs) = v.get("messages").and_then(Value::as_array) {
        for msg in msgs {
            turns.extend(parse_message_object(msg));
        }
    } else if let Some(input) = v.get("input").and_then(Value::as_array) {
        for msg in input {
            turns.extend(parse_message_object(msg));
        }
    } else if let Some(prompt) = v.get("prompt").and_then(Value::as_str) {
        turns.push(NormalizedTurn {
            kind: TurnKind::User,
            text: clip(prompt, 8_000),
            tool_name: None,
            tool_args: None,
            tool_result: None,
        });
    }
    turns
}

fn parse_response_half(raw: &str) -> Vec<NormalizedTurn> {
    if raw.starts_with("data:") {
        return vec![NormalizedTurn {
            kind: TurnKind::Assistant,
            text: clip(raw, 8_000),
            tool_name: None,
            tool_args: None,
            tool_result: None,
        }];
    }
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return vec![NormalizedTurn {
            kind: TurnKind::Assistant,
            text: clip(raw, 8_000),
            tool_name: None,
            tool_args: None,
            tool_result: None,
        }];
    };
    let mut turns = Vec::new();
    if let Some(content) = v.get("content").and_then(Value::as_array) {
        turns.extend(parse_content_blocks(content));
    }
    if let Some(msg) = v.pointer("/choices/0/message") {
        turns.extend(parse_message_object(msg));
    }
    if let Some(output) = v.get("output").and_then(Value::as_array) {
        for item in output {
            turns.extend(parse_message_object(item));
        }
    }
    if turns.is_empty() {
        if let Some(text) = v.get("text").and_then(Value::as_str) {
            turns.push(NormalizedTurn {
                kind: TurnKind::Assistant,
                text: clip(text, 8_000),
                tool_name: None,
                tool_args: None,
                tool_result: None,
            });
        }
    }
    turns
}

fn parse_message_object(msg: &Value) -> Vec<NormalizedTurn> {
    let role = msg.get("role").and_then(Value::as_str).unwrap_or("assistant");
    let kind = match role {
        "system" => TurnKind::System,
        "user" => TurnKind::User,
        "tool" | "function" => TurnKind::Tool,
        _ => TurnKind::Assistant,
    };
    if let Some(s) = msg.get("content").and_then(Value::as_str) {
        let t = s.trim();
        if t.is_empty() {
            return Vec::new();
        }
        return vec![NormalizedTurn {
            kind,
            text: clip(t, 8_000),
            tool_name: msg
                .get("name")
                .or_else(|| msg.get("tool_name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_args: None,
            tool_result: if kind == TurnKind::Tool { Some(clip(t, 8_000)) } else { None },
        }];
    }
    if let Some(arr) = msg.get("content").and_then(Value::as_array) {
        return parse_content_blocks(arr);
    }
    if let Some(calls) = msg.get("tool_calls").and_then(Value::as_array) {
        return calls
            .iter()
            .filter_map(|call| {
                let name = call
                    .pointer("/function/name")
                    .or_else(|| call.get("name"))
                    .and_then(Value::as_str)?
                    .to_string();
                let args = call
                    .pointer("/function/arguments")
                    .or_else(|| call.get("arguments"))
                    .and_then(Value::as_str)
                    .map(|s| clip(s, 4_000));
                Some(NormalizedTurn {
                    kind: TurnKind::Tool,
                    text: format!("tool:{name}"),
                    tool_name: Some(name),
                    tool_args: args,
                    tool_result: None,
                })
            })
            .collect();
    }
    Vec::new()
}

fn parse_content_blocks(blocks: &[Value]) -> Vec<NormalizedTurn> {
    let mut turns = Vec::new();
    for block in blocks {
        let ty = block.get("type").and_then(Value::as_str).unwrap_or("text");
        match ty {
            "text" => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        turns.push(NormalizedTurn {
                            kind: TurnKind::Assistant,
                            text: clip(t, 8_000),
                            tool_name: None,
                            tool_args: None,
                            tool_result: None,
                        });
                    }
                }
            },
            "thinking" | "reasoning" => {
                if let Some(t) = block
                    .get("thinking")
                    .or_else(|| block.get("text"))
                    .and_then(Value::as_str)
                {
                    let t = t.trim();
                    if !t.is_empty() {
                        turns.push(NormalizedTurn {
                            kind: TurnKind::Thinking,
                            text: clip(t, 4_000),
                            tool_name: None,
                            tool_args: None,
                            tool_result: None,
                        });
                    }
                }
            },
            "tool_use" | "function_call" => {
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let args = block.get("input").or_else(|| block.get("arguments")).map(|v| {
                    if v.is_string() {
                        clip(v.as_str().unwrap_or(""), 4_000)
                    } else {
                        clip(&v.to_string(), 4_000)
                    }
                });
                turns.push(NormalizedTurn {
                    kind: TurnKind::Tool,
                    text: format!("tool:{name}"),
                    tool_name: Some(name),
                    tool_args: args,
                    tool_result: None,
                });
            },
            "tool_result" => {
                let name = block
                    .get("name")
                    .or_else(|| block.get("tool_use_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let text = block
                    .get("content")
                    .map(|c| c.as_str().map_or_else(|| c.to_string(), str::to_string))
                    .unwrap_or_default();
                turns.push(NormalizedTurn {
                    kind: TurnKind::Tool,
                    text: clip(&text, 8_000),
                    tool_name: name,
                    tool_args: None,
                    tool_result: Some(clip(&text, 8_000)),
                });
            },
            _ => {},
        }
    }
    turns
}

fn clip(raw: &str, max: usize) -> String {
    if raw.len() <= max {
        raw.to_string()
    } else {
        format!("{}…", &raw[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traffic::ProviderKind;

    #[test]
    fn parses_claude_style_messages() {
        let mut event = TrafficEvent::new(ProviderKind::Claude);
        event.content = Some(
            r#"{"messages":[{"role":"user","content":"hello"}]}"#.to_string()
                + "\n---\n"
                + r#"{"content":[{"type":"text","text":"hi"}]}"#,
        );
        let turns = normalize_event_turns(&event);
        assert!(turns.iter().any(|t| t.kind == TurnKind::User && t.text.contains("hello")));
        assert!(turns.iter().any(|t| t.kind == TurnKind::Assistant && t.text.contains("hi")));
    }
}
