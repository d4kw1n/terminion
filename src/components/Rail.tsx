import { Icon, type IconName } from "./Icon";
import { useStore } from "../store";
import type { PageKind } from "../lib/types";

interface NavItem {
  key: "hosts" | PageKind;
  label: string;
  icon: IconName;
  shortcut?: string;
}

const NAV: NavItem[] = [
  { key: "hosts", label: "Hosts", icon: "server" },
  { key: "snippets", label: "Snippets", icon: "code" },
  { key: "forwards", label: "Port forwarding", icon: "swap" },
  { key: "keys", label: "SSH keys", icon: "key" },
  { key: "known", label: "Known hosts", icon: "shield" },
];

export function Rail() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const online = useStore((s) => s.online);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const openPage = useStore((s) => s.openPage);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activePage = activeTab?.kind === "page" ? activeTab.page : null;
  const hasLiveSession = tabs.some(
    (t) => t.kind === "terminal" && (t.status === "connected" || t.status === "reconnecting"),
  );

  const selectHosts = () => {
    const state = useStore.getState();
    const current = state.tabs.find((t) => t.id === state.activeTabId);
    if (current?.kind === "page") {
      const last = [...state.tabs].reverse().find((t) => t.kind !== "page");
      useStore.setState({ activeTabId: last?.id ?? null });
    }
  };

  return (
    <nav className="rail">
      <button className="rail-logo" onClick={selectHosts} title="Terminion">
        <span className="logo-mark">
          <span className="logo-prompt">&gt;</span>
          <span className="logo-cursor" />
          <span className="logo-dot" />
        </span>
      </button>

      <div className="rail-nav">
        {NAV.map((item) => {
          const active = item.key === "hosts" ? !activePage : activePage === item.key;
          return (
            <button
              key={item.key}
              className={`rail-item ${active ? "is-active" : ""}`}
              onClick={() => (item.key === "hosts" ? selectHosts() : openPage(item.key))}
              title={item.label}
              aria-label={item.label}
            >
              <Icon name={item.icon} size={20} />
              {item.key === "hosts" && hasLiveSession && <span className="rail-live" />}
              <span className="rail-tip">{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="rail-bottom">
        <button
          className="rail-item rail-item--quiet"
          onClick={() => setPaletteOpen(true)}
          title="Command palette (Ctrl+K)"
          aria-label="Command palette"
        >
          <Icon name="command" size={19} />
          <span className="rail-tip">Command palette · Ctrl K</span>
        </button>
        <button
          className={`rail-item ${activePage === "settings" ? "is-active" : ""}`}
          onClick={() => openPage("settings")}
          title="Settings (Ctrl+,)"
          aria-label="Settings"
        >
          <Icon name="settings" size={20} />
          <span className="rail-tip">Settings · Ctrl ,</span>
        </button>
        <div
          className={`rail-status ${online ? "is-online" : "is-offline"}`}
          title={online ? "Online" : "Offline"}
        >
          <span className="rail-status-dot" />
        </div>
      </div>
    </nav>
  );
}
