use std::path::PathBuf;

use russh::keys::ssh_key::LineEnding;
use russh::keys::{decode_secret_key, Algorithm, HashAlg, PrivateKey};
use tauri::ipc::Channel;
use tauri::State;

use crate::db::Db;
use crate::models::*;
use crate::ssh::ftp::FtpInfo;
use crate::ssh::sftp::SftpInfo;
use crate::ssh::terminal::SessionCommand;
use crate::sysmon::ProcessStats;
use crate::AppState;

// ------------------------------ hosts/groups ------------------------------

#[tauri::command]
pub fn list_hosts(state: State<'_, AppState>) -> Result<Vec<Host>, String> {
    state.db.list_hosts()
}

#[tauri::command]
pub fn get_host(state: State<'_, AppState>, id: i64) -> Result<Host, String> {
    state.db.get_host(id)
}

#[tauri::command]
pub fn save_host(state: State<'_, AppState>, input: HostInput) -> Result<Host, String> {
    state.db.save_host(input)
}

#[tauri::command]
pub fn delete_host(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.db.delete_host(id)
}

#[tauri::command]
pub fn set_host_favorite(
    state: State<'_, AppState>,
    id: i64,
    favorite: bool,
) -> Result<(), String> {
    state.db.set_host_favorite(id, favorite)
}

#[tauri::command]
pub fn list_groups(state: State<'_, AppState>) -> Result<Vec<Group>, String> {
    state.db.list_groups()
}

#[tauri::command]
pub fn save_group(state: State<'_, AppState>, input: GroupInput) -> Result<Group, String> {
    state.db.save_group(input)
}

#[tauri::command]
pub fn delete_group(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.db.delete_group(id)
}

#[derive(Default)]
struct SshBlock {
    aliases: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity: Option<String>,
}

fn parse_ssh_config(text: &str) -> Vec<SshBlock> {
    let mut blocks: Vec<SshBlock> = Vec::new();
    let mut current: Option<SshBlock> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        let value = parts.next().unwrap_or("").trim().trim_matches('"');
        match key.as_str() {
            "host" => {
                if let Some(block) = current.take() {
                    blocks.push(block);
                }
                let aliases = value
                    .split_whitespace()
                    .filter(|a| !a.contains('*') && !a.contains('?') && !a.starts_with('!'))
                    .map(|a| a.to_string())
                    .collect::<Vec<_>>();
                if !aliases.is_empty() {
                    current = Some(SshBlock {
                        aliases,
                        ..Default::default()
                    });
                }
            }
            "hostname" => {
                if let Some(block) = current.as_mut() {
                    block.hostname = Some(value.to_string());
                }
            }
            "user" => {
                if let Some(block) = current.as_mut() {
                    block.user = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(block) = current.as_mut() {
                    block.port = value.parse().ok();
                }
            }
            "identityfile" => {
                if let Some(block) = current.as_mut() {
                    block.identity = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    if let Some(block) = current {
        blocks.push(block);
    }
    blocks
}

fn expand_tilde(value: &str, home: &std::path::Path) -> PathBuf {
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        PathBuf::from(value)
    }
}

fn key_metadata(pem: &str, passphrase: Option<&str>) -> Result<(String, String, String), String> {
    let key = decode_secret_key(pem, passphrase).map_err(|e| e.to_string())?;
    let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    Ok((key.algorithm().to_string(), public, fingerprint))
}

#[tauri::command]
pub fn import_ssh_config(state: State<'_, AppState>) -> Result<ImportResult, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not locate your home directory".to_string())?;
    let config_path = home.join(".ssh").join("config");
    if !config_path.exists() {
        return Err(format!("No SSH config found at {}", config_path.display()));
    }
    let text = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Could not read {}: {e}", config_path.display()))?;
    let blocks = parse_ssh_config(&text);
    let mut existing_hosts = state.db.list_hosts()?;
    let mut existing_keys = state.db.list_keys()?;

    let mut group_id = state
        .db
        .list_groups()?
        .into_iter()
        .find(|g| g.name == "SSH Config")
        .map(|g| g.id);
    let mut imported_hosts = Vec::new();
    let mut skipped = 0usize;
    let mut keys_added = 0usize;

    for block in blocks {
        let alias = block.aliases.first().cloned().unwrap_or_default();
        let hostname = block.hostname.clone().unwrap_or_else(|| alias.clone());
        let username = block
            .user
            .clone()
            .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "root".into()));
        let port = block.port.unwrap_or(22);
        if existing_hosts.iter().any(|h| {
            h.hostname.eq_ignore_ascii_case(&hostname) && h.username == username && h.port == port
        }) {
            skipped += 1;
            continue;
        }

        let mut key_id = None;
        if let Some(identity) = block.identity.as_deref() {
            let path = expand_tilde(identity, &home);
            let path = if path.is_absolute() {
                path
            } else {
                home.join(".ssh").join(path)
            };
            if let Ok(pem) = std::fs::read_to_string(&path) {
                if let Ok((key_type, public, fingerprint)) = key_metadata(&pem, None) {
                    if let Some(existing) =
                        existing_keys.iter().find(|k| k.fingerprint == fingerprint)
                    {
                        key_id = Some(existing.id);
                    } else {
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| "imported-key".into());
                        if let Ok(entry) = state.db.insert_key(
                            &name,
                            &key_type,
                            &public,
                            &fingerprint,
                            &pem,
                            None,
                            Some("Imported from ~/.ssh/config"),
                        ) {
                            key_id = Some(entry.id);
                            keys_added += 1;
                            existing_keys.push(entry);
                        }
                    }
                }
            }
        }

        if group_id.is_none() {
            group_id = Some(
                state
                    .db
                    .save_group(GroupInput {
                        id: None,
                        name: "SSH Config".into(),
                        color: Some("#7c5cff".into()),
                        sort: Some(0),
                    })?
                    .id,
            );
        }

        let host = state.db.save_host(HostInput {
            id: None,
            label: alias.clone(),
            hostname: hostname.clone(),
            port,
            username,
            protocol: Some("ssh".into()),
            auth_type: if key_id.is_some() {
                "key".into()
            } else {
                "password".into()
            },
            password: None,
            key_id,
            group_id,
            tags: Some(vec!["imported".into()]),
            color: None,
            favorite: None,
            startup_command: None,
            keepalive_secs: None,
            auto_reconnect: None,
        })?;
        existing_hosts.push(host.clone());
        imported_hosts.push(host);
    }

    Ok(ImportResult {
        imported: imported_hosts.len(),
        skipped,
        keys_added,
        hosts: imported_hosts,
        config_path: config_path.display().to_string(),
    })
}

