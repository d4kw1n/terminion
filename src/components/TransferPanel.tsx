import { useState } from "react";

import { Icon } from "./Icon";
import { api } from "../lib/api";
import { formatBytes, formatSpeed } from "../lib/utils";
import { useStore } from "../store";

export function TransferPanel() {
  const transfers = useStore((s) => s.transfers);
  const dismiss = useStore((s) => s.dismissTransfer);
  const update = useStore((s) => s.updateTransfer);
  const [minimized, setMinimized] = useState(false);

  if (transfers.length === 0) return null;

  const running = transfers.filter((t) => t.status === "running");
  const finished = transfers.filter((t) => t.status !== "running");

  return (
    <div className={`transfers ${minimized ? "is-minimized" : ""}`}>
      <div className="transfers-head">
        <span className="transfers-title">
          <Icon name="swap" size={14} />
          Transfers
          {running.length > 0 && <span className="transfers-badge">{running.length}</span>}
        </span>
        <span className="spacer" />
        {finished.length > 0 && (
          <button
            className="icon-btn"
            title="Clear finished"
            onClick={() => finished.forEach((t) => dismiss(t.id))}
          >
            <Icon name="trash" size={13} />
          </button>
        )}
        <button
          className="icon-btn"
          title={minimized ? "Expand" : "Minimize"}
          onClick={() => setMinimized((v) => !v)}
        >
          <Icon name={minimized ? "chevron-right" : "chevron-down"} size={14} />
        </button>
      </div>

      {!minimized && (
        <div className="transfers-list">
          {transfers.map((transfer) => {
            const isRunning = transfer.status === "running";
            return (
              <div className={`transfer ${isRunning ? "is-running" : ""}`} key={transfer.id}>
                <span className={`transfer-icon ${transfer.direction}`}>
                  <Icon
                    name={transfer.direction === "upload" ? "upload" : "download"}
                    size={14}
                  />
                </span>
                <div className="transfer-main">
                  <div className="transfer-row">
                    <span className="transfer-name" title={transfer.current || transfer.name}>
                      {transfer.name}
                    </span>
                    <span className={`transfer-state state-${transfer.status}`}>
                      {transfer.status === "running"
                        ? `${Math.round(transfer.percent)}%`
                        : transfer.status === "done"
                          ? "Done"
                          : transfer.status === "cancelled"
                            ? "Cancelled"
                            : "Failed"}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className={`progress-fill ${transfer.status !== "running" ? `is-${transfer.status}` : ""}`}
                      style={{ width: `${Math.max(transfer.percent, isRunning ? 2 : 100)}%` }}
                    />
                  </div>
                  <div className="transfer-row transfer-meta">
                    <span>
                      {formatBytes(transfer.bytes)}
                      {transfer.totalBytes > 0 ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
                      {transfer.totalFiles > 1
                        ? ` · ${transfer.files}/${transfer.totalFiles} files`
                        : ""}
                    </span>
                    <span className="spacer" />
                    {isRunning && transfer.speed > 0 && (
                      <span>{formatSpeed(transfer.speed)}</span>
                    )}
                    {transfer.error && (
                      <span className="transfer-error" title={transfer.error}>
                        {transfer.error}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  className="icon-btn transfer-close"
                  title={isRunning ? "Cancel transfer" : "Dismiss"}
                  onClick={() => {
                    if (isRunning) {
                      api.sftpCancelTransfer(transfer.id).catch(() => {});
                      api.ftpCancelTransfer(transfer.id).catch(() => {});
                      update(transfer.id, { status: "cancelled" });
                    } else {
                      dismiss(transfer.id);
                    }
                  }}
                >
                  <Icon name={isRunning ? "x" : "x"} size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
