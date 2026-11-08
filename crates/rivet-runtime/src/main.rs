use anyhow::Result;
use rivet_runtime::Runtime;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let runtime = Runtime::bootstrap()?;
    tracing::info!(
        root = %runtime.paths.as_root(),
        api = %runtime.config.api_base_url(),
        proxy = %runtime.config.proxy_base_url(),
        "starting rivetd"
    );
    runtime.run().await
}