// --------------------------------- keys ---------------------------------

#[tauri::command]
pub fn list_keys(state: State<'_, AppState>) -> Result<Vec<KeyEntry>, String> {
    state.db.list_keys()
}

fn store_key_pair(
    db: &Db,
    name: &str,
    private_pem: &str,
    passphrase: Option<&str>,
    comment: Option<&str>,
) -> Result<KeyEntry, String> {
    let (key_type, public, fingerprint) = key_metadata(private_pem, passphrase)?;
    let display_name = if name.trim().is_empty() {
        format!(
            "{} • {}",
            key_type,
            &fingerprint[..fingerprint.len().min(20)]
        )
    } else {
        name.trim().to_string()
    };
    db.insert_key(
        &display_name,
        &key_type,
        &public,
        &fingerprint,
        private_pem,
        passphrase,
        comment,
    )
}

#[tauri::command]
pub fn generate_key(
    state: State<'_, AppState>,
    name: String,
    comment: Option<String>,
    passphrase: Option<String>,
) -> Result<KeyEntry, String> {
    let mut rng = rand::rng();
    let key = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|e| format!("Could not generate key: {e}"))?;
    let pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| e.to_string())?
        .to_string();
    store_key_pair(
        &state.db,
        &name,
        &pem,
        passphrase.as_deref().filter(|p| !p.is_empty()),
        comment.as_deref(),
    )
}

#[tauri::command]
pub fn import_key(
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    passphrase: Option<String>,
) -> Result<KeyEntry, String> {
    let pem = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let default_name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Imported key".into());
    store_key_pair(
        &state.db,
        name.as_deref().unwrap_or(&default_name),
        &pem,
        passphrase.as_deref().filter(|p| !p.is_empty()),
        None,
    )
}

#[tauri::command]
pub fn import_key_text(
    state: State<'_, AppState>,
    name: String,
    private_key: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<KeyEntry, String> {
    store_key_pair(
        &state.db,
        &name,
        &private_key,
        passphrase.as_deref().filter(|p| !p.is_empty()),
        comment.as_deref(),
    )
}

#[tauri::command]
pub fn delete_key(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.db.delete_key(id)
}

// ------------------------------- snippets -------------------------------

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    state.db.list_snippets()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, input: SnippetInput) -> Result<Snippet, String> {
    state.db.save_snippet(input)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.db.delete_snippet(id)
}

