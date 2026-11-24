import type { Part, Task } from "./types";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayISO(): string {
  return toISO(new Date());
}

export function addDays(date: Date, n: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + n);
  return next;
}

export function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

export function diffDays(from: Date, to: Date): number {
  return dayNumber(to) - dayNumber(from);
}

export function startOfMonday(date: Date): Date {
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (base.getDay() + 6) % 7;
  return addDays(base, -offset);
}

export function weekdayCN(date: Date): string {
  return WEEKDAYS[date.getDay()];
}

export function formatMD(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

export function formatRange(startISO: string, days: number): string {
  const start = parseISO(startISO);
  const end = addDays(start, days - 1);
  if (start.getFullYear() !== end.getFullYear()) {
    return `${start.getFullYear()}/${formatMD(start)} – ${end.getFullYear()}/${formatMD(end)}`;
  }
  return `${formatMD(start)} – ${formatMD(end)}`;
}

export function isWeekend(date: Date): boolean {
  return date.getDay() === 0 || date.getDay() === 6;
}

export function datePartToSlot(viewStartISO: string, dateISO: string, part: Part): number {
  return diffDays(parseISO(viewStartISO), parseISO(dateISO)) * 3 + part;
}

export function slotToDatePart(viewStartISO: string, slot: number): { date: string; part: Part } {
  const dayOffset = Math.floor(slot / 3);
  const part = (((slot % 3) + 3) % 3) as Part;
  return { date: toISO(addDays(parseISO(viewStartISO), dayOffset)), part };
}

export function taskStartSlot(viewStartISO: string, task: Task): number {
  return datePartToSlot(viewStartISO, task.startDate, task.startPart);
}

export function taskEndSlot(viewStartISO: string, task: Task): number {
  return datePartToSlot(viewStartISO, task.endDate, task.endPart);
}

export function compareSlots(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return aStart - bStart || aEnd - bEnd;
}

/** Absolute 1/3-day key, independent of the visible range. */
export function slotKey(dateISO: string, part: Part): number {
  return dayNumber(parseISO(dateISO)) * 3 + part;
}

export function keyToSlot(key: number): { date: string; part: Part } {
  const day = Math.floor(key / 3);
  const part = (((key % 3) + 3) % 3) as Part;
  const epoch = new Date(1970, 0, 1);
  return { date: toISO(addDays(epoch, day)), part };
}

export function currentPart(date = new Date()): Part {
  const hour = date.getHours();
  if (hour < 11) return 0;
  if (hour < 18) return 1;
  return 2;
}

export function formatSlotLabel(dateISO: string, part: Part): string {
  const date = parseISO(dateISO);
  return `${formatMD(date)} ${weekdayCN(date)} · ${["早", "中", "晚"][part]}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
