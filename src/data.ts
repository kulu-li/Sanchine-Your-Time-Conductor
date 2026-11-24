import type { Task, Zone } from "./types";
import { addDays, startOfMonday, toISO } from "./date";

export const NEW_ZONES: Zone[] = [
  { id: "study", name: "学习", parentId: null, color: "#B3261E", order: 10 },
  { id: "work", name: "工作 / 项目", parentId: null, color: "#4F46E5", order: 20 },
  { id: "life", name: "生活", parentId: null, color: "#0F766E", order: 30 },
  { id: "other", name: "其他", parentId: null, color: "#6B7280", order: 40 },
];

export const DEFAULT_ZONES: Zone[] = [
  { id: "study", name: "学习", parentId: null, color: "#B3261E", order: 10 },
  { id: "study-major", name: "专业课", parentId: "study", color: "#B3261E", order: 11 },
  { id: "study-easy", name: "水课", parentId: "study", color: "#E07A5F", order: 12 },
  { id: "study-english", name: "英语四级", parentId: "study", color: "#C2410C", order: 13 },

  { id: "studio", name: "制作组", parentId: null, color: "#4F46E5", order: 20 },
  { id: "studio-code", name: "程序", parentId: "studio", color: "#312E81", order: 21 },
  { id: "studio-script", name: "剧本", parentId: "studio", color: "#4338CA", order: 22 },
  { id: "studio-art", name: "美术", parentId: "studio", color: "#6366F1", order: 23 },
  { id: "studio-music", name: "音乐", parentId: "studio", color: "#8B5CF6", order: 24 },
  { id: "studio-promo", name: "宣发", parentId: "studio", color: "#A78BFA", order: 25 },

  { id: "piano", name: "钢琴", parentId: null, color: "#15803D", order: 30 },
  { id: "piano-lesson", name: "钢琴课", parentId: "piano", color: "#15803D", order: 31 },
  { id: "piano-practice", name: "练琴", parentId: "piano", color: "#4ADE80", order: 32 },

  { id: "innovation", name: "大创", parentId: null, color: "#92400E", order: 40 },
  { id: "life", name: "生活", parentId: null, color: "#0F766E", order: 50 },
  { id: "other", name: "其他", parentId: null, color: "#6B7280", order: 60 },
];

const FALLBACK_ZONE: Zone = {
  id: "other",
  name: "其他",
  parentId: null,
  color: "#6B7280",
  order: 9999,
};

export function cloneZones(zones: Zone[] = DEFAULT_ZONES): Zone[] {
  return zones.map((zone) => ({ ...zone }));
}

function fallbackZone(zones: Zone[]): Zone {
  return (
    zones.find((zone) => zone.id === "other") ??
    zones.find((zone) => zone.parentId === null) ??
    zones[0] ??
    FALLBACK_ZONE
  );
}

export function getZone(zones: Zone[], id: string): Zone {
  return zones.find((zone) => zone.id === id) ?? fallbackZone(zones);
}

export function getChildren(zones: Zone[], id: string): Zone[] {
  return zones.filter((zone) => zone.parentId === id).sort((a, b) => a.order - b.order);
}

export function hasChildren(zones: Zone[], id: string): boolean {
  return zones.some((zone) => zone.parentId === id);
}

export function getTopZones(zones: Zone[]): Zone[] {
  return zones.filter((zone) => zone.parentId === null).sort((a, b) => a.order - b.order);
}

export function getTopZone(zones: Zone[], id: string): Zone {
  let zone = getZone(zones, id);
  const seen = new Set<string>();
  while (zone.parentId && !seen.has(zone.id)) {
    seen.add(zone.id);
    const parent = zones.find((item) => item.id === zone.parentId);
    if (!parent) break;
    zone = parent;
  }
  return zone;
}

export function getSelectableZones(zones: Zone[]): Zone[] {
  return zones
    .filter((zone) => !hasChildren(zones, zone.id))
    .sort((a, b) => {
      const topA = getTopZone(zones, a.id).order;
      const topB = getTopZone(zones, b.id).order;
      return topA - topB || a.order - b.order;
    });
}

