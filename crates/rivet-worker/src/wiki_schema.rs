//! Schemars JSON schemas for constrained wiki model calls.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// LLM extract response: array of topic patches under `topics`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WikiExtractResponse {
    pub topics: Vec<WikiExtractTopic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WikiExtractAction {
    Create,
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WikiPatchMode {
    Replace,
    Append,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WikiArticlePatch {
    pub heading: String,
    pub body: String,
    #[serde(default)]
    pub mode: Option<WikiPatchMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WikiCitationIn {
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WikiSourceIn {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WikiExtractTopic {
    pub action: WikiExtractAction,
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub article: Option<String>,
    #[serde(default)]
    pub article_patches: Vec<WikiArticlePatch>,
    #[serde(default)]
    pub history_entry: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub entities: Vec<String>,
    #[serde(default)]
    pub related: Vec<String>,
    #[serde(default)]
    pub citations: Vec<WikiCitationIn>,
    #[serde(default)]
    pub sources: Vec<WikiSourceIn>,
    #[serde(default, rename = "type")]
    pub entity_type: Option<String>,
    #[serde(default)]
    pub allow_shrink: Option<bool>,
}

/// LLM recompile / merge rewrite response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WikiRecompileResponse {
    pub summary: String,
    pub article: String,
    #[serde(default)]
    pub history_entry: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub entities: Vec<String>,
    #[serde(default)]
    pub related: Vec<String>,
}

#[must_use]
pub fn extract_schema() -> Value {
    prepare_openai_schema(schemars::schema_for!(WikiExtractResponse))
}

#[must_use]
pub fn recompile_schema() -> Value {
    prepare_openai_schema(schemars::schema_for!(WikiRecompileResponse))
}

/// `OpenAI` structured-outputs wants a plain object schema (no `$schema`, strict-friendly).
fn prepare_openai_schema(schema: schemars::Schema) -> Value {
    let mut value = serde_json::to_value(schema).unwrap_or_else(|_| json!({ "type": "object" }));
    if let Some(obj) = value.as_object_mut() {
        obj.remove("$schema");
        // Prefer additionalProperties:false at the root when absent.
        if !obj.contains_key("additionalProperties") {
            obj.insert("additionalProperties".into(), Value::Bool(false));
        }
    }
    value
}

/// Build `OpenAI`-compatible `response_format` for a named schema.
#[must_use]
pub fn response_format(name: &str, schema: &Value) -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": name,
            "strict": true,
            "schema": schema
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_schema_is_object_with_topics() {
        let schema = extract_schema();
        assert_eq!(schema.get("type").and_then(|t| t.as_str()), Some("object"));
        assert!(schema.pointer("/properties/topics").is_some());
        assert!(schema.get("$schema").is_none());
    }

    #[test]
    fn recompile_schema_requires_summary_article() {
        let schema = recompile_schema();
        let required =
            schema.get("required").and_then(|r| r.as_array()).cloned().unwrap_or_default();
        assert!(required.iter().any(|v| v.as_str() == Some("summary")));
        assert!(required.iter().any(|v| v.as_str() == Some("article")));
    }

    #[test]
    fn response_format_wraps_schema() {
        let schema = extract_schema();
        let fmt = response_format("wiki_extract", &schema);
        assert_eq!(fmt.get("type").and_then(|t| t.as_str()), Some("json_schema"));
        assert_eq!(fmt.pointer("/json_schema/name").and_then(|t| t.as_str()), Some("wiki_extract"));
    }
}
