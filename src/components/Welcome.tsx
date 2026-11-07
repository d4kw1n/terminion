import { Icon } from "./Icon";
import { useStore } from "../store";

export function Welcome() {
  const openHostEditor = useStore((s) => s.openHostEditor);
  const importSshConfig = useStore((s) => s.importSshConfig);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const version = useStore((s) => s.appInfo?.version ?? "0.1.2");

  return (
    <div className="welcome welcome--minimal">
      <div className="welcome-inner">
        <div className="welcome-kicker">Terminion</div>
        <h1 className="welcome-title">No active session</h1>
        <p className="welcome-copy">
          Double-click a host in the sidebar to connect, or use Quick connect.
        </p>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={() => openHostEditor()}>
            <Icon name="plus" size={16} />
            New host
            <kbd className="btn-kbd">Ctrl N</kbd>
          </button>
          <button className="btn" onClick={() => void importSshConfig()}>
            <Icon name="download" size={16} />
            Import SSH config
          </button>
          <button className="btn" onClick={() => setPaletteOpen(true)}>
            <Icon name="command" size={16} />
            Quick connect
            <kbd className="btn-kbd">Ctrl K</kbd>
          </button>
        </div>

        <div className="welcome-footer">
          Terminion {version}
          <span className="dot-sep">·</span>
          <button
            className="link-btn"
            onClick={() => useStore.getState().openPage("settings")}
          >
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}
