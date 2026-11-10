import { useEffect, useMemo, useRef, useState } from "react";

import { Icon, type IconName } from "./Icon";
import { api } from "../lib/api";
import { hostColor, initials, fuzzyScore, relativeTime } from "../lib/utils";
import { useStore } from "../store";
import type { Host, PageKind, Snippet } from "../lib/types";

interface PaletteItem {
  id: string;
  kind: "host" | "action" | "snippet";
  title: string;
  subtitle: string;
  icon: IconName;
  hint?: string;
  host?: Host;
  snippet?: Snippet;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const hosts = useStore((s) => s.hosts);
  const localShells = useStore((s) => s.localShells);
  const snippets = useStore((s) => s.snippets);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const settings = useStore((s) => s.settings);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const activeEl = listRef.current?.querySelector<HTMLElement>(".palette-item.is-active");
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runInActiveTerminal = (command: string) => {
    const state = useStore.getState();
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    const lastTerminal = state.tabs.find(
      (t) => t.id === state.lastTerminalId && t.kind === "terminal" && t.sessionId,
    );
    const target =
      activeTab?.kind === "terminal" && activeTab.sessionId
        ? activeTab
        : lastTerminal ?? state.tabs.find((t) => t.kind === "terminal" && t.sessionId);
    if (target?.sessionId) {
      void api.terminalRun(target.sessionId, command);
      state.addToast({ type: "info", title: "Snippet sent", message: target.title });
    } else {
      void navigator.clipboard.writeText(command);
      state.addToast({
        type: "info",
        title: "No active terminal",
        message: "Snippet copied to the clipboard instead.",
      });
    }
  };

