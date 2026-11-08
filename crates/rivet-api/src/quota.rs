//! Pull credential + quota signals from the local CLIProxyAPI management API.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use rivet_core::RivetConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct QuotaSnapshot {
    pub source: &'static str,
    pub observed_at: String,
    pub credentials_total: u64,
    pub credentials_loaded: u64,
    pub providers: Vec<ProviderQuota>,
    pub accounts: Vec<QuotaAccount>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderQuota {
    pub provider: String,
    pub account_count: u64,
    /// Sum of remaining % across accounts (e.g. 555 ≈ 5.55 accounts-worth left).
    pub remaining_pct: f64,
    /// Capacity = account_count × 100.
    pub capacity_pct: f64,
    pub pool_empty: String,
    pub first_empty: String,
    pub next_reset: String,
    pub burn_last_horizon: String,
    pub burn_pct_per_hour: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaAccount {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub email: Option<String>,
    pub remaining_pct: Option<f64>,
    pub reset_at: Option<String>,
    pub cooldown_seconds: Option<i64>,
    pub supports_quota: bool,
    pub loaded: bool,
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct CredList {
    #[serde(default)]
    files: Vec<CredFile>,
    #[serde(default)]
    total: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CredFile {
    #[serde(default)]
    auth_index: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(rename = "type")]
    #[serde(default)]
    type_: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    unavailable: Option<bool>,
    #[serde(default)]
    disabled: Option<bool>,
    #[serde(default)]
    supports_quota: Option<bool>,
    #[serde(default)]
    quota: Option<QuotaObservation>,
    #[serde(default)]
    cooldowns: Option<Vec<CooldownItem>>,
    #[serde(default)]
    next_retry_after: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QuotaObservation {
    #[serde(default)]
    signals: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct CooldownItem {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    retry_at: Option<String>,
    #[serde(default)]
    remaining_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct QuotaFetchResponse {
    #[serde(default)]
    groups: Vec<QuotaGroup>,
}

#[derive(Debug, Deserialize)]
struct QuotaGroup {
    #[serde(default)]
    buckets: Vec<QuotaBucket>,
}

#[derive(Debug, Deserialize)]
struct QuotaBucket {
    #[serde(default)]
    #[serde(alias = "remaining_fraction")]
    remaining_fraction: Option<f64>,
    #[serde(default, rename = "remainingFraction")]
    remaining_fraction_camel: Option<f64>,
    #[serde(default)]
    #[serde(alias = "reset_time")]
    reset_time: Option<String>,
    #[serde(default, rename = "resetTime")]
    reset_time_camel: Option<String>,
}

impl QuotaBucket {
    fn remaining(&self) -> Option<f64> {
        self.remaining_fraction
            .or(self.remaining_fraction_camel)
            .map(|f| f * 100.0)
    }

    fn reset(&self) -> Option<String> {
        self.reset_time
            .clone()
            .or_else(|| self.reset_time_camel.clone())
    }
}

fn management_key(cfg: &RivetConfig) -> &str {
    if cfg.management_secret.trim().is_empty() {
        &cfg.proxy_access_key
    } else {
        &cfg.management_secret
    }
}

fn http_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .connect_timeout(Duration::from_secs(1))
        .build()?)
}

fn auth_headers(req: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {key}"))
        .header("X-Management-Key", key)
}

/// List credentials and fold them into a Rivet quota snapshot.
pub async fn fetch_quota_snapshot(
    cfg: &RivetConfig,
    burn_by_provider: &HashMap<String, f64>,
) -> Result<QuotaSnapshot> {
    let http = http_client()?;
    let key = management_key(cfg);
    let base = cfg.proxy_base_url();

    let list = match list_credentials(&http, &base, key).await {
        Ok(list) => list,
        Err(err) => {
            tracing::warn!(error = %err, "management credential list failed");
            return Err(err);
        }
    };
    build_snapshot(cfg, &http, key, list, burn_by_provider).await
}

async fn list_credentials(
    http: &reqwest::Client,
    base: &str,
    key: &str,
) -> Result<CredList> {
    let v8 = format!("{base}/v8/management/credentials");
    let res = auth_headers(http.get(&v8), key)
        .send()
        .await
        .context("list credentials")?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        let v0 = format!("{base}/v0/management/auth-files");
        let res = auth_headers(http.get(&v0), key)
            .send()
            .await
            .context("list auth-files")?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!("management list HTTP {status}: {body}");
        }
        return res.json().await.context("auth-files json");
    }
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("management credentials HTTP {status}: {body}");
    }
    res.json().await.context("credentials json")
}

