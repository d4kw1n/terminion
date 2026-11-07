import { Modal } from "./Modal";
import { useStore } from "../store";

export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const close = useStore((s) => s.closeConfirm);

  return (
    <Modal
      open={Boolean(confirm)}
      onClose={close}
      title={confirm?.title ?? ""}
      width={460}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className={`btn ${confirm?.danger ? "btn-danger" : "btn-primary"} primary-action`}
            onClick={() => {
              const action = confirm?.onConfirm;
              close();
              action?.();
            }}
          >
            {confirm?.confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      <p className="confirm-message">{confirm?.message}</p>
    </Modal>
  );
}
