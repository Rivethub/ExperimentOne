//! Wiki extract → patch → bound → archive (`RivetHub` / `RivetOS` parity).
//!
//! Budgets: 16 KiB article, 4 KiB per `###` section, 12 KiB sections total,
//! summary 2400 chars, monthly `archive/<slug>/YYYY-MM[.N].md` (64 KiB).

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
// BTreeSet used by rebase + identity consolidate.
use std::fmt::Write as _;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;

pub const ARTICLE_BUDGET: usize = 16 * 1024;
pub const SECTION_BUDGET: usize = 4 * 1024;
pub const SECTIONS_BUDGET: usize = 12 * 1024;
pub const SUMMARY_LIMIT: usize = 2400;
pub const HISTORY_LINE: usize = 200;
pub const HISTORY_CAP: usize = 48;
pub const CITATIONS_CAP: usize = 40;
pub const SOURCES_CAP: usize = 64;
pub const ENTITIES_CAP: usize = 64;
pub const ARCHIVE_SEGMENT_BUDGET: usize = 64 * 1024;
pub const REVISION_SUPERSEDED_ARTICLE: &str = "Superseded article";
pub const REVISION_SUPERSEDED_SUMMARY: &str = "Superseded current state";
pub const REVISION_SUMMARY_OVERFLOW: &str = "Summary overflow";
pub const KNOWLEDGE_MARKER: &str = "<!-- rivet:knowledge -->";
pub const COALESCE_MORE: usize = 7;
pub const COALESCE_CHARS: usize = 24_000;
pub const RECOMPILE_BYTES: usize = 60 * 1024;
const REPEAT_FLOOR: usize = 40;
const REPEAT_WORDS: usize = 12;
const REPEAT_PERCENT: usize = 80;

/// True when a page was written by the knowledge extract path (do not clobber).
#[must_use]
pub fn is_knowledge_page(text: &str) -> bool {
    text.contains(KNOWLEDGE_MARKER)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WikiAction {
    Create,
    Update,
}

#[derive(Debug, Clone, Default)]
pub struct PageCitation {
    pub id: String,
    pub kind: String,
    pub date: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PageSource {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Default)]
pub struct WikiPage {
    pub title: String,
    pub slug: String,
    pub summary: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub entities: Vec<String>,
    pub related: Vec<String>,
    pub article: String,
    pub history: Vec<String>,
    pub citations: Vec<PageCitation>,
    pub sources: Vec<PageSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchMode {
    Replace,
    Append,
}

#[derive(Debug, Clone)]
pub struct ArticlePatch {
    pub heading: String,
    pub body: String,
    pub mode: PatchMode,
}

#[derive(Debug, Clone)]
pub struct PagePatch {
    pub action: WikiAction,
    pub slug: String,
    pub title: String,
    pub summary: Option<String>,
    pub article: Option<String>,
    pub article_patches: Vec<ArticlePatch>,
    pub history_entry: Option<String>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub entities: Vec<String>,
    pub related: Vec<String>,
    pub citations: Vec<PageCitation>,
    pub sources: Vec<PageSource>,
    /// Optional entity type path (e.g. `People`, `Tools › CLI`).
    pub entity_type: Option<String>,
    pub allow_shrink: bool,
}

#[derive(Debug, Clone)]
pub struct Archived {
    pub heading: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct WikiTopicStats {
    pub slug: String,
    pub title: String,
    pub citations: u64,
    pub history: u64,
    pub bound: bool,
}

#[derive(Debug, Clone)]
pub struct WikiFold {
    pub cluster: String,
    pub parent: String,
    pub children: Vec<String>,
}

/// Normalize a wiki slug (lowercase kebab).
#[must_use]
pub fn normalize_slug(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch.is_whitespace())
            && !out.ends_with('-')
            && !out.is_empty()
        {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Compact inventory of an existing page for extract prompts.
#[must_use]
pub fn page_inventory(page: &WikiPage) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "slug: {}", page.slug);
    let _ = writeln!(out, "title: {}", page.title);
    if !page.summary.is_empty() {
        let _ = writeln!(out, "summary: {}", page.summary);
    }
    let headings: Vec<_> =
        split_sections(&page.article).into_iter().filter_map(|(h, _)| h).collect();
    if !headings.is_empty() {
        let _ = writeln!(out, "sections: {}", headings.join(", "));
    }
    if !page.related.is_empty() {
        let _ = writeln!(out, "related: {}", page.related.join(", "));
    }
    if !page.citations.is_empty() {
        let _ = writeln!(out, "citations: {}", page.citations.len());
    }
    out
}

/// Fit text into `budget` bytes, returning (kept, overflow).
#[must_use]
pub fn fit(text: &str, budget: usize) -> (String, String) {
    let text = text.trim();
    if text.len() <= budget {
        return (text.to_string(), String::new());
    }
    let blocks = fence_aware_blocks(text);
    let mut kept = Vec::new();
    let mut used = 0usize;
    let mut rest_at = blocks.len();
    for (i, block) in blocks.iter().enumerate() {
        let cost = block.len() + if kept.is_empty() { 0 } else { 2 };
        if used + cost > budget {
            rest_at = i;
            break;
        }
        used += cost;
        kept.push(block.clone());
    }
    let mut overflow: Vec<String> = blocks.into_iter().skip(rest_at).collect();
    if kept.is_empty() {
        if let Some(first) = overflow.first().cloned() {
            let cut = first
                .char_indices()
                .take_while(|(i, _)| *i < budget)
                .last()
                .map_or(0, |(i, c)| i + c.len_utf8());
            kept.push(first[..cut].trim_end().to_string());
            if let Some(slot) = overflow.first_mut() {
                *slot = first[cut..].trim_start().to_string();
            }
        }
    }
    overflow.retain(|b| !b.is_empty());
    (kept.join("\n\n"), overflow.join("\n\n"))
}

fn fence_aware_blocks(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            fenced = !fenced;
            current.push(line);
            continue;
        }
        if !fenced && line.trim().is_empty() {
            let block = current.join("\n");
            let block = block.trim();
            if !block.is_empty() {
                found.push(block.to_string());
            }
            current.clear();
        } else {
            current.push(line);
        }
    }
    let block = current.join("\n");
    let block = block.trim();
    if !block.is_empty() {
        found.push(block.to_string());
    }
    found
}

