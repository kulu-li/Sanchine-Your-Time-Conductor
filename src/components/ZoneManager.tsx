import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getChildren, getTopZone, getTopZones } from "../data";
import type { Task, Zone } from "../types";
import { Close, Plus, Trash } from "./Icons";

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

interface ZoneManagerProps {
  zones: Zone[];
  tasks: Task[];
  isMobile: boolean;
  onClose: () => void;
  onAdd: (input: { name: string; parentId: string | null; color: string }) => string | null;
  onDelete: (zoneId: string) => void;
}

export default function ZoneManager({
  zones,
  tasks,
  isMobile,
  onClose,
  onAdd,
  onDelete,
}: ZoneManagerProps) {
  const topZones = getTopZones(zones);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [error, setError] = useState("");

  const countForTop = (topId: string) =>
    tasks.filter((task) => getTopZone(zones, task.zoneId).id === topId).length;
  const countForZone = (zoneId: string) =>
    tasks.filter((task) => task.zoneId === zoneId).length;

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("给分区起个名字");
      return;
    }
    const siblings = zones.filter((zone) => zone.parentId === null);
    if (siblings.some((zone) => zone.name === trimmed)) {
      setError("已有同名分区");
      return;
    }
    const result = onAdd({
      name: trimmed,
      parentId: null,
      color,
    });
    if (result) {
      setError(result);
      return;
    }
    setError("");
    setName("");
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
        className="zm-panel"
        role="dialog"
        aria-modal="true"
        aria-label="分区管理"
        onPointerDown={stop}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            event.target instanceof HTMLInputElement
          ) {
            handleAdd();
          }
        }}
      >
        <div className="zm-head">
          <div>
            <div className="zm-kicker">Zones</div>
            <h2>分区管理</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Close size={15} />
          </button>
        </div>

        <div className="zm-body">
          <div className="zm-list">
            {topZones.map((top) => {
              const children = getChildren(zones, top.id);
              return (
                <div className="zm-group" key={top.id}>
                  <div className="zm-row">
                    <span className="zm-dot" style={{ background: top.color }} />
                    <span className="zm-name">{top.name}</span>
                    <span className="zm-badge">{countForTop(top.id)}</span>
                    <button
                      className="zm-delete"
                      onClick={() => onDelete(top.id)}
                      disabled={top.id === "other" || topZones.length <= 1}
                      title={
                        top.id === "other"
                          ? "「其他」是兜底分区，不能删除"
                          : topZones.length <= 1
                            ? "至少保留一个顶级分区"
                            : "删除分区"
                      }
                      aria-label={`删除分区 ${top.name}`}
                    >
                      <Trash size={12} />
                    </button>
                  </div>
                  {children.map((child) => (
                    <div className="zm-row is-child" key={child.id}>
                      <span className="zm-dot" style={{ background: child.color }} />
                      <span className="zm-name">{child.name}</span>
                      <span className="zm-badge">{countForZone(child.id)}</span>
                      <button
                        className="zm-delete"
                        onClick={() => onDelete(child.id)}
                        title="删除项目"
                        aria-label={`删除项目 ${child.name}`}
                      >
                        <Trash size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          <div className="zm-add">
            <div className="zm-add-title">新建分区（色系）</div>
            <div className="zm-add-grid">
              <input
                className="zm-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (error) setError("");
                }}
                placeholder="分区名称，比如「科研」"
                maxLength={16}
              />
            </div>

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

            <div className="zm-add-foot">
              <span className="zm-hint">
                {isMobile ? "项目用顶栏「新建项目」" : "项目用顶栏「新建项目」；这里只建色系"}
              </span>
              <button className="btn-primary" onClick={handleAdd}>
                <Plus size={12} /> 添加
              </button>
            </div>
          </div>

          <p className="zm-note">
            删除分区/项目时，里面的子任务会一起删除，不会移到「其他」；「其他」是兜底项目，不能删除。删除后可以用 ⌘Z 撤销。
          </p>
        </div>
      </div>
    </div>
  );
}
