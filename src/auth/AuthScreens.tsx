import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AuthMe } from "./types";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      data?.message || data?.error || `HTTP ${response.status}`,
    ) as Error & { code?: string };
    error.code = data?.error;
    throw error;
  }
  return data as T;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "请求失败，请稍后重试";
  const code = (error as Error & { code?: string }).code;
  switch (code) {
    case "bad_credentials":
      return "登录名或密码不对";
    case "bad_setup_token":
      return "Setup token 不对";
    case "already_setup":
      return "已经初始化过了，请直接登录";
    case "invite_invalid":
      return "邀请链接无效、已使用或已过期";
    case "username_taken":
      return "这个登录名已经被占用";
    case "bad_username":
      return "登录名需要 3–32 位字母、数字、_ 或 -";
    case "bad_password":
      return "密码至少 8 位";
    case "bad_origin":
      return "请求来源不对，请从原地址重新打开";
    default:
      return error.message || "请求失败，请稍后重试";
  }
}

function AuthShell({
  kicker,
  title,
  lead,
  children,
  footer,
}: {
  kicker: string;
  title: string;
  lead?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-screen">
      <div className="auth-orb auth-orb-a" />
      <div className="auth-orb auth-orb-b" />
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-bars" aria-hidden="true">
            <i style={{ background: "#B3261E" }} />
            <i style={{ background: "#4F46E5" }} />
            <i style={{ background: "#15803D" }} />
          </span>
          <div>
            <strong>三线</strong>
            <span>时间网格</span>
          </div>
        </div>
        <div className="auth-kicker">{kicker}</div>
        <h1 className="auth-title">{title}</h1>
        {lead && <p className="auth-lead">{lead}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function LoginScreen({
  onAuthed,
  offline,
}: {
  onAuthed: (me: AuthMe) => void;
  offline?: boolean;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username.trim() || !password) {
      setError("请输入登录名和密码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await postJson<AuthMe>("/api/auth/login", {
        username: username.trim(),
        password,
      });
      onAuthed(me);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      kicker="Sign in"
      title="回到你的三线"
      lead="这是一个邀请制的小工具。每个朋友有自己独立的一张图，互相看不到。"
      footer="没有账号？让管理员发一个邀请链接给你。"
    >
      {offline && (
        <div className="auth-error">
          现在连不上服务器。已经登录过的设备可以离线打开，但新登录需要联网。
        </div>
      )}
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field-label" htmlFor="login-username">
          登录名
        </label>
        <input
          id="login-username"
          className="zm-input"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoFocus
        />
        <label className="field-label" htmlFor="login-password">
          密码
        </label>
        <input
          id="login-password"
          className="zm-input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn-primary auth-submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </AuthShell>
  );
}

export function SetupScreen({ onAuthed }: { onAuthed: (me: AuthMe) => void }) {
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("我的三线");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!setupToken.trim() || !username.trim() || !displayName.trim()) {
      setError("请填完 Setup token、登录名和显示名");
      return;
    }
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (password !== confirm) {
      setError("两次密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await postJson<AuthMe>("/api/setup", {
        setupToken: setupToken.trim(),
        username: username.trim(),
        displayName: displayName.trim(),
        workspaceName: workspaceName.trim() || "我的三线",
        password,
      });
      onAuthed(me);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      kicker="First run"
      title="初始化你的三线"
      lead="第一次启动需要创建管理员。Setup token 在服务器终端输出，也在 data/setup-token.txt 里。"
    >
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field-label" htmlFor="setup-token">
          Setup token
        </label>
        <input
          id="setup-token"
          className="zm-input"
          value={setupToken}
          onChange={(event) => setSetupToken(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        <div className="auth-row">
          <div>
            <label className="field-label" htmlFor="setup-username">
              登录名
            </label>
            <input
              id="setup-username"
              className="zm-input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="laohei"
              autoCapitalize="none"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="setup-display">
              显示名
            </label>
            <input
              id="setup-display"
              className="zm-input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="老黑"
            />
          </div>
        </div>
        <label className="field-label" htmlFor="setup-workspace">
          工作区名称
        </label>
        <input
          id="setup-workspace"
          className="zm-input"
          value={workspaceName}
          onChange={(event) => setWorkspaceName(event.target.value)}
          maxLength={80}
        />
        <label className="field-label" htmlFor="setup-password">
          密码
        </label>
        <input
          id="setup-password"
          className="zm-input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
        <label className="field-label" htmlFor="setup-confirm">
          确认密码
        </label>
        <input
          id="setup-confirm"
          className="zm-input"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
        />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn-primary auth-submit" disabled={busy}>
          {busy ? "创建中…" : "创建管理员并导入现有数据"}
        </button>
      </form>
    </AuthShell>
  );
}

interface InviteDetails {
  workspaceName: string;
  expiresAt: number;
}

export function InviteScreen({
  token,
  onAuthed,
}: {
  token: string;
  onAuthed: (me: AuthMe) => void;
}) {
  const [details, setDetails] = useState<InviteDetails | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/invites/${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || "invite_invalid");
        if (!cancelled) {
          setDetails(data as InviteDetails);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async () => {
    if (!details) return;
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username.trim())) {
      setError("登录名需要 3–32 位字母、数字、_ 或 -");
      return;
    }
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (password !== confirm) {
      setError("两次密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await postJson<AuthMe>(
        `/api/invites/${encodeURIComponent(token)}/accept`,
        {
          username: username.trim(),
          password,
          displayName: displayName.trim() || username.trim(),
        },
      );
      onAuthed(me);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!details && !error) {
    return (
      <AuthShell kicker="Invite" title="正在打开邀请…">
        <div className="auth-loading">读取邀请信息…</div>
      </AuthShell>
    );
  }

  if (!details) {
    return (
      <AuthShell kicker="Invite" title="邀请链接不可用">
        <div className="auth-error">{error || "邀请链接无效、已使用或已过期"}</div>
        <p className="auth-lead">让管理员重新生成一个邀请链接。</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      kicker="Invite"
      title="加入你自己的三线"
      lead={`「${details.workspaceName}」。设置你自己的登录名和密码后，这张图只属于你。`}
    >
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field-label" htmlFor="invite-username">
          登录名
        </label>
        <input
          id="invite-username"
          className="zm-input"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="字母/数字/_/-，3–32 位"
          autoCapitalize="none"
          autoCorrect="off"
          maxLength={32}
          autoFocus
        />
        <label className="field-label" htmlFor="invite-display">
          显示名
        </label>
        <input
          id="invite-display"
          className="zm-input"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={80}
        />
        <label className="field-label" htmlFor="invite-password">
          设置密码
        </label>
        <input
          id="invite-password"
          className="zm-input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
        <label className="field-label" htmlFor="invite-confirm">
          确认密码
        </label>
        <input
          id="invite-confirm"
          className="zm-input"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
        />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn-primary auth-submit" disabled={busy}>
          {busy ? "创建中…" : "进入我的三线"}
        </button>
      </form>
    </AuthShell>
  );
}
