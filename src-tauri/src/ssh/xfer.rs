//! Shared transfer progress and path helpers used by the SFTP and FTP managers.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::ipc::Channel as EventChannel;

use crate::models::{TransferEvent, TransferResult};

pub(crate) struct Xfer {
    pub(crate) events: EventChannel<TransferEvent>,
    pub(crate) total_bytes: u64,
    pub(crate) total_files: u64,
    pub(crate) bytes: u64,
    pub(crate) files: u64,
    started: Instant,
    last_emit: Instant,
    cancel: Arc<AtomicBool>,
    pub(crate) dead: bool,
}

impl Xfer {
    pub(crate) fn new(
        events: EventChannel<TransferEvent>,
        id: String,
        direction: &str,
        name: String,
        total_bytes: u64,
        total_files: u64,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        let _ = events.send(TransferEvent::Started {
            transfer_id: id,
            name,
            total_bytes,
            total_files,
            direction: direction.to_string(),
        });
        Self {
            events,
            total_bytes,
            total_files,
            bytes: 0,
            files: 0,
            started: Instant::now(),
            last_emit: Instant::now(),
            cancel,
            dead: false,
        }
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub(crate) fn add(&mut self, bytes: u64) {
        self.bytes += bytes;
    }

    pub(crate) fn tick(&mut self, current: &str) {
        if self.last_emit.elapsed() < Duration::from_millis(120) && self.bytes < self.total_bytes {
            return;
        }
        self.last_emit = Instant::now();
        let elapsed = self.started.elapsed().as_secs_f64().max(0.001);
        let percent = if self.total_bytes == 0 {
            100.0
        } else {
            (self.bytes as f64 / self.total_bytes as f64 * 100.0).min(100.0)
        };
        if self
            .events
            .send(TransferEvent::Progress {
                percent,
                bytes: self.bytes,
                total_bytes: self.total_bytes,
                files: self.files,
                total_files: self.total_files,
                current: current.to_string(),
                speed: (self.bytes as f64 / elapsed) as u64,
            })
            .is_err()
        {
            self.dead = true;
        }
    }

    pub(crate) fn file_done(&mut self, path: &str, ok: bool, error: Option<String>) {
        self.files += 1;
        let _ = self.events.send(TransferEvent::FileDone {
            path: path.to_string(),
            ok,
            error,
        });
    }

    pub(crate) fn finish(self) -> TransferResult {
        let _ = self.events.send(TransferEvent::Done {
            bytes: self.bytes,
            files: self.files,
            duration_ms: self.started.elapsed().as_millis() as u64,
        });
        TransferResult {
            bytes: self.bytes,
            files: self.files,
        }
    }
}

pub(crate) fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!(
            "{}/{}",
            dir.trim_end_matches('/'),
            name.trim_start_matches('/')
        )
    }
}

pub(crate) fn file_name_of(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

/// Flattens local files (recursively) into `(absolute path, relative name, size)`.
pub(crate) fn collect_local(paths: &[String]) -> Result<Vec<(PathBuf, String, u64)>, String> {
    let mut items = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw);
        let meta =
            std::fs::symlink_metadata(&path).map_err(|e| format!("Could not read {raw}: {e}"))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            items.push((
                path.clone(),
                path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file".into()),
                meta.len(),
            ));
        } else if meta.is_dir() {
            let root_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "folder".into());
            let mut stack = vec![(path.clone(), root_name)];
            while let Some((dir, rel)) = stack.pop() {
                let entries = std::fs::read_dir(&dir)
                    .map_err(|e| format!("Could not read {}: {e}", dir.display()))?;
                for entry in entries.flatten() {
                    let Ok(ft) = entry.file_type() else { continue };
                    if ft.is_symlink() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    let child_rel = format!("{rel}/{name}");
                    if ft.is_dir() {
                        stack.push((entry.path(), child_rel));
                    } else if ft.is_file() {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        items.push((entry.path(), child_rel, size));
                    }
                }
            }
        }
    }
    Ok(items)
}

/// Make a server-supplied relative path safe to join under a local download
/// directory. Windows treats both `/` and `\` as separators, and a component
/// such as `C:` or `\\server\share` can escape the destination altogether.
pub(crate) fn sanitize_rel(rel: &str) -> String {
    rel.split(['/', '\\'])
        .filter_map(sanitize_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn sanitize_component(raw: &str) -> Option<String> {
    let mut part = raw.trim_matches('\0');
    if cfg!(windows) {
        part = part.trim_end_matches([' ', '.']);
    }
    if part.is_empty() || part == "." || part == ".." {
        return None;
    }
    // Reject drive prefixes, NTFS alternate data streams and control bytes.
    if part.contains(':') || part.chars().any(|c| c.is_control()) {
        return None;
    }
    if cfg!(windows) {
        let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit());
        if reserved {
            return Some(format!("_{part}"));
        }
    }
    Some(part.to_string())
}

/// Never overwrite an existing local file with content supplied by a remote
/// server. Broken symlinks are treated as existing so they cannot be followed.
pub(crate) fn unique_download_path(path: std::path::PathBuf) -> std::path::PathBuf {
    if path.symlink_metadata().is_err() {
        return path;
    }
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let extension = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for index in 1..1000 {
        let candidate = parent.join(format!("{stem} ({index}){extension}"));
        if candidate.symlink_metadata().is_err() {
            return candidate;
        }
    }
    parent.join(format!("{stem} (copy){extension}"))
}

pub(crate) fn safe_local_path(
    base: &std::path::Path,
    rel: &str,
) -> Result<std::path::PathBuf, String> {
    let safe = sanitize_rel(rel);
    if safe.is_empty() {
        return Err("The remote file name is not safe to write locally".into());
    }
    let target = base.join(&safe);
    if !target.starts_with(base) {
        return Err("The remote file name escapes the download folder".into());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::sanitize_rel;

    #[test]
    fn strips_windows_traversal_and_drive_prefixes() {
        assert_eq!(
            sanitize_rel("..\\..\\Startup\\evil.lnk"),
            "Startup/evil.lnk"
        );
        assert_eq!(
            sanitize_rel("C:\\Windows\\System32\\evil.dll"),
            "Windows/System32/evil.dll"
        );
        assert_eq!(sanitize_rel("\\\\server\\share\\evil"), "server/share/evil");
        assert_eq!(sanitize_rel("ok/notes.txt"), "ok/notes.txt");
    }

    #[test]
    fn rejects_ntfs_streams_and_control_names() {
        assert_eq!(sanitize_rel("safe.txt:payload"), "");
        assert_eq!(sanitize_rel("bad\u{0000}name"), "");
    }

    #[test]
    fn escapes_windows_device_names() {
        let expected = if cfg!(windows) { "_CON.txt" } else { "CON.txt" };
        assert_eq!(sanitize_rel("CON.txt"), expected);
    }
}
