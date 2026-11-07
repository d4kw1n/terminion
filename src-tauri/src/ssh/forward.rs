use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;

use crate::db::Db;
use crate::models::{ForwardStatusEvent, Host, PortForward, ResolvedAuth};
use crate::ssh::{
    authenticate, commit_host_key, connect_ssh, host_endpoint, ClientHandler, KnownHosts,
};

type SharedHandle = Arc<AsyncMutex<Option<client::Handle<ClientHandler>>>>;

struct RunningForward {
    task: tokio::task::JoinHandle<()>,
    bound_port: u16,
}

pub struct ForwardManager {
    db: Arc<Db>,
    known: KnownHosts,
    app: AppHandle,
    running: Mutex<HashMap<i64, RunningForward>>,
}

/// Opens a direct-tcpip channel, reconnecting once if the cached SSH
/// connection has gone stale.
async fn open_direct(
    slot: &SharedHandle,
    db: &Db,
    host: &Host,
    auth: &ResolvedAuth,
    known: KnownHosts,
    target: &(String, u16),
    app: &AppHandle,
) -> Result<russh::Channel<client::Msg>, String> {
    let mut guard = slot.lock().await;
    if let Some(handle) = guard.as_ref() {
        match handle
            .channel_open_direct_tcpip(target.0.clone(), target.1 as u32, "127.0.0.1", 0)
            .await
        {
            Ok(channel) => return Ok(channel),
            Err(_) => {
                *guard = None;
            }
        }
    }

    let endpoint = host_endpoint(&host.hostname, host.port);
    let known_for_commit = known.clone();
    let mut conn = connect_ssh(host, host.keepalive_secs, known, None).await?;
    authenticate(&mut conn.handle, auth, &endpoint).await?;
    if let Some(added) = commit_host_key(db, &endpoint, &conn.key_info, &known_for_commit) {
        let _ = app.emit("known-host-added", added);
    }
    let channel = conn
        .handle
        .channel_open_direct_tcpip(target.0.clone(), target.1 as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("Could not open tunnel: {e}"))?;
    *guard = Some(conn.handle);
    Ok(channel)
}

async fn bridge(mut local: TcpStream, channel: russh::Channel<client::Msg>) {
    let mut remote = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
    let _ = local.shutdown().await;
}

async fn socks5_connect(stream: &mut TcpStream) -> Result<(String, u16), String> {
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| e.to_string())?;
    if header[0] != 0x05 {
        return Err("Not a SOCKS5 client".into());
    }
    let mut methods = vec![0u8; header[1] as usize];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| e.to_string())?;
    stream
        .write_all(&[0x05, 0x00])
        .await
        .map_err(|e| e.to_string())?;

    let mut req = [0u8; 4];
    stream
        .read_exact(&mut req)
        .await
        .map_err(|e| e.to_string())?;
    if req[0] != 0x05 || req[1] != 0x01 {
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err("Only SOCKS5 CONNECT is supported".into());
    }
    let host = match req[3] {
        0x01 => {
            let mut ip = [0u8; 4];
            stream
                .read_exact(&mut ip)
                .await
                .map_err(|e| e.to_string())?;
            format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| e.to_string())?;
            let mut name = vec![0u8; len[0] as usize];
            stream
                .read_exact(&mut name)
                .await
                .map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&name).to_string()
        }
        0x04 => {
            let mut ip = [0u8; 16];
            stream
                .read_exact(&mut ip)
                .await
                .map_err(|e| e.to_string())?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => return Err("Unsupported SOCKS5 address type".into()),
    };
    let mut port_bytes = [0u8; 2];
    stream
        .read_exact(&mut port_bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok((host, u16::from_be_bytes(port_bytes)))
}

impl ForwardManager {
    pub fn new(db: Arc<Db>, known: KnownHosts, app: AppHandle) -> Self {
        Self {
            db,
            known,
            app,
            running: Mutex::new(HashMap::new()),
        }
    }

    fn emit_status(&self, id: i64, running: bool, error: Option<String>, bound_port: Option<u16>) {
        let _ = self.app.emit(
            "forward-status",
            ForwardStatusEvent {
                id,
                running,
                error,
                bound_port,
            },
        );
    }

    pub fn is_running(&self, id: i64) -> bool {
        self.running.lock().unwrap().contains_key(&id)
    }

    pub fn running_map(&self) -> Vec<(i64, u16)> {
        self.running
            .lock()
            .unwrap()
            .iter()
            .map(|(id, r)| (*id, r.bound_port))
            .collect()
    }

    pub async fn start(self: &Arc<Self>, id: i64) -> Result<u16, String> {
        if let Some(existing) = self.running.lock().unwrap().get(&id) {
            return Ok(existing.bound_port);
        }
        let rule = self.db.get_forward(id)?;
        let host = self.db.get_host(rule.host_id)?;
        let auth = self.db.resolve_auth(rule.host_id)?;

        let result = match rule.kind.as_str() {
            "remote" => self.start_remote(rule, host, auth).await,
            "dynamic" => self.start_dynamic(rule).await,
            _ => self.start_local(rule).await,
        };
        if let Err(ref err) = result {
            self.emit_status(id, false, Some(err.clone()), None);
        }
        result
    }

    fn bind_host(rule: &PortForward) -> String {
        if rule.listen_host.trim().is_empty() {
            "127.0.0.1".to_string()
        } else {
            rule.listen_host.clone()
        }
    }

