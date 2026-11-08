//! Agent-friendly Rivet setup and control CLI.

mod client;
mod daemon;
mod install;
mod paths;

use std::process::ExitCode;
use std::time::Duration;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

use client::{default_api_base, ApiClient};
use paths::{installed_version, resolve_runtime_bin};

const AGENT_PROMPT: &str = include_str!("../../../docs/agent-setup-prompt.md");

#[derive(Parser, Debug)]
#[command(
    name = "rivet",
    about = "Install, start, and control Rivet (local AI proxy) for agents and humans",
    version
)]
struct Cli {
    /// Print JSON for machine-readable commands (status, doctor, accounts, …).
    #[arg(long, global = true)]
    json: bool,

    /// Control API base URL (default: from config.json or http://127.0.0.1:8741).
    #[arg(long, global = true, env = "RIVET_API_URL")]
    api_url: Option<String>,

    #[command(subcommand)]
    cmd: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Download headless binaries from the latest (or tagged) GitHub release.
    Install {
        /// Release tag (e.g. v0.1.0). Default: latest.
        #[arg(long)]
        version: Option<String>,
    },
    /// Reinstall from the latest GitHub release.
    Upgrade,
    /// Install if needed, start rivetd, print onboarding checklist.
    Setup {
        /// Release tag for install when binaries are missing.
        #[arg(long)]
        version: Option<String>,
        /// Seconds to wait for rivetd to become ready.
        #[arg(long, default_value_t = 30)]
        wait: u64,
    },
    /// Start rivetd (from install root / RIVET_BIN_DIR / PATH).
    Start {
        #[arg(long, default_value_t = 30)]
        wait: u64,
    },
    /// Stop rivetd and owned sidecars.
    Stop,
    /// Restart rivetd.
    Restart {
        #[arg(long, default_value_t = 30)]
        wait: u64,
    },
    /// Control plane status.
    Status,
    /// Check onboarding gates; exit 1 when not ready.
    Doctor,
    /// Proxy control.
    Proxy {
        #[command(subcommand)]
        action: ProxyCmd,
    },
    /// Provider account login flows (`rivet login claude`, `rivet login status`, `rivet login cancel`).
    Login {
        /// Provider id, or `status` / `cancel`.
        target: String,
        /// Login method override (`browser` / `device`) for providers that support both.
        #[arg(long)]
        method: Option<String>,
        /// Poll login status until the flow finishes.
        #[arg(long)]
        watch: bool,
    },
    /// List signed-in accounts.
    Accounts,
    /// List supported providers.
    Providers,
    /// Write Claude / Codex harness config.
    Harness {
        #[command(subcommand)]
        action: HarnessCmd,
    },
    /// Seed demo traffic for UI / smoke tests.
    Demo {
        #[command(subcommand)]
        action: DemoCmd,
    },
    /// Recent traffic events.
    Traffic {
        #[command(subcommand)]
        action: TrafficCmd,
    },
    /// Kick background workers.
    Workers {
        #[command(subcommand)]
        action: WorkersCmd,
    },
    /// Public config (no secrets).
    Config {
        #[command(subcommand)]
        action: ConfigCmd,
    },
    /// Export traffic bag (no credentials).
    Export,
    /// Import a .rivetbag traffic package.
    Import { path: String },
    /// Ingest local harness transcripts already on disk (Claude Code / Codex).
    Ingest {
        #[command(subcommand)]
        action: IngestCmd,
    },
    /// Tail proxy or ClickHouse logs.
    Logs { kind: String },
    /// Print localhost session bootstrap (api key). Use sparingly.
    Session,
    /// Print the agent drop-in setup prompt.
    Prompt,
    /// CLI + installed runtime version.
    #[command(name = "version", visible_alias = "ver")]
    VersionInfo,
}

#[derive(Subcommand, Debug)]
enum ProxyCmd {
    Start,
    Stop,
}

#[derive(Subcommand, Debug)]
enum HarnessCmd {
    Write {
        target: String,
        #[arg(long, default_value = "user")]
        mode: String,
    },
}

#[derive(Subcommand, Debug)]
enum DemoCmd {
    Seed,
}

#[derive(Subcommand, Debug)]
enum TrafficCmd {
    Recent,
}

#[derive(Subcommand, Debug)]
enum WorkersCmd {
    Tick,
    /// Show NATS `JetStream` job queue counters.
    Queue,
}

#[derive(Subcommand, Debug)]
enum ConfigCmd {
    Get,
}

