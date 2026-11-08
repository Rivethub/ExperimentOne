//! Pull credential + quota signals from the local `CLIProxyAPI` management API.

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
    /// Accounts that reported a remaining_% (may be less than `account_count`).
    pub known_count: u64,
    /// Sum of remaining % across accounts with signals.
    pub remaining_pct: f64,
    /// Capacity = `known_count` × 100 (never invents unknown as full).
    pub capacity_pct: f64,
    pub pool_empty: String,
    pub first_empty: String,
    pub next_reset: String,
    pub burn_last_horizon: String,
    pub burn_pct_per_hour: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaWindow {
    /// Stable key: `5h`, `7d`, `primary`, `secondary`, model id, etc.
    pub id: String,
    pub label: String,
    pub remaining_pct: Option<f64>,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaAccount {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub remaining_pct: Option<f64>,
    pub reset_at: Option<String>,
    pub cooldown_seconds: Option<i64>,
    pub supports_quota: bool,
    pub loaded: bool,
    pub status: String,
    /// Per-limit windows (5h / weekly / model). Empty when provider only reports one watermark.
    pub windows: Vec<QuotaWindow>,
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
    subscription: Option<QuotaSubscriptionRaw>,
    #[serde(default)]
    groups: Vec<QuotaGroup>,
}

#[derive(Debug, Deserialize)]
struct QuotaSubscriptionRaw {
    #[serde(default)]
    plan: Option<String>,
    #[serde(default, rename = "tierName")]
    tier_name: Option<String>,
    #[serde(default, rename = "tier_name")]
    tier_name_snake: Option<String>,
}

impl QuotaSubscriptionRaw {
    fn plan_label(&self) -> Option<String> {
        self.plan
            .clone()
            .or_else(|| self.tier_name.clone())
            .or_else(|| self.tier_name_snake.clone())
    }
}

#[derive(Debug, Deserialize)]
struct QuotaGroup {
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default, rename = "display_name")]
    display_name_snake: Option<String>,
    #[serde(default)]
    buckets: Vec<QuotaBucket>,
}

impl QuotaGroup {
    fn name(&self) -> Option<String> {
        self.display_name.clone().or_else(|| self.display_name_snake.clone())
    }
}

#[derive(Debug, Deserialize)]
struct QuotaBucket {
    #[serde(default)]
    window: Option<String>,
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
        self.remaining_fraction.or(self.remaining_fraction_camel).map(|f| f * 100.0)
    }

    fn reset(&self) -> Option<String> {
        self.reset_time.clone().or_else(|| self.reset_time_camel.clone())
    }

    fn window_id(&self, group_name: Option<&str>) -> String {
        if let Some(w) = self.window.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            return normalize_window_id(w);
        }
        if let Some(g) = group_name.map(str::trim).filter(|s| !s.is_empty()) {
            return normalize_window_id(g);
        }
        "limit".into()
    }
}

fn normalize_window_id(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("5h") || lower.contains("five hour") || lower.contains("5-hour") {
        return "5h".into();
    }
    if lower.contains("7d") || lower.contains("weekly") || lower.contains("7-day") {
        return "7d".into();
    }
    if lower.contains("primary") {
        return "primary".into();
    }
    if lower.contains("secondary") {
        return "secondary".into();
    }
    raw.trim().replace(' ', "_").to_ascii_lowercase()
}

fn window_label(id: &str) -> String {
    match id {
        "5h" => "5-hour".into(),
        "7d" => "Weekly".into(),
        "primary" => "Primary".into(),
        "secondary" => "Secondary".into(),
        other => other.replace('_', " "),
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
    req.header("Authorization", format!("Bearer {key}")).header("X-Management-Key", key)
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
        },
    };
    build_snapshot(cfg, &http, key, list, burn_by_provider).await
}

