import { create } from "zustand";
import { api } from "./lib/api";
import type {
  AppInfo,
  Group,
  GroupInput,
  Host,
  HostInput,
  KeyEntry,
  KnownHostEntry,
  PageKind,
  Paths,
  PortForward,
  PortForwardInput,
  Settings,
  Snippet,
  SnippetInput,
  SplitNode,
  SplitSide,
  Tab,
  TabGroup,
  Toast,
  TransferItem,
} from "./lib/types";
import { buildSplit, removeSplitTab, splitContains, splitLeaves } from "./lib/split";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "violet",
  terminalTheme: "terminion",
  fontFamily: "Cascadia Mono, JetBrains Mono, Consolas, monospace",
  fontSize: 14,
  scrollback: 10000,
  cursorStyle: "bar",
  keepaliveSecs: 20,
  autoReconnect: true,
  copyOnSelect: false,
  confirmClose: true,
  renderer: "auto",
  bell: false,
};

const PAGE_TITLES: Record<PageKind, string> = {
  snippets: "Snippets",
  forwards: "Port forwarding",
  keys: "SSH keys",
  known: "Known hosts",
  settings: "Settings",
};

export interface HostEditorState {
  open: boolean;
  host: Host | null;
  prefill: Partial<HostInput> | null;
}

export interface GroupEditorState {
  open: boolean;
  group: Group | null;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => void;
}

export interface TabDragState {
  tabId: string;
  x: number;
  y: number;
  targetTabId: string | null;
  side: SplitSide | null;
  rect: { left: number; top: number; width: number; height: number } | null;
  /// Reorder target when the pointer is over the tab bar rather than a pane.
  tabDrop: {
    tabId: string;
    after: boolean;
    x: number;
    y: number;
    height: number;
  } | null;
}

interface AppStore {
  ready: boolean;
  hosts: Host[];
  groups: Group[];
  keys: KeyEntry[];
  snippets: Snippet[];
  forwards: PortForward[];
  knownHosts: KnownHostEntry[];
  runningForwards: Record<number, number>;
  settings: Settings;
  paths: Paths | null;
  appInfo: AppInfo | null;

  tabs: Tab[];
  activeTabId: string | null;
  lastTerminalId: string | null;
  tabGroups: TabGroup[];
  split: SplitNode | null;
  tabDrag: TabDragState | null;
  search: string;
  collapsed: Record<string, boolean>;

  editor: HostEditorState;
  groupEditor: GroupEditorState;
  paletteOpen: boolean;
  sidebarOpen: boolean;
  toasts: Toast[];
  transfers: TransferItem[];
  confirm: ConfirmState | null;
  online: boolean;

  bootstrap: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  refreshKeys: () => Promise<void>;
  refreshSnippets: () => Promise<void>;
  refreshForwards: () => Promise<void>;
  refreshKnownHosts: () => Promise<void>;