// ------------------------------ known hosts ------------------------------

#[tauri::command]
pub fn list_known_hosts(state: State<'_, AppState>) -> Result<Vec<KnownHostEntry>, String> {
    state.db.list_known_hosts()
}

#[tauri::command]
pub fn delete_known_host(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let endpoint = state
        .db
        .list_known_hosts()?
        .into_iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.endpoint);
    state.db.delete_known_host(id)?;
    if let Some(endpoint) = endpoint {
        state.known.lock().unwrap().remove(&endpoint);
    }
    Ok(())
}

// ------------------------------- forwards -------------------------------

#[tauri::command]
pub fn list_forwards(state: State<'_, AppState>) -> Result<Vec<PortForward>, String> {
    state.db.list_forwards()
}

#[tauri::command]
pub fn list_running_forwards(state: State<'_, AppState>) -> Result<Vec<RunningForward>, String> {
    Ok(state
        .forwards
        .running_map()
        .into_iter()
        .map(|(id, bound_port)| RunningForward { id, bound_port })
        .collect())
}

#[tauri::command]
pub fn save_forward(
    state: State<'_, AppState>,
    input: PortForwardInput,
) -> Result<PortForward, String> {
    let existing_id = input.id;
    let saved = state.db.save_forward(input)?;
    if let Some(id) = existing_id {
        if state.forwards.is_running(id) {
            state.forwards.stop(id);
        }
    }
    let _ = saved.clone();
    Ok(saved)
}

#[tauri::command]
pub fn delete_forward(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.forwards.stop(id);
    state.db.delete_forward(id)
}

#[tauri::command]
pub async fn start_forward(state: State<'_, AppState>, id: i64) -> Result<u16, String> {
    let forwards = state.forwards.clone();
    forwards.start(id).await
}

#[tauri::command]
pub fn stop_forward(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.forwards.stop(id);
    Ok(())
}

// ------------------------------- terminal -------------------------------

#[tauri::command]
pub fn open_terminal(
    state: State<'_, AppState>,
    host_id: i64,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<String, String> {
    state.terminals.open(host_id, cols, rows, on_event)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state
        .terminals
        .send(&session_id, SessionCommand::Write(data.into_bytes()))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminals.send(
        &session_id,
        SessionCommand::Resize(cols as u32, rows as u32),
    )
}

#[tauri::command]
pub fn terminal_reconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.terminals.send(&session_id, SessionCommand::Reconnect)
}

#[tauri::command]
pub fn terminal_probe(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.terminals.send(&session_id, SessionCommand::Probe)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .terminals
        .send(&session_id, SessionCommand::Disconnect)
}

