import { useEffect, useState } from "react";
import { CLOUD_STATUS_LABELS, formatSyncTime } from "../sync/cloudStatus";
import type { CloudStatus } from "../sync/useCloudSync";
import type { AuthUser, AuthWorkspace } from "../auth/types";
import { Close, Cloud } from "./Icons";

interface CloudControls {
  status: CloudStatus;
  lastSyncedAt: number | null;
  error: string | null;
  syncNow: () => void;
}

interface AgentToken {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  workspace: { id: string; name: string };
}

interface AccountDialogProps {
  user: AuthUser;
  workspace: AuthWorkspace;
  cloud: CloudControls;
  onClose: () => void;
  onLogout: () => void;
  onUserUpdated: (user: AuthUser) => void;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
  }
  return data as T;
}

export default function AccountDialog({
  user,
  workspace,
  cloud,
  onClose,
  onLogout,
  onUserUpdated,
}: AccountDialogProps) {
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [tokenLabel, setTokenLabel] = useState("DSH");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [inviteWorkspace, setInviteWorkspace] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  const [displayName, setDisplayName] = useState(user.displayName);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [resetSecret, setResetSecret] = useState<{ username: string; password: string } | null>(null);

  const loadTokens = async () => {
    try {
      const data = await apiJson<{ tokens: AgentToken[] }>("/api/agent-tokens");
      setTokens(data.tokens);
      setTokenError(null);
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "读取 token 失败");
    }
  };

  const loadAdminUsers = async () => {
    if (!user.isAdmin) return;
    try {
      const data = await apiJson<{ users: AdminUser[] }>("/api/admin/users");
      setAdminUsers(data.users);
      setAdminError(null);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "读取账号失败");
    }
  };

  useEffect(() => {
    void loadTokens();
    void loadAdminUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const createToken = async () => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const data = await apiJson<{ token: string }>("/api/agent-tokens", {
        method: "POST",
        body: JSON.stringify({ label: tokenLabel.trim() || "Agent" }),
      });
      setNewToken(data.token);
      setTokenLabel("DSH");
      await loadTokens();
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "创建 token 失败");
    } finally {
      setTokenBusy(false);
    }
  };

  const revokeToken = async (id: string) => {
    if (!window.confirm("撤销这个 Agent token？已经用它配置的 Agent 会立即失效。")) return;
    try {
      await apiJson(`/api/agent-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadTokens();
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "撤销失败");
    }
  };

  const createInvite = async () => {
    setInviteBusy(true);
    setInviteError(null);
    setInviteUrl(null);
    try {
      const data = await apiJson<{ invite: { url: string } }>("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify({ workspaceName: inviteWorkspace.trim() }),
      });
      setInviteUrl(data.invite.url);
      setInviteWorkspace("");
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "生成邀请失败");
    } finally {
      setInviteBusy(false);
    }
  };

  const saveProfile = async () => {
    if (!displayName.trim()) {
      setProfileError("显示名不能为空");
      return;
    }
    setProfileBusy(true);
    setProfileError(null);
    setProfileNotice(null);
    try {
      const data = await apiJson<{ user: AuthUser }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName: displayName.trim() }),
      });
      onUserUpdated(data.user);
      setProfileNotice("显示名已更新");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "更新失败");
    } finally {
      setProfileBusy(false);
    }
  };

  const changePassword = async () => {
    setPasswordError(null);
    setPasswordNotice(null);
    if (newPassword.length < 8) {
      setPasswordError("新密码至少 8 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("两次新密码不一致");
      return;
    }
    setPasswordBusy(true);
    try {
      await apiJson("/api/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordNotice("密码已更新，其他设备需要重新登录");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "修改密码失败");
    } finally {
      setPasswordBusy(false);
    }
  };

  const resetUserPassword = async (target: AdminUser) => {
    if (!window.confirm(`重置「${target.displayName}」的密码？对方会被登出。`)) return;
    setAdminError(null);
    setResetSecret(null);
    try {
      const data = await apiJson<{ username: string; password: string }>(
        `/api/admin/users/${encodeURIComponent(target.id)}/reset-password`,
        { method: "POST" },
      );
      setResetSecret({ username: data.username, password: data.password });
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "重置失败");
    }
  };

  const statusLabel = CLOUD_STATUS_LABELS[cloud.status];
  const syncTime = formatSyncTime(cloud.lastSyncedAt);

  return (
    <div
      className="zm-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="zm-panel project-panel account-panel"
        role="dialog"
        aria-modal="true"
        aria-label="账户与同步"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="zm-head">
          <div>
            <div className="zm-kicker">Account</div>
            <h2>账户与同步</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Close size={15} />
          </button>
        </div>

        <div className="project-body account-body">
          <div className="account-identity">
            <span className="account-avatar">
              {(user.displayName || user.username).slice(0, 1)}
            </span>
            <div>
              <strong>{user.displayName}</strong>
              <span>
                @{user.username} · {workspace.name}
                {user.isAdmin ? " · 管理员" : ""}
              </span>
            </div>
          </div>

          <div className={`cloud-status cloud-${cloud.status}`}>
            <span className="cloud-status-dot" />
            <span>{statusLabel}</span>
            {syncTime && cloud.status === "synced" && (
              <span className="cloud-time">最后同步 {syncTime}</span>
            )}
          </div>
          {cloud.error && <div className="zm-error">{cloud.error}</div>}
          <div className="cloud-actions">
            <button className="btn-primary" onClick={cloud.syncNow}>
              立即同步
            </button>
            <button className="btn-ghost" onClick={onLogout}>
              退出登录
            </button>
          </div>

          <section className="account-section">
            <div className="account-section-head">
              <h3>个人资料</h3>
              <span>显示名 / 密码</span>
            </div>
            <label className="field-label">显示名</label>
            <div className="account-inline">
              <input
                className="zm-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={80}
              />
              <button className="btn-ghost" onClick={() => void saveProfile()} disabled={profileBusy}>
                {profileBusy ? "保存中…" : "保存"}
              </button>
            </div>
            {profileError && <div className="zm-error">{profileError}</div>}
            {profileNotice && <p className="account-hint">{profileNotice}</p>}

            <label className="field-label">修改密码</label>
            <input
              className="zm-input"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder="当前密码"
              autoComplete="current-password"
            />
            <div className="account-inline">
              <input
                className="zm-input"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="新密码，至少 8 位"
                autoComplete="new-password"
              />
              <input
                className="zm-input"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="确认新密码"
                autoComplete="new-password"
              />
            </div>
            {passwordError && <div className="zm-error">{passwordError}</div>}
            {passwordNotice && <p className="account-hint">{passwordNotice}</p>}
            <div className="cloud-actions">
              <button className="btn-ghost" onClick={() => void changePassword()} disabled={passwordBusy}>
                {passwordBusy ? "修改中…" : "修改密码"}
              </button>
            </div>
          </section>

          <section className="account-section">
            <div className="account-section-head">
              <h3>
                <Cloud size={14} /> Agent token
              </h3>
              <span>给 DSH / Codex 用</span>
            </div>
            <p className="account-hint">
              每个 token 只能读写当前 workspace。复制后放进 DSH 的
              <code>GANTT_TOKEN</code>，不要发到公开聊天。
            </p>
            <div className="account-inline">
              <input
                className="zm-input"
                value={tokenLabel}
                onChange={(event) => setTokenLabel(event.target.value)}
                placeholder="token 名称，比如 DSH"
                maxLength={80}
              />
              <button className="btn-ghost" onClick={() => void createToken()} disabled={tokenBusy}>
                {tokenBusy ? "生成中…" : "生成"}
              </button>
            </div>
            {tokenError && <div className="zm-error">{tokenError}</div>}
            {newToken && (
              <div className="account-secret">
                <span>新 token（只显示一次）</span>
                <code>{newToken}</code>
                <button className="btn-ghost" onClick={() => void copy(newToken, "new")}>
                  {copied === "new" ? "已复制" : "复制"}
                </button>
              </div>
            )}
            <div className="token-list">
              {tokens.length === 0 && <p className="account-hint">还没有 token。</p>}
              {tokens.map((token) => (
                <div className="token-row" key={token.id}>
                  <div>
                    <strong>{token.label}</strong>
                    <span>
                      {token.lastUsedAt
                        ? `最近使用 ${new Date(token.lastUsedAt).toLocaleString("zh-CN")}`
                        : "从未使用"}
                    </span>
                  </div>
                  <button className="btn-ghost account-danger" onClick={() => void revokeToken(token.id)}>
                    撤销
                  </button>
                </div>
              ))}
            </div>
          </section>

          {user.isAdmin && (
            <section className="account-section">
              <div className="account-section-head">
                <h3>朋友账号</h3>
                <span>重置密码</span>
              </div>
              <p className="account-hint">
                忘记密码时，可以在这里生成一个临时密码；对方所有设备会被登出。
              </p>
              {adminError && <div className="zm-error">{adminError}</div>}
              {resetSecret && (
                <div className="account-secret">
                  <span>
                    {resetSecret.username} 的临时密码（只显示一次）
                  </span>
                  <code>{resetSecret.password}</code>
                  <button className="btn-ghost" onClick={() => void copy(resetSecret.password, "reset")}>
                    {copied === "reset" ? "已复制" : "复制"}
                  </button>
                </div>
              )}
              <div className="token-list">
                {adminUsers.length === 0 && <p className="account-hint">还没有朋友账号。</p>}
                {adminUsers.map((item) => (
                  <div className="token-row" key={item.id}>
                    <div>
                      <strong>
                        {item.displayName} · @{item.username}
                        {item.isAdmin ? " · 管理员" : ""}
                      </strong>
                      <span>{item.workspace.name}</span>
                    </div>
                    {!item.isAdmin && (
                      <button className="btn-ghost account-danger" onClick={() => void resetUserPassword(item)}>
                        重置密码
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {user.isAdmin && (
            <section className="account-section">
              <div className="account-section-head">
                <h3>邀请朋友</h3>
                <span>一人一个 workspace</span>
              </div>
              <p className="account-hint">
                生成一次性邀请链接。朋友打开后自己设置登录名、显示名和密码，就进入自己的图。7 天有效。
              </p>
              <label className="field-label">工作区名称</label>
              <input
                className="zm-input"
                value={inviteWorkspace}
                onChange={(event) => setInviteWorkspace(event.target.value)}
                placeholder="朋友的三线"
                maxLength={80}
              />
              {inviteError && <div className="zm-error">{inviteError}</div>}
              <div className="cloud-actions">
                <button className="btn-primary" onClick={() => void createInvite()} disabled={inviteBusy}>
                  {inviteBusy ? "生成中…" : "生成邀请链接"}
                </button>
              </div>
              {inviteUrl && (
                <div className="account-secret">
                  <span>邀请链接（只显示这次）</span>
                  <code>{inviteUrl}</code>
                  <button className="btn-ghost" onClick={() => void copy(inviteUrl, "invite")}>
                    {copied === "invite" ? "已复制" : "复制"}
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