#[derive(Subcommand, Debug)]
enum IngestCmd {
    /// Scan local harness transcripts (Claude / Codex / Cursor) and ingest turns.
    Local {
        /// `all` (default), `claude`, `codex`, or `cursor`.
        #[arg(long, default_value = "all")]
        source: String,
        /// Override Claude projects root (default: ~/.claude/projects).
        #[arg(long)]
        claude_root: Option<String>,
        /// Override Codex sessions root (default: ~/.codex/sessions).
        #[arg(long)]
        codex_root: Option<String>,
        /// Override Cursor projects root (default: ~/.cursor/projects).
        #[arg(long)]
        cursor_root: Option<String>,
        /// Parse and report without writing to the store.
        #[arg(long)]
        dry_run: bool,
        /// Cap parsed events (useful for smoke tests).
        #[arg(long)]
        limit: Option<usize>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        },
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();

    match cli.cmd {
        Commands::Install { version } => {
            let report = install::install(version.as_deref()).await?;
            install::print_install_report(&report);
            return Ok(());
        },
        Commands::Upgrade => {
            let report = install::install(None).await?;
            install::print_install_report(&report);
            return Ok(());
        },
        Commands::Prompt => {
            print!("{AGENT_PROMPT}");
            return Ok(());
        },
        Commands::VersionInfo => {
            let cli_ver = env!("CARGO_PKG_VERSION");
            let runtime = installed_version();
            let rivetd = resolve_runtime_bin("rivetd").map(|p| p.display().to_string());
            if cli.json {
                println!(
                    "{}",
                    json!({
                        "cli": cli_ver,
                        "installed_release": runtime,
                        "rivetd": rivetd,
                        "triple": rivet_core::target_triple(),
                    })
                );
            } else {
                println!("rivet-cli {cli_ver}");
                println!("triple {}", rivet_core::target_triple());
                match runtime {
                    Some(tag) => println!("installed release {tag}"),
                    None => println!("installed release (none)"),
                }
                match rivetd {
                    Some(p) => println!("rivetd {p}"),
                    None => println!("rivetd (not found)"),
                }
            }
            return Ok(());
        },
        _ => {},
    }

    let base = cli.api_url.clone().unwrap_or_else(default_api_base);
    let mut client = ApiClient::new(base)?;

    match cli.cmd {
        Commands::Install { .. } | Commands::Upgrade | Commands::Prompt | Commands::VersionInfo => {
            unreachable!("handled above")
        },
        Commands::Setup { version, wait } => {
            cmd_setup(&mut client, version.as_deref(), wait, cli.json).await?;
        },
        Commands::Start { wait } => {
            daemon::start(&mut client, wait).await?;
        },
        Commands::Stop => {
            daemon::stop(&mut client).await?;
        },
        Commands::Restart { wait } => {
            let _ = daemon::stop(&mut client).await;
            daemon::start(&mut client, wait).await?;
        },
        Commands::Status => {
            let v = client.get_value("/v1/status").await?;
            print_value(&v, cli.json);
        },
        Commands::Doctor => {
            cmd_doctor(&mut client, cli.json).await?;
        },
        Commands::Proxy { action } => match action {
            ProxyCmd::Start => {
                let v = client.post_value("/v1/proxy/start", None).await?;
                print_value(&v, cli.json);
            },
            ProxyCmd::Stop => {
                let v = client.post_value("/v1/proxy/stop", None).await?;
                print_value(&v, cli.json);
            },
        },
        Commands::Login { target, method, watch } => {
            cmd_login(&mut client, &target, method, watch, cli.json).await?;
        },
        Commands::Accounts => {
            let v = client.get_value("/v1/accounts").await?;
            print_value(&v, cli.json);
        },
        Commands::Providers => {
            let v = client.get_value("/v1/providers").await?;
            print_value(&v, cli.json);
        },
        Commands::Harness { action } => match action {
            HarnessCmd::Write { target, mode } => {
                let body = json!({ "target": target, "mode": mode });
                let v = client.post_value("/v1/harness/write", Some(body)).await?;
                print_value(&v, cli.json);
            },
        },
        Commands::Demo { action } => match action {
            DemoCmd::Seed => {
                let v = client.post_value("/v1/demo/seed", None).await?;
                print_value(&v, cli.json);
            },
        },
        Commands::Traffic { action } => match action {
            TrafficCmd::Recent => {
                let v = client.get_value("/v1/traffic/recent").await?;
                print_value(&v, cli.json);
            },
        },
        Commands::Workers { action } => match action {
            WorkersCmd::Tick => {
                let v = client.post_value("/v1/workers/tick", None).await?;
                print_value(&v, cli.json);
            },
            WorkersCmd::Queue => {
                let v = client.get_value("/v1/workers/queue").await?;
                print_value(&v, cli.json);
            },
        },
        Commands::Config { action } => match action {
            ConfigCmd::Get => {
                let v = client.get_value("/v1/config").await?;
                print_value(&v, cli.json);
            },
        },
        Commands::Export => {
            let v = client.post_value("/v1/export", None).await?;
            print_value(&v, cli.json);
        },
        Commands::Import { path } => {
            let body = json!({ "path": path });
            let v = client.post_value("/v1/import", Some(body)).await?;
            print_value(&v, cli.json);
        },
        Commands::Ingest { action } => match action {
            IngestCmd::Local { source, claude_root, codex_root, cursor_root, dry_run, limit } => {
                let sources = match source.trim().to_ascii_lowercase().as_str() {
                    "all" | "" => json!([]),
                    "claude" | "claude-code" => json!(["claude"]),
                    "codex" => json!(["codex"]),
                    "cursor" => json!(["cursor"]),
                    other => {
                        bail!("unknown --source {other} (expected all, claude, codex, or cursor)")
                    },
                };
                let mut body = json!({
                    "sources": sources,
                    "dry_run": dry_run,
                });
                if let Some(p) = claude_root {
                    body["claude_root"] = json!(p);
                }
                if let Some(p) = codex_root {
                    body["codex_root"] = json!(p);
                }
                if let Some(p) = cursor_root {
                    body["cursor_root"] = json!(p);
                }
                if let Some(n) = limit {
                    body["limit"] = json!(n);
                }
                let v = client.post_value("/v1/ingest/local", Some(body)).await?;
                if cli.json {
                    print_value(&v, true);
                } else {
                    print_ingest_report(&v);
                }
            },
        },
        Commands::Logs { kind } => {
            let v = client.get_value(&format!("/v1/logs/{kind}")).await?;
            print_value(&v, cli.json);
        },
        Commands::Session => {
            let key = client.ensure_session().await?;
            if cli.json {
                println!("{}", json!({ "api_key": key }));
            } else {
                println!("{key}");
            }
        },
    }
    Ok(())
}

