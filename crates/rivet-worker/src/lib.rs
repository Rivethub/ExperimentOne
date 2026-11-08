//! Background workers for vectorize + wiki.
//!
//! - **Vectorize**: embeds traffic content (proxy `/v1/embeddings` when
//!   `embedding_model` is set, otherwise local lexical vectors).
//! - **Wiki**: builds a markdown tree from traffic; when `wiki_model` is set,
//!   also asks the local proxy for an LLM overview page.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rivet_core::{lexical_embed, RivetConfig, RivetPaths, TrafficEvent};
use rivet_store::{MetaStore, TrafficStore, WikiPageMeta};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

pub struct WorkerPool {
    store: Arc<dyn TrafficStore>,
    meta: Arc<MetaStore>,
    paths: RivetPaths,
    config: Arc<RwLock<RivetConfig>>,
    http: reqwest::Client,
}

impl WorkerPool {
    pub fn new(
        store: Arc<dyn TrafficStore>,
        meta: Arc<MetaStore>,
        paths: RivetPaths,
        config: Arc<RwLock<RivetConfig>>,
    ) -> Self {
        Self {
            store,
            meta,
            paths,
            config,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("reqwest client"),
        }
    }

    pub fn spawn(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            // First pass soon after boot so UI shows pages/embeddings quickly.
            if let Err(err) = self.tick_once().await {
                warn!(?err, "worker initial tick failed");
            }
            let mut tick = tokio::time::interval(Duration::from_secs(20));
            loop {
                tick.tick().await;
                if let Err(err) = self.tick_once().await {
                    warn!(?err, "worker tick failed");
                }
            }
        })
    }

    /// Run one vectorize + wiki cycle (also exposed via control API).
    pub async fn tick_once(&self) -> Result<()> {
        let cfg = self.config.read().await.clone();
        let totals = self.store.usage_totals().await?;
        debug!(?totals, "worker heartbeat");

        if cfg.capabilities.vector_search {
            self.embed_new_events(&cfg).await?;
        }
        if cfg.capabilities.wiki {
            self.upsert_wiki(&cfg).await?;
        }
        Ok(())
    }

    async fn embed_new_events(&self, cfg: &RivetConfig) -> Result<()> {
        let recent = self.store.recent(400).await?;
        let mut n = 0u32;
        let mut remote_ok = cfg.embedding_model.is_some();
        let mut remote_fail_logged = false;

        for event in recent {
            let id = event.id.to_string();
            if self.meta.embedding_for(&id)?.is_some() {
                continue;
            }
            let text = event.content.as_deref().unwrap_or("").trim();
            if text.is_empty() {
                continue;
            }

            let dims = if remote_ok {
                match self.proxy_embed(cfg, text).await {
                    Ok(v) if !v.is_empty() => v,
                    Ok(_) => {
                        remote_ok = false;
                        lexical_embed(text)
                    }
                    Err(err) => {
                        if !remote_fail_logged {
                            warn!(?err, "proxy embeddings unavailable — using lexical");
                            remote_fail_logged = true;
                        }
                        remote_ok = false;
                        lexical_embed(text)
                    }
                }
            } else {
                lexical_embed(text)
            };

            self.meta.upsert_embedding(&id, &dims)?;
            n += 1;
            if n >= 80 {
                break; // keep each tick bounded
            }
        }

        if n > 0 {
            let mode = if cfg.embedding_model.is_some() && remote_ok {
                "proxy"
            } else {
                "lexical"
            };
            info!(n, mode, "vector worker embedded events");
        }
        self.meta
            .set_job_cursor("vectorize", &Utc::now().to_rfc3339())?;
        Ok(())
    }

    async fn proxy_embed(&self, cfg: &RivetConfig, text: &str) -> Result<Vec<f32>> {
        let model = cfg
            .embedding_model
            .as_deref()
            .ok_or_else(|| anyhow!("no embedding_model"))?;
        let url = format!("{}/v1/embeddings", cfg.proxy_base_url());
        let res = self
            .http
            .post(&url)
            .bearer_auth(&cfg.proxy_access_key)
            .json(&json!({
                "model": model,
                "input": text.chars().take(8_000).collect::<String>(),
            }))
            .send()
            .await
            .context("embeddings request")?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!("embeddings HTTP {status}: {body}");
        }
        let parsed: EmbeddingsResponse = res.json().await.context("embeddings json")?;
        parsed
            .data
            .into_iter()
            .next()
            .map(|d| d.embedding)
            .ok_or_else(|| anyhow!("empty embeddings response"))
    }

    async fn upsert_wiki(&self, cfg: &RivetConfig) -> Result<()> {
        let project = &cfg.wiki_project_id;
        let wiki_root = self.paths.wiki_dir().join(project);
        std::fs::create_dir_all(wiki_root.as_std_path())?;
        std::fs::create_dir_all(wiki_root.join("providers").as_std_path())?;
        std::fs::create_dir_all(wiki_root.join("topics").as_std_path())?;

        let totals = self.store.usage_totals().await?;
        let recent = self.store.recent(200).await?;

        // --- README overview ---
        let mut readme = String::new();
        readme.push_str("# Rivet project wiki\n\n");
        readme.push_str(&format!(
            "_Auto-updated {} by the wiki worker_\n\n",
            Utc::now().format("%Y-%m-%d %H:%M UTC")
        ));
        readme.push_str("## Traffic snapshot\n\n");
        readme.push_str(&format!(
            "- Events: **{}**\n- Tokens in: **{}**\n- Tokens out: **{}**\n- Embeddings: **{}**\n\n",
            totals.events,
            totals.tokens_in,
            totals.tokens_out,
            self.meta.embedding_count().unwrap_or(0)
        ));
        readme.push_str("## Pages\n\n");
        readme.push_str("- [Models](models.md)\n");
        readme.push_str("- [Sessions](sessions.md)\n");
        readme.push_str("- [Topics](topics/index.md)\n");
        {
            let mut provider_links = Vec::new();
            let mut seen = std::collections::BTreeSet::new();
            for e in &recent {
                let key = rivet_core::normalize_provider_id(&provider_key(e));
                if key == "other" || !seen.insert(key.clone()) {
                    continue;
                }
                provider_links.push(format!(
                    "[{}](providers/{}.md)",
                    key,
                    slugify(&key)
                ));
            }
            if provider_links.is_empty() {
                readme.push_str("- Providers: _none yet_\n");
            } else {
                readme.push_str(&format!("- {}\n", provider_links.join(" · ")));
            }
        }
        if cfg.wiki_model.is_some() {
            readme.push_str("- [LLM overview](overview-llm.md)\n");
        }
        readme.push_str("\n## Recent captures\n\n");
        for event in recent.iter().take(20) {
            readme.push_str(&format!("- {}\n", format_event_line(event)));
        }
        self.write_wiki_page(project, "README", "Project overview", "README.md", &readme)?;

        // --- Models ---
        let mut by_model: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
        for e in &recent {
            let key = e.model.clone().unwrap_or_else(|| "(unknown)".into());
            let entry = by_model.entry(key).or_default();
            entry.0 += 1;
            entry.1 += u64::from(e.tokens_in);
            entry.2 += u64::from(e.tokens_out);
        }
        let mut models = String::from("# Models\n\n| Model | Events | Tokens in | Tokens out |\n| --- | ---: | ---: | ---: |\n");
        for (model, (n, tin, tout)) in &by_model {
            models.push_str(&format!("| `{model}` | {n} | {tin} | {tout} |\n"));
        }
        self.write_wiki_page(project, "models", "Models", "models.md", &models)?;

        // --- Sessions ---
        let mut by_session: BTreeMap<String, Vec<&TrafficEvent>> = BTreeMap::new();
        for e in &recent {
            let key = e
                .session_id
                .clone()
                .unwrap_or_else(|| "(no-session)".into());
            by_session.entry(key).or_default().push(e);
        }
        let mut sessions = String::from("# Sessions\n\n");
        for (sid, events) in by_session.iter().take(40) {
            let tokens: u64 = events
                .iter()
                .map(|e| u64::from(e.tokens_in) + u64::from(e.tokens_out))
                .sum();
            sessions.push_str(&format!(
                "## `{sid}`\n\n_{} events · {} tokens_\n\n",
                events.len(),
                tokens
            ));
            for e in events.iter().take(8) {
                sessions.push_str(&format!("- {}\n", format_event_line(e)));
            }
            sessions.push('\n');
        }
        self.write_wiki_page(project, "sessions", "Sessions", "sessions.md", &sessions)?;

        // --- Topics (keyword buckets) ---
        let topics = cluster_topics(&recent);
        let mut topics_index = String::from("# Topics\n\nDerived from captured traffic keywords.\n\n");
        for (topic, events) in &topics {
            let slug = slugify(topic);
            topics_index.push_str(&format!(
                "- [{topic}]({slug}.md) — {} events\n",
                events.len()
            ));
            let mut page = format!("# {topic}\n\n");
            for e in events.iter().take(30) {
                page.push_str(&format!("- {}\n", format_event_line(e)));
            }
            self.write_wiki_page(
                project,
                &format!("topics/{slug}"),
                topic,
                &format!("topics/{slug}.md"),
                &page,
            )?;
        }
        if topics.is_empty() {
            topics_index.push_str("\n_No topics yet — capture more traffic._\n");
        }
        self.write_wiki_page(
            project,
            "topics/index",
            "Topics",
            "topics/index.md",
            &topics_index,
        )?;

        // --- Providers (any prox-supported id seen in traffic) ---
        let mut by_provider: BTreeMap<String, Vec<&TrafficEvent>> = BTreeMap::new();
        for e in &recent {
            let key = rivet_core::normalize_provider_id(&provider_key(e));
            by_provider.entry(key).or_default().push(e);
        }
        for (name, events) in &by_provider {
            let slug = slugify(name);
            let mut body = format!("# {name}\n\n_{} recent events_\n\n", events.len());
            for e in events.iter().take(40) {
                body.push_str(&format!("- {}\n", format_event_line(e)));
            }
            self.write_wiki_page(
                project,
                &format!("providers/{slug}"),
                &format!("{name} traffic"),
                &format!("providers/{slug}.md"),
                &body,
            )?;
        }

        // --- Optional LLM overview via local proxy ---
        if let Some(model) = cfg.wiki_model.as_deref() {
            match self.generate_llm_overview(cfg, model, &recent, &totals).await {
                Ok(markdown) => {
                    self.write_wiki_page(
                        project,
                        "overview-llm",
                        "LLM overview",
                        "overview-llm.md",
                        &markdown,
                    )?;
                    info!(model, "wiki worker wrote LLM overview");
                }
                Err(err) => {
                    warn!(?err, "wiki LLM overview skipped (proxy/model unavailable)");
                    let fallback = format!(
                        "# LLM overview\n\n_Could not reach the proxy model `{model}`._\n\n```\n{err:#}\n```\n\nEnable the proxy, sign in a provider account that serves this model, then wait for the next worker tick.\n"
                    );
                    self.write_wiki_page(
                        project,
                        "overview-llm",
                        "LLM overview",
                        "overview-llm.md",
                        &fallback,
                    )?;
                }
            }
        }

        self.meta
            .set_job_cursor("wiki", &Utc::now().to_rfc3339())?;
        debug!(project, "wiki worker upserted pages");
        Ok(())
    }

    async fn generate_llm_overview(
        &self,
        cfg: &RivetConfig,
        model: &str,
        recent: &[TrafficEvent],
        totals: &rivet_core::UsageTotals,
    ) -> Result<String> {
        let mut digest = String::new();
        digest.push_str(&format!(
            "Totals: {} events, {} tokens in, {} tokens out.\n\nRecent traffic:\n",
            totals.events, totals.tokens_in, totals.tokens_out
        ));
        for e in recent.iter().take(40) {
            digest.push_str(&format!("{}\n", format_event_line(e)));
        }
        let prompt = format!(
            "You are documenting a local AI traffic hub called Rivet.\n\
             Write a concise markdown wiki overview (no preamble) with sections:\n\
             ## Summary\n## Themes\n## Risks / errors\n## Suggested next pages\n\
             Use only the traffic digest below.\n\n{digest}"
        );

        let url = format!("{}/v1/chat/completions", cfg.proxy_base_url());
        let res = self
            .http
            .post(&url)
            .bearer_auth(&cfg.proxy_access_key)
            .json(&json!({
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": "You write crisp project wiki pages in markdown."},
                    {"role": "user", "content": prompt}
                ]
            }))
            .send()
            .await
            .context("wiki chat request")?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!("chat HTTP {status}: {body}");
        }
        let parsed: ChatResponse = res.json().await.context("chat json")?;
        let content = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .unwrap_or_default();
        if content.trim().is_empty() {
            anyhow::bail!("empty chat completion");
        }
        Ok(format!(
            "# LLM overview\n\n_Generated {} via `{model}` through Rivet proxy_\n\n{content}\n",
            Utc::now().format("%Y-%m-%d %H:%M UTC")
        ))
    }

    fn write_wiki_page(
        &self,
        project: &str,
        id_suffix: &str,
        title: &str,
        relative: &str,
        body: &str,
    ) -> Result<()> {
        let abs = self.paths.wiki_dir().join(project).join(relative);
        if let Some(parent) = abs.as_std_path().parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(abs.as_std_path(), body)?;
        let page = WikiPageMeta {
            id: format!("{project}/{id_suffix}"),
            project_id: project.to_string(),
            title: title.to_string(),
            path: relative_wiki_path(&self.paths, abs.as_std_path()),
            updated_at: Utc::now().to_rfc3339(),
        };
        self.meta.upsert_wiki_page(&page)?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct EmbeddingsResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: Option<String>,
}