async fn list_credentials(http: &reqwest::Client, base: &str, key: &str) -> Result<CredList> {
    let url = format!("{base}/v8/management/credentials");
    let res = auth_headers(http.get(&url), key).send().await.context("list credentials")?;
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
            file.provider.as_deref().or(file.type_.as_deref()).unwrap_or("unknown"),
        );
        let email = file.email.clone();
        let label = file.label.clone().or_else(|| email.clone()).unwrap_or_else(|| id.clone());

        let mut remaining_pct = remaining_from_signals(file.quota.as_ref());
        let mut reset_at = reset_from_signals(file.quota.as_ref())
            .or_else(|| cooldown_reset(file.cooldowns.as_ref()))
            .or_else(|| file.next_retry_after.clone());
        let cooldown_seconds = file
            .cooldowns
            .as_ref()
            .and_then(|c| c.iter().filter_map(|x| x.remaining_seconds).max());
        let mut windows = windows_from_signals(file.quota.as_ref());
        let mut plan: Option<String> = None;

        let supports = file.supports_quota.unwrap_or(false);
        if supports {
            if let Ok(fetched) = fetch_live_quota(http, &cfg.proxy_base_url(), key, &id).await {
                plan = fetched.subscription.as_ref().and_then(QuotaSubscriptionRaw::plan_label);
                let fetched_windows = windows_from_fetch(&fetched);
                if !fetched_windows.is_empty() {
                    windows = fetched_windows;
                }
                if remaining_pct.is_none() {
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
        }

        if remaining_pct.is_none() {
            remaining_pct = windows.iter().find_map(|w| w.remaining_pct);
        }
        if reset_at.is_none() {
            reset_at = windows.iter().find_map(|w| w.reset_at.clone());
        }
        if windows.is_empty() {
            if let Some(rem) = remaining_pct {
                windows.push(QuotaWindow {
                    id: "limit".into(),
                    label: "Limit".into(),
                    remaining_pct: Some(rem),
                    reset_at: reset_at.clone(),
                });
            }
        }

        let loaded = !file.disabled.unwrap_or(false) && !file.unavailable.unwrap_or(false);
        accounts.push(QuotaAccount {
            id,
            provider,
            label,
            email,
            plan,
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
            windows,
        });
    }

    let mut by_provider: HashMap<String, Vec<&QuotaAccount>> = HashMap::new();
    for a in &accounts {
        by_provider.entry(a.provider.clone()).or_default().push(a);
    }

    let mut providers = Vec::new();
    for (provider, list) in by_provider {
        let burn_tok_h = burn_by_provider.get(&provider).copied().unwrap_or(0.0);
        providers.push(provider_quota_from_accounts(&provider, &list, burn_tok_h));
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
        note: "Remaining sums only observed provider watermarks (unknown ≠ full). Burn %/h is estimated from captured Rivet traffic, not provider billing.".into(),
    })
}

async fn fetch_live_quota(
    http: &reqwest::Client,
    base: &str,
    key: &str,
    auth_index: &str,
) -> Result<QuotaFetchResponse> {
    let url = format!("{base}/v8/management/credentials/quota/fetch");
    let res = auth_headers(http.post(&url), key)
        .json(&serde_json::json!({ "auth_index": auth_index }))
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(anyhow!("quota fetch {}", res.status()));
    }
    Ok(res.json().await?)
}

fn windows_from_fetch(fetched: &QuotaFetchResponse) -> Vec<QuotaWindow> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for group in &fetched.groups {
        let gname = group.name();
        for bucket in &group.buckets {
            let rem = bucket.remaining();
            if rem.is_none() && bucket.reset().is_none() {
                continue;
            }
            let id = bucket.window_id(gname.as_deref());
            if !seen.insert(id.clone()) {
                continue;
            }
            out.push(QuotaWindow {
                id: id.clone(),
                label: gname
                    .clone()
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| window_label(&id)),
                remaining_pct: rem,
                reset_at: bucket.reset(),
            });
        }
    }
    out.sort_by_key(|a| window_sort_key(&a.id));
    out
}

fn windows_from_signals(obs: Option<&QuotaObservation>) -> Vec<QuotaWindow> {
    let Some(signals) = obs.and_then(|o| o.signals.as_ref()) else {
        return Vec::new();
    };
    let mut by_id: HashMap<String, QuotaWindow> = HashMap::new();

    for (k, v) in signals {
        let key = k.to_ascii_lowercase();
        let id = if key.contains("5h") {
            "5h".to_string()
        } else if key.contains("7d") {
            "7d".to_string()
        } else if key.contains("primary") {
            "primary".to_string()
        } else if key.contains("secondary") {
            "secondary".to_string()
        } else {
            continue;
        };
        let entry = by_id.entry(id.clone()).or_insert_with(|| QuotaWindow {
            id: id.clone(),
            label: window_label(&id),
            remaining_pct: None,
            reset_at: None,
        });
        if key.contains("used-percent") || key.contains("used_percent") {
            if let Ok(n) = v.parse::<f64>() {
                entry.remaining_pct = Some((100.0 - n).clamp(0.0, 100.0));
            }
        } else if key.contains("utilization") {
            if let Ok(n) = v.parse::<f64>() {
                let used = if n <= 1.0 { n * 100.0 } else { n };
                entry.remaining_pct = Some((100.0 - used).clamp(0.0, 100.0));
            }
        } else if key.contains("remaining") && key.contains("percent") {
            if let Ok(n) = v.parse::<f64>() {
                entry.remaining_pct = Some(n.clamp(0.0, 100.0));
            }
        } else if key.contains("reset-after-seconds") {
            if let Ok(secs) = v.parse::<i64>() {
                let at = Utc::now() + chrono::Duration::seconds(secs.max(0));
                entry.reset_at = Some(at.to_rfc3339());
            }
        } else if key.ends_with("-reset") || key.ends_with("_reset") || key.contains("reset-at") {
            if let Some(iso) = parse_reset_value(v) {
                entry.reset_at = Some(iso);
            }
        }
    }

    let mut out: Vec<_> = by_id.into_values().collect();
    out.sort_by_key(|a| window_sort_key(&a.id));
    out
}

