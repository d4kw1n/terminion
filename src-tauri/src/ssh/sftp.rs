use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use russh::client;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tauri::ipc::Channel as EventChannel;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::Db;
use crate::models::*;
use crate::ssh::xfer::{
    collect_local, file_name_of, join_remote, safe_local_path, unique_download_path, Xfer,
};
use crate::ssh::{
    authenticate, commit_host_key, connect_ssh, host_endpoint, maybe_detect_host_os, ClientHandler,
    KnownHosts,
};

const CHUNK: usize = 64 * 1024;

struct SftpEntry {
    session: Arc<SftpSession>,
    /// Kept alive for the lifetime of the SFTP channel.
    _handle: Mutex<Option<client::Handle<ClientHandler>>>,
}

pub struct SftpManager {
    db: Arc<Db>,
    known: KnownHosts,
    app: AppHandle,
    sessions: Mutex<HashMap<String, Arc<SftpEntry>>>,
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn mode_string(permissions: Option<u32>, is_dir: bool, is_symlink: bool) -> String {
    let Some(mode) = permissions else {
        return if is_dir {
            "drwxr-xr-x".into()
        } else {
            "-rw-r--r--".into()
        };
    };
    let mut out = String::with_capacity(10);
    out.push(if is_symlink {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    });
    for shift in [6u32, 3, 0] {
        let bits = (mode >> shift) & 0o7;
        out.push(if bits & 0o4 != 0 { 'r' } else { '-' });
        out.push(if bits & 0o2 != 0 { 'w' } else { '-' });
        out.push(if bits & 0o1 != 0 { 'x' } else { '-' });
    }
    out
}

fn remote_file_from_entry(entry: russh_sftp::client::fs::DirEntry) -> RemoteFile {
    let meta = entry.metadata();
    let file_type = meta.file_type();
    let is_dir = file_type.is_dir();
    let is_symlink = file_type.is_symlink();
    RemoteFile {
        name: entry.file_name(),
        path: entry.path(),
        is_dir,
        is_symlink,
        size: meta.size.unwrap_or(0),
        modified: meta.mtime.map(|v| v as i64),
        permissions: meta.permissions,
        mode: mode_string(meta.permissions, is_dir, is_symlink),
        owner: meta.user.clone(),
        group: meta.group.clone(),
    }
}

async fn ensure_remote_dir(
    session: &SftpSession,
    path: &str,
    cache: &mut HashSet<String>,
) -> Result<(), String> {
    if path.is_empty() || path == "/" || path == "." {
        return Ok(());
    }
    let absolute = path.starts_with('/');
    let mut current = if absolute {
        String::from("/")
    } else {
        String::new()
    };
    for part in path.split('/').filter(|p| !p.is_empty() && *p != ".") {
        if !current.is_empty() && !current.ends_with('/') {
            current.push('/');
        }
        current.push_str(part);
        if cache.contains(&current) {
            continue;
        }
        if session.create_dir(&current).await.is_err() {
            let exists = session.try_exists(&current).await.unwrap_or(false);
            if !exists {
                return Err(format!("Could not create remote directory {current}"));
            }
        }
        cache.insert(current.clone());
    }
    Ok(())
}

struct RemoteItem {
    path: String,
    rel: String,
    size: u64,
}

async fn collect_remote(
    session: &SftpSession,
    roots: &[String],
) -> Result<Vec<RemoteItem>, String> {
    let mut items = Vec::new();
    for root in roots {
        let meta = session
            .symlink_metadata(root)
            .await
            .map_err(|e| format!("Could not inspect {root}: {e}"))?;
        let base = file_name_of(root);
        if meta.is_dir() && !meta.file_type().is_symlink() {
            let mut stack = vec![(root.clone(), base)];
            while let Some((dir, rel)) = stack.pop() {
                let entries = session
                    .read_dir(&dir)
                    .await
                    .map_err(|e| format!("Could not list {dir}: {e}"))?;
                for entry in entries {
                    if entry.file_type().is_symlink() {
                        continue;
                    }
                    let child_rel = format!("{rel}/{}", entry.file_name());
                    if entry.file_type().is_dir() {
                        stack.push((entry.path(), child_rel));
                    } else {
                        items.push(RemoteItem {
                            path: entry.path(),
                            rel: child_rel,
                            size: entry.metadata().size.unwrap_or(0),
                        });
                    }
                }
            }
        } else if meta.is_dir() {
            // symlinked directory: create the directory itself, do not recurse
            items.push(RemoteItem {
                path: root.clone(),
                rel: base,
                size: 0,
            });
        } else {
            items.push(RemoteItem {
                path: root.clone(),
                rel: base,
                size: meta.size.unwrap_or(0),
            });
        }
    }
    Ok(items)
}

impl SftpManager {
    pub fn new(db: Arc<Db>, known: KnownHosts, app: AppHandle) -> Self {
        Self {
            db,
            known,
            app,
            sessions: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(&self, host_id: i64) -> Result<SftpInfo, String> {
        let host = self.db.get_host(host_id)?;
        let auth = self.db.resolve_auth(host_id)?;
        let endpoint = host_endpoint(&host.hostname, host.port);
        let mut conn = connect_ssh(&host, host.keepalive_secs, self.known.clone(), None).await?;
        authenticate(&mut conn.handle, &auth, &endpoint).await?;

        let channel = conn
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Could not open an SFTP channel: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("The server does not support SFTP: {e}"))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("Could not start SFTP: {e}"))?;

        if let Some(added) = commit_host_key(&self.db, &endpoint, &conn.key_info, &self.known) {
            let _ = self.app.emit("known-host-added", added);
        }
        if host.os.is_none() {
            maybe_detect_host_os(
                host.clone(),
                auth.clone(),
                self.known.clone(),
                self.db.clone(),
                self.app.clone(),
            );
        }

        let home = session
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| "/".to_string());
        let _ = self.db.mark_host_used(host_id);

        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(
            id.clone(),
            Arc::new(SftpEntry {
                session: Arc::new(session),
                _handle: Mutex::new(Some(conn.handle)),
            }),
        );

