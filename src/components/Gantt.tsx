import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  addDays,
  clamp,
  diffDays,
  formatMD,
  formatSlotLabel,
  hexToRgba,
  isWeekend,
  parseISO,
  slotToDatePart,
  taskEndSlot,
  taskStartSlot,
  todayISO,
  weekdayCN,
} from "../date";
import { getChildren, getTopZone, getTopZones, getZone } from "../data";
import { PART_LABELS } from "../types";
import type { Task, Zone } from "../types";
import { Grip, Plus, Trash } from "./Icons";

interface GanttProps {
  tasks: Task[];
  zones: Zone[];
  viewStart: string;
  viewDays: number;
  slotW: number;
  leftW: number;
  headerH: number;
  taskH: number;
  isMobile: boolean;
  hidden: Set<string>;
  selectedId: string | null;
  scrollTick: number;
  sortMode: boolean;
  onToggleSortMode: () => void;
  onToggleZone: (zoneId: string) => void;
  onSelectTask: (taskId: string | null) => void;
  onOpenTask: (taskId: string) => void;
  onCreateRange: (
    zoneId: string,
    startSlot: number,
    endSlot: number,
    options: { wasDrag: boolean; quickTitle: string },
  ) => void;
  onChangeTime: (taskId: string, startSlot: number, endSlot: number) => void;
  onToggleDone: (taskId: string) => void;
  onAddProject: (topZoneId?: string) => void;
  onDeleteProject: (zoneId: string) => void;
  onRenameZone: (zoneId: string, name: string) => string | null;
  onReorder: (draggedId: string, targetId: string, before: boolean) => void;
}

interface TaskBar {
  task: Task;
  start: number;
  end: number;
  lane: number;
}

interface ProjectRow {
  type: "project";
  key: string;
  zone: Zone;
  zoneId: string;
  top: Zone;
  label: string;
  direct: boolean;
  canDelete: boolean;
  reorderGroup: string | null;
  tasks: TaskBar[];
  taskCount: number;
  laneCount: number;
}

type Row = ProjectRow;

type DragKind = "create" | "move" | "resize-start" | "resize-end";

interface DragState {
  kind: DragKind;
  pointerId: number;
  originSlot: number;
  currentSlot: number;
  originStart: number;
  originEnd: number;
  previewStart: number;
  previewEnd: number;
  active: boolean;
  armed?: boolean;
  edgeOffset: number;
  zoneId: string;
  quickTitle: string;
  taskId?: string;
  originRowId?: string;
  startClientX: number;
  startClientY: number;
  pointerX: number;
  pointerY: number;
  track: HTMLElement;
  capture: HTMLElement;
}

interface LongPressCandidate {
  pointerId: number;
  taskId: string;
  task: Task;
  startX: number;
  startY: number;
  timer: number;
  capture: HTMLElement;
  track: HTMLElement;
  originSlot: number;
  originStart: number;
  originEnd: number;
}

interface ReorderState {
  id: string;
  group: string;
  pointerId: number;
  capture: HTMLElement;
  targetId: string | null;
  before: boolean;
}

function slotFromClientX(
  clientX: number,
  track: HTMLElement,
  slotW: number,
  totalSlots: number,
): number {
  const rect = track.getBoundingClientRect();
  return clamp(Math.floor((clientX - rect.left) / slotW), 0, totalSlots - 1);
}

function packProjectTasks(
  tasks: Task[],
  viewStart: string,
  viewDays: number,
): { bars: TaskBar[]; laneCount: number } {
  const totalSlots = viewDays * 3;
  const sorted = tasks
    .map((task) => ({
      task,
      start: taskStartSlot(viewStart, task),
      end: taskEndSlot(viewStart, task),
    }))
    .filter(({ start, end }) => start < totalSlots && end >= 0)
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.end - b.end ||
        a.task.createdAt - b.task.createdAt,
    );

  const laneEnds: number[] = [];
  const bars = sorted.map(({ task, start, end }) => {
    let lane = laneEnds.findIndex((lastEnd) => lastEnd < start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    return { task, start, end, lane };
  });

  return { bars, laneCount: Math.max(1, laneEnds.length) };
}

