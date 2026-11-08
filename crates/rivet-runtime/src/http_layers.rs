//! Loopback HTTP layers: rate limiting + optional Prometheus metrics.

use std::sync::Arc;

use axum::http::{header, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use axum_prometheus::PrometheusMetricLayer;
use rivet_core::RivetConfig;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::GovernorLayer;

async fn require_loopback(
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(rivet_core::host_is_loopback);
    if host_ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

/// Apply rate limits and optional `/metrics` to the merged API+ingest TCP router.
pub fn apply_loopback_layers(router: Router, cfg: &RivetConfig) -> Router {
    let mut router = router;

    if cfg.metrics_enabled {
        let (prometheus_layer, metric_handle) = PrometheusMetricLayer::pair();
        let metrics = Router::new()
            .route(
                "/metrics",
                get(move || {
                    let handle = metric_handle.clone();
                    async move { handle.render() }
                }),
            )
            .route_layer(middleware::from_fn(require_loopback));
        router = router.merge(metrics).layer(prometheus_layer);
    }

    if cfg.rate_limit_rps > 0 {
        let per_second = u64::from(cfg.rate_limit_rps.max(1));
        let burst = cfg.rate_limit_burst.max(1);
        let governor_conf = Arc::new(
            GovernorConfigBuilder::default()
                .per_second(per_second)
                .burst_size(burst)
                .finish()
                .expect("governor config"),
        );
        // All local clients share 127.0.0.1 — one global bucket is intentional.
        router = router.layer(GovernorLayer::new(governor_conf));
    }

    router
}
