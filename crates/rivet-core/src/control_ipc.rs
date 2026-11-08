//! Local control-plane transport (Docker Desktop–style).
//!
//! Desktop talks to `rivetd` over a Unix domain socket (macOS/Linux) or a
//! Windows named pipe — never over TCP/HTTP. The wire format is still HTTP/1.1
//! framed messages (same handlers as the loopback API).

use std::fmt::Write as _;
use std::io::{Read, Write};
use std::time::Duration;

use anyhow::{bail, Context, Result};

use crate::paths::RivetPaths;

/// Response from a control IPC call.
#[derive(Debug, Clone)]
pub struct ControlIpcResponse {
    pub status: u16,
    pub body: String,
    pub content_type: String,
}

/// Filesystem path of the Unix control socket.
#[cfg(unix)]
pub fn control_endpoint(paths: &RivetPaths) -> String {
    paths.control_sock().into_string()
}

/// Named-pipe path for the Windows control endpoint (deterministic per data dir).
#[cfg(windows)]
pub fn control_endpoint(paths: &RivetPaths) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    paths.root.as_str().hash(&mut hasher);
    format!(r"\\.\pipe\rivet-control-{:x}", hasher.finish())
}

#[cfg(not(any(unix, windows)))]
pub fn control_endpoint(paths: &RivetPaths) -> String {
    paths.control_sock().into_string()
}

/// True when something is accepting connections on the control endpoint.
pub fn control_up(paths: &RivetPaths) -> bool {
    connect_stream(paths, Duration::from_millis(200)).is_ok()
}

/// HTTP/1.1 request over the local control socket / named pipe.
pub fn control_request(
    paths: &RivetPaths,
    method: &str,
    path: &str,
    access_key: &str,
    body: Option<&str>,
) -> Result<ControlIpcResponse> {
    let path = path.trim();
    if !path.starts_with("/v1/") {
        bail!("path must start with /v1/");
    }
    let method = method.trim().to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" => {},
        other => bail!("unsupported method {other}"),
    }

    let mut stream = connect_stream(paths, Duration::from_secs(2))
        .with_context(|| format!("connect control ipc {}", control_endpoint(paths)))?;

    let body_bytes = body.unwrap_or("").as_bytes();
    let mut req = String::new();
    write!(
        req,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Rivet-Ipc: 1\r\n"
    )
    .context("format control ipc request")?;
    if !access_key.is_empty() {
        writeln!(req, "X-Rivet-Key: {access_key}").context("format control ipc request")?;
    }
    if !body_bytes.is_empty() {
        writeln!(req, "Content-Type: application/json").context("format control ipc request")?;
        writeln!(req, "Content-Length: {}", body_bytes.len())
            .context("format control ipc request")?;
    } else if matches!(method.as_str(), "POST" | "PUT" | "PATCH") {
        writeln!(req, "Content-Length: 0").context("format control ipc request")?;
    }
    req.push_str("\r\n");

    stream.write_all(req.as_bytes()).context("write control ipc headers")?;
    if !body_bytes.is_empty() {
        stream.write_all(body_bytes).context("write control ipc body")?;
    }
    stream.flush().context("flush control ipc")?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).context("read control ipc response")?;
    Ok(parse_http_response(&raw))
}

fn http_header_body(text: &str) -> (&str, &str) {
    if let Some(parts) = text.split_once("\r\n\r\n") {
        return parts;
    }
    if let Some(parts) = text.split_once("\n\n") {
        return parts;
    }
    (text, "")
}

fn parse_http_response(raw: &[u8]) -> ControlIpcResponse {
    let text = String::from_utf8_lossy(raw);
    let (header_blob, body) = http_header_body(&text);
    let mut lines = header_blob.lines();
    let status_line = lines.next().unwrap_or("");
    let status =
        status_line.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
    let mut content_type = String::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-type") {
                content_type = value.trim().to_string();
            }
        }
    }
    ControlIpcResponse { status, body: body.to_string(), content_type }
}

#[cfg(unix)]
type ControlStream = std::os::unix::net::UnixStream;

#[cfg(windows)]
type ControlStream = std::fs::File;

#[cfg(not(any(unix, windows)))]
type ControlStream = std::fs::File;

#[cfg(unix)]
fn connect_stream(paths: &RivetPaths, timeout: Duration) -> std::io::Result<ControlStream> {
    let path = paths.control_sock();
    let start = std::time::Instant::now();
    loop {
        match std::os::unix::net::UnixStream::connect(path.as_std_path()) {
            Ok(stream) => {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                return Ok(stream);
            },
            Err(err) => {
                if start.elapsed() >= timeout {
                    return Err(err);
                }
                std::thread::sleep(Duration::from_millis(25));
            },
        }
    }
}

#[cfg(windows)]
fn connect_stream(paths: &RivetPaths, timeout: Duration) -> std::io::Result<ControlStream> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    // GENERIC_READ | GENERIC_WRITE
    const ACCESS: u32 = 0x8000_0000 | 0x4000_0000;
    let endpoint = control_endpoint(paths);
    let start = std::time::Instant::now();
    loop {
        match OpenOptions::new().read(true).write(true).access_mode(ACCESS).open(&endpoint) {
            Ok(file) => return Ok(file),
            Err(err) => {
                if start.elapsed() >= timeout {
                    return Err(err);
                }
                std::thread::sleep(Duration::from_millis(25));
            },
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn connect_stream(paths: &RivetPaths, _timeout: Duration) -> std::io::Result<ControlStream> {
    let _ = paths;
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "control ipc unsupported on this platform",
    ))
}