/// Force-refresh all credentials via the management API.
pub async fn refresh_credentials(cfg: &RivetConfig) -> Result<serde_json::Value> {
    let http = http_client()?;
    let key = management_key(cfg);
    let base = cfg.proxy_base_url();
    let url = format!("{base}/v8/management/credentials/refresh");
    let res = auth_headers(http.post(&url), key)
        .json(&serde_json::json!({ "all": true }))
        .send()
        .await
        .context("refresh credentials")?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        let url = format!("{base}/v0/management/auth-files/refresh?all=true");
        let res = auth_headers(http.post(&url), key)
            .send()
            .await
            .context("refresh auth-files")?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!("refresh HTTP {status}: {body}");
        }
        return res.json().await.context("refresh json");
    }
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("refresh HTTP {status}: {body}");
    }
    res.json().await.context("refresh json")
}

async fn build_snapshot(
    cfg: &RivetConfig,
    http: &reqwest::Client,
    key: &str,
    list: CredList,
    burn_by_provider: &HashMap<String, f64>,
) -> Result<QuotaSnapshot> {
    let mut accounts = Vec::new();
    for file in &list.files {
        let id = file
            .auth_index
            .clone()
            .or_else(|| file.name.clone())
            .or_else(|| file.id.clone())
            .unwrap_or_else(|| "unknown".into());
        let provider = normalize_provider(
            file.provider
                .as_deref()
                .or(file.type_.as_deref())
                .unwrap_or("unknown"),
        );
        let email = file.email.clone();
        let label = file
            .label
            .clone()
            .or_else(|| email.clone())
            .unwrap_or_else(|| id.clone());

        let mut remaining_pct = remaining_from_signals(file.quota.as_ref());
        let mut reset_at = reset_from_signals(file.quota.as_ref())
            .or_else(|| cooldown_reset(file.cooldowns.as_ref()))
            .or_else(|| file.next_retry_after.clone());
        let cooldown_seconds = file
            .cooldowns
            .as_ref()
            .and_then(|c| c.iter().filter_map(|x| x.remaining_seconds).max());

        let supports = file.supports_quota.unwrap_or(false);
        if supports && remaining_pct.is_none() {
            if let Ok(fetched) = fetch_live_quota(http, &cfg.proxy_base_url(), key, &id).await {
                if let Some(bucket) = fetched
                    .groups
                    .iter()
                    .flat_map(|g| g.buckets.iter())
                    .find(|b| b.remaining().is_some())
                {
                    remaining_pct = bucket.remaining();
                    if reset_at.is_none() {
                        reset_at = bucket.reset();
                    }
                }
            }
        }

        let loaded = !file.disabled.unwrap_or(false) && !file.unavailable.unwrap_or(false);
        accounts.push(QuotaAccount {
            id,
            provider,
            label,
            email,
            remaining_pct,
            reset_at,
            cooldown_seconds,
            supports_quota: supports || remaining_pct.is_some(),
            loaded,
            status: file.status.clone().unwrap_or_else(|| {
                if loaded {
                    "loaded".into()
                } else {
                    "unavailable".into()
                }
            }),
        });
    }

    let mut by_provider: HashMap<String, Vec<&QuotaAccount>> = HashMap::new();
    for a in &accounts {
        by_provider.entry(a.provider.clone()).or_default().push(a);
    }

    let mut providers = Vec::new();
    for (provider, list) in by_provider {
        let account_count = list.len() as u64;
        let capacity_pct = (account_count as f64) * 100.0;
        let known: Vec<f64> = list.iter().filter_map(|a| a.remaining_pct).collect();
        // Unknown accounts treated as full so pool capacity stays stable until signals arrive.
        let remaining_pct = if known.is_empty() {
            list.iter().filter(|a| a.loaded).count() as f64 * 100.0
        } else {
            let missing = account_count as usize - known.len();
            known.iter().sum::<f64>() + missing as f64 * 100.0
        };

        let burn_tok_h = burn_by_provider.get(&provider).copied().unwrap_or(0.0);
        let assumed_pool_tokens = (capacity_pct / 100.0) * 80_000.0;
        let burn_pct_per_hour = if assumed_pool_tokens > 0.0 {
            (burn_tok_h / assumed_pool_tokens) * 100.0
        } else {
            0.0
        };

        let pool_empty = if burn_pct_per_hour > 0.01 && remaining_pct > 0.0 {
            format_horizon(remaining_pct / burn_pct_per_hour)
        } else if remaining_pct <= 0.0 {
            "Empty".into()
        } else if known.is_empty() {
            "— pending live quota".into()
        } else {
            "Steady".into()
        };

        let first_empty = list
            .iter()
            .filter_map(|a| {
                let rem = a.remaining_pct?;
                if burn_pct_per_hour <= 0.01 || account_count == 0 {
                    return None;
                }
                let per = burn_pct_per_hour / account_count as f64;
                if per <= 0.0 {
                    return None;
                }
                Some((rem / per, a.label.clone()))
            })
            .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(h, label)| format!("{label} · {}", format_horizon(h)))
            .unwrap_or_else(|| "—".into());

        let next_reset = list
            .iter()
            .filter_map(|a| a.reset_at.as_ref().map(|r| (r, a.remaining_pct.unwrap_or(0.0))))
            .min_by(|a, b| a.0.cmp(b.0))
            .map(|(r, rem)| format_reset_label(r, rem))
            .unwrap_or_else(|| "— pending live quota".into());

        providers.push(ProviderQuota {
            provider,
            account_count,
            remaining_pct,
            capacity_pct,
            pool_empty,
            first_empty,
            next_reset,
            burn_last_horizon: format!("{:.1}%/h", burn_pct_per_hour),
            burn_pct_per_hour,
        });
    }
    providers.sort_by(|a, b| a.provider.cmp(&b.provider));

    let loaded = accounts.iter().filter(|a| a.loaded).count() as u64;
    let total = list.total.unwrap_or(accounts.len() as u64);

    Ok(QuotaSnapshot {
        source: "management",
        observed_at: Utc::now().to_rfc3339(),
        credentials_total: total.max(accounts.len() as u64),
        credentials_loaded: loaded,
        providers,
        accounts,
        note: "Live credential signals from the local proxy management API; burn % estimated from Rivet traffic.".into(),
    })
}

