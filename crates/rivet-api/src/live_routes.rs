//! Live cursor + SSE endpoints for desktop / CLI refresh.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use chrono::Utc;
use futures::stream::{self, Stream, StreamExt};
use rivet_core::{LiveCursor, LiveEvent};

use crate::ApiState;

pub async fn live_cursor(State(state): State<ApiState>) -> Json<LiveCursor> {
    let traffic_events = state.store.usage_totals().await.map_or(0, |u| u.events);
    Json(LiveCursor {
        wiki_revision: state.wiki_revision.load(std::sync::atomic::Ordering::SeqCst),
        traffic_events,
        observed_at: Utc::now().to_rfc3339(),
    })
}

pub async fn live_sse(
    State(state): State<ApiState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let initial = live_cursor(State(state.clone())).await.0;
    let seed = Event::default()
        .event("cursor")
        .data(serde_json::to_string(&initial).unwrap_or_else(|_| "{}".into()));

    let rx = state.live.subscribe();
    let live_stream = stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_else(|_| "{}".into());
                    return Some((
                        Ok::<_, Infallible>(Event::default().event("live").data(data)),
                        rx,
                    ));
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });

    let heartbeat = stream::unfold((), |()| async {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let data = serde_json::to_string(&LiveEvent::Heartbeat).unwrap_or_else(|_| "{}".into());
        Some((Ok::<_, Infallible>(Event::default().event("live").data(data)), ()))
    });

    let stream = StreamExt::chain(
        stream::once(async move { Ok::<_, Infallible>(seed) }),
        stream::select(live_stream, heartbeat),
    );

    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping"))
}
