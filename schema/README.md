# Frozen snapshot schema v1

This is the API/Agent contract, not the browser's internal localStorage envelope.

## Snapshot

```text
{
  schemaVersion: 1,
  revision: integer >= 0,       // server-owned optimistic concurrency
  updatedAt: epoch ms,          // server-owned
  initialized: boolean,
  tasks: Task[],
  zones: Zone[]
}
```

## Zone (color family, group, or project)

| Field | Type | Rule |
|---|---|---|
| `id` | string | stable, `[A-Za-z0-9][A-Za-z0-9_-]{0,79}` |
| `name` | string | 1–80 chars |
| `parentId` | string \| null | null = top level; a child's parent must be top-level (max depth 2) |
| `color` | string | `#RRGGBB` |
| `order` | number | ascending within siblings |

A top-level zone with children is a **group**; a zone without children is a **project**.
`other` is the fallback project id and must not be deleted.

## Task (subtask)

| Field | Type | Rule |
|---|---|---|
| `id` | string | stable, unique |
| `zoneId` | string | must reference an existing zone (normally a leaf project) |
| `title` | string | 1–200 chars |
| `startDate`, `endDate` | string | `YYYY-MM-DD`, valid dates |
| `startPart`, `endPart` | 0 \| 1 \| 2 | 早 / 中 / 晚 |
| `done` | boolean | |
| `note` | string | max 4000 chars |
| `order` | number | ascending within the project |
| `createdAt`, `updatedAt` | number | epoch milliseconds |

The end slot (date + part) must be >= the start slot.

## Invariants

- Zone ids and task ids are unique.
- No zone cycles; max zone depth is 2 (top → project).
- Tasks may reference a group only for legacy "直属" rows; new tasks should use a leaf project.
- Unknown fields are rejected. Adding a field requires `schemaVersion: 2`.

The canonical runtime validator is `schema/validate.mjs`; `schema/gantt.schema.json` mirrors it for tooling.
