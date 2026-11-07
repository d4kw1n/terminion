import { useEffect, useMemo, useState } from "react";

import { Icon } from "./Icon";
import { Modal, Switch } from "./Modal";
import { emptyHostInput, hostToInput } from "../lib/hosts";
import { HOST_COLORS } from "../lib/utils";
import { useStore } from "../store";
import type { AuthType, HostInput, HostProtocol } from "../lib/types";

type EditorTab = "general" | "auth" | "advanced";

interface FormState {
  label: string;
  hostname: string;
  port: string;
  username: string;
  protocol: HostProtocol;
  authType: AuthType;
  keyId: number | null;
  groupId: number | null;
  tags: string;
  color: string | null;
  favorite: boolean;
  startupCommand: string;
  keepaliveSecs: number;
  autoReconnect: boolean;
}

const KEEPALIVE_OPTIONS = [10, 20, 30, 45, 60];

function formFrom(host: ReturnType<typeof useStore.getState>["editor"]["host"], prefill: Partial<HostInput> | null): FormState {
  const base = host ? hostToInput(host) : emptyHostInput(prefill ?? {});
  return {
    label: base.label,
    hostname: base.hostname,
    port: String(base.port),
    username: base.username,
    protocol: base.protocol,
    authType: base.authType,
    keyId: base.keyId,
    groupId: base.groupId,
    tags: (base.tags ?? []).join(", "),
    color: base.color,
    favorite: base.favorite ?? false,
    startupCommand: base.startupCommand ?? "",
    keepaliveSecs: base.keepaliveSecs ?? 20,
    autoReconnect: base.autoReconnect ?? true,
  };
}

