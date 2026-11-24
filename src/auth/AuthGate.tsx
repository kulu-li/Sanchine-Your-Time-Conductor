import { useEffect, useState } from "react";
import App from "../App";
import { setStorageNamespace } from "../storage";
import { InviteScreen, LoginScreen, SetupScreen } from "./AuthScreens";
import type { AuthMe } from "./types";

const AUTH_CACHE_KEY = "gantt-auth-cache-v1";

function loadCache(): AuthMe | null {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthMe | null;
    if (!parsed?.user || !parsed?.workspace) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(me: AuthMe) {
  try {
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(me));
  } catch {
    // ignore
  }
}

function clearCache() {
  try {
    localStorage.removeItem(AUTH_CACHE_KEY);
  } catch {
    // ignore
  }
}

function inviteTokenFromPath(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

type Screen = "loading" | "login" | "setup" | "invite" | "app";

export default function AuthGate() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [me, setMe] = useState<AuthMe | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inviteToken = inviteTokenFromPath();

  const enterApp = (next: AuthMe) => {
    saveCache(next);
    setStorageNamespace(next.workspace.id);
    setMe(next);
    setOffline(false);
    setError(null);
    setNeedsSetup(false);
    setScreen("app");
    if (inviteToken) window.history.replaceState({}, "", "/");
  };

  useEffect(() => {
    let cancelled = false;

    const routeUnauthenticated = async () => {
      if (inviteToken) {
        if (!cancelled) setScreen("invite");
        return;
      }
      try {
        const response = await fetch("/api/setup/status", {
          signal: AbortSignal.timeout(10000),
        });
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        const setup = Boolean(data?.needsSetup);
        setNeedsSetup(setup);
        setScreen(setup ? "setup" : "login");
      } catch {
        if (!cancelled) {
          setNeedsSetup(false);
          setOffline(true);
          setError("连不上服务器，无法登录");
          setScreen("login");
        }
      }
    };

    const boot = async () => {
      const cached = loadCache();
      try {
        const response = await fetch("/api/me", {
          credentials: "same-origin",
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
          const data = (await response.json()) as AuthMe;
          if (!cancelled) enterApp(data);
          return;
        }
        if (response.status === 401) {
          clearCache();
          await routeUnauthenticated();
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      } catch {
        if (cancelled) return;
        if (cached) {
          // Offline PWA: a previously logged-in device can open the cached
          // workspace; the sync hook will show "offline" until the server is back.
          setStorageNamespace(cached.workspace.id);
          setMe(cached);
          setOffline(true);
          setScreen("app");
          return;
        }
        await routeUnauthenticated();
        if (!cancelled) {
          setOffline(true);
          setError("连不上服务器，无法登录");
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      clearCache();
      setMe(null);
      setOffline(false);
      setError("登录已失效，请重新登录");
      setScreen("login");
    };
    window.addEventListener("gantt:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("gantt:unauthorized", handleUnauthorized);
  }, []);

  const updateUser = (nextUser: AuthMe["user"]) => {
    setMe((previous) => {
      if (!previous) return previous;
      const next = { ...previous, user: nextUser };
      saveCache(next);
      return next;
    });
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // clear locally anyway
    }
    clearCache();
    setMe(null);
    setNeedsSetup(false);
    setScreen("login");
    setError(null);
    setOffline(false);
    setStorageNamespace("");
  };

  if (screen === "loading") {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-loading">
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
          <div className="auth-loading">正在打开…</div>
        </div>
      </div>
    );
  }

  if (screen === "app" && me) {
    return (
      <App
        key={me.workspace.id}
        user={me.user}
        workspace={me.workspace}
        onLogout={logout}
        onUserUpdated={updateUser}
      />
    );
  }

  if (screen === "setup" || needsSetup) {
    return <SetupScreen onAuthed={enterApp} />;
  }

  if (screen === "invite" && inviteToken) {
    return <InviteScreen token={inviteToken} onAuthed={enterApp} />;
  }

  return (
    <LoginScreen
      onAuthed={enterApp}
      offline={offline}
    />
  );
}
