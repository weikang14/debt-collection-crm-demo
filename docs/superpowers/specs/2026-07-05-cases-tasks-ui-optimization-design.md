# Cases / Tasks UI Optimization — Design

Date: 2026-07-05

## Goal

Declutter the case detail page and make records/notes/tasks editable. Three
user-requested changes:

1. Case detail page no longer shows the records column directly. A `☰` icon on
   the case card opens a full-screen modal listing all records.
2. Rework the case-card action area: three separate action buttons in the
   page-head top-right; inline Add Note below the card; inline Change Status on
   the card. All laid out horizontally.
3. Tasks and case notes become editable.

Scope is UI + a few small routes. No schema changes.

## Files touched

- `src/views/cases/show.ejs` — layout rework, records modal, inline note/status, note edit/delete.
- `src/routes/cases.js` — note edit + note delete routes.
- `src/views/tasks/index.ejs` — per-row Edit + shared edit modal.
- `src/routes/tasks.js` — task update route.
- `public/css/style.css` — small additions (card header, icon button, modal sizing) reusing existing tokens.

## 1. Case detail page layout (`cases/show.ejs`)

**Remove the two-column `.detail-grid`.** The case card and Timeline become
full-width, stacked. The old right column (Payments / PTP / Calls / Tasks
tables) moves into a modal.

**Page-head, top-right (horizontal buttons, role-gated):**
`Record Payment` · `New PTP` · `Log Call` · `Print statement` · `Edit Case`.
These reuse the existing `<dialog>` modals for Payment / PTP / Call (unchanged),
just triggered from here. Role gating stays as today:
- Record Payment: admin, manager, finance, agent
- New PTP, Log Call: admin, manager, agent
- Print statement: everyone
- Edit Case: admin, manager (unchanged — **not** opened to agent)

**Case card gets a header bar:**
- Left: Change Status — inline `<select>` that **auto-submits on change**
  (`onchange` posts to `/cases/:id/status`). Sits "with the card".
- Right: `☰` icon button that opens the Records modal.
- The `<h1>` status badge stays for at-a-glance display.

**Records modal (`☰`):** one `<dialog class="modal modal-wide">` holding the
four record sections (Payments, PTP, Calls, Tasks) — the exact table markup
moved from the old right column. PTP Fulfill/Break controls kept as-is.
`✕` / backdrop click closes back to the case page.
- Note: PTP "Fulfill" opens a second `<dialog>` (`dlg-ptp-fulfill`) while the
  records dialog is open. Nested dialogs stack; on submit the page navigates
  away, so this is acceptable. (ponytail: nested dialog, revisit only if it
  misbehaves in the browser.)

**Inline Add Note:** directly below the case card, a small
`<form method=post action="/cases/:id/notes">` with a text input + `Add`
button. Replaces the old `dlg-note` modal.

**Removed:** the old `.kv-actions` button row; `dlg-note`; `dlg-status`
(both now inline).

**readOnly roles (auditor / client):** can open `☰` and view records
read-only. No action buttons, no status select, no Add Note, no note
edit/delete, no Edit Case.

## 2. Editable / deletable notes (Timeline)

Timeline entries with `event_type='note'` get small `Edit` / `Delete` controls
(admin, manager, agent). Edit toggles a small inline form in place; Delete is a
plain form submit.

New routes in `cases.js` (role: admin, manager, agent; scope-checked via
`loadCase`):
- `POST /cases/:id/notes/:noteId` — update `timeline_events.content` where
  `id=:noteId AND case_id=:id AND event_type='note'`.
- `POST /cases/:id/notes/:noteId/delete` — delete same row.

Guard: only rows with `event_type='note'` are editable/deletable, so payments,
status changes, calls, etc. (the audit log) stay immutable.

Caveat: the auto-generated "Case {no} created" entry is also `event_type='note'`,
so it will be editable/deletable too. Deemed harmless; left in scope.
(ponytail: if this matters later, exclude the first note by `created_by='system'`
or a marker.)

## 3. Task editing (`tasks/index.ejs` + `tasks.js`)

Each `/tasks` row gets an `Edit` button (shown wherever `Complete` is today:
admin, manager, agent). One shared edit `<dialog>` on the page is pre-filled via
`data-*` attributes read by a small inline script — edits `title`, `type`,
`due_date`, `notes`. Saves to `POST /tasks/:id`.

New route `POST /tasks/:id` in `tasks.js`:
- Same role gate as `/complete` (admin, manager, agent).
- Same agent-ownership check: an agent may only edit tasks where
  `agent_id = u.agent_id`.
- Updates `title`, `type`, `due_date`, `notes`. Does not change `status`
  (Complete already handles that) or `agent_id`.

## 4. Case info editing "更方便"

`Edit Case` (full form, admin/manager) is unchanged in behavior — only its
button moves into the page-head button row for one-click access. **Not** opened
to agents (financial fields stay admin/manager only), per user decision (B).

## Testing

Manual verification via the running app for each flow:
- Case page renders full-width; `☰` opens records modal; `✕` closes.
- Three action buttons trigger their dialogs; a payment/PTP/call records
  correctly.
- Status select auto-submits and updates the badge + timeline.
- Inline Add Note appends a note; note Edit updates it; note Delete removes it.
- Non-note timeline rows show no Edit/Delete.
- Task Edit updates fields; agent can only edit own tasks.
- Auditor sees records read-only with no mutation controls.

## Out of scope

- No schema changes.
- No task editing from inside the case Records modal (tasks edited on `/tasks`).
- No change to case-edit permissions.
- No bulk actions.
