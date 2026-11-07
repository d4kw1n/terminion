import { useMemo, useState } from "react";

import { Icon } from "../components/Icon";
import { formatDate } from "../lib/utils";
import { useStore } from "../store";

export function KnownHostsPage() {
  const knownHosts = useStore((s) => s.knownHosts);
  const deleteKnownHost = useStore((s) => s.deleteKnownHost);
  const askConfirm = useStore((s) => s.askConfirm);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return knownHosts;
    return knownHosts.filter((entry) =>
      `${entry.endpoint} ${entry.keyType} ${entry.fingerprint}`
        .toLowerCase()
        .includes(query),
    );
  }, [knownHosts, search]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Known hosts</h1>
          <p>Server keys Terminion has trusted on this device.</p>
        </div>
        <div className="page-actions">
          <div className="search-field search-field--compact">
            <Icon name="search" size={14} className="search-icon" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter hosts"
              spellCheck={false}
            />
          </div>
        </div>
      </header>

      <div className="page-body">
        <div className="callout callout--page">
          <Icon name="shield" size={16} />
          <div>
            On first connect the server's key is remembered (trust on first use).
            If a known server later presents a different key, the connection is
            blocked — remove the entry only when you know the server was rebuilt
            or rekeyed.
          </div>
        </div>

        {knownHosts.length === 0 ? (
          <div className="page-empty">
            <div className="empty-orb">
              <Icon name="shield" size={26} />
            </div>
            <h2>No trusted hosts yet</h2>
            <p>
              Connect to a server and its host key will appear here after the
              first successful handshake.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="page-empty">
            <h2>No matches</h2>
            <p>Nothing matches “{search}”.</p>
          </div>
        ) : (
          <div className="known-table">
            <div className="known-head">
              <span>Endpoint</span>
              <span>Key type</span>
              <span>SHA-256 fingerprint</span>
              <span>Trusted</span>
              <span />
            </div>
            {filtered.map((entry) => (
              <div className="known-row" key={entry.id}>
                <span className="known-endpoint">
                  <Icon name="server" size={14} /> {entry.endpoint}
                </span>
                <span className="pill pill--muted">{entry.keyType.replace("ssh-", "")}</span>
                <span className="known-fingerprint" title={entry.fingerprint}>
                  {entry.fingerprint}
                </span>
                <span className="known-date">{formatDate(entry.addedAt)}</span>
                <button
                  className="icon-btn"
                  title="Forget this host key"
                  onClick={() =>
                    askConfirm({
                      title: `Forget ${entry.endpoint}?`,
                      message:
                        "The next connection will trust whatever key the server presents. Only do this if you know the server key changed.",
                      confirmLabel: "Forget host",
                      danger: true,
                      onConfirm: () => void deleteKnownHost(entry.id),
                    })
                  }
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
