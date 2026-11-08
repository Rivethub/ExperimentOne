//! Download and unpack headless Rivet archives from GitHub Releases.

use std::fs::{self, File};
use std::io::Cursor;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use rivet_core::{exe_name, target_triple};
use serde::Deserialize;
use tar::Archive;

use crate::paths::{
    bin_dir, ensure_install_dirs, github_repo, path_display, user_bin_dir, version_file,
};

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
}

pub struct InstallReport {
    pub tag: String,
    pub asset: String,
    pub root: PathBuf,
    pub binaries: Vec<String>,
    pub linked_cli: Option<PathBuf>,
}

pub async fn install(version: Option<&str>) -> Result<InstallReport> {
    let repo = github_repo();
    let release = fetch_release(&repo, version).await?;
    let triple = target_triple();
    if triple == "unknown" {
        bail!("unsupported host platform for Rivet install");
    }

    let asset = pick_asset(&release, triple)
        .ok_or_else(|| {
            anyhow!(
                "no headless archive for triple '{triple}' in {repo}@{} — expected asset like rivet-{}-{triple}.tar.gz (or .zip). Assets present: {}",
                release.tag_name,
                strip_v(&release.tag_name),
                release
                    .assets
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;

    let tag = release.tag_name.clone();
    let asset_name = asset.name.clone();
    let asset_size = asset.size;
    let download_url = asset.browser_download_url.clone();

    eprintln!("Downloading {asset_name} ({asset_size} bytes) from {repo}@{tag}…");

    let bytes = download(&download_url).await?;
    let root = ensure_install_dirs()?;
    let dest = bin_dir()?;
    // Clear previous binaries so upgrades do not leave stale names.
    if dest.is_dir() {
        for entry in fs::read_dir(&dest).with_context(|| format!("read {}", dest.display()))? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let binaries = if asset_name.ends_with(".zip") {
        unpack_zip(&bytes, &dest)?
    } else if asset_name.ends_with(".tar.gz") || asset_name.ends_with(".tgz") {
        unpack_tar_gz(&bytes, &dest)?
    } else {
        bail!("unsupported archive type: {asset_name}");
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in &binaries {
            let path = dest.join(name);
            if path.is_file() {
                let mut perms = fs::metadata(&path)?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&path, perms)?;
            }
        }
    }

    fs::write(version_file()?, format!("{}\n", tag.trim())).context("write VERSION")?;

    let linked_cli = link_cli_to_user_bin(&dest)?;

    Ok(InstallReport { tag, asset: asset_name, root, binaries, linked_cli })
}

pub fn print_install_report(report: &InstallReport) {
    println!("Installed Rivet {}", report.tag);
    println!("  root: {}", path_display(&report.root));
    println!("  asset: {}", report.asset);
    println!("  binaries: {}", report.binaries.join(", "));
    if let Some(link) = &report.linked_cli {
        println!("  cli: {}", path_display(link));
    } else {
        println!("  cli: {} (add this directory to PATH)", path_display(&report.root.join("bin")));
    }
}

async fn fetch_release(repo: &str, version: Option<&str>) -> Result<Release> {
    let url = match version {
        Some(tag) => {
            let tag = tag.trim().trim_start_matches('v');
            // Try exact tag, then with v prefix.
            let candidates = [
                format!("https://api.github.com/repos/{repo}/releases/tags/{tag}"),
                format!("https://api.github.com/repos/{repo}/releases/tags/v{tag}"),
            ];
            let mut last_err = None;
            for candidate in candidates {
                match github_get_json(&candidate).await {
                    Ok(r) => return Ok(r),
                    Err(err) => last_err = Some(err),
                }
            }
            return Err(last_err.unwrap_or_else(|| anyhow!("release not found")));
        },
        None => format!("https://api.github.com/repos/{repo}/releases/latest"),
    };
    github_get_json(&url).await.with_context(|| {
        format!(
            "fetch release from {url} — publish a GitHub release with rivet-<version>-<triple>.tar.gz assets"
        )
    })
}

async fn github_get_json(url: &str) -> Result<Release> {
    let client = reqwest::Client::builder().user_agent("rivet-cli").build()?;
    let mut req = client.get(url);
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if !token.trim().is_empty() {
            req = req.bearer_auth(token.trim());
        }
    }
    let res = req.send().await.with_context(|| format!("GET {url}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("GitHub API {status}: {text}");
    }
    serde_json::from_str(&text).context("decode GitHub release JSON")
}

async fn download(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder().user_agent("rivet-cli").build()?;
    let mut req = client.get(url);
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if !token.trim().is_empty() {
            req = req.bearer_auth(token.trim());
        }
    }
    let res = req.send().await.with_context(|| format!("GET {url}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        bail!("download failed ({status}): {body}");
    }
    let bytes = res.bytes().await.context("read download body")?;
    Ok(bytes.to_vec())
}

fn pick_asset<'a>(release: &'a Release, triple: &str) -> Option<&'a Asset> {
    let ver = strip_v(&release.tag_name);
    let preferred = [
        format!("rivet-{ver}-{triple}.tar.gz"),
        format!("rivet-{ver}-{triple}.tgz"),
        format!("rivet-{ver}-{triple}.zip"),
        format!("rivet-{triple}.tar.gz"),
        format!("rivet-{triple}.tgz"),
        format!("rivet-{triple}.zip"),
    ];
    for name in &preferred {
        if let Some(a) = release.assets.iter().find(|a| &a.name == name) {
            return Some(a);
        }
    }
    // Fuzzy: contains rivet + triple + archive suffix.
    release.assets.iter().find(|a| {
        let n = a.name.to_ascii_lowercase();
        n.contains("rivet")
            && n.contains(&triple.to_ascii_lowercase())
            && (n.ends_with(".tar.gz") || n.ends_with(".tgz") || n.ends_with(".zip"))
            && !n.contains("desktop")
            && !n.contains(".dmg")
            && !n.contains(".deb")
            && !n.contains(".appimage")
            && !n.contains(".msi")
            && !n.contains(".nsis")
    })
}

fn strip_v(tag: &str) -> String {
    tag.trim().trim_start_matches('v').to_string()
}

fn unpack_tar_gz(bytes: &[u8], dest: &Path) -> Result<Vec<String>> {
    let dec = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(dec);
    let mut names = Vec::new();
    for entry in archive.entries().context("read tar entries")? {
        let mut entry = entry.context("tar entry")?;
        let path = entry.path().context("tar path")?.into_owned();
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("invalid file name in archive"))?
            .to_string();
        let Some(canonical) = canonicalize_bin_name(&file_name) else {
            continue;
        };
        let out = dest.join(&canonical);
        entry.unpack(&out).with_context(|| format!("unpack {file_name} → {canonical}"))?;
        names.push(canonical);
    }
    if names.is_empty() {
        bail!(
            "archive contained no Rivet binaries (expected rivet, rivetd, rivet-proxy, clickhouse)"
        );
    }
    Ok(names)
}