async fn cmd_setup(
    client: &mut ApiClient,
    version: Option<&str>,
    wait: u64,
    json: bool,
) -> Result<()> {
    if resolve_runtime_bin("rivetd").is_none() {
        eprintln!("rivetd missing — installing from GitHub release…");
        let report = install::install(version).await?;
        install::print_install_report(&report);
    } else if let Some(tag) = version {
        eprintln!("reinstalling release {tag}…");
        let report = install::install(Some(tag)).await?;
        install::print_install_report(&report);
    }

    daemon::start(client, wait).await?;
    let status = client.get_value("/v1/status").await?;
    if json {
        print_value(&status, true);
        return Ok(());
    }

    println!("Rivet is up at {}", client.base());
    if let Some(onboarding) = status.get("onboarding") {
        println!("Onboarding:");
        for key in ["proxy_running", "has_accounts", "harness_ready", "has_traffic"] {
            let ok = onboarding.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            println!("  {}: {}", key, if ok { "ok" } else { "needed" });
        }
    }
    if let Some(url) = status.get("proxy_base_url").and_then(|v| v.as_str()) {
        println!("Proxy: {url}");
    }
    println!();
    println!("Next:");
    println!("  rivet login <provider>     # human completes OAuth");
    println!("  rivet harness write claude");
    println!("  rivet doctor");
    Ok(())
}

async fn cmd_doctor(client: &mut ApiClient, json: bool) -> Result<()> {
    if !daemon::is_running(client).await {
        bail!("rivetd is not running — run `rivet start` or `rivet setup`");
    }
    let status = client.get_value("/v1/status").await?;
    let onboarding = status.get("onboarding").cloned().unwrap_or_else(|| json!({}));
    let proxy_running = onboarding.get("proxy_running").and_then(|v| v.as_bool()).unwrap_or(false);
    let has_accounts = onboarding.get("has_accounts").and_then(|v| v.as_bool()).unwrap_or(false);
    let harness_ready = onboarding.get("harness_ready").and_then(|v| v.as_bool()).unwrap_or(false);
    let ready = proxy_running && has_accounts && harness_ready;

    let report = json!({
        "ready": ready,
        "proxy_running": proxy_running,
        "has_accounts": has_accounts,
        "harness_ready": harness_ready,
        "proxy_base_url": status.get("proxy_base_url"),
        "warnings": status.get("warnings").cloned().unwrap_or_else(|| json!([])),
        "next": doctor_next(proxy_running, has_accounts, harness_ready),
    });

    if json {
        println!("{report}");
    } else {
        println!("doctor: {}", if ready { "ready" } else { "not ready" });
        println!("  proxy_running:  {}", flag(proxy_running));
        println!("  has_accounts:   {}", flag(has_accounts));
        println!("  harness_ready:  {}", flag(harness_ready));
        if let Some(next) = report.get("next").and_then(|v| v.as_str()) {
            println!("  next: {next}");
        }
        if let Some(warnings) = status.get("warnings").and_then(|v| v.as_array()) {
            for w in warnings {
                if let Some(s) = w.as_str() {
                    println!("  warning: {s}");
                }
            }
        }
    }

    if !ready {
        bail!("setup incomplete");
    }
    Ok(())
}

