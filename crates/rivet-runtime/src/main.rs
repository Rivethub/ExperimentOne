use anyhow::Result;
use rivet_runtime::Runtime;

#[tokio::main]
async fn main() -> Result<()> {
    rivet_runtime::telemetry::init()?;

    let runtime = Runtime::bootstrap()?;
    tracing::info!(
        root = %runtime.paths.as_root(),
        api = %runtime.config.api_base_url(),
        proxy = %runtime.config.proxy_base_url(),
        "starting rivetd"
    );
    runtime.run().await
}
