import type { CSSProperties } from "react";

import { Icon } from "./Icon";
import { useStore } from "../store";

export function TabDragLayer() {
  const drag = useStore((s) => s.tabDrag);
  const draggedTab = useStore((s) =>
    drag ? s.tabs.find((tab) => tab.id === drag.tabId) : undefined,
  );
  const title = draggedTab?.customTitle ?? draggedTab?.title ?? "Terminal";
  const icon =
    draggedTab?.kind === "sftp"
      ? "folder"
      : draggedTab?.kind === "page"
        ? "code"
        : "terminal";

  if (!drag) return null;

  let zoneStyle: CSSProperties | null = null;
  if (drag.rect && drag.side) {
    const { left, top, width, height } = drag.rect;
    zoneStyle =
      drag.side === "left"
        ? { left, top, width: width / 2, height }
        : drag.side === "right"
          ? { left: left + width / 2, top, width: width / 2, height }
          : drag.side === "top"
            ? { left, top, width, height: height / 2 }
            : { left, top: top + height / 2, width, height: height / 2 };
  }

  return (
    <div className="tab-drag-layer" aria-hidden="true">
      <div className="tab-drag-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
        <Icon name={icon} size={13} />
        <span>{title}</span>
      </div>
      {drag.tabDrop && (
        <div
          className="tab-drop-line"
          style={{
            left: drag.tabDrop.x,
            top: drag.tabDrop.y,
            height: drag.tabDrop.height,
          }}
        />
      )}
      {zoneStyle && drag.side && (
        <div className={`tab-drag-zone tab-drag-zone--${drag.side}`} style={zoneStyle}>
          <span>Split {drag.side}</span>
        </div>
      )}
    </div>
  );
}
