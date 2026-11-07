//! Plain FTP file browser support (RFC 959), including passive mode transfers.
//!
//! FTP is unencrypted; Terminion only offers it for legacy appliances that have
//! no SSH/SFTP support. Passwords for FTP hosts are still sealed with DPAPI at
//! rest, but the protocol itself sends them in the clear.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use suppaftp::list::{File as FtpFile, ListParser, PosixPexQuery};
use suppaftp::tokio::AsyncFtpStream;
use suppaftp::types::FileType;
use tauri::ipc::Channel as EventChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;

use crate::db::Db;
use crate::models::*;
use crate::ssh::xfer::{file_name_of, join_remote, safe_local_path, unique_download_path, Xfer};

const CHUNK: usize = 64 * 1024;

struct FtpEntry {
    stream: Arc<AsyncMutex<AsyncFtpStream>>,
}

pub struct FtpManager {
    db: Arc<Db>,
    sessions: Mutex<HashMap<String, Arc<FtpEntry>>>,
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpInfo {
    pub id: String,
    pub home: String,
    pub endpoint: String,
    pub host_id: i64,
}

fn friendly_ftp_error(context: &str, err: impl std::fmt::Display) -> String {
    let message = err.to_string();
    if message.contains("530") || message.contains("Not logged in") {
        format!("{context}: the server rejected the username or password")
    } else if message.contains("Connection refused") || message.contains("ConnectionError") {
        format!("{context}: connection refused — check the host and port")
    } else if message.contains("timed out") || message.contains("TimedOut") {
        format!("{context}: the server did not respond in time")
    } else {
        format!("{context}: {message}")
    }
}

fn file_modified(file: &FtpFile) -> Option<i64> {
    file.modified()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn pex(file: &FtpFile, who: PosixPexQuery) -> (bool, bool, bool) {
    (
        file.can_read(who),
        file.can_write(who),
        file.can_execute(who),
    )
}

fn ftp_mode(file: &FtpFile, is_dir: bool, is_symlink: bool) -> String {
    let mut out = String::with_capacity(10);
    out.push(if is_symlink {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    });
    for who in [
        PosixPexQuery::Owner,
        PosixPexQuery::Group,
        PosixPexQuery::Others,
    ] {
        let (read, write, execute) = pex(file, who);
        out.push(if read { 'r' } else { '-' });
        out.push(if write { 'w' } else { '-' });
        out.push(if execute { 'x' } else { '-' });
    }
    out
}

/// MLSD servers often advertise access through `perm=` facts instead of
/// `UNIX.mode=`. Show those honestly rather than the parser's default 0777.
fn mlsd_mode(line: &str, file: &FtpFile, is_dir: bool, is_symlink: bool) -> String {
    if line.to_ascii_lowercase().contains("unix.mode=") {
        return ftp_mode(file, is_dir, is_symlink);
    }
    let Some(perm) = line
        .split(';')
        .find_map(|fact| fact.trim().strip_prefix("perm="))
    else {
        return ftp_mode(file, is_dir, is_symlink);
    };
    let read = perm.contains('r') || (is_dir && perm.contains('l'));
    let write = perm
        .chars()
        .any(|c| matches!(c, 'w' | 'a' | 'c' | 'd' | 'f' | 'm' | 'p'));
    let execute = is_dir && perm.contains('e');
    let mut out = String::with_capacity(10);
    out.push(if is_symlink {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    });
    for _ in 0..3 {
        out.push(if read { 'r' } else { '-' });
        out.push(if write { 'w' } else { '-' });
        out.push(if execute { 'x' } else { '-' });
    }
    out
}

fn parse_ftp_line(line: &str, from_mlsd: bool) -> Option<FtpFile> {
    if from_mlsd {
        ListParser::parse_mlsd(line)
            .ok()
            .or_else(|| ListParser::parse_posix(line).ok())
    } else {
        ListParser::parse_posix(line)
            .ok()
            .or_else(|| ListParser::parse_dos(line).ok())
    }
}

async fn list_lines(ftp: &mut AsyncFtpStream) -> Result<(Vec<String>, bool), String> {
    match ftp.mlsd(None).await {
        Ok(lines) => Ok((lines, true)),
        Err(_) => ftp
            .list(None)
            .await
            .map(|lines| (lines, false))
            .map_err(|e| friendly_ftp_error("Could not list the folder", e)),
    }
}

async fn ensure_remote_dir(ftp: &mut AsyncFtpStream, path: &str) -> Result<(), String> {
    if path.is_empty() || path == "/" || path == "." {
        return Ok(());
    }
    let absolute = path.starts_with('/');
    let mut current = if absolute {
        String::from("/")
    } else {
        String::new()
    };
    let mut cache: HashSet<String> = HashSet::new();
    for part in path.split('/').filter(|p| !p.is_empty() && *p != ".") {
        if !current.is_empty() && !current.ends_with('/') {
            current.push('/');
        }
        current.push_str(part);
        if cache.contains(&current) {
            continue;
        }
        if ftp.cwd(&current).await.is_err() {
            ftp.mkdir(&current)
                .await
                .map_err(|e| friendly_ftp_error(&format!("Could not create {current}"), e))?;
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

impl FtpManager {
    pub fn new(db: Arc<Db>) -> Self {
        Self {
            db,
            sessions: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(&self, host_id: i64) -> Result<FtpInfo, String> {
        let host = self.db.get_host(host_id)?;
        if host.protocol != "ftp" {
            return Err("This host is not configured as an FTP host".into());
        }
        let auth = self.db.resolve_auth(host_id)?;
        let password = auth
            .password
            .ok_or_else(|| "This FTP host has no password saved".to_string())?;
        let endpoint = format!("{}:{}", host.hostname, host.port);

        let stream = tokio::time::timeout(
            Duration::from_secs(15),
            TcpStream::connect((host.hostname.as_str(), host.port)),
        )
        .await
        .map_err(|_| format!("Connection to {endpoint} timed out"))?
        .map_err(|e| friendly_ftp_error(&format!("Could not connect to {endpoint}"), e))?;

        let mut ftp = tokio::time::timeout(
            Duration::from_secs(20),
            AsyncFtpStream::connect_with_stream(stream),
        )
        .await
        .map_err(|_| format!("FTP handshake with {endpoint} timed out"))?
        .map_err(|e| friendly_ftp_error(&format!("FTP handshake with {endpoint} failed"), e))?;

        tokio::time::timeout(
            Duration::from_secs(20),
            ftp.login(auth.username.as_str(), password.as_str()),
        )
        .await
        .map_err(|_| "FTP login timed out".to_string())?
        .map_err(|e| friendly_ftp_error("FTP login failed", e))?;

        ftp.transfer_type(FileType::Binary)
            .await
            .map_err(|e| friendly_ftp_error("Could not switch to binary transfer mode", e))?;

        let home = ftp
            .pwd()
            .await
            .map_err(|e| friendly_ftp_error("Could not read the current directory", e))?;

        let _ = self.db.mark_host_used(host_id);
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(
            id.clone(),
            Arc::new(FtpEntry {
                stream: Arc::new(AsyncMutex::new(ftp)),
            }),
        );

        Ok(FtpInfo {
            id,
            home,
            endpoint,
            host_id,
        })
    }

    pub fn disconnect(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    fn entry(&self, id: &str) -> Result<Arc<FtpEntry>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "The FTP session is no longer connected".to_string())
    }

    pub async fn home(&self, id: &str) -> Result<String, String> {
        let entry = self.entry(id)?;
        let mut ftp = entry.stream.lock().await;
        ftp.pwd()
            .await
            .map_err(|e| friendly_ftp_error("Could not read the current directory", e))
    }

    pub async fn list_dir(&self, id: &str, path: &str) -> Result<DirListing, String> {
        let entry = self.entry(id)?;
        let mut ftp = entry.stream.lock().await;
        let target = if path.trim().is_empty() {
            ftp.pwd()
                .await
                .map_err(|e| friendly_ftp_error("Could not read the home directory", e))?
        } else {
            path.to_string()
        };
        ftp.cwd(&target)
            .await
            .map_err(|e| friendly_ftp_error(&format!("Could not open {target}"), e))?;
        let resolved = ftp
            .pwd()
            .await
            .map_err(|e| friendly_ftp_error("Could not read the current directory", e))?;

        let (lines, from_mlsd) = list_lines(&mut ftp).await?;
        let mut entries = Vec::new();
        for line in lines {
            let Some(parsed) = parse_ftp_line(&line, from_mlsd) else {
                continue;
            };
            let name = parsed.name().to_string();
            if name == "." || name == ".." || name.is_empty() {
                continue;
            }
            let is_dir = parsed.is_directory();
            let is_symlink = parsed.is_symlink();
            entries.push(RemoteFile {
                path: join_remote(&resolved, &name),
                name,
                is_dir: is_dir && !is_symlink,
                is_symlink,
                size: parsed.size() as u64,
                modified: file_modified(&parsed),
                permissions: None,
                mode: if from_mlsd {
                    mlsd_mode(&line, &parsed, is_dir, is_symlink)
                } else {
                    ftp_mode(&parsed, is_dir, is_symlink)
                },
                owner: parsed.uid().map(|id| id.to_string()),
                group: parsed.gid().map(|id| id.to_string()),
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        let total = entries.len();
        Ok(DirListing {
            path: resolved,
            entries,
            total,
        })
    }

    pub async fn mkdir(&self, id: &str, path: &str) -> Result<(), String> {
        let entry = self.entry(id)?;
        let mut ftp = entry.stream.lock().await;
        ftp.mkdir(path)
            .await
            .map_err(|e| friendly_ftp_error("Could not create the folder", e))
    }

    pub async fn rename(&self, id: &str, from: &str, to: &str) -> Result<(), String> {
        let entry = self.entry(id)?;
        let mut ftp = entry.stream.lock().await;
        ftp.rename(from, to)
            .await
            .map_err(|e| friendly_ftp_error("Could not rename the item", e))
    }

    pub async fn delete(&self, id: &str, path: &str, recursive: bool) -> Result<(), String> {
        let entry = self.entry(id)?;
        let mut ftp = entry.stream.lock().await;
        if ftp.cwd(path).await.is_err() {
            return ftp
                .rm(path)
                .await
                .map_err(|e| friendly_ftp_error("Could not delete the file", e));
        }
        if !recursive {
            return ftp
                .rmdir(path)
                .await
                .map_err(|e| friendly_ftp_error("The folder is not empty", e));
        }
        delete_dir(&mut ftp, path).await
    }

    pub async fn read_text(&self, id: &str, path: &str, max_bytes: u64) -> Result<String, String> {
        let entry = self.entry(id)?;
        let mut ftp = entry.stream.lock().await;
        if let Ok(size) = ftp.size(path).await {
            if size as u64 > max_bytes {
                return Err(format!(
                    "This file is larger than {} KB — download it instead.",
                    max_bytes / 1024
                ));
            }
        }
        let mut stream = ftp
            .retr_as_stream(path)
            .await
            .map_err(|e| friendly_ftp_error("Could not download the file", e))?;
        let mut data = Vec::new();
        let _ = (&mut stream)
            .take(max_bytes)
            .read_to_end(&mut data)
            .await
            .map_err(|e| friendly_ftp_error("Could not read the file", e))?;
        stream
            .finish()
            .await
            .map_err(|e| friendly_ftp_error("Could not finish the transfer", e))?;
        Ok(String::from_utf8_lossy(&data).to_string())
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
        id: &str,
        local_paths: Vec<String>,
        remote_dir: String,
        transfer_id: String,
        events: EventChannel<TransferEvent>,
    ) -> Result<TransferResult, String> {
        let entry = self.entry(id)?;
        let cancel = self.register_transfer(&transfer_id);
        let items = match crate::ssh::xfer::collect_local(&local_paths) {
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

        let mut ftp = entry.stream.lock().await;
        for (local_path, rel, _size) in items {
            if xfer.cancelled() || xfer.dead {
                break;
            }
            let remote_path = join_remote(&remote_dir, &rel);
            let parent = remote_path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            if let Err(e) = ensure_remote_dir(&mut ftp, parent).await {
                xfer.file_done(&rel, false, Some(e));
                continue;
            }
            let outcome: Result<(), String> = async {
                let mut local = tokio::fs::File::open(&local_path)
                    .await
                    .map_err(|e| format!("Could not open local file: {e}"))?;
                let mut stream = ftp
                    .put_with_stream(&remote_path)
                    .await
                    .map_err(|e| friendly_ftp_error("Could not create the remote file", e))?;
                let mut buf = vec![0u8; CHUNK];
                loop {
                    if xfer.cancelled() {
                        break;
                    }
                    let n = local.read(&mut buf).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    stream
                        .write_all(&buf[..n])
                        .await
                        .map_err(|e| format!("Upload failed: {e}"))?;
                    xfer.add(n as u64);
                    xfer.tick(&rel);
                }
                stream
                    .finish()
                    .await
                    .map_err(|e| format!("Could not finish the upload: {e}"))?;
                Ok(())
            }
            .await;

            match outcome {
                Ok(()) => {
                    xfer.file_done(&rel, true, None);
                }
                Err(e) => {
                    xfer.file_done(&rel, false, Some(e));
                    break;
                }
            }
        }
        drop(ftp);
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
        id: &str,
        remote_paths: Vec<String>,
        local_dir: String,
        transfer_id: String,
        events: EventChannel<TransferEvent>,
    ) -> Result<TransferResult, String> {
        let entry = self.entry(id)?;
        let cancel = self.register_transfer(&transfer_id);
        let items = {
            let mut ftp = entry.stream.lock().await;
            match collect_remote(&mut ftp, &remote_paths).await {
                Ok(items) => items,
                Err(e) => {
                    drop(ftp);
                    self.end_transfer(&transfer_id);
                    let _ = events.send(TransferEvent::Error { message: e.clone() });
                    return Err(e);
                }
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

        let mut ftp = entry.stream.lock().await;
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
            let outcome: Result<(), String> = async {
                if let Some(parent) = local_path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Could not create local folder: {e}"))?;
                }
                let mut stream = ftp
                    .retr_as_stream(&item.path)
                    .await
                    .map_err(|e| friendly_ftp_error("Could not open the remote file", e))?;
                let mut local = tokio::fs::File::create(&local_path)
                    .await
                    .map_err(|e| format!("Could not write local file: {e}"))?;
                let mut buf = vec![0u8; CHUNK];
                loop {
                    if xfer.cancelled() {
                        break;
                    }
                    let n = stream
                        .read(&mut buf)
                        .await
                        .map_err(|e| format!("Download failed: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    local
                        .write_all(&buf[..n])
                        .await
                        .map_err(|e| format!("Could not write local file: {e}"))?;
                    xfer.add(n as u64);
                    xfer.tick(&item.rel);
                }
                stream
                    .finish()
                    .await
                    .map_err(|e| format!("Could not finish the download: {e}"))?;
                let _ = local.flush().await;
                Ok(())
            }
            .await;
            match outcome {
                Ok(()) => xfer.file_done(&item.rel, true, None),
                Err(e) => {
                    xfer.file_done(&item.rel, false, Some(e));
                    break;
                }
            }
        }
        drop(ftp);
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

async fn delete_dir(ftp: &mut AsyncFtpStream, path: &str) -> Result<(), String> {
    let entries = {
        ftp.cwd(path)
            .await
            .map_err(|e| friendly_ftp_error(&format!("Could not open {path}"), e))?;
        let (lines, from_mlsd) = list_lines(ftp).await?;
        let mut entries = Vec::new();
        for line in lines {
            if let Some(parsed) = parse_ftp_line(&line, from_mlsd) {
                let name = parsed.name().to_string();
                if name != "." && name != ".." {
                    entries.push((name, parsed.is_directory(), parsed.is_symlink()));
                }
            }
        }
        entries
    };
    for (name, is_dir, is_symlink) in entries {
        let child = join_remote(path, &name);
        if is_dir && !is_symlink {
            Box::pin(delete_dir(ftp, &child)).await?;
        } else {
            ftp.rm(&child)
                .await
                .map_err(|e| friendly_ftp_error(&format!("Could not delete {name}"), e))?;
        }
    }
    ftp.rmdir(path)
        .await
        .map_err(|e| friendly_ftp_error(&format!("Could not remove {path}"), e))
}

async fn collect_remote(
    ftp: &mut AsyncFtpStream,
    roots: &[String],
) -> Result<Vec<RemoteItem>, String> {
    let mut items = Vec::new();
    for root in roots {
        let base = file_name_of(root);
        if ftp.cwd(root).await.is_ok() {
            let mut stack = vec![(root.clone(), base)];
            while let Some((dir, rel)) = stack.pop() {
                ftp.cwd(&dir)
                    .await
                    .map_err(|e| friendly_ftp_error(&format!("Could not open {dir}"), e))?;
                let (lines, from_mlsd) = list_lines(ftp).await?;
                for line in lines {
                    let Some(parsed) = parse_ftp_line(&line, from_mlsd) else {
                        continue;
                    };
                    let name = parsed.name().to_string();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let child_rel = format!("{rel}/{name}");
                    let child_path = join_remote(&dir, &name);
                    if parsed.is_directory() && !parsed.is_symlink() {
                        stack.push((child_path, child_rel));
                    } else {
                        items.push(RemoteItem {
                            path: child_path,
                            rel: child_rel,
                            size: parsed.size() as u64,
                        });
                    }
                }
            }
        } else {
            let size = ftp.size(root).await.unwrap_or(0) as u64;
            items.push(RemoteItem {
                path: root.clone(),
                rel: base,
                size,
            });
        }
    }
    Ok(items)
}
