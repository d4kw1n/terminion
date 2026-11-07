pub mod forward;
pub mod ftp;
pub mod sftp;
pub mod terminal;
pub mod xfer;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{
    decode_secret_key, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate,
};
use russh::Channel;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;

use crate::db::Db;
use crate::models::{Host, HostOsDetected, KnownHostAdded, KnownHostEntry, ResolvedAuth};

pub type KnownHosts = Arc<Mutex<HashMap<String, KnownHostEntry>>>;

pub fn host_endpoint(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[derive(Debug, Default, Clone)]
pub struct HostKeyInfo {
    pub key_type: Option<String>,
    pub fingerprint: Option<String>,
    pub new: bool,
    pub mismatch: Option<(String, String)>, // (saved, presented)
}

pub struct ClientHandler {
    endpoint: String,
    known: KnownHosts,
    info: Arc<Mutex<HostKeyInfo>>,
    /// When set, channels opened by the server for remote forwarding are
    /// tunneled to this local target.
    forward_target: Option<(String, u16)>,
}

impl ClientHandler {
    pub fn new(
        endpoint: String,
        known: KnownHosts,
        info: Arc<Mutex<HostKeyInfo>>,
        forward_target: Option<(String, u16)>,
    ) -> Self {
        Self {
            endpoint,
            known,
            info,
            forward_target,
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pk = server_public_key.public_key();
        let fingerprint = pk.fingerprint(HashAlg::Sha256).to_string();
        let key_type = pk.algorithm().to_string();
        let saved = self
            .known
            .lock()
            .unwrap()
            .get(&self.endpoint)
            .map(|e| e.fingerprint.clone());

        let mut info = self.info.lock().unwrap();
        info.key_type = Some(key_type);
        info.fingerprint = Some(fingerprint.clone());
        match saved {
            Some(saved) if saved != fingerprint => {
                info.new = false;
                info.mismatch = Some((saved, fingerprint));
                Ok(false)
            }
            Some(_) => {
                info.new = false;
                Ok(true)
            }
            None => {
                info.new = true;
                Ok(true)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.forward_target.clone();
        tokio::spawn(async move {
            let Some((host, port)) = target else {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
                return;
            };
            match TcpStream::connect((host.as_str(), port)).await {
                Ok(stream) => {
                    reply.accept().await;
                    let mut ch = channel.into_stream();
                    let mut stream = stream;
                    let _ = tokio::io::copy_bidirectional(&mut ch, &mut stream).await;
                }
                Err(_) => {
                    reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                }
            }
        });
        Ok(())
    }
}

pub struct SshConnection {
    pub handle: Handle<ClientHandler>,
    pub key_info: HostKeyInfo,
}

pub fn client_config(keepalive_secs: u32) -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(keepalive_secs.clamp(5, 300) as u64)),
        keepalive_max: 3,
        nodelay: true,
        inactivity_timeout: None,
        anonymous: false,
        ..Default::default()
    })
}

/// Opens a TCP connection with OS-level keepalive so that dead links are
/// noticed even when the SSH implementation is blocked on a read.
async fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let target = host_endpoint(host, port);
    let attempt = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("Connection to {target} timed out"))?;

    let stream = attempt.map_err(|e| match e.kind() {
        std::io::ErrorKind::ConnectionRefused => {
            format!("Connection refused by {target} — is the SSH service running?")
        }
        std::io::ErrorKind::TimedOut => format!("Connection to {target} timed out"),
        std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::NotFound => {
            format!("Could not resolve hostname “{host}”")
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("Permission denied while connecting to {target}")
        }
        std::io::ErrorKind::NetworkUnreachable | std::io::ErrorKind::HostUnreachable => {
            "Network unreachable — check your internet connection".to_string()
        }
        _ => format!("Could not connect to {target}: {e}"),
    })?;

    let _ = stream.set_nodelay(true);
    let sock = socket2::SockRef::from(&stream);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(10));
    let _ = sock.set_tcp_keepalive(&keepalive);
    Ok(stream)
}

