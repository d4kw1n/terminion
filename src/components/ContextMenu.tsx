import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  label?: string;
  icon?: IconName;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
  checked?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  minWidth?: number;
}

export function ContextMenu({ x, y, items, onClose, minWidth = 208 }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8);
    if (ny + rect.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - rect.height - 8);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onDown = (event: MouseEvent) => {
      if (ref.current && ref.current.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y, minWidth }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      {items.map((item, index) => {
        if (item.separator) {
          return <div key={`sep-${index}`} className="ctx-sep" />;
        }
        return (
          <button
            key={`${item.label}-${index}`}
            className={`ctx-item ${item.danger ? "is-danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onClick?.();
            }}
            role="menuitem"
          >
            <span className="ctx-icon">
              {item.icon ? <Icon name={item.icon} size={15} /> : null}
              {item.checked && <Icon name="check" size={14} />}
            </span>
            <span className="ctx-label">{item.label}</span>
            {item.hint && <span className="ctx-hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
