import { Icon, type IconName } from "./Icon";
import { useStore } from "../store";
import type { Toast } from "../lib/types";

const ICONS: Record<Toast["type"], IconName> = {
  info: "info",
  success: "check",
  error: "alert-circle",
  warning: "alert-triangle",
};

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.type}`}>
          <span className="toast-icon">
            <Icon name={ICONS[toast.type]} size={16} />
          </span>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            {toast.message && <div className="toast-message">{toast.message}</div>}
            {toast.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button className="toast-close" onClick={() => dismiss(toast.id)} title="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