export default function Gantt(props: GanttProps) {
  const {
    tasks,
    zones,
    viewStart,
    viewDays,
    slotW,
    leftW,
    headerH,
    taskH,
    isMobile,
    hidden,
    selectedId,
    scrollTick,
    sortMode,
    onToggleSortMode,
    onToggleZone,
    onSelectTask,
    onOpenTask,
    onCreateRange,
    onChangeTime,
    onToggleDone,
    onAddProject,
    onDeleteProject,
    onRenameZone,
    onReorder,
  } = props;

  const totalSlots = viewDays * 3;
  const dayWidth = slotW * 3;
  const totalWidth = totalSlots * slotW;
  const railW = isMobile ? 22 : 30;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameKind, setRenameKind] = useState<"project" | "zone">("project");
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [armedTaskId, setArmedTaskId] = useState<string | null>(null);
  const armedTaskIdRef = useRef<string | null>(null);
  const longPressRef = useRef<LongPressCandidate | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [reorder, setReorder] = useState<ReorderState | null>(null);
  const reorderRef = useRef<ReorderState | null>(null);
  const barClickRef = useRef<{
    taskId: string;
    time: number;
    timer: number;
  } | null>(null);

  const clearBarClick = () => {
    if (barClickRef.current) {
      window.clearTimeout(barClickRef.current.timer);
      barClickRef.current = null;
    }
  };

  const activateBar = (taskId: string) => {
    const now = Date.now();
    const last = barClickRef.current;
    // A second click/tap within 500 ms means "toggle done" instead of "edit".
    if (last && last.taskId === taskId && now - last.time < 500) {
      window.clearTimeout(last.timer);
      barClickRef.current = null;
      onToggleDone(taskId);
      return;
    }
    if (last) window.clearTimeout(last.timer);
    const timer = window.setTimeout(() => {
      barClickRef.current = null;
      onOpenTask(taskId);
    }, 300);
    barClickRef.current = { taskId, time: now, timer };
  };

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".bar")) clearBarClick();
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer);
      if (barClickRef.current) window.clearTimeout(barClickRef.current.timer);
    };
  }, []);

  useEffect(() => {
    const swallowClick = (event: MouseEvent) => {
      if (!suppressNextClickRef.current) return;
      suppressNextClickRef.current = false;
      if (suppressClickTimerRef.current) {
        window.clearTimeout(suppressClickTimerRef.current);
        suppressClickTimerRef.current = null;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", swallowClick, true);
    return () => document.removeEventListener("click", swallowClick, true);
  }, []);

  // Mobile long-press mode: lock scrolling, swallow taps outside the armed
  // bar, and leave the mode on the first outside tap.
  useEffect(() => {
    if (!armedTaskId) return;

    const handleOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const touchedTaskId = target?.closest(".bar")?.getAttribute("data-task-id");
      if (touchedTaskId === armedTaskId) return;
      event.preventDefault();
      event.stopPropagation();
      suppressNextClickRef.current = true;
      if (suppressClickTimerRef.current) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 700);
      exitArmedRef.current();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      suppressNextClickRef.current = true;
      if (suppressClickTimerRef.current) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 700);
      exitArmedRef.current();
    };

    const preventScroll = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };

    document.addEventListener("pointerdown", handleOutside, true);
    document.addEventListener("touchmove", preventScroll, { passive: false });
    window.addEventListener("keydown", handleKeyDown, true);
    document.body.classList.add("is-bar-drag-locked");

    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
      document.removeEventListener("touchmove", preventScroll);
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.classList.remove("is-bar-drag-locked");
    };
  }, [armedTaskId]);

  const updateDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const updateReorder = (next: ReorderState | null) => {
    reorderRef.current = next;
    setReorder(next);
  };

  const clearLongPress = () => {
    const candidate = longPressRef.current;
    if (!candidate) return;
    window.clearTimeout(candidate.timer);
    try {
      candidate.capture.releasePointerCapture(candidate.pointerId);
    } catch {
      // capture may already be gone
    }
    longPressRef.current = null;
  };

  const exitArmed = () => {
    clearLongPress();
    const current = dragRef.current;
    if (current) {
      try {
        current.capture.releasePointerCapture(current.pointerId);
      } catch {
        // already released
      }
      updateDrag(null);
    }
    armedTaskIdRef.current = null;
    setArmedTaskId(null);
  };

  const exitArmedRef = useRef(exitArmed);
  exitArmedRef.current = exitArmed;

  const startTouchPress = (
    event: ReactPointerEvent<HTMLElement>,
    task: Task,
  ) => {
    if (event.button !== 0) return;
    if (longPressRef.current) clearLongPress();
    const capture = event.currentTarget;
    const track = capture.closest(".row-track") as HTMLElement | null;
    if (!track) return;
    const slot = slotFromClientX(event.clientX, track, slotW, totalSlots);
    const start = taskStartSlot(viewStart, task);
    const end = taskEndSlot(viewStart, task);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;

    onSelectTask(task.id);
    try {
      capture.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    event.stopPropagation();

    const timer = window.setTimeout(() => {
      const candidate = longPressRef.current;
      if (!candidate || candidate.pointerId !== pointerId) return;
      longPressRef.current = null;
      armedTaskIdRef.current = task.id;
      setArmedTaskId(task.id);
      try {
        navigator.vibrate?.(12);
      } catch {
        // no haptics
      }
      const state: DragState = {
        kind: "move",
        pointerId,
        originSlot: slot,
        currentSlot: slot,
        originStart: start,
        originEnd: end,
        previewStart: start,
        previewEnd: end,
        active: false,
        armed: true,
        edgeOffset: 0,
        zoneId: task.zoneId,
        quickTitle: task.title,
        taskId: task.id,
        originRowId: task.id,
        startClientX: startX,
        startClientY: startY,
        pointerX: startX,
        pointerY: startY,
        track,
        capture,
      };
      updateDrag(state);
    }, 380);

    longPressRef.current = {
      pointerId,
      taskId: task.id,
      task,
      startX,
      startY,
      timer,
      capture,
      track,
      originSlot: slot,
      originStart: start,
      originEnd: end,
    };
  };

  const rows = useMemo(() => {
    const list: ProjectRow[] = [];
    for (const top of getTopZones(zones)) {
      if (hidden.has(top.id)) continue;
      const children = getChildren(zones, top.id);
      const directTasks = tasks.filter((task) => task.zoneId === top.id);

      if (children.length === 0) {
        const packed = packProjectTasks(directTasks, viewStart, viewDays);
        list.push({
          type: "project",
          key: top.id,
          zone: top,
          zoneId: top.id,
          top,
          label: top.name,
          direct: false,
          canDelete: top.id !== "other",
          reorderGroup: "top",
          tasks: packed.bars,
          taskCount: directTasks.length,
          laneCount: packed.laneCount,
        });
        continue;
      }

      for (const child of children) {
        const childTasks = tasks.filter((task) => task.zoneId === child.id);
        const packed = packProjectTasks(childTasks, viewStart, viewDays);
        list.push({
          type: "project",
          key: child.id,
          zone: child,
          zoneId: child.id,
          top,
          label: child.name,
          direct: false,
          canDelete: true,
          reorderGroup: `child:${top.id}`,
          tasks: packed.bars,
          taskCount: childTasks.length,
          laneCount: packed.laneCount,
        });
      }

      if (directTasks.length > 0) {
        const packed = packProjectTasks(directTasks, viewStart, viewDays);
        list.push({
          type: "project",
          key: `direct:${top.id}`,
          zone: top,
          zoneId: top.id,
          top,
          label: `${top.name}（直属）`,
          direct: true,
          canDelete: false,
          reorderGroup: null,
          tasks: packed.bars,
          taskCount: directTasks.length,
          laneCount: packed.laneCount,
        });
      }
    }
    return list;
  }, [tasks, zones, hidden, viewStart, viewDays]);

  const rowsWithMeta = useMemo(() => {
    let top = 0;
    return rows.map((row) => {
      const height = row.laneCount * taskH;
      const meta = { row, top, height };
      top += height;
      return meta;
    });
  }, [rows, taskH]);

  const zoneBlocks = useMemo(() => {
    const blocks: { key: string; zone: Zone; height: number; rows: typeof rowsWithMeta }[] = [];
    for (const meta of rowsWithMeta) {
      const last = blocks[blocks.length - 1];
      if (last && last.zone.id === meta.row.top.id) {
        last.height += meta.height;
        last.rows.push(meta);
      } else {
        blocks.push({
          key: meta.row.top.id,
          zone: meta.row.top,
          height: meta.height,
          rows: [meta],
        });
      }
    }
    return blocks;
  }, [rowsWithMeta]);

  const totalBodyHeight = rowsWithMeta.reduce((sum, row) => sum + row.height, 0);

  const days = useMemo(
    () => Array.from({ length: viewDays }, (_, index) => addDays(parseISO(viewStart), index)),
    [viewStart, viewDays],
  );

  const today = todayISO();
  const todayIndex = diffDays(parseISO(viewStart), parseISO(today));
  const weekendIndices = days
    .map((day, index) => (isWeekend(day) ? index : -1))
    .filter((index) => index >= 0);

  // Scroll to "today" on first paint and when the parent asks for it.
  const lastScrollTick = useRef<number | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const first = lastScrollTick.current === null;
    if (!first && lastScrollTick.current === scrollTick) return;
    lastScrollTick.current = scrollTick;
    if (todayIndex < 0 || todayIndex >= viewDays) return;
    const target = Math.max(
      0,
      railW + leftW + todayIndex * dayWidth + slotW - scroller.clientWidth * 0.36,
    );
    scroller.scrollLeft = target;
  }, [scrollTick, viewStart, viewDays, slotW, leftW, railW, dayWidth, todayIndex]);

  // Keep the chart scrolling while a drag is held near an edge.
  useEffect(() => {
    if (!drag?.active) return;
    // The mobile long-press lock is a static frame: no auto-scrolling,
    // otherwise small moves near an edge jump several slots.
    if (isMobile && armedTaskId) return;
    const timer = window.setInterval(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const x = pointerRef.current.x;
      if (x < rect.left + 48) {
        scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 14);
      } else if (x > rect.right - 48) {
        scroller.scrollLeft = Math.min(
          scroller.scrollWidth - scroller.clientWidth,
          scroller.scrollLeft + 14,
        );
      }
    }, 16);
    return () => window.clearInterval(timer);
  }, [drag?.active, armedTaskId, isMobile]);

  const beginCreate = (
    event: ReactPointerEvent<HTMLDivElement>,
    rowKey: string,
    zoneId: string,
    quickTitle: string,
  ) => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    clearBarClick();
    const track = event.currentTarget;
    const slot = slotFromClientX(event.clientX, track, slotW, totalSlots);
    const state: DragState = {
      kind: "create",
      pointerId: event.pointerId,
      originSlot: slot,
      currentSlot: slot,
      originStart: slot,
      originEnd: slot,
      previewStart: slot,
      previewEnd: slot,
      active: false,
      edgeOffset: 0,
      zoneId,
      quickTitle,
      originRowId: rowKey,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      track,
      capture: track,
    };
    updateDrag(state);
    onSelectTask(null);
    track.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  };

  const beginTaskDrag = (
    event: ReactPointerEvent<HTMLElement>,
    task: Task,
    kind: Exclude<DragKind, "create">,
  ) => {
    if (event.button !== 0) return;
    const capture = event.currentTarget;
    const track = capture.closest(".row-track") as HTMLElement | null;
    if (!track) return;
    const slot = slotFromClientX(event.clientX, track, slotW, totalSlots);
    const start = taskStartSlot(viewStart, task);
    const end = taskEndSlot(viewStart, task);
    const edgeOffset =
      kind === "resize-start"
        ? slot - start
        : kind === "resize-end"
          ? slot - end
          : 0;
    const state: DragState = {
      kind,
      pointerId: event.pointerId,
      originSlot: slot,
      currentSlot: slot,
      originStart: start,
      originEnd: end,
      previewStart: start,
      previewEnd: end,
      active: false,
      edgeOffset,
      zoneId: task.zoneId,
      quickTitle: task.title,
      taskId: task.id,
      originRowId: task.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      track,
      capture,
    };
    updateDrag(state);
    onSelectTask(task.id);
    capture.setPointerCapture(event.pointerId);
    event.stopPropagation();
    if (
      event.pointerType !== "touch" ||
      armedTaskIdRef.current === task.id
    ) {
      event.preventDefault();
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = longPressRef.current;
    if (candidate && candidate.pointerId === event.pointerId) {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const distance = Math.hypot(
        event.clientX - candidate.startX,
        event.clientY - candidate.startY,
      );
      // Moving before the long-press threshold cancels arming and returns
      // the gesture to normal scrolling.
      if (distance > 8) clearLongPress();
      return;
    }

    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    const distance = Math.hypot(
      event.clientX - current.startClientX,
      event.clientY - current.startClientY,
    );

    if (current.armed) {
      // Armed means the interface is locked; any horizontal movement moves
      // the task, including a one-slot bar with no spare width.
      if (!current.active && Math.abs(event.clientX - current.startClientX) < 2) {
        return;
      }
    } else {
      const threshold = event.pointerType === "touch" ? 6 : 4;
      if (!current.active && distance < threshold) return;

      // On a phone, a vertical drag means "scroll the page", not "move the task".
      if (!current.active && event.pointerType === "touch") {
        const dx = Math.abs(event.clientX - current.startClientX);
        const dy = Math.abs(event.clientY - current.startClientY);
        if (dy > dx) {
          try {
            current.capture.releasePointerCapture(event.pointerId);
          } catch {
            // already released
          }
          updateDrag(null);
          return;
        }
      }
    }

    const slot = slotFromClientX(event.clientX, current.track, slotW, totalSlots);
    let previewStart = current.previewStart;
    let previewEnd = current.previewEnd;

    if (current.kind === "create") {
      previewStart = Math.min(current.originSlot, slot);
      previewEnd = Math.max(current.originSlot, slot);
    } else if (current.kind === "move") {
      const delta = slot - current.originSlot;
      previewStart = current.originStart + delta;
      previewEnd = current.originEnd + delta;
    } else if (current.kind === "resize-start") {
      const edgeSlot = slot - current.edgeOffset;
      previewStart = Math.min(edgeSlot, current.originEnd);
      previewEnd = current.originEnd;
    } else {
      const edgeSlot = slot - current.edgeOffset;
      previewStart = current.originStart;
      previewEnd = Math.max(edgeSlot, current.originStart);
    }

    if (!current.active) clearBarClick();
    updateDrag({
      ...current,
      active: true,
      currentSlot: slot,
      previewStart,
      previewEnd,
      pointerX: event.clientX,
      pointerY: event.clientY,
    });
    event.preventDefault();
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const candidate = longPressRef.current;
    if (candidate && candidate.pointerId === event.pointerId) {
      const taskId = candidate.taskId;
      clearLongPress();
      if (!cancelled) activateBar(taskId);
      return;
    }

    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    try {
      current.capture.releasePointerCapture(event.pointerId);
    } catch {
      // The capture may already be gone (e.g. pointercancel).
    }

    if (!cancelled) {
      if (!current.active) {
        if (
          !current.armed &&
          armedTaskIdRef.current !== current.taskId
        ) {
          if (current.kind === "create") {
            onCreateRange(current.zoneId, current.originSlot, current.originSlot, {
              wasDrag: false,
              quickTitle: current.quickTitle,
            });
          } else if (current.taskId) {
            activateBar(current.taskId);
          }
        }
      } else {
        // Recompute from the pointer at release time. This matters when the
        // chart auto-scrolled and no further pointermove was delivered.
        const slot = slotFromClientX(event.clientX, current.track, slotW, totalSlots);
        let start = current.previewStart;
        let end = current.previewEnd;
        if (current.kind === "create") {
          start = Math.min(current.originSlot, slot);
          end = Math.max(current.originSlot, slot);
        } else if (current.kind === "move") {
          const delta = slot - current.originSlot;
          start = current.originStart + delta;
          end = current.originEnd + delta;
        } else if (current.kind === "resize-start") {
          start = Math.min(slot - current.edgeOffset, current.originEnd);
          end = current.originEnd;
        } else {
          start = current.originStart;
          end = Math.max(slot - current.edgeOffset, current.originStart);
        }
        if (current.kind === "create") {
          onCreateRange(current.zoneId, start, end, {
            wasDrag: true,
            quickTitle: current.quickTitle,
          });
        } else if (current.taskId) {
          onChangeTime(current.taskId, start, end);
        }
      }
    }
    updateDrag(null);
  };

  const handleProjectClick = (event: ReactMouseEvent<HTMLDivElement>, row: ProjectRow) => {
    if (!isMobile) return;
    const slot = slotFromClientX(event.clientX, event.currentTarget, slotW, totalSlots);
    onCreateRange(row.zoneId, slot, slot, {
      wasDrag: false,
      quickTitle: row.zone.name,
    });
  };

  const openTaskFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>, taskId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onSelectTask(taskId);
    onOpenTask(taskId);
  };

  const beginRename = (zone: Zone, kind: "project" | "zone") => {
    setRenamingId(zone.id);
    setRenameKind(kind);
    setRenameValue(zone.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
    setRenameError(null);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const error = onRenameZone(renamingId, renameValue);
    if (error) {
      setRenameError(error);
      return;
    }
    cancelRename();
  };

  const handleRenameKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      commitRename();
    }
  };

  const beginReorder = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
    group: string,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    clearBarClick();
    const capture = event.currentTarget;
    capture.setPointerCapture(event.pointerId);
    updateReorder({
      id,
      group,
      pointerId: event.pointerId,
      capture,
      targetId: null,
      before: false,
    });
  };

  const findReorderTarget = (
    current: ReorderState,
    clientY: number,
  ): { id: string; before: boolean } | null => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        current.group === "top"
          ? ".zone-block[data-zone-id]"
          : `.gantt-row[data-reorder-group="${current.group}"]`,
      ),
    );
    let best: { id: string; before: boolean; distance: number } | null = null;

    for (const node of nodes) {
      const id =
        current.group === "top" ? node.dataset.zoneId : node.dataset.rowId;
      if (!id || id === current.id) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const center = rect.top + rect.height / 2;
      const distance = Math.abs(clientY - center);
      if (!best || distance < best.distance) {
        best = { id, before: clientY < center, distance };
      }
    }

    return best ? { id: best.id, before: best.before } : null;
  };

  const handleReorderMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = reorderRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = findReorderTarget(current, event.clientY);
    updateReorder({
      ...current,
      targetId: target?.id ?? null,
      before: target?.before ?? false,
    });
  };

  const finishReorder = (
    event: ReactPointerEvent<HTMLElement>,
    cancelled = false,
  ) => {
    const current = reorderRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      current.capture.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const target = cancelled ? null : findReorderTarget(current, event.clientY);
    if (target && target.id !== current.id) {
      onReorder(current.id, target.id, target.before);
    }
    updateReorder(null);
  };

  const renderTints = () => (
    <>
      {weekendIndices.map((index) => (
        <span
          key={`weekend-${index}`}
          className="track-tint weekend"
          style={{ left: index * dayWidth, width: dayWidth }}
        />
      ))}
      {todayIndex >= 0 && todayIndex < viewDays && (
        <span
          className="track-tint today"
          style={{ left: todayIndex * dayWidth, width: dayWidth }}
        />
      )}
    </>
  );

  const renderBar = (bar: TaskBar, zone: Zone) => {
    const { task, lane } = bar;
    const dragging = drag?.active && drag.taskId === task.id;
    const start = dragging ? drag.previewStart : bar.start;
    const end = dragging ? drag.previewEnd : bar.end;
    if (start > totalSlots - 1 || end < 0) return null;

    const visibleStart = clamp(start, 0, totalSlots - 1);
    const visibleEnd = clamp(end, 0, totalSlots - 1);
    const width = Math.max(8, (visibleEnd - visibleStart + 1) * slotW - 4);
    const left = visibleStart * slotW + 2;
    const top = lane * taskH + 7;
    const narrow = width < (isMobile ? 62 : 58);
    const armed = armedTaskId === task.id;
    const showLabel = width >= 22;
    const label = narrow ? task.title.slice(0, 3) : task.title;
    const clippedStart = start < 0;
    const clippedEnd = end > totalSlots - 1;
    const classes = [
      "bar",
      task.done ? "is-done" : "",
      selectedId === task.id ? "is-selected" : "",
      armed ? "is-armed" : "",
      dragging ? "is-dragging" : "",
      narrow ? "is-narrow" : "",
      clippedStart ? "clip-start" : "",
      clippedEnd ? "clip-end" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div
        key={task.id}
        className={classes}
        style={
          {
            left,
            top,
            width,
            background: hexToRgba(zone.color, task.done ? 0.1 : 0.28),
            color: task.done ? "#948B7D" : "#302A22",
            "--bar-color": zone.color,
          } as CSSProperties
        }
        title={`${task.title}\n${formatSlotLabel(task.startDate, task.startPart)} → ${formatSlotLabel(
          task.endDate,
          task.endPart,
        )}\n${isMobile ? "长按拖动调整时间 · 双击标记完成" : "双击标记完成"}`}
        data-task-id={task.id}
        tabIndex={0}
        onPointerDown={(event) => {
          if (!isMobile || armedTaskIdRef.current === task.id) {
            beginTaskDrag(event, task, "move");
            return;
          }
          startTouchPress(event, task);
        }}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => openTaskFromKeyboard(event, task.id)}
      >
        {showLabel && (
          <span className={`bar-title ${narrow ? "is-short" : ""}`}>{label}</span>
        )}
        {(!isMobile || armed) && (
          <>
            <span
              className="bar-handle bar-handle-start"
              onPointerDown={(event) => beginTaskDrag(event, task, "resize-start")}
            />
            <span
              className="bar-handle bar-handle-end"
              onPointerDown={(event) => beginTaskDrag(event, task, "resize-end")}
            />
          </>
        )}
      </div>
    );
  };

  const ghost = (() => {
    if (!drag?.active || drag.kind !== "create") return null;
    const start = Math.min(drag.previewStart, drag.previewEnd);
    const end = Math.max(drag.previewStart, drag.previewEnd);
    return (
      <div
        className="bar ghost"
        style={
          {
            left: start * slotW + 2,
            top: 7,
            width: Math.max(8, (end - start + 1) * slotW - 4),
            "--bar-color": getZone(zones, drag.zoneId).color,
          } as CSSProperties
        }
      />
    );
  })();

  const dragLabel = (() => {
    if (!drag?.active) return null;
    const start = slotToDatePart(viewStart, drag.previewStart);
    const end = slotToDatePart(viewStart, drag.previewEnd);
    const prefix = drag.kind === "create" ? "新建子任务" : drag.kind === "move" ? "移动" : "调整";
    const same = start.date === end.date && start.part === end.part;
    return (
      <div
        className="drag-label"
        style={{
          left: Math.min(window.innerWidth - 250, drag.pointerX + 14),
          top: drag.pointerY - 14,
        }}
      >
        {prefix} · {formatSlotLabel(start.date, start.part)}
        {!same && ` → ${formatSlotLabel(end.date, end.part)}`}
      </div>
    );
  })();

  const style = {
    "--slot-w": `${slotW}px`,
    "--left-w": `${leftW}px`,
    "--rail-w": `${railW}px`,
    "--task-h": `${taskH}px`,
  } as CSSProperties;

  const dropClass = (id: string) => {
    if (!reorder || reorder.targetId !== id) return "";
    return reorder.before ? "drop-before" : "drop-after";
  };

  const topDropClass = (id: string) =>
    reorder?.group === "top" ? dropClass(id) : "";

  const renderProjectRow = (
    row: ProjectRow,
    height: number,
  ) => {
    const reordering = reorder?.id === row.key;
    return (
      <div
        className={[
          "gantt-row project-row",
          row.direct ? "is-direct" : "",
          !row.zone.parentId ? "is-top" : "",
          reordering ? "is-reordering" : "",
          dropClass(row.key),
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ height }}
        key={`project-${row.key}`}
        data-row-kind="project"
        data-row-id={row.key}
        data-reorder-group={row.reorderGroup ?? undefined}
      >
        <div className="row-label" style={{ width: leftW }}>
          <div
            className={`project-label ${row.direct ? "is-direct" : ""}`}
            title={`${row.label} · ${row.taskCount} 个子任务`}
          >
            <span
              className="project-dot"
              style={{ background: row.zone.color }}
            />
            {renamingId === row.zone.id && renameKind === "project" ? (
              <input
                className={`inline-rename project-rename ${renameError ? "is-invalid" : ""}`}
                value={renameValue}
                onChange={(event) => {
                  setRenameValue(event.target.value);
                  setRenameError(null);
                }}
                onBlur={commitRename}
                onKeyDown={handleRenameKey}
                onPointerDown={(event) => event.stopPropagation()}
                autoFocus
                maxLength={16}
                aria-label={`重命名 ${row.label}`}
                title={renameError ?? "回车保存，Esc 取消"}
              />
            ) : (
              <span
                className="project-name"
                onClick={
                  isMobile
                    ? (event) => {
                        event.stopPropagation();
                        beginRename(row.zone, "project");
                      }
                    : undefined
                }
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  beginRename(row.zone, "project");
                }}
                title={`${row.label} · 双击改名${isMobile ? " / 点一下" : ""}`}
              >
                {row.label}
              </span>
            )}
            <span className="project-count">{row.taskCount}</span>
            {row.canDelete && (
              <button
                className="task-delete"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteProject(row.zone.id);
                }}
                aria-label={`删除项目 ${row.label}`}
                title="删除项目（连同子任务）"
              >
                <Trash size={12} />
              </button>
            )}
            {sortMode && row.reorderGroup && (
              <button
                className="reorder-grip"
                onPointerDown={(event) =>
                  beginReorder(event, row.key, row.reorderGroup as string)
                }
                onPointerMove={handleReorderMove}
                onPointerUp={(event) => finishReorder(event)}
                onPointerCancel={(event) => finishReorder(event, true)}
                onClick={(event) => event.stopPropagation()}
                aria-label={`拖动排序 ${row.label}`}
                title="拖动排序"
              >
                <Grip size={12} />
              </button>
            )}
          </div>
        </div>
        <div
          className="row-track project-track"
          style={{ width: totalWidth }}
          onPointerDown={
            !isMobile
              ? (event) =>
                  beginCreate(event, row.key, row.zoneId, row.zone.name)
              : undefined
          }
          onClick={
            isMobile ? (event) => handleProjectClick(event, row) : undefined
          }
        >
          {renderTints()}
          {row.tasks.length === 0 && row.taskCount === 0 && (
            <span className="project-empty-hint">
              {isMobile ? "点一下加子任务" : "拖一下加子任务"}
            </span>
          )}
          {row.tasks.map((bar) => renderBar(bar, row.zone))}
          {drag?.active &&
            drag.kind === "create" &&
            drag.originRowId === row.key &&
            ghost}
        </div>
      </div>
    );
  };

  return (
    <div
      className={`gantt ${sortMode ? "is-sorting" : ""}`}
      style={style}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event)}
      onPointerCancel={(event) => finishDrag(event, true)}
    >
      <div className="gantt-scroll" ref={scrollRef}>
        <div
          className="scroll-content"
          style={{ width: railW + leftW + totalWidth }}
        >
          <div className="gantt-header" style={{ height: headerH }}>
            <div className="corner" style={{ width: railW + leftW }}>
              <div className="corner-rail" style={{ width: railW }}>
                分<br />区
              </div>
              <div className="corner-main">
                <div className="corner-head">
                  <span className="corner-title">项目</span>
                  <button
                    className={`sort-toggle ${sortMode ? "is-on" : ""}`}
                    onClick={onToggleSortMode}
                    title={sortMode ? "退出排序" : "拖动排序"}
                    aria-label={sortMode ? "退出排序" : "拖动排序"}
                    aria-pressed={sortMode}
                  >
                    <Grip size={12} />
                    <span className="sort-label">{sortMode ? "完成" : "排序"}</span>
                  </button>
                </div>
                <div className="corner-sub">
                  {sortMode ? "拖动右侧手柄排序" : "每天 3 格 · 早中晚"}
                </div>
              </div>
            </div>
            <div className="days" style={{ width: totalWidth }}>
              {days.map((day, index) => (
                <div
                  key={day.toISOString()}
                  className={[
                    "day-head",
                    isWeekend(day) ? "is-weekend" : "",
                    index === todayIndex ? "is-today" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ width: dayWidth }}
                  title={`${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日 ${weekdayCN(
                    day,
                  )}`}
                >
                  <div className="day-date">
                    <span>{formatMD(day)}</span>
                    <span className="day-weekday">{weekdayCN(day)}</span>
                  </div>
                  <div className="day-parts">
                    {PART_LABELS.map((part) => (
                      <span className="day-part" key={part}>
                        {part}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="gantt-body" style={{ height: totalBodyHeight }}>
            {zoneBlocks.map((block) => {
              const children = getChildren(zones, block.zone.id);
              return (
                <div
                  className={[
                    "zone-block",
                    reorder?.group === "top" && reorder.id === block.zone.id
                      ? "is-reordering"
                      : "",
                    topDropClass(block.zone.id),
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={block.key}
                  style={{ height: block.height }}
                  data-zone-id={block.zone.id}
                  data-reorder-group="top"
                >
                  <div
                    className="zone-rail"
                    style={{
                      width: railW,
                      borderLeftColor: block.zone.color,
                      background: hexToRgba(block.zone.color, 0.08),
                    }}
                    title={`${block.zone.name} · 双击改名`}
                  >
                    {renamingId === block.zone.id && renameKind === "zone" ? (
                      <input
                        className={`zone-rail-rename ${renameError ? "is-invalid" : ""}`}
                        value={renameValue}
                        onChange={(event) => {
                          setRenameValue(event.target.value);
                          setRenameError(null);
                        }}
                        onBlur={commitRename}
                        onKeyDown={handleRenameKey}
                        onPointerDown={(event) => event.stopPropagation()}
                        autoFocus
                        maxLength={16}
                        aria-label={`重命名分区 ${block.zone.name}`}
                        title={renameError ?? "回车保存，Esc 取消"}
                      />
                    ) : (
                      <button
                        className="zone-rail-name"
                        onClick={
                          isMobile
                            ? (event) => {
                                event.stopPropagation();
                                beginRename(block.zone, "zone");
                              }
                            : undefined
                        }
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          beginRename(block.zone, "zone");
                        }}
                        title={`${block.zone.name} · 双击改名${isMobile ? " / 点一下" : ""}`}
                      >
                        {block.zone.name}
                      </button>
                    )}
                    <div className="zone-rail-actions">
                      {sortMode ? (
                        <button
                          className="zone-rail-btn"
                          onPointerDown={(event) =>
                            beginReorder(event, block.zone.id, "top")
                          }
                          onPointerMove={handleReorderMove}
                          onPointerUp={(event) => finishReorder(event)}
                          onPointerCancel={(event) => finishReorder(event, true)}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`拖动排序 ${block.zone.name}`}
                          title="拖动排序"
                        >
                          <Grip size={11} />
                        </button>
                      ) : (
                        children.length > 0 && (
                          <button
                            className="zone-rail-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              onAddProject(block.zone.id);
                            }}
                            aria-label={`在${block.zone.name}新建项目`}
                            title="在此分区新建项目"
                          >
                            <Plus size={11} />
                          </button>
                        )
                      )}
                      {block.zone.id !== "other" &&
                        getTopZones(zones).length > 1 && (
                          <button
                            className="zone-rail-btn is-danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteProject(block.zone.id);
                            }}
                            aria-label={`删除分区 ${block.zone.name}`}
                            title="删除分区（连同项目和子任务）"
                          >
                            <Trash size={11} />
                          </button>
                        )}
                    </div>
                  </div>
                  <div className="zone-rows">
                    {block.rows.map(({ row, height }) =>
                      renderProjectRow(row, height),
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {todayIndex >= 0 && todayIndex < viewDays && (
            <div
              className="today-line"
              style={{
                left: railW + leftW + todayIndex * dayWidth,
                top: headerH,
                height: totalBodyHeight,
              }}
            />
          )}
        </div>
      </div>

      {tasks.length === 0 && (
        <div className="empty-state">
          <div className="empty-card">
            <div className="empty-kicker">空白的一周</div>
            <h3>先建一个项目，或直接拖子任务</h3>
            <p>
              左栏一行是一个项目，比如「英语四级」。在项目行上拖出时间块，就是这个项目的子任务。
            </p>
            <button className="btn-primary" onClick={() => onAddProject()}>
              新建项目
            </button>
          </div>
        </div>
      )}

      {armedTaskId && (
        <>
          <div className="drag-lock-frame" aria-hidden="true" />
          <div className="drag-lock-hint" role="status">
            拖动条形调整时间 · 点其他位置退出
          </div>
        </>
      )}

      {dragLabel}
    </div>
  );
}
