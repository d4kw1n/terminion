import { useMemo, useState } from "react";
import type { MouseEvent } from "react";

import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./Icon";
import { useStore } from "../store";
import { hostToInput, parseQuickConnect } from "../lib/hosts";
import { hostColor, initials, relativeTime } from "../lib/utils";
import type { Group, Host } from "../lib/types";

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

const UNGROUPED = "__ungrouped";
const FAVORITES = "__favorites";

function groupKey(groupId: number | null) {
  return groupId === null ? UNGROUPED : `g-${groupId}`;
}

export function HostSidebar() {
  const hosts = useStore((s) => s.hosts);
  const groups = useStore((s) => s.groups);
  const tabs = useStore((s) => s.tabs);
  const search = useStore((s) => s.search);
  const collapsed = useStore((s) => s.collapsed);
  const setSearch = useStore((s) => s.setSearch);
  const toggleGroup = useStore((s) => s.toggleGroup);
  const openTerminal = useStore((s) => s.openTerminal);
  const localShells = useStore((s) => s.localShells);
  const openLocalShell = useStore((s) => s.openLocalShell);
  const connectHost = useStore((s) => s.connectHost);
  const openFileBrowser = useStore((s) => s.openFileBrowser);
  const openHostEditor = useStore((s) => s.openHostEditor);
  const openGroupEditor = useStore((s) => s.openGroupEditor);
  const deleteHost = useStore((s) => s.deleteHost);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const importSshConfig = useStore((s) => s.importSshConfig);
  const askConfirm = useStore((s) => s.askConfirm);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const liveByHost = useMemo(() => {
    const map = new Map<number, "connected" | "reconnecting" | "connecting">();
    for (const tab of tabs) {
      if (tab.kind !== "terminal" || !tab.hostId) continue;
      if (tab.status === "connected" || tab.status === "reconnecting" || tab.status === "connecting") {
        const existing = map.get(tab.hostId);
        if (existing !== "connected") {
          map.set(tab.hostId, tab.status === "connecting" ? "connecting" : tab.status);
        }
      }
    }
    return map;
  }, [tabs]);

  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return hosts;
    return hosts.filter((host) => {
      const haystack = [host.label, host.hostname, host.username, ...host.tags]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [hosts, query]);

  const quick = parseQuickConnect(search);

  const openShellMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] =
      localShells.length > 0
        ? localShells.map((shell) => ({
            label: shell.label,
            icon: "terminal" as const,
            hint: shell.command,
            onClick: () => openLocalShell(shell.id),
          }))
        : [{ label: "No local shell found", disabled: true }];
    setMenu({ x: rect.left, y: rect.top - 8, items });
  };

  const favorites = filtered.filter((h) => h.favorite);
  const byGroup = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const host of filtered) {
      if (host.favorite && !query) continue;
      const key = groupKey(host.groupId);
      const list = map.get(key) ?? [];
      list.push(host);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    }
    return map;
  }, [filtered, query]);

  const hostMenu = (host: Host): MenuItem[] => [
    {
      label: host.protocol === "ftp" ? "Browse files" : "Connect",
      icon: host.protocol === "ftp" ? "folder" : "terminal",
      onClick: () => connectHost(host.id),
    },
    {
      label: host.protocol === "ftp" ? "Open FTP browser" : "Open SFTP",
      icon: "folder",
      onClick: () => openFileBrowser(host.id),
    },
    { separator: true },
    {
      label: "Edit host",
      icon: "edit",
      onClick: () => openHostEditor(host),
    },
    {
      label: "Duplicate",
      icon: "copy",
      onClick: () =>
        openHostEditor(null, {
          ...hostToInput(host),
          id: null,
          label: `${host.label} copy`,
          password: null,
          favorite: false,
        }),
    },
    {
      label: host.favorite ? "Remove from favorites" : "Add to favorites",
      icon: host.favorite ? "star-filled" : "star",
      onClick: () => void toggleFavorite(host),
    },
    { separator: true },
    ...(host.protocol === "ssh"
      ? [
          {
            label: "Copy SSH command",
            icon: "copy" as const,
            onClick: () => {
              const port = host.port !== 22 ? ` -p ${host.port}` : "";
              void navigator.clipboard.writeText(
                `ssh ${host.username}@${host.hostname}${port}`,
              );
            },
          },
        ]
      : []),
    {
      label: "Copy address",
      icon: "link",
      onClick: () => void navigator.clipboard.writeText(`${host.username}@${host.hostname}`),
    },
    { separator: true },
    {
      label: "Delete host",
      icon: "trash",
      danger: true,
      onClick: () =>
        askConfirm({
          title: `Delete “${host.label}”?`,
          message:
            "The host and its saved credentials will be removed from this device. Open sessions are closed.",
          confirmLabel: "Delete host",
          danger: true,
          onConfirm: () => void deleteHost(host.id),
        }),
    },
  ];

  const groupMenu = (group: Group): MenuItem[] => [
    {
      label: "New host here",
      icon: "plus",
      onClick: () => openHostEditor(null, { groupId: group.id }),
    },
    {
      label: "Edit group",
      icon: "edit",
      onClick: () => openGroupEditor(group),
    },
    { separator: true },
    {
      label: "Delete group",
      icon: "trash",
      danger: true,
      onClick: () =>
        askConfirm({
          title: `Delete “${group.name}”?`,
          message: "Hosts in this group will stay, but move to Ungrouped.",
          confirmLabel: "Delete group",
          danger: true,
          onConfirm: () => void deleteGroup(group.id),
        }),
    },
  ];

  const showMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const showMenuForButton = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: rect.left - 150, y: rect.bottom + 4, items });
  };

  const connect = (host: Host) => connectHost(host.id);

  const renderHost = (host: Host, showGroup = false) => {
    const live = liveByHost.get(host.id);
    const color = hostColor(host);
    const groupName = groups.find((g) => g.id === host.groupId)?.name;
    return (
      <div
        key={host.id}
        className={`host-row ${live ? "is-live" : ""}`}
        role="button"
        tabIndex={0}
        onDoubleClick={() => connect(host)}
        onContextMenu={(event) => showMenu(event, hostMenu(host))}
        onKeyDown={(event) => {
          if (event.key === "Enter") connect(host);
          if (event.key === "ContextMenu") {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({ x: rect.left + 40, y: rect.top + 20, items: hostMenu(host) });
          }
        }}
        title={`${host.username}@${host.hostname}:${host.port}${
          host.tags.length ? ` · ${host.tags.join(", ")}` : ""
        } · double-click to connect`}
      >
        <span
          className="avatar"
          style={{
            background: `linear-gradient(145deg, ${color}e6, ${color}80)`,
            boxShadow: `0 4px 14px -6px ${color}80`,
          }}
        >
          {initials(host.label)}
          {live && <span className={`avatar-live ${live}`} />}
        </span>
        <span className="host-main">
          <span className="host-name">
            {host.label}
            {host.favorite && (
              <Icon name="star-filled" size={11} className="host-star" />
            )}
          </span>
          <span className="host-sub">
            {host.protocol === "ftp" ? (
              <em className="host-protocol" title="Plain FTP (unencrypted)">FTP</em>
            ) : null}
            {host.username}@{host.hostname}
            {host.os ? (
              <em className="host-os-tag" title={host.os}>
                {host.os}
              </em>
            ) : null}
            {showGroup && groupName ? <em className="host-group-tag">{groupName}</em> : null}
          </span>
        </span>
        <span className="host-tail">
          <span className="host-actions">
            <button
              className="row-action"
              title={host.favorite ? "Unfavorite" : "Favorite"}
              onClick={(event) => {
                event.stopPropagation();
                void toggleFavorite(host);
              }}
            >
              <Icon name={host.favorite ? "star-filled" : "star"} size={14} />
            </button>
            <button
              className="row-action"
              title="More"
              onClick={(event) => showMenuForButton(event, hostMenu(host))}
            >
              <Icon name="more-horizontal" size={15} />
            </button>
          </span>
          {live ? (
            <span className={`host-live ${live}`} title={live} />
          ) : host.port !== 22 ? (
            <span className="port-badge">{host.port}</span>
          ) : (
            <span className="host-last" title="Last used">
              {relativeTime(host.lastUsedAt)}
            </span>
          )}
        </span>
      </div>
    );
  };

  const renderGroup = (key: string, label: string, list: Host[], group?: Group) => {
    const isCollapsed = collapsed[key];
    return (
      <section className="host-group" key={key}>
        <div
          className="group-head"
          onClick={() => toggleGroup(key)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter") toggleGroup(key);
          }}
        >
          <Icon
            name="chevron-right"
            size={13}
            className={`group-chevron ${isCollapsed ? "" : "is-open"}`}
          />
          <span
            className="group-dot"
            style={{ background: group?.color || "var(--text-faint)" }}
          />
          <span className="group-name">{label}</span>
          <span className="group-count">{list.length}</span>
          <button
            className="row-action group-more"
            title="Group options"
            onClick={(event) => {
              event.stopPropagation();
              if (group) showMenuForButton(event, groupMenu(group));
              else
                showMenuForButton(event, [
                  {
                    label: "New host",
                    icon: "plus",
                    onClick: () => openHostEditor(null, { groupId: null }),
                  },
                ]);
            }}
          >
            <Icon name="more-horizontal" size={14} />
          </button>
        </div>
        {!isCollapsed && (
          <div className="group-hosts">{list.map((host) => renderHost(host, Boolean(query)))}</div>
        )}
      </section>
    );
  };

  const hasGroups = groups.length > 0;
  const ungrouped = byGroup.get(UNGROUPED) ?? [];
  const totalHosts = hosts.length;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title-row">
          <h2 className="sidebar-title">Hosts</h2>
          <span className="count-pill">{totalHosts}</span>
          <span className="spacer" />
          <button
            className="icon-btn"
            title="New host (Ctrl N)"
            onClick={() => openHostEditor()}
          >
            <Icon name="plus" size={17} />
          </button>
          <button
            className="icon-btn"
            title="More"
            onClick={(event) =>
              showMenuForButton(event, [
                {
                  label: "New host",
                  icon: "plus",
                  hint: "Ctrl N",
                  onClick: () => openHostEditor(),
                },
                {
                  label: "New group",
                  icon: "folder-plus",
                  onClick: () => openGroupEditor(),
                },
                { separator: true },
                {
                  label: "Import from ~/.ssh/config",
                  icon: "download",
                  onClick: () => void importSshConfig(),
                },
                {
                  label: "Open SSH keys",
                  icon: "key",
                  onClick: () => useStore.getState().openPage("keys"),
                },
              ])
            }
          >
            <Icon name="more-horizontal" size={17} />
          </button>
        </div>
        <div className="search-field">
          <Icon name="search" size={15} className="search-icon" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search hosts, tags, ssh config…"
            spellCheck={false}
            aria-label="Search hosts"
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch("")} title="Clear">
              <Icon name="x" size={13} />
            </button>
          )}
          <kbd className="search-kbd">/</kbd>
        </div>
      </div>

      <div className="sidebar-scroll">
        {quick && (
          <button
            className="quick-row"
            onClick={() =>
              openHostEditor(null, {
                hostname: quick.hostname,
                port: quick.port,
                username: quick.username,
                label: quick.hostname,
              })
            }
          >
            <span className="quick-icon">
              <Icon name="zap" size={15} />
            </span>
            <span className="quick-main">
              <span className="quick-label">Quick connect</span>
              <span className="quick-sub">
                {quick.username}@{quick.hostname}:{quick.port}
              </span>
            </span>
            <Icon name="arrow-right" size={14} className="quick-arrow" />
          </button>
        )}

        {totalHosts === 0 ? (
          <div className="sidebar-empty">
            <div className="empty-orb">
              <Icon name="server" size={26} />
            </div>
            <h3>No hosts yet</h3>
            <p>Add your first server, or bring over everything from your SSH config.</p>
            <button className="btn btn-primary btn-block" onClick={() => openHostEditor()}>
              <Icon name="plus" size={16} /> New host
            </button>
            <button className="btn btn-block" onClick={() => void importSshConfig()}>
              <Icon name="download" size={15} /> Import SSH config
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="sidebar-empty sidebar-empty--compact">
            <div className="empty-orb empty-orb--sm">
              <Icon name="search" size={20} />
            </div>
            <h3>No matches</h3>
            <p>Nothing found for “{search}”.</p>
            <button className="btn btn-block" onClick={() => setSearch("")}>
              Clear search
            </button>
          </div>
        ) : query ? (
          <section className="host-group">
            <div className="group-head group-head--static">
              <Icon name="search" size={13} className="group-chevron is-open" />
              <span className="group-name">Results</span>
              <span className="group-count">{filtered.length}</span>
            </div>
            <div className="group-hosts">
              {filtered.map((host) => renderHost(host, true))}
            </div>
          </section>
        ) : (
          <>
            {favorites.length > 0 &&
              renderGroup(
                FAVORITES,
                "Favorites",
                [...favorites].sort((a, b) =>
                  a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
                ),
              )}
            {groups.map((group) =>
              renderGroup(`g-${group.id}`, group.name, byGroup.get(`g-${group.id}`) ?? [], group),
            )}
            {ungrouped.length > 0 &&
              renderGroup(UNGROUPED, hasGroups ? "Ungrouped" : "Connections", ungrouped)}
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="sidebar-add" onClick={() => openHostEditor()}>
          <Icon name="plus" size={15} />
          New host
        </button>
        <button
          className="icon-btn"
          title="Local shell (Ctrl+Shift+T)"
          aria-label="Local shell"
          onClick={openShellMenu}
        >
          <Icon name="terminal" size={16} />
        </button>
        <button
          className="icon-btn"
          title="Import from ~/.ssh/config"
          onClick={() => void importSshConfig()}
        >
          <Icon name="download" size={16} />
        </button>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </aside>
  );
}
