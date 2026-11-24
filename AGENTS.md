# 三线 Gantt — Agent instructions

This file is the contract for agents (including DSH) working on the Gantt tool.

## Read this first

- Project root: `gantt-v1/`.
- Data contract: `schema/gantt.schema.json`, schema v1. The canonical runtime validator is `schema/validate.mjs`.
- **Never edit `data/state.json` directly.** The running server owns an in-memory snapshot; direct file edits get overwritten.
- **Never reset, wipe, or re-seed production data** unless the user explicitly asks and confirms twice.
- **Never print or commit agent tokens, cookies, passwords, or `data/passcode.txt`.**
- Do not change `schema/`, `server/`, or `src/` when the task is only task/project data changes.
- Unknown fields in tasks/zones are rejected. Adding a field requires schemaVersion 2; do not add ad-hoc fields.

## Access

The CLI talks to the same API as the web app. Each account has one workspace;
each workspace has its own agent token.

```bash
cd gantt-v1
export GANTT_URL="https://your-workspace.example.com"
export GANTT_TOKEN="gantt_..."                # workspace token, NOT a login password
node agent/gantt.mjs state
```

- The owner creates the token in **账户与同步 → Agent token**. It is shown once.
- A token can only read/write its own workspace. It cannot access admin routes,
  invitations, or another friend's data.
- If someone shares a workspace with you in the future, use that workspace's
  token; never reuse another person's token.
- The CLI never writes without a revision check. A 409 conflict means the cloud
  changed; re-read, then re-apply. Do not force or retry blindly.
- `--dry-run` validates and prints the intended change without writing.
- `--json` is for machine parsing.
- The CLI also loads `.env` (project root or `agent/.env`), so DSH sessions do
  not need the token on the command line:

  ```bash
  # .env is gitignored; never commit it
  GANTT_URL=https://your-workspace.example.com
  GANTT_TOKEN=gantt_...
  ```

- `GANTT_PASSCODE` / `--passcode-file` remains only for the legacy single-user
  server. Do not use it for the multi-workspace server.

## Daily workflow

1. `state` and `validate` to confirm revision and schema.
2. `projects` / `tasks` to find the exact project or task.
3. For a change, run the command with `--dry-run --json` first.
4. Show the user a short plan (project, title, time range, count).
5. Only after the user asks to apply, run the same command without `--dry-run`.
6. Report the new revision and the created/updated ids. Do not dump the whole state.

For several changes, run them one at a time. Each successful write increments the revision. If a later command conflicts, stop and report; do not overwrite.

## Commands

```bash
node agent/gantt.mjs state
node agent/gantt.mjs projects
node agent/gantt.mjs tasks --project 英语四级 --from 2026-10-20 --to 2026-10-27
node agent/gantt.mjs tasks --todo --json

node agent/gantt.mjs add-task --project 英语四级 --title "听力一套" \
  --start 2026-10-22/晚 --length 2 --note "真题听力"

node agent/gantt.mjs update-task --id <id> --title "新标题" --start 2026-10-23/早 --length 1
node agent/gantt.mjs move-task --id <id> --start 2026-10-24/中
node agent/gantt.mjs done --id <id>
node agent/gantt.mjs done --id <id> --undo

node agent/gantt.mjs add-project --name "英语六级" --parent "学习" --color "#C2410C"
node agent/gantt.mjs update-project --id <id> --name "英语六级" --color "#DC2626"

node agent/gantt.mjs delete-task --id <id> --dry-run
node agent/gantt.mjs delete-task --id <id> --yes

node agent/gantt.mjs delete-project --id <id> --dry-run
node agent/gantt.mjs delete-project --id <id> --yes   # tasks move to "其他"
```

Time syntax: `YYYY-MM-DD/早|中|晚` (also accepts `/0 /1 /2`). A date without a part defaults to 早. One slot = 1/3 day. `--length` is inclusive; `--end` and `--length` are mutually exclusive.

## Data rules

- A top-level zone with children is a **group/分区**; a zone without children is a **project**.
- Tasks normally attach to a leaf project. `大创`, `生活`, `其他` can be top-level leaf projects.
- `other` (「其他」) is the fallback project id; never delete it. The CLI can create it with `add-project --name "其他"`, which reserves id `other`.
- `zoneId` must reference an existing zone.
- End slot must be >= start slot.
- Task/project ids are opaque and stable. Do not rename ids.
- Colors are `#RRGGBB`. Names are 1–80 chars; task titles 1–200; notes <=4000.
- Max 2 zone levels (top → project). No grandchildren.
- Keep `order` numeric; the CLI uses increments of 10.

## What the CLI does not do

- It does not change the view (week/fortnight/month), scroll position, collapsed groups, or other browser preferences.
- It does not create users or workspaces. Invites are created in **账户与同步** by the admin.
- It does not support group deletion; delete child projects individually, or use the web UI.
- It cannot move a project to a different parent. Name/color/order only.

## Failure handling

| Exit | Meaning |
|---|---|
| 1 | usage / not found / network / unexpected |
| 2 | unauthorized token/passcode |
| 3 | revision conflict; re-read before retrying |
| 4 | schema validation failure; do not write |

If `validate` fails, stop and report the exact errors. Do not "fix" data by deleting rows.

## Production safety

- The live workspace may have real study/production data. Read-only commands are safe.
- There is one workspace per account. Do not use a friend's token, and do not
  ask for their password.
- Do not run mutation tests against the live URL. If a dry run is not enough,
  ask the owner for a separate test workspace/token.
- The token is a secret: never print it, paste it into a task note, or send it
  to an external service.
- The deployed server is behind Cloudflare Tunnel; there is no public admin API.
- Backups live on the server under the data directory; do not delete them.
