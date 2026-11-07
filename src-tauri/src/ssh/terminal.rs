use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use russh::client;
use russh::{Channel, ChannelMsg};
use tauri::ipc::Channel as EventChannel;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::db::Db;
use crate::models::{Host, KnownHostAdded, Settings, TerminalEvent};
use crate::ssh::{authenticate, commit_host_key, connect_ssh, host_endpoint, KnownHosts};

pub enum SessionCommand {
    Write(Vec<u8>),
    Resize(u32, u32),
    Reconnect,
    Probe,
    Disconnect,
}

struct SessionHandle {
    host_id: i64,
    tx: UnboundedSender<SessionCommand>,
}

type SessionMap = Arc<Mutex<HashMap<String, SessionHandle>>>;

pub struct TerminalManager {
    db: Arc<Db>,
    known: KnownHosts,
    app: AppHandle,
    sessions: SessionMap,
}

struct ConnectedHandles {
    handle: client::Handle<crate::ssh::ClientHandler>,
    channel: Channel<client::Msg>,
    host: Host,
    fingerprint: String,
    key_type: String,
    new_key: Option<KnownHostAdded>,
}

enum AttemptOutcome {
    Connected(ConnectedHandles),
    Failed(String),
    /// The user asked to close the session while it was connecting.
    Aborted,
    /// The user asked to reconnect while it was connecting.
    Restart,
}

enum ShellOutcome {
    Stopped,
    Ended(Option<u32>),
    Lost(String),
    Restart,
}

impl TerminalManager {
    pub fn new(db: Arc<Db>, known: KnownHosts, app: AppHandle) -> Self {
        Self {
            db,
            known,
            app,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn open(
        &self,
        host_id: i64,
        cols: u16,
        rows: u16,
        on_event: EventChannel<TerminalEvent>,
    ) -> Result<String, String> {
        // Validate before spawning so errors show up synchronously.
        self.db.get_host(host_id)?;
        let settings = self.db.get_settings()?;
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = unbounded_channel();
        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), SessionHandle { host_id, tx });

        let db = self.db.clone();
        let known = self.known.clone();
        let app = self.app.clone();
        let sessions = self.sessions.clone();
        let session_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = on_event.send(TerminalEvent::Status {
                status: "connecting".into(),
                detail: None,
                attempt: Some(0),
            });
            run_session(
                db,
                known,
                app,
                host_id,
                settings,
                session_id.clone(),
                cols.max(2) as u32,
                rows.max(2) as u32,
                on_event,
                rx,
            )
            .await;
            sessions.lock().unwrap().remove(&session_id);
        });

        Ok(id)
    }

    pub fn send(&self, session_id: &str, cmd: SessionCommand) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "This session is no longer available".to_string())?;
        session
            .tx
            .send(cmd)
            .map_err(|_| "This session has ended".to_string())
    }

    pub fn host_of(&self, session_id: &str) -> Option<i64> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.host_id)
    }
}

fn emit(channel: &EventChannel<TerminalEvent>, event: TerminalEvent) -> bool {
    channel.send(event).is_ok()
}

fn flush(pending: &mut Vec<u8>, channel: &EventChannel<TerminalEvent>) -> bool {
    if pending.is_empty() {
        return true;
    }
    let data = B64.encode(&pending);
    pending.clear();
    emit(channel, TerminalEvent::Data { data })
}

fn is_fatal(message: &str) -> bool {
    message.contains("Authentication failed")
        || message.contains("Host key verification failed")
        || message.contains("no credentials configured")
        || message.contains("rejected the SSH key")
        || message.contains("Could not read the SSH key")
        || message.contains("SSH key")
        || message.contains("passphrase")
}

async fn open_connection(
    db: Arc<Db>,
    known: KnownHosts,
    host_id: i64,
    cols: u32,
    rows: u32,
) -> Result<ConnectedHandles, String> {
    let host = db.get_host(host_id)?;
    let auth = db.resolve_auth(host_id)?;
    let endpoint = host_endpoint(&host.hostname, host.port);
    let known_for_commit = known.clone();
    let mut conn = connect_ssh(&host, host.keepalive_secs, known, None).await?;

    authenticate(&mut conn.handle, &auth, &endpoint).await?;

    let channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Could not open an SSH session: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("The server refused a terminal: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("Could not start a shell: {e}"))?;

    let new_key = commit_host_key(&db, &endpoint, &conn.key_info, &known_for_commit);
    let fingerprint = conn.key_info.fingerprint.unwrap_or_default();
    let key_type = conn.key_info.key_type.unwrap_or_default();

    Ok(ConnectedHandles {
        handle: conn.handle,
        channel,
        host,
        fingerprint,
        key_type,
        new_key,
    })
}

async fn attempt_connect(
    db: Arc<Db>,
    known: KnownHosts,
    host_id: i64,
    cols: u32,
    rows: u32,
    rx: &mut UnboundedReceiver<SessionCommand>,
) -> AttemptOutcome {
    let mut task = tokio::spawn(open_connection(db, known, host_id, cols, rows));
    loop {
        tokio::select! {
            res = &mut task => {
                return match res {
                    Ok(Ok(connected)) => AttemptOutcome::Connected(connected),
                    Ok(Err(message)) => AttemptOutcome::Failed(message),
                    Err(join_err) => AttemptOutcome::Failed(format!("Connection task failed: {join_err}")),
                };
            }
            cmd = rx.recv() => {
                match cmd {
                    None | Some(SessionCommand::Disconnect) => {
                        task.abort();
                        return AttemptOutcome::Aborted;
                    }
                    Some(SessionCommand::Reconnect) => {
                        task.abort();
                        return AttemptOutcome::Restart;
                    }
                    Some(SessionCommand::Resize(_, _))
                    | Some(SessionCommand::Write(_))
                    | Some(SessionCommand::Probe) => {}
                }
            }
        }
    }
}

async fn park(rx: &mut UnboundedReceiver<SessionCommand>) -> ShellOutcome {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            SessionCommand::Reconnect => return ShellOutcome::Restart,
            SessionCommand::Disconnect => return ShellOutcome::Stopped,
            SessionCommand::Probe => {}
            _ => {}
        }
    }
    ShellOutcome::Stopped
}

