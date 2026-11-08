//! Loopback control-API client (session key + JSON helpers).

use anyhow::{anyhow, bail, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::Client;
use serde_json::Value;

#[derive(Clone)]
pub struct ApiClient {
    http: Client,
    base: String,
    key: Option<String>,
}

impl ApiClient {
    pub fn new(base: impl Into<String>) -> Result<Self> {
        let base = base.into().trim_end_matches('/').to_string();
        let http = Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .context("build HTTP client")?;
        Ok(Self {
            http,
            base,
            key: None,
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub async fn ensure_session(&mut self) -> Result<&str> {
        if self.key.is_some() {
            return Ok(self.key.as_deref().unwrap());
        }
        let url = format!("{}/v1/session", self.base);
        let res = self
            .http
            .get(&url)
            .header("Host", host_header(&self.base))
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            bail!("session bootstrap failed ({status}): {body}");
        }
        let v: Value = res.json().await.context("decode /v1/session")?;
        let key = v
            .get("api_key")
            .and_then(|x| x.as_str())
            .ok_or_else(|| anyhow!("session response missing api_key"))?
            .to_string();
        self.key = Some(key);
        Ok(self.key.as_deref().unwrap())
    }

    pub async fn get_value(&mut self, path: &str) -> Result<Value> {
        self.request("GET", path, None).await
    }

    pub async fn post_value(&mut self, path: &str, body: Option<Value>) -> Result<Value> {
        self.request("POST", path, body).await
    }

    pub async fn status_up(&self) -> bool {
        let url = format!("{}/v1/status", self.base);
        match self
            .http
            .get(&url)
            .header("Host", host_header(&self.base))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(res) => res.status().is_success(),
            Err(_) => false,
        }
    }

    async fn request(&mut self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let needs_key = path != "/v1/status" && path != "/v1/session";
        if needs_key {
            self.ensure_session().await?;
        }
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        };

        let mut headers = HeaderMap::new();
        headers.insert("Host", HeaderValue::from_str(&host_header(&self.base))?);
        if needs_key {
            if let Some(key) = &self.key {
                headers.insert("X-Rivet-Key", HeaderValue::from_str(key)?);
            }
        }
        if body.is_some() {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }

        let mut builder = match method {
            "GET" => self.http.get(&url),
            "POST" => self.http.post(&url),
            "PUT" => self.http.put(&url),
            "DELETE" => self.http.delete(&url),
            other => bail!("unsupported method {other}"),
        };
        builder = builder.headers(headers);
        if let Some(b) = body {
            builder = builder.json(&b);
        }

        let res = builder
            .send()
            .await
            .with_context(|| format!("{method} {url}"))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("{method} {path} failed ({status}): {text}");
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("decode response for {path}"))
    }
}

fn host_header(base: &str) -> String {
    let trimmed = base
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    trimmed
        .split('/')
        .next()
        .unwrap_or("127.0.0.1:8741")
        .to_string()
}

pub fn default_api_base() -> String {
    // Prefer live config.json when present so migrated ports still work.
    // Read-only: do not create a data dir just by running the CLI.
    if let Ok(paths) = rivet_core::RivetPaths::discover() {
        let file = paths.config_file();
        if file.as_std_path().is_file() {
            if let Ok(raw) = std::fs::read_to_string(file.as_std_path()) {
                if let Ok(cfg) = serde_json::from_str::<rivet_core::RivetConfig>(&raw) {
                    return cfg.api_base_url();
                }
            }
        }
    }
    "http://127.0.0.1:8741".into()
}
