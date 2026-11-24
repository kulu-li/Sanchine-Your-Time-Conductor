import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import Gantt from "./components/Gantt";
import TaskEditor from "./components/TaskEditor";
import ZoneManager from "./components/ZoneManager";
import ProjectEditor from "./components/ProjectEditor";
import CloudConflictDialog from "./components/CloudConflictDialog";
import InstallDialog from "./components/InstallDialog";
import AccountDialog from "./components/AccountDialog";
import type { AuthUser, AuthWorkspace } from "./auth/types";
import {
  Calendar,
  Cloud,
  ChevronLeft,
  ChevronRight,
  Download,
  MoreHorizontal,
  Pencil,
  Plus,
  Redo,
  Refresh,
  Trash,
  Undo,
  Upload,
} from "./components/Icons";
import {
  NEW_ZONES,
  cloneZones,
  collectZoneIds,
  createSampleTasks,
  getChildren,
  getSelectableZones,
  getTopZone,
  getTopZones,
  getZone,
  nextTaskOrder,
  nextZoneOrder,
  reorderSiblings,
  reorderTopZones,
} from "./data";
import {
  addDays,
  currentPart,
  diffDays,
  formatRange,
  keyToSlot,
  parseISO,
  slotKey,
  slotToDatePart,
  toISO,
  todayISO,
} from "./date";
import { CLOUD_STATUS_LABELS, formatSyncTime } from "./sync/cloudStatus";
import { useCloudSync } from "./sync/useCloudSync";
import { readStorage, removeStorage, writeStorage } from "./storage";
import { VIEW_DAYS, VIEW_LABELS } from "./types";
import type { Part, Task, TaskDraft, ViewMode, Zone } from "./types";

const TASKS_KEY = "laohei-gantt-v1-tasks";
const ZONES_KEY = "laohei-gantt-v1-zones";
const VIEW_KEY = "laohei-gantt-v1-view";
const HIDDEN_ZONES_KEY = "laohei-gantt-v1-hidden-zones";
const LAST_ZONE_KEY = "laohei-gantt-v1-last-zone";
const DRAG_EDIT_KEY = "laohei-gantt-v1-drag-edit";

interface Snapshot {
  tasks: Task[];
  zones: Zone[];
}

interface HistoryState {
  past: Snapshot[];
  present: Snapshot;
  future: Snapshot[];
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type HistoryAction =
  | { type: "commit"; next: Snapshot }
  | { type: "replace"; next: Snapshot }
  | { type: "undo" }
  | { type: "redo" };

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === "replace") {
    return { past: [], present: action.next, future: [] };
  }
  if (action.type === "commit") {
    return {
      past: [...state.past.slice(-39), state.present],
      present: action.next,
      future: [],
    };
  }
  if (action.type === "undo") {
    if (state.past.length === 0) return state;
    const previous = state.past[state.past.length - 1];
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, 40),
    };
  }
  if (state.future.length === 0) return state;
  return {
    past: [...state.past, state.present].slice(-40),
    present: state.future[0],
    future: state.future.slice(1),
  };
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPart(value: unknown): value is Part {
  return value === 0 || value === 1 || value === 2;
}

function isDateISO(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

function fallbackZoneId(zones: Zone[]): string {
  return (
    zones.find((zone) => zone.id === "other")?.id ??
    getSelectableZones(zones)[0]?.id ??
    getTopZones(zones)[0]?.id ??
    "other"
  );
}

function normalizeTask(value: unknown, zones: Zone[], index: number): Task | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  if (!isDateISO(raw.startDate) || !isDateISO(raw.endDate)) return null;
  if (
    Number.isNaN(parseISO(raw.startDate).getTime()) ||
    Number.isNaN(parseISO(raw.endDate).getTime())
  ) {
    return null;
  }
  const startPart = isPart(Number(raw.startPart)) ? (Number(raw.startPart) as Part) : 0;
  const endPart = isPart(Number(raw.endPart)) ? (Number(raw.endPart) as Part) : startPart;
  let endDate = raw.endDate;
  let safeEndPart = endPart;
  if (slotKey(endDate, endPart) < slotKey(raw.startDate, startPart)) {
    endDate = raw.startDate;
    safeEndPart = startPart;
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    zoneId: zones.some((zone) => zone.id === raw.zoneId)
      ? (raw.zoneId as string)
      : fallbackZoneId(zones),
    title,
    startDate: raw.startDate,
    startPart,
    endDate,
    endPart: safeEndPart,
    done: Boolean(raw.done),
    note: typeof raw.note === "string" ? raw.note : "",
    order:
      typeof raw.order === "number" && Number.isFinite(raw.order)
        ? raw.order
        : index * 10,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function normalizeZone(value: unknown, index: number): Zone | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id ? raw.id : null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;
  return {
    id,
    name,
    parentId:
      typeof raw.parentId === "string" && raw.parentId ? raw.parentId : null,
    color: isHexColor(raw.color) ? raw.color : "#6B7280",
    order:
      typeof raw.order === "number" && Number.isFinite(raw.order)
        ? raw.order
        : index * 10,
  };
}

function normalizeZones(value: unknown): Zone[] {
  if (!Array.isArray(value)) return cloneZones(NEW_ZONES);
  const seen = new Set<string>();
  const zones: Zone[] = [];
  value.forEach((item, index) => {
    const zone = normalizeZone(item, index);
    if (zone && !seen.has(zone.id)) {
      seen.add(zone.id);
      zones.push(zone);
    }
  });
  if (zones.length === 0) return cloneZones(NEW_ZONES);

  const ids = new Set(zones.map((zone) => zone.id));
  const fixed = zones.map((zone) =>
    zone.parentId && (!ids.has(zone.parentId) || zone.parentId === zone.id)
      ? { ...zone, parentId: null }
      : zone,
  );
  if (!fixed.some((zone) => zone.parentId === null)) {
    fixed[0] = { ...fixed[0], parentId: null };
  }
  return fixed;
}

function loadZones(): Zone[] {
  try {
    const raw = readStorage(ZONES_KEY);
    if (!raw) return cloneZones(NEW_ZONES);
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { zones?: unknown }).zones)
        ? (parsed as { zones: unknown[] }).zones
        : null;
    return list ? normalizeZones(list) : cloneZones(NEW_ZONES);
  } catch {
    return cloneZones(NEW_ZONES);
  }
}