fn format_event_line(event: &TrafficEvent) -> String {
    let preview = event
        .content
        .as_deref()
        .unwrap_or("")
        .chars()
        .take(140)
        .collect::<String>()
        .replace('|', "/")
        .replace('\n', " ");
    let provider = provider_key(event);
    let model = event.model.as_deref().unwrap_or("-");
    format!(
        "`{}` · {} · `{}` · {}/{} tok · {}",
        event.ts.format("%Y-%m-%d %H:%M"),
        provider,
        model,
        event.tokens_in,
        event.tokens_out,
        preview
    )
}

fn provider_key(event: &TrafficEvent) -> String {
    serde_json::to_value(event.provider)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "other".into())
}

fn cluster_topics(events: &[TrafficEvent]) -> BTreeMap<String, Vec<&TrafficEvent>> {
    let mut buckets: HashMap<String, Vec<&TrafficEvent>> = HashMap::new();
    for event in events {
        let text = event.content.as_deref().unwrap_or("");
        let mut counts: HashMap<String, usize> = HashMap::new();
        for tok in text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() > 4)
            .map(|t| t.to_ascii_lowercase())
        {
            if STOP.contains(&tok.as_str()) || tok.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            *counts.entry(tok).or_default() += 1;
        }
        let mut scored: Vec<(String, usize)> = counts.into_iter().collect();
        scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let topic = scored
            .first()
            .map(|(t, _)| t.clone())
            .unwrap_or_else(|| "general".into());
        buckets.entry(topic).or_default().push(event);
    }
    let mut ordered: Vec<_> = buckets.into_iter().collect();
    ordered.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    ordered.into_iter().take(12).collect()
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().take(40) {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "topic".into()
    } else {
        trimmed
    }
}

const STOP: &[&str] = &[
    "about", "after", "again", "being", "between", "could", "every", "first", "their", "there",
    "these", "those", "through", "under", "where", "which", "while", "would", "should", "please",
    "thanks", "using", "with", "from", "this", "that", "have", "here", "your", "what", "when",
    "will", "into", "just", "like", "make", "need", "other", "some", "than", "then", "them",
    "content", "messages", "assistant", "system", "model", "tokens", "request", "response",
];

fn relative_wiki_path(paths: &RivetPaths, absolute: &std::path::Path) -> String {
    absolute
        .strip_prefix(paths.as_root().as_std_path())
        .unwrap_or(absolute)
        .to_string_lossy()
        .to_string()
}