fn doctor_next(proxy: bool, accounts: bool, harness: bool) -> String {
    if !proxy {
        return "rivet proxy start".into();
    }
    if !accounts {
        return "rivet login <provider>  # then complete OAuth as the human".into();
    }
    if !harness {
        return "rivet harness write claude  # or codex".into();
    }
    "ok".into()
}

fn flag(ok: bool) -> &'static str {
    if ok {
        "yes"
    } else {
        "no"
    }
}

async fn cmd_login(
    client: &mut ApiClient,
    target: &str,
    method: Option<String>,
    watch: bool,
    json: bool,
) -> Result<()> {
    match target.trim().to_ascii_lowercase().as_str() {
        "status" => {
            login_status(client, watch, json).await?;
        },
        "cancel" => {
            let v = client.post_value("/v1/accounts/login/cancel", None).await?;
            print_value(&v, json);
        },
        provider => {
            let mut body = json!({ "provider": provider });
            if let Some(m) = method {
                body["method"] = json!(m);
            }
            let v = client.post_value("/v1/accounts/login", Some(body)).await?;
            print_value(&v, json);
            if !json {
                println!();
                println!("Complete OAuth / device login as the human, then run:");
                println!("  rivet login status --watch");
            }
            if watch {
                login_status(client, true, json).await?;
            }
        },
    }
    Ok(())
}

async fn login_status(client: &mut ApiClient, watch: bool, json: bool) -> Result<()> {
    let mut last = String::new();
    loop {
        let v = client.get_value("/v1/accounts/login/status").await?;
        if json && !watch {
            print_value(&v, true);
            return Ok(());
        }

        let output = v.get("output").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if output != last {
            // Print only the delta so agents/humans see new URL/device lines.
            let delta = if output.starts_with(&last) {
                output[last.len()..].to_string()
            } else {
                output.clone()
            };
            if !delta.is_empty() {
                print!("{delta}");
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
            last = output;
        }

        let done = v.get("done").and_then(|x| x.as_bool()).unwrap_or(false);
        let active = v.get("active").and_then(|x| x.as_bool()).unwrap_or(false);
        if done || !active {
            let success = v.get("success").and_then(|x| x.as_bool()).unwrap_or(false);
            if json {
                print_value(&v, true);
            } else if success {
                println!("\nlogin succeeded");
            } else if done {
                println!("\nlogin finished without success");
            } else {
                println!("\nno active login");
            }
            if done && !success {
                bail!("login failed");
            }
            return Ok(());
        }

        if !watch {
            if json {
                print_value(&v, true);
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn print_value(v: &Value, as_json: bool) {
    if as_json {
        println!("{v}");
    } else {
        match serde_json::to_string_pretty(v) {
            Ok(s) => println!("{s}"),
            Err(_) => println!("{v}"),
        }
    }
}

fn print_ingest_report(v: &Value) {
    let dry = v.get("dry_run").and_then(|x| x.as_bool()).unwrap_or(false);
    let files = v.get("files_scanned").and_then(|x| x.as_u64()).unwrap_or(0);
    let parsed = v.get("events_parsed").and_then(|x| x.as_u64()).unwrap_or(0);
    let inserted = v.get("events_inserted").and_then(|x| x.as_u64()).unwrap_or(0);
    let skipped = v.get("events_skipped_existing").and_then(|x| x.as_u64()).unwrap_or(0);
    println!(
        "ingest local{}: {files} files, {parsed} events parsed, {inserted} inserted, {skipped} skipped",
        if dry { " (dry-run)" } else { "" }
    );
    if let Some(sources) = v.get("sources").and_then(|x| x.as_array()) {
        for src in sources {
            let name = src.get("source").and_then(|x| x.as_str()).unwrap_or("?");
            let root = src.get("root").and_then(|x| x.as_str()).unwrap_or("");
            let f = src.get("files_scanned").and_then(|x| x.as_u64()).unwrap_or(0);
            let e = src.get("events_parsed").and_then(|x| x.as_u64()).unwrap_or(0);
            println!("  {name}: {e} events from {f} files ({root})");
        }
    }
}
