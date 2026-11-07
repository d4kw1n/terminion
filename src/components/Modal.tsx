import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 560,
  className = "",
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const timer = window.setTimeout(() => {
      const focusable = ref.current?.querySelector<HTMLElement>(
        "input:not([type=hidden]), textarea, select, button.primary-action",
      );
      focusable?.focus();
    }, 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${className}`}
        style={{ width, maxWidth: "calc(100vw - 48px)" }}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <div className="modal-head-text">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch-row ${disabled ? "is-disabled" : ""}`}>
      <span className="switch-text">
        {label && <span className="switch-label">{label}</span>}
        {description && <span className="switch-desc">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`switch ${checked ? "is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </label>
  );
}