async fn fetch_live_quota(
    http: &reqwest::Client,
    base: &str,
    key: &str,
    auth_index: &str,
) -> Result<QuotaFetchResponse> {
    for path in [
        "/v8/management/credentials/quota/fetch",
        "/v0/management/quota/fetch",
    ] {
        let url = format!("{base}{path}");
        let res = auth_headers(http.post(&url), key)
            .json(&serde_json::json!({ "auth_index": auth_index }))
            .send()
            .await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND
            || res.status() == reqwest::StatusCode::NOT_IMPLEMENTED
        {
            continue;
        }
        if !res.status().is_success() {
            return Err(anyhow!("quota fetch {}", res.status()));
        }
        return Ok(res.json().await?);
    }
    Err(anyhow!("no quota fetch endpoint"))
}

fn remaining_from_signals(obs: Option<&QuotaObservation>) -> Option<f64> {
    let signals = obs?.signals.as_ref()?;

    // Codex: used-percent → remaining.
    let mut used_candidates = Vec::new();
    for (k, v) in signals {
        let key = k.to_ascii_lowercase();
        if key.contains("used-percent") || key.contains("used_percent") {
            if let Ok(n) = v.parse::<f64>() {
                used_candidates.push((primary_rank(&key), n));
            }
        }
    }
    if let Some((_, used)) = used_candidates.iter().min_by_key(|(r, _)| *r) {
        return Some((100.0 - *used).clamp(0.0, 100.0));
    }

    // Claude: utilization is 0–1 used fraction on unified windows.
    let mut util_candidates = Vec::new();
    for (k, v) in signals {
        let key = k.to_ascii_lowercase();
        if key.contains("utilization") {
            if let Ok(n) = v.parse::<f64>() {
                let used_pct = if n <= 1.0 { n * 100.0 } else { n };
                util_candidates.push((claude_window_rank(&key), used_pct));
            }
        }
    }
    if let Some((_, used)) = util_candidates.iter().min_by_key(|(r, _)| *r) {
        return Some((100.0 - *used).clamp(0.0, 100.0));
    }

    for (k, v) in signals {
        let key = k.to_ascii_lowercase();
        if key.contains("remaining") && key.contains("percent") {
            if let Ok(n) = v.parse::<f64>() {
                return Some(n.clamp(0.0, 100.0));
            }
        }
    }
    None
}

fn reset_from_signals(obs: Option<&QuotaObservation>) -> Option<String> {
    let signals = obs?.signals.as_ref()?;
    let mut candidates = Vec::new();
    for (k, v) in signals {
        let key = k.to_ascii_lowercase();
        if key.contains("reset-after-seconds") {
            if let Ok(secs) = v.parse::<i64>() {
                let at = Utc::now() + chrono::Duration::seconds(secs.max(0));
                candidates.push((primary_rank(&key), at.to_rfc3339()));
            }
        } else if key.ends_with("-reset") || key.ends_with("_reset") || key.contains("reset-at") {
            if let Some(iso) = parse_reset_value(v) {
                candidates.push((claude_window_rank(&key).min(primary_rank(&key)), iso));
            }
        }
    }
    candidates
        .into_iter()
        .min_by_key(|(r, _)| *r)
        .map(|(_, iso)| iso)
}