fn window_sort_key(id: &str) -> i32 {
    match id {
        "5h" | "primary" => 0,
        "7d" | "secondary" => 1,
        "limit" => 9,
        _ => 5,
    }
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
    candidates.into_iter().min_by_key(|(r, _)| *r).map(|(_, iso)| iso)
}

fn parse_reset_value(v: &str) -> Option<String> {
    if let Ok(n) = v.parse::<i64>() {
        // Unix seconds (or ms).
        let secs = if n > 1_000_000_000_000 { n / 1000 } else { n };
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
        .filter(|c| c.reason.as_deref().is_none_or(|r| r.contains("quota")))
        .filter_map(|c| c.retry_at.clone())
        .min()
}

fn normalize_provider(raw: &str) -> String {
    rivet_core::normalize_provider_id(raw)
}

fn format_horizon(hours: f64) -> String {
    if !hours.is_finite() || hours > 24.0 * 14.0 {
        return "Not soon".into();
    }
    if hours < 1.0 {
        format!("~{:.0}m", hours.mul_add(60.0, 0.0).max(1.0))
    } else if hours < 48.0 {
        format!("~{hours:.1}h")
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
            email: if label.contains('@') { Some(label.clone()) } else { None },
            plan: None,
            remaining_pct: None,
            reset_at: None,
            cooldown_seconds: None,
            supports_quota: false,
            loaded: true,
            status: "local".into(),
            windows: Vec::new(),
        });
    }
    let mut providers = Vec::new();
    for (provider, account_count) in by_provider {
        let burn_tok_h = burn_by_provider.get(&provider).copied().unwrap_or(0.0);
        providers.push(ProviderQuota {
            provider,
            account_count,
            known_count: 0,
            remaining_pct: 0.0,
            capacity_pct: 0.0,
            pool_empty: "— pending live quota".into(),
            first_empty: "—".into(),
            next_reset: "— pending live quota".into(),
            burn_last_horizon: if burn_tok_h > 0.0 {
                format!("{burn_tok_h:.0} tok/h")
            } else {
                "0 tok/h".into()
            },
            burn_pct_per_hour: 0.0,
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
        note: "Proxy management unreachable — account list only; remaining % withheld until live quota signals exist. Burn shown as tok/h from traffic.".into(),
    }
}

/// Assumed tokens remaining from summed account percentages (production path).
pub fn remaining_tokens_from_pct_sum(remaining_pct_sum: f64) -> f64 {
    (remaining_pct_sum / 100.0) * 80_000.0
}

const ASSUMED_TOK_PER_ACCT: f64 = 80_000.0;

fn u64_to_f64(value: u64) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

/// Pure per-provider rollup used by `build_snapshot` (unit-testable).
pub fn provider_quota_from_accounts(
    provider: &str,
    list: &[&QuotaAccount],
    burn_tok_h: f64,
) -> ProviderQuota {
    let account_count = list.len() as u64;
    let known: Vec<f64> =
        list.iter().filter(|a| a.loaded).filter_map(|a| a.remaining_pct).collect();
    let known_count = known.len() as u64;
    // Only sum observed watermarks — never invent "full" for missing signals.
    let remaining_pct = known.iter().sum::<f64>();
    let capacity_pct = if known_count > 0 { u64_to_f64(known_count) * 100.0 } else { 0.0 };

    let remaining_tokens: f64 = remaining_tokens_from_pct_sum(
        list.iter().filter(|a| a.loaded).filter_map(|a| a.remaining_pct).sum(),
    );
    let burn_pct_per_hour = if known_count > 0 {
        let pool = u64_to_f64(known_count) * ASSUMED_TOK_PER_ACCT;
        (burn_tok_h / pool) * 100.0
    } else {
        0.0
    };

    let pool_empty = if known.is_empty() {
        "— pending live quota".into()
    } else if remaining_tokens <= 0.0 {
        "Empty".into()
    } else if burn_tok_h > 1.0 {
        format!("est. {} @ 80k tok/acct", format_horizon(remaining_tokens / burn_tok_h))
    } else {
        "Steady".into()
    };

    let first_empty = list
        .iter()
        .filter(|a| a.loaded)
        .filter_map(|a| {
            let rem = a.remaining_pct?;
            if burn_tok_h <= 1.0 || known_count == 0 {
                return None;
            }
            let share = burn_tok_h / u64_to_f64(known_count);
            if share <= 0.0 {
                return None;
            }
            let rem_tok = (rem / 100.0) * ASSUMED_TOK_PER_ACCT;
            Some((rem_tok / share, a.label.clone()))
        })
        .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        .map_or_else(
            || {
                if known.is_empty() {
                    "— pending live quota".into()
                } else {
                    "—".into()
                }
            },
            |(h, label)| format!("est. {label} · {}", format_horizon(h)),
        );

    let next_reset = list
        .iter()
        .filter(|a| a.loaded)
        .filter_map(|a| {
            let rem = a.remaining_pct?;
            let r = a.reset_at.as_ref()?;
            Some((r, rem))
        })
        .min_by(|a, b| a.0.cmp(b.0))
        .map_or_else(
            || {
                if known.is_empty() {
                    "— pending live quota".into()
                } else {
                    "—".into()
                }
            },
            |(r, rem)| format_reset_label(r, rem),
        );

    ProviderQuota {
        provider: provider.to_string(),
        account_count,
        known_count,
        remaining_pct,
        capacity_pct,
        pool_empty,
        first_empty,
        next_reset,
        burn_last_horizon: format!("{burn_tok_h:.0} tok/h"),
        burn_pct_per_hour,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(id: &str, remaining: Option<f64>, loaded: bool, reset: Option<&str>) -> QuotaAccount {
        QuotaAccount {
            id: id.into(),
            provider: "claude".into(),
            label: id.into(),
            email: None,
            plan: None,
            remaining_pct: remaining,
            reset_at: reset.map(str::to_string),
            cooldown_seconds: None,
            supports_quota: remaining.is_some(),
            loaded,
            status: if loaded { "loaded" } else { "unavailable" }.into(),
            windows: remaining
                .map(|r| {
                    vec![QuotaWindow {
                        id: "limit".into(),
                        label: "Limit".into(),
                        remaining_pct: Some(r),
                        reset_at: reset.map(str::to_string),
                    }]
                })
                .unwrap_or_default(),
        }
    }

    #[test]
    fn pool_empty_uses_token_sum_not_pct_sum() {
        // Two accounts at 50% with 80k tok/acct ⇒ 80k remaining.
        // Burn 80k tok/h ⇒ 1 hour, not 2 (the old pct/burn_% bug).
        let acct_a = acct("a", Some(50.0), true, None);
        let acct_b = acct("b", Some(50.0), true, None);
        let q = provider_quota_from_accounts("claude", &[&acct_a, &acct_b], 80_000.0);
        assert_eq!(q.known_count, 2);
        assert!((q.remaining_pct - 100.0).abs() < 1e-9);
        assert!(
            q.pool_empty.contains("~1.0h") || q.pool_empty.contains("~1h"),
            "got {}",
            q.pool_empty
        );
    }

    #[test]
    fn unknown_accounts_do_not_inflate_capacity_or_reset() {
        let known = acct("k", Some(40.0), true, Some("2026-01-01T00:00:00Z"));
        let unknown = acct("u", None, true, Some("2026-01-01T00:00:00Z"));
        let unloaded = acct("x", Some(90.0), false, Some("2026-01-01T00:00:00Z"));
        let q = provider_quota_from_accounts("claude", &[&known, &unknown, &unloaded], 0.0);
        assert_eq!(q.account_count, 3);
        assert_eq!(q.known_count, 1);
        assert!((q.capacity_pct - 100.0).abs() < 1e-9);
        assert!((q.remaining_pct - 40.0).abs() < 1e-9);
        assert!(
            q.next_reset.contains("+60%") || q.next_reset.contains("reset"),
            "{}",
            q.next_reset
        );
        assert_eq!(q.burn_pct_per_hour, 0.0);
    }

    #[test]
    fn empty_pool_when_all_unknown() {
        let acct_a = acct("a", None, true, None);
        let acct_b = acct("b", None, true, None);
        let q = provider_quota_from_accounts("codex", &[&acct_a, &acct_b], 12_000.0);
        assert_eq!(q.known_count, 0);
        assert_eq!(q.capacity_pct, 0.0);
        assert!(q.pool_empty.contains("pending"), "{}", q.pool_empty);
        assert!(q.next_reset.contains("pending"), "{}", q.next_reset);
        assert_eq!(q.burn_pct_per_hour, 0.0);
        assert!(q.burn_last_horizon.contains("12000"), "{}", q.burn_last_horizon);
    }

    #[test]
    fn local_fallback_marks_unknown() {
        let snap = local_fallback_snapshot(
            &[("a".into(), "claude".into(), "a@x".into())],
            &HashMap::from([("claude".into(), 100.0)]),
        );
        assert_eq!(snap.source, "local");
        assert_eq!(snap.providers[0].known_count, 0);
        assert!(snap.providers[0].pool_empty.contains("pending"));
    }
}
