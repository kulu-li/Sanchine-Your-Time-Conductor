#!/usr/bin/env node
/**
 * 三线 Gantt agent CLI.
 *
 * It reads/writes the same snapshot API as the web app. It never edits
 * data/state.json directly, and every write is checked against the current
 * revision so an agent cannot silently overwrite a newer change.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  PART_LABELS,
  isValidDate,
  slotOf,
  slotToDatePart,
  validateData,
  validateSnapshot,
} from "../schema/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_URL = "http://127.0.0.1:8787";
const PART_ALIASES = { 早: 0, 中: 1, 晚: 2, 0: 0, 1: 1, 2: 2 };
function loadDotEnv() {
  const files = [path.join(ROOT, ".env"), path.join(ROOT, "agent", ".env")];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadDotEnv();



class CliError extends Error {
  constructor(code, message, details = null, exitCode = 1) {
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function parseArgv(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const raw = item.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      args[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[raw] = next;
      i += 1;
    } else {
      args[raw] = true;
    }
  }
  return args;
}

function fail(code, message, details = null, exitCode = 1) {
  throw new CliError(code, message, details, exitCode);
}

function boolArg(value) {
  return value === true || value === "true" || value === "1";
}

function requireArg(args, name, label = name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    fail("usage", `缺少 --${name}（${label}）`);
  }
  return value.trim();
}

function optionalString(args, name) {
  return typeof args[name] === "string" ? args[name] : undefined;
}

function baseUrl(args) {
  const value = optionalString(args, "url") || process.env.GANTT_URL || DEFAULT_URL;
  return value.replace(/\/+$/, "");
}

function authHeaders(args) {
  const token = process.env.GANTT_TOKEN?.trim();
  if (token) return { Authorization: `Bearer ${token}` };
  if (process.env.GANTT_PASSCODE) {
    return { "X-Gantt-Passcode": process.env.GANTT_PASSCODE.trim() };
  }
  const file = optionalString(args, "passcode-file") ||
    path.join(ROOT, "data", "passcode.txt");
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value) return { "X-Gantt-Passcode": value };
  } catch {
    // fall through
  }
  fail(
    "unauthorized",
    "没有认证信息。设置 GANTT_TOKEN（workspace agent token）；旧部署可临时用 GANTT_PASSCODE/--passcode-file。",
    null,
    2,
  );
}

async function requestJson(args, method, body) {
  const url = `${baseUrl(args)}/api/state`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...authHeaders(args),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    fail(
      "network",
      `连不上 ${baseUrl(args)}：${error instanceof Error ? error.message : String(error)}`,
      null,
      1,
    );
  }

  if (response.status === 401) {
    fail("unauthorized", "云端口令不对。", null, 2);
  }
  if (response.status === 409) {
    const data = await response.json().catch(() => null);
    fail(
      "conflict",
      `云端已更新到 revision ${data?.state?.revision ?? "?"}，本次没有写入。请重新读取后再改。`,
      { remoteRevision: data?.state?.revision ?? null, state: data?.state ?? null },
      3,
    );
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const details = data?.details || data?.error || `HTTP ${response.status}`;
    fail(
      "server",
      `服务器拒绝写入：${Array.isArray(details) ? details.join("; ") : details}`,
      data,
      4,
    );
  }
  return response.json();
}

async function getState(args, { quiet = false } = {}) {
  const state = await requestJson(args, "GET");
  const validation = validateSnapshot({
    schemaVersion: state.schemaVersion ?? SCHEMA_VERSION,
    revision: state.revision,
    updatedAt: state.updatedAt,
    initialized: state.initialized,
    tasks: state.tasks,
    zones: state.zones,
  });
  if (!validation.ok) {
    if (!quiet) {
      fail("bad_remote", "云端数据不符合 schema v1。", validation.errors, 4);
    }
    return { ...state, validation };
  }
  return state;
}

async function commit(args, state, nextTasks, nextZones, summary) {
  const validation = validateData(nextTasks, nextZones);
  if (!validation.ok) {
    fail("invalid", "修改后的数据不符合 schema v1，未写入。", validation.errors, 4);
  }
  if (args["dry-run"] || args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      revision: state.revision,
      summary,
      counts: { tasks: nextTasks.length, zones: nextZones.length },
    };
  }

  const saved = await requestJson(args, "PUT", {
    schemaVersion: SCHEMA_VERSION,
    baseRevision: state.revision,
    tasks: nextTasks,
    zones: nextZones,
  });
  const validationAfter = validateSnapshot(saved);
  if (!validationAfter.ok) {
    fail("bad_server", "服务器返回的数据不符合 schema v1。", validationAfter.errors, 4);
  }
  return {
    ok: true,
    dryRun: false,
    revision: saved.revision,
    updatedAt: saved.updatedAt,
    summary,
    counts: { tasks: saved.tasks.length, zones: saved.zones.length },
  };
}

function zoneMap(zones) {
  return new Map(zones.map((zone) => [zone.id, zone]));
}

function childrenOf(zones, parentId) {
  return zones.filter((zone) => zone.parentId === parentId);
}

function hasChildren(zones, zoneId) {
  return zones.some((zone) => zone.parentId === zoneId);
}

function nextOrder(items) {
  const values = items.map((item) => Number(item.order) || 0);
  return (values.length ? Math.max(...values) : 0) + 10;
}

function newId(prefix, used) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `${prefix}-${Date.now().toString(36)}-${crypto
      .randomBytes(3)
      .toString("hex")}`;
    if (!used.has(candidate)) return candidate;
  }
  fail("id", "无法生成唯一 id");
}

function resolveZoneByName(zones, query, { allowGroup = true } = {}) {
  const byId = zones.find((zone) => zone.id === query);
  if (byId) {
    if (!allowGroup && hasChildren(zones, byId.id)) {
      fail(
        "not_project",
        `「${byId.name}」是分区，不是项目。可选子项目：${childrenOf(zones, byId.id)
          .map((zone) => zone.name)
          .join("、") || "无"}`,
      );
    }
    return byId;
  }

  const matches = zones.filter((zone) => zone.name === query);
  if (matches.length === 0) {
    fail("not_found", `找不到分区/项目「${query}」。`, {
      candidates: zones.map((zone) => ({ id: zone.id, name: zone.name })),
    });
  }
  if (matches.length > 1) {
    fail(
      "ambiguous",
      `「${query}」有 ${matches.length} 个同名项，请改用 --project-id 或 --id。`,
      {
        candidates: matches.map((zone) => ({
          id: zone.id,
          name: zone.name,
          parentId: zone.parentId,
        })),
      },
    );
  }
  const match = matches[0];
  if (!allowGroup && hasChildren(zones, match.id)) {
    fail(
      "not_project",
      `「${match.name}」是分区，不是项目。可选子项目：${childrenOf(zones, match.id)
        .map((zone) => zone.name)
        .join("、") || "无"}`,
    );
  }
  return match;
}

function resolveScope(state, args) {
  const id = optionalString(args, "project-id");
  if (id) {
    const zone = state.zones.find((item) => item.id === id);
    if (!zone) fail("not_found", `找不到项目 id「${id}」。`);
    return zone;
  }
  return resolveZoneByName(state.zones, requireArg(args, "project", "项目名或 id"), {
    allowGroup: true,
  });
}

function assertSingleTimeMode(args) {
  if (args.end !== undefined && args.length !== undefined) {
    fail("usage", "--end 和 --length 只能二选一。");
  }
}

function resolveProject(state, args, queryKey = "project", idKey = "project-id") {
  const id = optionalString(args, idKey);
  if (id) {
    const zone = state.zones.find((item) => item.id === id);
    if (!zone) fail("not_found", `找不到项目 id「${id}」。`);
    if (hasChildren(state.zones, zone.id)) {
      fail("not_project", `「${zone.name}」是分区，不是项目。`);
    }
    return zone;
  }
  const query = requireArg(args, queryKey, "项目名或 id");
  return resolveZoneByName(state.zones, query, { allowGroup: false });
}

function parseWhen(value, label = "时间") {
  if (typeof value !== "string") {
    fail("usage", `${label}格式应为 YYYY-MM-DD/早|中|晚`);
  }
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[/ ](早|中|晚|0|1|2))?$/);
  if (!match || !isValidDate(match[1])) {
    fail("usage", `${label}格式应为 YYYY-MM-DD/早|中|晚，收到「${value}」`);
  }
  const part = match[2] === undefined ? 0 : PART_ALIASES[match[2]];
  return { date: match[1], part };
}

function formatWhen(when) {
  return `${when.date}/${PART_LABELS[when.part]}`;
}

function parseLength(value, label = "长度") {
  const length = Number(value);
  if (!Number.isInteger(length) || length < 1 || length > 1000) {
    fail("usage", `${label}必须是 1–1000 的整数（1 格 = 1/3 天）`);
  }
  return length;
}

function endFrom(start, length) {
  const slot = slotOf(start.date, start.part) + length - 1;
  return slotToDatePart(slot);
}

function durationOf(task) {
  return slotOf(task.endDate, task.endPart) - slotOf(task.startDate, task.startPart) + 1;
}

function assertTimeRange(start, end, label = "任务") {
  if (slotOf(end.date, end.part) < slotOf(start.date, start.part)) {
    fail("usage", `${label}的结束时间不能早于开始时间。`);
  }
}

function taskProjectName(state, task) {
  return zoneMap(state.zones).get(task.zoneId)?.name || task.zoneId;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const slotDiff =
      slotOf(a.startDate, a.startPart) - slotOf(b.startDate, b.startPart);
    if (slotDiff !== 0) return slotDiff;
    return (Number(a.order) || 0) - (Number(b.order) || 0);
  });
}

function printTask(task, state) {
  const start = `${task.startDate}/${PART_LABELS[task.startPart]}`;
  const end = `${task.endDate}/${PART_LABELS[task.endPart]}`;
  const range = start === end ? start : `${start} → ${end}`;
  const mark = task.done ? "[x]" : "[ ]";
  console.log(`${mark} ${range}  ${taskProjectName(state, task)}  ${task.title}`);
}

function printProjects(state, args) {
  const tops = state.zones
    .filter((zone) => zone.parentId === null)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  for (const top of tops) {
    const children = childrenOf(state.zones, top.id);
    if (children.length === 0) {
      const count = state.tasks.filter((task) => task.zoneId === top.id).length;
      console.log(`${top.name}  (${count} 个子任务)  [${top.id}]`);
      continue;
    }
    console.log(`${top.name}  [分区 ${top.id}]`);
    for (const child of children.sort(
      (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0),
    )) {
      const count = state.tasks.filter((task) => task.zoneId === child.id).length;
      console.log(`  - ${child.name}  (${count} 个子任务)  [${child.id}]`);
    }
  }
}

function stateSummary(state) {
  return {
    schemaVersion: state.schemaVersion ?? SCHEMA_VERSION,
    revision: state.revision,
    initialized: state.initialized,
    tasks: state.tasks.length,
    zones: state.zones.length,
    updatedAt: state.updatedAt,
  };
}

function printResult(args, result) {
  if (boolArg(args.json) || boolArg(args["json"])) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.dryRun) {
    console.log(`DRY RUN · revision ${result.revision} · ${result.summary}`);
    console.log("没有写入云端。");
    return;
  }
  console.log(`OK · revision ${result.revision} · ${result.summary}`);
}

function printError(error, json) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          code: error.code || "error",
          message: error.message,
          details: error.details || null,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`错误 [${error.code || "error"}]: ${error.message}`);
    if (error.details) {
      if (Array.isArray(error.details)) {
        for (const detail of error.details.slice(0, 20)) console.error(`- ${detail}`);
      } else if (typeof error.details === "object" && error.details.candidates) {
        for (const candidate of error.details.candidates.slice(0, 20)) {
          console.error(`- ${candidate.name ?? ""} [${candidate.id ?? ""}]`);
        }
      }
    }
  }
}

function printHelp() {
  console.log(`三线 Gantt agent CLI

用法：
  node agent/gantt.mjs <command> [options]

命令：
  state                         查看 revision / 数量
  projects                      列出分区和项目
  tasks [--project X] [--from D] [--to D] [--done|--todo] [--json]
  add-task --project X --title T --start D/早|中|晚 [--length N | --end D/早|中|晚] [--note S]
  update-task --id ID [--title T] [--note S] [--project X] [--start ...] [--end ... | --length N] [--done|--undone]
  move-task --id ID --start D/早|中|晚 [--end ... | --length N]
  done --id ID [--undo]
  add-project --name N [--parent X] [--color '#RRGGBB']
  update-project --id ID [--name N] [--color '#RRGGBB'] [--order N]
  delete-task --id ID [--yes]
  delete-project --id ID [--yes]   # 分组不能删；子任务移到 other
  export [--file PATH]
  validate                      校验云端 schema

通用选项：
  --url URL                     默认 http://127.0.0.1:8787 或 GANTT_URL
  GANTT_TOKEN / GANTT_URL       推荐：workspace agent token + 部署地址
  --passcode-file PATH          旧部署兼容：data/passcode.txt 或 GANTT_PASSCODE
  --project-id ID               同名项目/分区时用 id 消歧
  --parent-id ID                同名父分区时用 id
  --dry-run                     只显示结果，不写云端
  --json                        机器可读输出
  --yes                         确认删除

时间：
  --start 2026-10-22/晚         日期 + 早/中/晚（也接受 0/1/2）
  日期不带时段默认早。
  --length 2                    跨 2 个 1/3 天格；不写默认 1 格。
`);
}

async function commandState(args) {
  const state = await getState(args);
  const summary = stateSummary(state);
  if (boolArg(args.json)) {
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
    return;
  }
  console.log(`revision ${summary.revision}`);
  console.log(`schema v${summary.schemaVersion} · ${summary.tasks} 个子任务 · ${summary.zones} 个分区/项目`);
  console.log(`initialized ${summary.initialized ? "yes" : "no"} · updated ${new Date(summary.updatedAt).toISOString()}`);
}

async function commandProjects(args) {
  const state = await getState(args);
  if (boolArg(args.json)) {
    console.log(JSON.stringify({ ok: true, revision: state.revision, zones: state.zones }, null, 2));
    return;
  }
  printProjects(state, args);
}

async function commandTasks(args) {
  const state = await getState(args);
  let rows = state.tasks;
  if (args.project || args["project-id"]) {
    const project = resolveScope(state, args);
    const scope = new Set([project.id]);
    for (const child of childrenOf(state.zones, project.id)) scope.add(child.id);
    rows = rows.filter((task) => scope.has(task.zoneId));
  }
  if (typeof args.from === "string") {
    const from = parseWhen(args.from, "--from").date;
    rows = rows.filter((task) => task.endDate >= from);
  }
  if (typeof args.to === "string") {
    const to = parseWhen(args.to, "--to").date;
    rows = rows.filter((task) => task.startDate <= to);
  }
  if (boolArg(args.done)) rows = rows.filter((task) => task.done);
  if (boolArg(args.todo)) rows = rows.filter((task) => !task.done);
  const limit = args.limit === undefined ? 200 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1) fail("usage", "--limit 必须是正整数");
  rows = sortTasks(rows).slice(0, limit);

  if (boolArg(args.json)) {
    console.log(JSON.stringify({ ok: true, revision: state.revision, tasks: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("没有匹配的子任务。");
    return;
  }
  for (const task of rows) printTask(task, state);
  console.log(`\n共 ${rows.length} 条（revision ${state.revision}）`);
}

async function commandAddTask(args) {
  const state = await getState(args);
  const project = resolveProject(state, args);
  const title = requireArg(args, "title", "子任务标题");
  if (title.length > 200) fail("usage", "标题最多 200 字");
  assertSingleTimeMode(args);
  const start = parseWhen(requireArg(args, "start", "开始时间"));
  let end;
  if (args.end !== undefined) {
    end = parseWhen(String(args.end), "--end");
  } else {
    end = endFrom(start, args.length === undefined ? 1 : parseLength(args.length));
  }
  assertTimeRange(start, end);
  const note = optionalString(args, "note") ?? "";
  if (note.length > 4000) fail("usage", "备注最多 4000 字");
  const now = Date.now();
  const used = new Set(state.tasks.map((task) => task.id));
  const task = {
    id: newId("task", used),
    zoneId: project.id,
    title,
    startDate: start.date,
    startPart: start.part,
    endDate: end.date,
    endPart: end.part,
    done: false,
    note,
    order: nextOrder(state.tasks.filter((item) => item.zoneId === project.id)),
    createdAt: now,
    updatedAt: now,
  };
  const nextTasks = [...state.tasks, task];
  const result = await commit(
    args,
    state,
    nextTasks,
    state.zones,
    `新增「${project.name} / ${title}」${formatWhen(start)} → ${formatWhen(end)}`,
  );
  if (boolArg(args.json)) {
    console.log(JSON.stringify({ ...result, task }, null, 2));
  } else {
    printResult(args, result);
    if (!result.dryRun) console.log(`id: ${task.id}`);
  }
}

async function commandUpdateTask(args) {
  const state = await getState(args);
  const id = requireArg(args, "id", "子任务 id");
  const task = state.tasks.find((item) => item.id === id);
  if (!task) fail("not_found", `找不到子任务 id「${id}」。`);

  const next = { ...task };
  const changed = [];
  if (args.title !== undefined) {
    const title = String(args.title).trim();
    if (!title || title.length > 200) fail("usage", "标题必须在 1–200 字");
    next.title = title;
    changed.push("标题");
  }
  if (args.note !== undefined) {
    const note = String(args.note);
    if (note.length > 4000) fail("usage", "备注最多 4000 字");
    next.note = note;
    changed.push("备注");
  }
  if (args.project || args["project-id"]) {
    const project = resolveProject(state, args);
    next.zoneId = project.id;
    next.order = nextOrder(
      state.tasks.filter((item) => item.zoneId === project.id && item.id !== id),
    );
    changed.push("项目");
  }
  if (args.start !== undefined || args.end !== undefined || args.length !== undefined) {
    assertSingleTimeMode(args);
    const start = args.start !== undefined
      ? parseWhen(String(args.start), "--start")
      : { date: task.startDate, part: task.startPart };
    let end;
    if (args.end !== undefined) {
      end = parseWhen(String(args.end), "--end");
    } else if (args.length !== undefined) {
      end = endFrom(start, parseLength(args.length));
    } else {
      end = endFrom(start, durationOf(task));
    }
    assertTimeRange(start, end);
    next.startDate = start.date;
    next.startPart = start.part;
    next.endDate = end.date;
    next.endPart = end.part;
    changed.push("时间");
  }
  if (boolArg(args.done)) {
    next.done = true;
    changed.push("完成");
  }
  if (boolArg(args.undone)) {
    next.done = false;
    changed.push("未完成");
  }
  if (changed.length === 0) fail("usage", "没有要修改的字段。");

  next.updatedAt = Date.now();
  const nextTasks = state.tasks.map((item) => (item.id === id ? next : item));
  const result = await commit(
    args,
    state,
    nextTasks,
    state.zones,
    `更新「${next.title}」：${changed.join("、")}`,
  );
  if (boolArg(args.json)) console.log(JSON.stringify({ ...result, task: next }, null, 2));
  else printResult(args, result);
}

async function commandMoveTask(args) {
  const state = await getState(args);
  const id = requireArg(args, "id", "子任务 id");
  const task = state.tasks.find((item) => item.id === id);
  if (!task) fail("not_found", `找不到子任务 id「${id}」。`);
  assertSingleTimeMode(args);
  const start = parseWhen(requireArg(args, "start", "开始时间"));
  let end;
  if (args.end !== undefined) end = parseWhen(String(args.end), "--end");
  else if (args.length !== undefined) end = endFrom(start, parseLength(args.length));
  else end = endFrom(start, durationOf(task));
  assertTimeRange(start, end);
  const next = {
    ...task,
    startDate: start.date,
    startPart: start.part,
    endDate: end.date,
    endPart: end.part,
    updatedAt: Date.now(),
  };
  const nextTasks = state.tasks.map((item) => (item.id === id ? next : item));
  const result = await commit(
    args,
    state,
    nextTasks,
    state.zones,
    `移动「${task.title}」到 ${formatWhen(start)} → ${formatWhen(end)}`,
  );
  if (boolArg(args.json)) console.log(JSON.stringify({ ...result, task: next }, null, 2));
  else printResult(args, result);
}

async function commandDone(args) {
  const state = await getState(args);
  const id = requireArg(args, "id", "子任务 id");
  const task = state.tasks.find((item) => item.id === id);
  if (!task) fail("not_found", `找不到子任务 id「${id}」。`);
  const done = !boolArg(args.undo);
  if (task.done === done) {
    console.log(`「${task.title}」已经是${done ? "已完成" : "未完成"}。`);
    return;
  }
  const next = { ...task, done, updatedAt: Date.now() };
  const nextTasks = state.tasks.map((item) => (item.id === id ? next : item));
  const result = await commit(
    args,
    state,
    nextTasks,
    state.zones,
    `${done ? "完成" : "取消完成"}「${task.title}」`,
  );
  if (boolArg(args.json)) console.log(JSON.stringify({ ...result, task: next }, null, 2));
  else printResult(args, result);
}

async function commandAddProject(args) {
  const state = await getState(args);
  const name = requireArg(args, "name", "项目名称");
  if (name.length > 80) fail("usage", "项目名最多 80 字");
  let parent = null;
  if (args.parent || args["parent-id"]) {
    if (args["parent-id"]) {
      parent = state.zones.find((zone) => zone.id === args["parent-id"]);
      if (!parent) fail("not_found", `找不到父分区 id「${args["parent-id"]}」。`);
    } else {
      parent = resolveZoneByName(state.zones, String(args.parent), { allowGroup: true });
    }
    if (parent.parentId !== null) fail("usage", "父分区必须是顶级分区，最多两层。");
  }
  const color = optionalString(args, "color") || parent?.color || "#6B7280";
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) fail("usage", "--color 需要 #RRGGBB");
  if (name === "其他" && state.zones.some((zone) => zone.id === "other")) {
    fail("exists", "兜底项目「其他」已经存在。");
  }
  if (name === "其他" && parent) {
    fail("usage", "「其他」必须是顶级兜底项目，不能挂在分区下面。");
  }
  const used = new Set(state.zones.map((zone) => zone.id));
  const zone = {
    id: name === "其他" ? "other" : newId("project", used),
    name,
    parentId: parent?.id ?? null,
    color,
    order: nextOrder(state.zones.filter((item) => item.parentId === (parent?.id ?? null))),
  };
  const warning = parent && !hasChildren(state.zones, parent.id)
    ? `（「${parent.name}」会变成分区，原来的直属任务会显示为直属）`
    : "";
  const result = await commit(
    args,
    state,
    state.tasks,
    [...state.zones, zone],
    `新增${parent ? "子项目" : "顶级项目"}「${name}」${warning}`,
  );
  if (boolArg(args.json)) console.log(JSON.stringify({ ...result, zone }, null, 2));
  else printResult(args, result);
}

async function commandUpdateProject(args) {
  const state = await getState(args);
  const id = requireArg(args, "id", "项目 id");
  const zone = state.zones.find((item) => item.id === id);
  if (!zone) fail("not_found", `找不到项目 id「${id}」。`);
  const next = { ...zone };
  const changed = [];
  if (args.name !== undefined) {
    const name = String(args.name).trim();
    if (!name || name.length > 80) fail("usage", "项目名必须在 1–80 字");
    next.name = name;
    changed.push("名称");
  }
  if (args.color !== undefined) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(String(args.color))) fail("usage", "--color 需要 #RRGGBB");
    next.color = String(args.color);
    changed.push("颜色");
  }
  if (args.order !== undefined) {
    const order = Number(args.order);
    if (!Number.isFinite(order)) fail("usage", "--order 需要数字");
    next.order = order;
    changed.push("排序");
  }
  if (changed.length === 0) fail("usage", "没有要修改的字段。");
  const nextZones = state.zones.map((item) => (item.id === id ? next : item));
  const result = await commit(
    args,
    state,
    state.tasks,
    nextZones,
    `更新项目「${next.name}」：${changed.join("、")}`,
  );
  if (boolArg(args.json)) console.log(JSON.stringify({ ...result, zone: next }, null, 2));
  else printResult(args, result);
}

async function commandDeleteTask(args) {
  const state = await getState(args);
  const id = requireArg(args, "id", "子任务 id");
  const task = state.tasks.find((item) => item.id === id);
  if (!task) fail("not_found", `找不到子任务 id「${id}」。`);
  if (!boolArg(args.yes) && !boolArg(args["dry-run"])) {
    fail("confirm", `删除「${task.title}」需要加 --yes（可先用 --dry-run 预览）。`);
  }
  const nextTasks = state.tasks.filter((item) => item.id !== id);
  const result = await commit(
    args,
    state,
    nextTasks,
    state.zones,
    `删除子任务「${task.title}」`,
  );
  if (boolArg(args.json)) console.log(JSON.stringify({ ...result, deleted: task }, null, 2));
  else printResult(args, result);
}

async function commandDeleteProject(args) {
  const state = await getState(args);
  const id = requireArg(args, "id", "项目 id");
  const zone = state.zones.find((item) => item.id === id);
  if (!zone) fail("not_found", `找不到项目 id「${id}」。`);
  if (zone.id === "other") fail("protected", "「其他」是兜底项目，不能删除。");
  if (hasChildren(state.zones, zone.id)) {
    fail("has_children", `「${zone.name}」是分区，请先逐个删除子项目。`);
  }
  const other = state.zones.find((item) => item.id === "other");
  if (!other) fail("not_found", "找不到「其他」兜底项目，不能安全迁移子任务。");
  if (!boolArg(args.yes) && !boolArg(args["dry-run"])) {
    fail("confirm", `删除项目「${zone.name}」需要加 --yes（可先用 --dry-run 预览）。`);
  }
  const affected = state.tasks.filter((task) => task.zoneId === zone.id);
  let order = nextOrder(state.tasks.filter((task) => task.zoneId === other.id));
  const now = Date.now();
  const nextTasks = state.tasks.map((task) => {
    if (task.zoneId !== zone.id) return task;
    const moved = { ...task, zoneId: other.id, order, updatedAt: now };
    order += 10;
    return moved;
  });
  const nextZones = state.zones.filter((item) => item.id !== zone.id);
  const result = await commit(
    args,
    state,
    nextTasks,
    nextZones,
    `删除项目「${zone.name}」，${affected.length} 个子任务移到「${other.name}」`,
  );
  if (boolArg(args.json)) {
    console.log(JSON.stringify({ ...result, deletedZone: zone, movedTasks: affected.length }, null, 2));
  } else {
    printResult(args, result);
  }
}

async function commandExport(args) {
  const state = await getState(args);
  const serialized = JSON.stringify(state, null, 2);
  if (typeof args.file === "string" && args.file) {
    fs.writeFileSync(path.resolve(args.file), serialized + "\n");
    if (boolArg(args.json)) {
      console.log(JSON.stringify({ ok: true, file: path.resolve(args.file), revision: state.revision }, null, 2));
    } else {
      console.log(`已导出 revision ${state.revision} 到 ${path.resolve(args.file)}`);
    }
    return;
  }
  if (boolArg(args.json)) {
    console.log(JSON.stringify({ ok: true, revision: state.revision, snapshot: state }, null, 2));
  } else {
    console.log(serialized);
  }
}

async function commandValidate(args) {
  const state = await requestJson(args, "GET");
  const validation = validateSnapshot({
    schemaVersion: state.schemaVersion ?? SCHEMA_VERSION,
    revision: state.revision,
    updatedAt: state.updatedAt,
    initialized: state.initialized,
    tasks: state.tasks,
    zones: state.zones,
  });
  if (boolArg(args.json)) {
    console.log(JSON.stringify({ ok: validation.ok, revision: state.revision, errors: validation.errors }, null, 2));
  } else if (validation.ok) {
    console.log(`schema v${SCHEMA_VERSION} 校验通过 · revision ${state.revision} · ${state.tasks.length} 个任务 · ${state.zones.length} 个分区/项目`);
  } else {
    console.error(`schema 校验失败（${validation.errors.length} 项）：`);
    for (const error of validation.errors.slice(0, 50)) console.error(`- ${error}`);
  }
  if (!validation.ok) process.exitCode = 4;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const command = args._[0] || "help";
  if (boolArg(args.help) || command === "help" || command === "--help") {
    printHelp();
    return;
  }
  try {
    switch (command) {
      case "state":
        await commandState(args);
        break;
      case "projects":
        await commandProjects(args);
        break;
      case "tasks":
        await commandTasks(args);
        break;
      case "add-task":
        await commandAddTask(args);
        break;
      case "update-task":
        await commandUpdateTask(args);
        break;
      case "move-task":
        await commandMoveTask(args);
        break;
      case "done":
        await commandDone(args);
        break;
      case "add-project":
        await commandAddProject(args);
        break;
      case "update-project":
        await commandUpdateProject(args);
        break;
      case "delete-task":
        await commandDeleteTask(args);
        break;
      case "delete-project":
        await commandDeleteProject(args);
        break;
      case "export":
        await commandExport(args);
        break;
      case "validate":
        await commandValidate(args);
        break;
      default:
        fail("usage", `未知命令「${command}」。运行 node agent/gantt.mjs help`);
    }
  } catch (error) {
    const json = boolArg(args.json);
    if (error instanceof CliError) {
      printError(error, json);
      process.exitCode = error.exitCode;
    } else {
      printError(
        { code: "unexpected", message: error instanceof Error ? error.message : String(error), details: null },
        json,
      );
      process.exitCode = 1;
    }
  }
}

main();
