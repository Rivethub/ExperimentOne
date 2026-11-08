//! Temporal / importance scoring for hybrid memory hits (RivetHub-style).

const DECAY_TAU_DAYS: f64 = 30.0;
const REINFORCEMENT_ALPHA: f64 = 0.01;
const REINFORCEMENT_CAP: u32 = 25;
const W_FTS: f64 = 0.3;
const W_SEMANTIC: f64 = 0.3;
const W_TEMPORAL: f64 = 0.3;
const W_IMPORTANCE: f64 = 0.1;

#[must_use]
pub fn temporal_decay(age_days: f64, access_count: u32) -> f64 {
    let reinforced = f64::from(access_count.min(REINFORCEMENT_CAP));
    let decayed = ((age_days.max(0.0) / DECAY_TAU_DAYS).ln_1p() + 1.0).recip();
    decayed * REINFORCEMENT_ALPHA.mul_add(reinforced, 1.0)
}

#[must_use]
pub fn recency_boost(age_days: f64, access_count: u32, importance: f64) -> f64 {
    temporal_decay(age_days, access_count).mul_add(W_TEMPORAL, importance * W_IMPORTANCE)
}

#[must_use]
pub const fn composite_score(arm_score: f64, semantic: f64, boost: f64) -> f64 {
    arm_score.mul_add(W_FTS, semantic.mul_add(W_SEMANTIC, boost))
}

/// Age in days from an RFC3339 / chrono timestamp relative to now.
#[must_use]
pub fn age_days_since(ts: chrono::DateTime<chrono::Utc>) -> f64 {
    let secs = (chrono::Utc::now() - ts).num_seconds().max(0);
    #[allow(clippy::cast_precision_loss)]
    let secs_f = secs as f64;
    secs_f / 86_400.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_unread_is_full_weight() {
        assert!((temporal_decay(0.0, 0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn access_caps_at_25() {
        assert!((temporal_decay(0.0, 25) - 1.25).abs() < 1e-12);
        assert!((temporal_decay(0.0, 100) - 1.25).abs() < 1e-12);
    }
}
