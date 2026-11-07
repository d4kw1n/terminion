use serde::{Deserialize, Serialize};

pub type DbResult<T> = Result<T, String>;

pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub sort: i64,
    pub host_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub id: Option<i64>,
    pub name: String,
    pub color: Option<String>,
    pub sort: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: i64,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    /// `ssh` or `ftp`
    pub protocol: String,
    /// Detected OS/distro, filled after the first successful SSH connection.
    pub os: Option<String>,
    pub auth_type: String,
    pub has_password: bool,
    pub key_id: Option<i64>,
    pub group_id: Option<i64>,
    pub tags: Vec<String>,
    pub color: Option<String>,
    pub favorite: bool,
    pub startup_command: Option<String>,
    pub keepalive_secs: u32,
    pub auto_reconnect: bool,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub id: Option<i64>,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    /// `ssh` or `ftp`
    pub protocol: Option<String>,
    pub auth_type: String,
    /// `None` keeps the stored password, `Some("")` clears it.
    pub password: Option<String>,
    pub key_id: Option<i64>,
    pub group_id: Option<i64>,
    pub tags: Option<Vec<String>>,
    pub color: Option<String>,
    pub favorite: Option<bool>,
    pub startup_command: Option<String>,
    pub keepalive_secs: Option<u32>,
    pub auto_reconnect: Option<bool>,
}

/// Everything needed to authenticate. Stays inside the backend.
#[derive(Debug, Clone)]
pub struct ResolvedAuth {
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: String,
    pub public_key: String,
    pub fingerprint: String,
    pub comment: Option<String>,
    pub has_passphrase: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: i64,
    pub label: String,
    pub command: String,
    pub tags: Vec<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub id: Option<i64>,
    pub label: String,
    pub command: String,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub id: i64,
    pub endpoint: String,
    pub key_type: String,
    pub fingerprint: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: i64,
    pub host_id: i64,
    pub label: String,
    pub kind: String,
    pub listen_host: String,
    pub listen_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub auto_start: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInput {
    pub id: Option<i64>,
    pub host_id: i64,
    pub label: String,
    pub kind: String,
    pub listen_host: String,
    pub listen_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub auto_start: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub accent: String,
    pub terminal_theme: String,
    pub font_family: String,
    pub font_size: u32,
    pub scrollback: u32,
    pub cursor_style: String,
    pub keepalive_secs: u32,
    pub auto_reconnect: bool,
    pub copy_on_select: bool,
    pub confirm_close: bool,
    pub renderer: String,
    pub bell: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent: "violet".into(),
            terminal_theme: "terminion".into(),
            font_family: "Cascadia Mono, JetBrains Mono, Consolas, monospace".into(),
            font_size: 14,
            scrollback: 10_000,
            cursor_style: "bar".into(),
            keepalive_secs: 20,
            auto_reconnect: true,
            copy_on_select: false,
            confirm_close: true,
            renderer: "auto".into(),
            bell: false,
        }
    }
}

// ---------- terminal events ----------

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum TerminalEvent {
    Status {
        status: String,
        detail: Option<String>,
        attempt: Option<u32>,
    },
    Data {
        /// base64 encoded raw terminal output
        data: String,
    },
    Connected {
        fingerprint: String,
        key_type: String,
        new_host_key: bool,
        reused: bool,
    },
    Reconnecting {
        attempt: u32,
        delay_ms: u64,
        reason: String,
    },
    Disconnected {
        reason: String,
        code: Option<u32>,
        reconnecting: bool,
    },
    AuthFailed {
        message: String,
    },
}

// ---------- sftp ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub permissions: Option<u32>,
    pub mode: String,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<RemoteFile>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum TransferEvent {
    Started {
        transfer_id: String,
        name: String,
        total_bytes: u64,
        total_files: u64,
        direction: String,
    },
    Progress {
        percent: f64,
        bytes: u64,
        total_bytes: u64,
        files: u64,
        total_files: u64,
        current: String,
        speed: u64,
    },
    FileDone {
        path: String,
        ok: bool,
        error: Option<String>,
    },
    Done {
        bytes: u64,
        files: u64,
        duration_ms: u64,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatusEvent {
    pub id: i64,
    pub running: bool,
    pub error: Option<String>,
    pub bound_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningForward {
    pub id: i64,
    pub bound_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub keys_added: usize,
    pub hosts: Vec<Host>,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub home: String,
    pub downloads: String,
    pub data_dir: String,
    pub ssh_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOsDetected {
    pub host_id: i64,
    pub os: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostAdded {
    pub endpoint: String,
    pub fingerprint: String,
    pub key_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub platform: String,
}