/// Blocks present in `before` but missing from `after` (normalized).
#[must_use]
pub fn dropped(before: &str, after: &str) -> String {
    let after_norm = normalize_words(after);
    fence_aware_blocks(before)
        .into_iter()
        .filter(|block| !after_norm.contains(&normalize_words(block)))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Three-way block merge (RivetHub-style). When `base == current`, returns `ours`.
#[must_use]
pub fn rebase(base: &str, ours: &str, current: &str) -> String {
    if normalize_words(base) == normalize_words(current) {
        return ours.trim().to_string();
    }
    let ours_blocks = fence_aware_blocks(ours);
    let ours_norm: BTreeSet<String> = ours_blocks.iter().map(|b| normalize_words(b)).collect();
    let base_norm: BTreeSet<String> =
        fence_aware_blocks(base).into_iter().map(|b| normalize_words(&b)).collect();
    let mut merged: Vec<String> = fence_aware_blocks(current)
        .into_iter()
        .filter(|block| {
            let key = normalize_words(block);
            ours_norm.contains(&key) || !base_norm.contains(&key)
        })
        .collect();
    let mut anchor: Option<String> = None;
    for block in &ours_blocks {
        let key = normalize_words(block);
        if !merged.iter().any(|kept| normalize_words(kept) == key) {
            let at = anchor
                .as_ref()
                .and_then(|before| merged.iter().position(|kept| normalize_words(kept) == *before))
                .map_or(0, |index| index.saturating_add(1));
            merged.insert(at.min(merged.len()), block.clone());
        }
        anchor = Some(key);
    }
    merged.join("\n\n")
}

/// Prefer rewrite headings; keep prior `###` sections the rewrite omitted.
#[must_use]
pub fn merge_article_rewrite(prev: &str, next: &str) -> String {
    if prev.trim().is_empty() {
        return next.to_string();
    }
    if next.trim().is_empty() {
        return prev.to_string();
    }
    let mut out = demote_headings(next);
    let next_headings: BTreeSet<String> = split_sections(&out)
        .into_iter()
        .filter_map(|(h, _)| h.map(|s| s.to_ascii_lowercase()))
        .collect();
    for (heading, body) in split_sections(prev) {
        let Some(h) = heading else {
            continue;
        };
        if next_headings.contains(&h.to_ascii_lowercase()) {
            continue;
        }
        let _ = write!(out, "\n\n### {h}\n\n{}", body.trim());
    }
    // When base == current, rebase returns ours; keeps the three-way entry point hot.
    rebase(prev, &out, prev)
}

fn drop_repeats(text: &str) -> String {
    let blocks = fence_aware_blocks(text);
    let mut kept = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for block in blocks {
        let norm = normalize_words(&block);
        if block.len() >= REPEAT_FLOOR && is_repeat(&norm, &seen) {
            continue;
        }
        if !norm.is_empty() {
            seen.push(norm);
        }
        kept.push(block);
    }
    kept.join("\n\n")
}

fn normalize_words(text: &str) -> String {
    text.split_whitespace().map(str::to_ascii_lowercase).collect::<Vec<_>>().join(" ")
}

fn is_repeat(norm: &str, seen: &[String]) -> bool {
    let words: Vec<&str> = norm.split_whitespace().collect();
    if words.len() < REPEAT_WORDS {
        return false;
    }
    for prior in seen {
        let prior_words: Vec<&str> = prior.split_whitespace().collect();
        if prior_words.is_empty() {
            continue;
        }
        let overlap = words.iter().filter(|w| prior_words.contains(w)).count();
        let denom = words.len().max(prior_words.len());
        if overlap.saturating_mul(100) / denom >= REPEAT_PERCENT {
            return true;
        }
    }
    false
}

#[must_use]
pub fn history_line(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= HISTORY_LINE {
        return text.to_string();
    }
    let mut kept: String = text.chars().take(HISTORY_LINE.saturating_sub(1)).collect();
    if let Some(at) = kept.rfind(". ").filter(|at| *at * 2 >= kept.len()) {
        kept.truncate(at + 1);
    } else {
        kept = kept.trim_end().to_string();
        kept.push('…');
    }
    kept
}

/// Ensure summary starts with "Currently," when non-empty.
#[must_use]
pub fn normalize_summary(summary: &str) -> String {
    let s = summary.trim();
    if s.is_empty() {
        return String::new();
    }
    if s.to_ascii_lowercase().starts_with("currently") {
        s.to_string()
    } else {
        format!("Currently, {s}")
    }
}

/// Parse an on-disk knowledge page into a structured [`WikiPage`].
#[must_use]
pub fn parse_wiki_page(slug: &str, raw: &str) -> WikiPage {
    let mut page = WikiPage { slug: slug.to_string(), ..WikiPage::default() };
    let body = raw.replace(KNOWLEDGE_MARKER, "").trim().to_string();
    let mut lines = body.lines().peekable();
    if let Some(first) = lines.peek().copied() {
        if let Some(title) = first.strip_prefix("# ") {
            page.title = title.trim().to_string();
            lines.next();
        }
    }
    let rest = lines.collect::<Vec<_>>().join("\n");
    let (before_hist, history) = match rest.find("\n## History\n") {
        Some(idx) => (rest[..idx].to_string(), rest[idx..].to_string()),
        None => (rest, String::new()),
    };
    page.history = history.lines().filter(|l| l.starts_with("- ")).map(str::to_string).collect();

    let (main, citations_src) = split_named_section(&before_hist, "## Citations");
    let (main, sources_src) = split_named_section(&main, "## Sources");
    page.citations = parse_citation_lines(&citations_src);
    page.sources = parse_source_lines(&sources_src);

    let mut article_parts = Vec::new();
    for block in main.split("\n\n") {
        let b = block.trim();
        if b.is_empty() {
            continue;
        }
        if let Some(rest) = b.strip_prefix("_Aliases:_") {
            page.aliases = split_csv(rest);
            continue;
        }
        if let Some(rest) = b.strip_prefix("_Tags:_") {
            page.tags = split_csv(rest);
            continue;
        }
        if let Some(rest) = b.strip_prefix("_Entities:_") {
            page.entities = split_csv(rest);
            continue;
        }
        if let Some(rest) = b.strip_prefix("_Related:_") {
            page.related = split_csv(rest);
            continue;
        }
        if page.summary.is_empty()
            && !b.starts_with('#')
            && b.to_ascii_lowercase().starts_with("currently")
        {
            page.summary = b.to_string();
            continue;
        }
        article_parts.push(b);
    }
    page.article = article_parts.join("\n\n");
    if page.title.is_empty() {
        page.title = slug.to_string();
    }
    page
}

fn split_named_section(text: &str, heading: &str) -> (String, String) {
    let marker = format!("\n{heading}\n");
    text.find(&marker).map_or_else(
        || (text.to_string(), String::new()),
        |idx| {
            let after = &text[idx + marker.len()..];
            let end = after.find("\n## ").unwrap_or(after.len());
            (format!("{}{}", &text[..idx], &after[end..]), after[..end].to_string())
        },
    )
}

fn parse_citation_lines(text: &str) -> Vec<PageCitation> {
    text.lines()
        .filter_map(|line| {
            let item = line.trim().strip_prefix("- ")?;
            let (id, rest) = if let Some(rest) = item.strip_prefix('`') {
                let end = rest.find('`')?;
                (rest[..end].to_string(), rest[end + 1..].trim().to_string())
            } else {
                let mut parts = item.split_whitespace();
                let id = parts.next()?.to_string();
                (id, parts.collect::<Vec<_>>().join(" "))
            };
            if id.is_empty() {
                return None;
            }
            let mut kind = "summary".to_string();
            let mut date = None;
            let mut note = None;
            for part in rest.split(" · ").map(str::trim).filter(|p| !p.is_empty()) {
                if part.eq_ignore_ascii_case("event") || part.eq_ignore_ascii_case("summary") {
                    kind = part.to_ascii_lowercase();
                } else if part.len() == 10 && part.chars().nth(4) == Some('-') {
                    date = Some(part.to_string());
                } else {
                    note = Some(part.to_string());
                }
            }
            Some(PageCitation { id, kind, date, note })
        })
        .collect()
}

fn parse_source_lines(text: &str) -> Vec<PageSource> {
    text.lines()
        .filter_map(|line| {
            let item = line.trim().strip_prefix("- ")?;
            let (id, label) = if let Some((a, b)) = item.split_once('—') {
                (a.trim(), b.trim())
            } else if let Some((a, b)) = item.split_once(" - ") {
                (a.trim(), b.trim())
            } else {
                (item, item)
            };
            let id = id.trim_matches('`');
            (!id.is_empty()).then(|| PageSource { id: id.to_string(), label: label.to_string() })
        })
        .collect()
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// Serialize a structured page for disk (knowledge-managed).
#[must_use]
pub fn render_wiki_page(page: &WikiPage) -> String {
    let mut out = String::new();
    out.push_str(KNOWLEDGE_MARKER);
    out.push('\n');
    let _ = writeln!(out, "# {}\n", page.title);
    if !page.summary.is_empty() {
        out.push_str(&page.summary);
        out.push_str("\n\n");
    }
    if !page.aliases.is_empty() {
        let _ = write!(out, "_Aliases:_ {}\n\n", page.aliases.join(", "));
    }
    if !page.tags.is_empty() {
        let _ = write!(out, "_Tags:_ {}\n\n", page.tags.join(", "));
    }
    if !page.entities.is_empty() {
        let _ = write!(out, "_Entities:_ {}\n\n", page.entities.join(", "));
    }
    if !page.related.is_empty() {
        let _ = write!(out, "_Related:_ {}\n\n", page.related.join(", "));
    }
    if !page.article.is_empty() {
        out.push_str(page.article.trim());
        out.push('\n');
    }
    if !page.citations.is_empty() {
        out.push_str("\n## Citations\n\n");
        for c in &page.citations {
            let mut line = format!("- `{}` · {}", c.id, c.kind);
            if let Some(date) = &c.date {
                line.push_str(" · ");
                line.push_str(date);
            }
            if let Some(note) = &c.note {
                line.push_str(" · ");
                line.push_str(note);
            }
            out.push_str(&line);
            out.push('\n');
        }
    }
    if !page.sources.is_empty() {
        out.push_str("\n## Sources\n\n");
        for s in &page.sources {
            let _ = writeln!(out, "- `{}` — {}", s.id, s.label);
        }
    }
    if !page.history.is_empty() {
        out.push_str("\n## History\n\n");
        out.push_str(&page.history.join("\n"));
        out.push('\n');
    }
    out
}

/// Merge a patch into an optional previous page.
#[must_use]
pub fn apply_patch(prev: Option<WikiPage>, patch: &PagePatch) -> WikiPage {
    let mut page = prev.unwrap_or_else(|| WikiPage {
        slug: patch.slug.clone(),
        title: patch.title.clone(),
        ..WikiPage::default()
    });
    page.slug.clone_from(&patch.slug);
    if !patch.title.trim().is_empty() {
        page.title.clone_from(&patch.title);
    }
    merge_unique(&mut page.aliases, &patch.aliases);
    merge_unique(&mut page.tags, &patch.tags);
    merge_unique(&mut page.entities, &patch.entities);
    merge_unique(&mut page.related, &patch.related);
    merge_citations(&mut page.citations, &patch.citations);
    merge_sources(&mut page.sources, &patch.sources);

    if let Some(summary) = patch.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let next = normalize_summary(summary);
        if patch.allow_shrink || next.len() >= page.summary.len() || page.summary.is_empty() {
            if !page.summary.is_empty() && normalize_words(&page.summary) != normalize_words(&next)
            {
                page.history.push(format!(
                    "- {} — {REVISION_SUPERSEDED_SUMMARY}",
                    Utc::now().format("%Y-%m-%d")
                ));
            }
            page.summary = next;
        }
    }

    if let Some(article) = patch.article.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let demoted = demote_headings(article);
        if patch.allow_shrink || demoted.len() >= page.article.len() / 2 || page.article.is_empty()
        {
            let prev_article = page.article.clone();
            page.article = if prev_article.is_empty() {
                demoted
            } else {
                merge_article_rewrite(&prev_article, &demoted)
            };
            if !prev_article.is_empty() && !dropped(&prev_article, &page.article).is_empty() {
                page.history.push(format!(
                    "- {} — {REVISION_SUPERSEDED_ARTICLE}",
                    Utc::now().format("%Y-%m-%d")
                ));
            }
        }
    }

    for ap in &patch.article_patches {
        apply_section_patch(&mut page.article, ap);
    }

    if let Some(entry) = patch.history_entry.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        page.history.push(format!("- {} — {}", Utc::now().format("%Y-%m-%d"), history_line(entry)));
    }
    page
}

