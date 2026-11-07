import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon, type IconName } from "./Icon";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import {
  formatBytes,
  formatDate,
  hostColor,
  initials,
  joinPath,
  parentPath,
  splitPath,
} from "../lib/utils";
import { useStore } from "../store";
import type {
  ConnStatus,
  DirListing,
  RemoteFile,
  SftpInfo,
  Tab,
  TransferEvent,
  TransferResult,
} from "../lib/types";

interface SftpViewProps {
  tab: Tab;
  active: boolean;
  embedded?: boolean;
  onCollapse?: () => void;
}

type SortKey = "name" | "size" | "modified";

interface FilesApi {
  label: "SFTP" | "FTP";
  unencrypted: boolean;
  chmod: ((id: string, path: string, mode: number) => Promise<void>) | null;
  connect: (hostId: number) => Promise<SftpInfo>;
  disconnect: (id: string) => Promise<void>;
  list: (id: string, path: string) => Promise<DirListing>;
  home: (id: string) => Promise<string>;
  mkdir: (id: string, path: string) => Promise<void>;
  rename: (id: string, from: string, to: string) => Promise<void>;
  delete: (id: string, path: string, recursive: boolean) => Promise<void>;
  readText: (id: string, path: string, maxBytes: number) => Promise<string>;
  upload: (
    id: string,
    localPaths: string[],
    remoteDir: string,
    transferId: string,
    onEvent: (event: TransferEvent) => void,
  ) => Promise<TransferResult>;
  download: (
    id: string,
    remotePaths: string[],
    localDir: string,
    transferId: string,
    onEvent: (event: TransferEvent) => void,
  ) => Promise<TransferResult>;
}

