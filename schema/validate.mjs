// Canonical runtime validator for the frozen Gantt snapshot schema (v1).
// Keep this file dependency-free: the server and the agent CLI both import it.

export const SCHEMA_VERSION = 1;
export const PARTS = ["早", "中", "晚"];
export const PART_LABELS = { 0: "早", 1: "中", 2: "晚" };

const TASK_KEYS = new Set([
  "id",
  "zoneId",
  "title",
  "startDate",
  "startPart",
  "endDate",
  "endPart",
  "done",
  "note",
  "order",
  "createdAt",
  "updatedAt",
]);

const ZONE_KEYS = new Set(["id", "name", "parentId", "color", "order"]);
const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "revision",
  "updatedAt",
  "initialized",
  "tasks",
  "zones",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export function isValidDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function slotOf(date, part) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000) * 3 + part;
}

export function slotToDatePart(slot) {
  const day = Math.floor(slot / 3);
  const part = ((slot % 3) + 3) % 3;
  const date = new Date(Date.UTC(1970, 0, 1) + day * 86400000)
    .toISOString()
    .slice(0, 10);
  return { date, part };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateTask(task, index, zonesById, taskIds, errors) {
  const path = `tasks[${index}]`;
  if (!isPlainObject(task)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkKeys(task, TASK_KEYS, path, errors);

  if (typeof task.id !== "string" || !ID_RE.test(task.id)) {
    errors.push(`${path}.id: expected id matching ${ID_RE}`);
  } else if (taskIds.has(task.id)) {
    errors.push(`${path}.id: duplicate task id ${task.id}`);
  } else {
    taskIds.add(task.id);
  }

  if (typeof task.zoneId !== "string" || !zonesById.has(task.zoneId)) {
    errors.push(`${path}.zoneId: unknown zone ${String(task.zoneId)}`);
  }
  if (typeof task.title !== "string" || !task.title.trim()) {
    errors.push(`${path}.title: expected non-empty string`);
  } else if (task.title.length > 200) {
    errors.push(`${path}.title: max length is 200`);
  }
  if (!isValidDate(task.startDate)) {
    errors.push(`${path}.startDate: expected YYYY-MM-DD`);
  }
  if (!isValidDate(task.endDate)) {
    errors.push(`${path}.endDate: expected YYYY-MM-DD`);
  }
  if (![0, 1, 2].includes(task.startPart)) {
    errors.push(`${path}.startPart: expected 0, 1 or 2`);
  }
  if (![0, 1, 2].includes(task.endPart)) {
    errors.push(`${path}.endPart: expected 0, 1 or 2`);
  }
  if (isValidDate(task.startDate) && isValidDate(task.endDate)) {
    if ([0, 1, 2].includes(task.startPart) && [0, 1, 2].includes(task.endPart)) {
      if (slotOf(task.endDate, task.endPart) < slotOf(task.startDate, task.startPart)) {
        errors.push(`${path}: end is before start`);
      }
    }
  }
  if (typeof task.done !== "boolean") {
    errors.push(`${path}.done: expected boolean`);
  }
  if (typeof task.note !== "string") {
    errors.push(`${path}.note: expected string`);
  } else if (task.note.length > 4000) {
    errors.push(`${path}.note: max length is 4000`);
  }
  if (!finiteNumber(task.order)) {
    errors.push(`${path}.order: expected number`);
  }
  if (!finiteNumber(task.createdAt)) {
    errors.push(`${path}.createdAt: expected epoch milliseconds`);
  }
  if (!finiteNumber(task.updatedAt)) {
    errors.push(`${path}.updatedAt: expected epoch milliseconds`);
  }
}

function validateZone(zone, index, zoneIds, zones, errors) {
  const path = `zones[${index}]`;
  if (!isPlainObject(zone)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkKeys(zone, ZONE_KEYS, path, errors);

  if (typeof zone.id !== "string" || !ID_RE.test(zone.id)) {
    errors.push(`${path}.id: expected id matching ${ID_RE}`);
  } else if (zoneIds.has(zone.id)) {
    errors.push(`${path}.id: duplicate zone id ${zone.id}`);
  } else {
    zoneIds.add(zone.id);
  }

  if (typeof zone.name !== "string" || !zone.name.trim()) {
    errors.push(`${path}.name: expected non-empty string`);
  } else if (zone.name.length > 80) {
    errors.push(`${path}.name: max length is 80`);
  }
  if (zone.parentId !== null && typeof zone.parentId !== "string") {
    errors.push(`${path}.parentId: expected string or null`);
  }
  if (typeof zone.color !== "string" || !COLOR_RE.test(zone.color)) {
    errors.push(`${path}.color: expected #RRGGBB`);
  }
  if (!finiteNumber(zone.order)) {
    errors.push(`${path}.order: expected number`);
  }
}

/**
 * Validate tasks/zones. Returns { ok, errors }.
 * @param {unknown[]} tasks
 * @param {unknown[]} zones
 */
export function validateData(tasks, zones) {
  const errors = [];
  if (!Array.isArray(zones)) {
    return { ok: false, errors: ["zones: expected array"] };
  }
  if (!Array.isArray(tasks)) {
    return { ok: false, errors: ["tasks: expected array"] };
  }
  if (zones.length > 600) errors.push("zones: max 600");
  if (tasks.length > 5000) errors.push("tasks: max 5000");

  const zonesById = new Map();
  const zoneIds = new Set();
  zones.forEach((zone, index) => validateZone(zone, index, zoneIds, zones, errors));

  for (const zone of zones) {
    if (isPlainObject(zone) && typeof zone.id === "string") zonesById.set(zone.id, zone);
  }
  for (const zone of zones) {
    if (!isPlainObject(zone) || typeof zone.parentId !== "string") continue;
    const parent = zonesById.get(zone.parentId);
    if (!parent) {
      errors.push(`zone ${zone.id}: parent ${zone.parentId} does not exist`);
    } else if (parent.parentId !== null) {
      errors.push(`zone ${zone.id}: parent must be a top-level zone (max depth 2)`);
    }
  }

  const taskIds = new Set();
  tasks.forEach((task, index) => validateTask(task, index, zonesById, taskIds, errors));

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a full snapshot (including metadata). Existing data without
 * schemaVersion is treated as v1.
 */
export function validateSnapshot(snapshot) {
  const errors = [];
  if (!isPlainObject(snapshot)) {
    return { ok: false, errors: ["snapshot: expected object"] };
  }
  checkKeys(snapshot, SNAPSHOT_KEYS, "snapshot", errors);

  if (snapshot.schemaVersion !== undefined && snapshot.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected ${SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    errors.push("revision: expected integer >= 0");
  }
  if (!finiteNumber(snapshot.updatedAt) || snapshot.updatedAt < 0) {
    errors.push("updatedAt: expected epoch milliseconds");
  }
  if (typeof snapshot.initialized !== "boolean") {
    errors.push("initialized: expected boolean");
  }

  const data = validateData(snapshot.tasks, snapshot.zones);
  errors.push(...data.errors);
  return { ok: errors.length === 0, errors };
}
