import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./Icon";
import { SftpView } from "./SftpView";
import { api } from "../lib/api";
import { mountTerminal, terminalRegistry } from "../lib/term";
import { terminalTheme } from "../lib/terminalThemes";
import { hostColor, initials } from "../lib/utils";
import { useStore } from "../store";
import type { Tab } from "../lib/types";

function statusLabel(tab: Tab) {
  switch (tab.status) {
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "reconnecting":
      return `Reconnecting${tab.attempt ? ` · ${tab.attempt}` : ""}`;
    case "disconnected":
      return "Disconnected";
    default:
      return "Idle";
  }
}

function TerminalPane({
  tab,
  active,
  onSearch,
}: {
  tab: Tab;
  active: boolean;
  onSearch: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !tab.hostId) return;
    let disposed = false;
    const element = ref.current;
    void mountTerminal(tab.id, tab.hostId, element, { onSearch }).then((handle) => {
      if (disposed) {
        handle.dispose();
      } else if (active) {
        requestAnimationFrame(() => {
          handle.fitNow();
          handle.focus();
        });
      }
    });
    return () => {
      disposed = true;
      terminalRegistry.get(tab.id)?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      const handle = terminalRegistry.get(tab.id);
      handle?.fitNow();
      handle?.focus();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [active, tab.id]);

  return <div className="term-host" ref={ref} />;
}

const SEARCH_DECORATIONS = {
  matchBackground: "#7c5cff55",
  matchBorder: "#7c5cffaa",
  matchOverviewRuler: "#7c5cff",
  activeMatchBackground: "#22d3a6aa",
  activeMatchBorder: "#22d3a6",
  activeMatchColorOverviewRuler: "#22d3a6",
};

