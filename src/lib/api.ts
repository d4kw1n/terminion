import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  DirListing,
  Host,
  HostInput,
  Group,
  GroupInput,
  ImportResult,
  KeyEntry,
  KnownHostEntry,
  Paths,
  PortForward,
  PortForwardInput,
  ProcessStats,
  RunningForward,
  Settings,
  SftpInfo,
  Snippet,
  SnippetInput,
  Tab,
  TerminalEvent,
  TransferEvent,
  TransferResult,
} from "./types";

export interface TerminalStream {
  sessionId: string;
  channel: Channel<TerminalEvent>;
}

export const api = {
  // hosts & groups
  listHosts: () => invoke<Host[]>("list_hosts"),
  getHost: (id: number) => invoke<Host>("get_host", { id }),
  saveHost: (input: HostInput) => invoke<Host>("save_host", { input }),
  deleteHost: (id: number) => invoke<void>("delete_host", { id }),
  setHostFavorite: (id: number, favorite: boolean) =>
    invoke<void>("set_host_favorite", { id, favorite }),
  listGroups: () => invoke<Group[]>("list_groups"),
  saveGroup: (input: GroupInput) => invoke<Group>("save_group", { input }),
  deleteGroup: (id: number) => invoke<void>("delete_group", { id }),
  importSshConfig: () => invoke<ImportResult>("import_ssh_config"),

  // keys
  listKeys: () => invoke<KeyEntry[]>("list_keys"),
  generateKey: (name: string, comment: string | null, passphrase: string | null) =>
    invoke<KeyEntry>("generate_key", { name, comment, passphrase }),
  importKey: (path: string, name: string | null, passphrase: string | null) =>
    invoke<KeyEntry>("import_key", { path, name, passphrase }),
  importKeyText: (
    name: string,
    privateKey: string,
    passphrase: string | null,
    comment: string | null,
  ) => invoke<KeyEntry>("import_key_text", { name, privateKey, passphrase, comment }),
  deleteKey: (id: number) => invoke<void>("delete_key", { id }),

  // snippets
  listSnippets: () => invoke<Snippet[]>("list_snippets"),
  saveSnippet: (input: SnippetInput) => invoke<Snippet>("save_snippet", { input }),
  deleteSnippet: (id: number) => invoke<void>("delete_snippet", { id }),

  // known hosts
  listKnownHosts: () => invoke<KnownHostEntry[]>("list_known_hosts"),
  deleteKnownHost: (id: number) => invoke<void>("delete_known_host", { id }),

  // forwards
  listForwards: () => invoke<PortForward[]>("list_forwards"),
  listRunningForwards: () => invoke<RunningForward[]>("list_running_forwards"),
  saveForward: (input: PortForwardInput) => invoke<PortForward>("save_forward", { input }),
  deleteForward: (id: number) => invoke<void>("delete_forward", { id }),
  startForward: (id: number) => invoke<number>("start_forward", { id }),
  stopForward: (id: number) => invoke<void>("stop_forward", { id }),

  // terminal
  openTerminal: async (
    hostId: number,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalStream> => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    const sessionId = await invoke<string>("open_terminal", {
      hostId,
      cols,
      rows,
      onEvent: channel,
    });
    return { sessionId, channel };
  },
  terminalWrite: (sessionId: string, data: string) =>
    invoke<void>("terminal_write", { sessionId, data }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  terminalReconnect: (sessionId: string) =>
    invoke<void>("terminal_reconnect", { sessionId }),
  terminalProbe: (sessionId: string) => invoke<void>("terminal_probe", { sessionId }),
  terminalClose: (sessionId: string) => invoke<void>("terminal_close", { sessionId }),
  terminalRun: (sessionId: string, command: string) =>
    invoke<void>("terminal_run", { sessionId, command }),

  // sftp
  sftpConnect: (hostId: number) => invoke<SftpInfo>("sftp_connect", { hostId }),
  sftpDisconnect: (sftpId: string) => invoke<void>("sftp_disconnect", { sftpId }),
  sftpListDir: (sftpId: string, path: string) =>
    invoke<DirListing>("sftp_list_dir", { sftpId, path }),
  sftpHome: (sftpId: string) => invoke<string>("sftp_home", { sftpId }),
  sftpMkdir: (sftpId: string, path: string) =>
    invoke<void>("sftp_mkdir", { sftpId, path }),
  sftpRename: (sftpId: string, from: string, to: string) =>
    invoke<void>("sftp_rename", { sftpId, from, to }),
  sftpDelete: (sftpId: string, path: string, recursive: boolean) =>
    invoke<void>("sftp_delete", { sftpId, path, recursive }),
  sftpChmod: (sftpId: string, path: string, mode: number) =>
    invoke<void>("sftp_chmod", { sftpId, path, mode }),
  sftpReadText: (sftpId: string, path: string, maxBytes?: number) =>
    invoke<string>("sftp_read_text", { sftpId, path, maxBytes: maxBytes ?? null }),
  sftpUpload: (
    sftpId: string,
    localPaths: string[],
    remoteDir: string,
    transferId: string,
    onEvent: (event: TransferEvent) => void,
  ) => {
    const channel = new Channel<TransferEvent>();
    channel.onmessage = onEvent;
    return invoke<TransferResult>("sftp_upload", {
      sftpId,
      localPaths,
      remoteDir,
      transferId,
      onEvent: channel,
    });
  },
  sftpDownload: (
    sftpId: string,
    remotePaths: string[],
    localDir: string,
    transferId: string,
    onEvent: (event: TransferEvent) => void,
  ) => {
    const channel = new Channel<TransferEvent>();
    channel.onmessage = onEvent;
    return invoke<TransferResult>("sftp_download", {
      sftpId,
      remotePaths,
      localDir,
      transferId,
      onEvent: channel,
    });
  },
  sftpCancelTransfer: (transferId: string) =>
    invoke<void>("sftp_cancel_transfer", { transferId }),

  // plain FTP
  ftpConnect: (hostId: number) => invoke<SftpInfo>("ftp_connect", { hostId }),
  ftpDisconnect: (ftpId: string) => invoke<void>("ftp_disconnect", { ftpId }),
  ftpListDir: (ftpId: string, path: string) =>
    invoke<DirListing>("ftp_list_dir", { ftpId, path }),
  ftpHome: (ftpId: string) => invoke<string>("ftp_home", { ftpId }),
  ftpMkdir: (ftpId: string, path: string) =>
    invoke<void>("ftp_mkdir", { ftpId, path }),
  ftpRename: (ftpId: string, from: string, to: string) =>
    invoke<void>("ftp_rename", { ftpId, from, to }),
  ftpDelete: (ftpId: string, path: string, recursive: boolean) =>
    invoke<void>("ftp_delete", { ftpId, path, recursive }),
  ftpReadText: (ftpId: string, path: string, maxBytes?: number) =>
    invoke<string>("ftp_read_text", { ftpId, path, maxBytes: maxBytes ?? null }),
  ftpUpload: (
    ftpId: string,
    localPaths: string[],
    remoteDir: string,
    transferId: string,
    onEvent: (event: TransferEvent) => void,
  ) => {
    const channel = new Channel<TransferEvent>();
    channel.onmessage = onEvent;
    return invoke<TransferResult>("ftp_upload", {
      ftpId,
      localPaths,
      remoteDir,
      transferId,
      onEvent: channel,
    });
  },
  ftpDownload: (
    ftpId: string,
    remotePaths: string[],
    localDir: string,
    transferId: string,
    onEvent: (event: TransferEvent) => void,
  ) => {
    const channel = new Channel<TransferEvent>();
    channel.onmessage = onEvent;
    return invoke<TransferResult>("ftp_download", {
      ftpId,
      remotePaths,
      localDir,
      transferId,
      onEvent: channel,
    });
  },
  ftpCancelTransfer: (transferId: string) =>
    invoke<void>("ftp_cancel_transfer", { transferId }),

  // settings/system
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  getPaths: () => invoke<Paths>("get_paths"),
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  processStats: () => invoke<ProcessStats>("process_stats"),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
};

export function tabBase(tab: Tab) {
  return tab.kind === "terminal" ? "terminal" : tab.kind === "sftp" ? "sftp" : "page";
}