fn merge_citations(dst: &mut Vec<PageCitation>, src: &[PageCitation]) {
    for c in src {
        if c.id.trim().is_empty() {
            continue;
        }
        if !dst.iter().any(|d| d.id == c.id) {
            dst.push(c.clone());
        }
    }
    if dst.len() > CITATIONS_CAP {
        let _ = dst.drain(..dst.len() - CITATIONS_CAP);
    }
}

fn merge_sources(dst: &mut Vec<PageSource>, src: &[PageSource]) {
    for s in src {
        if s.id.trim().is_empty() {
            continue;
        }
        if !dst.iter().any(|d| d.id == s.id) {
            dst.push(s.clone());
        }
    }
    if dst.len() > SOURCES_CAP {
        let _ = dst.drain(..dst.len() - SOURCES_CAP);
    }
}

fn demote_headings(article: &str) -> String {
    article
        .lines()
        .map(|line| {
            if line.starts_with("## ") && !line.starts_with("### ") {
                format!("### {}", line.trim_start_matches('#').trim())
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn apply_section_patch(article: &mut String, patch: &ArticlePatch) {
    let heading = patch.heading.trim().trim_start_matches('#').trim();
    if heading.is_empty() {
        return;
    }
    let marker = format!("### {heading}");
    let body = demote_headings(patch.body.trim());
    let section = format!("{marker}\n\n{body}");
    if let Some(idx) = article.find(&marker) {
        let after = &article[idx + marker.len()..];
        let end = after.find("\n### ").map_or(article.len(), |i| idx + marker.len() + i);
        match patch.mode {
            PatchMode::Replace => {
                let mut next = String::new();
                next.push_str(&article[..idx]);
                next.push_str(&section);
                if end < article.len() {
                    next.push('\n');
                    next.push_str(article[end..].trim_start());
                }
                *article = next.trim().to_string();
            },
            PatchMode::Append => {
                let mut next = article[..end].trim_end().to_string();
                next.push_str("\n\n");
                next.push_str(&body);
                if end < article.len() {
                    next.push('\n');
                    next.push_str(article[end..].trim_start());
                }
                *article = next.trim().to_string();
            },
        }
    } else {
        if !article.is_empty() {
            article.push_str("\n\n");
        }
        article.push_str(&section);
    }
}

fn merge_unique(dst: &mut Vec<String>, src: &[String]) {
    for s in src {
        let t = s.trim();
        if t.is_empty() {
            continue;
        }
        if !dst.iter().any(|d| d.eq_ignore_ascii_case(t)) {
            dst.push(t.to_string());
        }
    }
    dst.truncate(64);
}

/// Enforce article / section budgets; return content to archive.
#[must_use]
pub fn bound_page(page: &mut WikiPage) -> Vec<Archived> {
    let mut archived = Vec::new();
    page.article = drop_repeats(&page.article);

    if page.entities.len() > ENTITIES_CAP {
        let spill = page.entities.split_off(ENTITIES_CAP);
        archived.push(Archived { heading: "Entities".into(), body: spill.join(", ") });
    }

    let (sum_kept, sum_over) = fit(&normalize_summary(&page.summary), SUMMARY_LIMIT);
    page.summary = sum_kept;
    if !sum_over.is_empty() {
        archived.push(Archived { heading: REVISION_SUMMARY_OVERFLOW.into(), body: sum_over });
    }

    let sections = split_sections(&page.article);
    let mut kept_sections = Vec::new();
    let mut used = 0usize;
    for (heading, body) in sections {
        let (body_kept, body_over) = fit(&body, SECTION_BUDGET);
        if !body_over.is_empty() {
            archived.push(Archived {
                heading: heading.clone().unwrap_or_else(|| "Section".into()),
                body: body_over,
            });
        }
        let block = match &heading {
            Some(h) => format!("### {h}\n\n{body_kept}"),
            None => body_kept,
        };
        let cost = block.len() + if kept_sections.is_empty() { 0 } else { 2 };
        if used + cost > SECTIONS_BUDGET && !kept_sections.is_empty() {
            archived.push(Archived {
                heading: heading.unwrap_or_else(|| "Section".into()),
                body: block,
            });
            continue;
        }
        used += cost;
        kept_sections.push(block);
    }
    page.article = kept_sections.join("\n\n");

    let (art_kept, art_over) = fit(&page.article, ARTICLE_BUDGET);
    page.article = art_kept;
    if !art_over.is_empty() {
        archived.push(Archived { heading: "Article".into(), body: art_over });
    }

    if page.citations.len() > CITATIONS_CAP {
        let _ = page.citations.drain(..page.citations.len() - CITATIONS_CAP);
    }
    if page.sources.len() > SOURCES_CAP {
        let _ = page.sources.drain(..page.sources.len() - SOURCES_CAP);
    }

    if page.history.len() > HISTORY_CAP {
        let spill = page.history.drain(..page.history.len() - HISTORY_CAP).collect::<Vec<_>>();
        archived.push(Archived { heading: "History".into(), body: spill.join("\n") });
        page.history.push(format!(
            "- {} — Moved {} history lines to archive.",
            Utc::now().format("%Y-%m-%d"),
            spill.len()
        ));
    }
    archived
}

fn split_sections(article: &str) -> Vec<(Option<String>, String)> {
    let mut out = Vec::new();
    let mut cur_heading: Option<String> = None;
    let mut cur_body = String::new();
    for line in article.lines() {
        if let Some(rest) = line.strip_prefix("### ") {
            if cur_heading.is_some() || !cur_body.trim().is_empty() {
                out.push((cur_heading.take(), cur_body.trim().to_string()));
                cur_body.clear();
            }
            cur_heading = Some(rest.trim().to_string());
        } else {
            cur_body.push_str(line);
            cur_body.push('\n');
        }
    }
    if cur_heading.is_some() || !cur_body.trim().is_empty() {
        out.push((cur_heading, cur_body.trim().to_string()));
    }
    out
}

/// Append archived chunks into monthly segment files under `archive/<slug>/`.
pub fn settle_archive(
    wiki_root: &Path,
    project: &str,
    slug: &str,
    archived: &[Archived],
) -> Result<Vec<PathBuf>> {
    if archived.is_empty() {
        return Ok(Vec::new());
    }
    let dir = wiki_root.join(project).join("archive").join(slug);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let month = Utc::now().format("%Y-%m").to_string();
    let mut path = dir.join(format!("{month}.md"));
    let mut part = 0u32;
    while path.is_file() {
        let len =
            std::fs::metadata(&path).map_or(0, |m| usize::try_from(m.len()).unwrap_or(usize::MAX));
        if len < ARCHIVE_SEGMENT_BUDGET {
            break;
        }
        part += 1;
        path = dir.join(format!("{month}.{part}.md"));
    }
    let mut chunk = String::new();
    if !path.is_file() {
        let _ = writeln!(chunk, "# Archive · {slug} · {month}\n");
    }
    let stamp = Utc::now().format("%Y-%m-%d %H:%M UTC");
    let _ = writeln!(chunk, "## Spill · {stamp}\n");
    for item in archived {
        let _ = writeln!(chunk, "### {}\n\n{}\n", item.heading, item.body.trim());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
    file.write_all(chunk.as_bytes())?;
    Ok(vec![path])
}

/// Apply a knowledge patch: load → merge → bound → write + archive.
pub fn apply_topic_patch(wiki_root: &Path, project: &str, patch: &PagePatch) -> Result<PathBuf> {
    let topics = wiki_root.join(project).join("topics");
    std::fs::create_dir_all(&topics)?;
    let page_path = topics.join(format!("{}.md", patch.slug));
    let prev = if page_path.is_file() {
        let raw = std::fs::read_to_string(&page_path).unwrap_or_default();
        Some(parse_wiki_page(&patch.slug, &raw))
    } else {
        None
    };
    let prev_article = prev.as_ref().map(|p| p.article.clone()).unwrap_or_default();
    let mut page = apply_patch(prev, patch);
    let mut archived = Vec::new();
    if patch.article.is_some() && !prev_article.is_empty() {
        let lost = dropped(&prev_article, &page.article);
        if !lost.is_empty() {
            archived.push(Archived { heading: REVISION_SUPERSEDED_ARTICLE.into(), body: lost });
        }
    }
    archived.extend(bound_page(&mut page));
    if !archived.is_empty() {
        let _ = settle_archive(wiki_root, project, &patch.slug, &archived)?;
        page.history.push(format!(
            "- {} — Archived {} overflow block(s).",
            Utc::now().format("%Y-%m-%d"),
            archived.len()
        ));
        if page.history.len() > HISTORY_CAP {
            let _ = page.history.drain(..page.history.len() - HISTORY_CAP);
        }
    }
    let rendered = render_wiki_page(&page);
    std::fs::write(&page_path, rendered)?;
    Ok(page_path)
}

/// Relative entity path: `entities/{type-slug}/{slug}.md` or `entities/{slug}.md`.
#[must_use]
pub fn entity_rel_path(slug: &str, entity_type: Option<&str>) -> String {
    entity_type.map(str::trim).filter(|s| !s.is_empty()).map_or_else(
        || format!("entities/{slug}.md"),
        |kind| {
            let type_slug = normalize_slug(&kind.replace(['›', '/'], "-"));
            if type_slug.is_empty() {
                format!("entities/{slug}.md")
            } else {
                format!("entities/{type_slug}/{slug}.md")
            }
        },
    )
}

/// Apply an entity page under `entities/` (optionally typed subfolder).
pub fn apply_entity_patch(wiki_root: &Path, project: &str, patch: &PagePatch) -> Result<PathBuf> {
    let rel = entity_rel_path(&patch.slug, patch.entity_type.as_deref());
    let page_path = wiki_root.join(project).join(&rel);
    if let Some(parent) = page_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let prev = if page_path.is_file() {
        let raw = std::fs::read_to_string(&page_path).unwrap_or_default();
        Some(parse_wiki_page(&patch.slug, &raw))
    } else {
        None
    };
    let mut page = apply_patch(prev, patch);
    if let Some(kind) = patch.entity_type.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        merge_unique(&mut page.tags, &[format!("type:{kind}")]);
    }
    let archived = bound_page(&mut page);
    if !archived.is_empty() {
        let _ = settle_archive(wiki_root, project, &format!("entity-{}", patch.slug), &archived)?;
    }
    std::fs::write(&page_path, render_wiki_page(&page))?;
    Ok(page_path)
}

/// List archive segment filenames for a topic slug (newest first).
#[must_use]
pub fn list_archive_segments(wiki_root: &Path, project: &str, slug: &str) -> Vec<String> {
    let dir = wiki_root.join(project).join("archive").join(slug);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            Path::new(&name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                .then_some(name)
        })
        .collect();
    names.sort();
    names.reverse();
    names
}

/// Fold a child page into a parent (consolidate), archiving the child body.
pub fn fold_page(
    wiki_root: &Path,
    project: &str,
    parent_slug: &str,
    child_slug: &str,
) -> Result<()> {
    let topics = wiki_root.join(project).join("topics");
    let parent_path = topics.join(format!("{parent_slug}.md"));
    let child_path = topics.join(format!("{child_slug}.md"));
    if !parent_path.is_file() || !child_path.is_file() {
        return Ok(());
    }
    let mut parent = parse_wiki_page(parent_slug, &std::fs::read_to_string(&parent_path)?);
    let child = parse_wiki_page(child_slug, &std::fs::read_to_string(&child_path)?);
    merge_unique(&mut parent.aliases, &child.aliases);
    merge_unique(&mut parent.aliases, std::slice::from_ref(&child.title));
    merge_unique(&mut parent.tags, &child.tags);
    merge_unique(&mut parent.entities, &child.entities);
    merge_unique(&mut parent.related, &child.related);
    parent.related.retain(|r| r != child_slug);
    merge_citations(&mut parent.citations, &child.citations);
    merge_sources(&mut parent.sources, &child.sources);
    if !child.article.trim().is_empty() {
        let _ =
            write!(parent.article, "\n\n### Merged · {}\n\n{}", child.title, child.article.trim());
    }
    parent.history.push(format!(
        "- {} — Folded `{child_slug}` into this page.",
        Utc::now().format("%Y-%m-%d")
    ));
    let archived = bound_page(&mut parent);
    let _ = settle_archive(wiki_root, project, parent_slug, &archived)?;
    let _ = settle_archive(
        wiki_root,
        project,
        child_slug,
        &[Archived {
            heading: "Folded".into(),
            body: format!("Merged into `{parent_slug}`.\n\n{}", child.article),
        }],
    )?;
    std::fs::write(&parent_path, render_wiki_page(&parent))?;
    let _ = std::fs::remove_file(&child_path);
    Ok(())
}

/// Byte size of a topic page plus its archive directory (for recompile gate).
#[must_use]
pub fn page_archive_bytes(wiki_root: &Path, project: &str, slug: &str) -> usize {
    let mut total = 0usize;
    let page = wiki_root.join(project).join("topics").join(format!("{slug}.md"));
    if let Ok(meta) = std::fs::metadata(&page) {
        total = total.saturating_add(usize::try_from(meta.len()).unwrap_or(usize::MAX));
    }
    let archive = wiki_root.join(project).join("archive").join(slug);
    if let Ok(entries) = std::fs::read_dir(&archive) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(usize::try_from(meta.len()).unwrap_or(usize::MAX));
            }
        }
    }
    total
}

