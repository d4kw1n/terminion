use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

use crate::models::{LocalShellInfo, TerminalEvent};

enum LocalCommand {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

struct LocalSession {
    tx: Sender<LocalCommand>,
}

/// Owns local pseudo-terminal sessions (PowerShell, cmd, WSL, Unix shell).
pub struct LocalShellManager {
    sessions: Arc<Mutex<HashMap<String, LocalSession>>>,
}

impl LocalShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn list_shells() -> Vec<LocalShellInfo> {
        available_shells()
            .into_iter()
            .map(|shell| shell.info)
            .collect()
    }

    pub fn open(
        &self,
        shell_id: &str,
        cols: u16,
        rows: u16,
        events: Channel<TerminalEvent>,
    ) -> Result<String, String> {
        let shell = available_shells()
            .into_iter()
            .find(|shell| shell.info.id == shell_id)
            .ok_or_else(|| format!("Local shell '{shell_id}' is not available"))?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Could not create a local terminal: {e}"))?;

        let mut command = CommandBuilder::new(&shell.program);
        command.args(shell.args.iter());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Terminion");
        if let Some(home) = dirs::home_dir().filter(|path| path.is_dir()) {
            command.cwd(home);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("Could not start {}: {e}", shell.info.label))?;
        drop(pair.slave);

        let master = pair.master;
        let mut reader = master
            .try_clone_reader()
            .map_err(|e| format!("Could not read from the local terminal: {e}"))?;
        let mut writer = master
            .take_writer()
            .map_err(|e| format!("Could not write to the local terminal: {e}"))?;

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), LocalSession { tx });

        let _ = events.send(TerminalEvent::Status {
            status: "connected".into(),
            detail: None,
            attempt: Some(0),
        });

        let finished = Arc::new(AtomicBool::new(false));

        let reader_events = events.clone();
        let reader_sessions = self.sessions.clone();
        let reader_id = id.clone();
        let reader_finished = finished.clone();
        std::thread::Builder::new()
            .name(format!("local-read-{reader_id}"))
            .spawn(move || {
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(size) => {
                            let data = B64.encode(&buffer[..size]);
                            if reader_events.send(TerminalEvent::Data { data }).is_err() {
                                break;
                            }
                        }
                        Err(err) if err.kind() == ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                finish_session(
                    &reader_events,
                    &reader_sessions,
                    &reader_id,
                    &reader_finished,
                    None,
                );
            })
            .map_err(|e| format!("Could not start the local terminal reader: {e}"))?;

        let command_events = events.clone();
        let command_sessions = self.sessions.clone();
        let command_id = id.clone();
        let command_finished = finished.clone();
        std::thread::Builder::new()
            .name(format!("local-write-{id}"))
            .spawn(move || {
                let mut code = None;
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            code = Some(status.exit_code());
                            break;
                        }
                        Ok(None) => {}
                        Err(_) => break,
                    }
                    match rx.recv_timeout(Duration::from_millis(120)) {
                        Ok(LocalCommand::Write(bytes)) => {
                            if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                                break;
                            }
                        }
                        Ok(LocalCommand::Resize(cols, rows)) => {
                            let _ = master.resize(PtySize {
                                rows: rows.max(2),
                                cols: cols.max(2),
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                        Ok(LocalCommand::Close) => break,
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                let _ = child.kill();
                if let Ok(status) = child.wait() {
                    if code.is_none() {
                        code = Some(status.exit_code());
                    }
                }
                finish_session(
                    &command_events,
                    &command_sessions,
                    &command_id,
                    &command_finished,
                    code,
                );
            })
            .map_err(|e| format!("Could not start the local terminal writer: {e}"))?;

        Ok(id)
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }

    pub fn write(&self, session_id: &str, bytes: Vec<u8>) -> Result<(), String> {
        self.send(session_id, LocalCommand::Write(bytes))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.send(session_id, LocalCommand::Resize(cols, rows))
    }

    pub fn close(&self, session_id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().get(session_id) {
            let _ = session.tx.send(LocalCommand::Close);
        }
    }

    fn send(&self, session_id: &str, command: LocalCommand) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "This local shell is no longer available".to_string())?;
        session
            .tx
            .send(command)
            .map_err(|_| "This local shell has ended".to_string())
    }
}

impl Drop for LocalShellManager {
    fn drop(&mut self) {
        for session in self.sessions.lock().unwrap().values() {
            let _ = session.tx.send(LocalCommand::Close);
        }
    }
}

fn finish_session(
    events: &Channel<TerminalEvent>,
    sessions: &Arc<Mutex<HashMap<String, LocalSession>>>,
    session_id: &str,
    finished: &AtomicBool,
    code: Option<u32>,
) {
    if finished.swap(true, Ordering::SeqCst) {
        return;
    }

    let reason = "Local shell ended".to_string();
    let _ = events.send(TerminalEvent::Disconnected {
        reason: reason.clone(),
        code,
        reconnecting: false,
    });
    let _ = events.send(TerminalEvent::Status {
        status: "disconnected".into(),
        detail: Some(reason),
        attempt: None,
    });
    let _ = events.send(TerminalEvent::Status {
        status: "closed".into(),
        detail: None,
        attempt: None,
    });
    sessions.lock().unwrap().remove(session_id);
}

#[derive(Clone)]
struct ShellSpec {
    info: LocalShellInfo,
    program: PathBuf,
    args: Vec<String>,
}

#[cfg(windows)]
fn find_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn available_shells() -> Vec<ShellSpec> {
    let mut shells = Vec::new();

    if let Some(program) = find_program("pwsh.exe") {
        shells.push(ShellSpec {
            info: LocalShellInfo {
                id: "pwsh".into(),
                label: "PowerShell 7".into(),
                command: "pwsh.exe -NoLogo".into(),
            },
            program,
            args: vec!["-NoLogo".into()],
        });
    }

    let powershell = find_program("powershell.exe").or_else(|| {
        std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|root| {
                root.join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
            })
            .filter(|path| path.is_file())
    });
    if let Some(program) = powershell {
        shells.push(ShellSpec {
            info: LocalShellInfo {
                id: "powershell".into(),
                label: "Windows PowerShell".into(),
                command: "powershell.exe -NoLogo".into(),
            },
            program,
            args: vec!["-NoLogo".into()],
        });
    }

    let cmd = find_program("cmd.exe").or_else(|| {
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
    });
    if let Some(program) = cmd {
        shells.push(ShellSpec {
            info: LocalShellInfo {
                id: "cmd".into(),
                label: "Command Prompt".into(),
                command: "cmd.exe".into(),
            },
            program,
            args: Vec::new(),
        });
    }

    if let Some(program) = find_program("wsl.exe") {
        shells.push(ShellSpec {
            info: LocalShellInfo {
                id: "wsl".into(),
                label: "WSL".into(),
                command: "wsl.exe".into(),
            },
            program,
            args: Vec::new(),
        });
    }

    shells
}

#[cfg(not(windows))]
fn available_shells() -> Vec<ShellSpec> {
    let program = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let command = program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sh")
        .to_string();
    vec![ShellSpec {
        info: LocalShellInfo {
            id: "default".into(),
            label: "Local shell".into(),
            command,
        },
        program,
        args: Vec::new(),
    }]
}
