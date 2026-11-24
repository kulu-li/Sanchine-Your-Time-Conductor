import { useCallback, useEffect, useRef, useState } from "react";
import type { Task, Zone } from "../types";
import { readStorage, writeStorage } from "../storage";

export type CloudStatus =
  | "local"
  | "connecting"
  | "syncing"
  | "synced"
  | "offline"
  | "conflict"
  | "unauthorized";

export interface CloudSnapshot {
  revision: number;
  updatedAt: number;
  initialized: boolean;
  tasks: Task[];
  zones: Zone[];
}

interface SyncMeta {
  baseRevision: number;
  dirty: boolean;
  lastSyncedAt: number | null;
}

const META_KEY = "laohei-gantt-cloud-meta";

function loadMeta(): SyncMeta | null {
  try {
    const raw = readStorage(META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SyncMeta> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      baseRevision:
        typeof parsed.baseRevision === "number" && Number.isFinite(parsed.baseRevision)
          ? parsed.baseRevision
          : 0,
      dirty: Boolean(parsed.dirty),
      lastSyncedAt:
        typeof parsed.lastSyncedAt === "number" ? parsed.lastSyncedAt : null,
    };
  } catch {
    return null;
  }
}

interface UseCloudSyncOptions {
  tasks: Task[];
  zones: Zone[];
  enabled?: boolean;
  onRemote: (snapshot: { tasks: Task[]; zones: Zone[] }) => void;
}

function signalUnauthorized() {
  try {
    window.dispatchEvent(new CustomEvent("gantt:unauthorized"));
  } catch {
    // ignore
  }
}

