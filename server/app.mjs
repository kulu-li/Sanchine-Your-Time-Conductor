#!/usr/bin/env node
/**
 * 三线 multi-workspace server.
 *
 * One account = one workspace (friends each get their own chart).
 * - SQLite via node:sqlite (Node >= 22.5, tested on 26).
 * - Invite-only accounts, HttpOnly session cookies.
 * - Per-workspace snapshot revision, schema v1.
 * - Workspace-scoped agent tokens for the CLI.
 */
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEMA_VERSION,
  validateData,
  validateSnapshot,
} from "../schema/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const DATA_DIR = process.env.GANTT_DATA_DIR
  ? path.resolve(process.env.GANTT_DATA_DIR)
  : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const LEGACY_STATE_FILE = path.join(DATA_DIR, "state.json");
const SETUP_TOKEN_FILE = path.join(DATA_DIR, "setup-token.txt");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 6 * 1024 * 1024;
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const COOKIE_NAME = "gantt_session";

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    workspace_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
  );
  CREATE TABLE IF NOT EXISTS workspace_state (
    workspace_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    initialized INTEGER NOT NULL,
    tasks_json TEXT NOT NULL,
    zones_json TEXT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    workspace_name TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
`);

function getSetupToken() {
  const fromEnv = process.env.GANTT_SETUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(SETUP_TOKEN_FILE)) {
    const saved = readFileSync(SETUP_TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  }
  const generated = crypto.randomBytes(24).toString("base64url");
  writeFileSync(SETUP_TOKEN_FILE, generated + "\n", { mode: 0o600 });
  return generated;
}

const SETUP_TOKEN = getSetupToken();

function userCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("base64url")}`;
}

function randomToken(prefix = "") {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function verifyPassword(password, stored) {
  try {
    const [algorithm, saltB64, hashB64] = String(stored).split("$");
    if (algorithm !== "scrypt" || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validUsername(username) {
  return /^[A-Za-z0-9_-]{3,32}$/.test(username);
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const result = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function isSecureRequest(req) {
  if (process.env.COOKIE_SECURE === "1") return true;
  return req.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(req, token, maxAge = SESSION_DAYS * 86400) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) {
  return sessionCookie(req, "", 0);
}

function createSession(req, res, userId) {
  const token = randomToken();
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sha256(token), userId, now, now + SESSION_DAYS * 86400000, now);
  res.setHeader("Set-Cookie", sessionCookie(req, token));
  return token;
}

function authSessionFromToken(token) {
  if (!token) return null;
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.id, u.username, u.display_name, u.is_admin, u.workspace_id,
              w.name AS workspace_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = u.workspace_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(token));
  if (!row) return null;
  if (Number(row.expires_at) <= now) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
    now,
    row.token_hash,
  );
  return {
    type: "user",
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      isAdmin: Boolean(row.is_admin),
    },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
    },
  };
}

function authSession(req) {
  return authSessionFromToken(parseCookies(req)[COOKIE_NAME]);
}