export function TerminalView({
  tab,
  active,
  splitMode = false,
  onUnsplit,
}: {
  tab: Tab;
  active: boolean;
  splitMode?: boolean;
  onUnsplit?: () => void;
}) {
  const hosts = useStore((s) => s.hosts);
  const keys = useStore((s) => s.keys);
  const snippets = useStore((s) => s.snippets);
  const settings = useStore((s) => s.settings);
  const openSftp = useStore((s) => s.openSftp);
  const arrangeSplit = useStore((s) => s.arrangeSplit);
  const openHostEditor = useStore((s) => s.openHostEditor);
  const openPage = useStore((s) => s.openPage);
  const closeTab = useStore((s) => s.closeTab);
  const addToast = useStore((s) => s.addToast);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [filesMounted, setFilesMounted] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const host = hosts.find((h) => h.id === tab.hostId) ?? null;
  const theme = terminalTheme(settings.terminalTheme);
  const color = host ? hostColor(host) : "#7c5cff";

  const filesTab = useMemo<Tab>(
    () => ({
      id: `${tab.id}::files`,
      kind: "sftp",
      fileProtocol: "sftp",
      title: `${host?.label ?? tab.title} · SFTP`,
      subtitle: host ? `${host.username}@${host.hostname}` : undefined,
      hostId: tab.hostId,
      status: "idle",
    }),
    [host?.label, host?.hostname, host?.username, tab.hostId, tab.id, tab.title],
  );

  const closeFiles = () => {
    setFilesOpen(false);
    window.setTimeout(() => terminalRegistry.get(tab.id)?.focus(), 40);
  };

  const toggleFiles = () => {
    if (!tab.hostId) return;
    if (!filesMounted) {
      setFilesMounted(true);
      setFilesOpen(true);
      return;
    }
    if (filesOpen) closeFiles();
    else setFilesOpen(true);
  };

  useEffect(() => {
    if (!filesMounted) return;
    const timer = window.setTimeout(() => {
      terminalRegistry.get(tab.id)?.fitNow();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [filesMounted, filesOpen, tab.id]);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) {
      terminalRegistry.get(tab.id)?.search.clearDecorations();
    }
  }, [searchOpen, tab.id]);

  const runSearch = (direction: "next" | "prev") => {
    const handle = terminalRegistry.get(tab.id);
    if (!handle || !query) return;
    const options = { decorations: SEARCH_DECORATIONS, caseSensitive: false };
    if (direction === "next") handle.search.findNext(query, options);
    else handle.search.findPrevious(query, options);
  };

  const copySelection = () => {
    const selection = terminalRegistry.get(tab.id)?.term.getSelection();
    if (selection) {
      void navigator.clipboard.writeText(selection);
      addToast({ type: "success", title: "Copied to clipboard" });
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const handle = terminalRegistry.get(tab.id);
      if (text && handle) handle.term.paste(text);
    } catch {
      addToast({ type: "warning", title: "Clipboard is not available" });
    }
  };

  const reconnect = () => {
    if (!tab.sessionId) return;
    api.terminalReconnect(tab.sessionId).catch((err) => {
      addToast({ type: "error", title: "Could not reconnect", message: String(err) });
    });
  };

  const terminalMenu = (): MenuItem[] => [
    {
      label: "Copy",
      icon: "copy",
      hint: "Ctrl Shift C",
      onClick: copySelection,
    },
    {
      label: "Paste",
      icon: "clipboard",
      hint: "Ctrl V",
      onClick: () => void pasteClipboard(),
    },
    {
      label: "Select all",
      icon: "check",
      onClick: () => terminalRegistry.get(tab.id)?.term.selectAll(),
    },
    {
      label: "Search",
      icon: "search",
      hint: "Ctrl F",
      onClick: () => setSearchOpen(true),
    },
    { separator: true },
    {
      label: "Clear buffer",
      icon: "trash",
      onClick: () => terminalRegistry.get(tab.id)?.term.clear(),
    },
    {
      label: filesOpen ? "Hide files panel" : "Show files panel",
      icon: "folder",
      onClick: toggleFiles,
    },
    {
      label: "Open SFTP in new tab",
      icon: "folder",
      onClick: () => tab.hostId && openSftp(tab.hostId),
    },
    ...(splitMode
      ? [
          {
            label: "Layout: 2 top + 1 bottom",
            icon: "menu" as const,
            onClick: () => arrangeSplit("two-top-one-bottom"),
          },
        ]
      : []),
    {
      label: "Edit host",
      icon: "edit",
      onClick: () => host && openHostEditor(host),
    },
    { separator: true },
    {
      label: "Reconnect",
      icon: "refresh",
      disabled: !tab.sessionId,
      onClick: reconnect,
    },
    {
      label: "Close tab",
      icon: "x",
      danger: true,
      onClick: () => closeTab(tab.id),
    },
  ];

  const snippetItems = (): MenuItem[] => {
    const items: MenuItem[] = snippets.slice(0, 9).map((snippet) => ({
      label: snippet.label,
      icon: "code",
      hint: snippet.command.length > 28 ? `${snippet.command.slice(0, 28)}…` : snippet.command,
      disabled: !tab.sessionId,
      onClick: () => {
        if (!tab.sessionId) return;
        api.terminalRun(tab.sessionId, snippet.command).catch(() => {});
      },
    }));
    if (items.length === 0) {
      items.push({ label: "No snippets yet", disabled: true });
    }
    items.push({ separator: true });
    items.push({
      label: "Manage snippets",
      icon: "settings",
      onClick: () => openPage("snippets"),
    });
    return items;
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: terminalMenu() });
  };

  const onMenuButton = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: rect.right - 220, y: rect.bottom + 6, items });
  };

  const keyName = host?.keyId ? keys.find((k) => k.id === host.keyId)?.name : null;

  return (
    <div className="term-view">
      <div className="term-column">
      <div className="term-toolbar">
        <div className="term-identity">
          {host ? (
            <span
              className="avatar avatar--sm"
              style={{
                background: `linear-gradient(145deg, ${color}e6, ${color}80)`,
              }}
            >
              {initials(host.label)}
            </span>
          ) : (
            <span className="avatar avatar--sm" style={{ background: "#374151" }}>
              ?
            </span>
          )}
          <div className="term-titles">
            <div className="term-title-row">
              <span className="term-title">{host?.label ?? tab.title}</span>
              <span className={`status-pill ${tab.status}`}>
                <span className="status-dot" />
                {statusLabel(tab)}
              </span>
              {tab.keyType && (
                <span className="pill pill--muted" title={tab.fingerprint}>
                  {tab.keyType.replace("ssh-", "")}
                </span>
              )}
            </div>
            <div className="term-endpoint">
              {host ? `${host.username}@${host.hostname}` : tab.subtitle}
              {host && host.port !== 22 ? `:${host.port}` : ""}
              {keyName ? ` · ${keyName}` : ""}
            </div>
          </div>
        </div>

        <div className="term-actions">
          {tab.status === "disconnected" && (
            <button className="term-action term-action--accent" onClick={reconnect}>
              <Icon name="refresh" size={14} />
              Reconnect
            </button>
          )}
          <button
            className="term-action"
            title="Snippets"
            onClick={(event) => onMenuButton(event, snippetItems())}
          >
            <Icon name="code" size={15} />
          </button>
          <button
            className="term-action"
            title="Search (Ctrl+F)"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Icon name="search" size={15} />
          </button>
          <button
            className={`term-action ${filesOpen ? "term-action--accent" : ""}`}
            title={filesOpen ? "Hide SFTP panel" : "Show SFTP panel"}
            disabled={!tab.hostId}
            onClick={toggleFiles}
          >
            <Icon name="folder" size={15} />
          </button>
          {splitMode && onUnsplit && (
            <button
              className="term-action"
              title="Maximize this pane and exit split"
              onClick={onUnsplit}
            >
              <Icon name="arrow-up-right" size={15} />
            </button>
          )}
          <button
            className="term-action"
            title="More"
            onClick={(event) => onMenuButton(event, terminalMenu())}
          >
            <Icon name="more-horizontal" size={16} />
          </button>
        </div>
      </div>

      <div
        className="term-surface"
        style={{ background: theme.background }}
        onContextMenu={onContextMenu}
      >
        <TerminalPane
          tab={tab}
          active={active}
          onSearch={() => setSearchOpen(true)}
        />

        {searchOpen && (
          <div className="term-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Find in terminal…"
              onChange={(event) => {
                setQuery(event.target.value);
                const handle = terminalRegistry.get(tab.id);
                if (handle && event.target.value) {
                  handle.search.findNext(event.target.value, {
                    incremental: true,
                    decorations: SEARCH_DECORATIONS,
                    caseSensitive: false,
                  });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch(event.shiftKey ? "prev" : "next");
                }
                if (event.key === "Escape") {
                  setSearchOpen(false);
                  terminalRegistry.get(tab.id)?.focus();
                }
              }}
            />
            <span className="term-search-count">{query ? "↵ next" : ""}</span>
            <button className="icon-btn" title="Previous" onClick={() => runSearch("prev")}>
              <Icon name="chevron-left" size={15} />
            </button>
            <button className="icon-btn" title="Next" onClick={() => runSearch("next")}>
              <Icon name="chevron-right" size={15} />
            </button>
            <button className="icon-btn" title="Close" onClick={() => setSearchOpen(false)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        {tab.status === "reconnecting" && (
          <div className="reconnect-banner">
            <Icon name="loader" size={15} className="spin" />
            <div className="reconnect-text">
              <strong>Connection lost</strong>
              <span>
                {tab.error || "Network interrupted"} · retrying
                {tab.attempt ? ` (attempt ${tab.attempt})` : ""}
              </span>
            </div>
            <button className="btn btn-sm" onClick={reconnect}>
              Retry now
            </button>
          </div>
        )}

        {tab.status === "disconnected" && (
          <div className="term-overlay">
            <div className="term-overlay-card">
              <div className="overlay-icon">
                <Icon
                  name={tab.error?.includes("Authentication") ? "lock" : "wifi-off"}
                  size={22}
                />
              </div>
              <h3>
                {tab.error?.includes("Authentication")
                  ? "Authentication failed"
                  : "Session disconnected"}
              </h3>
              <p>{tab.error || "The connection to this host is closed."}</p>
              <div className="overlay-actions">
                <button className="btn btn-primary" onClick={reconnect}>
                  <Icon name="refresh" size={14} /> Reconnect
                </button>
                {host && (
                  <button className="btn" onClick={() => openHostEditor(host)}>
                    <Icon name="edit" size={14} /> Edit host
                  </button>
                )}
                <button className="btn btn-ghost" onClick={() => closeTab(tab.id)}>
                  Close tab
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {filesMounted && (
        <aside className={`term-files-panel ${filesOpen ? "is-open" : ""}`}>
          <SftpView
            tab={filesTab}
            active={active && filesOpen}
            embedded
            onCollapse={closeFiles}
          />
        </aside>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