pub async fn connect_ssh(
    host: &Host,
    keepalive_secs: u32,
    known: KnownHosts,
    forward_target: Option<(String, u16)>,
) -> Result<SshConnection, String> {
    let endpoint = host_endpoint(&host.hostname, host.port);
    let stream = tcp_connect(&host.hostname, host.port).await?;
    let info = Arc::new(Mutex::new(HostKeyInfo::default()));
    let handler = ClientHandler::new(endpoint.clone(), known, info.clone(), forward_target);
    let config = client_config(keepalive_secs);

    let handshake = tokio::time::timeout(
        Duration::from_secs(30),
        client::connect_stream(config, stream, handler),
    )
    .await
    .map_err(|_| format!("SSH handshake with {endpoint} timed out"))?;

    let handle = match handshake {
        Ok(handle) => handle,
        Err(err) => {
            let captured = info.lock().unwrap().clone();
            if let Some((saved, presented)) = captured.mismatch {
                return Err(format!(
                    "Host key verification failed for {endpoint}.\n\nThe server presented a different key than the one saved.\nSaved:     {saved}\nPresented: {presented}\n\nIf you intentionally rebuilt this server, remove its entry under Known Hosts and reconnect."
                ));
            }
            return Err(format!("SSH handshake with {endpoint} failed: {err}"));
        }
    };

    let key_info = info.lock().unwrap().clone();
    Ok(SshConnection { handle, key_info })
}

fn decode_private_key(pem: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    decode_secret_key(pem, passphrase).map_err(|e| {
        let hint = if pem.contains("ENCRYPTED") {
            " The key is encrypted — add its passphrase to the key entry."
        } else {
            ""
        };
        format!("Could not read the SSH key: {e}.{hint}")
    })
}

pub async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    auth: &ResolvedAuth,
    endpoint: &str,
) -> Result<(), String> {
    if let Some(pem) = auth.private_key.as_deref() {
        let key = decode_private_key(pem, auth.passphrase.as_deref())?;
        let hash_alg = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| format!("SSH negotiation failed: {e}"))?
            .flatten();
        let res = handle
            .authenticate_publickey(
                auth.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await
            .map_err(|e| format!("Key authentication failed: {e}"))?;
        if res.success() {
            return Ok(());
        }
        if auth.password.is_none() {
            return Err(format!(
                "Authentication failed for {}@{}: the server rejected the SSH key.",
                auth.username, endpoint
            ));
        }
    }

    if let Some(password) = auth.password.as_deref() {
        let res = handle
            .authenticate_password(auth.username.clone(), password.to_string())
            .await
            .map_err(|e| format!("Authentication failed: {e}"))?;
        if res.success() {
            return Ok(());
        }

        // Many servers only expose keyboard-interactive (PAM, MFA prompts).
        match handle
            .authenticate_keyboard_interactive_start(auth.username.clone(), None::<String>)
            .await
        {
            Ok(client::KeyboardInteractiveAuthResponse::Success) => return Ok(()),
            Ok(client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. }) => {
                let mut responses = vec![password.to_string(); prompts.len()];
                let mut round = 0;
                loop {
                    let res = handle
                        .authenticate_keyboard_interactive_respond(responses)
                        .await
                        .map_err(|e| format!("Authentication failed: {e}"))?;
                    match res {
                        client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
                        client::KeyboardInteractiveAuthResponse::InfoRequest {
                            prompts, ..
                        } if round < 4 => {
                            responses = vec![password.to_string(); prompts.len()];
                            round += 1;
                        }
                        _ => break,
                    }
                }
            }
            _ => {}
        }

        return Err(format!(
            "Authentication failed for {}@{}. Check the username, password and that the server allows this sign-in method.",
            auth.username, endpoint
        ));
    }

    Err(
        "This host has no credentials configured. Edit the host and add a password or SSH key."
            .into(),
    )
}

static OS_DETECTING: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();

