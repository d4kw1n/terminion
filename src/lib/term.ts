import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

import { useStore } from "../store";
import { api } from "./api";
import { terminalTheme } from "./terminalThemes";
import type { Settings, TerminalEvent } from "./types";
import { b64ToBytes } from "./utils";

export interface TermHandle {
  tabId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  sessionId: string | null;
  channel: Channel<TerminalEvent> | null;
  disposed: boolean;
  fitNow: () => void;
  focus: () => void;
  applySettings: (settings: Settings) => void;
  dispose: () => void;
}

export const terminalRegistry = new Map<string, TermHandle>();

const MINT = "\x1b[38;2;34;211;166m";
const DIM = "\x1b[2m";
const RED = "\x1b[38;2;255;107;129m";
const RESET = "\x1b[0m";

export type TerminalSource =
  | { kind: "ssh"; hostId: number }
  | { kind: "local"; shellId: string };

export async function mountTerminal(
  tabId: string,
  source: TerminalSource,
  container: HTMLElement,
  options: { onSearch?: () => void; onReady?: () => void } = {},
): Promise<TermHandle> {
  terminalRegistry.get(tabId)?.dispose();

  const settings = useStore.getState().settings;
  const theme = terminalTheme(settings.terminalTheme);

  const term = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    fontWeight: "400",
    fontWeightBold: "600",
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    theme: theme.theme,
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    smoothScrollDuration: 0,
    minimumContrastRatio: 1,
    drawBoldTextInBrightColors: true,
    tabStopWidth: 8,
    scrollOnUserInput: true,
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(container);

  const lowMemory = useStore.getState().appInfo?.lowMemory ?? false;
  if (!lowMemory && (settings.renderer === "auto" || settings.renderer === "webgl")) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* ignore */
        }
      });
      term.loadAddon(webgl);
    } catch {
      // Canvas renderer remains active.
    }
  }

  let sessionId: string | null = null;
  let channel: Channel<TerminalEvent> | null = null;
  let inputBuffer = "";
  let flushTimer: number | null = null;
  let disposed = false;
  let observer: ResizeObserver | null = null;

  const handle: TermHandle = {
    tabId,
    term,
    fit,
    search,
    sessionId: null,
    channel: null,
    disposed: false,
    fitNow: () => {},
    focus: () => {},
    applySettings: () => {},
    dispose: () => {},
  };

  const fitNow = () => {
    if (disposed) return;
    if (container.clientWidth < 24 || container.clientHeight < 24) return;
    try {
      fit.fit();
    } catch {
      /* the element can be mid-layout */
    }
  };

  const flushInput = () => {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!inputBuffer || !sessionId || disposed) return;
    const payload = inputBuffer;
    inputBuffer = "";
    api.terminalWrite(sessionId, payload).catch(() => {});
  };

  const queueInput = (data: string) => {
    inputBuffer += data;
    if (inputBuffer.length >= 32 * 1024) {
      flushInput();
    } else if (flushTimer === null) {
      flushTimer = window.setTimeout(flushInput, 5);
    }
  };

  const copySelection = () => {
    const selection = term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => {});
    }
    return Boolean(selection);
  };

  term.onData(queueInput);
  term.onBell(() => {
    if (!useStore.getState().settings.bell) return;
    try {
      const Ctx = window.AudioContext;
      const context = new Ctx();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.035;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.07);
      window.setTimeout(() => void context.close(), 240);
    } catch {
      /* audio is unavailable */
    }
  });
  term.onResize(({ cols, rows }) => {
    if (sessionId) api.terminalResize(sessionId, cols, rows).catch(() => {});
  });
  term.onSelectionChange(() => {
    if (useStore.getState().settings.copyOnSelect && term.hasSelection()) {
      const selection = term.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    }
  });

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const ctrl = event.ctrlKey || event.metaKey;
    const code = event.code;
    const key = event.key.toLowerCase();
    const is = (c: string, k: string) => code === c || key === k;
    if (ctrl && event.shiftKey && is("KeyC", "c")) {
      copySelection();
      return false;
    }
    // Let the browser deliver one native paste event; xterm handles it.
    // Reading the clipboard here as well would insert the text twice.
    if (ctrl && event.shiftKey && is("KeyV", "v")) return false;
    if (ctrl && !event.shiftKey && is("KeyC", "c") && term.hasSelection()) {
      copySelection();
      return false;
    }
    if (ctrl && !event.shiftKey && is("KeyV", "v")) return false;
    if (ctrl && !event.shiftKey && is("KeyF", "f")) {
      options.onSearch?.();
      return false;
    }
    if (ctrl && !event.shiftKey && (is("KeyK", "k") || is("KeyP", "p"))) {
      useStore.getState().setPaletteOpen(true);
      return false;
    }
    if (ctrl && !event.shiftKey && is("KeyW", "w")) {
      useStore.getState().closeTab(tabId);
      return false;
    }
    return true;
  });

  const onEvent = (event: TerminalEvent) => {
    const store = useStore.getState();
    switch (event.type) {
      case "data": {
        if (!disposed) term.write(b64ToBytes(event.data));
        break;
      }
      case "status": {
        switch (event.status) {
          case "connected":
            store.setTabStatus(tabId, "connected");
            break;
          case "reconnecting":
            store.setTabStatus(tabId, "reconnecting", event.detail ?? undefined, event.attempt ?? undefined);
            break;
          case "connecting":
            store.setTabStatus(tabId, "connecting");
            break;
          case "disconnected":
            store.setTabStatus(tabId, "disconnected", event.detail ?? undefined);
            break;
          case "closed":
            store.setTabStatus(tabId, "disconnected", "Session closed");
            break;
          default:
            break;
        }
        break;
      }
      case "connected": {
        store.patchTab(tabId, {
          status: "connected",
          error: undefined,
          attempt: 0,
          fingerprint: event.fingerprint,
          keyType: event.keyType,
        });
        if (event.reused && !disposed) {
          term.write(`\r\n${MINT}✓ reconnected${RESET} ${DIM}${new Date().toLocaleTimeString()}${RESET}\r\n`);
        }
        break;
      }
      case "reconnecting": {
        store.setTabStatus(tabId, "reconnecting", event.reason, event.attempt);
        break;
      }
      case "disconnected": {
        store.setTabStatus(tabId, "disconnected", event.reason);
        if (!disposed && event.code !== null && event.code !== undefined) {
          term.write(`\r\n${DIM}[process exited with code ${event.code}]${RESET}\r\n`);
        }
        break;
      }
      case "authFailed": {
        store.addToast({
          type: "error",
          title: "Authentication failed",
          message: event.message,
        });
        if (!disposed) {
          term.write(`\r\n${RED}${event.message}${RESET}\r\n`);
        }
        break;
      }
      default:
        break;
    }
  };

  handle.fitNow = fitNow;
  handle.focus = () => term.focus();
  handle.applySettings = (next: Settings) => {
    if (disposed) return;
    term.options.fontFamily = next.fontFamily;
    term.options.fontSize = next.fontSize;
    term.options.cursorStyle = next.cursorStyle;
    term.options.scrollback = next.scrollback;
    term.options.theme = terminalTheme(next.terminalTheme).theme;
    fitNow();
  };
  handle.dispose = () => {
    if (disposed) return;
    disposed = true;
    handle.disposed = true;
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    observer?.disconnect();
    if (sessionId) api.terminalClose(sessionId).catch(() => {});
    try {
      term.dispose();
    } catch {
      /* ignore */
    }
    if (terminalRegistry.get(tabId) === handle) terminalRegistry.delete(tabId);
  };

  observer = new ResizeObserver(() => fitNow());
  observer.observe(container);

  terminalRegistry.set(tabId, handle);
  requestAnimationFrame(fitNow);

  try {
    const stream =
      source.kind === "local"
        ? await api.openLocalShell(source.shellId, term.cols, term.rows, onEvent)
        : await api.openTerminal(source.hostId, term.cols, term.rows, onEvent);
    sessionId = stream.sessionId;
    channel = stream.channel;
    handle.sessionId = sessionId;
    handle.channel = channel;
    if (disposed) {
      api.terminalClose(sessionId).catch(() => {});
      return handle;
    }
    useStore.getState().patchTab(tabId, { sessionId });
    // The opening fit can happen before the session id exists, so send the
    // current size once explicitly and fit again on the next frame.
    void api.terminalResize(sessionId, term.cols, term.rows).catch(() => {});
    requestAnimationFrame(fitNow);
    flushInput();
    options.onReady?.();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useStore.getState().setTabStatus(tabId, "disconnected", message);
    if (!disposed) {
      term.write(`\r\n${RED}Could not open the session: ${message}${RESET}\r\n`);
    }
  }

  return handle;
}