function loadTasks(zones: Zone[]): Task[] | null {
  try {
    const raw = readStorage(TASKS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { tasks?: unknown }).tasks)
        ? (parsed as { tasks: unknown[] }).tasks
        : null;
    if (!list) return null;
    return list
      .map((item, index) => normalizeTask(item, zones, index))
      .filter((task): task is Task => task !== null);
  } catch {
    return null;
  }
}

function defaultView(): { mode: ViewMode; start: string } {
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  return {
    mode: mobile ? "week" : "fortnight",
    start: todayISO(),
  };
}

function loadView(): { mode: ViewMode; start: string } {
  try {
    const raw = readStorage(VIEW_KEY);
    if (!raw) return defaultView();
    const parsed = JSON.parse(raw) as { mode?: unknown; start?: unknown };
    if (
      (parsed.mode !== "week" && parsed.mode !== "fortnight" && parsed.mode !== "month") ||
      !isDateISO(parsed.start)
    ) {
      return defaultView();
    }
    return { mode: parsed.mode, start: parsed.start };
  } catch {
    return defaultView();
  }
}

function loadHiddenZones(): string[] {
  try {
    const raw = readStorage(HIDDEN_ZONES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function loadLastZone(zones: Zone[]): string {
  try {
    const raw = readStorage(LAST_ZONE_KEY);
    if (raw && zones.some((zone) => zone.id === raw)) return raw;
  } catch {
    // ignore
  }
  return fallbackZoneId(zones);
}

function loadDragEdit(): boolean {
  try {
    const raw = readStorage(DRAG_EDIT_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function createInitialHistory(): HistoryState {
  const zones = loadZones();
  const loaded = loadTasks(zones);
  return { past: [], present: { tasks: loaded ?? [], zones }, future: [] };
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    window.matchMedia("(max-width: 720px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const handle = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    query.addEventListener("change", handle);
    return () => query.removeEventListener("change", handle);
  }, []);
  return isMobile;
}

interface AppProps {
  user: AuthUser;
  workspace: AuthWorkspace;
  onLogout: () => void;
  onUserUpdated: (user: AuthUser) => void;
}

export default function App({ user, workspace, onLogout, onUserUpdated }: AppProps) {
  const [history, dispatch] = useReducer(historyReducer, undefined, createInitialHistory);
  const tasks = history.present.tasks;
  const zones = history.present.zones;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const initialView = useMemo(() => loadView(), []);
  const [viewMode, setViewMode] = useState<ViewMode>(initialView.mode);
  const [viewStart, setViewStart] = useState<string>(initialView.start);
  const [scrollTick, setScrollTick] = useState(0);
  const [hiddenZones, setHiddenZones] = useState<Set<string>>(
    () => new Set(loadHiddenZones()),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    mode: "create" | "edit";
    draft: TaskDraft;
  } | null>(null);
  const [lastZone, setLastZone] = useState<string>(() => loadLastZone(zones));
  const [dragEdit, setDragEdit] = useState<boolean>(() => loadDragEdit());
  const [sortMode, setSortMode] = useState(false);
  const [zoneManagerOpen, setZoneManagerOpen] = useState(false);
  const [projectEditor, setProjectEditor] = useState<{ parentId: string } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);

  const isMobile = useIsMobile();
  const viewDays = VIEW_DAYS[viewMode];
  const slotW = isMobile ? 30 : 44;
  const leftW = isMobile ? 110 : 212;
  const headerH = isMobile ? 48 : 54;
  const taskH = isMobile ? 40 : 44;

  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const projectCount = useMemo(() => {
    let count = 0;
    for (const top of getTopZones(zones)) {
      const children = getChildren(zones, top.id);
      if (children.length === 0) {
        count += 1;
      } else {
        count += children.length;
        if (tasks.some((task) => task.zoneId === top.id)) count += 1;
      }
    }
    return count;
  }, [zones, tasks]);

  const showToast = useCallback(
    (message: string, actionLabel?: string, onAction?: () => void) => {
      setToast({ id: Date.now(), message, actionLabel, onAction });
    },
    [],
  );

  const commit = useCallback(
    (nextTasks: Task[], nextZones: Zone[] = zones) => {
      dispatch({ type: "commit", next: { tasks: nextTasks, zones: nextZones } });
    },
    [zones],
  );

  const applyRemote = useCallback(
    (snapshot: { tasks: Task[]; zones: Zone[] }) => {
      const nextZones = normalizeZones(snapshot.zones);
      const nextTasks = snapshot.tasks
        .map((task, index) => normalizeTask(task, nextZones, index))
        .filter((task): task is Task => task !== null);
      dispatch({ type: "replace", next: { tasks: nextTasks, zones: nextZones } });
    },
    [],
  );

  const cloud = useCloudSync({ tasks, zones, onRemote: applyRemote });

  const rememberZone = useCallback((zoneId: string) => {
    setLastZone(zoneId);
    try {
      writeStorage(LAST_ZONE_KEY, zoneId);
    } catch {
      // ignore
    }
  }, []);

  const expandZoneFor = useCallback(
    (zoneId: string) => {
      const topId = getTopZone(zones, zoneId).id;
      setHiddenZones((previous) => {
        if (!previous.has(topId)) return previous;
        const next = new Set(previous);
        next.delete(topId);
        return next;
      });
    },
    [zones],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        writeStorage(TASKS_KEY, JSON.stringify({ version: 2, tasks }));
      } catch {
        // ignore
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [tasks]);

  useEffect(() => {
    try {
      writeStorage(ZONES_KEY, JSON.stringify({ version: 2, zones }));
    } catch {
      // ignore
    }
  }, [zones]);

  useEffect(() => {
    try {
      writeStorage(VIEW_KEY, JSON.stringify({ mode: viewMode, start: viewStart }));
    } catch {
      // ignore
    }
  }, [viewMode, viewStart]);

  useEffect(() => {
    try {
      writeStorage(HIDDEN_ZONES_KEY, JSON.stringify([...hiddenZones]));
    } catch {
      // ignore
    }
  }, [hiddenZones]);

  useEffect(() => {
    try {
      writeStorage(DRAG_EDIT_KEY, dragEdit ? "1" : "0");
    } catch {
      // ignore
    }
  }, [dragEdit]);

  useEffect(() => {
    const ids = new Set(zones.map((zone) => zone.id));
    setHiddenZones((previous) => {
      let changed = false;
      const next = new Set<string>();
      previous.forEach((id) => {
        if (ids.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : previous;
    });
  }, [zones]);

  useEffect(() => {
    if (!zones.some((zone) => zone.id === lastZone)) {
      rememberZone(fallbackZoneId(zones));
    }
  }, [zones, lastZone, rememberZone]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast?.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const handle = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handle);
    return () => document.removeEventListener("pointerdown", handle);
  }, [menuOpen]);

  useEffect(() => {
    const handlePrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => setInstallEvent(null);
    window.addEventListener("beforeinstallprompt", handlePrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handlePrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);


  const handleInstall = async () => {
    if (installEvent) {
      await installEvent.prompt();
      try {
        await installEvent.userChoice;
      } catch {
        // ignore
      }
      setInstallEvent(null);
      setInstallOpen(false);
      return;
    }
    setInstallOpen(true);
  };

  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  const toggleZone = useCallback((zoneId: string) => {
    setHiddenZones((previous) => {
      const next = new Set(previous);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

  const changeMode = (mode: ViewMode) => {
    if (mode === viewMode) return;
    setViewMode(mode);
  };

  const shiftView = (direction: number) => {
    setViewStart((previous) => toISO(addDays(parseISO(previous), direction * viewDays)));
  };

  const goToday = () => {
    setViewStart(todayISO());
    setScrollTick((tick) => tick + 1);
  };

  const chooseViewStart = (value: string) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    setViewStart(value);
    setScrollTick((tick) => tick + 1);
  };

  const toggleDragEdit = () => {
    const next = !dragEdit;
    setDragEdit(next);
    showToast(
      next
        ? "新建任务时会弹出详情"
        : "新建任务时直接使用左栏名称",
    );
  };

  const openCreate = useCallback(
    (zoneId?: string, range?: { start: number; end: number }) => {
      const validZone = (id?: string) =>
        id && zones.some((zone) => zone.id === id) ? id : null;
      const rawZone =
        validZone(zoneId) ??
        validZone(lastZone) ??
        fallbackZoneId(zones);
      const childZones = getChildren(zones, rawZone);
      const zone = childZones.length > 0 ? childZones[0].id : rawZone;
      let startDate = todayISO();
      let startPart = currentPart();
      let endDate = startDate;
      let endPart = startPart;
      if (range) {
        const start = slotToDatePart(viewStart, range.start);
        const end = slotToDatePart(viewStart, range.end);
        startDate = start.date;
        startPart = start.part;
        endDate = end.date;
        endPart = end.part;
      }
      expandZoneFor(zone);
      setSelectedId(null);
      setEditor({
        mode: "create",
        draft: {
          zoneId: zone,
          title: "",
          startDate,
          startPart,
          endDate,
          endPart,
          note: "",
          done: false,
        },
      });
    },
    [expandZoneFor, lastZone, viewStart, zones],
  );

  const openProjectEditor = useCallback(
    (parentId?: string) => {
      const tops = getTopZones(zones).filter((zone) => zone.id !== "other");
      const fallbackTop = getTopZone(zones, lastZone).id;
      const parent =
        (parentId && tops.some((zone) => zone.id === parentId) ? parentId : null) ??
        tops.find((zone) => zone.id === fallbackTop)?.id ??
        tops[0]?.id;
      if (!parent) {
        showToast("先创建一个分区，再新建项目");
        return;
      }
      setProjectEditor({ parentId: parent });
    },
    [lastZone, showToast, zones],
  );

  const openCreateAt = useCallback(
    (
      zoneId: string,
      startSlot: number,
      endSlot: number,
      options: { wasDrag: boolean; quickTitle: string },
    ) => {
      if (!dragEdit && (options.wasDrag || isMobile)) {
        const start = slotToDatePart(viewStart, startSlot);
        const end = slotToDatePart(viewStart, endSlot);
        const childZones = getChildren(zones, zoneId);
        const projectZoneId = childZones.length > 0 ? childZones[0].id : zoneId;
        const base = (options.quickTitle.trim() || getZone(zones, zoneId).name).slice(0, 80);
        const existing = new Set(
          tasks.filter((task) => task.zoneId === projectZoneId).map((task) => task.title),
        );
        let title = base;
        if (existing.has(title)) {
          let index = 2;
          while (existing.has(`${base} ${index}`)) index += 1;
          title = `${base} ${index}`.slice(0, 80);
        }
        const now = Date.now();
        const task: Task = {
          id: newId(),
          zoneId: projectZoneId,
          title,
          startDate: start.date,
          startPart: start.part,
          endDate: end.date,
          endPart: end.part,
          done: false,
          note: "",
          order: nextTaskOrder(tasks, zones, projectZoneId),
          createdAt: now,
          updatedAt: now,
        };
        commit([...tasks, task]);
        expandZoneFor(projectZoneId);
        setSelectedId(task.id);
        showToast(`已添加子任务「${title}」`, "撤销", () => dispatch({ type: "undo" }));
        return;
      }
      openCreate(zoneId, { start: startSlot, end: endSlot });
    },
    [commit, dragEdit, expandZoneFor, isMobile, openCreate, showToast, tasks, viewStart, zones],
  );

  const openEdit = useCallback(
    (taskId: string) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return;
      setSelectedId(task.id);
      setEditor({
        mode: "edit",
        draft: {
          id: task.id,
          zoneId: task.zoneId,
          title: task.title,
          startDate: task.startDate,
          startPart: task.startPart,
          endDate: task.endDate,
          endPart: task.endPart,
          note: task.note,
          done: task.done,
        },
      });
    },
    [tasks],
  );

  const saveEditor = useCallback(() => {
    if (!editor) return;
    const title = editor.draft.title.trim();
    if (!title) return;
    const zoneId = zones.some((zone) => zone.id === editor.draft.zoneId)
      ? editor.draft.zoneId
      : fallbackZoneId(zones);
    const startKey = slotKey(editor.draft.startDate, editor.draft.startPart);
    let endDate = editor.draft.endDate;
    let endPart = editor.draft.endPart;
    if (slotKey(endDate, endPart) < startKey) {
      endDate = editor.draft.startDate;
      endPart = editor.draft.startPart;
    }
    const now = Date.now();

    if (editor.mode === "create") {
      const task: Task = {
        id: newId(),
        zoneId,
        title,
        startDate: editor.draft.startDate,
        startPart: editor.draft.startPart,
        endDate,
        endPart,
        done: false,
        note: editor.draft.note,
        order: nextTaskOrder(tasks, zones, zoneId),
        createdAt: now,
        updatedAt: now,
      };
      commit([...tasks, task]);
      setSelectedId(task.id);
      showToast("已添加");
    } else if (editor.draft.id) {
      const id = editor.draft.id;
      const original = tasks.find((task) => task.id === id);
      const sameTop =
        original &&
        getTopZone(zones, original.zoneId).id === getTopZone(zones, zoneId).id;
      const nextOrder =
        original && sameTop ? original.order : nextTaskOrder(tasks, zones, zoneId);
      const next = tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              zoneId,
              title,
              startDate: editor.draft.startDate,
              startPart: editor.draft.startPart,
              endDate,
              endPart,
              done: editor.draft.done,
              note: editor.draft.note,
              order: nextOrder,
              updatedAt: now,
            }
          : task,
      );
      commit(next);
      setSelectedId(id);
      showToast("已保存");
    }

    rememberZone(zoneId);
    expandZoneFor(zoneId);
    setEditor(null);
  }, [commit, editor, expandZoneFor, rememberZone, showToast, tasks, zones]);

  const deleteTask = useCallback(
    (taskId: string) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return;
      commit(tasks.filter((item) => item.id !== taskId));
      setEditor(null);
      setSelectedId(null);
      showToast(`已删除「${task.title}」`, "撤销", () => dispatch({ type: "undo" }));
    },
    [commit, showToast, tasks],
  );

  const toggleDone = useCallback(
    (taskId: string) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return;
      commit(
        tasks.map((item) =>
          item.id === taskId
            ? { ...item, done: !item.done, updatedAt: Date.now() }
            : item,
        ),
      );
      showToast(task.done ? `已取消完成「${task.title}」` : `已完成「${task.title}」`);
    },
    [commit, showToast, tasks],
  );

  const changeTime = useCallback(
    (taskId: string, startSlot: number, endSlot: number) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return;
      const start = slotToDatePart(viewStart, startSlot);
      const end = slotToDatePart(viewStart, endSlot);
      if (
        task.startDate === start.date &&
        task.startPart === start.part &&
        task.endDate === end.date &&
        task.endPart === end.part
      ) {
        return;
      }
      commit(
        tasks.map((item) =>
          item.id === taskId
            ? {
                ...item,
                startDate: start.date,
                startPart: start.part,
                endDate: end.date,
                endPart: end.part,
                updatedAt: Date.now(),
              }
            : item,
        ),
      );
    },
    [commit, tasks, viewStart],
  );

  const addZone = useCallback(
    (input: { name: string; parentId: string | null; color: string }): string | null => {
      const name = input.name.trim();
      if (!name) return "名称不能为空";
      if (name.length > 16) return "名称最多 16 个字";
      const parentId =
        input.parentId && zones.some((zone) => zone.id === input.parentId)
          ? input.parentId
          : null;
      const siblings = zones.filter((zone) => zone.parentId === parentId);
      const kind = parentId ? "项目" : "分区";
      if (siblings.some((zone) => zone.name === name)) return `同级已有同名${kind}`;
      if (parentId === "other") return "「其他」是兜底分区，不能再加子项目";
      const zone: Zone = {
        id: `zone-${newId()}`,
        name,
        parentId,
        color: isHexColor(input.color) ? input.color : "#6B7280",
        order: nextZoneOrder(zones, parentId),
      };
      commit(tasks, [...zones, zone]);
      if (parentId) {
        setHiddenZones((previous) => {
          if (!previous.has(parentId)) return previous;
          const next = new Set(previous);
          next.delete(parentId);
          return next;
        });
      }
      rememberZone(zone.id);
      showToast(`已添加${kind}「${name}」`);
      return null;
    },
    [commit, rememberZone, showToast, tasks, zones],
  );

  const deleteZone = useCallback(
    (zoneId: string) => {
      const zone = zones.find((item) => item.id === zoneId);
      if (!zone) return;
      if (zone.id === "other") {
        showToast("「其他」是兜底项目，不能删除");
        return;
      }
      if (!zone.parentId && getTopZones(zones).length <= 1) {
        showToast("至少保留一个顶级分区");
        return;
      }
      const ids = collectZoneIds(zones, zoneId);
      const affected = tasks.filter((task) => ids.has(task.zoneId));
      const isGroup = getChildren(zones, zone.id).length > 0;
      const label = isGroup ? `分区「${zone.name}」` : `项目「${zone.name}」`;
      const childCount = ids.size - 1;
      const details: string[] = [];
      if (childCount > 0) details.push(`其下 ${childCount} 个子项目也会删除`);
      if (affected.length > 0) details.push(`${affected.length} 个子任务会一起删除`);
      const detail = details.length ? `\n${details.join("；")}。` : "";
      if (!window.confirm(`删除${label}？${detail}`)) return;

      const nextZones = zones.filter((item) => !ids.has(item.id));
      const nextTasks = tasks.filter((task) => !ids.has(task.zoneId));
      commit(nextTasks, nextZones);
      setHiddenZones((previous) => {
        const next = new Set(previous);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      const fallback = fallbackZoneId(nextZones);
      if (ids.has(lastZone)) rememberZone(fallback);
      showToast(`已删除${label}，${affected.length} 个子任务已删除`, "撤销", () =>
        dispatch({ type: "undo" }),
      );
    },
    [commit, lastZone, rememberZone, showToast, tasks, zones],
  );

  const renameZone = useCallback(
    (zoneId: string, rawName: string): string | null => {
      const zone = zones.find((item) => item.id === zoneId);
      if (!zone) return "项目不存在";
      const name = rawName.trim();
      if (!name) {
        showToast("名称不能为空");
        return "名称不能为空";
      }
      if (name.length > 16) {
        showToast("名称最多 16 个字");
        return "名称最多 16 个字";
      }
      const siblings = zones.filter(
        (item) => item.parentId === zone.parentId && item.id !== zone.id,
      );
      if (siblings.some((item) => item.name === name)) {
        showToast("同级已有同名");
        return "同级已有同名";
      }
      if (name === zone.name) return null;
      commit(
        tasks,
        zones.map((item) => (item.id === zone.id ? { ...item, name } : item)),
      );
      showToast(`已改名为「${name}」`);
      return null;
    },
    [commit, showToast, tasks, zones],
  );

  const reorderAny = useCallback(
    (draggedId: string, targetId: string, before: boolean) => {
      const dragged = zones.find((zone) => zone.id === draggedId);
      const target = zones.find((zone) => zone.id === targetId);
      if (!dragged || !target) return;

      let next: Zone[];
      if (!dragged.parentId && !target.parentId) {
        next = reorderTopZones(zones, draggedId, targetId, before);
      } else if (dragged.parentId && dragged.parentId === target.parentId) {
        next = reorderSiblings(zones, draggedId, targetId, before);
      } else {
        return;
      }
      if (next !== zones) commit(tasks, next);
    },
    [commit, tasks, zones],
  );

  const exportJson = useCallback(() => {
    const payload = {
      version: 2,
      app: "laohei-gantt",
      exportedAt: new Date().toISOString(),
      tasks,
      zones,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `laohei-gantt-${todayISO()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMenuOpen(false);
    showToast("已导出 JSON");
  }, [showToast, tasks, zones]);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      let importedZones = zones;
      let list: unknown[] | null = null;
      if (Array.isArray(parsed)) {
        list = parsed;
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as { tasks?: unknown; zones?: unknown };
        if (Array.isArray(obj.zones)) importedZones = normalizeZones(obj.zones);
        if (Array.isArray(obj.tasks)) list = obj.tasks;
      }
      if (!list) throw new Error("bad file");
      const normalized = list
        .map((item, index) => normalizeTask(item, importedZones, index))
        .filter((task): task is Task => task !== null);
      commit(normalized, importedZones);
      setEditor(null);
      setSelectedId(null);
      setMenuOpen(false);
      showToast(`已导入 ${normalized.length} 个任务`);
    } catch {
      showToast("文件格式不对");
    }
  };

  const resetSample = () => {
    if (!window.confirm("用示例数据覆盖当前任务？分区不会重置。")) return;
    const seeded = createSampleTasks()
      .map((task, index) => normalizeTask(task, zones, index))
      .filter((task): task is Task => task !== null);
    commit(seeded, zones);
    setEditor(null);
    setSelectedId(null);
    setMenuOpen(false);
    showToast("已恢复示例数据");
  };

  const clearAll = () => {
    if (!window.confirm("清空全部任务？这个操作可以用 ⌘Z 撤销。")) return;
    commit([], zones);
    setEditor(null);
    setSelectedId(null);
    setMenuOpen(false);
    showToast("已清空");
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target?.matches("input, textarea, select, [contenteditable='true']"),
      );
      const command = event.metaKey || event.ctrlKey;

      if (command && event.key.toLowerCase() === "z") {
        if (editor || zoneManagerOpen || projectEditor || typing) return;
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }

      if (event.key === "Escape") {
        if (editor) {
          setEditor(null);
          return;
        }
        if (projectEditor) {
          setProjectEditor(null);
          return;
        }
        if (zoneManagerOpen) {
          setZoneManagerOpen(false);
          return;
        }
        if (menuOpen) {
          setMenuOpen(false);
          return;
        }
        setSelectedId(null);
        return;
      }

      if (editor || zoneManagerOpen || projectEditor || typing || !selectedId) return;
      const task = tasks.find((item) => item.id === selectedId);
      if (!task) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteTask(selectedId);
        return;
      }

      const step =
        event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowUp"
              ? -3
              : event.key === "ArrowDown"
                ? 3
                : 0;
      if (!step) return;
      event.preventDefault();

      const start = slotKey(task.startDate, task.startPart);
      const end = slotKey(task.endDate, task.endPart);
      if (event.shiftKey) {
        const newEnd = Math.max(start, end + step);
        const nextEnd = keyToSlot(newEnd);
        commit(
          tasks.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  endDate: nextEnd.date,
                  endPart: nextEnd.part,
                  updatedAt: Date.now(),
                }
              : item,
          ),
        );
      } else {
        const nextStart = keyToSlot(start + step);
        const nextEnd = keyToSlot(end + step);
        commit(
          tasks.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  startDate: nextStart.date,
                  startPart: nextStart.part,
                  endDate: nextEnd.date,
                  endPart: nextEnd.part,
                  updatedAt: Date.now(),
                }
              : item,
          ),
        );
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    commit,
    deleteTask,
    editor,
    menuOpen,
    projectEditor,
    redo,
    selectedId,
    tasks,
    undo,
    zoneManagerOpen,
  ]);

  const legendZones = useMemo(() => getTopZones(zones), [zones]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="brand-text">
            <strong>三线</strong>
            <small>时间网格 · v1</small>
          </div>
        </div>

        <div className="range">
          <button className="icon-btn range-arrow" onClick={() => shiftView(-1)} aria-label="上一段">
            <ChevronLeft size={14} />
          </button>
          <div className="range-center">
            <input
              type="date"
              className="range-date"
              value={viewStart}
              onChange={(event) => chooseViewStart(event.target.value)}
              aria-label="选择时间范围的起始日期"
              title="选择任意一天作为起始日期"
            />
            <span className="range-span">{formatRange(viewStart, viewDays)}</span>
          </div>
          <button className="icon-btn range-arrow" onClick={() => shiftView(1)} aria-label="下一段">
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="topbar-spacer" />

        <div className="view-switch" role="group" aria-label="时间范围">
          {(["week", "fortnight", "month"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              className={viewMode === mode ? "active" : ""}
              onClick={() => changeMode(mode)}
            >
              {VIEW_LABELS[mode]}
            </button>
          ))}
        </div>

        <button
          className={`drag-edit-toggle ${dragEdit ? "is-on" : ""}`}
          onClick={toggleDragEdit}
          title={
            dragEdit
              ? "拖拽新建后会弹出详情；点击关闭"
              : "拖拽新建会直接生成与左栏同名的任务；点击开启详情"
          }
          aria-pressed={dragEdit}
          aria-label={dragEdit ? "关闭拖拽填写" : "开启拖拽填写"}
        >
          <Pencil size={14} className="drag-edit-icon" />
          <span className={`mini-switch ${dragEdit ? "on" : ""}`}>
            <span />
          </span>
          <span className="drag-edit-label">拖拽填写</span>
        </button>

        <div className="topbar-actions">
          <button
            className="icon-btn undo-btn"
            onClick={undo}
            disabled={!canUndo}
            title="撤销 ⌘Z"
            aria-label="撤销"
          >
            <Undo size={15} />
          </button>
          <button
            className="icon-btn redo-btn"
            onClick={redo}
            disabled={!canRedo}
            title="重做 ⇧⌘Z"
            aria-label="重做"
          >
            <Redo size={15} />
          </button>
          <button className="icon-btn today-btn" onClick={goToday} title="回到今天">
            <Calendar size={14} />
            <span>今天</span>
          </button>
          <button
            className="add-btn"
            onClick={() => openProjectEditor()}
            title="新建项目"
            aria-label="新建项目"
          >
            <Plus size={14} />
            <span>新建项目</span>
          </button>
          <div className="menu-wrap" ref={menuRef}>
            <button
              className="icon-btn"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="更多"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={17} />
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setAccountOpen(true);
                  }}
                  role="menuitem"
                >
                  <Cloud size={14} /> 账户与同步 · {CLOUD_STATUS_LABELS[cloud.status]}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    void handleInstall();
                  }}
                  role="menuitem"
                >
                  <Download size={14} /> 安装到桌面
                </button>
                <div className="menu-sep" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    goToday();
                  }}
                  role="menuitem"
                >
                  <Calendar size={14} /> 回到今天
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setZoneManagerOpen(true);
                  }}
                  role="menuitem"
                >
                  <Plus size={14} /> 分区管理
                </button>
                <div className="menu-sep" />
                <button onClick={exportJson} role="menuitem">
                  <Download size={14} /> 导出 JSON
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    fileRef.current?.click();
                  }}
                  role="menuitem"
                >
                  <Upload size={14} /> 导入 JSON
                </button>
                <div className="menu-sep" />
                <button onClick={resetSample} role="menuitem">
                  <Refresh size={14} /> 恢复示例数据
                </button>
                <button className="danger" onClick={clearAll} role="menuitem">
                  <Trash size={14} /> 清空全部任务
                </button>
                <div className="menu-sep" />
                <div className="menu-note">
                  v1 · 本地优先，可接云端
                  <br />
                  {isMobile
                    ? "长按条形拖动 · 点其他位置退出"
                    : "拖动条形调整时间 · 双击完成"}
                  <br />
                  ⌘Z 撤销 · 方向键移动 · Shift+滚轮横向滚动
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="legend">
        <span className="legend-label">分区</span>
        {legendZones.map((zone) => {
          const children = getChildren(zones, zone.id);
          const background = children.length
            ? `linear-gradient(135deg, ${children.map((child) => child.color).join(", ")})`
            : zone.color;
          return (
            <button
              key={zone.id}
              className={`legend-item ${hiddenZones.has(zone.id) ? "is-off" : ""}`}
              onClick={() => toggleZone(zone.id)}
              title={hiddenZones.has(zone.id) ? "点击显示这个分区" : "点击隐藏这个分区"}
            >
              <span className="legend-dot" style={{ background }} />
              <span>{zone.name}</span>
            </button>
          );
        })}
        <button
          className="legend-add"
          onClick={() => setZoneManagerOpen(true)}
          title="添加或删除分区"
        >
          <Plus size={11} /> 分区
        </button>
      </div>

      <main className="gantt-shell">
        <Gantt
          tasks={tasks}
          zones={zones}
          viewStart={viewStart}
          viewDays={viewDays}
          slotW={slotW}
          leftW={leftW}
          headerH={headerH}
          taskH={taskH}
          isMobile={isMobile}
          hidden={hiddenZones}
          selectedId={selectedId}
          scrollTick={scrollTick}
          sortMode={sortMode}
          onToggleSortMode={() => setSortMode((value) => !value)}
          onToggleZone={toggleZone}
          onRenameZone={renameZone}
          onSelectTask={setSelectedId}
          onOpenTask={openEdit}
          onCreateRange={openCreateAt}
          onChangeTime={changeTime}
          onToggleDone={toggleDone}
          onAddProject={openProjectEditor}
          onDeleteProject={deleteZone}
          onReorder={reorderAny}
        />
      </main>

      <footer className="statusbar">
        <button
          className={`status-left status-${cloud.status}`}
          onClick={() => setAccountOpen(true)}
          title="账户与同步"
        >
          <span className="status-dot" />
          <span>
            {CLOUD_STATUS_LABELS[cloud.status]}
            {cloud.status === "synced" && cloud.lastSyncedAt
              ? ` · ${formatSyncTime(cloud.lastSyncedAt)}`
              : ""}
          </span>
        </button>
        <div className="status-right">
          {tasks.length} 个子任务 · {projectCount} 个项目 ·{" "}
          {isMobile ? "双击条形完成" : "双击条形完成 · 拖拽排期"} · ⌘Z 撤销
        </div>
      </footer>

      {editor && (
        <TaskEditor
          mode={editor.mode}
          draft={editor.draft}
          zones={zones}
          isMobile={isMobile}
          onChange={(draft) => setEditor({ ...editor, draft })}
          onSave={saveEditor}
          onCancel={() => setEditor(null)}
          onDelete={
            editor.mode === "edit" && editor.draft.id
              ? () => deleteTask(editor.draft.id as string)
              : undefined
          }
        />
      )}

      {zoneManagerOpen && (
        <ZoneManager
          zones={zones}
          tasks={tasks}
          isMobile={isMobile}
          onClose={() => setZoneManagerOpen(false)}
          onAdd={addZone}
          onDelete={deleteZone}
        />
      )}

      {projectEditor && (
        <ProjectEditor
          zones={zones}
          defaultParentId={projectEditor.parentId}
          isMobile={isMobile}
          onClose={() => setProjectEditor(null)}
          onAdd={addZone}
        />
      )}

      {accountOpen && (
        <AccountDialog
          user={user}
          workspace={workspace}
          cloud={{
            status: cloud.status,
            lastSyncedAt: cloud.lastSyncedAt,
            error: cloud.error,
            syncNow: cloud.syncNow,
          }}
          onClose={() => setAccountOpen(false)}
          onLogout={onLogout}
          onUserUpdated={onUserUpdated}
        />
      )}

      {cloud.conflict && (
        <CloudConflictDialog
          remote={cloud.conflict}
          onUseRemote={() => cloud.resolveConflict("remote")}
          onUseLocal={() => cloud.resolveConflict("local")}
        />
      )}

      {installOpen && (
        <InstallDialog
          canPrompt={Boolean(installEvent)}
          onClose={() => setInstallOpen(false)}
          onPrompt={handleInstall}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.actionLabel && (
            <button
              onClick={() => {
                toast.onAction?.();
                setToast(null);
              }}
            >
              {toast.actionLabel}
            </button>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={handleFile}
      />
    </div>
  );
}