fn clean_os_label(raw: &str) -> String {
    raw.lines()
        .next()
        .unwrap_or_default()
        .trim()
        .trim_matches('"')
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect()
}

async fn exec_capture(handle: &Handle<ClientHandler>, command: &str) -> Option<String> {
    let mut channel = tokio::time::timeout(Duration::from_secs(5), handle.channel_open_session())
        .await
        .ok()?
        .ok()?;
    tokio::time::timeout(Duration::from_secs(5), channel.exec(true, command))
        .await
        .ok()?
        .ok()?;

    let mut output: Vec<u8> = Vec::with_capacity(1024);
    let read = async {
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { data }) => {
                    if output.len() < 16 * 1024 {
                        output.extend_from_slice(&data);
                    }
                }
                Some(russh::ChannelMsg::ExtendedData { data, ext }) if ext == 1 => {
                    if output.len() < 16 * 1024 {
                        output.extend_from_slice(&data);
                    }
                }
                Some(russh::ChannelMsg::ExitStatus { .. }) => {}
                Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(6), read).await;
    Some(String::from_utf8_lossy(&output).to_string())
}

async fn detect_linux(handle: &Handle<ClientHandler>) -> Option<String> {
    let raw = exec_capture(
        handle,
        "sh -c 'if [ -r /etc/os-release ]; then cat /etc/os-release; elif [ -r /usr/lib/os-release ]; then cat /usr/lib/os-release; else uname -srm; fi' 2>/dev/null",
    )
    .await
    .unwrap_or_default();

    let (mut pretty, mut name, mut version, mut version_id) = (None, None, None, None);
    for line in raw.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_string();
        match key.trim() {
            "PRETTY_NAME" => pretty = Some(value),
            "NAME" => name = Some(value),
            "VERSION" => version = Some(value),
            "VERSION_ID" => version_id = Some(value),
            _ => {}
        }
    }
    if let Some(pretty) = pretty.filter(|value| !value.is_empty()) {
        return Some(clean_os_label(&pretty));
    }
    if let Some(name) = name.filter(|value| !value.is_empty()) {
        return Some(
            match version_id.or(version).filter(|value| !value.is_empty()) {
                Some(version) => clean_os_label(&format!("{name} {version}")),
                None => clean_os_label(&name),
            },
        );
    }
    let fallback = clean_os_label(&raw);
    let lower = fallback.to_ascii_lowercase();
    if fallback.is_empty()
        || lower.contains("not found")
        || lower.contains("not recognized")
        || lower.contains("permission denied")
    {
        None
    } else {
        Some(fallback)
    }
}

async fn detect_macos(handle: &Handle<ClientHandler>) -> Option<String> {
    let name = exec_capture(handle, "sw_vers -productName 2>/dev/null")
        .await
        .unwrap_or_default();
    let version = exec_capture(handle, "sw_vers -productVersion 2>/dev/null")
        .await
        .unwrap_or_default();
    let name = clean_os_label(&name);
    let version = clean_os_label(&version);
    if name.is_empty() {
        let uname = exec_capture(handle, "uname -sr").await?;
        let label = clean_os_label(&uname);
        return if label.is_empty() { None } else { Some(label) };
    }
    Some(if version.is_empty() {
        name
    } else {
        format!("{name} {version}")
    })
}

