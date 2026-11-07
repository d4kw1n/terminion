import { useEffect, useState } from "react";

import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { HOST_COLORS } from "../lib/utils";
import { useStore } from "../store";

export function GroupEditor() {
  const state = useStore((s) => s.groupEditor);
  const close = useStore((s) => s.closeGroupEditor);
  const saveGroup = useStore((s) => s.saveGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const askConfirm = useStore((s) => s.askConfirm);

  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state.open) return;
    setName(state.group?.name ?? "");
    setColor(state.group?.color ?? HOST_COLORS[0]);
    setError("");
    setSaving(false);
  }, [state.open, state.group]);

  const submit = async () => {
    if (!name.trim()) {
      setError("Give the group a name.");
      return;
    }
    setSaving(true);
    await saveGroup({
      id: state.group?.id ?? null,
      name: name.trim(),
      color,
      sort: state.group?.sort ?? null,
    });
    setSaving(false);
  };

  return (
    <Modal
      open={state.open}
      onClose={close}
      title={state.group ? "Edit group" : "New group"}
      subtitle="Groups keep large fleets organised."
      width={440}
      footer={
        <>
          {state.group && (
            <button
              className="btn btn-danger-ghost"
              onClick={() =>
                askConfirm({
                  title: `Delete “${state.group?.name}”?`,
                  message: "Hosts stay saved and move to Ungrouped.",
                  confirmLabel: "Delete group",
                  danger: true,
                  onConfirm: () => {
                    close();
                    if (state.group) void deleteGroup(state.group.id);
                  },
                })
              }
            >
              <Icon name="trash" size={14} /> Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary primary-action" disabled={saving} onClick={() => void submit()}>
            {saving ? <Icon name="loader" size={14} className="spin" /> : null}
            {state.group ? "Save group" : "Create group"}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <div className={`field ${error ? "has-error" : ""}`}>
          <label htmlFor="group-name">Name</label>
          <input
            id="group-name"
            className="input"
            value={name}
            placeholder="Production"
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          {error && <span className="error-text">{error}</span>}
        </div>
        <div className="field">
          <label>Color</label>
          <div className="swatches">
            {HOST_COLORS.map((value) => (
              <button
                key={value}
                type="button"
                className={`swatch ${color === value ? "is-selected" : ""}`}
                style={{ background: value }}
                onClick={() => setColor(value)}
                title={value}
              >
                {color === value && <Icon name="check" size={12} strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
