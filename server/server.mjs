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
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PASSCODE_FILE = path.join(DATA_DIR, "passcode.txt");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 6 * 1024 * 1024;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: 0,
    initialized: false,
    tasks: [],
    zones: [],
  };
}

function readState() {
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.zones)) {
      return emptyState();
    }
    const candidate = {
      schemaVersion: Number(parsed.schemaVersion) || SCHEMA_VERSION,
      revision: Number(parsed.revision) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
      initialized: Boolean(parsed.initialized),
      tasks: parsed.tasks,
      zones: parsed.zones,
    };
    const validation = validateSnapshot(candidate);
    if (!validation.ok) {
      console.error(
        "[server] state.json does not match schema v1; serving it read-only for inspection:",
        validation.errors.slice(0, 10),
      );
    }
    return candidate;
  } catch {
    return emptyState();
  }
}

let state = readState();

function getPasscode() {
  const fromEnv = process.env.GANTT_PASSCODE?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(PASSCODE_FILE)) {
    const saved = readFileSync(PASSCODE_FILE, "utf8").trim();
    if (saved) return saved;
  }
  const generated = crypto.randomBytes(9).toString("base64url");
  writeFileSync(PASSCODE_FILE, generated + "\n", { mode: 0o600 });
  return generated;
}

const PASSCODE = getPasscode();

function authorized(req) {
  const header = req.headers["x-gantt-passcode"];
  if (typeof header !== "string" || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Gantt-Passcode");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(req, res, status, data) {
  cors(req, res);
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function pruneBackups() {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((name) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort();
    while (files.length > 14) {
      const oldest = files.shift();
      if (oldest) unlinkSync(path.join(BACKUP_DIR, oldest));
    }
  } catch {
    // Backups are best-effort.
  }
}

function saveState(next) {
  const temp = STATE_FILE + ".tmp";
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temp, STATE_FILE);

  const day = new Date().toISOString().slice(0, 10);
  const backup = path.join(BACKUP_DIR, `state-${day}.json`);
  if (!existsSync(backup)) {
    try {
      copyFileSync(STATE_FILE, backup);
      pruneBackups();
    } catch {
      // Do not fail a save because a backup could not be written.
    }
  }
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

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    cors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      revision: state.revision,
      initialized: state.initialized,
      updatedAt: state.updatedAt,
      schemaVersion: state.schemaVersion,
    });
    return;
  }

  if (!authorized(req)) {
    sendJson(req, res, 401, { error: "unauthorized" });
    return;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    sendJson(req, res, 200, state);
    return;
  }

  if (pathname === "/api/state" && req.method === "PUT") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
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
    if (state.initialized && baseRevision !== state.revision && !body.force) {
      sendJson(req, res, 409, { error: "conflict", state });
      return;
    }

    state = {
      schemaVersion: SCHEMA_VERSION,
      revision: state.revision + 1,
      updatedAt: Date.now(),
      initialized: true,
      tasks: body.tasks,
      zones: body.zones,
    };
    saveState(state);
    sendJson(req, res, 200, state);
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

  if (!stat) {
    if (!decoded.includes(".")) {
      filePath = path.join(DIST, "index.html");
      try {
        stat = statSync(filePath);
      } catch {
        stat = null;
      }
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  三线 · 时间网格 服务已启动");
  console.log(`  本地：http://localhost:${PORT}/`);
  console.log(`  口令：${PASSCODE}`);
  console.log(`  数据：${STATE_FILE}`);
  console.log("");
});
