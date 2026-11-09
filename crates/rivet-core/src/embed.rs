//! Local lexical embedding used when no remote embedding model is configured.
//! Deterministic bag-of-hashed-tokens — good enough for MCP `semantic_search`
//! until a real embedding model is pointed at the proxy.

/// Fixed dimensionality for [`lexical_embed`] (and the `ClickHouse` HNSW index).
pub const LEXICAL_EMBED_DIMS: usize = 64;

/// Embedding space id stored in `ClickHouse` `embeddings.space`.
pub const LEXICAL_SPACE: &str = "lexical";

/// Hash tokens into a fixed-size unit vector.
pub fn lexical_embed(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; LEXICAL_EMBED_DIMS];
    for token in tokenize(text) {
        let h = hash64(&token);
        let idx = usize::try_from(h % u64::try_from(LEXICAL_EMBED_DIMS).unwrap_or(64)).unwrap_or(0);
        let sign = if h & 1 == 0 { 1.0 } else { -1.0 };
        v[idx] += sign;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    for x in &mut v {
        *x /= norm;
    }
    v
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn tokenize(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric()).filter(|t| t.len() > 2).map(str::to_ascii_lowercase)
}

fn hash64(s: &str) -> u64 {
    // FNV-1a 64
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_text_scores_higher() {
        let embed_a = lexical_embed("claude code proxy captures tokens");
        let embed_b = lexical_embed("claude proxy captures and tokens");
        let embed_c = lexical_embed("completely unrelated gardening tips");
        assert!(cosine(&embed_a, &embed_b) > cosine(&embed_a, &embed_c));
    }
}