  openTerminal: (hostId: number, activate?: boolean) => string | null;
  openSftp: (hostId: number) => void;
  openFileBrowser: (hostId: number) => void;
  connectHost: (hostId: number) => void;
  openPage: (page: PageKind) => void;
  closeTab: (tabId: string, force?: boolean) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, title: string) => void;
  moveTab: (tabId: string, targetTabId: string, after: boolean) => void;
  createTabGroup: (tabId: string, name: string, color: string) => void;
  addTabToGroup: (tabId: string, groupId: string) => void;
  removeTabFromGroup: (tabId: string) => void;
  renameTabGroup: (groupId: string, name: string, color: string) => void;
  deleteTabGroup: (groupId: string) => void;
  toggleTabGroup: (groupId: string) => void;
  splitTab: (targetTabId: string, sourceTabId: string, side: SplitSide) => void;
  arrangeSplit: (preset: "two-top-one-bottom") => void;
  clearSplit: () => void;
  setTabDrag: (drag: TabDragState | null) => void;
  patchTab: (tabId: string, patch: Partial<Tab>) => void;
  setTabStatus: (
    tabId: string,
    status: Tab["status"],
    error?: string,
    attempt?: number,
  ) => void;
  closeTabsForHost: (hostId: number) => void;

  setSearch: (value: string) => void;
  toggleGroup: (key: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;

  openHostEditor: (host?: Host | null, prefill?: Partial<HostInput> | null) => void;
  closeHostEditor: () => void;
  saveHost: (input: HostInput) => Promise<Host | null>;
  deleteHost: (id: number) => Promise<void>;
  toggleFavorite: (host: Host) => Promise<void>;

  openGroupEditor: (group?: Group | null) => void;
  closeGroupEditor: () => void;
  saveGroup: (input: GroupInput) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;

  importSshConfig: () => Promise<void>;

  saveSnippet: (input: SnippetInput) => Promise<void>;
  deleteSnippet: (id: number) => Promise<void>;

  saveForward: (input: PortForwardInput) => Promise<void>;
  deleteForward: (id: number) => Promise<void>;
  toggleForward: (id: number, run: boolean) => Promise<void>;

  deleteKnownHost: (id: number) => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => void;

  addToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  setOnline: (online: boolean) => void;

  askConfirm: (confirm: ConfirmState) => void;
  closeConfirm: () => void;

  beginTransfer: (item: TransferItem) => void;
  updateTransfer: (id: string, patch: Partial<TransferItem>) => void;
  endTransfer: (id: string, patch: Partial<TransferItem>) => void;
  dismissTransfer: (id: string) => void;
}

export function applyTheme(settings: Settings) {
  const root = document.documentElement;
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  const theme =
    settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  root.dataset.theme = theme;
  root.dataset.accent = settings.accent;
}

let settingsSaveTimer: number | null = null;

function scheduleSaveSettings(settings: Settings) {
  if (settingsSaveTimer) window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(() => {
    api.saveSettings(settings).catch(() => {});
  }, 240);
}

function cleanupTabGroups(tabs: Tab[], groups: TabGroup[]): TabGroup[] {
  const used = new Set(tabs.map((tab) => tab.groupId).filter((id): id is string => !!id));
  return groups.filter((group) => used.has(group.id));
}

