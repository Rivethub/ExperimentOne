use anyhow::{Context, Result};
use camino::{Utf8Path, Utf8PathBuf};

/// On-disk layout under Application Support (macOS) / XDG (others).
#[derive(Debug, Clone)]
pub struct RivetPaths {
    pub root: Utf8PathBuf,
}

impl RivetPaths {
    pub fn discover() -> Result<Self> {
        let base = dirs::data_dir().context("no data dir")?;
        let root = Utf8PathBuf::from_path_buf(base.join("Rivet"))
            .map_err(|_| anyhow::anyhow!("data dir is not utf-8"))?;
        Ok(Self { root })
    }

    pub fn ensure(&self) -> Result<()> {
        for p in [
            self.root.as_std_path(),
            self.clickhouse_dir().as_std_path(),
            self.clickhouse_data_dir().as_std_path(),
            self.clickhouse_tmp_dir().as_std_path(),
            self.clickhouse_user_files_dir().as_std_path(),
            self.clickhouse_log_dir().as_std_path(),
            self.blobs_dir().as_std_path(),
            self.proxy_dir().as_std_path(),
            self.proxy_auth_dir().as_std_path(),
            self.proxy_logs_dir().as_std_path(),
            self.exports_dir().as_std_path(),
            self.wiki_dir().as_std_path(),
            self.harness_claude_dir().as_std_path(),
            self.harness_codex_dir().as_std_path(),
        ] {
            std::fs::create_dir_all(p)?;
        }
        Ok(())
    }

    pub fn config_file(&self) -> Utf8PathBuf {
        self.root.join("config.json")
    }

    pub fn sqlite_file(&self) -> Utf8PathBuf {
        self.root.join("rivet.sqlite")
    }

    pub fn clickhouse_dir(&self) -> Utf8PathBuf {
        self.root.join("clickhouse")
    }

    pub fn clickhouse_data_dir(&self) -> Utf8PathBuf {
        self.clickhouse_dir().join("data")
    }

    pub fn clickhouse_tmp_dir(&self) -> Utf8PathBuf {
        self.clickhouse_dir().join("tmp")
    }

    pub fn clickhouse_user_files_dir(&self) -> Utf8PathBuf {
        self.clickhouse_dir().join("user_files")
    }

    pub fn clickhouse_log_dir(&self) -> Utf8PathBuf {
        self.clickhouse_dir().join("logs")
    }

    pub fn clickhouse_config_file(&self) -> Utf8PathBuf {
        self.clickhouse_dir().join("config.xml")
    }

    pub fn blobs_dir(&self) -> Utf8PathBuf {
        self.root.join("blobs")
    }

    pub fn proxy_dir(&self) -> Utf8PathBuf {
        self.root.join("proxy")
    }

    pub fn proxy_config_file(&self) -> Utf8PathBuf {
        self.proxy_dir().join("config.yaml")
    }

    pub fn proxy_auth_dir(&self) -> Utf8PathBuf {
        self.proxy_dir().join("auth")
    }

    pub fn proxy_logs_dir(&self) -> Utf8PathBuf {
        self.proxy_dir().join("logs")
    }

    pub fn exports_dir(&self) -> Utf8PathBuf {
        self.root.join("exports")
    }

    pub fn wiki_dir(&self) -> Utf8PathBuf {
        self.root.join("wiki")
    }

    /// Isolated Claude Code config dir — set `CLAUDE_CONFIG_DIR` to this path.
    pub fn harness_claude_dir(&self) -> Utf8PathBuf {
        self.root.join("harness").join("claude")
    }

    /// Isolated Codex home — set `CODEX_HOME` to this path.
    pub fn harness_codex_dir(&self) -> Utf8PathBuf {
        self.root.join("harness").join("codex")
    }

    pub fn ingest_sock(&self) -> Utf8PathBuf {
        self.root.join("ingest.sock")
    }

    pub fn as_root(&self) -> &Utf8Path {
        &self.root
    }
}
