//! Reciprocal rank fusion for hybrid memory search (RivetHub-style RRF).

use std::collections::BTreeMap;

pub const HYBRID_RRF_K: f64 = 20.0;
const SUMMARY_FUSION_BONUS: f64 = 1.3;
const GATE_FRACTION: f64 = 0.5;
const HYBRID_POOL_MIN: u32 = 50;
const HYBRID_POOL_MAX: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitSource {
    Message,
    Summary,
}

pub trait FusionItem {
    fn fusion_id(&self) -> &str;
    fn fusion_source(&self) -> HitSource;
    fn fusion_boost(&self) -> f64;
}

#[derive(Debug, Clone, Copy)]
pub struct Fused<'a, T> {
    pub item: &'a T,
    pub rrf: f64,
    pub arm_count: u32,
}

#[must_use]
pub fn hybrid_pool(limit: u32) -> u32 {
    limit.saturating_mul(3).clamp(HYBRID_POOL_MIN, HYBRID_POOL_MAX)
}

#[must_use]
pub fn reciprocal_rank_fusion<'a, T: FusionItem>(arms: &[&'a [T]], k: f64) -> Vec<Fused<'a, T>> {
    let mut index: BTreeMap<&'a str, usize> = BTreeMap::new();
    let mut fused: Vec<Fused<'a, T>> = Vec::new();
    for arm in arms {
        for (rank, item) in (0u32..).zip(arm.iter()) {
            let contribution = 1.0 / (k + f64::from(rank) + 1.0);
            if let Some(slot) = index.get(item.fusion_id()).and_then(|&at| fused.get_mut(at)) {
                slot.rrf += contribution;
                slot.arm_count = slot.arm_count.saturating_add(1);
            } else {
                index.insert(item.fusion_id(), fused.len());
                fused.push(Fused { item, rrf: contribution, arm_count: 1 });
            }
        }
    }
    fused
}

#[must_use]
pub fn fusion_score<T: FusionItem>(rrf: f64, item: &T) -> f64 {
    let bonus = if item.fusion_source() == HitSource::Summary {
        SUMMARY_FUSION_BONUS
    } else {
        1.0
    };
    rrf * (1.0 + item.fusion_boost()) * bonus
}

#[must_use]
pub fn passes_fusion_gate(arm_count: u32, score: f64, top: f64) -> bool {
    arm_count >= 2 || score >= top * GATE_FRACTION
}

/// Rank fused hits: score descending, then `arm_count`, then id.
#[must_use]
pub fn rank_fused<T: FusionItem>(mut fused: Vec<Fused<'_, T>>) -> Vec<Fused<'_, T>> {
    fused.sort_by(|a, b| {
        let sa = fusion_score(a.rrf, a.item);
        let sb = fusion_score(b.rrf, b.item);
        sb.partial_cmp(&sa)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.arm_count.cmp(&a.arm_count))
            .then(a.item.fusion_id().cmp(b.item.fusion_id()))
    });
    fused
}

/// Keep rows that pass the fusion gate relative to the top score.
#[must_use]
pub fn gated_fused<T: FusionItem>(fused: Vec<Fused<'_, T>>) -> Vec<Fused<'_, T>> {
    let ranked = rank_fused(fused);
    let top = ranked.first().map_or(0.0, |f| fusion_score(f.rrf, f.item));
    ranked
        .into_iter()
        .filter(|f| passes_fusion_gate(f.arm_count, fusion_score(f.rrf, f.item), top))
        .collect()
}

/// True when the query looks path-/id-like (prefer lexical arm).
#[must_use]
pub fn literal_scan(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Pull-request / issue shorthand: `PR #4821`, `#4821`, `PR#4821`.
    if trimmed.contains('#')
        && trimmed.chars().any(|c| c.is_ascii_digit())
        && (trimmed.to_ascii_lowercase().contains("pr")
            || trimmed.split_whitespace().any(|t| t.starts_with('#')))
    {
        return true;
    }
    text.split_whitespace().any(|tok| {
        tok.contains('/')
            || tok.contains('.')
            || tok.contains(':')
            || tok.contains('_')
            || tok.contains('@')
            || tok.starts_with('#')
            || (tok.chars().any(|c| c.is_ascii_digit())
                && tok.chars().any(|c| c.is_ascii_alphabetic()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Hit {
        id: &'static str,
        source: HitSource,
        boost: f64,
    }

    impl FusionItem for Hit {
        fn fusion_id(&self) -> &str {
            self.id
        }
        fn fusion_source(&self) -> HitSource {
            self.source
        }
        fn fusion_boost(&self) -> f64 {
            self.boost
        }
    }

    const fn message(id: &'static str) -> Hit {
        Hit { id, source: HitSource::Message, boost: 0.0 }
    }

    #[test]
    fn agreement_beats_solo_first() {
        let lexical = [message("solo"), message("shared")];
        let semantic = [message("shared")];
        let fused = reciprocal_rank_fusion(&[&lexical, &semantic], HYBRID_RRF_K);
        let shared = fused.iter().find(|f| f.item.id == "shared").expect("shared");
        let solo = fused.iter().find(|f| f.item.id == "solo").expect("solo");
        assert!(shared.rrf > solo.rrf);
        assert_eq!(shared.arm_count, 2);
    }

    #[test]
    fn gate_keeps_two_arm_hits() {
        assert!(passes_fusion_gate(2, 0.0, 1.0));
        assert!(!passes_fusion_gate(1, 0.1, 1.0));
        assert!(passes_fusion_gate(1, 0.5, 1.0));
    }

    #[test]
    fn pool_clamps() {
        assert_eq!(hybrid_pool(1), 50);
        assert_eq!(hybrid_pool(40), 100);
    }
}