export const useStore = create<AppStore>((set, get) => ({
  ready: false,
  hosts: [],
  groups: [],
  keys: [],
  snippets: [],
  forwards: [],
  knownHosts: [],
  runningForwards: {},
  settings: DEFAULT_SETTINGS,
  paths: null,
  appInfo: null,

  tabs: [],
  activeTabId: null,
  lastTerminalId: null,
  tabGroups: [],
  split: null,
  tabDrag: null,
  search: "",
  collapsed: {},

  editor: { open: false, host: null, prefill: null },
  groupEditor: { open: false, group: null },
  paletteOpen: false,
  sidebarOpen: true,
  toasts: [],
  transfers: [],
  confirm: null,
  online: navigator.onLine,

  bootstrap: async () => {
    try {
      const [hosts, groups, keys, snippets, forwards, knownHosts, settings, paths, appInfo, running] =
        await Promise.all([
          api.listHosts(),
          api.listGroups(),
          api.listKeys(),
          api.listSnippets(),
          api.listForwards(),
          api.listKnownHosts(),
          api.getSettings(),
          api.getPaths(),
          api.getAppInfo(),
          api.listRunningForwards(),
        ]);
      const runningForwards: Record<number, number> = {};
      for (const entry of running) runningForwards[entry.id] = entry.boundPort;
      applyTheme(settings);
      set({
        hosts,
        groups,
        keys,
        snippets,
        forwards,
        knownHosts,
        settings,
        paths,
        appInfo,
        runningForwards,
        ready: true,
      });
    } catch (err) {
      set({ ready: true });
      get().addToast({
        type: "error",
        title: "Could not load your workspace",
        message: String(err),
      });
    }
  },

  refreshHosts: async () => set({ hosts: await api.listHosts() }),
  refreshGroups: async () => set({ groups: await api.listGroups() }),
  refreshKeys: async () => set({ keys: await api.listKeys() }),
  refreshSnippets: async () => set({ snippets: await api.listSnippets() }),
  refreshForwards: async () => {
    const [forwards, running] = await Promise.all([
      api.listForwards(),
      api.listRunningForwards(),
    ]);
    const runningForwards: Record<number, number> = {};
    for (const entry of running) runningForwards[entry.id] = entry.boundPort;
    set({ forwards, runningForwards });
  },
  refreshKnownHosts: async () => set({ knownHosts: await api.listKnownHosts() }),

  openTerminal: (hostId, activate = true) => {
    const host = get().hosts.find((h) => h.id === hostId);
    if (!host) return null;
    if (host.protocol !== "ssh") {
      get().openFileBrowser(hostId);
      return null;
    }
    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      kind: "terminal",
      title: host.label,
      subtitle: `${host.username}@${host.hostname}:${host.port}`,
      hostId,
      status: "connecting",
      endpoint: `${host.hostname}:${host.port}`,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: activate ? id : state.activeTabId,
      lastTerminalId: activate ? id : state.lastTerminalId,
    }));
    return id;
  },

  openSftp: (hostId) => {
    get().openFileBrowser(hostId);
  },

  openFileBrowser: (hostId) => {
    const host = get().hosts.find((h) => h.id === hostId);
    if (!host) return;
    const existing = get().tabs.find((t) => t.kind === "sftp" && t.hostId === hostId);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const protocol = host.protocol === "ftp" ? "ftp" : "sftp";
    const scheme = protocol === "ftp" ? "ftp" : "sftp";
    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      kind: "sftp",
      fileProtocol: protocol,
      title: `${host.label} · ${protocol.toUpperCase()}`,
      subtitle: `${scheme}://${host.username}@${host.hostname}:${host.port}`,
      hostId,
      status: "connecting",
      endpoint: `${host.hostname}:${host.port}`,
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: id }));
  },

  connectHost: (hostId) => {
    const host = get().hosts.find((h) => h.id === hostId);
    if (!host) return;
    if (host.protocol === "ftp") get().openFileBrowser(hostId);
    else get().openTerminal(hostId);
  },

  openPage: (page) => {
    const existing = get().tabs.find((t) => t.kind === "page" && t.page === page);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: Tab = {
      id: `page-${page}`,
      kind: "page",
      page,
      title: PAGE_TITLES[page],
      status: "ready",
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  },

  closeTab: (tabId, force = false) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (
      !force &&
      state.settings.confirmClose &&
      tab.kind === "terminal" &&
      tab.status === "connected"
    ) {
      state.askConfirm({
        title: "Close this session?",
        message:
          "The connection will be closed. Anything running in this terminal will keep running on the server.",
        confirmLabel: "Close session",
        danger: true,
        onConfirm: () => get().closeTab(tabId, true),
      });
      return;
    }
    if (tab.kind === "terminal" && tab.sessionId) {
      api.terminalClose(tab.sessionId).catch(() => {});
    }
    if (tab.kind === "sftp" && tab.sftpId) {
      api.sftpDisconnect(tab.sftpId).catch(() => {});
    }
    set((current) => {
      const index = current.tabs.findIndex((t) => t.id === tabId);
      const tabs = current.tabs.filter((t) => t.id !== tabId);
      const closedActive = current.activeTabId === tabId;
      const closedFromSplit = Boolean(
        current.split && splitContains(current.split, tabId),
      );
      let activeTabId = current.activeTabId;
      if (closedActive) {
        activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
      }

      let split = current.split ? removeSplitTab(current.split, tabId) : null;
      const leaves = split ? splitLeaves(split) : [];
      if (split && leaves.length < 2) {
        split = null;
      }
      if (closedActive && closedFromSplit) {
        activeTabId = leaves[0] ?? activeTabId;
      }

      let lastTerminalId = current.lastTerminalId;
      if (lastTerminalId === tabId) {
        lastTerminalId =
          [...tabs].reverse().find((t) => t.kind === "terminal")?.id ?? null;
      }
      if (tabs.find((t) => t.id === activeTabId)?.kind === "terminal") {
        lastTerminalId = activeTabId;
      }
      return {
        tabs,
        activeTabId,
        lastTerminalId,
        split,
        tabGroups: cleanupTabGroups(tabs, current.tabGroups),
      };
    });
  },

  setActiveTab: (tabId) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      return {
        activeTabId: tabId,
        lastTerminalId: tab?.kind === "terminal" ? tabId : state.lastTerminalId,
      };
    }),

  renameTab: (tabId, title) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, customTitle: title.trim() || undefined }
          : tab,
      ),
    })),

  moveTab: (tabId, targetTabId, after) =>
    set((state) => {
      const source = state.tabs.find((tab) => tab.id === tabId);
      const target = state.tabs.find((tab) => tab.id === targetTabId);
      if (!source || !target || source.id === target.id) return state;
      const groupId =
        target.groupId && state.tabGroups.some((group) => group.id === target.groupId)
          ? target.groupId
          : undefined;
      const moved = { ...source, groupId };
      const without = state.tabs.filter((tab) => tab.id !== tabId);
      const targetIndex = without.findIndex((tab) => tab.id === targetTabId);
      if (targetIndex < 0) return state;
      const insertAt = targetIndex + (after ? 1 : 0);
      const tabs = [
        ...without.slice(0, insertAt),
        moved,
        ...without.slice(insertAt),
      ];
      return { tabs, tabGroups: cleanupTabGroups(tabs, state.tabGroups) };
    }),

  createTabGroup: (tabId, name, color) =>
    set((state) => {
      if (!state.tabs.some((tab) => tab.id === tabId)) return state;
      const group: TabGroup = {
        id: crypto.randomUUID(),
        name: name.trim() || "Group",
        color,
        collapsed: false,
      };
      const tabs = state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, groupId: group.id } : tab,
      );
      return {
        tabs,
        tabGroups: [...cleanupTabGroups(tabs, state.tabGroups), group],
      };
    }),

  addTabToGroup: (tabId, groupId) =>
    set((state) => {
      const group = state.tabGroups.find((item) => item.id === groupId);
      const source = state.tabs.find((tab) => tab.id === tabId);
      if (!group || !source || source.groupId === groupId) return state;
      const lastGroupTab = [...state.tabs]
        .reverse()
        .find((tab) => tab.groupId === groupId);
      if (!lastGroupTab) return state;
      const moved = { ...source, groupId };
      const without = state.tabs.filter((tab) => tab.id !== tabId);
      const lastIndex = without.findIndex((tab) => tab.id === lastGroupTab.id);
      const tabs = [
        ...without.slice(0, lastIndex + 1),
        moved,
        ...without.slice(lastIndex + 1),
      ];
      const tabGroups = cleanupTabGroups(tabs, state.tabGroups).map((tabGroup) =>
        tabGroup.id === groupId ? { ...tabGroup, collapsed: false } : tabGroup,
      );
      return { tabs, tabGroups };
    }),

  removeTabFromGroup: (tabId) =>
    set((state) => {
      const tabs = state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, groupId: undefined } : tab,
      );
      return { tabs, tabGroups: cleanupTabGroups(tabs, state.tabGroups) };
    }),

  renameTabGroup: (groupId, name, color) =>
    set((state) => ({
      tabGroups: state.tabGroups.map((group) =>
        group.id === groupId
          ? { ...group, name: name.trim() || group.name, color }
          : group,
      ),
    })),

  deleteTabGroup: (groupId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.groupId === groupId ? { ...tab, groupId: undefined } : tab,
      ),
      tabGroups: state.tabGroups.filter((group) => group.id !== groupId),
    })),

  toggleTabGroup: (groupId) =>
    set((state) => ({
      tabGroups: state.tabGroups.map((group) =>
        group.id === groupId
          ? { ...group, collapsed: !group.collapsed }
          : group,
      ),
    })),

  splitTab: (targetTabId, sourceTabId, side) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === targetTabId);
      const source = state.tabs.find((t) => t.id === sourceTabId);
      if (
        !target ||
        !source ||
        target.id === source.id ||
        target.kind !== "terminal" ||
        source.kind !== "terminal"
      ) {
        return state;
      }
      const split = buildSplit(state.split, targetTabId, sourceTabId, side);
      if (!split) return state;
      return {
        split,
        activeTabId: targetTabId,
        lastTerminalId: targetTabId,
      };
    }),

  arrangeSplit: (preset) => {
    if (preset !== "two-top-one-bottom") return;
    const state = get();
    const terminalIds = state.tabs
      .filter((tab) => tab.kind === "terminal")
      .map((tab) => tab.id);
    if (terminalIds.length < 3) {
      state.addToast({
        type: "warning",
        title: "Need three terminals",
        message: "Open another terminal tab before using this layout.",
      });
      return;
    }
    const currentLeaves = splitLeaves(state.split).filter((id) =>
      terminalIds.includes(id),
    );
    const active =
      state.activeTabId && terminalIds.includes(state.activeTabId)
        ? state.activeTabId
        : null;
    const ordered: string[] = [];
    for (const id of [active, ...currentLeaves, ...terminalIds]) {
      if (id && !ordered.includes(id)) ordered.push(id);
    }
    const [first, second, third] = ordered.slice(0, 3);
    const split: SplitNode = {
      type: "split",
      direction: "column",
      children: [
        {
          type: "split",
          direction: "row",
          children: [
            { type: "leaf", tabId: first },
            { type: "leaf", tabId: second },
          ],
        },
        { type: "leaf", tabId: third },
      ],
    };
    set({
      split,
      activeTabId: active ?? first,
      lastTerminalId: active ?? first,
    });
  },

  clearSplit: () => set({ split: null }),

  setTabDrag: (drag) => set({ tabDrag: drag }),

  patchTab: (tabId, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    })),

  setTabStatus: (tabId, status, error, attempt) =>
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.id !== tabId) return t;
        if (t.status === status && t.error === error && t.attempt === attempt) return t;
        return { ...t, status, error, attempt };
      }),
    })),

  closeTabsForHost: (hostId) => {
    const tabs = get().tabs.filter((t) => t.hostId === hostId);
    for (const tab of tabs) get().closeTab(tab.id, true);
  },

  setSearch: (value) => set({ search: value }),
  toggleGroup: (key) =>
    set((state) => ({ collapsed: { ...state.collapsed, [key]: !state.collapsed[key] } })),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  openHostEditor: (host = null, prefill = null) =>
    set({ editor: { open: true, host, prefill } }),
  closeHostEditor: () => set({ editor: { open: false, host: null, prefill: null } }),

  saveHost: async (input) => {
    try {
      const host = await api.saveHost(input);
      await Promise.all([get().refreshHosts(), get().refreshGroups()]);
      get().addToast({
        type: "success",
        title: input.id ? "Host updated" : "Host added",
        message: `${host.username}@${host.hostname}:${host.port}`,
      });
      return host;
    } catch (err) {
      get().addToast({ type: "error", title: "Could not save host", message: String(err) });
      return null;
    }
  },

  deleteHost: async (id) => {
    const host = get().hosts.find((h) => h.id === id);
    try {
      get().closeTabsForHost(id);
      await api.deleteHost(id);
      await Promise.all([get().refreshHosts(), get().refreshGroups()]);
      get().addToast({ type: "success", title: "Host deleted", message: host?.label });
    } catch (err) {
      get().addToast({ type: "error", title: "Could not delete host", message: String(err) });
    }
  },

  toggleFavorite: async (host) => {
    try {
      await api.setHostFavorite(host.id, !host.favorite);
      await get().refreshHosts();
    } catch (err) {
      get().addToast({ type: "error", title: "Could not update host", message: String(err) });
    }
  },

  openGroupEditor: (group = null) => set({ groupEditor: { open: true, group } }),
  closeGroupEditor: () => set({ groupEditor: { open: false, group: null } }),

  saveGroup: async (input) => {
    try {
      await api.saveGroup(input);
      await get().refreshGroups();
      set({ groupEditor: { open: false, group: null } });
    } catch (err) {
      get().addToast({ type: "error", title: "Could not save group", message: String(err) });
    }
  },

  deleteGroup: async (id) => {
    try {
      await api.deleteGroup(id);
      await Promise.all([get().refreshGroups(), get().refreshHosts()]);
    } catch (err) {
      get().addToast({ type: "error", title: "Could not delete group", message: String(err) });
    }
  },

  importSshConfig: async () => {
    try {
      const result = await api.importSshConfig();
      await Promise.all([get().refreshHosts(), get().refreshGroups(), get().refreshKeys()]);
      get().addToast({
        type: result.imported > 0 ? "success" : "info",
        title:
          result.imported > 0
            ? `Imported ${result.imported} host${result.imported === 1 ? "" : "s"}`
            : "Nothing new to import",
        message:
          result.imported > 0
            ? `${result.keysAdded} key${result.keysAdded === 1 ? "" : "s"} added${
                result.skipped ? ` · ${result.skipped} already existed` : ""
              }`
            : `No new hosts found in ${result.configPath}`,
      });
    } catch (err) {
      get().addToast({
        type: "error",
        title: "SSH config import failed",
        message: String(err),
      });
    }
  },

  saveSnippet: async (input) => {
    try {
      await api.saveSnippet(input);
      await get().refreshSnippets();
      get().addToast({ type: "success", title: input.id ? "Snippet updated" : "Snippet added" });
    } catch (err) {
      get().addToast({ type: "error", title: "Could not save snippet", message: String(err) });
    }
  },

  deleteSnippet: async (id) => {
    try {
      await api.deleteSnippet(id);
      await get().refreshSnippets();
    } catch (err) {
      get().addToast({ type: "error", title: "Could not delete snippet", message: String(err) });
    }
  },

  saveForward: async (input) => {
    try {
      await api.saveForward(input);
      await get().refreshForwards();
      get().addToast({ type: "success", title: input.id ? "Forward updated" : "Forward added" });
    } catch (err) {
      get().addToast({ type: "error", title: "Could not save forward", message: String(err) });
    }
  },

  deleteForward: async (id) => {
    try {
      await api.deleteForward(id);
      await get().refreshForwards();
    } catch (err) {
      get().addToast({ type: "error", title: "Could not delete forward", message: String(err) });
    }
  },

  toggleForward: async (id, run) => {
    try {
      if (run) {
        const port = await api.startForward(id);
        set((state) => ({ runningForwards: { ...state.runningForwards, [id]: port } }));
        get().addToast({
          type: "success",
          title: "Tunnel established",
          message: `Listening on port ${port}`,
        });
      } else {
        await api.stopForward(id);
        set((state) => {
          const runningForwards = { ...state.runningForwards };
          delete runningForwards[id];
          return { runningForwards };
        });
      }
    } catch (err) {
      get().addToast({ type: "error", title: "Tunnel failed", message: String(err) });
      await get().refreshForwards().catch(() => {});
    }
  },

  deleteKnownHost: async (id) => {
    try {
      await api.deleteKnownHost(id);
      await get().refreshKnownHosts();
    } catch (err) {
      get().addToast({
        type: "error",
        title: "Could not remove host key",
        message: String(err),
      });
    }
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    applyTheme(settings);
    set({ settings });
    scheduleSaveSettings(settings);
  },

  addToast: (toast) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts.slice(-3), { ...toast, id }] }));
    window.setTimeout(() => get().dismissToast(id), toast.type === "error" ? 9000 : 5200);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  setOnline: (online) => set({ online }),

  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),

  beginTransfer: (item) =>
    set((state) => {
      const finished = state.transfers.filter((t) => t.status !== "running").slice(-2);
      const running = state.transfers.filter((t) => t.status === "running");
      return { transfers: [...finished, ...running, item] };
    }),
  updateTransfer: (id, patch) =>
    set((state) => ({
      transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  endTransfer: (id, patch) =>
    set((state) => ({
      transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  dismissTransfer: (id) =>
    set((state) => ({ transfers: state.transfers.filter((t) => t.id !== id) })),
}));
