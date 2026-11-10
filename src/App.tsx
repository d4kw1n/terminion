import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { GroupEditor } from "./components/GroupEditor";
import { HostEditor } from "./components/HostEditor";
import { HostSidebar } from "./components/HostSidebar";
import { Rail } from "./components/Rail";
import { SftpView } from "./components/SftpView";
import { TabBar } from "./components/TabBar";
import { TabDragLayer } from "./components/TabDragLayer";
import { TerminalView } from "./components/TerminalView";
import { Toasts } from "./components/Toasts";
import { TransferPanel } from "./components/TransferPanel";
import { Welcome } from "./components/Welcome";
import { api } from "./lib/api";
import { terminalRegistry } from "./lib/term";
import { layoutSplitRects } from "./lib/split";
import type {
  ForwardStatusEvent,
  HostOsDetected,
  KnownHostAdded,
  SplitRect,
  Tab,
} from "./lib/types";
import { applyTheme, useStore } from "./store";
import { isEditableTarget } from "./lib/utils";
import { ForwardsPage } from "./pages/ForwardsPage";
import { KeysPage } from "./pages/KeysPage";
import { KnownHostsPage } from "./pages/KnownHostsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SnippetsPage } from "./pages/SnippetsPage";

function probeSessions() {
  const state = useStore.getState();
  for (const tab of state.tabs) {
    if (tab.kind === "terminal" && tab.sessionId && !tab.localShell) {
      api.terminalProbe(tab.sessionId).catch(() => {});
    }
  }
}

function PageView({ page }: { page: string }) {
  switch (page) {
    case "snippets":
      return <SnippetsPage />;
    case "forwards":
      return <ForwardsPage />;
    case "keys":
      return <KeysPage />;
    case "known":
      return <KnownHostsPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return null;
  }
}

