import type { CloudSnapshot } from "../sync/useCloudSync";

interface CloudConflictDialogProps {
  remote: CloudSnapshot;
  onUseRemote: () => void;
  onUseLocal: () => void;
}

export default function CloudConflictDialog({
  remote,
  onUseRemote,
  onUseLocal,
}: CloudConflictDialogProps) {
  return (
    <div className="zm-backdrop cloud-conflict-backdrop">
      <div
        className="zm-panel project-panel cloud-panel"
        role="dialog"
        aria-modal="true"
        aria-label="同步冲突"
      >
        <div className="zm-head">
          <div>
            <div className="zm-kicker">Conflict</div>
            <h2>云端有更新</h2>
          </div>
        </div>

        <div className="project-body">
          <p className="project-lead">
            云端的数据和这台设备不一样，可能是另一台设备刚刚改过。
            先选一边，选完会立刻同步，避免互相覆盖。
          </p>

          <div className="cloud-compare">
            <div>
              <span>云端</span>
              <strong>{remote.tasks.length} 个子任务</strong>
              <small>
                {remote.updatedAt
                  ? new Date(remote.updatedAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "未知时间"}
              </small>
            </div>
            <div>
              <span>本机</span>
              <strong>当前这版</strong>
              <small>包含你还没同步的改动</small>
            </div>
          </div>

          <div className="cloud-actions">
            <button className="btn-primary" onClick={onUseRemote}>
              使用云端
            </button>
            <button className="btn-ghost cloud-danger" onClick={onUseLocal}>
              用本机覆盖云端
            </button>
          </div>

          <p className="zm-note">
            不确定就先用云端；选「用本机覆盖」会丢掉云端那一版改动。
          </p>
        </div>
      </div>
    </div>
  );
}
