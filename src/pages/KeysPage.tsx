import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { api } from "../lib/api";
import { formatDate } from "../lib/utils";
import { useStore } from "../store";
import type { KeyEntry } from "../lib/types";

interface ImportDraft {
  mode: "file" | "paste";
  path: string;
  name: string;
  passphrase: string;
  text: string;
}

const EMPTY_IMPORT: ImportDraft = {
  mode: "file",
  path: "",
  name: "",
  passphrase: "",
  text: "",
};

export function KeysPage() {
  const keys = useStore((s) => s.keys);
  const hosts = useStore((s) => s.hosts);
  const refreshKeys = useStore((s) => s.refreshKeys);
  const refreshHosts = useStore((s) => s.refreshHosts);
  const addToast = useStore((s) => s.addToast);
  const askConfirm = useStore((s) => s.askConfirm);

  const [generateOpen, setGenerateOpen] = useState(false);
  const [genName, setGenName] = useState("");
  const [genComment, setGenComment] = useState("");
  const [genPassphrase, setGenPassphrase] = useState("");
  const [genBusy, setGenBusy] = useState(false);

  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const [viewKey, setViewKey] = useState<KeyEntry | null>(null);

  const usage = useMemo(() => {
    const map = new Map<number, number>();
    for (const host of hosts) {
      if (host.keyId) map.set(host.keyId, (map.get(host.keyId) ?? 0) + 1);
    }
    return map;
  }, [hosts]);

  const generate = async () => {
    setGenBusy(true);
    try {
      await api.generateKey(
        genName.trim() || "Terminion key",
        genComment.trim() || null,
        genPassphrase || null,
      );
      await refreshKeys();
      setGenerateOpen(false);
      setGenName("");
      setGenComment("");
      setGenPassphrase("");
      addToast({ type: "success", title: "Ed25519 key generated" });
    } catch (err) {
      addToast({ type: "error", title: "Could not generate key", message: String(err) });
    } finally {
      setGenBusy(false);
    }
  };

  const pickFile = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      title: "Import a private key",
    });
    if (typeof picked !== "string") return;
    setImportDraft((draft) =>
      draft
        ? {
            ...draft,
            path: picked,
            name:
              draft.name ||
              picked.split(/[\\/]/).pop()?.replace(/\.pub$/, "") ||
              "Imported key",
          }
        : draft,
    );
  };

  const doImport = async () => {
    if (!importDraft) return;
    if (importDraft.mode === "file" && !importDraft.path) {
      addToast({ type: "warning", title: "Choose a private key file first" });
      return;
    }
    if (importDraft.mode === "paste" && !importDraft.text.trim()) {
      addToast({ type: "warning", title: "Paste the key contents first" });
      return;
    }
    setImportBusy(true);
    try {
      if (importDraft.mode === "file") {
        await api.importKey(
          importDraft.path,
          importDraft.name.trim() || null,
          importDraft.passphrase || null,
        );
      } else {
        await api.importKeyText(
          importDraft.name.trim() || "Imported key",
          importDraft.text,
          importDraft.passphrase || null,
          null,
        );
      }
      await refreshKeys();
      setImportDraft(null);
      addToast({ type: "success", title: "SSH key imported" });
    } catch (err) {
      addToast({
        type: "error",
        title: "Could not import key",
        message: String(err),
      });
    } finally {
      setImportBusy(false);
    }
  };

  const removeKey = (key: KeyEntry) => {
    askConfirm({
      title: `Delete “${key.name}”?`,
      message:
        usage.get(key.id) && usage.get(key.id)! > 0
          ? `This key is used by ${usage.get(key.id)} host(s). They will need another authentication method.`
          : "The private key will be removed from this device. Make sure you have a copy.",
      confirmLabel: "Delete key",
      danger: true,
      onConfirm: async () => {
        try {
          await api.deleteKey(key.id);
          await Promise.all([refreshKeys(), refreshHosts()]);
        } catch (err) {
          addToast({ type: "error", title: "Could not delete key", message: String(err) });
        }
      },
    });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>SSH keys</h1>
          <p>Generate a key here, or import the ones you already use.</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setImportDraft({ ...EMPTY_IMPORT })}>
            <Icon name="download" size={15} /> Import
          </button>
          <button className="btn btn-primary" onClick={() => setGenerateOpen(true)}>
            <Icon name="plus" size={15} /> Generate key
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="callout callout--page">
          <Icon name="lock" size={16} />
          <div>
            Private keys are sealed with Windows DPAPI and never leave this
            machine. Only the public key is meant to be copied to servers.
          </div>
        </div>

        {keys.length === 0 ? (
          <div className="page-empty">
            <div className="empty-orb">
              <Icon name="key" size={26} />
            </div>
            <h2>No SSH keys yet</h2>
            <p>
              Ed25519 is a good modern default. Import an existing key if your
              servers already trust one.
            </p>
            <div className="overlay-actions">
              <button className="btn btn-primary" onClick={() => setGenerateOpen(true)}>
                <Icon name="plus" size={15} /> Generate Ed25519 key
              </button>
              <button className="btn" onClick={() => setImportDraft({ ...EMPTY_IMPORT })}>
                <Icon name="download" size={15} /> Import key
              </button>
            </div>
          </div>
        ) : (
          <div className="key-grid">
            {keys.map((key) => (
              <article className="key-card" key={key.id}>
                <div className="key-head">
                  <span className="key-icon">
                    <Icon name="key" size={17} />
                  </span>
                  <div className="key-title">
                    <h3>{key.name}</h3>
                    <span className="key-type">{key.type}</span>
                  </div>
                  <span className="spacer" />
                  <button className="icon-btn" title="Delete" onClick={() => removeKey(key)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
                <div className="key-fingerprint" title="SHA-256 fingerprint">
                  {key.fingerprint}
                </div>
                <div className="key-meta">
                  <span>Added {formatDate(key.createdAt)}</span>
                  {key.hasPassphrase && <span className="pill pill--tiny">passphrase</span>}
                  {usage.get(key.id) ? (
                    <span className="pill pill--tiny pill--accent">
                      {usage.get(key.id)} host{usage.get(key.id) === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
                <div className="key-actions">
                  <button className="btn btn-sm" onClick={() => setViewKey(key)}>
                    <Icon name="eye" size={13} /> Public key
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(key.publicKey);
                      addToast({
                        type: "success",
                        title: "Public key copied",
                        message: "Paste it into ~/.ssh/authorized_keys",
                      });
                    }}
                  >
                    <Icon name="copy" size={13} /> Copy
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        title="Generate an SSH key"
        subtitle="Ed25519 · 256-bit elliptic curve"
        width={520}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setGenerateOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary primary-action"
              disabled={genBusy}
              onClick={() => void generate()}
            >
              {genBusy ? <Icon name="loader" size={14} className="spin" /> : <Icon name="key" size={14} />}
              Generate
            </button>
          </>
        }
      >
        <div className="form-stack">
          <div className="field">
            <label htmlFor="gen-name">Name</label>
            <input
              id="gen-name"
              className="input"
              value={genName}
              placeholder="Work laptop"
              onChange={(event) => setGenName(event.target.value)}
            />
            <span className="hint">Only used inside Terminion.</span>
          </div>
          <div className="field">
            <label htmlFor="gen-comment">Comment</label>
            <input
              id="gen-comment"
              className="input"
              value={genComment}
              placeholder="you@laptop"
              onChange={(event) => setGenComment(event.target.value)}
            />
            <span className="hint">Appended to the public key. Handy when auditing servers.</span>
          </div>
          <div className="field">
            <label htmlFor="gen-passphrase">Passphrase (optional)</label>
            <input
              id="gen-passphrase"
              className="input"
              type="password"
              value={genPassphrase}
              placeholder="Leave empty for no passphrase"
              autoComplete="new-password"
              onChange={(event) => setGenPassphrase(event.target.value)}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={importDraft !== null}
        onClose={() => setImportDraft(null)}
        title="Import an SSH key"
        subtitle="OpenSSH, PEM or PuTTY keys are supported."
        width={560}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setImportDraft(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary primary-action"
              disabled={importBusy}
              onClick={() => void doImport()}
            >
              {importBusy ? <Icon name="loader" size={14} className="spin" /> : <Icon name="download" size={14} />}
              Import key
            </button>
          </>
        }
      >
        {importDraft && (
          <div className="form-stack">
            <div className="segmented segmented--wide">
              <button
                className={importDraft.mode === "file" ? "is-active" : ""}
                onClick={() => setImportDraft({ ...importDraft, mode: "file" })}
              >
                From file
              </button>
              <button
                className={importDraft.mode === "paste" ? "is-active" : ""}
                onClick={() => setImportDraft({ ...importDraft, mode: "paste" })}
              >
                Paste key
              </button>
            </div>

            {importDraft.mode === "file" ? (
              <div className="field">
                <label>Private key file</label>
                <button className="file-picker" onClick={() => void pickFile()}>
                  <Icon name="file" size={16} />
                  <span>{importDraft.path || "Choose ~/.ssh/id_ed25519…"}</span>
                  <span className="spacer" />
                  <span className="btn btn-sm">Browse</span>
                </button>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="key-pem">Private key contents</label>
                <textarea
                  id="key-pem"
                  className="input textarea input--mono"
                  rows={7}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
                  spellCheck={false}
                  value={importDraft.text}
                  onChange={(event) =>
                    setImportDraft({ ...importDraft, text: event.target.value })
                  }
                />
              </div>
            )}

            <div className="field-row">
              <div className="field">
                <label htmlFor="import-name">Name</label>
                <input
                  id="import-name"
                  className="input"
                  value={importDraft.name}
                  placeholder="Imported key"
                  onChange={(event) =>
                    setImportDraft({ ...importDraft, name: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="import-pass">Passphrase</label>
                <input
                  id="import-pass"
                  className="input"
                  type="password"
                  value={importDraft.passphrase}
                  placeholder="Only if encrypted"
                  autoComplete="new-password"
                  onChange={(event) =>
                    setImportDraft({ ...importDraft, passphrase: event.target.value })
                  }
                />
              </div>
            </div>
            <span className="hint">
              The passphrase is stored alongside the key, both sealed with DPAPI.
            </span>
          </div>
        )}
      </Modal>

      <Modal
        open={viewKey !== null}
        onClose={() => setViewKey(null)}
        title={viewKey?.name ?? "Public key"}
        subtitle="Safe to share — add this to authorized_keys on your servers."
        width={720}
        footer={
          <>
            <span className="spacer" />
            <button
              className="btn"
              onClick={() => {
                if (!viewKey) return;
                void navigator.clipboard.writeText(viewKey.publicKey);
                addToast({ type: "success", title: "Public key copied" });
              }}
            >
              <Icon name="copy" size={14} /> Copy public key
            </button>
            <button className="btn btn-primary" onClick={() => setViewKey(null)}>
              Done
            </button>
          </>
        }
      >
        <pre className="public-key-body">{viewKey?.publicKey}</pre>
      </Modal>
    </div>
  );
}