async fn detect_windows(handle: &Handle<ClientHandler>) -> Option<String> {
    let caption = exec_capture(
        handle,
        "powershell -NoProfile -NonInteractive -Command \"(Get-CimInstance Win32_OperatingSystem).Caption\" 2>NUL",
    )
    .await
    .unwrap_or_default();
    let caption = clean_os_label(&caption)
        .trim_start_matches("Microsoft ")
        .to_string();
    if !caption.is_empty()
        && !caption.to_ascii_lowercase().contains("not recognized")
        && !caption.to_ascii_lowercase().contains("access is denied")
    {
        return Some(caption);
    }

    let version = exec_capture(handle, "cmd /c ver").await.unwrap_or_default();
    let version = version.trim();
    if let (Some(start), Some(end)) = (version.find("[Version "), version.find(']')) {
        if end > start + 9 {
            return Some(format!("Windows {}", &version[start + 9..end]));
        }
    }
    let first = clean_os_label(version);
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

async fn detect_os_via_handle(handle: &Handle<ClientHandler>) -> Option<String> {
    let uname = exec_capture(handle, "uname -s 2>/dev/null")
        .await
        .unwrap_or_default();
    let lower = uname.to_ascii_lowercase();
    if lower.contains("linux") {
        if let Some(os) = detect_linux(handle).await {
            return Some(os);
        }
        let fallback = clean_os_label(&uname);
        if !fallback.is_empty() {
            return Some(fallback);
        }
    }
    if lower.contains("darwin") {
        if let Some(os) = detect_macos(handle).await {
            return Some(os);
        }
    }
    if lower.contains("bsd") {
        let raw = exec_capture(handle, "uname -sr").await.unwrap_or_default();
        let label = clean_os_label(&raw);
        if !label.is_empty() {
            return Some(label);
        }
    }
    if lower.contains("mingw") || lower.contains("msys") || lower.contains("cygwin") {
        if let Some(os) = detect_windows(handle).await {
            return Some(os);
        }
    }

    let first = clean_os_label(&uname);
    if !first.is_empty()
        && !first.to_ascii_lowercase().contains("not recognized")
        && !first.to_ascii_lowercase().contains("command not found")
    {
        return Some(first);
    }
    detect_windows(handle).await
}

async fn detect_host_os(host: &Host, auth: &ResolvedAuth, known: KnownHosts) -> Option<String> {
    let endpoint = host_endpoint(&host.hostname, host.port);
    let mut conn = connect_ssh(host, host.keepalive_secs, known, None)
        .await
        .ok()?;
    authenticate(&mut conn.handle, auth, &endpoint).await.ok()?;
    detect_os_via_handle(&conn.handle).await
}

/// Identify the remote OS/distro once per host in the background.
pub fn maybe_detect_host_os(
    host: Host,
    auth: ResolvedAuth,
    known: KnownHosts,
    db: Arc<Db>,
    app: AppHandle,
) {
    if host.protocol != "ssh" || host.os.is_some() {
        return;
    }
    let detecting = OS_DETECTING.get_or_init(|| Mutex::new(HashSet::new()));
    {
        let mut set = detecting.lock().unwrap();
        if !set.insert(host.id) {
            return;
        }
    }

    tokio::spawn(async move {
        let result = detect_host_os(&host, &auth, known).await;
        detecting.lock().unwrap().remove(&host.id);
        if let Some(os) = result {
            if db.set_host_os(host.id, &os).is_ok() {
                let _ = app.emit(
                    "host-os-detected",
                    HostOsDetected {
                        host_id: host.id,
                        os,
                    },
                );
            }
        }
    });
}

/// Persist a newly encountered host key and notify the UI.
pub fn commit_host_key(
    db: &Db,
    endpoint: &str,
    info: &HostKeyInfo,
    known: &KnownHosts,
) -> Option<KnownHostAdded> {
    if !info.new {
        return None;
    }
    let (key_type, fingerprint) = (info.key_type.clone()?, info.fingerprint.clone()?);
    if db
        .upsert_known_host(endpoint, &key_type, &fingerprint)
        .is_ok()
    {
        // Keep the in-memory cache in sync so later connections in this
        // process verify against the key we just trusted.
        known.lock().unwrap().insert(
            endpoint.to_string(),
            KnownHostEntry {
                id: 0,
                endpoint: endpoint.to_string(),
                key_type: key_type.clone(),
                fingerprint: fingerprint.clone(),
                added_at: crate::models::now_ts(),
            },
        );
        Some(KnownHostAdded {
            endpoint: endpoint.to_string(),
            fingerprint,
            key_type,
        })
    } else {
        None
    }
}