async fn wait_before_retry(
    rx: &mut UnboundedReceiver<SessionCommand>,
    millis: u64,
) -> ShellOutcome {
    let sleep = tokio::time::sleep(Duration::from_millis(millis));
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return ShellOutcome::Lost("retry".into()),
            cmd = rx.recv() => match cmd {
                None | Some(SessionCommand::Disconnect) => return ShellOutcome::Stopped,
                Some(SessionCommand::Reconnect) | Some(SessionCommand::Probe) => {
                    return ShellOutcome::Restart
                }
                _ => {}
            }
        }
    }
}

async fn run_shell(
    mut connected: ConnectedHandles,
    cols: &mut u32,
    rows: &mut u32,
    rx: &mut UnboundedReceiver<SessionCommand>,
    events: &EventChannel<TerminalEvent>,
) -> ShellOutcome {
    let mut pending: Vec<u8> = Vec::with_capacity(8192);
    let mut flush_tick = tokio::time::interval(Duration::from_millis(12));
    flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    if let Some(cmd) = connected
        .host
        .startup_command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        let line = format!("{cmd}\r");
        let _ = connected.channel.data_bytes(line.into_bytes()).await;
    }

    loop {
        tokio::select! {
            biased;
            cmd = rx.recv() => {
                match cmd {
                    None => {
                        let _ = connected.channel.close().await;
                        return ShellOutcome::Stopped;
                    }
                    Some(SessionCommand::Write(bytes)) => {
                        if let Err(e) = connected.channel.data_bytes(bytes).await {
                            let _ = flush(&mut pending, events);
                            return ShellOutcome::Lost(format!("Could not send input: {e}"));
                        }
                    }
                    Some(SessionCommand::Resize(c, r)) => {
                        *cols = c.max(2);
                        *rows = r.max(2);
                        let _ = connected.channel.window_change(*cols, *rows, 0, 0).await;
                    }
                    Some(SessionCommand::Reconnect) => {
                        let _ = flush(&mut pending, events);
                        let _ = connected.channel.close().await;
                        return ShellOutcome::Restart;
                    }
                    Some(SessionCommand::Probe) => {
                        // Open a throwaway channel; if the link is dead this
                        // hangs and we can fail over quickly.
                        match tokio::time::timeout(
                            Duration::from_secs(5),
                            connected.handle.channel_open_session(),
                        ).await {
                            Ok(Ok(probe)) => { let _ = probe.close().await; }
                            _ => {
                                let _ = flush(&mut pending, events);
                                return ShellOutcome::Lost("Network link lost".into());
                            }
                        }
                    }
                    Some(SessionCommand::Disconnect) => {
                        let _ = flush(&mut pending, events);
                        let _ = connected.channel.eof().await;
                        let _ = connected.channel.close().await;
                        return ShellOutcome::Stopped;
                    }
                }
            }
            msg = connected.channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        pending.extend_from_slice(&data);
                        if pending.len() >= 64 * 1024 && !flush(&mut pending, events) {
                            return ShellOutcome::Stopped;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, ext }) => {
                        if ext == 1 {
                            pending.extend_from_slice(&data);
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = flush(&mut pending, events);
                        return ShellOutcome::Ended(Some(exit_status));
                    }
                    Some(ChannelMsg::ExitSignal { .. }) => {
                        let _ = flush(&mut pending, events);
                        return ShellOutcome::Ended(None);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        let _ = flush(&mut pending, events);
                        return ShellOutcome::Lost("Connection closed by the server".into());
                    }
                    _ => {}
                }
            }
            _ = flush_tick.tick() => {
                if !flush(&mut pending, events) {
                    return ShellOutcome::Stopped;
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    db: Arc<Db>,
    known: KnownHosts,
    app: AppHandle,
    host_id: i64,
    settings: Settings,
    _session_id: String,
    mut cols: u32,
    mut rows: u32,
    events: EventChannel<TerminalEvent>,
    mut rx: UnboundedReceiver<SessionCommand>,
) {
    let mut attempt: u32 = 0;
    let mut ever_connected = false;
    let mut auto = settings.auto_reconnect;
    let mut last_reason = String::from("Connection lost");

    loop {
        if attempt > 0 {
            let delay = match attempt {
                1 => 700,
                2 => 1_500,
                3 => 3_000,
                4 => 5_000,
                _ => 8_000,
            };
            let _ = emit(
                &events,
                TerminalEvent::Reconnecting {
                    attempt,
                    delay_ms: delay,
                    reason: last_reason.clone(),
                },
            );
            match wait_before_retry(&mut rx, delay).await {
                ShellOutcome::Stopped => break,
                ShellOutcome::Restart => {
                    attempt = 0;
                    continue;
                }
                _ => {}
            }
        }

        let _ = emit(
            &events,
            TerminalEvent::Status {
                status: if attempt == 0 {
                    "connecting"
                } else {
                    "reconnecting"
                }
                .into(),
                detail: if attempt == 0 {
                    None
                } else {
                    Some(last_reason.clone())
                },
                attempt: Some(attempt),
            },
        );

        let outcome =
            attempt_connect(db.clone(), known.clone(), host_id, cols, rows, &mut rx).await;
        match outcome {
            AttemptOutcome::Aborted => break,
            AttemptOutcome::Restart => {
                attempt = 0;
                continue;
            }
            AttemptOutcome::Failed(message) => {
                last_reason = message.clone();
                let fatal = is_fatal(&message);
                if fatal || !auto {
                    let _ = emit(
                        &events,
                        TerminalEvent::Disconnected {
                            reason: message.clone(),
                            code: None,
                            reconnecting: false,
                        },
                    );
                    if fatal {
                        let _ = emit(&events, TerminalEvent::AuthFailed { message });
                    }
                    let _ = emit(
                        &events,
                        TerminalEvent::Status {
                            status: "disconnected".into(),
                            detail: Some(last_reason.clone()),
                            attempt: None,
                        },
                    );
                    match park(&mut rx).await {
                        ShellOutcome::Stopped => break,
                        _ => {
                            attempt = 0;
                            continue;
                        }
                    }
                } else {
                    attempt = attempt.saturating_add(1);
                    continue;
                }
            }
            AttemptOutcome::Connected(connected) => {
                attempt = 0;
                let _ = db.mark_host_used(host_id);
                auto = settings.auto_reconnect && connected.host.auto_reconnect;
                let new_key = connected.new_key.is_some();
                if let Some(added) = connected.new_key.clone() {
                    let _ = app.emit("known-host-added", added);
                }
                let fingerprint = connected.fingerprint.clone();
                let key_type = connected.key_type.clone();
                let reused = ever_connected;
                ever_connected = true;

                if !emit(
                    &events,
                    TerminalEvent::Connected {
                        fingerprint,
                        key_type,
                        new_host_key: new_key,
                        reused,
                    },
                ) {
                    break;
                }
                let _ = emit(
                    &events,
                    TerminalEvent::Status {
                        status: "connected".into(),
                        detail: None,
                        attempt: Some(0),
                    },
                );

                match run_shell(connected, &mut cols, &mut rows, &mut rx, &events).await {
                    ShellOutcome::Stopped => break,
                    ShellOutcome::Restart => {
                        last_reason = "Reconnecting…".into();
                        attempt = 0;
                        // reconnect right away
                        let _ = emit(
                            &events,
                            TerminalEvent::Status {
                                status: "reconnecting".into(),
                                detail: Some(last_reason.clone()),
                                attempt: Some(0),
                            },
                        );
                        continue;
                    }
                    ShellOutcome::Ended(code) => {
                        let _ = emit(
                            &events,
                            TerminalEvent::Disconnected {
                                reason: "Session ended".into(),
                                code,
                                reconnecting: false,
                            },
                        );
                        let _ = emit(
                            &events,
                            TerminalEvent::Status {
                                status: "disconnected".into(),
                                detail: Some("Session ended".into()),
                                attempt: None,
                            },
                        );
                        match park(&mut rx).await {
                            ShellOutcome::Stopped => break,
                            _ => {
                                attempt = 0;
                                continue;
                            }
                        }
                    }
                    ShellOutcome::Lost(reason) => {
                        last_reason = reason.clone();
                        let _ = emit(
                            &events,
                            TerminalEvent::Status {
                                status: if auto { "reconnecting" } else { "disconnected" }.into(),
                                detail: Some(reason.clone()),
                                attempt: Some(attempt),
                            },
                        );
                        if auto {
                            attempt = 1;
                            continue;
                        }
                        let _ = emit(
                            &events,
                            TerminalEvent::Disconnected {
                                reason,
                                code: None,
                                reconnecting: false,
                            },
                        );
                        match park(&mut rx).await {
                            ShellOutcome::Stopped => break,
                            _ => {
                                attempt = 0;
                                continue;
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = emit(
        &events,
        TerminalEvent::Status {
            status: "closed".into(),
            detail: None,
            attempt: None,
        },
    );
}
