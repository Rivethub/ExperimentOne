//! Paragraph-aware text chunking for embedding windows.

/// Split `text` into chunks near `target` chars, preferring `\n\n`, then `\n`, then `. `.
#[must_use]
pub fn chunk_text(text: &str, target: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let target = target.max(64);
    if text.chars().count() <= target {
        return vec![text.to_string()];
    }

    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let len = rest.chars().count();
        if len <= target {
            out.push(rest.trim().to_string());
            break;
        }
        let soft = (target * 85) / 100;
        let window = take_chars(rest, target);
        let break_at = break_point(&window, soft).unwrap_or(target);
        let (head, rem) = split_at_chars(rest, break_at.max(1));
        let piece = head.trim();
        if piece.is_empty() {
            let (forced, rem2) = split_at_chars(rest, target);
            out.push(forced.to_string());
            rest = rem2.trim_start();
            continue;
        }
        out.push(piece.to_string());
        rest = rem.trim_start();
    }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn break_point(window: &str, soft: usize) -> Option<usize> {
    let soft = soft.min(window.chars().count().saturating_sub(1));
    for sep in ["\n\n", "\n", ". "] {
        if let Some(char_idx) = rfind_sep_chars(window, sep, soft) {
            return Some(char_idx);
        }
    }
    None
}

fn rfind_sep_chars(window: &str, sep: &str, soft: usize) -> Option<usize> {
    let soft_byte = window.char_indices().nth(soft).map_or(0, |(b, _)| b);
    let tail = &window[soft_byte..];
    let rel = tail.rfind(sep)?;
    let end_byte = soft_byte + rel + sep.len();
    Some(window[..end_byte].chars().count())
}

fn split_at_chars(s: &str, n: usize) -> (&str, &str) {
    match s.char_indices().nth(n) {
        Some((byte, _)) => (&s[..byte], &s[byte..]),
        None => (s, ""),
    }
}

/// Heuristic: skip embedding for pure base64 / data-URI blobs.
#[must_use]
pub fn looks_unembeddable(text: &str) -> bool {
    let t = text.trim();
    if t.len() < 80 {
        return false;
    }
    if t.starts_with("data:") && t.contains(";base64,") {
        return true;
    }
    let sample: String = t.chars().take(200).collect();
    let alnum = sample.chars().filter(char::is_ascii_alphanumeric).count();
    let plus_slash = sample.chars().filter(|c| *c == '+' || *c == '/' || *c == '=').count();
    alnum + plus_slash > sample.len().saturating_mul(95) / 100 && !sample.contains(' ')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_one_chunk() {
        assert_eq!(chunk_text("hello", 100), vec!["hello".to_string()]);
    }

    #[test]
    fn splits_on_paragraphs() {
        let text = format!("{}\n\n{}", "a".repeat(40), "b".repeat(40));
        let chunks = chunk_text(&text, 50);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn detects_base64ish() {
        let blob = "A".repeat(120) + &"B".repeat(40);
        assert!(looks_unembeddable(&blob));
        assert!(!looks_unembeddable("Edited /tmp/foo.rs to change the port."));
    }
}