/// Topic identity key after stripping noise words (RivetHub-style).
#[must_use]
pub fn topic_identity(slug: &str, title: &str) -> (String, usize) {
    let slug = normalize_slug(slug);
    let title_slug = normalize_slug(title);
    let mut words: Vec<&str> = slug.split('-').filter(|w| !w.is_empty()).collect();
    let total = words.len();
    if let Some(last) = words.last().copied() {
        if last.len() == 1
            && last.as_bytes()[0].is_ascii_digit()
            && !title_slug.split('-').any(|w| w == last)
        {
            words.pop();
        }
    }
    let mut kept: Vec<String> =
        words.into_iter().filter(|w| !is_noise_word(w)).map(singular).collect();
    if kept.is_empty() {
        return (slug, 0);
    }
    let noise = total.saturating_sub(kept.len());
    kept.sort_unstable();
    kept.dedup();
    (kept.join("-"), noise)
}

fn is_noise_word(word: &str) -> bool {
    matches!(
        word,
        "rivet"
            | "rivetos"
            | "rivethub"
            | "project"
            | "projects"
            | "the"
            | "and"
            | "of"
            | "for"
            | "in"
            | "on"
            | "to"
            | "with"
            | "via"
            | "by"
    )
}

fn singular(word: &str) -> String {
    if word.bytes().any(|b| b.is_ascii_digit()) {
        return word.to_string();
    }
    if let Some(stem) = word.strip_suffix("ies").filter(|s| s.len() > 1) {
        return format!("{stem}y");
    }
    if let Some(stem) = word.strip_suffix("sses") {
        return format!("{stem}ss");
    }
    if let Some(stem) = word.strip_suffix("xes") {
        return format!("{stem}x");
    }
    match word.strip_suffix('s') {
        Some(stem) if stem.len() > 2 && !stem.ends_with(['s', 'u', 'i']) => stem.to_string(),
        _ => word.to_string(),
    }
}

