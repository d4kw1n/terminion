import { useMemo, useState } from "react";

import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { Snippet } from "../lib/types";

interface Draft {
  id: number | null;
  label: string;
  command: string;
  tags: string;
}

const EMPTY: Draft = { id: null, label: "", command: "", tags: "" };

export function SnippetsPage() {
  const snippets = useStore((s) => s.snippets);
  const saveSnippet = useStore((s) => s.saveSnippet);
  const deleteSnippet = useStore((s) => s.deleteSnippet);
  const askConfirm = useStore((s) => s.askConfirm);
  const addToast = useStore((s) => s.addToast);

  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return snippets;
    return snippets.filter((snippet) =>
      [snippet.label, snippet.command, ...snippet.tags]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [snippets, search]);

  const run = (snippet: Snippet) => {
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
      void api.terminalRun(target.sessionId, snippet.command);
      addToast({ type: "success", title: "Snippet sent", message: target.title });
    } else {
      void navigator.clipboard.writeText(snippet.command);
      addToast({
        type: "info",
        title: "No active terminal",
        message: "Copied to the clipboard instead.",
      });
    }
  };

  const submit = async () => {
    if (!draft) return;
    if (!draft.label.trim()) {
      setError("Give the snippet a name.");
      return;
    }
    if (!draft.command.trim()) {
      setError("The command cannot be empty.");
      return;
    }
    await saveSnippet({
      id: draft.id,
      label: draft.label.trim(),
      command: draft.command,
      tags: draft.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setDraft(null);
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Snippets</h1>
          <p>Reusable commands you can fire into the active terminal.</p>
        </div>
        <div className="page-actions">
          <div className="search-field search-field--compact">
            <Icon name="search" size={14} className="search-icon" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter snippets"
              spellCheck={false}
            />
          </div>
          <button className="btn btn-primary" onClick={() => setDraft({ ...EMPTY })}>
            <Icon name="plus" size={15} /> New snippet
          </button>
        </div>
      </header>

      <div className="page-body">
        {filtered.length === 0 ? (
          <div className="page-empty">
            <div className="empty-orb">
              <Icon name="code" size={26} />
            </div>
            <h2>{snippets.length === 0 ? "No snippets yet" : "No matches"}</h2>
            <p>
              {snippets.length === 0
                ? "Save commands you run often — restarts, log tails, deploys — and send them with one click."
                : "Try a different search term."}
            </p>
            {snippets.length === 0 && (
              <button className="btn btn-primary" onClick={() => setDraft({ ...EMPTY })}>
                <Icon name="plus" size={15} /> Create your first snippet
              </button>
            )}
          </div>
        ) : (
          <div className="snippet-grid">
            {filtered.map((snippet) => (
              <article className="snippet-card" key={snippet.id}>
                <div className="snippet-head">
                  <span className="snippet-icon">
                    <Icon name="terminal" size={15} />
                  </span>
                  <h3>{snippet.label}</h3>
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    title="Edit"
                    onClick={() =>
                      setDraft({
                        id: snippet.id,
                        label: snippet.label,
                        command: snippet.command,
                        tags: snippet.tags.join(", "),
                      })
                    }
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Delete"
                    onClick={() =>
                      askConfirm({
                        title: `Delete “${snippet.label}”?`,
                        message: "This snippet will be removed from this device.",
                        confirmLabel: "Delete snippet",
                        danger: true,
                        onConfirm: () => void deleteSnippet(snippet.id),
                      })
                    }
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
                <pre className="snippet-command">{snippet.command}</pre>
                <div className="snippet-foot">
                  <div className="tag-row">
                    {snippet.tags.map((tag) => (
                      <span className="tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    title="Copy command"
                    onClick={() => {
                      void navigator.clipboard.writeText(snippet.command);
                      addToast({ type: "success", title: "Copied to clipboard" });
                    }}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => run(snippet)}>
                    <Icon name="play" size={12} /> Run
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit snippet" : "New snippet"}
        subtitle="Snippets run in whichever terminal is active."
        width={560}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn btn-primary primary-action" onClick={() => void submit()}>
              {draft?.id ? "Save changes" : "Create snippet"}
            </button>
          </>
        }
      >
        <div className="form-stack">
          <div className={`field ${error ? "has-error" : ""}`}>
            <label htmlFor="snippet-label">Name</label>
            <input
              id="snippet-label"
              className="input"
              value={draft?.label ?? ""}
              placeholder="Tail application log"
              onChange={(event) => {
                setDraft((d) => (d ? { ...d, label: event.target.value } : d));
                setError("");
              }}
            />
            {error && <span className="error-text">{error}</span>}
          </div>
          <div className="field">
            <label htmlFor="snippet-command">Command</label>
            <textarea
              id="snippet-command"
              className="input textarea input--mono"
              rows={4}
              value={draft?.command ?? ""}
              placeholder="tail -f /var/log/nginx/error.log"
              spellCheck={false}
              onChange={(event) =>
                setDraft((d) => (d ? { ...d, command: event.target.value } : d))
              }
            />
            <span className="hint">A carriage return is appended when the snippet runs.</span>
          </div>
          <div className="field">
            <label htmlFor="snippet-tags">Tags</label>
            <input
              id="snippet-tags"
              className="input"
              value={draft?.tags ?? ""}
              placeholder="logs, nginx"
              onChange={(event) =>
                setDraft((d) => (d ? { ...d, tags: event.target.value } : d))
              }
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