export function useCloudSync({
  tasks,
  zones,
  enabled = true,
  onRemote,
}: UseCloudSyncOptions) {
  const initialMeta = useRef<SyncMeta | null>(loadMeta());
  const [status, setStatus] = useState<CloudStatus>("connecting");
  const statusRef = useRef(status);
  statusRef.current = status;
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(
    initialMeta.current?.lastSyncedAt ?? null,
  );
  const lastSyncedRef = useRef<number | null>(
    initialMeta.current?.lastSyncedAt ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<CloudSnapshot | null>(null);

  const baseRevisionRef = useRef(initialMeta.current?.baseRevision ?? 0);
  const dirtyRef = useRef(initialMeta.current?.dirty ?? false);
  const metaLoadedRef = useRef(initialMeta.current !== null);
  const readyRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const inFlightRef = useRef(false);
  const didInitRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const saveMeta = () => {
    try {
      writeStorage(
        META_KEY,
        JSON.stringify({
          baseRevision: baseRevisionRef.current,
          dirty: dirtyRef.current,
          lastSyncedAt: lastSyncedRef.current,
        } satisfies SyncMeta),
      );
    } catch {
      // ignore
    }
  };

  const applyRemote = (snapshot: CloudSnapshot) => {
    applyingRemoteRef.current = true;
    onRemoteRef.current({ tasks: snapshot.tasks, zones: snapshot.zones });
    baseRevisionRef.current = snapshot.revision;
    dirtyRef.current = false;
    lastSyncedRef.current = Date.now();
    metaLoadedRef.current = true;
    readyRef.current = true;
    saveMeta();
    setLastSyncedAt(lastSyncedRef.current);
    setConflict(null);
    setError(null);
    setStatus("synced");
  };

  const handleUnauthorized = () => {
    setStatus("unauthorized");
    setError("登录已失效，请重新登录");
    signalUnauthorized();
  };

  const push = useCallback(async (force = false) => {
    if (!enabledRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus("syncing");
    setError(null);
    try {
      const response = await fetch("/api/state", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseRevision: baseRevisionRef.current,
          tasks: tasksRef.current,
          zones: zonesRef.current,
          force,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      if (response.status === 409) {
        const data = (await response.json().catch(() => null)) as {
          state?: CloudSnapshot;
        } | null;
        if (data?.state) {
          dirtyRef.current = true;
          saveMeta();
          setConflict(data.state);
          setStatus("conflict");
        } else {
          setStatus("offline");
          setError("同步冲突，请稍后重试");
        }
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const snapshot = (await response.json()) as CloudSnapshot;
      baseRevisionRef.current = snapshot.revision;
      dirtyRef.current = false;
      lastSyncedRef.current = Date.now();
      metaLoadedRef.current = true;
      readyRef.current = true;
      saveMeta();
      setLastSyncedAt(lastSyncedRef.current);
      setConflict(null);
      setError(null);
      setStatus("synced");
    } catch {
      setStatus("offline");
      setError("连接不上云端，已保存在本机");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const pull = useCallback(async () => {
    if (!enabledRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus((previous) => (previous === "conflict" ? previous : "connecting"));
    try {
      const response = await fetch("/api/state", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(15000),
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const remote = (await response.json()) as CloudSnapshot;

      if (!remote.initialized) {
        // A new workspace: push the local starter template.
        baseRevisionRef.current = remote.revision;
        dirtyRef.current = true;
        saveMeta();
        inFlightRef.current = false;
        await push();
        return;
      }

      if (dirtyRef.current) {
        if (remote.revision !== baseRevisionRef.current) {
          saveMeta();
          setConflict(remote);
          setStatus("conflict");
          return;
        }
        inFlightRef.current = false;
        await push();
        return;
      }

      // First login on a fresh device, or a clean local cache: adopt the
      // server snapshot. This covers migration from the single-user version.
      if (!metaLoadedRef.current || remote.revision !== baseRevisionRef.current) {
        applyRemote(remote);
      } else {
        readyRef.current = true;
        setError(null);
        setStatus("synced");
      }
    } catch {
      setStatus("offline");
      setError("连接不上云端，已保存在本机");
    } finally {
      inFlightRef.current = false;
    }
  }, [push]);

  const schedulePush = useCallback(() => {
    if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
    pushTimerRef.current = window.setTimeout(() => {
      pushTimerRef.current = null;
      void push();
    }, 700);
  }, [push]);

  // Initial connection.
  useEffect(() => {
    if (!enabled || didInitRef.current) return;
    didInitRef.current = true;
    void pull();
  }, [enabled, pull]);

  // Any local edit becomes dirty and is pushed after a short debounce.
  useEffect(() => {
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      return;
    }
    if (!enabledRef.current || !readyRef.current) return;
    if (statusRef.current === "conflict" || statusRef.current === "unauthorized") {
      return;
    }
    dirtyRef.current = true;
    saveMeta();
    setStatus("syncing");
    schedulePush();
  }, [tasks, zones, schedulePush]);

  // Retry/refresh loop. Dirty state retries a push; clean state polls.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (inFlightRef.current) return;
      if (statusRef.current === "conflict" || statusRef.current === "unauthorized") {
        return;
      }
      if (dirtyRef.current) void push();
      else void pull();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [enabled, pull, push]);

  useEffect(() => {
    const handleOnline = () => {
      if (!enabledRef.current) return;
      if (dirtyRef.current) void push();
      else void pull();
    };
    const handleVisible = () => {
      if (
        document.visibilityState === "visible" &&
        enabledRef.current &&
        !inFlightRef.current
      ) {
        if (dirtyRef.current) void push();
        else void pull();
      }
    };
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, [pull, push]);

  useEffect(() => {
    return () => {
      if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
    };
  }, []);

  const syncNow = () => {
    if (!enabledRef.current) return;
    if (dirtyRef.current) void push();
    else void pull();
  };

  const resolveConflict = (choice: "remote" | "local") => {
    const remote = conflict;
    if (!remote) return;
    if (choice === "remote") {
      applyRemote(remote);
      return;
    }
    baseRevisionRef.current = remote.revision;
    dirtyRef.current = true;
    metaLoadedRef.current = true;
    setConflict(null);
    saveMeta();
    void push(true);
  };

  return {
    status,
    lastSyncedAt,
    error,
    conflict,
    syncNow,
    resolveConflict,
  };
}
