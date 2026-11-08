//! Local lexical embedding used when no remote embedding model is configured.
//! Deterministic bag-of-hashed-tokens — good enough for MCP semantic_search
//! until a real embedding model is pointed at the proxy.

const DIMS: usize = 64;

/// Hash tokens into a fixed-size unit vector.
pub fn lexical_embed(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; DIMS];
    for token in tokenize(text) {
        let h = hash64(&token);
        let idx = (h as usize) % DIMS;
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
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 2)
        .map(|t| t.to_ascii_lowercase())
}

fn hash64(s: &str) -> u64 {
    // FNV-1a 64
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_text_scores_higher() {
        let a = lexical_embed("claude code proxy traffic tokens");
        let b = lexical_embed("claude proxy traffic and tokens");
        let c = lexical_embed("completely unrelated gardening tips");
        assert!(cosine(&a, &b) > cosine(&a, &c));
    }
}
