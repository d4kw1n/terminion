export type AuthType = "password" | "key";
export type HostProtocol = "ssh" | "ftp";
export type ForwardKind = "local" | "remote" | "dynamic";

export interface Group {
  id: number;
  name: string;
  color: string | null;
  sort: number;
  hostCount: number;
}

export interface Host {
  id: number;
  label: string;
  hostname: string;
  port: number;
  username: string;
  protocol: HostProtocol;
  /// Detected after the first SSH connection: distro/OS label.
  os: string | null;
  authType: AuthType;
  hasPassword: boolean;
  keyId: number | null;
  groupId: number | null;
  tags: string[];
  color: string | null;
  favorite: boolean;
  startupCommand: string | null;
  keepaliveSecs: number;
  autoReconnect: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface HostOsDetected {
  hostId: number;
  os: string;
}

export interface LocalShellInfo {
  id: string;
  label: string;
  command: string;
}

export interface HostInput {
  id: number | null;
  label: string;
  hostname: string;
  port: number;
  username: string;
  protocol: HostProtocol;
  authType: AuthType;
  password: string | null;
  keyId: number | null;
  groupId: number | null;
  tags: string[];
  color: string | null;
  favorite: boolean | null;
  startupCommand: string | null;
  keepaliveSecs: number | null;
  autoReconnect: boolean | null;
}

export interface GroupInput {
  id: number | null;
  name: string;
  color: string | null;
  sort: number | null;
}

export interface KeyEntry {
  id: number;
  name: string;
  type: string;
  publicKey: string;
  fingerprint: string;
  comment: string | null;
  hasPassphrase: boolean;
  createdAt: number;
}

export interface Snippet {
  id: number;
  label: string;
  command: string;
  tags: string[];
  createdAt: number;
}

export interface SnippetInput {
  id: number | null;
  label: string;
  command: string;
  tags: string[] | null;
}

export interface KnownHostEntry {
  id: number;
  endpoint: string;
  keyType: string;
  fingerprint: string;
  addedAt: number;
}

export interface PortForward {
  id: number;
  hostId: number;
  label: string;
  kind: ForwardKind;
  listenHost: string;
  listenPort: number;
  targetHost: string | null;
  targetPort: number | null;
  autoStart: boolean;
  createdAt: number;
}

export interface PortForwardInput {
  id: number | null;
  hostId: number;
  label: string;
  kind: ForwardKind;
  listenHost: string;
  listenPort: number;
  targetHost: string | null;
  targetPort: number | null;
  autoStart: boolean | null;
}

export interface RunningForward {
  id: number;
  boundPort: number;
}

export interface Settings {
  theme: "dark" | "light" | "system";
  accent: "violet" | "mint" | "blue" | "amber" | "rose";
  terminalTheme: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorStyle: "block" | "bar" | "underline";
  keepaliveSecs: number;
  autoReconnect: boolean;
  copyOnSelect: boolean;
  confirmClose: boolean;
  renderer: "auto" | "webgl" | "dom";
  bell: boolean;
}

export interface Paths {
  home: string;
  downloads: string;
  dataDir: string;
  sshDir: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  platform: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  keysAdded: number;
  hosts: Host[];
  configPath: string;
}

export interface SftpInfo {
  id: string;
  home: string;
  endpoint: string;
  hostId: number;
}

export interface RemoteFile {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
  mode: string;
  owner: string | null;
  group: string | null;
}

export interface DirListing {
  path: string;
  entries: RemoteFile[];
  total: number;
}

export type TerminalEvent =
  | { type: "status"; status: string; detail: string | null; attempt: number | null }
  | { type: "data"; data: string }
  | {
      type: "connected";
      fingerprint: string;
      keyType: string;
      newHostKey: boolean;
      reused: boolean;
    }
  | { type: "reconnecting"; attempt: number; delayMs: number; reason: string }
  | { type: "disconnected"; reason: string; code: number | null; reconnecting: boolean }
  | { type: "authFailed"; message: string };

export type TransferEvent =
  | {
      type: "started";
      transferId: string;
      name: string;
      totalBytes: number;
      totalFiles: number;
      direction: "upload" | "download";
    }
  | {
      type: "progress";
      percent: number;
      bytes: number;
      totalBytes: number;
      files: number;
      totalFiles: number;
      current: string;
      speed: number;
    }
  | { type: "fileDone"; path: string; ok: boolean; error: string | null }
  | { type: "done"; bytes: number; files: number; durationMs: number }
  | { type: "error"; message: string };

export interface TransferResult {
  bytes: number;
  files: number;
}

export interface ForwardStatusEvent {
  id: number;
  running: boolean;
  error: string | null;
  boundPort: number | null;
}

export interface KnownHostAdded {
  endpoint: string;
  fingerprint: string;
  keyType: string;
}

export type TabKind = "terminal" | "sftp" | "page";
export type PageKind = "snippets" | "forwards" | "keys" | "known" | "settings";

export type ConnStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "ready";

export type SplitSide = "left" | "right" | "top" | "bottom";
export type SplitDirection = "row" | "column";

export type SplitNode =
  | { type: "leaf"; tabId: string }
  | { type: "split"; direction: SplitDirection; children: SplitNode[] };

export interface SplitRect {
  tabId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TabGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}

export interface Tab {
  id: string;
  kind: TabKind;
  page?: PageKind;
  /// For file-browser tabs: which protocol backs the listing.
  fileProtocol?: "sftp" | "ftp";
  title: string;
  subtitle?: string;
  hostId?: number;
  /// Set for a terminal backed by a local PTY instead of an SSH host.
  localShell?: string;
  /// User-visible tab label; falls back to the title/host label when absent.
  customTitle?: string;
  groupId?: string;
  status: ConnStatus;
  sessionId?: string;
  sftpId?: string;
  home?: string;
  endpoint?: string;
  error?: string;
  attempt?: number;
  fingerprint?: string;
  keyType?: string;
}

export interface ProcessStats {
  ramMb: number;
  cpuPercent: number;
  processCount: number;
}

export interface Toast {
  id: string;
  type: "info" | "success" | "error" | "warning";
  title: string;
  message?: string;
  action?: { label: string; run: () => void };
}

export interface TransferItem {
  id: string;
  name: string;
  direction: "upload" | "download";
  percent: number;
  bytes: number;
  totalBytes: number;
  files: number;
  totalFiles: number;
  speed: number;
  current: string;
  status: "running" | "done" | "error" | "cancelled";
  error?: string;
  tabId: string;
}
