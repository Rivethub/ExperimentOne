//! Strict validation for proxy → rivetd ingest payloads.

use chrono::{Duration, Utc};

use crate::TrafficEvent;

/// Hard caps so a buggy proxy cannot blow up `ClickHouse` / memory.
pub const MAX_INGEST_BATCH: usize = 2_000;
pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TOKENS_FIELD: u32 = 10_000_000;
pub const MAX_FUTURE_SKEW: Duration = Duration::minutes(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestValidationError {
    pub index: Option<usize>,
    pub message: String,
}

impl std::fmt::Display for IngestValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.index {
            Some(i) => write!(f, "events[{i}]: {}", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}

impl std::error::Error for IngestValidationError {}

/// Validate one traffic event before persistence.
pub fn validate_traffic_event(event: &TrafficEvent) -> Result<(), IngestValidationError> {
    if event.provider.as_str().is_empty() {
        return Err(IngestValidationError { index: None, message: "provider is required".into() });
    }
    if event.tokens_in > MAX_TOKENS_FIELD || event.tokens_out > MAX_TOKENS_FIELD {
        return Err(IngestValidationError {
            index: None,
            message: format!("token counts exceed {MAX_TOKENS_FIELD}"),
        });
    }
    if let Some(content) = event.content.as_ref() {
        if content.len() > MAX_CONTENT_BYTES {
            return Err(IngestValidationError {
                index: None,
                message: format!("content exceeds {MAX_CONTENT_BYTES} bytes"),
            });
        }
    }
    let now = Utc::now();
    if event.ts > now + MAX_FUTURE_SKEW {
        return Err(IngestValidationError {
            index: None,
            message: "timestamp too far in the future".into(),
        });
    }
    // Older than ~10y is almost certainly corrupt.
    if event.ts < now - Duration::days(3650) {
        return Err(IngestValidationError {
            index: None,
            message: "timestamp too far in the past".into(),
        });
    }
    Ok(())
}

/// Validate a whole ingest batch (size + per-event rules).
pub fn validate_ingest_batch(events: &[TrafficEvent]) -> Result<(), IngestValidationError> {
    if events.len() > MAX_INGEST_BATCH {
        return Err(IngestValidationError {
            index: None,
            message: format!("batch exceeds {MAX_INGEST_BATCH} events"),
        });
    }
    for (i, event) in events.iter().enumerate() {
        validate_traffic_event(event).map_err(|mut err| {
            err.index = Some(i);
            err
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProviderKind, TrafficEvent};

    #[test]
    fn rejects_oversized_batch() {
        let events: Vec<_> =
            (0..=MAX_INGEST_BATCH).map(|_| TrafficEvent::new(ProviderKind::Claude)).collect();
        assert!(validate_ingest_batch(&events).is_err());
    }

    #[test]
    fn rejects_huge_content() {
        let mut ev = TrafficEvent::new(ProviderKind::Claude);
        ev.content = Some("x".repeat(MAX_CONTENT_BYTES + 1));
        assert!(validate_traffic_event(&ev).is_err());
    }

    #[test]
    fn accepts_normal_event() {
        let ev = TrafficEvent::new(ProviderKind::Claude);
        assert!(validate_traffic_event(&ev).is_ok());
    }
}