#[tauri::command]
pub fn terminal_run(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<(), String> {
    let mut bytes = command.into_bytes();
    bytes.push(b'\r');
    state
        .terminals
        .send(&session_id, SessionCommand::Write(bytes))
}

// --------------------------------- sftp ---------------------------------

#[tauri::command]
pub async fn sftp_connect(state: State<'_, AppState>, host_id: i64) -> Result<SftpInfo, String> {
    let sftp = state.sftp.clone();
    sftp.connect(host_id).await
}

#[tauri::command]
pub fn sftp_disconnect(state: State<'_, AppState>, sftp_id: String) {
    state.sftp.disconnect(&sftp_id);
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<DirListing, String> {
    let sftp = state.sftp.clone();
    sftp.list_dir(&sftp_id, &path).await
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, sftp_id: String) -> Result<String, String> {
    let sftp = state.sftp.clone();
    sftp.home(&sftp_id).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = state.sftp.clone();
    sftp.mkdir(&sftp_id, &path).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    sftp_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = state.sftp.clone();
    sftp.rename(&sftp_id, &from, &to).await
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    let sftp = state.sftp.clone();
    sftp.delete(&sftp_id, &path, recursive).await
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let sftp = state.sftp.clone();
    sftp.chmod(&sftp_id, &path, mode).await
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let sftp = state.sftp.clone();
    sftp.read_text(&sftp_id, &path, max_bytes.unwrap_or(512 * 1024))
        .await
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    sftp_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_id: String,
    on_event: Channel<TransferEvent>,
) -> Result<TransferResult, String> {
    let sftp = state.sftp.clone();
    sftp.upload(&sftp_id, local_paths, remote_dir, transfer_id, on_event)
        .await
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    sftp_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    transfer_id: String,
    on_event: Channel<TransferEvent>,
) -> Result<TransferResult, String> {
    let sftp = state.sftp.clone();
    sftp.download(&sftp_id, remote_paths, local_dir, transfer_id, on_event)
        .await
}

#[tauri::command]
pub fn sftp_cancel_transfer(state: State<'_, AppState>, transfer_id: String) {
    state.sftp.cancel_transfer(&transfer_id);
}

// ---------------------------------- ftp ----------------------------------

#[tauri::command]
pub async fn ftp_connect(state: State<'_, AppState>, host_id: i64) -> Result<FtpInfo, String> {
    let ftp = state.ftp.clone();
    ftp.connect(host_id).await
}

#[tauri::command]
pub fn ftp_disconnect(state: State<'_, AppState>, ftp_id: String) {
    state.ftp.disconnect(&ftp_id);
}

#[tauri::command]
pub async fn ftp_list_dir(
    state: State<'_, AppState>,
    ftp_id: String,
    path: String,
) -> Result<DirListing, String> {
    let ftp = state.ftp.clone();
    ftp.list_dir(&ftp_id, &path).await
}

#[tauri::command]
pub async fn ftp_home(state: State<'_, AppState>, ftp_id: String) -> Result<String, String> {
    let ftp = state.ftp.clone();
    ftp.home(&ftp_id).await
}

#[tauri::command]
pub async fn ftp_mkdir(
    state: State<'_, AppState>,
    ftp_id: String,
    path: String,
) -> Result<(), String> {
    let ftp = state.ftp.clone();
    ftp.mkdir(&ftp_id, &path).await
}

#[tauri::command]
pub async fn ftp_rename(
    state: State<'_, AppState>,
    ftp_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let ftp = state.ftp.clone();
    ftp.rename(&ftp_id, &from, &to).await
}

#[tauri::command]
pub async fn ftp_delete(
    state: State<'_, AppState>,
    ftp_id: String,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    let ftp = state.ftp.clone();
    ftp.delete(&ftp_id, &path, recursive).await
}

#[tauri::command]
pub async fn ftp_read_text(
    state: State<'_, AppState>,
    ftp_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let ftp = state.ftp.clone();
    ftp.read_text(&ftp_id, &path, max_bytes.unwrap_or(512 * 1024))
        .await
}

#[tauri::command]
pub async fn ftp_upload(
    state: State<'_, AppState>,
    ftp_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_id: String,
    on_event: Channel<TransferEvent>,
) -> Result<TransferResult, String> {
    let ftp = state.ftp.clone();
    ftp.upload(&ftp_id, local_paths, remote_dir, transfer_id, on_event)
        .await
}

#[tauri::command]
pub async fn ftp_download(
    state: State<'_, AppState>,
    ftp_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    transfer_id: String,
    on_event: Channel<TransferEvent>,
) -> Result<TransferResult, String> {
    let ftp = state.ftp.clone();
    ftp.download(&ftp_id, remote_paths, local_dir, transfer_id, on_event)
        .await
}

#[tauri::command]
pub fn ftp_cancel_transfer(state: State<'_, AppState>, transfer_id: String) {
    state.ftp.cancel_transfer(&transfer_id);
}

// ------------------------------- settings -------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state.db.get_settings()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    state.db.save_settings(&settings)
}

#[tauri::command]
pub fn get_paths(state: State<'_, AppState>) -> Result<Paths, String> {
    let home = dirs::home_dir().unwrap_or_default();
    Ok(Paths {
        home: home.display().to_string(),
        downloads: dirs::download_dir()
            .unwrap_or_else(|| home.join("Downloads"))
            .display()
            .to_string(),
        data_dir: state.data_dir.display().to_string(),
        ssh_dir: home.join(".ssh").display().to_string(),
    })
}

#[tauri::command]
pub fn get_app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: state.data_dir.display().to_string(),
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

#[cfg(windows)]
fn explorer_exe() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("explorer.exe")
}

#[tauri::command]
pub fn process_stats(state: State<'_, AppState>) -> ProcessStats {
    state.monitor.sample()
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("{path} does not exist"));
    }
    #[cfg(windows)]
    {
        let arg = format!("/select,{}", target.display());
        std::process::Command::new(explorer_exe())
            .arg(arg)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new(explorer_exe())
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
