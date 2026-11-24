import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { getTopZones } from "../data";
import type { Zone } from "../types";
import { Close, Plus } from "./Icons";

const COLORS = [
  "#B3261E",
  "#E07A5F",
  "#C2410C",
  "#D97706",
  "#312E81",
  "#4338CA",
  "#6366F1",
  "#8B5CF6",
  "#A78BFA",
  "#15803D",
  "#4ADE80",
  "#0F766E",
  "#92400E",
  "#6B7280",
];

interface ProjectEditorProps {
  zones: Zone[];
  defaultParentId: string;
  isMobile: boolean;
  onClose: () => void;
  onAdd: (input: { name: string; parentId: string | null; color: string }) => string | null;
}

export default function ProjectEditor({
  zones,
  defaultParentId,
  isMobile,
  onClose,
  onAdd,
}: ProjectEditorProps) {
  const tops = getTopZones(zones).filter((zone) => zone.id !== "other");
  const initialParent =
    tops.find((zone) => zone.id === defaultParentId) ?? tops[0];
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState(initialParent?.id ?? "");
  const [color, setColor] = useState(initialParent?.color ?? COLORS[0]);
  const [error, setError] = useState("");

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("给项目起个名字");
      return;
    }
    if (!parentId) {
      setError("先选择一个所属分区");
      return;
    }
    const siblings = zones.filter((zone) => zone.parentId === parentId);
    if (siblings.some((zone) => zone.name === trimmed)) {
      setError("这个分区下已有同名项目");
      return;
    }
    const result = onAdd({ name: trimmed, parentId, color });
    if (result) {
      setError(result);
      return;
    }
    onClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault();
      handleAdd();
    }
  };

  const stop = (event: ReactPointerEvent) => event.stopPropagation();

  return (
    <div
      className="zm-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="zm-panel project-panel"
        role="dialog"
        aria-modal="true"
        aria-label="新建项目"
        onPointerDown={stop}
        onKeyDown={handleKeyDown}
      >
        <div className="zm-head">
          <div>
            <div className="zm-kicker">Project</div>
            <h2>新建项目</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Close size={15} />
          </button>
        </div>

        <div className="project-body">
          <p className="project-lead">
            项目会成为左栏的一行，比如「英语四级」。子任务不用在这里建，
            在它的时间行上拖出来就行。
          </p>

          <label className="field-label" htmlFor="project-name">
            项目名称
          </label>
          <input
            id="project-name"
            className="zm-input"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError("");
            }}
            placeholder="比如：英语四级"
            maxLength={16}
            autoFocus
          />

          <label className="field-label" htmlFor="project-parent">
            所属分区
          </label>
          <select
            id="project-parent"
            className="zm-select"
            value={parentId}
            onChange={(event) => {
              const next = event.target.value;
              setParentId(next);
              const parent = zones.find((zone) => zone.id === next);
              if (parent) setColor(parent.color);
            }}
          >
            {tops.map((top) => (
              <option key={top.id} value={top.id}>
                {top.name}
              </option>
            ))}
          </select>

          <div className="field-label">颜色</div>
          <div className="zm-colors">
            {COLORS.map((swatch) => (
              <button
                key={swatch}
                className={`zm-swatch ${color.toLowerCase() === swatch.toLowerCase() ? "is-active" : ""}`}
                style={{ background: swatch }}
                onClick={() => setColor(swatch)}
                aria-label={`选择颜色 ${swatch}`}
                title={swatch}
              />
            ))}
            <label className="zm-custom-color" title="自定义颜色">
              <input
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                aria-label="自定义颜色"
              />
              <span style={{ background: color }} />
            </label>
          </div>

          {error && <div className="zm-error">{error}</div>}

          <div className="project-actions">
            <span className="zm-hint">
              {isMobile ? "子任务在时间行上点一下" : "子任务在时间行上拖一下"}
            </span>
            <div>
              <button className="btn-ghost" onClick={onClose}>
                取消
              </button>
              <button className="btn-primary" onClick={handleAdd}>
                <Plus size={12} /> 新建
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
