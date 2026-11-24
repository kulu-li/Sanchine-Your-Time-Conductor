import type { CloudStatus } from "./useCloudSync";

export const CLOUD_STATUS_LABELS: Record<CloudStatus, string> = {
  local: "仅本地",
  connecting: "连接中…",
  syncing: "同步中…",
  synced: "云端已同步",
  offline: "离线 · 已存本机",
  conflict: "云端有更新",
  unauthorized: "云端口令失效",
};

export function formatSyncTime(timestamp: number | null): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}