    async fn listen(rule: &PortForward) -> Result<(TcpListener, u16), String> {
        let bind_host = Self::bind_host(rule);
        let listener = TcpListener::bind((bind_host.as_str(), rule.listen_port))
            .await
            .map_err(|e| format!("Could not listen on {bind_host}:{} — {e}", rule.listen_port))?;
        let bound = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(rule.listen_port);
        Ok((listener, bound))
    }

    async fn start_local(self: &Arc<Self>, rule: PortForward) -> Result<u16, String> {
        let target = (
            rule.target_host.clone().unwrap_or_default(),
            rule.target_port.unwrap_or(22),
        );
        let (listener, bound_port) = Self::listen(&rule).await?;

        let rule_id = rule.id;
        let host_id = rule.host_id;
        let app = self.app.clone();
        let known = self.known.clone();
        let db = self.db.clone();
        let slot: SharedHandle = Arc::new(AsyncMutex::new(None));

        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let Ok(host) = db.get_host(host_id) else {
                            continue;
                        };
                        let Ok(auth) = db.resolve_auth(host_id) else {
                            continue;
                        };
                        let slot = slot.clone();
                        let known = known.clone();
                        let app = app.clone();
                        let db = db.clone();
                        let target = target.clone();
                        tokio::spawn(async move {
                            match open_direct(&slot, &db, &host, &auth, known, &target, &app).await
                            {
                                Ok(channel) => bridge(stream, channel).await,
                                Err(_) => {
                                    let mut s = stream;
                                    let _ = s.shutdown().await;
                                }
                            }
                        });
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(150)).await,
                }
            }
        });

        self.running
            .lock()
            .unwrap()
            .insert(rule_id, RunningForward { task, bound_port });
        self.emit_status(rule_id, true, None, Some(bound_port));
        Ok(bound_port)
    }

    async fn start_dynamic(self: &Arc<Self>, rule: PortForward) -> Result<u16, String> {
        let (listener, bound_port) = Self::listen(&rule).await?;

        let host_id = rule.host_id;
        let rule_id = rule.id;
        let app = self.app.clone();
        let known = self.known.clone();
        let db = self.db.clone();
        let slot: SharedHandle = Arc::new(AsyncMutex::new(None));

        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    continue;
                };
                let Ok(host) = db.get_host(host_id) else {
                    continue;
                };
                let Ok(auth) = db.resolve_auth(host_id) else {
                    continue;
                };
                let slot = slot.clone();
                let known = known.clone();
                let app = app.clone();
                let db = db.clone();
                tokio::spawn(async move {
                    let Ok(target) = socks5_connect(&mut stream).await else {
                        return;
                    };
                    match open_direct(&slot, &db, &host, &auth, known, &target, &app).await {
                        Ok(channel) => {
                            let reply = [0x05u8, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
                            if stream.write_all(&reply).await.is_ok() {
                                bridge(stream, channel).await;
                            }
                        }
                        Err(_) => {
                            let _ = stream
                                .write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                                .await;
                        }
                    }
                });
            }
        });

        self.running
            .lock()
            .unwrap()
            .insert(rule_id, RunningForward { task, bound_port });
        self.emit_status(rule_id, true, None, Some(bound_port));
        Ok(bound_port)
    }

    async fn start_remote(
        self: &Arc<Self>,
        rule: PortForward,
        host: Host,
        auth: ResolvedAuth,
    ) -> Result<u16, String> {
        let target = (
            rule.target_host.clone().unwrap_or_default(),
            rule.target_port.unwrap_or(22),
        );
        let bind_host = Self::bind_host(&rule);
        let endpoint = host_endpoint(&host.hostname, host.port);
        let mut conn =
            connect_ssh(&host, host.keepalive_secs, self.known.clone(), Some(target)).await?;
        authenticate(&mut conn.handle, &auth, &endpoint).await?;
        if let Some(added) = commit_host_key(&self.db, &endpoint, &conn.key_info, &self.known) {
            let _ = self.app.emit("known-host-added", added);
        }
        let requested_port = rule.listen_port as u32;
        let reply_port = conn
            .handle
            .tcpip_forward(bind_host.clone(), requested_port)
            .await
            .map_err(|e| format!("Remote server refused the forward: {e}"))?;
        // Servers only fill the reply port when the request asked for 0.
        let bound_port = if requested_port == 0 {
            reply_port
        } else {
            requested_port
        };

        let rule_id = rule.id;
        let task = tokio::spawn(async move {
            let _handle = conn.handle;
            std::future::pending::<()>().await;
        });
        self.running.lock().unwrap().insert(
            rule_id,
            RunningForward {
                task,
                bound_port: bound_port as u16,
            },
        );
        self.emit_status(rule_id, true, None, Some(bound_port as u16));
        Ok(bound_port as u16)
    }

    pub fn stop(&self, id: i64) {
        if let Some(running) = self.running.lock().unwrap().remove(&id) {
            running.task.abort();
            self.emit_status(id, false, None, None);
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<i64> = self.running.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.stop(id);
        }
    }

    pub fn autostart(self: &Arc<Self>) {
        let rules = self.db.list_forwards().unwrap_or_default();
        for rule in rules.into_iter().filter(|r| r.auto_start) {
            let this = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let _ = this.start(rule.id).await;
            });
        }
    }
}
