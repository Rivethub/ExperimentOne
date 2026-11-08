//! Background workers.
//!
//! Local: Tokio tasks. Enterprise: same logic as queue consumers.
//! Vectorize + wiki run when capabilities are enabled.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use rivet_core::{lexical_embed, RivetConfig, RivetPaths};
use rivet_store::{MetaStore, TrafficStore, WikiPageMeta};
use tracing::{debug, info};

pub struct WorkerPool {
    store: Arc<dyn TrafficStore>,
    meta: Arc<MetaStore>,
    paths: RivetPaths,
    config: RivetConfig,
}

impl WorkerPool {
    pub fn new(
        store: Arc<dyn TrafficStore>,
        meta: Arc<MetaStore>,
        paths: RivetPaths,
        config: RivetConfig,
    ) -> Self {
        Self {
            store,
            meta,
            paths,
            config,
        }
    }

    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(15));
            loop {
                tick.tick().await;
                if let Err(err) = self.tick_once().await {
                    tracing::warn!(?err, "worker tick failed");
                }
            }
        })
    }

    async fn tick_once(&self) -> Result<()> {
        let totals = self.store.usage_totals().await?;
        debug!(?totals, "worker heartbeat");

        if self.config.capabilities.vector_search {
            self.embed_new_events().await?;
        }
        if self.config.capabilities.wiki {
            self.upsert_wiki().await?;
        }
        Ok(())
    }

    async fn embed_new_events(&self) -> Result<()> {
        let recent = self.store.recent(100).await?;
        let mut n = 0u32;
        for event in recent {
            let id = event.id.to_string();
            if self.meta.embedding_for(&id)?.is_some() {
                continue;
            }
            let text = event.content.as_deref().unwrap_or("");
            if text.trim().is_empty() {
                continue;
            }
            // Prefer remote embedding model when configured; fall back to lexical.
            let dims = if self.config.embedding_model.is_some() {
                // Proxy-backed embeddings land in a follow-up; lexical keeps MCP useful today.
                lexical_embed(text)
            } else {
                lexical_embed(text)
            };
            self.meta.upsert_embedding(&id, &dims)?;
            n += 1;
        }
        if n > 0 {
            info!(n, "vector worker embedded events");
        }
        let cursor = Utc::now().to_rfc3339();
        self.meta.set_job_cursor("vectorize", &cursor)?;
        Ok(())
    }

    async fn upsert_wiki(&self) -> Result<()> {
        let project = &self.config.wiki_project_id;
        let wiki_root = self.paths.wiki_dir().join(project);
        std::fs::create_dir_all(wiki_root.as_std_path())?;

        let totals = self.store.usage_totals().await?;
        let recent = self.store.recent(25).await?;
        let index_path = wiki_root.join("README.md");
        let mut body = String::new();
        body.push_str("# Rivet project wiki\n\n");
        body.push_str(&format!(
            "_Auto-updated {} — {}_\n\n",
            Utc::now().to_rfc3339(),
            if self.config.wiki_model.is_some() {
                "text-gen model configured (stub summary until proxy gen is wired)"
            } else {
                "local stub (set wiki_model to enable LLM upserts)"
            }
        ));
        body.push_str("## Traffic snapshot\n\n");
        body.push_str(&format!(
            "- Events: **{}**\n- Tokens in: **{}**\n- Tokens out: **{}**\n\n",
            totals.events, totals.tokens_in, totals.tokens_out
        ));
        body.push_str("## Recent captures\n\n");
        for event in &recent {
            let preview = event
                .content
                .as_deref()
                .unwrap_or("")
                .chars()
                .take(120)
                .collect::<String>()
                .replace('\n', " ");
            body.push_str(&format!(
                "- `{}` · {} · {}\n",
                event.ts.format("%Y-%m-%d %H:%M"),
                serde_json::to_value(event.provider)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "other".into()),
                preview
            ));
        }
        body.push('\n');
        std::fs::write(index_path.as_std_path(), &body)?;

        let page = WikiPageMeta {
            id: format!("{project}/README"),
            project_id: project.clone(),
            title: "Project overview".into(),
            path: relative_wiki_path(&self.paths, index_path.as_std_path()),
            updated_at: Utc::now().to_rfc3339(),
        };
        self.meta.upsert_wiki_page(&page)?;
        self.meta
            .set_job_cursor("wiki", &Utc::now().to_rfc3339())?;
        debug!(project, "wiki worker upserted README");
        Ok(())
    }
}

fn relative_wiki_path(paths: &RivetPaths, absolute: &std::path::Path) -> String {
    absolute
        .strip_prefix(paths.as_root().as_std_path())
        .unwrap_or(absolute)
        .to_string_lossy()
        .to_string()
}