function authAgent(req) {
  const header = req.headers.authorization;
  const raw =
    (typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : null) ||
    (typeof req.headers["x-gantt-token"] === "string"
      ? req.headers["x-gantt-token"].trim()
      : null);
  if (!raw) return null;
  const row = db
    .prepare(
      `SELECT t.id, t.label, t.workspace_id, w.name AS workspace_name
       FROM agent_tokens t
       JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .get(sha256(raw));
  if (!row) return null;
  db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(
    Date.now(),
    row.id,
  );
  return {
    type: "agent",
    user: null,
    workspace: { id: row.workspace_id, name: row.workspace_name },
    agent: { id: row.id, label: row.label },
  };
}

function authenticate(req) {
  return authAgent(req) || authSession(req);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return parsed.host === host;
  } catch {
    return false;
  }
}

function sendJson(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function jsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function publicOrigin(req) {
  const configured = process.env.PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function getStateRow(workspaceId) {
  return db
    .prepare("SELECT * FROM workspace_state WHERE workspace_id = ?")
    .get(workspaceId);
}

function rowToState(row) {
  if (!row) {
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      updatedAt: 0,
      initialized: false,
      tasks: [],
      zones: [],
    };
  }
  return {
    schemaVersion: Number(row.schema_version) || SCHEMA_VERSION,
    revision: Number(row.revision) || 0,
    updatedAt: Number(row.updated_at) || 0,
    initialized: Boolean(row.initialized),
    tasks: JSON.parse(row.tasks_json),
    zones: JSON.parse(row.zones_json),
  };
}

function createEmptyState(workspaceId) {
  db.prepare(
    `INSERT INTO workspace_state
      (workspace_id, schema_version, revision, updated_at, initialized, tasks_json, zones_json)
     VALUES (?, ?, 0, ?, 0, '[]', '[]')`,
  ).run(workspaceId, SCHEMA_VERSION, Date.now());
}

function createWorkspaceAndUser({
  username,
  displayName,
  password,
  workspaceName,
  isAdmin,
  legacyState = null,
}) {
  const userId = randomId("user");
  const workspaceId = randomId("ws");
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO workspaces(id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, workspaceName, userId, now);
    db.prepare(
      `INSERT INTO users(id, username, display_name, password_hash, is_admin, workspace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      username,
      displayName,
      hashPassword(password),
      isAdmin ? 1 : 0,
      workspaceId,
      now,
    );
    if (legacyState) {
      db.prepare(
        `INSERT INTO workspace_state
          (workspace_id, schema_version, revision, updated_at, initialized, tasks_json, zones_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        workspaceId,
        SCHEMA_VERSION,
        Math.max(1, Number(legacyState.revision) || 0),
        Number(legacyState.updatedAt) || now,
        legacyState.initialized ? 1 : 0,
        JSON.stringify(legacyState.tasks),
        JSON.stringify(legacyState.zones),
      );
    } else {
      createEmptyState(workspaceId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { userId, workspaceId };
}

function readLegacyState() {
  if (!existsSync(LEGACY_STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_STATE_FILE, "utf8"));
    const candidate = {
      schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
      revision: Number(parsed.revision) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
      initialized: Boolean(parsed.initialized),
      tasks: parsed.tasks,
      zones: parsed.zones,
    };
    const validation = validateSnapshot(candidate);
    if (!validation.ok) {
      throw new Error(
        `legacy state.json is invalid: ${validation.errors.slice(0, 10).join("; ")}`,
      );
    }
    return candidate;
  } catch (error) {
    console.error("[setup] could not read legacy state.json:", error);
    throw error;
  }
}

function mePayload(auth) {
  return {
    user: auth.user,
    workspace: auth.workspace,
  };
}

function requireSession(req, res) {
  if (!sameOrigin(req)) {
    sendJson(req, res, 403, { error: "bad_origin" });
    return null;
  }
  const auth = authSession(req);
  if (!auth) {
    sendJson(req, res, 401, { error: "unauthorized" });
    return null;
  }
  return auth;
}

function requireAdmin(req, res) {
  const auth = requireSession(req, res);
  if (!auth) return null;
  if (!auth.user.isAdmin) {
    sendJson(req, res, 403, { error: "forbidden" });
    return null;
  }
  return auth;
}

function validateUsernameAndPassword(username, password) {
  if (!validUsername(username)) return "登录名必须是 3–32 位字母、数字、_ 或 -";
  if (!validPassword(password)) return "密码至少 8 位，最多 200 位";
  return null;
}

function createInvite(req, res, admin, body) {
  const workspaceName = String(body.workspaceName || "").trim();
  if (!workspaceName || workspaceName.length > 80) {
    sendJson(req, res, 400, { error: "bad_workspace_name" });
    return;
  }
  const token = randomToken();
  const id = randomId("invite");
  const now = Date.now();
  db.prepare(
    `INSERT INTO invites
      (id, token_hash, workspace_name, username, display_name, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sha256(token),
    workspaceName,
    "",
    "",
    admin.user.id,
    now,
    now + INVITE_DAYS * 86400000,
  );
  sendJson(req, res, 201, {
    invite: {
      id,
      workspaceName,
      expiresAt: now + INVITE_DAYS * 86400000,
      url: `${publicOrigin(req)}/invite/${token}`,
    },
    token,
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      needsSetup: userCount() === 0,
      schemaVersion: SCHEMA_VERSION,
    });
    return;
  }

  if (pathname === "/api/setup/status" && req.method === "GET") {
    sendJson(req, res, 200, {
      needsSetup: userCount() === 0,
      schemaVersion: SCHEMA_VERSION,
    });
    return;
  }

  if (pathname === "/api/setup" && req.method === "POST") {
    if (userCount() > 0) {
      sendJson(req, res, 409, { error: "already_setup" });
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(req, res, 403, { error: "bad_origin" });
      return;
    }
    const body = await jsonBody(req);
    if (!body) {
      sendJson(req, res, 400, { error: "bad_body" });
      return;
    }
    const provided = String(body.setupToken || "");
    const expected = SETUP_TOKEN;
    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      sendJson(req, res, 403, { error: "bad_setup_token" });
      return;
    }
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const displayName = String(body.displayName || username).trim();
    const workspaceName = String(body.workspaceName || "我的三线").trim();
    const passwordError = validateUsernameAndPassword(username, password);
    if (passwordError) {
      sendJson(req, res, 400, { error: "bad_credentials", message: passwordError });
      return;
    }
    if (!displayName || displayName.length > 80 || !workspaceName || workspaceName.length > 80) {
      sendJson(req, res, 400, { error: "bad_name" });
      return;
    }
    try {
      const legacy = readLegacyState();
      const created = createWorkspaceAndUser({
        username,
        displayName,
        password,
        workspaceName,
        isAdmin: true,
        legacyState: legacy,
      });
      const sessionToken = createSession(req, res, created.userId);
      const auth = authSessionFromToken(sessionToken);
      sendJson(req, res, 201, mePayload(auth));
    } catch (error) {
      console.error("[setup]", error);
      sendJson(req, res, 500, { error: "setup_failed" });
    }
    return;
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    if (!sameOrigin(req)) {
      sendJson(req, res, 403, { error: "bad_origin" });
      return;
    }
    const body = await jsonBody(req);
    if (!body) {
      sendJson(req, res, 400, { error: "bad_body" });
      return;
    }
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = db
      .prepare(
        "SELECT id, username, display_name, password_hash, is_admin, workspace_id FROM users WHERE username = ?",
      )
      .get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      sendJson(req, res, 401, { error: "bad_credentials" });
      return;
    }
    const sessionToken = createSession(req, res, user.id);
    const auth = authSessionFromToken(sessionToken);
    sendJson(req, res, 200, mePayload(auth));
    return;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    if (!sameOrigin(req)) {
      sendJson(req, res, 403, { error: "bad_origin" });
      return;
    }
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    res.setHeader("Set-Cookie", clearSessionCookie(req));
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const auth = authSession(req);
    if (!auth) {
      sendJson(req, res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(req, res, 200, mePayload(auth));
    return;
  }

  if (pathname === "/api/me" && req.method === "PATCH") {
    const auth = requireSession(req, res);
    if (!auth) return;
    const body = await jsonBody(req);
    if (!body) {
      sendJson(req, res, 400, { error: "bad_body" });
      return;
    }
    const displayName = String(body.displayName || "").trim();
    if (!displayName || displayName.length > 80) {
      sendJson(req, res, 400, { error: "bad_display_name" });
      return;
    }
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(
      displayName,
      auth.user.id,
    );
    const updated = authSession(req);
    sendJson(req, res, 200, mePayload(updated));
    return;
  }

  if (pathname === "/api/account/password" && req.method === "POST") {
    const auth = requireSession(req, res);
    if (!auth) return;
    const body = await jsonBody(req);
    if (!body) {
      sendJson(req, res, 400, { error: "bad_body" });
      return;
    }
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!validPassword(newPassword)) {
      sendJson(req, res, 400, { error: "bad_password", message: "新密码至少 8 位" });
      return;
    }
    const row = db
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(auth.user.id);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      sendJson(req, res, 403, { error: "bad_current_password" });
      return;
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      hashPassword(newPassword),
      auth.user.id,
    );
    const currentToken = parseCookies(req)[COOKIE_NAME];
    db.prepare(
      "DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?",
    ).run(auth.user.id, sha256(currentToken || ""));
    sendJson(req, res, 200, { ok: true });
    return;
  }

  const inviteMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteMatch && req.method === "GET") {
    const token = decodeURIComponent(inviteMatch[1]);
    const row = db
      .prepare("SELECT * FROM invites WHERE token_hash = ?")
      .get(sha256(token));
    const now = Date.now();
    if (!row || row.used_at || row.revoked_at || Number(row.expires_at) <= now) {
      sendJson(req, res, 404, { error: "invite_invalid" });
      return;
    }
    sendJson(req, res, 200, {
      workspaceName: row.workspace_name,
      expiresAt: row.expires_at,
    });
    return;
  }

  const acceptMatch = pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
  if (acceptMatch && req.method === "POST") {
    if (!sameOrigin(req)) {
      sendJson(req, res, 403, { error: "bad_origin" });
      return;
    }
    const token = decodeURIComponent(acceptMatch[1]);
    const body = await jsonBody(req);
    if (!body) {
      sendJson(req, res, 400, { error: "bad_body" });
      return;
    }
    const password = String(body.password || "");
    const passwordError = validPassword(password);
    if (!passwordError) {
      sendJson(req, res, 400, { error: "bad_password", message: "密码至少 8 位" });
      return;
    }
    const row = db
      .prepare("SELECT * FROM invites WHERE token_hash = ?")
      .get(sha256(token));
    const now = Date.now();
    if (!row || row.used_at || row.revoked_at || Number(row.expires_at) <= now) {
      sendJson(req, res, 404, { error: "invite_invalid" });
      return;
    }
    try {
      const requestedUsername = String(body.username || "").trim();
      const username = requestedUsername || row.username;
      if (!validUsername(username)) {
        sendJson(req, res, 400, {
          error: "bad_username",
          message: "登录名需要 3–32 位字母、数字、_ 或 -",
        });
        return;
      }
      if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
        sendJson(req, res, 409, { error: "username_taken" });
        return;
      }
      const requestedDisplayName = String(body.displayName || "").trim();
      const displayName = requestedDisplayName && requestedDisplayName.length <= 80
        ? requestedDisplayName
        : username;
      const created = createWorkspaceAndUser({
        username,
        displayName,
        password,
        workspaceName: row.workspace_name,
        isAdmin: false,
      });
      db.prepare(
        "UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL",
      ).run(now, created.userId, row.id);
      const sessionToken = createSession(req, res, created.userId);
      const auth = authSessionFromToken(sessionToken);
      sendJson(req, res, 201, mePayload(auth));
    } catch (error) {
      console.error("[invite]", error);
      sendJson(req, res, 409, { error: "invite_accept_failed" });
    }
    return;
  }

  if (pathname === "/api/admin/invites" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const rows = db
      .prepare(
        "SELECT id, workspace_name, username, display_name, created_at, expires_at, used_at, revoked_at FROM invites ORDER BY created_at DESC LIMIT 100",
      )
      .all();
    sendJson(req, res, 200, {
      invites: rows.map((row) => ({
        id: row.id,
        workspaceName: row.workspace_name,
        username: row.username,
        displayName: row.display_name,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        revokedAt: row.revoked_at,
      })),
    });
    return;
  }

  if (pathname === "/api/admin/invites" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const body = await jsonBody(req);
    if (!body) {
      sendJson(req, res, 400, { error: "bad_body" });
      return;
    }
    createInvite(req, res, admin, body);
    return;
  }

  const adminInviteDelete = pathname.match(/^\/api\/admin\/invites\/([^/]+)$/);
  if (adminInviteDelete && req.method === "DELETE") {
    requireAdmin(req, res);
    if (res.writableEnded) return;
    db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ?").run(
      Date.now(),
      decodeURIComponent(adminInviteDelete[1]),
    );
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/admin/users" && req.method === "GET") {
    requireAdmin(req, res);
    if (res.writableEnded) return;
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at,
                w.id AS workspace_id, w.name AS workspace_name
         FROM users u JOIN workspaces w ON w.id = u.workspace_id
         ORDER BY u.created_at`,
      )
      .all();
    sendJson(req, res, 200, {
      users: rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        isAdmin: Boolean(row.is_admin),
        createdAt: row.created_at,
        workspace: { id: row.workspace_id, name: row.workspace_name },
      })),
    });
    return;
  }

  const resetMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
  if (resetMatch && req.method === "POST") {
    requireAdmin(req, res);
    if (res.writableEnded) return;
    const userId = decodeURIComponent(resetMatch[1]);
    const target = db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(userId);
    if (!target) {
      sendJson(req, res, 404, { error: "user_not_found" });
      return;
    }
    const tempPassword = crypto.randomBytes(9).toString("base64url");
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      hashPassword(tempPassword),
      target.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    sendJson(req, res, 200, {
      ok: true,
      username: target.username,
      password: tempPassword,
    });
    return;
  }

  if (pathname === "/api/agent-tokens" && req.method === "GET") {
    const auth = requireSession(req, res);
    if (!auth) return;
    const rows = db
      .prepare(
        "SELECT id, label, created_at, last_used_at FROM agent_tokens WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .all(auth.workspace.id);
    sendJson(req, res, 200, {
      tokens: rows.map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      })),
    });
    return;
  }

  if (pathname === "/api/agent-tokens" && req.method === "POST") {
    const auth = requireSession(req, res);
    if (!auth) return;
    const body = await jsonBody(req);
    const label = String(body?.label || "Agent").trim();
    if (!label || label.length > 80) {
      sendJson(req, res, 400, { error: "bad_label" });
      return;
    }
    const token = randomToken("gantt_");
    const id = randomId("at");
    db.prepare(
      "INSERT INTO agent_tokens(id, workspace_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, auth.workspace.id, label, sha256(token), Date.now());
    sendJson(req, res, 201, { id, label, token });
    return;
  }

  const agentTokenDelete = pathname.match(/^\/api\/agent-tokens\/([^/]+)$/);
  if (agentTokenDelete && req.method === "DELETE") {
    const auth = requireSession(req, res);
    if (!auth) return;
    db.prepare(
      "UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ?",
    ).run(Date.now(), decodeURIComponent(agentTokenDelete[1]), auth.workspace.id);
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    const auth = authenticate(req);
    if (!auth) {
      sendJson(req, res, 401, { error: "unauthorized" });
      return;
    }
    const row = getStateRow(auth.workspace.id);
    if (!row) {
      createEmptyState(auth.workspace.id);
    }
    sendJson(req, res, 200, rowToState(getStateRow(auth.workspace.id)));
    return;
  }

  if (pathname === "/api/state" && req.method === "PUT") {
    if (!sameOrigin(req)) {
      sendJson(req, res, 403, { error: "bad_origin" });
      return;
    }
    const auth = authenticate(req);
    if (!auth) {
      sendJson(req, res, 401, { error: "unauthorized" });
      return;
    }
    const body = await jsonBody(req);
    if (!body) {
      sendJson(req, res, 400, { error: "bad_body" });
      return;
    }
    const validation = validateData(body.tasks, body.zones);
    if (!validation.ok) {
      sendJson(req, res, 400, {
        error: "bad_snapshot",
        details: validation.errors.slice(0, 20),
      });
      return;
    }
    const baseRevision = Number(body.baseRevision);
    if (!Number.isFinite(baseRevision)) {
      sendJson(req, res, 400, { error: "bad_revision" });
      return;
    }
    const workspaceId = auth.workspace.id;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = getStateRow(workspaceId);
      const currentRevision = current ? Number(current.revision) : 0;
      if ((current?.initialized || currentRevision > 0) && baseRevision !== currentRevision) {
        db.exec("ROLLBACK");
        sendJson(req, res, 409, {
          error: "conflict",
          state: rowToState(current),
        });
        return;
      }
      const nextRevision = currentRevision + 1;
      const updatedAt = Date.now();
      db.prepare(
        `INSERT INTO workspace_state
          (workspace_id, schema_version, revision, updated_at, initialized, tasks_json, zones_json)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           revision = excluded.revision,
           updated_at = excluded.updated_at,
           initialized = 1,
           tasks_json = excluded.tasks_json,
           zones_json = excluded.zones_json`,
      ).run(
        workspaceId,
        SCHEMA_VERSION,
        nextRevision,
        updatedAt,
        JSON.stringify(body.tasks),
        JSON.stringify(body.zones),
      );
      db.exec("COMMIT");
      sendJson(req, res, 200, {
        schemaVersion: SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt,
        initialized: true,
        tasks: body.tasks,
        zones: body.zones,
      });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      console.error("[state]", error);
      sendJson(req, res, 500, { error: "state_failed" });
    }
    return;
  }

  sendJson(req, res, 404, { error: "not_found" });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (decoded.includes("\0")) {
    res.writeHead(400);
    res.end();
    return;
  }
  let filePath = path.join(DIST, decoded);
  const relative = path.relative(DIST, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end();
    return;
  }
  let stat = null;
  try {
    stat = statSync(filePath);
  } catch {
    stat = null;
  }
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    try {
      stat = statSync(filePath);
    } catch {
      stat = null;
    }
  }
  if (!stat && !decoded.includes(".")) {
    filePath = path.join(DIST, "index.html");
    try {
      stat = statSync(filePath);
    } catch {
      stat = null;
    }
  }
  if (!stat) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found. Run `npm run build` first.");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "X-Content-Type-Options": "nosniff",
  };
  if (base === "index.html" || base === "sw.js" || base === "manifest.webmanifest") {
    headers["Cache-Control"] = "no-cache";
  } else if (decoded.startsWith("/assets/")) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  } else {
    headers["Cache-Control"] = "public, max-age=86400";
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error("[server]", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const needsSetup = userCount() === 0;
  console.log("");
  console.log("  三线 · 多 workspace 服务已启动");
  console.log(`  本地：http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
  console.log(`  数据：${DB_FILE}`);
  if (needsSetup) {
    console.log("");
    console.log("  首次启动需要设置管理员：");
    console.log(`  Setup token: ${SETUP_TOKEN}`);
  }
  console.log("");
});

function shutdown() {
  try {
    db.close();
  } catch {
    // ignore
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