export function defaultZoneForTop(zones: Zone[], topId: string): string {
  const children = getChildren(zones, topId);
  return children.length > 0 ? children[0].id : topId;
}

export function nextZoneOrder(zones: Zone[], parentId: string | null): number {
  const siblings = zones.filter((zone) => zone.parentId === parentId);
  return (siblings.length ? Math.max(...siblings.map((zone) => zone.order)) : 0) + 10;
}

export function nextTaskOrder(tasks: Task[], zones: Zone[], zoneId: string): number {
  const topId = getTopZone(zones, zoneId).id;
  const group = tasks.filter((task) => getTopZone(zones, task.zoneId).id === topId);
  return (group.length ? Math.max(...group.map((task) => task.order ?? 0)) : 0) + 10;
}

export function collectZoneIds(zones: Zone[], id: string): Set<string> {
  const ids = new Set<string>();
  const visit = (zoneId: string) => {
    if (ids.has(zoneId)) return;
    ids.add(zoneId);
    zones
      .filter((zone) => zone.parentId === zoneId)
      .forEach((child) => visit(child.id));
  };
  visit(id);
  return ids;
}

export function reorderTopZones(
  zones: Zone[],
  draggedId: string,
  targetId: string,
  before: boolean,
): Zone[] {
  const top = getTopZones(zones);
  const from = top.findIndex((zone) => zone.id === draggedId);
  const to = top.findIndex((zone) => zone.id === targetId);
  if (from < 0 || to < 0 || from === to) return zones;

  const next = [...top];
  const [item] = next.splice(from, 1);
  let insert = next.findIndex((zone) => zone.id === targetId);
  if (insert < 0) return zones;
  if (!before) insert += 1;
  next.splice(insert, 0, item);

  const order = new Map(next.map((zone, index) => [zone.id, (index + 1) * 10]));
  return zones.map((zone) =>
    order.has(zone.id) ? { ...zone, order: order.get(zone.id)! } : zone,
  );
}

export function reorderSiblings(
  zones: Zone[],
  draggedId: string,
  targetId: string,
  before: boolean,
): Zone[] {
  const dragged = zones.find((zone) => zone.id === draggedId);
  const target = zones.find((zone) => zone.id === targetId);
  if (!dragged || !target || !dragged.parentId || dragged.parentId !== target.parentId) {
    return zones;
  }

  const siblings = zones
    .filter((zone) => zone.parentId === dragged.parentId)
    .slice()
    .sort((a, b) => a.order - b.order);
  const from = siblings.findIndex((zone) => zone.id === draggedId);
  const to = siblings.findIndex((zone) => zone.id === targetId);
  if (from < 0 || to < 0 || from === to) return zones;

  const next = [...siblings];
  const [item] = next.splice(from, 1);
  let insert = next.findIndex((zone) => zone.id === targetId);
  if (insert < 0) return zones;
  if (!before) insert += 1;
  next.splice(insert, 0, item);

  const order = new Map(next.map((zone, index) => [zone.id, (index + 1) * 10]));
  return zones.map((zone) =>
    order.has(zone.id) ? { ...zone, order: order.get(zone.id)! } : zone,
  );
}

export function reorderTasks(
  tasks: Task[],
  zones: Zone[],
  draggedId: string,
  targetId: string,
  before: boolean,
): Task[] {
  const dragged = tasks.find((task) => task.id === draggedId);
  const target = tasks.find((task) => task.id === targetId);
  if (!dragged || !target || dragged.id === target.id) return tasks;

  const topId = getTopZone(zones, dragged.zoneId).id;
  if (getTopZone(zones, target.zoneId).id !== topId) return tasks;

  const group = tasks
    .filter((task) => getTopZone(zones, task.zoneId).id === topId)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  const from = group.findIndex((task) => task.id === dragged.id);
  const to = group.findIndex((task) => task.id === target.id);
  if (from < 0 || to < 0) return tasks;

  const next = [...group];
  const [item] = next.splice(from, 1);
  let insert = next.findIndex((task) => task.id === target.id);
  if (insert < 0) return tasks;
  if (!before) insert += 1;
  next.splice(insert, 0, item);

  const order = new Map(next.map((task, index) => [task.id, (index + 1) * 10]));
  return tasks.map((task) =>
    order.has(task.id) ? { ...task, order: order.get(task.id)! } : task,
  );
}