        Ok(SftpInfo {
            id,
            home,
            endpoint,
            host_id,
        })
    }

    pub fn disconnect(&self, sftp_id: &str) {
        self.sessions.lock().unwrap().remove(sftp_id);
    }

    pub fn session_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    fn entry(&self, sftp_id: &str) -> Result<Arc<SftpEntry>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(sftp_id)
            .cloned()
            .ok_or_else(|| "The SFTP session is no longer connected".to_string())
    }

    pub async fn list_dir(&self, sftp_id: &str, path: &str) -> Result<DirListing, String> {
        let entry = self.entry(sftp_id)?;
        let target = if path.trim().is_empty() {
            entry
                .session
                .canonicalize(".")
                .await
                .map_err(|e| format!("Could not resolve the home directory: {e}"))?
        } else {
            path.to_string()
        };
        let mut entries: Vec<RemoteFile> = entry
            .session
            .read_dir(&target)
            .await
            .map_err(|e| format!("Could not open {target}: {e}"))?
            .map(remote_file_from_entry)
            .collect();
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        let total = entries.len();
        Ok(DirListing {
            path: target,
            entries,
            total,
        })
    }

    pub async fn home(&self, sftp_id: &str) -> Result<String, String> {
        let entry = self.entry(sftp_id)?;
        entry
            .session
            .canonicalize(".")
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn mkdir(&self, sftp_id: &str, path: &str) -> Result<(), String> {
        let entry = self.entry(sftp_id)?;
        entry
            .session
            .create_dir(path)
            .await
            .map_err(|e| format!("Could not create folder: {e}"))
    }

    pub async fn rename(&self, sftp_id: &str, from: &str, to: &str) -> Result<(), String> {
        let entry = self.entry(sftp_id)?;
        entry
            .session
            .rename(from, to)
            .await
            .map_err(|e| format!("Could not rename: {e}"))
    }

    pub async fn delete(&self, sftp_id: &str, path: &str, recursive: bool) -> Result<(), String> {
        let entry = self.entry(sftp_id)?;
        let meta = entry
            .session
            .symlink_metadata(path)
            .await
            .map_err(|e| format!("Could not inspect {path}: {e}"))?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return entry
                .session
                .remove_file(path)
                .await
                .map_err(|e| format!("Could not delete: {e}"));
        }
        if !recursive {
            return entry
                .session
                .remove_dir(path)
                .await
                .map_err(|e| format!("Folder is not empty: {e}"));
        }
        let mut dirs = Vec::new();
        let mut stack = vec![path.to_string()];
        while let Some(dir) = stack.pop() {
            let entries = entry
                .session
                .read_dir(&dir)
                .await
                .map_err(|e| format!("Could not list {dir}: {e}"))?;
            for item in entries {
                if item.file_type().is_dir() && !item.file_type().is_symlink() {
                    stack.push(item.path());
                } else {
                    entry
                        .session
                        .remove_file(item.path())
                        .await
                        .map_err(|e| format!("Could not delete {}: {e}", item.path()))?;
                }
            }
            dirs.push(dir);
        }
        for dir in dirs.into_iter().rev() {
            entry
                .session
                .remove_dir(&dir)
                .await
                .map_err(|e| format!("Could not delete folder {dir}: {e}"))?;
        }
        Ok(())
    }

    pub async fn chmod(&self, sftp_id: &str, path: &str, mode: u32) -> Result<(), String> {
        let entry = self.entry(sftp_id)?;
        let attrs = FileAttributes {
            permissions: Some(mode & 0o7777),
            ..Default::default()
        };
        entry
            .session
            .set_metadata(path, attrs)
            .await
            .map_err(|e| format!("Could not change permissions: {e}"))
    }

    pub async fn read_text(
        &self,
        sftp_id: &str,
        path: &str,
        max_bytes: u64,
    ) -> Result<String, String> {
        let entry = self.entry(sftp_id)?;
        let meta = entry
            .session
            .metadata(path)
            .await
            .map_err(|e| format!("Could not inspect {path}: {e}"))?;
        if meta.size.unwrap_or(0) > max_bytes {
            return Err(format!(
                "This file is larger than {} KB — open it in a terminal instead.",
                max_bytes / 1024
            ));
        }
        let bytes = entry
            .session
            .read(path)
            .await
            .map_err(|e| format!("Could not read file: {e}"))?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    pub fn register_transfer(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.transfers
            .lock()
            .unwrap()
            .insert(id.to_string(), flag.clone());
        flag
    }

    pub fn cancel_transfer(&self, id: &str) {
        if let Some(flag) = self.transfers.lock().unwrap().get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn end_transfer(&self, id: &str) {
        self.transfers.lock().unwrap().remove(id);
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upload(
        &self,
        sftp_id: &str,
        local_paths: Vec<String>,
        remote_dir: String,
        transfer_id: String,
        events: EventChannel<TransferEvent>,
    ) -> Result<TransferResult, String> {
        let entry = self.entry(sftp_id)?;
        let cancel = self.register_transfer(&transfer_id);
        let items = match collect_local(&local_paths) {
            Ok(items) => items,
            Err(e) => {
                self.end_transfer(&transfer_id);
                let _ = events.send(TransferEvent::Error { message: e.clone() });
                return Err(e);
            }
        };
        let total_bytes: u64 = items.iter().map(|i| i.2).sum();
        let total_files = items.len() as u64;
        let name = if local_paths.len() == 1 {
            file_name_of(&local_paths[0].replace('\\', "/"))
        } else {
            format!("{} items", local_paths.len())
        };
        let mut xfer = Xfer::new(
            events.clone(),
            transfer_id.clone(),
            "upload",
            name,
            total_bytes,
            total_files,
            cancel,
        );
        let mut dirs: HashSet<String> = HashSet::new();
        let mut consecutive_errors = 0;

        for (local_path, rel, _size) in items {
            if xfer.cancelled() || xfer.dead {
                break;
            }
            let remote_path = join_remote(&remote_dir, &rel);
            let parent = remote_path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            if let Err(e) = ensure_remote_dir(&entry.session, parent, &mut dirs).await {
                xfer.file_done(&rel, false, Some(e));
                consecutive_errors += 1;
                if consecutive_errors >= 3 {
                    break;
                }
                continue;
            }
            let outcome: Result<u64, String> = async {
                let mut local = tokio::fs::File::open(&local_path)
                    .await
                    .map_err(|e| format!("Could not open local file: {e}"))?;
                let mut remote = entry
                    .session
                    .open_with_flags(
                        &remote_path,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                    )
                    .await
                    .map_err(|e| format!("Could not create remote file: {e}"))?;
                let mut buf = vec![0u8; CHUNK];
                let mut written = 0u64;
                loop {
                    if xfer.cancelled() {
                        break;
                    }
                    let n = local.read(&mut buf).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    remote
                        .write_all(&buf[..n])
                        .await
                        .map_err(|e| e.to_string())?;
                    written += n as u64;
                    xfer.add(n as u64);
                    xfer.tick(&rel);
                }
                let _ = remote.shutdown().await;
                Ok(written)
            }
            .await;

            match outcome {
                Ok(_) => {
                    consecutive_errors = 0;
                    xfer.file_done(&rel, true, None);
                }
                Err(e) => {
                    consecutive_errors += 1;
                    xfer.file_done(&rel, false, Some(e));
                    if consecutive_errors >= 3 {
                        break;
                    }
                }
            }
        }

        self.end_transfer(&transfer_id);
        if xfer.cancelled() {
            let bytes = xfer.bytes;
            let files = xfer.files;
            let _ = xfer.events.send(TransferEvent::Error {
                message: "Transfer cancelled".into(),
            });
            return Ok(TransferResult { bytes, files });
        }
        Ok(xfer.finish())
    }

    pub async fn download(
        &self,
        sftp_id: &str,
        remote_paths: Vec<String>,
        local_dir: String,
        transfer_id: String,
        events: EventChannel<TransferEvent>,
    ) -> Result<TransferResult, String> {
        let entry = self.entry(sftp_id)?;
        let cancel = self.register_transfer(&transfer_id);
        let items = match collect_remote(&entry.session, &remote_paths).await {
            Ok(items) => items,
            Err(e) => {
                self.end_transfer(&transfer_id);
                let _ = events.send(TransferEvent::Error { message: e.clone() });
                return Err(e);
            }
        };
        let base_dir = match tokio::fs::canonicalize(&local_dir).await {
            Ok(path) if path.is_dir() => path,
            Ok(_) => {
                self.end_transfer(&transfer_id);
                let message = "The download destination is not a folder".to_string();
                let _ = events.send(TransferEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
            Err(e) => {
                self.end_transfer(&transfer_id);
                let message = format!("Could not open the download folder: {e}");
                let _ = events.send(TransferEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        };
        let total_bytes: u64 = items.iter().map(|i| i.size).sum();
        let total_files = items.len() as u64;
        let name = if remote_paths.len() == 1 {
            file_name_of(&remote_paths[0])
        } else {
            format!("{} items", remote_paths.len())
        };
        let mut xfer = Xfer::new(
            events.clone(),
            transfer_id.clone(),
            "download",
            name,
            total_bytes,
            total_files,
            cancel,
        );
        let mut consecutive_errors = 0;

        for item in items {
            if xfer.cancelled() || xfer.dead {
                break;
            }
            let local_path = match safe_local_path(&base_dir, &item.rel) {
                Ok(path) => unique_download_path(path),
                Err(e) => {
                    xfer.file_done(&item.rel, false, Some(e));
                    continue;
                }
            };
            let outcome: Result<u64, String> = async {
                if let Some(parent) = local_path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Could not create local folder: {e}"))?;
                }
                let mut remote = entry
                    .session
                    .open(&item.path)
                    .await
                    .map_err(|e| format!("Could not open remote file: {e}"))?;
                let mut local = tokio::fs::File::create(&local_path)
                    .await
                    .map_err(|e| format!("Could not write local file: {e}"))?;
                let mut buf = vec![0u8; CHUNK];
                let mut written = 0u64;
                loop {
                    if xfer.cancelled() {
                        break;
                    }
                    let n = remote.read(&mut buf).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    local
                        .write_all(&buf[..n])
                        .await
                        .map_err(|e| e.to_string())?;
                    written += n as u64;
                    xfer.add(n as u64);
                    xfer.tick(&item.rel);
                }
                let _ = local.flush().await;
                Ok(written)
            }
            .await;

            match outcome {
                Ok(_) => {
                    consecutive_errors = 0;
                    xfer.file_done(&item.rel, true, None);
                }
                Err(e) => {
                    consecutive_errors += 1;
                    xfer.file_done(&item.rel, false, Some(e));
                    if consecutive_errors >= 3 {
                        break;
                    }
                }
            }
        }

        self.end_transfer(&transfer_id);
        if xfer.cancelled() {
            let bytes = xfer.bytes;
            let files = xfer.files;
            let _ = xfer.events.send(TransferEvent::Error {
                message: "Transfer cancelled".into(),
            });
            return Ok(TransferResult { bytes, files });
        }
        Ok(xfer.finish())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpInfo {
    pub id: String,
    pub home: String,
    pub endpoint: String,
    pub host_id: i64,
}