fn is_slug_variant(left: &str, right: &str) -> bool {
    let left = normalize_slug(left);
    let right = normalize_slug(right);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    left.strip_prefix(&right).is_some_and(|r| r.starts_with('-'))
        || right.strip_prefix(&left).is_some_and(|r| r.starts_with('-'))
}

/// Plan folds for duplicate / stem-variant topics.
#[must_use]
pub fn consolidation_plan(
    topics: &[WikiTopicStats],
    min_cluster: usize,
    limit: usize,
) -> Vec<WikiFold> {
    let mut groups: BTreeMap<String, Vec<(usize, &WikiTopicStats)>> = BTreeMap::new();
    for topic in topics {
        let (key, noise) = topic_identity(&topic.slug, &topic.title);
        groups.entry(key).or_default().push((noise, topic));
    }
    let mut planned = Vec::new();
    let mut folded: BTreeSet<String> = BTreeSet::new();
    for (cluster, mut members) in groups {
        if members.len() < min_cluster {
            continue;
        }
        members.sort_by_key(|&(noise, t)| {
            (
                !t.bound,
                noise,
                Reverse(t.citations),
                Reverse(t.history),
                t.slug.len(),
                t.slug.clone(),
            )
        });
        let parent = members[0].1.slug.clone();
        let children: Vec<String> = members
            .iter()
            .skip(1)
            .filter(|(_, t)| !t.bound || t.citations < members[0].1.citations)
            .map(|(_, t)| t.slug.clone())
            .filter(|s| s != &parent)
            .collect();
        if children.is_empty() {
            continue;
        }
        for c in &children {
            folded.insert(c.clone());
        }
        planned.push((members.len(), WikiFold { cluster, parent, children }));
    }

    // Stem variants among remaining.
    let remaining: Vec<&WikiTopicStats> =
        topics.iter().filter(|t| !folded.contains(&t.slug)).collect();
    for topic in &remaining {
        let variants: Vec<String> = remaining
            .iter()
            .filter(|o| o.slug != topic.slug && is_slug_variant(&o.slug, &topic.slug))
            .map(|o| o.slug.clone())
            .collect();
        if variants.is_empty() {
            continue;
        }
        let mut members = variants;
        members.push(topic.slug.clone());
        members.sort_by_key(|s| (s.len(), s.clone()));
        let parent = members[0].clone();
        let children: Vec<String> =
            members.into_iter().skip(1).filter(|s| !folded.contains(s)).collect();
        if children.is_empty() {
            continue;
        }
        for c in &children {
            folded.insert(c.clone());
        }
        planned.push((children.len() + 1, WikiFold { cluster: parent.clone(), parent, children }));
    }

    planned.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cluster.cmp(&b.1.cluster)));
    planned.into_iter().take(limit).map(|(_, f)| f).collect()
}

