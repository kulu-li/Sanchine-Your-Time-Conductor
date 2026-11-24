import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { formatSlotLabel, keyToSlot, slotKey } from "../date";
import { getChildren, getTopZones, getZone } from "../data";
import { PART_LABELS } from "../types";
import type { Part, TaskDraft, Zone } from "../types";
import { Close, Trash } from "./Icons";

interface TaskEditorProps {
  mode: "create" | "edit";
  draft: TaskDraft;
  zones: Zone[];
  isMobile: boolean;
  onChange: (draft: TaskDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}

export default function TaskEditor({
  mode,
  draft,
  zones,
  isMobile,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: TaskEditorProps) {
  const zone = getZone(zones, draft.zoneId);
  const canSave = draft.title.trim().length > 0;
  const sameSlot =
    draft.startDate === draft.endDate && draft.startPart === draft.endPart;

  const groups = getTopZones(zones).map((top) => {
    const children = getChildren(zones, top.id);
    const direct = children.length > 0 && draft.zoneId === top.id;
    return {
      top,
      options: children.length > 0 ? [...children, ...(direct ? [top] : [])] : [top],
      hasChildren: children.length > 0,
    };
  });

  const updateStart = (date: string, part: Part) => {
    const next: TaskDraft = { ...draft, startDate: date, startPart: part };
    if (slotKey(date, part) > slotKey(draft.endDate, draft.endPart)) {
      next.endDate = date;
      next.endPart = part;
    }
    onChange(next);
  };

  const updateEnd = (date: string, part: Part) => {
    const next: TaskDraft = { ...draft, endDate: date, endPart: part };
    if (slotKey(date, part) < slotKey(draft.startDate, draft.startPart)) {
      next.startDate = date;
      next.startPart = part;
    }
    onChange(next);
  };

  const shift = (startDelta: number, endDelta: number) => {
    const start = slotKey(draft.startDate, draft.startPart) + startDelta;
    const end = Math.max(
      start,
      slotKey(draft.endDate, draft.endPart) + endDelta,
    );
    const nextStart = keyToSlot(start);
    const nextEnd = keyToSlot(end);
    onChange({
      ...draft,
      startDate: nextStart.date,
      startPart: nextStart.part,
      endDate: nextEnd.date,
      endPart: nextEnd.part,
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key === "Enter" && canSave) {
      event.preventDefault();
      onSave();
      return;
    }
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      event.target.classList.contains("title-input") &&
      !event.nativeEvent.isComposing &&
      canSave
    ) {
      event.preventDefault();
      onSave();
    }
  };

  const stop = (event: ReactPointerEvent) => event.stopPropagation();

  return (
    <div
      className="editor-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="editor"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? "新建子任务" : "编辑子任务"}
        onPointerDown={stop}
        onKeyDown={handleKeyDown}
      >
        <div className="editor-head">
          <div className="editor-kicker">
            <span className="editor-zone-dot" style={{ background: zone.color }} />
            {mode === "create" ? "新建子任务" : "编辑子任务"}
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label="关闭">
            <Close size={15} />
          </button>
        </div>

        <input
          className="title-input"
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
          placeholder="子任务要做什么？"
          autoFocus
          maxLength={80}
        />

        <label className="field-label" htmlFor="zone-select">
          项目
        </label>
        <select
          id="zone-select"
          className="zone-select"
          value={draft.zoneId}
          onChange={(event) => onChange({ ...draft, zoneId: event.target.value })}
        >
          {groups.map(({ top, options, hasChildren: groupHasChildren }) => (
            <optgroup key={top.id} label={top.name}>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id === top.id && groupHasChildren
                    ? `${option.name}（直属）`
                    : option.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <div className="field-label">时间</div>
        <div className="time-block">
          <div className="time-row">
            <span className="time-key">开始</span>
            <input
              type="date"
              value={draft.startDate}
              onChange={(event) => {
                if (event.target.value) updateStart(event.target.value, draft.startPart);
              }}
            />
            <select
              value={draft.startPart}
              onChange={(event) =>
                updateStart(draft.startDate, Number(event.target.value) as Part)
              }
              aria-label="开始时段"
            >
              {PART_LABELS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="time-row">
            <span className="time-key">结束</span>
            <input
              type="date"
              value={draft.endDate}
              onChange={(event) => {
                if (event.target.value) updateEnd(event.target.value, draft.endPart);
              }}
            />
            <select
              value={draft.endPart}
              onChange={(event) =>
                updateEnd(draft.endDate, Number(event.target.value) as Part)
              }
              aria-label="结束时段"
            >
              {PART_LABELS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="time-summary">
            {formatSlotLabel(draft.startDate, draft.startPart)}
            {!sameSlot && ` → ${formatSlotLabel(draft.endDate, draft.endPart)}`}
          </div>
          <div className="quick-shift">
            <button onClick={() => shift(-1, -1)}>← 前移一格</button>
            <button onClick={() => shift(1, 1)}>后移一格 →</button>
            <button onClick={() => shift(0, -1)}>缩短</button>
            <button onClick={() => shift(0, 1)}>延长</button>
          </div>
        </div>

        <label className="field-label" htmlFor="note-input">
          备注
        </label>
        <textarea
          id="note-input"
          className="note-input"
          value={draft.note}
          onChange={(event) => onChange({ ...draft, note: event.target.value })}
          placeholder={isMobile ? "可选" : "可选：地点、材料、下一步…"}
          maxLength={4000}
        />

        {mode === "edit" && (
          <label className="done-row">
            <input
              type="checkbox"
              checked={draft.done}
              onChange={(event) => onChange({ ...draft, done: event.target.checked })}
            />
            标记为已完成
          </label>
        )}

        <div className="editor-foot">
          <div>
            {mode === "edit" && onDelete && (
              <button className="btn-ghost btn-danger" onClick={onDelete}>
                <Trash size={13} /> 删除子任务
              </button>
            )}
          </div>
          <div className="editor-actions">
            <button className="btn-ghost" onClick={onCancel}>
              取消
            </button>
            <button className="btn-primary" onClick={onSave} disabled={!canSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