fn parse_reset_value(v: &str) -> Option<String> {
    if let Ok(n) = v.parse::<i64>() {
        // Unix seconds (or ms).
        let secs = if n > 1_000_000_000_000 {
            n / 1000
        } else {
            n
        };
        return Utc.timestamp_opt(secs, 0).single().map(|t| t.to_rfc3339());
    }
    if DateTime::parse_from_rfc3339(v).is_ok() {
        return Some(v.to_string());
    }
    None
}

fn primary_rank(key: &str) -> i32 {
    if key.contains("primary") {
        0
    } else if key.contains("secondary") {
        1
    } else if key.contains("5h") {
        0
    } else if key.contains("7d") {
        2
    } else {
        3
    }
}

fn claude_window_rank(key: &str) -> i32 {
    if key.contains("5h") {
        0
    } else if key.contains("7d") {
        1
    } else {
        2
    }
}

fn cooldown_reset(items: Option<&Vec<CooldownItem>>) -> Option<String> {
    items?
        .iter()
        .filter(|c| {
            c.reason
                .as_deref()
                .map(|r| r.contains("quota"))
                .unwrap_or(true)
        })
        .filter_map(|c| c.retry_at.clone())
        .min()
}

fn normalize_provider(raw: &str) -> String {
    let s = raw.to_ascii_lowercase();
    if s.contains("claude") || s == "anthropic" {
        "claude".into()
    } else if s.contains("codex") || s.contains("openai") {
        "codex".into()
    } else {
        s
    }
}

fn format_horizon(hours: f64) -> String {
    if !hours.is_finite() || hours > 24.0 * 14.0 {
        return "Not soon".into();
    }
    if hours < 1.0 {
        format!("~{}m", (hours * 60.0).round().max(1.0) as i64)
    } else if hours < 48.0 {
        format!("~{:.1}h", hours)
    } else {
        format!("~{:.1}d", hours / 24.0)
    }
}

fn format_reset_label(reset_at: &str, remaining_pct: f64) -> String {
    let refill = (100.0 - remaining_pct).clamp(0.0, 100.0);
    let when = DateTime::parse_from_rfc3339(reset_at)
        .ok()
        .map(|d| d.with_timezone(&Utc).format("%a %H:%M UTC").to_string())
        .or_else(|| {
            reset_at
                .parse::<i64>()
                .ok()
                .and_then(|secs| Utc.timestamp_opt(secs, 0).single())
                .map(|t| t.format("%a %H:%M UTC").to_string())
        })
        .unwrap_or_else(|| reset_at.to_string());
    if refill > 0.5 {
        format!("+{refill:.0}% {when}")
    } else {
        format!("reset {when}")
    }
}

/// Local-only snapshot when management API is unreachable.
pub fn local_fallback_snapshot(
    accounts: &[(String, String, String)],
    burn_by_provider: &HashMap<String, f64>,
) -> QuotaSnapshot {
    let mut by_provider: HashMap<String, u64> = HashMap::new();
    let mut out_accounts = Vec::new();
    for (id, provider, label) in accounts {
        let p = normalize_provider(provider);
        *by_provider.entry(p.clone()).or_default() += 1;
        out_accounts.push(QuotaAccount {
            id: id.clone(),
            provider: p,
            label: label.clone(),
            email: if label.contains('@') {
                Some(label.clone())
            } else {
                None
            },
            remaining_pct: None,
            reset_at: None,
            cooldown_seconds: None,
            supports_quota: false,
            loaded: true,
            status: "local".into(),
        });
    }
    let mut providers = Vec::new();
    for (provider, account_count) in by_provider {
        let capacity_pct = account_count as f64 * 100.0;
        let burn_tok_h = burn_by_provider.get(&provider).copied().unwrap_or(0.0);
        let assumed_pool_tokens = (capacity_pct / 100.0) * 80_000.0;
        let burn_pct_per_hour = if assumed_pool_tokens > 0.0 {
            (burn_tok_h / assumed_pool_tokens) * 100.0
        } else {
            0.0
        };
        let remaining_pct = capacity_pct;
        let pool_empty = if burn_pct_per_hour > 0.01 {
            format_horizon(remaining_pct / burn_pct_per_hour)
        } else {
            "Sign in / refresh for live quota".into()
        };
        providers.push(ProviderQuota {
            provider,
            account_count,
            remaining_pct,
            capacity_pct,
            pool_empty,
            first_empty: "—".into(),
            next_reset: "— pending live quota".into(),
            burn_last_horizon: format!("{:.1}%/h", burn_pct_per_hour),
            burn_pct_per_hour,
        });
    }
    providers.sort_by(|a, b| a.provider.cmp(&b.provider));
    QuotaSnapshot {
        source: "local",
        observed_at: Utc::now().to_rfc3339(),
        credentials_total: out_accounts.len() as u64,
        credentials_loaded: out_accounts.len() as u64,
        providers,
        accounts: out_accounts,
        note: "Proxy management unreachable — showing local account list + traffic burn estimates.".into(),
    }
}
