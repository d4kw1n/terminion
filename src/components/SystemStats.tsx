import { useEffect, useState } from "react";

import { Icon } from "./Icon";
import { api } from "../lib/api";
import type { ProcessStats as Stats } from "../lib/types";

function formatRam(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

function formatCpu(percent: number) {
  return percent < 10 ? percent.toFixed(1) : Math.round(percent).toString();
}

export function SystemStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const poll = async () => {
      if (document.hidden) return;
      try {
        const next = await api.processStats();
        if (!disposed) setStats(next);
      } catch {
        // The indicator is diagnostic only; never disturb the workspace.
      }
    };

    void poll();
    timer = window.setInterval(poll, 2000);
    return () => {
      disposed = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);

  if (!stats) return null;

  return (
    <div
      className="sys-stats"
      title={`Private memory across ${stats.processCount} processes · CPU ${stats.cpuPercent.toFixed(
        1,
      )}% of all logical processors`}
    >
      <span className="sys-stat">
        <Icon name="hard-drive" size={12} />
        {formatRam(stats.ramMb)}
      </span>
      <span className="sys-stat">
        <Icon name="cpu" size={12} />
        {formatCpu(stats.cpuPercent)}%
      </span>
    </div>
  );
}