fn unpack_zip(bytes: &[u8], dest: &Path) -> Result<Vec<String>> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).context("open zip")?;
    let mut names = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("zip entry")?;
        let name = file
            .enclosed_name()
            .and_then(|p| p.file_name().map(|s| s.to_owned()))
            .ok_or_else(|| anyhow!("invalid zip entry name"))?;
        let file_name = name.to_str().ok_or_else(|| anyhow!("non-utf8 zip name"))?.to_string();
        if file.is_dir() {
            continue;
        }
        let Some(canonical) = canonicalize_bin_name(&file_name) else {
            continue;
        };
        let out = dest.join(&canonical);
        let mut out_file =
            File::create(&out).with_context(|| format!("create {}", out.display()))?;
        std::io::copy(&mut file, &mut out_file).context("write zip entry")?;
        names.push(canonical);
    }
    if names.is_empty() {
        bail!(
            "archive contained no Rivet binaries (expected rivet, rivetd, rivet-proxy, clickhouse)"
        );
    }
    Ok(names)
}

/// Map archive member names to plain install names (`rivetd`, `rivet-proxy`, …).
fn canonicalize_bin_name(name: &str) -> Option<String> {
    let base = name.trim_end_matches(".exe");
    let triple = target_triple();
    let stem = base.strip_suffix(&format!("-{triple}")).unwrap_or(base);
    let plain = match stem {
        "rivet" | "rivetd" | "rivet-proxy" | "clickhouse" => stem,
        _ => return None,
    };
    Some(exe_name(plain))
}

fn link_cli_to_user_bin(bin_dir: &Path) -> Result<Option<PathBuf>> {
    let cli_src = bin_dir.join(exe_name("rivet"));
    if !cli_src.is_file() {
        return Ok(None);
    }
    let Some(user_bin) = user_bin_dir() else {
        return Ok(None);
    };
    fs::create_dir_all(&user_bin).ok();
    let dest = user_bin.join(exe_name("rivet"));
    #[cfg(unix)]
    {
        let _ = fs::remove_file(&dest);
        match std::os::unix::fs::symlink(&cli_src, &dest) {
            Ok(()) => Ok(Some(dest)),
            Err(_) => {
                // Fall back to copy when symlink is blocked.
                fs::copy(&cli_src, &dest)
                    .with_context(|| format!("copy CLI to {}", dest.display()))?;
                Ok(Some(dest))
            },
        }
    }
    #[cfg(windows)]
    {
        let _ = fs::remove_file(&dest);
        fs::copy(&cli_src, &dest).with_context(|| format!("copy CLI to {}", dest.display()))?;
        Ok(Some(dest))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = dest;
        Ok(None)
    }
}
