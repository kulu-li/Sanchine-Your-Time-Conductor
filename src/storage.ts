// Per-workspace localStorage namespace. AuthGate calls setStorageNamespace()
// before rendering App so two accounts in the same browser cannot mix data.
let namespace = "anon";

export function setStorageNamespace(workspaceId: string) {
  namespace = workspaceId ? `ws-${workspaceId}` : "anon";
}

export function storageKey(key: string) {
  return `${namespace}:${key}`;
}

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(storageKey(key), value);
  } catch {
    // quota / private mode
  }
}

export function removeStorage(key: string) {
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    // ignore
  }
}
