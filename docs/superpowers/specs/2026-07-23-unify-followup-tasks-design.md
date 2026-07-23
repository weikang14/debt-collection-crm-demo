# Unify Case Follow-up (`next_action_at`) into Tasks — Design

Date: 2026-07-23

## Goal

`cases.next_action_at` (a bare date on the case) and the `tasks` table are two
unrelated "something to follow up on" mechanisms today. They surface
separately on the dashboard (`followups` from `next_action_at`, `overdueTasks`
count from `tasks`) with zero data-layer relationship — an agent or manager
has to check two places to know what's due.

This unifies them: `tasks` becomes the single source of truth for
follow-ups. It also extends visibility from "due today / overdue" to a
forward-looking window, so upcoming follow-ups don't get missed.

## 1. Data model & migration

**End state:** `cases.next_action_at` is removed. `tasks` (unchanged schema:
`case_id`, `agent_id`, `type`, `title`, `due_date`, `status`, `notes`) is the
only place a follow-up date lives.

**Migration (in `src/db/index.js` `init()`, following the existing
try/catch `ALTER TABLE` idiom already used for `is_demo`, `plan_id`,
`interest_mode`, etc.):**

```js
try {
  const rows = db.prepare(
    "SELECT id, agent_id, case_no, next_action_at FROM cases WHERE next_action_at IS NOT NULL"
  ).all();
  for (const r of rows) {
    db.prepare(
      `INSERT INTO tasks (case_id, agent_id, type, title, due_date, status)
       VALUES (?, ?, 'follow_up', ?, ?, 'pending')`
    ).run(r.id, r.agent_id, `跟进 ${r.case_no}`, r.next_action_at);
  }
  db.prepare('ALTER TABLE cases DROP COLUMN next_action_at').run();
} catch (e) { /* already migrated: column gone, or nothing to backfill */ }
```

Runs once: after the column is dropped, the `SELECT` on a future app start
throws "no such column" inside the same `try`, so the block is a no-op —
same idempotency pattern the rest of `init()` already relies on.

`schema.sql`: remove `next_action_at TEXT` from the `cases` table
definition (so fresh databases don't create it).

**Affected code:**
- `src/routes/cases.js` — drop `next_action_at` from the `INSERT`/`UPDATE`
  case statements (currently lines ~102-104, ~133-134).
- `src/views/cases/form.ejs` — remove the "下次跟进日期" input.
- `src/views/cases/show.ejs` — line 66 "Next Action" fact changes from
  `c.next_action_at` to this case's earliest-due pending task (title + due
  date; `SELECT ... FROM tasks WHERE case_id=? AND status='pending' ORDER
  BY due_date IS NULL, due_date LIMIT 1`), or `—` if none exists.
- `src/routes/dashboard.js` — the `followups` query (lines ~32-38) is
  rewritten against `tasks` (see below).

## 2. Dashboard & Tasks page

**Dashboard (`dashboard.js` + `dashboard/index.ejs`):**

- `followups` query becomes: `tasks` joined to `cases`/`debtors`, filtered
  to `status='pending' AND due_date <= date('now','+8 hours','+14 days')`,
  scoped by `agent_id` for agent role (same `isScoped` pattern already used
  for `overdueTasks`), unscoped (team-wide) for admin/manager. Sorted by
  `due_date` ascending. Limit 10 + "查看全部" link to `/tasks` with the
  matching window param.
- Section renamed "今日跟进" → "近期待办", subtitle "未来 14 天内到期".
- Row badge logic: overdue → red `.b-late` (unchanged), due today → gold
  `.b-today` (unchanged), due within the next 1-14 days → new muted badge
  showing relative days ("3天后").
- New KPI figure next to the existing "逾期任务" chip: "近14天待办" (total
  count in the window), giving managers an at-a-glance total.

**Tasks page (`tasks.js` + `tasks/index.ejs`):**

- Existing `status` / `type` / `overdue` filters unchanged.
- New independent filter: due-date window — 今天 / 7天内 / 14天内 / 30天内
  / 全部, via `?window=` query param, default `14` (matches the dashboard).
  This is an upper bound (`due_date <= today + N`) and composes with
  `overdue` (a lower-bound signal), not a replacement for it.

## Files touched

- `src/db/index.js` — migration block in `init()`.
- `src/db/schema.sql` — remove `next_action_at` column from `cases`.
- `src/routes/cases.js` — remove `next_action_at` read/write.
- `src/routes/dashboard.js` — rewrite `followups` query, add window-count KPI.
- `src/routes/tasks.js` — add `window` query param handling.
- `src/views/cases/form.ejs` — remove "下次跟进日期" input.
- `src/views/cases/show.ejs` — replace "Next Action" fact with linked task.
- `src/views/dashboard/index.ejs` — rename section, add relative-day badge,
  add window-count KPI chip.
- `src/views/tasks/index.ejs` — add window filter control.
- `docs/dashboard-mockups.html` — not touched by this change (static
  comparison mockup, out of scope here).

## Testing (manual, no new automated framework)

- Run the app once against a dev DB that has existing `next_action_at`
  values; confirm every such case now has a matching `follow_up` task with
  the same due date, and the column is gone from `cases` afterward.
- Dashboard "近期待办": overdue / today / upcoming badges render correctly;
  agent login sees only own tasks, admin sees all; the "近14天待办" KPI
  count matches the table.
- Case detail page: "Next Action" fact shows the linked task correctly, or
  "—" when the case has no pending task.
- Tasks page: switching the window filter narrows/widens results correctly
  and composes with existing `status`/`type`/`overdue` filters.

## Out of scope

- No changes to PTP (Promise to Pay) — separate concept, untouched.
- No changes to `docs/dashboard-mockups.html` (static comparison file).
- No bulk task creation/assignment tooling.
- No configurable default window per user (14-day default is fixed for now).
