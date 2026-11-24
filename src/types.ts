export type Part = 0 | 1 | 2;

export type ViewMode = "week" | "fortnight" | "month";

export interface Zone {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  order: number;
}

export interface Task {
  id: string;
  zoneId: string;
  title: string;
  startDate: string; // YYYY-MM-DD
  startPart: Part;
  endDate: string; // YYYY-MM-DD, inclusive
  endPart: Part;
  done: boolean;
  note: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDraft {
  id?: string;
  zoneId: string;
  title: string;
  startDate: string;
  startPart: Part;
  endDate: string;
  endPart: Part;
  note: string;
  done: boolean;
}

export const PART_LABELS = ["早", "中", "晚"] as const;

export const VIEW_DAYS: Record<ViewMode, number> = {
  week: 7,
  fortnight: 14,
  month: 30,
};

export const VIEW_LABELS: Record<ViewMode, string> = {
  week: "周",
  fortnight: "双周",
  month: "月",
};