export function createSampleTasks(): Task[] {
  const monday = startOfMonday(new Date());
  const now = Date.now();
  let seq = 0;

  const t = (
    zoneId: string,
    title: string,
    day: number,
    part: number,
    endDay = day,
    endPart = part,
    note = "",
  ): Task => {
    seq += 1;
    const startDate = toISO(addDays(monday, day));
    const endDate = toISO(addDays(monday, endDay));
    return {
      id: `sample-${seq}`,
      zoneId,
      title,
      startDate,
      startPart: part as Task["startPart"],
      endDate,
      endPart: endPart as Task["endPart"],
      done: false,
      note,
      order: seq * 10,
      createdAt: now + seq,
      updatedAt: now + seq,
    };
  };

  return [
    t("study-major", "系统解剖学 · 内脏学", 0, 0, 0, 1, "课前 20 分钟预习；课后整理腹膜间隙图。"),
    t("study-easy", "医学伦理学", 0, 1),
    t("studio-art", "场景 AI 初稿筛选", 0, 2, 0, 2, "先按「可用 / 待修 / 废弃」三档过一遍。"),

    t("study-major", "局部解剖学实验", 1, 0),
    t("study-english", "四级阅读精练", 1, 1),
    t("studio-code", "ComfyUI 场景工作流调试", 1, 2, 2, 0, "先跑通场景 LoRA，再对比 3 组采样器。"),

    t("studio-art", "立绘差分检查", 2, 1),
    t("piano-practice", "练琴 · 肖邦夜曲", 2, 2, 2, 2, "重点：右手 rubato 与左手低音层次。"),

    t("study-english", "四级真题精练", 3, 0, 3, 1),
    t("studio-script", "《恋音》第三幕对白", 3, 2),

    t("study-major", "病理学导论", 4, 0),
    t("innovation", "大创 · 文献综述", 4, 1, 4, 2, "目标：拆成 3 个可写的段落，而不是继续堆文献。"),
    t("studio-music", "OP 编曲参考收集", 4, 1),

    t("study-english", "四级真题一套", 5, 0),
    t("piano-lesson", "钢琴课", 5, 1, 5, 1, "周四前把夜曲过一遍，课上直接处理难点。"),
    t("studio-art", "立绘差分验收", 5, 2, 6, 0),

    t("studio-script", "《前夜》角色日常线", 6, 0, 6, 1),
    t("life", "本周复盘 + 下周排期", 6, 2, 6, 2, "看三线占比：学习 / 制作组 / 钢琴，别让制作组吃掉全部空白。"),

    t("study-major", "药理学", 8, 0),
    t("studio-promo", "B站宣传物料排期", 8, 1),
    t("studio-code", "LoRA 训练参数对比", 8, 2),

    t("innovation", "大创 · 问卷设计讨论", 9, 1),
    t("piano-practice", "练琴 · 巴赫", 9, 2),

    t("study-major", "生理学", 10, 0),
    t("studio-art", "CG 构图草图", 10, 1, 10, 2),

    t("study-english", "四级听力精听", 11, 0),
    t("studio-music", "BGM 混音检查", 11, 1),
    t("studio-script", "《恋音》第四幕对白", 11, 2),

    t("life", "健身", 12, 2),
    t("studio-art", "场景最终手修", 13, 0, 13, 1),
    t("piano-practice", "练琴 · 复习课", 13, 2),
  ];
}
