//! Hybrid event ranking: RRF over keyword + vector arms + recency boosts.

use std::collections::HashMap;

use rivet_core::{
    gated_fused, hybrid_pool, literal_scan, reciprocal_rank_fusion, FusionItem, HitSource,
    HYBRID_RRF_K,
};

#[derive(Debug, Clone)]
struct RankHit {
    id: String,
    source: HitSource,
    boost: f64,
}

impl FusionItem for RankHit {
    fn fusion_id(&self) -> &str {
        &self.id
    }
    fn fusion_source(&self) -> HitSource {
        self.source
    }
    fn fusion_boost(&self) -> f64 {
        self.boost
    }
}

/// Optional per-id boost (recency / access / importance).
#[must_use]
pub fn fuse_event_id_arms(
    keyword_ids: &[String],
    vector_ids: &[String],
    summary_ids: &[String],
    limit: u32,
) -> Vec<String> {
    fuse_event_id_arms_boosted(keyword_ids, vector_ids, summary_ids, &HashMap::new(), limit)
}

/// Fuse with per-id boost map (e.g. `recency_boost` values).
#[must_use]
pub fn fuse_event_id_arms_boosted<S: ::std::hash::BuildHasher>(
    keyword_ids: &[String],
    vector_ids: &[String],
    summary_ids: &[String],
    boosts: &HashMap<String, f64, S>,
    limit: u32,
) -> Vec<String> {
    let to_hit = |id: &String| RankHit {
        id: id.clone(),
        source: if summary_ids.iter().any(|s| s == id) {
            HitSource::Summary
        } else {
            HitSource::Message
        },
        boost: boosts.get(id).copied().unwrap_or(0.0),
    };
    let lexical: Vec<RankHit> = keyword_ids.iter().map(to_hit).collect();
    let semantic: Vec<RankHit> = vector_ids.iter().map(to_hit).collect();
    if lexical.is_empty() && semantic.is_empty() {
        return Vec::new();
    }
    let arms: Vec<&[RankHit]> = match (lexical.is_empty(), semantic.is_empty()) {
        (false, false) => vec![&lexical, &semantic],
        (false, true) => vec![&lexical],
        (true, false) => vec![&semantic],
        (true, true) => return Vec::new(),
    };
    let fused = reciprocal_rank_fusion(&arms, HYBRID_RRF_K);
    gated_fused(fused).into_iter().take(limit.max(1) as usize).map(|f| f.item.id.clone()).collect()
}

/// Prefer keyword-only ordering when the query is path-/id-like.
#[must_use]
pub fn prefer_lexical_query(query: &str) -> bool {
    literal_scan(query)
}

#[must_use]
pub fn hybrid_fetch_limit(limit: u32) -> u32 {
    hybrid_pool(limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_id_ranks_above_solo() {
        let kw = vec!["solo".into(), "shared".into()];
        let vec = vec!["shared".into()];
        let out = fuse_event_id_arms(&kw, &vec, &[], 10);
        assert_eq!(out.first().map(String::as_str), Some("shared"));
    }
}
