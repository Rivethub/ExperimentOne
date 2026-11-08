//! Offline hybrid fusion eval — no ClickHouse required.
//!
//! Corpus arms simulate keyword/vector hit lists a live CH search would return.
//! Harder cases cover path / `PR #` lexical preference, summary lineage, and
//! recency/access boosts.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use rivet_store::{fuse_event_id_arms, fuse_event_id_arms_boosted, prefer_lexical_query};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Corpus {
    queries: Vec<Query>,
    #[serde(default)]
    docs: HashMap<String, String>,
    keyword_arms: std::collections::BTreeMap<String, Vec<String>>,
    vector_arms: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default)]
    summary_ids: Vec<String>,
    #[serde(default)]
    boosts: HashMap<String, f64>,
}

#[derive(Debug, Deserialize)]
struct Query {
    id: String,
    q: String,
    expect_any: Vec<String>,
    #[serde(default)]
    mode: Option<String>,
}

#[test]
fn search_eval_matches_baseline() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/search_eval");
    let corpus: Corpus =
        serde_json::from_str(&fs::read_to_string(root.join("corpus.json")).unwrap()).unwrap();
    let baseline: std::collections::BTreeMap<String, Vec<String>> =
        serde_json::from_str(&fs::read_to_string(root.join("baseline.json")).unwrap()).unwrap();

    for query in &corpus.queries {
        // Live-ish content check: expected docs must mention a query token (or path/PR).
        for id in &query.expect_any {
            if let Some(doc) = corpus.docs.get(id) {
                let q_l = query.q.to_ascii_lowercase();
                let d_l = doc.to_ascii_lowercase();
                let token_hit = q_l.split_whitespace().any(|t| {
                    let bare = t.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '#' && c != '/');
                    !bare.is_empty() && d_l.contains(bare)
                });
                assert!(
                    token_hit || d_l.contains(&q_l),
                    "doc {id} should contain a token from {:?}",
                    query.q
                );
            }
        }

        let kw = corpus.keyword_arms.get(&query.id).cloned().unwrap_or_default();
        let vec = corpus.vector_arms.get(&query.id).cloned().unwrap_or_default();
        let mode = query.mode.as_deref().unwrap_or("hybrid");
        let fused = match mode {
            "lexical" => {
                assert!(
                    prefer_lexical_query(&query.q),
                    "query {} should prefer lexical",
                    query.id
                );
                kw.clone()
            },
            "boosted" => fuse_event_id_arms_boosted(
                &kw,
                &vec,
                &corpus.summary_ids,
                &corpus.boosts,
                5,
            ),
            _ if prefer_lexical_query(&query.q) && !kw.is_empty() => kw.clone(),
            _ => fuse_event_id_arms(&kw, &vec, &corpus.summary_ids, 5),
        };

        let expect: HashSet<_> = baseline
            .get(&query.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let got: HashSet<_> = fused.into_iter().take(3).collect();
        assert!(
            expect.iter().any(|id| got.contains(id)),
            "query {} ({}) expected one of {:?} in top-3 {:?}; also expect_any={:?}",
            query.id,
            query.q,
            expect,
            got,
            query.expect_any
        );
    }
}

#[test]
fn pr_and_path_prefer_lexical() {
    assert!(prefer_lexical_query("crates/rivet-store/src/hybrid.rs"));
    assert!(prefer_lexical_query("PR #4821"));
    assert!(prefer_lexical_query("#4821 soft-wire"));
    assert!(!prefer_lexical_query("how does compaction work"));
}