function WorkspacePane({
  tab,
  active,
  splitRect,
}: {
  tab: Tab;
  active: boolean;
  splitRect?: SplitRect;
}) {
  const setActiveTab = useStore((s) => s.setActiveTab);
  const clearSplit = useStore((s) => s.clearSplit);
  const canSplit = tab.kind === "terminal";

  const visible = Boolean(splitRect) || active;
  const className = [
    "tab-pane",
    active ? "is-active" : "",
    splitRect ? "is-split-pane" : "",
    splitRect && active ? "is-focused" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const style = splitRect
    ? {
        left: `${splitRect.left}%`,
        top: `${splitRect.top}%`,
        width: `${splitRect.width}%`,
        height: `${splitRect.height}%`,
      }
    : undefined;

  return (
    <div
      className={className}
      style={style}
      aria-hidden={!visible}
      data-split-tab-id={canSplit ? tab.id : undefined}
      onMouseDownCapture={() => {
        if (!active) setActiveTab(tab.id);
      }}
    >
      {tab.kind === "terminal" && (
        <TerminalView
          tab={tab}
          active={active}
          splitMode={Boolean(splitRect)}
          onUnsplit={() => {
            clearSplit();
            setActiveTab(tab.id);
          }}
        />
      )}
      {tab.kind === "sftp" && <SftpView tab={tab} active={active} />}
      {tab.kind === "page" && tab.page && <PageView page={tab.page} />}
    </div>
  );
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const split = useStore((s) => s.split);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const settings = useStore((s) => s.settings);
  const [clock, setClock] = useState(0);

  const splitRects = useMemo(
    () => (split ? layoutSplitRects(split) : []),
    [split],
  );
  const splitById = useMemo(
    () => new Map(splitRects.map((rect) => [rect.tabId, rect])),
    [splitRects],
  );
  const splitVisible = Boolean(
    split && activeTabId && splitRects.some((rect) => rect.tabId === activeTabId),
  );

  useEffect(() => {
    void useStore.getState().bootstrap();
  }, []);

  // Keep terminals in sync with appearance settings.
  useEffect(() => {
    for (const handle of terminalRegistry.values()) handle.applySettings(settings);
    setClock((c) => c + 1);
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.cursorStyle,
    settings.scrollback,
    settings.terminalTheme,
    settings.bell,
  ]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      if (useStore.getState().settings.theme !== "system") return;
      applyTheme(useStore.getState().settings);
      const dark = media.matches;
      getCurrentWindow()
        .setTheme(dark ? "dark" : "light")
        .catch(() => {});
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // Keep the native title bar in step with the in-app theme.
  useEffect(() => {
    const resolved =
      settings.theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : settings.theme;
    getCurrentWindow()
      .setTheme(resolved)
      .catch(() => {});
  }, [settings.theme]);

  // Native events from the backend.
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    (async () => {
      const a = await listen<KnownHostAdded>("known-host-added", (event) => {
        const store = useStore.getState();
        store.addToast({
          type: "info",
          title: "New host key trusted",
          message: `${event.payload.endpoint} · ${event.payload.fingerprint}`,
        });
        store.refreshKnownHosts().catch(() => {});
      });
      const c = await listen<HostOsDetected>("host-os-detected", (event) => {
        const store = useStore.getState();
        const host = store.hosts.find((item) => item.id === event.payload.hostId);
        store.setHostOs(event.payload.hostId, event.payload.os);
        if (host && !host.os) {
          store.addToast({
            type: "info",
            title: "Host identified",
            message: `${host.label}: ${event.payload.os}`,
          });
        }
      });
      const b = await listen<ForwardStatusEvent>("forward-status", (event) => {
        const { id, running, error, boundPort } = event.payload;
        useStore.setState((state) => {
          const runningForwards = { ...state.runningForwards };
          if (running && boundPort) runningForwards[id] = boundPort;
          else delete runningForwards[id];
          return { runningForwards };
        });
        if (error) {
          useStore.getState().addToast({
            type: "error",
            title: "Port forward stopped",
            message: error,
          });
        }
      });
      if (disposed) {
        a();
        b();
        c();
      } else {
        unlisteners.push(a, b, c);
      }
    })();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  // Network changes: probe live sessions so a stale TCP link is detected
  // immediately instead of waiting for the SSH keepalive.
  useEffect(() => {
    const onOnline = () => {
      const wasOnline = useStore.getState().online;
      useStore.getState().setOnline(true);
      if (!wasOnline) {
        useStore.getState().addToast({
          type: "success",
          title: "Network restored",
          message: "Verifying open sessions…",
        });
        probeSessions();
      }
    };
    const onOffline = () => {
      useStore.getState().setOnline(false);
      useStore.getState().addToast({
        type: "warning",
        title: "You are offline",
        message: "Sessions will reconnect automatically when the network returns.",
      });
    };
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt && Date.now() - hiddenAt > 25_000) {
        hiddenAt = 0;
        probeSessions();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Global shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const code = event.code;
      const key = event.key.toLowerCase();
      const is = (c: string, k: string) => code === c || key === k;
      if (!ctrl) {
        if (event.key === "/" && !isEditableTarget(event.target)) {
          const input = document.querySelector<HTMLInputElement>(
            ".sidebar .search-field input",
          );
          if (input) {
            event.preventDefault();
            input.focus();
            input.select();
          }
        }
        if (event.key === "Escape" && useStore.getState().search) {
          useStore.getState().setSearch("");
        }
        return;
      }
      const store = useStore.getState();
      if (is("KeyK", "k") && !event.shiftKey) {
        event.preventDefault();
        store.setPaletteOpen(!store.paletteOpen);
        return;
      }
      if (is("KeyP", "p") && event.shiftKey) {
        event.preventDefault();
        store.setPaletteOpen(true);
        return;
      }
      if (is("KeyN", "n") && !event.shiftKey) {
        event.preventDefault();
        store.openHostEditor();
        return;
      }
      if (is("Comma", ",")) {
        event.preventDefault();
        store.openPage("settings");
        return;
      }
      if (is("KeyB", "b") && !event.shiftKey) {
        event.preventDefault();
        store.setSidebarOpen(!store.sidebarOpen);
        return;
      }
      if (is("Tab", "tab")) {
        event.preventDefault();
        const tabs = store.tabs;
        if (tabs.length === 0) return;
        const index = tabs.findIndex((t) => t.id === store.activeTabId);
        const next = event.shiftKey
          ? (index - 1 + tabs.length) % tabs.length
          : (index + 1) % tabs.length;
        store.setActiveTab(tabs[next].id);
        return;
      }
      if (is("KeyT", "t") && event.shiftKey) {
        event.preventDefault();
        store.openDefaultLocalShell();
        return;
      }
      if (is("KeyW", "w") && store.activeTabId) {
        if (document.querySelector(".xterm-helper-textarea") === document.activeElement) return;
        event.preventDefault();
        store.closeTab(store.activeTabId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible" && !navigator.onLine) {
        useStore.getState().setOnline(false);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // clock is only used to nudge layout after settings are applied
  void clock;

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-mark">
          <div className="logo-mark logo-mark--large">
            <span className="logo-prompt">&gt;</span>
            <span className="logo-cursor" />
            <span className="logo-dot" />
          </div>
        </div>
        <div className="splash-title">Terminion</div>
        <div className="splash-sub">Opening your workspace…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <Rail />
      {sidebarOpen && <HostSidebar />}
      <main className="workspace">
        <TabBar />
        <div className="workspace-body">
          {tabs.length === 0 ? (
            <Welcome />
          ) : (
            tabs.map((tab) => (
              <WorkspacePane
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                splitRect={splitVisible ? splitById.get(tab.id) : undefined}
              />
            ))
          )}
        </div>
      </main>

      <HostEditor />
      <GroupEditor />
      <TabDragLayer />
      <CommandPalette />
      <Toasts />
      <TransferPanel />
      <ConfirmDialog />
    </div>
  );
}
