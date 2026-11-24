import { Close } from "./Icons";

interface InstallDialogProps {
  canPrompt: boolean;
  onClose: () => void;
  onPrompt: () => void;
}

export default function InstallDialog({
  canPrompt,
  onClose,
  onPrompt,
}: InstallDialogProps) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

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
        aria-label="安装到桌面"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="zm-head">
          <div>
            <div className="zm-kicker">Install</div>
            <h2>安装到桌面</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Close size={15} />
          </button>
        </div>
        <div className="project-body">
          <p className="project-lead">
            安装后会像 App 一样有独立图标，全屏打开，断网也能看到缓存的界面。
          </p>

          {isIOS ? (
            <ol className="install-steps">
              <li>用 <strong>Safari</strong> 打开这个页面。</li>
              <li>点底部的「分享」按钮。</li>
              <li>往下找「添加到主屏幕」，确认添加。</li>
            </ol>
          ) : (
            <ol className="install-steps">
              <li>用 Chrome / Edge 打开这个页面。</li>
              <li>点地址栏右侧的「安装」图标，或浏览器菜单里的「安装应用 / 添加到主屏幕」。</li>
              <li>确认后，桌面会出现「三线」图标。</li>
            </ol>
          )}

          <div className="cloud-actions">
            {canPrompt && (
              <button className="btn-primary" onClick={onPrompt}>
                立即安装
              </button>
            )}
            <button className="btn-ghost" onClick={onClose}>
              关闭
            </button>
          </div>

          <p className="zm-note">
            iPhone / iPad 必须用 Safari 添加；微信内置浏览器不能安装。
          </p>
        </div>
      </div>
    </div>
  );
}