export function HostEditor() {
  const editor = useStore((s) => s.editor);
  const groups = useStore((s) => s.groups);
  const keys = useStore((s) => s.keys);
  const closeHostEditor = useStore((s) => s.closeHostEditor);
  const saveHost = useStore((s) => s.saveHost);
  const openTerminal = useStore((s) => s.openTerminal);
  const openPage = useStore((s) => s.openPage);
  const defaults = useStore((s) => s.settings);

  const [tab, setTab] = useState<EditorTab>("general");
  const [form, setForm] = useState<FormState>(() => formFrom(null, null));
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editor.open) return;
    setTab("general");
    const next = formFrom(editor.host, editor.prefill);
    if (!editor.host) {
      if (editor.prefill?.keepaliveSecs == null) {
        next.keepaliveSecs = defaults.keepaliveSecs;
      }
      if (editor.prefill?.autoReconnect == null) {
        next.autoReconnect = defaults.autoReconnect;
      }
    }
    setForm(next);
    setPassword("");
    setShowPassword(false);
    setErrors({});
    setSaving(false);
  }, [editor.open, editor.host, editor.prefill, defaults.keepaliveSecs, defaults.autoReconnect]);

  const title = editor.host ? "Edit host" : "New host";
  const subtitle = editor.host
    ? `${editor.host.username}@${editor.host.hostname}:${editor.host.port}`
    : "Save a server with its credentials, then connect in one click.";

  const selectedKey = useMemo(
    () => keys.find((k) => k.id === form.keyId) ?? null,
    [keys, form.keyId],
  );

  const patch = (updates: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...updates }));

  const switchProtocol = (protocol: HostProtocol) => {
    if (protocol === "ftp" && tab === "advanced") setTab("general");
    setForm((prev) => ({
      ...prev,
      protocol,
      authType: protocol === "ftp" ? "password" : prev.authType,
      keyId: protocol === "ftp" ? null : prev.keyId,
      port:
        protocol === "ftp"
          ? prev.port === "22" || !prev.port
            ? "21"
            : prev.port
          : prev.port === "21"
            ? "22"
            : prev.port,
    }));
    setErrors({});
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!form.hostname.trim()) next.hostname = "Enter a hostname or IP address.";
    if (!form.username.trim()) next.username = "Enter a username.";
    const port = Number(form.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      next.port = "Port must be between 1 and 65535.";
    }
    if (form.protocol === "ssh" && form.authType === "key" && !form.keyId) {
      next.keyId = "Choose an SSH key, or switch to password authentication.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      if (next.keyId) setTab("auth");
      return false;
    }
    return true;
  };

  const submit = async (connectAfter: boolean) => {
    if (!validate()) return;
    setSaving(true);
    const tags = form.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const payload: HostInput = {
      id: editor.host?.id ?? null,
      label: form.label.trim() || form.hostname.trim(),
      hostname: form.hostname.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      protocol: form.protocol,
      authType: form.protocol === "ftp" ? "password" : form.authType,
      password: editor.host ? (password ? password : null) : password || null,
      keyId: form.protocol === "ssh" ? form.keyId : null,
      groupId: form.groupId,
      tags,
      color: form.color,
      favorite: form.favorite,
      startupCommand: form.startupCommand.trim() || null,
      keepaliveSecs: form.keepaliveSecs,
      autoReconnect: form.autoReconnect,
    };
    const saved = await saveHost(payload);
    setSaving(false);
    if (saved) {
      closeHostEditor();
      if (connectAfter) openTerminal(saved.id);
    }
  };

  return (
    <Modal
      open={editor.open}
      onClose={closeHostEditor}
      title={title}
      subtitle={subtitle}
      width={620}
      footer={
        <>
          <span className="foot-hint">
            <Icon name="lock" size={13} /> Credentials are encrypted on this device
          </span>
          <div className="foot-actions">
            <button className="btn" onClick={closeHostEditor}>
              Cancel
            </button>
            <button className="btn" disabled={saving} onClick={() => void submit(false)}>
              {saving ? <Icon name="loader" size={15} className="spin" /> : null}
              {editor.host ? "Save changes" : "Save host"}
            </button>
            <button
              className="btn btn-primary primary-action"
              disabled={saving}
              onClick={() => void submit(true)}
            >
              <Icon name="play" size={14} />
              {editor.host ? "Save & connect" : "Save & connect"}
            </button>
          </div>
        </>
      }
    >
      <div className="editor-tabs">
        <button
          className={`editor-tab ${tab === "general" ? "is-active" : ""}`}
          onClick={() => setTab("general")}
        >
          General
        </button>
        <button
          className={`editor-tab ${tab === "auth" ? "is-active" : ""}`}
          onClick={() => setTab("auth")}
        >
          Authentication
        </button>
        {form.protocol === "ssh" && (
          <button
            className={`editor-tab ${tab === "advanced" ? "is-active" : ""}`}
            onClick={() => setTab("advanced")}
          >
            Advanced
          </button>
        )}
      </div>

      {tab === "general" && (
        <div className="form-stack">
          <div className="field">
            <label>Protocol</label>
            <div className="segmented segmented--wide">
              <button
                type="button"
                className={form.protocol === "ssh" ? "is-active" : ""}
                onClick={() => switchProtocol("ssh")}
              >
                <Icon name="terminal" size={14} />
                SSH / SFTP
              </button>
              <button
                type="button"
                className={form.protocol === "ftp" ? "is-active" : ""}
                onClick={() => switchProtocol("ftp")}
              >
                <Icon name="folder" size={14} />
                FTP
              </button>
            </div>
            <span className="hint">
              {form.protocol === "ssh"
                ? "Encrypted terminal and SFTP file transfers."
                : "Legacy plain FTP. No terminal, and traffic is unencrypted."}
            </span>
          </div>

          <div className="field">
            <label htmlFor="host-label">Label</label>
            <input
              id="host-label"
              className="input"
              value={form.label}
              placeholder="Production web"
              onChange={(event) => patch({ label: event.target.value })}
            />
            <span className="hint">Shown in the sidebar. Defaults to the hostname.</span>
          </div>

          <div className="field-row field-row--host">
            <div className={`field ${errors.hostname ? "has-error" : ""}`}>
              <label htmlFor="host-hostname">Hostname or IP</label>
              <input
                id="host-hostname"
                className="input"
                value={form.hostname}
                placeholder="server.example.com"
                spellCheck={false}
                onChange={(event) => patch({ hostname: event.target.value })}
              />
              {errors.hostname && <span className="error-text">{errors.hostname}</span>}
            </div>
            <div className={`field field--port ${errors.port ? "has-error" : ""}`}>
              <label htmlFor="host-port">Port</label>
              <input
                id="host-port"
                className="input"
                value={form.port}
                inputMode="numeric"
                onChange={(event) => patch({ port: event.target.value.replace(/[^\d]/g, "") })}
              />
              {errors.port && <span className="error-text">{errors.port}</span>}
            </div>
          </div>
          {form.protocol === "ftp" && (
            <div className="callout">
              <Icon name="alert-triangle" size={15} />
              <div>
                Plain FTP sends the password and files without encryption. Prefer
                SSH/SFTP when the device supports it.
              </div>
            </div>
          )}

          <div className="field-row">
            <div className={`field ${errors.username ? "has-error" : ""}`}>
              <label htmlFor="host-username">Username</label>
              <input
                id="host-username"
                className="input"
                value={form.username}
                spellCheck={false}
                onChange={(event) => patch({ username: event.target.value })}
              />
              {errors.username && <span className="error-text">{errors.username}</span>}
            </div>
            <div className="field">
              <label htmlFor="host-group">Group</label>
              <select
                id="host-group"
                className="select"
                value={form.groupId ?? ""}
                onChange={(event) =>
                  patch({ groupId: event.target.value ? Number(event.target.value) : null })
                }
              >
                <option value="">Ungrouped</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label>Color</label>
            <div className="swatches">
              <button
                type="button"
                className={`swatch swatch--auto ${form.color === null ? "is-selected" : ""}`}
                onClick={() => patch({ color: null })}
                title="Automatic"
              >
                A
              </button>
              {HOST_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`swatch ${form.color === color ? "is-selected" : ""}`}
                  style={{ background: color }}
                  onClick={() => patch({ color })}
                  title={color}
                >
                  {form.color === color && <Icon name="check" size={12} strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="host-tags">Tags</label>
            <input
              id="host-tags"
              className="input"
              value={form.tags}
              placeholder="production, web, eu-west"
              onChange={(event) => patch({ tags: event.target.value })}
            />
            <span className="hint">Comma separated. Useful for search and quick connect.</span>
          </div>
        </div>
      )}

      {tab === "auth" && (
        <div className="form-stack">
          {form.protocol === "ssh" && (
            <div className="segmented segmented--wide">
              <button
                className={form.authType === "password" ? "is-active" : ""}
                onClick={() => patch({ authType: "password" })}
              >
                <Icon name="lock" size={15} />
                Password
              </button>
              <button
                className={form.authType === "key" ? "is-active" : ""}
                onClick={() => patch({ authType: "key" })}
              >
                <Icon name="key" size={15} />
                SSH key
              </button>
            </div>
          )}

          {form.authType === "password" || form.protocol === "ftp" ? (
            <div className="field">
              <label htmlFor="host-password">Password</label>
              <div className="input-with-action">
                <input
                  id="host-password"
                  className="input"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  placeholder={editor.host?.hasPassword ? "••••••••  (saved)" : "Enter password"}
                  autoComplete="new-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="input-action"
                  onClick={() => setShowPassword((v) => !v)}
                  title={showPassword ? "Hide" : "Show"}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} size={15} />
                </button>
              </div>
              {editor.host?.hasPassword ? (
                <span className="hint">
                  A password is saved. Leave the field empty to keep it.
                </span>
              ) : (
                <span className="hint">
                  Stored encrypted with Windows DPAPI — never written to logs.
                </span>
              )}
            </div>
          ) : (
            <div className={`field ${errors.keyId ? "has-error" : ""}`}>
              <label htmlFor="host-key">Private key</label>
              <select
                id="host-key"
                className="select"
                value={form.keyId ?? ""}
                onChange={(event) =>
                  patch({ keyId: event.target.value ? Number(event.target.value) : null })
                }
              >
                <option value="">Select a key…</option>
                {keys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.name} · {key.type}
                  </option>
                ))}
              </select>
              {errors.keyId && <span className="error-text">{errors.keyId}</span>}
              {selectedKey ? (
                <div className="key-summary">
                  <Icon name="key" size={15} />
                  <div>
                    <div className="key-summary-name">{selectedKey.name}</div>
                    <div className="key-summary-fp">{selectedKey.fingerprint}</div>
                  </div>
                  {selectedKey.hasPassphrase && (
                    <span className="pill pill--muted">Passphrase saved</span>
                  )}
                </div>
              ) : (
                <span className="hint">
                  Import or generate a key in the SSH keys section.
                </span>
              )}
              <div className="inline-actions">
                <button
                  className="link-btn"
                  onClick={() => {
                    closeHostEditor();
                    openPage("keys");
                  }}
                >
                  Manage SSH keys <Icon name="arrow-right" size={12} />
                </button>
              </div>
            </div>
          )}

          {form.protocol === "ssh" && form.authType === "key" && (
            <div className="callout">
              <Icon name="info" size={15} />
              <div>
                If the server rejects the key, Terminion falls back to the saved
                password when one exists.
              </div>
            </div>
          )}

          {form.protocol === "ftp" && (
            <div className="callout">
              <Icon name="alert-triangle" size={15} />
              <div>
                FTP credentials are sent in the clear by the protocol. They are only
                encrypted at rest on this machine.
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "advanced" && form.protocol === "ssh" && (
        <div className="form-stack">
          <div className="field">
            <label htmlFor="host-startup">Startup command</label>
            <input
              id="host-startup"
              className="input"
              value={form.startupCommand}
              placeholder="tmux new -A -s terminion"
              spellCheck={false}
              onChange={(event) => patch({ startupCommand: event.target.value })}
            />
            <span className="hint">
              Runs every time the shell opens, including after an automatic reconnect.
              A command like <code>tmux new -A -s work</code> keeps remote processes alive
              across network changes.
            </span>
          </div>

          <div className="field">
            <label htmlFor="host-keepalive">Keepalive interval</label>
            <select
              id="host-keepalive"
              className="select"
              value={form.keepaliveSecs}
              onChange={(event) => patch({ keepaliveSecs: Number(event.target.value) })}
            >
              {KEEPALIVE_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  Every {seconds} seconds
                </option>
              ))}
            </select>
            <span className="hint">
              Small keepalive packets detect a dead link quickly. Three missed replies
              trigger a reconnect.
            </span>
          </div>

          <div className="panel">
            <Switch
              checked={form.autoReconnect}
              onChange={(value) => patch({ autoReconnect: value })}
              label="Reconnect automatically"
              description="If the connection drops, Terminion retries with backoff and restores the terminal you already have open."
            />
          </div>

          <div className="panel">
            <Switch
              checked={form.favorite}
              onChange={(value) => patch({ favorite: value })}
              label="Pin to favorites"
              description="Favorites are listed first in the sidebar."
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
