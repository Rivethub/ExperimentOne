//! Logging + optional OpenTelemetry OTLP export.
//!
//! Set `RIVET_OTLP_ENDPOINT` (e.g. `http://127.0.0.1:4317`) to export spans.

use anyhow::Result;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Initialize logging (+ optional OTLP tracing). Call once at process start.
pub fn init() -> Result<()> {
    let filter = EnvFilter::from_default_env().add_directive("info".parse()?);
    let endpoint = std::env::var("RIVET_OTLP_ENDPOINT").ok().filter(|s| !s.trim().is_empty());

    if let Some(endpoint) = endpoint {
        if let Err(err) = install_otlp(&filter, &endpoint) {
            tracing_subscriber::fmt().with_env_filter(filter).try_init().ok();
            tracing::warn!(?err, %endpoint, "OTLP init failed — fmt logging only");
        } else {
            tracing::info!(%endpoint, "OTLP tracing enabled");
        }
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
    Ok(())
}

fn install_otlp(filter: &EnvFilter, endpoint: &str) -> Result<()> {
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_otlp::{SpanExporter, WithExportConfig};
    use opentelemetry_sdk::trace::SdkTracerProvider;

    let exporter = SpanExporter::builder().with_tonic().with_endpoint(endpoint).build()?;
    let provider = SdkTracerProvider::builder().with_batch_exporter(exporter).build();
    let tracer = provider.tracer("rivetd");
    // Retain provider for process lifetime (flush on drop would need shutdown hook).
    std::mem::forget(provider);

    let otlp_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    let fmt_layer = tracing_subscriber::fmt::layer();
    tracing_subscriber::registry()
        .with(filter.clone())
        .with(fmt_layer)
        .with(otlp_layer)
        .try_init()
        .map_err(|e| anyhow::anyhow!("subscriber init: {e}"))?;
    Ok(())
}
