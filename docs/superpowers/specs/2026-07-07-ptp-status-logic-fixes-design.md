# PTP / Status Logic Fixes — Design

Date: 2026-07-07

## Goal

Close the logic gaps from the audit batch 1 plus PTP creation validation. No
schema migration, no new dependencies.

Items: **A** PTP-create validation, **#4** break-PTP status revert + overdue-PTP
dashboard tile, **#5** case-edit re-runs status, **#7** dashboard overdue-tasks
scope.

## Decisions

- Break-PTP revert target = **`negotiation`** (no "previous status" is stored;
  negotiation is the sensible active state after a promise falls through).
- Overdue-PTP **dashboard tile: yes**.
- PTP creation amount is **capped at the current outstanding** — reject
  `> outstanding` (and reject non-positive/non-numeric), reusing
  `validatePayment`.

## A — PTP creation validation (`src/routes/cases.js`, `POST /:id/ptps`)

**Problem:** the create route inserts `Number(req.body.amount)` with no
validation — a negative/zero/non-numeric or over-outstanding PTP can be created.

**Fix:** `validatePayment` is already imported in `cases.js`. In the route:
```js
const v = validatePayment(req.body.amount, c.outstanding_amount);
if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
```
Insert `v.amount` (exact, unrounded) instead of `Number(req.body.amount)`. Use
`v.amount` in the timeline text too. Everything else in the route is unchanged.

## #4a — Break PTP reverts case status (`src/routes/ptps.js`, break route)

**Problem:** creating a PTP sets case status to `ptp`; breaking it leaves the
case stuck at `ptp`.

**Fix:** after `UPDATE ptps SET status='broken'`, within the existing scoped
route: if the case's current status is exactly `'ptp'` **and** no `pending` PTP
remains for the case, set status to `'negotiation'` and insert a
`status_change` timeline event (`Status changed ptp → negotiation`). Do nothing
to the status otherwise (terminal/paid statuses, or cases with other pending
PTPs, are untouched). Query for remaining pending:
`SELECT COUNT(*) c FROM ptps WHERE case_id=? AND status='pending'`.

## #4b — Overdue-PTP dashboard tile (`src/routes/dashboard.js`, `src/views/dashboard/index.ejs`)

**Fix:** add a KPI:
```sql
SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id
WHERE <caseWhere on c> AND t.status='pending' AND date(t.due_date) < date('now','+8 hours')
```
Add `overduePtp` to the `kpi` object and a tile in `dashboard/index.ejs`
alongside the existing PTP/broken tiles. MYT (`+8 hours`) per the batch-1 fix.

## #5 — Case edit re-runs status (`src/routes/cases.js`, `POST /:id`)

**Problem:** editing principal/interest recomputes outstanding but never
re-evaluates status (e.g. lowering principal below paid should flip to
`fully_paid`).

**Fix:** after `recomputeOutstanding`, reuse the existing service logic:
```js
const outstanding = recomputeOutstanding(Number(req.params.id));
const paidCount = get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [id]).c;
const cur = get('SELECT status FROM cases WHERE id=?', [id]).status;
const next = statusAfterPayment(cur, outstanding, paidCount);
if (next !== cur) {
  run('UPDATE cases SET status=? WHERE id=?', [next, id]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
    [id, 'status_change', `Status changed ${cur} → ${next}`, req.session.user.full_name]);
}
```
`statusAfterPayment` already guards terminal statuses and returns `fully_paid`
only when `outstanding <= 0`. Import `statusAfterPayment` and `get` where
needed (`get` is already imported; add `statusAfterPayment` to the payments
import). *Note (accepted edge):* editing a case to `principal=0` with no
payments yields `outstanding<=0` → `fully_paid`; this matches the shared
status rule and is an admin-only edge, left as-is.

## #7 — Dashboard overdue tasks scope (`src/routes/dashboard.js`)

**Problem:** `overdueTasks` uses `tasks t JOIN cases c ...`, so tasks with a
`NULL case_id` never count, and the scope is applied via the case join rather
than the tasks-page rule.

**Fix:** scope overdue tasks the way `src/routes/tasks.js` does:
- `agent` → `tasks.agent_id = ?` (`user.agent_id`), including case-less tasks.
- `admin`/`manager`/`finance`/`auditor` → all tasks.
- (`client` role is out of usable surface; if `isScoped` for client, keep the
  existing case-based restriction — but `client` is not seeded, so this is
  defensive only.)
```js
// agent:
SELECT COUNT(*) c FROM tasks WHERE agent_id=? AND status='pending'
  AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')
// privileged:
SELECT COUNT(*) c FROM tasks WHERE status='pending'
  AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')
```
Match the tasks-page overdue definition (`status='pending' AND due_date IS NOT NULL
AND date(due_date) < date('now','+8 hours')`).

## Testing

- **A (`test/ptp_create.test.js`, new):** call the validated insert path is
  route-level; instead unit-cover the rule via `validatePayment` (already
  tested) + a live curl smoke posting a negative and an over-outstanding PTP,
  asserting `?err=` and no PTP row.
- **#4a (`test/ptp_status.test.js`, new, DB):** create a case, add a PTP (status
  → `ptp`), break it via `recordBreak`-equivalent logic, assert status →
  `negotiation`; and a second case with two pending PTPs where breaking one
  leaves status `ptp`.
- **#5 (`test/ptp_status.test.js`, DB):** case with a payment, edit principal
  down so outstanding ≤ 0, assert status → `fully_paid` via the shared logic.
- **#4b, #7:** verified by reasoning + dashboard boot returns 200 (timezone/
  scope queries not cleanly unit-testable).

To make #4a unit-testable, extract the break logic into a small exported
`breakPtp(ptpId, req)` in `ptps.js` (mirrors `recordFulfillment`), returning
`{ ok, caseId }`, and call it from the route. #5 status logic can be tested by
asserting the state after running the same statements against a seeded DB.

## Files touched

- `src/routes/cases.js` — PTP-create validation (A); case-edit status re-run (#5).
- `src/routes/ptps.js` — `breakPtp` with status revert (#4a).
- `src/routes/dashboard.js` — overdue-PTP KPI (#4b); overdue-tasks scope (#7).
- `src/views/dashboard/index.ejs` — overdue-PTP tile.
- `test/ptp_status.test.js` (new) — #4a, #5.

## Out of scope

- The `recordFulfillment` orphan-atomicity follow-up (needs nested-transaction
  restructuring; deferred).
- #8 numbering, #9 audit swallow, #10 auth, and the aging-bucket feature.