/// Parse wiki patches from an LLM response (validated).
///
/// Accepts either `{ "topics": [ ... ] }` (schemars extract schema) or a bare
/// JSON array for older prompts.
pub fn parse_wiki_patches(raw: &str) -> Vec<PagePatch> {
    let trimmed = raw.trim();
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            let obj = &trimmed[start..=end];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(obj) {
                if let Some(arr) = v.get("topics").and_then(|t| t.as_array()) {
                    return arr.iter().filter_map(value_to_patch).collect();
                }
            }
        }
    }
    let json = if let Some(start) = trimmed.find('[') {
        let end = trimmed.rfind(']').unwrap_or(trimmed.len() - 1);
        &trimmed[start..=end]
    } else {
        return Vec::new();
    };
    let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return Vec::new();
    };
    arr.iter().filter_map(value_to_patch).collect()
}

fn value_to_patch(v: &serde_json::Value) -> Option<PagePatch> {
    if v.as_object()?.keys().any(|k| {
        !matches!(
            k.as_str(),
            "action"
                | "slug"
                | "title"
                | "summary"
                | "article"
                | "article_patches"
                | "history_entry"
                | "aliases"
                | "tags"
                | "entities"
                | "related"
                | "citations"
                | "sources"
                | "add_citations"
                | "add_sources"
                | "allow_shrink"
                | "type"
                | "entity_type"
        )
    }) {
        // Soft: ignore unknown keys rather than reject whole patch.
    }
    let slug_raw = v.get("slug")?.as_str()?.trim();
    let slug = normalize_slug(slug_raw);
    if slug.is_empty() {
        return None;
    }
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())?
        .to_string();
    let action = match v.get("action").and_then(|a| a.as_str()).unwrap_or("upsert") {
        "create" => WikiAction::Create,
        "update" | "upsert" => WikiAction::Update,
        other if other.eq_ignore_ascii_case("create") => WikiAction::Create,
        _ => WikiAction::Update,
    };
    let article_patches: Vec<ArticlePatch> = v
        .get("article_patches")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let heading = p.get("heading")?.as_str()?.trim().to_string();
                    if heading.is_empty() {
                        return None;
                    }
                    let mode = match p.get("mode").and_then(|m| m.as_str()).unwrap_or("replace") {
                        "append" => PatchMode::Append,
                        _ => PatchMode::Replace,
                    };
                    Some(ArticlePatch {
                        heading,
                        body: p.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
                        mode,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let has_body = v.get("summary").and_then(|t| t.as_str()).is_some_and(|s| !s.trim().is_empty())
        || v.get("article").and_then(|t| t.as_str()).is_some_and(|s| !s.trim().is_empty())
        || !article_patches.is_empty();
    if !has_body {
        return None;
    }
    Some(PagePatch {
        action,
        slug,
        title,
        summary: v.get("summary").and_then(|t| t.as_str()).map(str::to_string),
        article: v.get("article").and_then(|t| t.as_str()).map(str::to_string),
        article_patches,
        history_entry: v.get("history_entry").and_then(|t| t.as_str()).map(str::to_string),
        aliases: string_list(v, "aliases"),
        tags: string_list(v, "tags"),
        entities: string_list(v, "entities"),
        related: string_list(v, "related"),
        citations: citation_list(v, "citations")
            .into_iter()
            .chain(citation_list(v, "add_citations"))
            .collect(),
        sources: source_list(v, "sources")
            .into_iter()
            .chain(source_list(v, "add_sources"))
            .collect(),
        entity_type: v
            .get("type")
            .or_else(|| v.get("entity_type"))
            .and_then(|t| t.as_str())
            .map(str::to_string),
        allow_shrink: v.get("allow_shrink").and_then(serde_json::Value::as_bool).unwrap_or(false),
    })
}

fn citation_list(v: &serde_json::Value, key: &str) -> Vec<PageCitation> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let id = c
                        .get("id")
                        .or_else(|| c.get("summary_id"))
                        .or_else(|| c.get("event_id"))
                        .and_then(|x| x.as_str())?
                        .trim()
                        .to_string();
                    if id.is_empty() {
                        return None;
                    }
                    Some(PageCitation {
                        id,
                        kind: c
                            .get("kind")
                            .and_then(|k| k.as_str())
                            .unwrap_or("summary")
                            .to_string(),
                        date: c.get("date").and_then(|d| d.as_str()).map(str::to_string),
                        note: c.get("note").and_then(|n| n.as_str()).map(str::to_string),
                    })
                })
                .take(CITATIONS_CAP)
                .collect()
        })
        .unwrap_or_default()
}