const BINARY_HINT = ["zip", "gz", "tgz", "7z", "rar", "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "exe", "dll", "so", "dylib", "bin", "mp4", "mp3", "woff", "woff2"];

function iconFor(file: RemoteFile): IconName {
  if (file.isSymlink) return "link";
  if (file.isDir) return "folder";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (BINARY_HINT.includes(ext)) return "hard-drive";
  if (["sh", "bash", "zsh", "ps1", "bat"].includes(ext)) return "terminal";
  if (["json", "yml", "yaml", "toml", "ini", "conf", "env", "xml"].includes(ext)) return "file-text";
  if (["md", "txt", "log", "csv"].includes(ext)) return "file-text";
  return "file";
}

export function SftpView({ tab, active, embedded = false, onCollapse }: SftpViewProps) {
  const hosts = useStore((s) => s.hosts);
  const paths = useStore((s) => s.paths);
  const beginTransfer = useStore((s) => s.beginTransfer);
  const updateTransfer = useStore((s) => s.updateTransfer);
  const endTransfer = useStore((s) => s.endTransfer);
  const addToast = useStore((s) => s.addToast);
  const askConfirm = useStore((s) => s.askConfirm);
  const closeTab = useStore((s) => s.closeTab);
  const openHostEditor = useStore((s) => s.openHostEditor);
  const patchTab = useStore((s) => s.patchTab);
  const setTabStatus = useStore((s) => s.setTabStatus);

  const [sftpId, setSftpId] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<ConnStatus>("connecting");
  const [home, setHome] = useState(tab.home ?? "");
  const [listing, setListing] = useState<{ path: string; entries: RemoteFile[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [pathEditing, setPathEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<
    | { type: "mkdir"; value: string }
    | { type: "rename"; file: RemoteFile; value: string }
    | { type: "chmod"; file: RemoteFile; value: string }
    | null
  >(null);
  const [preview, setPreview] = useState<{
    file: RemoteFile;
    content: string;
    loading: boolean;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const sftpIdRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const host = hosts.find((h) => h.id === tab.hostId) ?? null;
  const color = host ? hostColor(host) : "#7c5cff";
  const currentPath = listing?.path ?? home;
  const isFtp = tab.fileProtocol === "ftp";
  const status = embedded ? localStatus : tab.status;

  const markStatus = useCallback(
    (next: ConnStatus, message?: string) => {
      setLocalStatus(next);
      setTabStatus(tab.id, next, message);
    },
    [setTabStatus, tab.id],
  );

  const fs = useMemo<FilesApi>(
    () =>
      isFtp
        ? {
            label: "FTP",
            unencrypted: true,
            chmod: null,
            connect: (hostId) => api.ftpConnect(hostId),
            disconnect: (id) => api.ftpDisconnect(id),
            list: (id, path) => api.ftpListDir(id, path),
            home: (id) => api.ftpHome(id),
            mkdir: (id, path) => api.ftpMkdir(id, path),
            rename: (id, from, to) => api.ftpRename(id, from, to),
            delete: (id, path, recursive) => api.ftpDelete(id, path, recursive),
            readText: (id, path, maxBytes) => api.ftpReadText(id, path, maxBytes),
            upload: (id, localPaths, remoteDir, transferId, onEvent) =>
              api.ftpUpload(id, localPaths, remoteDir, transferId, onEvent),
            download: (id, remotePaths, localDir, transferId, onEvent) =>
              api.ftpDownload(id, remotePaths, localDir, transferId, onEvent),
          }
        : {
            label: "SFTP",
            unencrypted: false,
            chmod: (id, path, mode) => api.sftpChmod(id, path, mode),
            connect: (hostId) => api.sftpConnect(hostId),
            disconnect: (id) => api.sftpDisconnect(id),
            list: (id, path) => api.sftpListDir(id, path),
            home: (id) => api.sftpHome(id),
            mkdir: (id, path) => api.sftpMkdir(id, path),
            rename: (id, from, to) => api.sftpRename(id, from, to),
            delete: (id, path, recursive) => api.sftpDelete(id, path, recursive),
            readText: (id, path, maxBytes) => api.sftpReadText(id, path, maxBytes),
            upload: (id, localPaths, remoteDir, transferId, onEvent) =>
              api.sftpUpload(id, localPaths, remoteDir, transferId, onEvent),
            download: (id, remotePaths, localDir, transferId, onEvent) =>
              api.sftpDownload(id, remotePaths, localDir, transferId, onEvent),
          },
    [isFtp],
  );

  const loadDir = useCallback(
    async (id: string, target: string) => {
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await fs.list(id, target);
        if (request !== requestRef.current) return;
        setListing({ path: result.path, entries: result.entries });
        setSelected(new Set());
        setLastIndex(null);
        patchTab(tab.id, { status: "connected", error: undefined });
      } catch (err) {
        if (request !== requestRef.current) return;
        const message = String(err);
        setError(message);
        addToast({ type: "error", title: "Could not open folder", message });
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [addToast, fs, patchTab, tab.id],
  );

  // Connect once when the tab mounts.
  useEffect(() => {
    let cancelled = false;
    if (!tab.hostId) return;
    setLoading(true);
    markStatus("connecting");
    fs.connect(tab.hostId)
      .then((info) => {
        if (cancelled) {
          void fs.disconnect(info.id);
          return;
        }
        sftpIdRef.current = info.id;
        setSftpId(info.id);
        setHome(info.home);
        markStatus("connected");
        patchTab(tab.id, {
          sftpId: info.id,
          home: info.home,
          status: "connected",
          endpoint: info.endpoint,
        });
        void loadDir(info.id, info.home);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err);
        setError(message);
        setLoading(false);
        markStatus("disconnected", message);
        addToast({ type: "error", title: `${fs.label} connection failed`, message });
      });
    return () => {
      cancelled = true;
      const id = sftpIdRef.current;
      if (id) {
        fs.disconnect(id).catch(() => {});
        sftpIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, tab.id, tab.hostId]);

  const navigate = (target: string) => {
    if (!sftpId) return;
    void loadDir(sftpId, target);
  };

  const refresh = () => {
    if (!sftpId || !currentPath) return;
    void loadDir(sftpId, currentPath);
  };

  const reconnect = async () => {
    if (!tab.hostId) return;
    const previous = sftpIdRef.current;
    sftpIdRef.current = null;
    if (previous) await fs.disconnect(previous).catch(() => {});
    setSftpId(null);
    setListing(null);
    setSelected(new Set());
    setError(null);
    setLoading(true);
    markStatus("connecting");
    try {
      const info = await fs.connect(tab.hostId);
      sftpIdRef.current = info.id;
      setSftpId(info.id);
      setHome(info.home);
      markStatus("connected");
      patchTab(tab.id, {
        sftpId: info.id,
        home: info.home,
        status: "connected",
        endpoint: info.endpoint,
        error: undefined,
      });
      await loadDir(info.id, info.home);
    } catch (err) {
      const message = String(err);
      setError(message);
      setLoading(false);
      markStatus("disconnected", message);
      addToast({ type: "error", title: `${fs.label} connection failed`, message });
    }
  };

  // Detect a dead file-transfer channel while the tab is in the foreground.
  useEffect(() => {
    if (!active || !sftpId) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      fs.home(sftpId)
        .catch((err) => {
          if (disposed) return;
          setError(String(err));
          markStatus("disconnected", String(err));
        });
    }, 25_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, fs, sftpId, tab.id, markStatus]);

  const sorted = useMemo(() => {
    const entries = listing?.entries ?? [];
    const sortedEntries = [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let result = 0;
      if (sort.key === "name") {
        result = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      } else if (sort.key === "size") {
        result = a.size - b.size;
      } else {
        result = (a.modified ?? 0) - (b.modified ?? 0);
      }
      return result * sort.dir;
    });
    return sortedEntries;
  }, [listing, sort]);

  const selectedFiles = useMemo(
    () => (listing?.entries ?? []).filter((f) => selected.has(f.path)),
    [listing, selected],
  );

  const changeSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 },
    );
  };

  const handleRowClick = (event: MouseEvent, file: RemoteFile, index: number) => {
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      setSelected(next);
      setLastIndex(index);
      return;
    }
    if (event.shiftKey && lastIndex !== null) {
      const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
      const next = new Set(selected);
      for (let i = start; i <= end; i++) next.add(sorted[i].path);
      setSelected(next);
      return;
    }
    setSelected(new Set([file.path]));
    setLastIndex(index);
  };

  const openFile = (file: RemoteFile) => {
    if (file.isDir) {
      navigate(file.path);
    } else {
      void openPreview(file);
    }
  };

  const openPreview = async (file: RemoteFile) => {
    if (!sftpId) return;
    setPreview({ file, content: "", loading: true });
    try {
      const text = await fs.readText(sftpId, file.path, 512 * 1024);
      const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
      if (replacementCount > 3) {
        setPreview({ file, content: "__BINARY__", loading: false });
      } else {
        setPreview({ file, content: text, loading: false });
      }
    } catch (err) {
      setPreview(null);
      addToast({ type: "error", title: "Could not preview file", message: String(err) });
    }
  };

  const downloadTo = async (files: RemoteFile[]) => {
    if (!sftpId || files.length === 0) return;
    let destination = paths?.downloads;
    if (!destination) {
      const picked = await openDialog({ directory: true, title: "Download to folder" });
      if (typeof picked !== "string") return;
      destination = picked;
    }
    const id = crypto.randomUUID();
    const name =
      files.length === 1 ? files[0].name : `${files.length} items`;
    beginTransfer({
      id,
      name,
      direction: "download",
      percent: 0,
      bytes: 0,
      totalBytes: 0,
      files: 0,
      totalFiles: files.length,
      speed: 0,
      current: "",
      status: "running",
      tabId: tab.id,
    });
    const onEvent = (event: TransferEvent) => {
      if (event.type === "started") {
        updateTransfer(id, {
          name: event.name,
          totalBytes: event.totalBytes,
          totalFiles: event.totalFiles,
        });
      } else if (event.type === "progress") {
        updateTransfer(id, {
          percent: event.percent,
          bytes: event.bytes,
          totalBytes: event.totalBytes,
          files: event.files,
          totalFiles: event.totalFiles,
          speed: event.speed,
          current: event.current,
        });
      } else if (event.type === "done") {
        endTransfer(id, {
          status: "done",
          percent: 100,
          bytes: event.bytes,
          files: event.files,
          speed: 0,
        });
        addToast({
          type: "success",
          title: "Download complete",
          message: `${formatBytes(event.bytes)} · ${destination}`,
          action: {
            label: "Show folder",
            run: () => void api.revealPath(destination as string),
          },
        });
        refresh();
      } else if (event.type === "error") {
        endTransfer(id, {
          status: event.message === "Transfer cancelled" ? "cancelled" : "error",
          error: event.message,
        });
      }
    };
    try {
      await fs.download(
        sftpId,
        files.map((f) => f.path),
        destination,
        id,
        onEvent,
      );
    } catch (err) {
      endTransfer(id, { status: "error", error: String(err) });
      addToast({ type: "error", title: "Download failed", message: String(err) });
    }
  };

  const uploadPaths = useCallback(
    async (pathsToUpload: string[]) => {
      if (!sftpId || !currentPath || pathsToUpload.length === 0) return;
      const id = crypto.randomUUID();
      const name = pathsToUpload.length === 1 ? pathsToUpload[0].split(/[\\/]/).pop()! : `${pathsToUpload.length} items`;
      beginTransfer({
        id,
        name,
        direction: "upload",
        percent: 0,
        bytes: 0,
        totalBytes: 0,
        files: 0,
        totalFiles: pathsToUpload.length,
        speed: 0,
        current: "",
        status: "running",
        tabId: tab.id,
      });
      const targetDir = currentPath;
      const onEvent = (event: TransferEvent) => {
        if (event.type === "started") {
          updateTransfer(id, {
            name: event.name,
            totalBytes: event.totalBytes,
            totalFiles: event.totalFiles,
          });
        } else if (event.type === "progress") {
          updateTransfer(id, {
            percent: event.percent,
            bytes: event.bytes,
            totalBytes: event.totalBytes,
            files: event.files,
            totalFiles: event.totalFiles,
            speed: event.speed,
            current: event.current,
          });
        } else if (event.type === "done") {
          endTransfer(id, {
            status: "done",
            percent: 100,
            bytes: event.bytes,
            files: event.files,
            speed: 0,
          });
          addToast({
            type: "success",
            title: "Upload complete",
            message: `${formatBytes(event.bytes)} → ${targetDir}`,
          });
          refresh();
        } else if (event.type === "error") {
          endTransfer(id, {
            status: event.message === "Transfer cancelled" ? "cancelled" : "error",
            error: event.message,
          });
        }
      };
      try {
        await fs.upload(sftpId, pathsToUpload, targetDir, id, onEvent);
      } catch (err) {
        endTransfer(id, { status: "error", error: String(err) });
        addToast({ type: "error", title: "Upload failed", message: String(err) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fs, sftpId, currentPath, tab.id],
  );

  const pickFiles = async (directory: boolean) => {
    try {
      const picked = await openDialog({
        multiple: true,
        directory,
        title: directory ? "Upload a folder" : "Upload files",
      });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      if (list.length > 0) void uploadPaths(list);
    } catch (err) {
      addToast({
        type: "error",
        title: "Could not open the file picker",
        message: String(err),
      });
    }
  };

  const createFolder = async (name: string) => {
    if (!sftpId || !name.trim()) return;
    try {
      await fs.mkdir(sftpId, joinPath(currentPath, name.trim()));
      setDialog(null);
      refresh();
    } catch (err) {
      addToast({ type: "error", title: "Could not create folder", message: String(err) });
    }
  };

  const renameFile = async (file: RemoteFile, name: string) => {
    if (!sftpId || !name.trim() || name === file.name) {
      setDialog(null);
      return;
    }
    const target = joinPath(parentPath(file.path), name.trim());
    try {
      await fs.rename(sftpId, file.path, target);
      setDialog(null);
      refresh();
    } catch (err) {
      addToast({ type: "error", title: "Could not rename", message: String(err) });
    }
  };

  const chmodFile = async (file: RemoteFile, value: string) => {
    if (!sftpId || !fs.chmod) return;
    const mode = parseInt(value, 8);
    if (!Number.isFinite(mode) || mode < 0 || mode > 0o7777) {
      addToast({ type: "error", title: "Invalid mode", message: "Use an octal mode such as 755." });
      return;
    }
    try {
      await fs.chmod(sftpId, file.path, mode);
      setDialog(null);
      refresh();
    } catch (err) {
      addToast({ type: "error", title: "Could not change permissions", message: String(err) });
    }
  };

  const deleteFiles = (files: RemoteFile[]) => {
    if (!sftpId || files.length === 0) return;
    askConfirm({
      title:
        files.length === 1 ? `Delete “${files[0].name}”?` : `Delete ${files.length} items?`,
      message: files.some((f) => f.isDir)
        ? "Folders are deleted recursively. This cannot be undone."
        : "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        for (const file of files) {
          try {
            await fs.delete(sftpId, file.path, file.isDir);
          } catch (err) {
            addToast({ type: "error", title: `Could not delete ${file.name}`, message: String(err) });
          }
        }
        refresh();
      },
    });
  };

  const rowMenu = (file: RemoteFile): MenuItem[] => {
    const multiple = selected.has(file.path) && selected.size > 1;
    const files = multiple ? selectedFiles : [file];
    const items: MenuItem[] = [
      file.isDir
        ? { label: "Open", icon: "folder", onClick: () => navigate(file.path) }
        : { label: "Preview", icon: "eye", onClick: () => void openPreview(file) },
      {
        label: file.isDir ? (multiple ? "Download folders" : "Download folder") : multiple ? "Download files" : "Download",
        icon: "download",
        onClick: () => void downloadTo(files),
      },
      { separator: true },
    ];
    if (!multiple) {
      items.push({
        label: "Rename",
        icon: "edit",
        onClick: () => setDialog({ type: "rename", file, value: file.name }),
      });
      if (fs.chmod) {
        items.push({
          label: "Permissions",
          icon: "lock",
          onClick: () =>
            setDialog({
              type: "chmod",
              file,
              value: (file.permissions ?? 0o644).toString(8).slice(-3),
            }),
        });
      }
      items.push({
        label: "Copy path",
        icon: "copy",
        onClick: () => void navigator.clipboard.writeText(file.path),
      });
    }
    items.push({ separator: true });
    items.push({
      label: multiple ? `Delete ${files.length} items` : "Delete",
      icon: "trash",
      danger: true,
      onClick: () => deleteFiles(files),
    });
    return items;
  };

  const backgroundMenu = (): MenuItem[] => [
    { label: "Refresh", icon: "refresh", onClick: refresh },
    {
      label: "New folder",
      icon: "folder-plus",
      onClick: () => setDialog({ type: "mkdir", value: "" }),
    },
    { separator: true },
    { label: "Upload files…", icon: "upload", onClick: () => void pickFiles(false) },
    { label: "Upload folder…", icon: "folder", onClick: () => void pickFiles(true) },
    { separator: true },
    {
      label: "Copy current path",
      icon: "copy",
      onClick: () => void navigator.clipboard.writeText(currentPath),
    },
    {
      label: "Go home",
      icon: "home",
      onClick: () => home && navigate(home),
    },
  ];

  // Native drag & drop (Tauri disables HTML5 file drops).
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        const type = event.payload.type;
        if (type === "enter" || type === "over") {
          setDropActive(true);
        } else if (type === "leave") {
          setDropActive(false);
        } else if (type === "drop") {
          setDropActive(false);
          const pathsDropped =
            (event.payload as { paths?: string[] }).paths ?? [];
          if (pathsDropped.length > 0) void uploadPaths(pathsDropped);
        }
      });
      if (disposed) un();
      else unlisten = un;
    })();
    return () => {
      disposed = true;
      unlisten?.();
      setDropActive(false);
    };
  }, [active, uploadPaths]);

  // Keep global shortcuts from stealing Ctrl+L inside the path editor.
  const headerStatus =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting"
        : status === "reconnecting"
          ? "Reconnecting"
          : "Disconnected";

  const crumbs = splitPath(currentPath || "/");
  const sortArrow = (key: SortKey) =>
    sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : "";

  return (
    <div className={`sftp-view ${embedded ? "sftp-view--embedded" : ""}`}>
      <div className="term-toolbar">
        <div className="term-identity">
          {host ? (
            <span
              className="avatar avatar--sm"
              style={{ background: `linear-gradient(145deg, ${color}e6, ${color}80)` }}
            >
              {initials(host.label)}
            </span>
          ) : null}
          <div className="term-titles">
            <div className="term-title-row">
              <span className="term-title">{host?.label ?? tab.title}</span>
              <span className={`status-pill ${status}`} title={headerStatus}>
                <span className="status-dot" />
                {headerStatus}
              </span>
              <span className="pill pill--muted">{fs.label}</span>
              {host?.os && (
                <span className="pill pill--muted host-os-pill" title={host.os}>
                  {host.os}
                </span>
              )}
              {fs.unencrypted && <span className="pill pill--warn">unencrypted</span>}
            </div>
            <div className="term-endpoint">
              {host ? `${host.username}@${host.hostname}` : tab.endpoint}
              {host && host.port !== 22 ? `:${host.port}` : ""}
            </div>
          </div>
        </div>
        <div className="term-actions">
          <button
            className="term-action"
            title={`Reconnect ${fs.label} session`}
            onClick={() => void reconnect()}
          >
            <Icon name="link" size={15} />
          </button>
          {!embedded && (
            <>
              <button className="term-action" title="Home" onClick={() => home && navigate(home)}>
                <Icon name="home" size={15} />
              </button>
              <button
                className="term-action"
                title="New folder"
                onClick={() => setDialog({ type: "mkdir", value: "" })}
              >
                <Icon name="folder-plus" size={15} />
              </button>
            </>
          )}
          <button
            className="term-action"
            title="Upload"
            onClick={(event) => {
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({
                x: rect.right - 210,
                y: rect.bottom + 6,
                items: [
                  { label: "Upload files…", icon: "upload", onClick: () => void pickFiles(false) },
                  { label: "Upload folder…", icon: "folder", onClick: () => void pickFiles(true) },
                ],
              });
            }}
          >
            <Icon name="upload" size={15} />
          </button>
          <button
            className="term-action term-action--accent"
            title="Download selection"
            disabled={selectedFiles.length === 0}
            onClick={() => void downloadTo(selectedFiles)}
          >
            <Icon name="download" size={15} />
          </button>
          <button
            className="term-action"
            title="More"
            onClick={(event) => {
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: rect.right - 220, y: rect.bottom + 6, items: backgroundMenu() });
            }}
          >
            <Icon name="more-horizontal" size={16} />
          </button>
          {embedded && onCollapse && (
            <button
              className="term-action"
              title="Collapse files panel"
              onClick={onCollapse}
            >
              <Icon name="chevron-right" size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="filebar">
        <button className="icon-btn" title="Up" onClick={() => navigate(parentPath(currentPath))}>
          <Icon name="arrow-up" size={16} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <Icon name="refresh" size={15} className={loading ? "spin" : ""} />
        </button>
        {pathEditing ? (
          <input
            className="path-input"
            autoFocus
            value={pathDraft}
            spellCheck={false}
            onChange={(event) => setPathDraft(event.target.value)}
            onBlur={() => setPathEditing(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setPathEditing(false);
                navigate(pathDraft.trim() || "/");
              }
              if (event.key === "Escape") setPathEditing(false);
            }}
          />
        ) : (
          <div className="breadcrumbs" title="Click to navigate">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="crumb-wrap">
                {index > 0 && <Icon name="chevron-right" size={12} className="crumb-sep" />}
                <button className="crumb" onClick={() => navigate(crumb.path)}>
                  {crumb.name}
                </button>
              </span>
            ))}
            <button
              className="crumb-edit"
              title="Edit path"
              onClick={() => {
                setPathDraft(currentPath);
                setPathEditing(true);
              }}
            >
              <Icon name="edit" size={12} />
            </button>
          </div>
        )}
        <span className="spacer" />
        {selectedFiles.length > 0 ? (
          <div className="selection-bar">
            <span>
              {selectedFiles.length} selected ·{" "}
              {formatBytes(selectedFiles.reduce((sum, f) => sum + (f.isDir ? 0 : f.size), 0))}
            </span>
            <button className="icon-btn" title="Download" onClick={() => void downloadTo(selectedFiles)}>
              <Icon name="download" size={15} />
            </button>
            <button className="icon-btn" title="Delete" onClick={() => deleteFiles(selectedFiles)}>
              <Icon name="trash" size={15} />
            </button>
            <button className="icon-btn" title="Clear selection" onClick={() => setSelected(new Set())}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : (
          <span className="filebar-hint">{listing ? `${sorted.length} items` : ""}</span>
        )}
      </div>

      <div
        className={`sftp-surface ${dropActive ? "is-drop-target" : ""}`}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, items: backgroundMenu() });
        }}
      >
        <div className="file-table">
          <div className="file-head">
            <button className="file-col file-col--name" onClick={() => changeSort("name")}>
              Name <span className="sort-arrow">{sortArrow("name")}</span>
            </button>
            <button className="file-col file-col--size" onClick={() => changeSort("size")}>
              Size <span className="sort-arrow">{sortArrow("size")}</span>
            </button>
            <button className="file-col file-col--modified" onClick={() => changeSort("modified")}>
              Modified <span className="sort-arrow">{sortArrow("modified")}</span>
            </button>
            <span className="file-col file-col--mode">Permissions</span>
          </div>

          <div
            className={`file-body ${loading ? "is-refreshing" : ""}`}
            onClick={(event) => {
              if (event.target === event.currentTarget) setSelected(new Set());
            }}
          >
            {loading && !listing ? (
              <div className="skeleton-list">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div className="skeleton-row" key={index}>
                    <span className="skeleton-icon" />
                    <span className="skeleton-line" style={{ width: `${30 + ((index * 13) % 40)}%` }} />
                    <span className="skeleton-line skeleton-line--sm" />
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="sftp-state">
                <div className="empty-orb">
                  <Icon name="alert-triangle" size={24} />
                </div>
                <h3>Could not open this folder</h3>
                <p>{error}</p>
                <div className="overlay-actions">
                  <button className="btn btn-primary" onClick={() => void reconnect()}>
                    <Icon name="link" size={14} /> Reconnect
                  </button>
                  <button className="btn" onClick={refresh}>
                    <Icon name="refresh" size={14} /> Retry listing
                  </button>
                  <button className="btn" onClick={() => tab.hostId && openHostEditor(host ?? undefined)}>
                    Edit host
                  </button>
                  <button className="btn btn-ghost" onClick={() => closeTab(tab.id)}>
                    Close tab
                  </button>
                </div>
              </div>
            ) : sorted.length === 0 ? (
              <div className="sftp-state">
                <div className="empty-orb">
                  <Icon name="folder" size={24} />
                </div>
                <h3>This folder is empty</h3>
                <p>Drop files here, or use the upload button above.</p>
                <button className="btn" onClick={() => void pickFiles(false)}>
                  <Icon name="upload" size={15} /> Upload files
                </button>
              </div>
            ) : (
              sorted.map((file, index) => (
                <div
                  key={file.path}
                  className={`file-row ${selected.has(file.path) ? "is-selected" : ""} ${
                    file.isDir ? "is-dir" : ""
                  }`}
                  role="row"
                  tabIndex={0}
                  onClick={(event) => handleRowClick(event, file, index)}
                  onDoubleClick={() => openFile(file)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!selected.has(file.path)) setSelected(new Set([file.path]));
                    setMenu({ x: event.clientX, y: event.clientY, items: rowMenu(file) });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openFile(file);
                    if (event.key === "Delete") deleteFiles([file]);
                  }}
                >
                  <span className="file-name-cell">
                    <span className={`file-icon ${file.isDir ? "is-folder" : ""}`}>
                      <Icon name={iconFor(file)} size={16} />
                    </span>
                    <span className="file-name" title={file.name}>
                      {file.name}
                    </span>
                    {file.isSymlink && <span className="pill pill--tiny">link</span>}
                  </span>
                  <span className="file-col file-col--size">
                    {file.isDir ? "—" : formatBytes(file.size)}
                  </span>
                  <span className="file-col file-col--modified">{formatDate(file.modified)}</span>
                  <span className="file-col file-col--mode">
                    <span className="mode-text">{file.mode}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {dropActive && (
          <div className="drop-overlay">
            <div className="drop-card">
              <Icon name="upload" size={26} />
              <strong>Drop to upload</strong>
              <span>Files go to {currentPath}</span>
            </div>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      <Modal
        open={dialog?.type === "mkdir"}
        onClose={() => setDialog(null)}
        title="New folder"
        width={420}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary primary-action"
              onClick={() => dialog?.type === "mkdir" && void createFolder(dialog.value)}
            >
              Create folder
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="new-folder">Folder name</label>
          <input
            id="new-folder"
            className="input"
            autoFocus
            value={dialog?.type === "mkdir" ? dialog.value : ""}
            placeholder="logs"
            onChange={(event) => setDialog({ type: "mkdir", value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && dialog?.type === "mkdir") void createFolder(dialog.value);
            }}
          />
          <span className="hint">Created in {currentPath}</span>
        </div>
      </Modal>

      <Modal
        open={dialog?.type === "rename"}
        onClose={() => setDialog(null)}
        title="Rename"
        width={420}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary primary-action"
              onClick={() =>
                dialog?.type === "rename" && void renameFile(dialog.file, dialog.value)
              }
            >
              Rename
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="rename-file">New name</label>
          <input
            id="rename-file"
            className="input"
            autoFocus
            value={dialog?.type === "rename" ? dialog.value : ""}
            onChange={(event) =>
              dialog?.type === "rename" && setDialog({ ...dialog, value: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && dialog?.type === "rename")
                void renameFile(dialog.file, dialog.value);
            }}
          />
        </div>
      </Modal>

      <Modal
        open={dialog?.type === "chmod"}
        onClose={() => setDialog(null)}
        title="Change permissions"
        subtitle={dialog?.type === "chmod" ? dialog.file.path : undefined}
        width={420}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary primary-action"
              onClick={() => dialog?.type === "chmod" && void chmodFile(dialog.file, dialog.value)}
            >
              Apply
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="chmod-mode">Octal mode</label>
          <input
            id="chmod-mode"
            className="input input--mono"
            autoFocus
            value={dialog?.type === "chmod" ? dialog.value : ""}
            placeholder="755"
            onChange={(event) =>
              dialog?.type === "chmod" && setDialog({ ...dialog, value: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && dialog?.type === "chmod")
                void chmodFile(dialog.file, dialog.value);
            }}
          />
          <span className="hint">For example 644 for files, 755 for folders.</span>
        </div>
      </Modal>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.file.name ?? "Preview"}
        subtitle="Read-only preview · up to 512 KB"
        width={820}
        className="modal--wide"
        footer={
          <>
            <span className="spacer" />
            <button
              className="btn"
              onClick={() => {
                if (preview) void downloadTo([preview.file]);
              }}
            >
              <Icon name="download" size={14} /> Download
            </button>
            <button className="btn btn-primary" onClick={() => setPreview(null)}>
              Close
            </button>
          </>
        }
      >
        {preview?.loading ? (
          <div className="preview-loading">
            <Icon name="loader" size={20} className="spin" /> Loading file…
          </div>
        ) : preview?.content === "__BINARY__" ? (
          <div className="preview-binary">
            <Icon name="hard-drive" size={24} />
            <p>This looks like a binary file and cannot be previewed as text.</p>
          </div>
        ) : (
          <pre className="preview-body">{preview?.content}</pre>
        )}
      </Modal>
    </div>
  );
}
