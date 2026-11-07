import { useState } from "react";

import { Icon } from "../components/Icon";
import { Modal, Switch } from "../components/Modal";
import { useStore } from "../store";
import type { ForwardKind, PortForward } from "../lib/types";

interface Draft {
  id: number | null;
  hostId: number | null;
  label: string;
  kind: ForwardKind;
  listenHost: string;
  listenPort: string;
  targetHost: string;
  targetPort: string;
  autoStart: boolean;
}

const KIND_LABEL: Record<ForwardKind, string> = {
  local: "Local",
  remote: "Remote",
  dynamic: "SOCKS5",
};

function emptyDraft(hostId: number | null): Draft {
  return {
    id: null,
    hostId,
    label: "",
    kind: "local",
    listenHost: "127.0.0.1",
    listenPort: "8080",
    targetHost: "localhost",
    targetPort: "80",
    autoStart: false,
  };
}

export function ForwardsPage() {
  const forwards = useStore((s) => s.forwards);
  const hosts = useStore((s) => s.hosts);
  const running = useStore((s) => s.runningForwards);
  const saveForward = useStore((s) => s.saveForward);
  const deleteForward = useStore((s) => s.deleteForward);
  const toggleForward = useStore((s) => s.toggleForward);
  const askConfirm = useStore((s) => s.askConfirm);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  const startNew = () => {
    setDraft(emptyDraft(hosts[0]?.id ?? null));
    setError("");
  };

  const edit = (forward: PortForward) => {
    setDraft({
      id: forward.id,
      hostId: forward.hostId,
      label: forward.label,
      kind: forward.kind,
      listenHost: forward.listenHost,
      listenPort: String(forward.listenPort),
      targetHost: forward.targetHost ?? "",
      targetPort: forward.targetPort ? String(forward.targetPort) : "",
      autoStart: forward.autoStart,
    });
    setError("");
  };

  const submit = async () => {
    if (!draft) return;
    if (!draft.label.trim()) {
      setError("Give the tunnel a name.");
      return;
    }
    if (!draft.hostId) {
      setError("Choose the host to tunnel through.");
      return;
    }
    const listenPort = Number(draft.listenPort);
    if (!Number.isFinite(listenPort) || listenPort < 0 || listenPort > 65535) {
      setError("Listen port must be between 0 and 65535.");
      return;
    }
    if (draft.kind !== "dynamic") {
      if (!draft.targetHost.trim()) {
        setError("Enter the destination host.");
        return;
      }
      const targetPort = Number(draft.targetPort);
      if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
        setError("Destination port must be between 1 and 65535.");
        return;
      }
    }
    await saveForward({
      id: draft.id,
      hostId: draft.hostId,
      label: draft.label.trim(),
      kind: draft.kind,
      listenHost: draft.listenHost.trim() || "127.0.0.1",
      listenPort,
      targetHost: draft.kind === "dynamic" ? null : draft.targetHost.trim(),
      targetPort: draft.kind === "dynamic" ? null : Number(draft.targetPort),
      autoStart: draft.autoStart,
    });
    setDraft(null);
  };

  const hostName = (id: number) => hosts.find((h) => h.id === id)?.label ?? "Unknown host";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Port forwarding</h1>
          <p>Tunnels that start with the app or on demand.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={startNew} disabled={hosts.length === 0}>
            <Icon name="plus" size={15} /> New tunnel
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="callout callout--page">
          <Icon name="info" size={16} />
          <div>
            <strong>Local</strong> exposes a remote service on this machine.{" "}
            <strong>Remote</strong> exposes a local service on the server.{" "}
            <strong>SOCKS5</strong> turns the SSH host into a proxy — point apps at
            the local port and they browse through the server.
          </div>
        </div>

        {forwards.length === 0 ? (
          <div className="page-empty">
            <div className="empty-orb">
              <Icon name="swap" size={26} />
            </div>
            <h2>No tunnels yet</h2>
            <p>
              Forward a database port, reach an internal dashboard, or route a
              browser through your server with SOCKS5.
            </p>
            <button className="btn btn-primary" onClick={startNew} disabled={hosts.length === 0}>
              <Icon name="plus" size={15} /> Create a tunnel
            </button>
            {hosts.length === 0 && (
              <p className="page-empty-hint">Add a host first, then create tunnels through it.</p>
            )}
          </div>
        ) : (
          <div className="forward-table">
            <div className="forward-head">
              <span>Status</span>
              <span>Tunnel</span>
              <span>Host</span>
              <span>Address</span>
              <span />
            </div>
            {forwards.map((forward) => {
              const boundPort = running[forward.id];
              const isRunning = boundPort !== undefined;
              const listenPort = forward.listenPort === 0 ? boundPort : forward.listenPort;
              return (
                <div className="forward-row" key={forward.id}>
                  <button
                    className={`toggle ${isRunning ? "is-on" : ""}`}
                    onClick={() => void toggleForward(forward.id, !isRunning)}
                    title={isRunning ? "Stop tunnel" : "Start tunnel"}
                    aria-label={isRunning ? "Stop tunnel" : "Start tunnel"}
                  >
                    <span className="toggle-thumb" />
                  </button>
                  <div className="forward-name-cell">
                    <span className="forward-label">{forward.label}</span>
                    <span className={`kind-pill kind-${forward.kind}`}>
                      {KIND_LABEL[forward.kind]}
                    </span>
                    {forward.autoStart && (
                      <span className="pill pill--tiny" title="Starts with the app">
                        auto
                      </span>
                    )}
                  </div>
                  <span className="forward-host">
                    <Icon name="server" size={13} /> {hostName(forward.hostId)}
                  </span>
                  <span className="forward-addr" title="Click to copy">
                    <button
                      className="addr"
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          `${forward.listenHost}:${listenPort ?? forward.listenPort}`,
                        )
                      }
                    >
                      {forward.listenHost}:{listenPort ?? forward.listenPort}
                    </button>
                    {forward.kind !== "dynamic" && (
                      <>
                        <Icon name="arrow-right" size={12} className="addr-arrow" />
                        <span className="addr-target">
                          {forward.targetHost}:{forward.targetPort}
                        </span>
                      </>
                    )}
                  </span>
                  <div className="forward-actions">
                    <span className={`forward-state ${isRunning ? "is-on" : ""}`}>
                      {isRunning ? "Active" : "Idle"}
                    </span>
                    <button className="icon-btn" title="Edit" onClick={() => edit(forward)}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Delete"
                      onClick={() =>
                        askConfirm({
                          title: `Delete “${forward.label}”?`,
                          message: "The tunnel is stopped and removed.",
                          confirmLabel: "Delete tunnel",
                          danger: true,
                          onConfirm: () => void deleteForward(forward.id),
                        })
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit tunnel" : "New tunnel"}
        subtitle="Tunnels reuse a dedicated SSH connection."
        width={600}
        footer={
          <>
            <span className="foot-hint">
              <Icon name="shield" size={13} /> Encrypted inside SSH
            </span>
            <span className="spacer" />
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn btn-primary primary-action" onClick={() => void submit()}>
              {draft?.id ? "Save tunnel" : "Create tunnel"}
            </button>
          </>
        }
      >
        <div className="form-stack">
          <div className="field-row">
            <div className={`field ${error && !draft?.label ? "has-error" : ""}`}>
              <label htmlFor="fwd-label">Name</label>
              <input
                id="fwd-label"
                className="input"
                value={draft?.label ?? ""}
                placeholder="Postgres via bastion"
                onChange={(event) =>
                  setDraft((d) => (d ? { ...d, label: event.target.value } : d))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="fwd-host">Host</label>
              <select
                id="fwd-host"
                className="select"
                value={draft?.hostId ?? ""}
                onChange={(event) =>
                  setDraft((d) =>
                    d ? { ...d, hostId: Number(event.target.value) } : d,
                  )
                }
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label} · {host.hostname}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label>Type</label>
            <div className="segmented segmented--wide">
              {(["local", "remote", "dynamic"] as ForwardKind[]).map((kind) => (
                <button
                  key={kind}
                  className={draft?.kind === kind ? "is-active" : ""}
                  onClick={() => setDraft((d) => (d ? { ...d, kind } : d))}
                >
                  {KIND_LABEL[kind]}
                </button>
              ))}
            </div>
            <span className="hint">
              {draft?.kind === "local" &&
                "Listen on this machine and forward traffic to a host reachable from the server."}
              {draft?.kind === "remote" &&
                "Ask the server to listen on its side and forward traffic back to this machine."}
              {draft?.kind === "dynamic" &&
                "Run a local SOCKS5 proxy; destinations are resolved as clients connect."}
            </span>
          </div>

          <div className="field-row field-row--host">
            <div className="field">
              <label htmlFor="fwd-listen-host">Listen host</label>
              <input
                id="fwd-listen-host"
                className="input"
                value={draft?.listenHost ?? ""}
                placeholder="127.0.0.1"
                spellCheck={false}
                onChange={(event) =>
                  setDraft((d) => (d ? { ...d, listenHost: event.target.value } : d))
                }
              />
            </div>
            <div className="field field--port">
              <label htmlFor="fwd-listen-port">Port</label>
              <input
                id="fwd-listen-port"
                className="input"
                value={draft?.listenPort ?? ""}
                inputMode="numeric"
                onChange={(event) =>
                  setDraft((d) =>
                    d ? { ...d, listenPort: event.target.value.replace(/[^\d]/g, "") } : d,
                  )
                }
              />
            </div>
          </div>
          <span className="hint">Use port 0 to let the system pick a free port.</span>

          {draft?.kind !== "dynamic" && (
            <div className="field-row field-row--host">
              <div className="field">
                <label htmlFor="fwd-target-host">Destination host</label>
                <input
                  id="fwd-target-host"
                  className="input"
                  value={draft?.targetHost ?? ""}
                  placeholder="localhost"
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft((d) => (d ? { ...d, targetHost: event.target.value } : d))
                  }
                />
              </div>
              <div className="field field--port">
                <label htmlFor="fwd-target-port">Port</label>
                <input
                  id="fwd-target-port"
                  className="input"
                  value={draft?.targetPort ?? ""}
                  inputMode="numeric"
                  onChange={(event) =>
                    setDraft((d) =>
                      d ? { ...d, targetPort: event.target.value.replace(/[^\d]/g, "") } : d,
                    )
                  }
                />
              </div>
            </div>
          )}

          <div className="panel">
            <Switch
              checked={draft?.autoStart ?? false}
              onChange={(value) => setDraft((d) => (d ? { ...d, autoStart: value } : d))}
              label="Start with Terminion"
              description="Re-open this tunnel automatically when the app launches."
            />
          </div>

          {error && <div className="form-error">{error}</div>}
        </div>
      </Modal>
    </div>
  );
}
