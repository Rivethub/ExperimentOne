//! Serve the control API on a local IPC endpoint (UDS / named pipe).

use anyhow::{Context, Result};
use axum::Router;
use rivet_core::RivetPaths;
use tracing::info;

/// Bind and serve `app` on the Desktop control IPC endpoint.
pub async fn serve_control(paths: RivetPaths, app: Router) -> Result<()> {
    #[cfg(unix)]
    {
        serve_unix(paths, app).await
    }
    #[cfg(windows)]
    {
        serve_windows(paths, app).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (paths, app);
        anyhow::bail!("control ipc unsupported on this platform")
    }
}

#[cfg(unix)]
async fn serve_unix(paths: RivetPaths, app: Router) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let sock = paths.control_sock();
    if let Some(parent) = sock.parent() {
        tokio::fs::create_dir_all(parent.as_std_path())
            .await
            .with_context(|| format!("create control sock dir {parent}"))?;
    }
    let _ = tokio::fs::remove_file(sock.as_std_path()).await;
    let listener = UnixListener::bind(sock.as_std_path())
        .with_context(|| format!("bind control sock {sock}"))?;
    let perms = std::fs::Permissions::from_mode(0o600);
    let _ = tokio::fs::set_permissions(sock.as_std_path(), perms).await;
    info!(endpoint = %sock, "rivet control ipc listening (unix socket)");
    axum::serve(listener, app)
        .await
        .context("control ipc serve")?;
    Ok(())
}

#[cfg(windows)]
async fn serve_windows(paths: RivetPaths, app: Router) -> Result<()> {
    use hyper_util::rt::TokioIo;
    use hyper_util::service::TowerToHyperService;
    use rivet_core::control_endpoint;
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = control_endpoint(&paths);
    info!(endpoint = %pipe_name, "rivet control ipc listening (named pipe)");

    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .with_context(|| format!("create control pipe {pipe_name}"))?;

    loop {
        server.connect().await.context("control pipe connect")?;
        let connected = server;
        server = ServerOptions::new()
            .create(&pipe_name)
            .context("create next control pipe instance")?;

        let svc = TowerToHyperService::new(app.clone());
        tokio::spawn(async move {
            let io = TokioIo::new(connected);
            if let Err(err) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, svc)
                .await
            {
                tracing::warn!(?err, "control ipc connection error");
            }
        });
    }
}
