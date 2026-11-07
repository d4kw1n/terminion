import type { ReactNode } from "react";

import { Icon } from "../components/Icon";
import { Switch } from "../components/Modal";
import { api } from "../lib/api";
import { TERMINAL_THEMES, terminalTheme } from "../lib/terminalThemes";
import { useStore } from "../store";
import type { Settings } from "../lib/types";

const ACCENTS: { id: Settings["accent"]; label: string; color: string }[] = [
  { id: "violet", label: "Violet", color: "#7c5cff" },
  { id: "mint", label: "Mint", color: "#22d3a6" },
  { id: "blue", label: "Blue", color: "#38bdf8" },
  { id: "amber", label: "Amber", color: "#f59e0b" },
  { id: "rose", label: "Rose", color: "#fb7185" },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-label">{label}</div>
        {description && <div className="settings-desc">{description}</div>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const paths = useStore((s) => s.paths);
  const appInfo = useStore((s) => s.appInfo);
  const addToast = useStore((s) => s.addToast);
  const askConfirm = useStore((s) => s.askConfirm);

  const theme = terminalTheme(settings.terminalTheme);
  const preview = theme.theme;

  const openFolder = (path?: string) => {
    if (!path) return;
    api.openFolder(path).catch((err) =>
      addToast({ type: "error", title: "Could not open folder", message: String(err) }),
    );
  };

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Changes are saved automatically and applied to open sessions.</p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() =>
              askConfirm({
                title: "Restore default preferences?",
                message:
                  "Appearance, terminal and connection preferences return to their defaults. Hosts, keys and snippets are not touched.",
                confirmLabel: "Restore defaults",
                danger: false,
                onConfirm: () => {
                  update({
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
                  });
                },
              })
            }
          >
            Restore defaults
          </button>
        </div>
      </header>

      <div className="page-body settings-body">
        <Section title="Appearance" description="How the workspace looks around your terminals.">
          <Row label="Theme" description="System follows your Windows theme.">
            <div className="segmented">
              <button
                className={settings.theme === "dark" ? "is-active" : ""}
                onClick={() => update({ theme: "dark" })}
              >
                <Icon name="moon" size={14} /> Dark
              </button>
              <button
                className={settings.theme === "light" ? "is-active" : ""}
                onClick={() => update({ theme: "light" })}
              >
                <Icon name="sun" size={14} /> Light
              </button>
              <button
                className={settings.theme === "system" ? "is-active" : ""}
                onClick={() => update({ theme: "system" })}
              >
                <Icon name="monitor" size={14} /> System
              </button>
            </div>
          </Row>
          <Row label="Accent color" description="Used for highlights, active tabs and buttons.">
            <div className="accent-row">
              {ACCENTS.map((accent) => (
                <button
                  key={accent.id}
                  className={`accent-swatch ${settings.accent === accent.id ? "is-selected" : ""}`}
                  style={{ background: accent.color }}
                  title={accent.label}
                  onClick={() => update({ accent: accent.id })}
                >
                  {settings.accent === accent.id && (
                    <Icon name="check" size={12} strokeWidth={3} />
                  )}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Terminal" description="Applies instantly to every open session.">
          <Row label="Color theme">
            <select
              className="select select--compact"
              value={settings.terminalTheme}
              onChange={(event) => update({ terminalTheme: event.target.value })}
            >
              {TERMINAL_THEMES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="terminal-preview" style={{ background: theme.background }}>
            <div className="preview-line">
              <span style={{ color: preview.green as string }}>➜</span>{" "}
              <span style={{ color: preview.cyan as string }}>~/srv/api</span>{" "}
              <span style={{ color: preview.foreground as string }}>git status</span>
            </div>
            <div className="preview-line" style={{ color: preview.foreground as string }}>
              On branch <span style={{ color: preview.magenta as string }}>main</span>
            </div>
            <div className="preview-line" style={{ color: preview.brightBlack as string }}>
              Your branch is up to date with 'origin/main'.
            </div>
            <div className="preview-line">
              <span style={{ color: preview.blue as string }}>deploy.sh</span>{" "}
              <span style={{ color: preview.green as string }}>+12</span>{" "}
              <span style={{ color: preview.red as string }}>-3</span>{" "}
              <span style={{ color: preview.foreground as string }}>
                ready <span style={{ color: preview.yellow as string }}>→</span>{" "}
                <span style={{ color: preview.brightWhite as string }}>production</span>
              </span>
            </div>
          </div>
          <Row label="Font family">
            <input
              className="input input--compact"
              value={settings.fontFamily}
              spellCheck={false}
              onChange={(event) => update({ fontFamily: event.target.value })}
            />
          </Row>
          <Row label="Font size" description="10 – 24 px">
            <div className="stepper">
              <button
                className="stepper-btn"
                onClick={() => update({ fontSize: Math.max(10, settings.fontSize - 1) })}
              >
                −
              </button>
              <span className="stepper-value">{settings.fontSize} px</span>
              <button
                className="stepper-btn"
                onClick={() => update({ fontSize: Math.min(24, settings.fontSize + 1) })}
              >
                +
              </button>
            </div>
          </Row>
          <Row label="Cursor">
            <div className="segmented">
              {(["bar", "block", "underline"] as const).map((style) => (
                <button
                  key={style}
                  className={settings.cursorStyle === style ? "is-active" : ""}
                  onClick={() => update({ cursorStyle: style })}
                >
                  {style[0].toUpperCase() + style.slice(1)}
                </button>
              ))}
            </div>
          </Row>
          <Row
            label="Scrollback"
            description="Lines kept in memory per terminal. Lower uses less RAM."
          >
            <select
              className="select select--compact"
              value={settings.scrollback}
              onChange={(event) => update({ scrollback: Number(event.target.value) })}
            >
              {[2000, 5000, 10000, 25000, 50000].map((lines) => (
                <option key={lines} value={lines}>
                  {lines.toLocaleString()} lines
                </option>
              ))}
            </select>
          </Row>
          <Row label="Renderer" description="Auto picks GPU rendering when available.">
            <select
              className="select select--compact"
              value={settings.renderer}
              onChange={(event) =>
                update({ renderer: event.target.value as Settings["renderer"] })
              }
            >
              <option value="auto">Auto</option>
              <option value="webgl">WebGL</option>
              <option value="dom">Canvas / DOM</option>
            </select>
          </Row>
          <Row label="Terminal bell" description="Audible bell on BEL characters.">
            <Switch
              checked={settings.bell}
              onChange={(value) => update({ bell: value })}
            />
          </Row>
        </Section>

        <Section title="Connections" description="Defaults for new hosts. Existing hosts keep their own settings.">
          <Row
            label="Keepalive interval"
            description="How often to probe an idle connection. Three misses trigger a reconnect."
          >
            <select
              className="select select--compact"
              value={settings.keepaliveSecs}
              onChange={(event) => update({ keepaliveSecs: Number(event.target.value) })}
            >
              {[10, 20, 30, 45, 60].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} seconds
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="Reconnect automatically"
            description="Retry with backoff when a connection drops. Scrollback and the tab stay put."
          >
            <Switch
              checked={settings.autoReconnect}
              onChange={(value) => update({ autoReconnect: value })}
            />
          </Row>
          <div className="settings-note">
            <Icon name="refresh" size={15} />
            <div>
              When Windows reports a network change, Terminion probes every live
              session. A stale link is detected immediately and reconnected — your
              terminal buffer is preserved.
            </div>
          </div>
        </Section>

        <Section title="Behavior">
          <Row
            label="Copy on select"
            description="Automatically copy terminal selections to the clipboard."
          >
            <Switch
              checked={settings.copyOnSelect}
              onChange={(value) => update({ copyOnSelect: value })}
            />
          </Row>
          <Row
            label="Confirm before closing a session"
            description="Ask before closing a tab that is still connected."
          >
            <Switch
              checked={settings.confirmClose}
              onChange={(value) => update({ confirmClose: value })}
            />
          </Row>
        </Section>

        <Section title="About">
          <div className="about-grid">
            <div className="about-stat">
              <span className="about-label">Version</span>
              <span className="about-value">{appInfo?.version ?? "0.1.0"}</span>
            </div>
            <div className="about-stat">
              <span className="about-label">Platform</span>
              <span className="about-value">{appInfo?.platform ?? "windows x86_64"}</span>
            </div>
            <div className="about-stat">
              <span className="about-label">Sessions</span>
              <span className="about-value">SSH · SFTP · FTP · Port forwarding</span>
            </div>
          </div>
          <div className="settings-paths">
            <div className="settings-path">
              <Icon name="hard-drive" size={14} />
              <span className="path-label">Database</span>
              <span className="path-value" title={paths?.dataDir}>
                {paths?.dataDir}
              </span>
              <button className="btn btn-sm" onClick={() => openFolder(paths?.dataDir)}>
                Open
              </button>
            </div>
            <div className="settings-path">
              <Icon name="download" size={14} />
              <span className="path-label">Downloads</span>
              <span className="path-value" title={paths?.downloads}>
                {paths?.downloads}
              </span>
              <button className="btn btn-sm" onClick={() => openFolder(paths?.downloads)}>
                Open
              </button>
            </div>
            <div className="settings-path">
              <Icon name="terminal" size={14} />
              <span className="path-label">SSH config</span>
              <span className="path-value" title={paths?.sshDir}>
                {paths?.sshDir}
              </span>
              <button className="btn btn-sm" onClick={() => openFolder(paths?.sshDir)}>
                Open
              </button>
            </div>
          </div>
          <div className="settings-note">
            <Icon name="lock" size={15} />
            <div>
              Terminion is local-first. There is no account, no cloud sync, and no
              telemetry. Passwords and private keys are encrypted with Windows
              DPAPI under your Windows user profile.
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
