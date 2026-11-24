import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { CLOUD_STATUS_LABELS, formatSyncTime } from "../sync/cloudStatus";
import type { CloudStatus } from "../sync/useCloudSync";
import { Cloud, Close } from "./Icons";

interface CloudSyncDialogProps {
  passcode: string;
  status: CloudStatus;
  lastSyncedAt: number | null;
  error: string | null;
  onClose: () => void;
  onConnect: (passcode: string) => void;
  onSync: () => void;
  onDisconnect: () => void;
}

export default function CloudSyncDialog({
  passcode,
  status,
  lastSyncedAt,
  error,
  onClose,
  onConnect,
  onSync,
  onDisconnect,
}: CloudSyncDialogProps) {
  const [input, setInput] = useState("");
  const connected = Boolean(passcode) && status !== "unauthorized";
  const statusLabel = CLOUD_STATUS_LABELS[status];
  const syncTime = formatSyncTime(lastSyncedAt);

  const stop = (event: ReactPointerEvent) => event.stopPropagation();

  const submit = () => {
    if (!input.trim()) return;
    onConnect(input);
  };

  return (
    <div
      className="zm-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="zm-panel project-panel cloud-panel"
        role="dialog"
        aria-modal="true"
        aria-label="云端同步"
        onPointerDown={stop}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (
            event.key === "Enter" &&
            event.target instanceof HTMLInputElement &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <div className="zm-head">
          <div>
            <div className="zm-kicker">Cloud</div>
            <h2>云端同步</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Close size={15} />
          </button>
        </div>

        <div className="project-body">
          {connected ? (
            <>
              <div className={`cloud-status cloud-${status}`}>
                <span className="cloud-status-dot" />
                <span>{statusLabel}</span>
                {syncTime && status === "synced" && (
                  <span className="cloud-time">最后同步 {syncTime}</span>
                )}
              </div>
              {error && <div className="zm-error">{error}</div>}
              <p className="project-lead">
                这台设备已连接云端。手机和电脑输入同一个口令，就会共用同一份数据。
              </p>
              <div className="cloud-actions">
                <button className="btn-primary" onClick={onSync}>
                  立即同步
                </button>
                <button className="btn-ghost" onClick={onDisconnect}>
                  断开云端
                </button>
              </div>
              <p className="zm-note">
                连不上云端时仍然可以继续用，改动会先存在本机；恢复联网后再同步。
              </p>
            </>
          ) : (
            <>
              <div className="cloud-hero">
                <span className="cloud-hero-icon">
                  <Cloud size={22} />
                </span>
                <div>
                  <strong>手机和电脑共用一份数据</strong>
                  <p>
                    输入服务器上的口令。第一次连接时，如果云端还没有数据，会把本机数据传上去；
                    如果云端已有数据，会让你选择用哪一边。
                  </p>
                </div>
              </div>

              <label className="field-label" htmlFor="cloud-passcode">
                云端口令
              </label>
              <input
                id="cloud-passcode"
                className="zm-input"
                type="password"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="输入部署时生成的口令"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
              {error && <div className="zm-error">{error}</div>}

              <div className="cloud-actions">
                <button className="btn-primary" onClick={submit}>
                  连接云端
                </button>
                <button className="btn-ghost" onClick={onClose}>
                  先只用本地
                </button>
              </div>

              <p className="zm-note">
                口令在服务器目录 <code>data/passcode.txt</code> 里。不要发到公开群聊。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