  const items = useMemo<PaletteItem[]>(() => {
    const state = useStore.getState();
    const shellActions: PaletteItem[] = localShells.map((shell, index) => ({
      id: `local-shell-${shell.id}`,
      kind: "action",
      title: index === 0 ? "Open local shell" : `Local shell · ${shell.label}`,
      subtitle: `${shell.label} · ${shell.command}`,
      icon: "terminal",
      hint: index === 0 ? "Ctrl Shift T" : undefined,
      run: () => state.openLocalShell(shell.id),
    }));
    const actions: PaletteItem[] = [
      {
        id: "new-host",
        kind: "action",
        title: "New host",
        subtitle: "Save a server with its credentials",
        icon: "plus",
        hint: "Ctrl N",
        run: () => state.openHostEditor(),
      },
      ...shellActions,
      {
        id: "new-group",
        kind: "action",
        title: "New group",
        subtitle: "Organise hosts into a group",
        icon: "folder-plus",
        run: () => state.openGroupEditor(),
      },
      {
        id: "import-ssh",
        kind: "action",
        title: "Import from ~/.ssh/config",
        subtitle: "Bring over hosts and identity files",
        icon: "download",
        run: () => void state.importSshConfig(),
      },
      {
        id: "theme",
        kind: "action",
        title: "Toggle light / dark theme",
        subtitle: `Currently ${settings.theme}`,
        icon: settings.theme === "light" ? "moon" : "sun",
        run: () =>
          state.updateSettings({ theme: settings.theme === "light" ? "dark" : "light" }),
      },
    ];
    const pages: PageKind[] = ["snippets", "forwards", "keys", "known", "settings"];
    const pageMeta: Record<PageKind, { title: string; subtitle: string; icon: IconName }> = {
      snippets: {
        title: "Open snippets",
        subtitle: "Reusable command palette entries",
        icon: "code",
      },
      forwards: {
        title: "Open port forwarding",
        subtitle: "Local, remote and SOCKS5 tunnels",
        icon: "swap",
      },
      keys: {
        title: "Open SSH keys",
        subtitle: "Generate, import and copy public keys",
        icon: "key",
      },
      known: {
        title: "Open known hosts",
        subtitle: "Review trusted server keys",
        icon: "shield",
      },
      settings: {
        title: "Open settings",
        subtitle: "Appearance, terminal and connections",
        icon: "settings",
      },
    };
    for (const page of pages) {
      actions.push({
        id: `page-${page}`,
        kind: "action",
        title: pageMeta[page].title,
        subtitle: pageMeta[page].subtitle,
        icon: pageMeta[page].icon,
        run: () => state.openPage(page),
      });
    }

    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.kind === "terminal" && activeTab.sessionId && !activeTab.localShell) {
      actions.unshift({
        id: "reconnect-active",
        kind: "action",
        title: "Reconnect active session",
        subtitle: activeTab.title,
        icon: "refresh",
        run: () => activeTab.sessionId && void api.terminalReconnect(activeTab.sessionId),
      });
    }

    const hostItems: PaletteItem[] = hosts.map((host) => ({
      id: `host-${host.id}`,
      kind: "host",
      title: host.label,
      subtitle: `${host.protocol === "ftp" ? "FTP · " : ""}${host.username}@${host.hostname}${
        host.port !== 22 ? `:${host.port}` : ""
      }${host.tags.length ? ` · ${host.tags.join(", ")}` : ""}`,
      icon: "server",
      hint: host.lastUsedAt ? relativeTime(host.lastUsedAt) : undefined,
      host,
      run: () => state.connectHost(host.id),
    }));

    const snippetItems: PaletteItem[] = snippets.map((snippet) => ({
      id: `snippet-${snippet.id}`,
      kind: "snippet",
      title: snippet.label,
      subtitle: snippet.command,
      icon: "code",
      snippet,
      run: () => runInActiveTerminal(snippet.command),
    }));

    const all = [...actions, ...hostItems, ...snippetItems];
    if (!query.trim()) {
      const favorites = hosts.filter((h) => h.favorite).length;
      const recentHosts = [...hosts]
        .filter((h) => h.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 4);
      const orderedHosts = favorites
        ? recentHosts
        : [...hosts].slice(0, 6);
      const rest = all.filter((i) => i.kind === "action");
      const hostSection = [...recentHosts, ...orderedHosts]
        .filter((h, index, arr) => arr.findIndex((x) => x.id === h.id) === index)
        .map((host) => hostItems.find((i) => i.host?.id === host.id)!)
        .filter(Boolean);
      return [...rest, ...hostSection, ...snippetItems.slice(0, 3)];
    }
    return all
      .map((item) => ({
        item,
        score: Math.max(
          fuzzyScore(query, item.title),
          fuzzyScore(query, item.subtitle) * 0.55,
        ) + (item.kind === "host" ? 8 : 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((entry) => entry.item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, hosts, localShells, snippets, tabs, activeTabId, settings.theme]);

  if (!open) return null;

  const close = () => setOpen(false);

  const activate = (index: number, sftp = false) => {
    const item = items[index];
    if (!item) return;
    close();
    if (sftp && item.host) {
      useStore.getState().openFileBrowser(item.host.id);
    } else {
      item.run();
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true">
        <div className="palette-input-row">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search hosts, snippets or commands…"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(active, event.ctrlKey || event.metaKey);
              }
            }}
          />
          <kbd className="palette-esc">esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="palette-empty">
              <Icon name="search" size={20} />
              <span>No results for “{query}”</span>
            </div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.id}
                className={`palette-item ${index === active ? "is-active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={(event) => {
                  close();
                  if (item.host && (event.ctrlKey || event.metaKey)) {
                    useStore.getState().openFileBrowser(item.host.id);
                  } else {
                    item.run();
                  }
                }}
              >
                {item.host ? (
                  <span
                    className="avatar avatar--sm"
                    style={{
                      background: `linear-gradient(145deg, ${hostColor(item.host)}e6, ${hostColor(
                        item.host,
                      )}80)`,
                    }}
                  >
                    {initials(item.host.label)}
                  </span>
                ) : (
                  <span className={`palette-icon palette-icon--${item.kind}`}>
                    <Icon name={item.icon} size={16} />
                  </span>
                )}
                <span className="palette-text">
                  <span className="palette-title">{item.title}</span>
                  <span className="palette-subtitle">{item.subtitle}</span>
                </span>
                {item.kind === "snippet" && <span className="pill pill--tiny">snippet</span>}
                {item.hint && <span className="palette-hint">{item.hint}</span>}
                {index === active && (
                  <span className="palette-enter">
                    <Icon name="arrow-right" size={13} />
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> select
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>↵</kbd> open SFTP
          </span>
          <span className="spacer" />
          <span className="palette-brand">
            <Icon name="terminal" size={12} /> Terminion
          </span>
        </div>
      </div>
    </div>
  );
}