fn source_list(v: &serde_json::Value, key: &str) -> Vec<PageSource> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let id = s.get("id").and_then(|x| x.as_str())?.trim().to_string();
                    if id.is_empty() {
                        return None;
                    }
                    Some(PageSource {
                        id: id.clone(),
                        label: s.get("label").and_then(|l| l.as_str()).unwrap_or(&id).to_string(),
                    })
                })
                .take(SOURCES_CAP)
                .collect()
        })
        .unwrap_or_default()
}

fn string_list(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).take(32).collect())
        .unwrap_or_default()
}

/// Coalesce helper: pack additional summary bodies under a char budget.
#[must_use]
pub fn coalesce_summary_bodies<'a>(
    lead: &str,
    others: impl IntoIterator<Item = &'a str>,
) -> String {
    let mut out = lead.to_string();
    for (n, body) in others.into_iter().enumerate() {
        if n >= COALESCE_MORE {
            break;
        }
        if out.len() + body.len() + 8 > COALESCE_CHARS {
            break;
        }
        out.push_str("\n\n---\n\n");
        out.push_str(body);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_splits_overflow() {
        let text = format!("{}\n\n{}", "a".repeat(100), "b".repeat(100));
        let (kept, overflow) = fit(&text, 120);
        assert!(kept.len() <= 120);
        assert_ne!(overflow, "");
    }

    #[test]
    fn rebase_keeps_ours_when_base_matches_current() {
        let base = "### A\n\none\n\n### B\n\ntwo";
        let ours = "### A\n\none-prime\n\n### C\n\nthree";
        assert_eq!(rebase(base, ours, base), ours);
    }

    #[test]
    fn entity_rel_path_typed() {
        assert_eq!(entity_rel_path("alice", None), "entities/alice.md");
        assert_eq!(entity_rel_path("alice", Some("person")), "entities/person/alice.md");
    }

    #[test]
    fn summary_gets_currently() {
        assert!(normalize_summary("oauth uses PKCE.").starts_with("Currently,"));
    }

    #[test]
    fn section_budget_archives_overflow() {
        let mut page = WikiPage {
            title: "Auth".into(),
            slug: "auth".into(),
            summary: "Currently, OAuth uses PKCE.".into(),
            article: format!("### Details\n\n{}", "x".repeat(SECTION_BUDGET + 200)),
            ..WikiPage::default()
        };
        let archived = bound_page(&mut page);
        assert!(!archived.is_empty());
        assert!(page.article.len() <= ARTICLE_BUDGET);
        for (heading, body) in split_sections(&page.article) {
            let _ = heading;
            assert!(body.len() <= SECTION_BUDGET);
        }
    }

    #[test]
    fn apply_section_replace_and_append() {
        let mut page = WikiPage {
            title: "Auth".into(),
            slug: "auth".into(),
            article: "### Setup\n\nOld setup.\n\n### Other\n\nKeep me.".into(),
            ..WikiPage::default()
        };
        page = apply_patch(
            Some(page),
            &PagePatch {
                action: WikiAction::Update,
                slug: "auth".into(),
                title: "Auth".into(),
                summary: None,
                article: None,
                article_patches: vec![
                    ArticlePatch {
                        heading: "Setup".into(),
                        body: "New setup.".into(),
                        mode: PatchMode::Replace,
                    },
                    ArticlePatch {
                        heading: "Setup".into(),
                        body: "Extra note.".into(),
                        mode: PatchMode::Append,
                    },
                ],
                history_entry: Some("Updated setup".into()),
                aliases: Vec::new(),
                tags: Vec::new(),
                entities: Vec::new(),
                related: Vec::new(),
                citations: Vec::new(),
                sources: Vec::new(),
                entity_type: None,
                allow_shrink: true,
            },
        );
        assert!(page.article.contains("New setup."));
        assert!(page.article.contains("Extra note."));
        assert!(page.article.contains("Keep me."));
        assert_ne!(page.history.len(), 0);
    }

    #[test]
    fn knowledge_roundtrip_marker() {
        let page = WikiPage {
            title: "Proxy".into(),
            slug: "proxy".into(),
            summary: "Currently, capture is proxy-only.".into(),
            article: "### Notes\n\nWire headers matter.".into(),
            citations: vec![PageCitation {
                id: "sum-1".into(),
                kind: "summary".into(),
                date: Some("2026-01-01".into()),
                note: Some("root".into()),
            }],
            sources: vec![PageSource { id: "sum-1".into(), label: "Root summary".into() }],
            ..WikiPage::default()
        };
        let rendered = render_wiki_page(&page);
        assert!(is_knowledge_page(&rendered));
        let parsed = parse_wiki_page("proxy", &rendered);
        assert_eq!(parsed.title, "Proxy");
        assert!(parsed.summary.starts_with("Currently,"));
        assert!(parsed.article.contains("Wire headers"));
        assert_eq!(parsed.citations.len(), 1);
        assert_eq!(parsed.sources.len(), 1);
    }

    #[test]
    fn identity_clusters_noise() {
        let (a, _) = topic_identity("rivet-oauth-pkce", "OAuth PKCE");
        let (b, _) = topic_identity("oauth-pkce", "OAuth PKCE");
        assert_eq!(a, b);
    }

    #[test]
    fn consolidation_folds_identity_twins() {
        let topics = vec![
            WikiTopicStats {
                slug: "oauth-pkce".into(),
                title: "OAuth PKCE".into(),
                citations: 3,
                history: 2,
                bound: true,
            },
            WikiTopicStats {
                slug: "rivet-oauth-pkce".into(),
                title: "OAuth PKCE".into(),
                citations: 1,
                history: 1,
                bound: false,
            },
        ];
        let plan = consolidation_plan(&topics, 2, 10);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].parent, "oauth-pkce");
        assert_eq!(plan[0].children, vec!["rivet-oauth-pkce".to_string()]);
    }

    #[test]
    fn rejects_patch_without_title_or_body() {
        let raw = r#"[{"action":"update","slug":"x"}]"#;
        assert!(parse_wiki_patches(raw).is_empty());
        let raw =
            r#"[{"action":"update","slug":"auth","title":"Auth","summary":"Currently, ok."}]"#;
        assert_eq!(parse_wiki_patches(raw).len(), 1);
    }

    #[test]
    fn parses_topics_wrapper() {
        let raw = r#"{"topics":[{"action":"update","slug":"auth","title":"Auth","summary":"Currently, ok."}]}"#;
        assert_eq!(parse_wiki_patches(raw).len(), 1);
    }
}
