mod commands;
mod db;
mod local;
mod models;
mod secret;
mod ssh;
mod sysmon;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use db::Db;
use local::LocalShellManager;
use ssh::forward::ForwardManager;
use ssh::ftp::FtpManager;
use ssh::sftp::SftpManager;
use ssh::terminal::TerminalManager;
use ssh::KnownHosts;
use sysmon::ProcessMonitor;

pub struct AppState {
    pub db: Arc<Db>,
    pub known: KnownHosts,
    pub terminals: Arc<TerminalManager>,
    pub local: Arc<LocalShellManager>,
    pub sftp: Arc<SftpManager>,
    pub ftp: Arc<FtpManager>,
    pub forwards: Arc<ForwardManager>,
    pub monitor: Arc<ProcessMonitor>,
    pub data_dir: PathBuf,
}

/// Marker read before WebView2 starts. Kept outside SQLite so it can be
/// checked from the process entry point, before Tauri initializes.
pub fn low_memory_marker_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.terminion.app")
        .join("low-memory")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if low_memory_marker_path().exists() {
        let mut args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !args.split_whitespace().any(|arg| arg == "--disable-gpu") {
            if !args.is_empty() {
                args.push(' ');
            }
            args.push_str("--disable-gpu");
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Could not resolve the data directory: {e}"))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("Could not create {}: {e}", data_dir.display()))?;

            let db = Arc::new(Db::open(&data_dir.join("terminion.db"))?);
            let known_map = db.known_hosts_map().unwrap_or_default();
            let known: KnownHosts = Arc::new(Mutex::new(known_map));

            let handle = app.handle().clone();
            let terminals = Arc::new(TerminalManager::new(
                db.clone(),
                known.clone(),
                handle.clone(),
            ));
            let sftp = Arc::new(SftpManager::new(db.clone(), known.clone(), handle.clone()));
            let ftp = Arc::new(FtpManager::new(db.clone()));
            let forwards = Arc::new(ForwardManager::new(
                db.clone(),
                known.clone(),
                handle.clone(),
            ));

            app.manage(AppState {
                db,
                known,
                terminals,
                local: Arc::new(LocalShellManager::new()),
                sftp,
                ftp,
                forwards: forwards.clone(),
                monitor: Arc::new(ProcessMonitor::new()),
                data_dir,
            });

            forwards.autostart();

            #[cfg(windows)]
            {
                // WebView2 would otherwise swallow Ctrl+F / Ctrl+K / Ctrl+N.
                if let Some(window) = app.get_webview_window("main") {
                    std::thread::spawn(move || {
                        use std::sync::atomic::{AtomicBool, Ordering};
                        use std::sync::Arc;
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                        use windows_core::Interface;

                        for _ in 0..15 {
                            std::thread::sleep(std::time::Duration::from_millis(400));
                            let done = Arc::new(AtomicBool::new(false));
                            let flag = done.clone();
                            let result = window.with_webview(move |webview| unsafe {
                                let controller = webview.controller();
                                if let Ok(core) = controller.CoreWebView2() {
                                    if let Ok(settings) = core.Settings() {
                                        if let Ok(settings3) =
                                            settings.cast::<ICoreWebView2Settings3>()
                                        {
                                            let _ = settings3
                                                .SetAreBrowserAcceleratorKeysEnabled(false);
                                            flag.store(true, Ordering::SeqCst);
                                        }
                                    }
                                }
                            });
                            if result.is_err() {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(200));
                            if done.load(Ordering::SeqCst) {
                                break;
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_hosts,
            commands::get_host,
            commands::save_host,
            commands::delete_host,
            commands::set_host_favorite,
            commands::list_groups,
            commands::save_group,
            commands::delete_group,
            commands::import_ssh_config,
            commands::list_keys,
            commands::generate_key,
            commands::import_key,
            commands::import_key_text,
            commands::delete_key,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::list_known_hosts,
            commands::delete_known_host,
            commands::list_forwards,
            commands::list_running_forwards,
            commands::save_forward,
            commands::delete_forward,
            commands::start_forward,
            commands::stop_forward,
            commands::open_terminal,
            commands::list_local_shells,
            commands::open_local_shell,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_reconnect,
            commands::terminal_probe,
            commands::terminal_close,
            commands::terminal_run,
            commands::sftp_connect,
            commands::sftp_disconnect,
            commands::sftp_list_dir,
            commands::sftp_home,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_chmod,
            commands::sftp_read_text,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_cancel_transfer,
            commands::ftp_connect,
            commands::ftp_disconnect,
            commands::ftp_list_dir,
            commands::ftp_home,
            commands::ftp_mkdir,
            commands::ftp_rename,
            commands::ftp_delete,
            commands::ftp_read_text,
            commands::ftp_upload,
            commands::ftp_download,
            commands::ftp_cancel_transfer,
            commands::get_settings,
            commands::save_settings,
            commands::get_paths,
            commands::get_app_info,
            commands::set_low_memory,
            commands::process_stats,
            commands::reveal_path,
            commands::open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Terminion");
}
