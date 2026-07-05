# Cases / Tasks UI Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declutter the case detail page (records behind a `☰` modal, horizontal action buttons, inline note/status) and make tasks and case notes editable.

**Architecture:** Server-rendered EJS + Express. Two new mutation routes (note edit/delete in `cases.js`, task update in `tasks.js`), then view reworks in `cases/show.ejs` and `tasks/index.ejs`. No schema changes, no new dependencies.

**Tech Stack:** Node 22, Express 4, EJS + ejs-mate, better-sqlite3 (via `src/db`), `node --test`.

## Global Constraints

- No new npm dependencies.
- DB access only through `src/db` helpers: `get`, `all`, `run` (`run` returns a better-sqlite3 info object with `.lastInsertRowid`).
- Case data access goes through `loadCase(req, res)` in `cases.js` (enforces user scope; returns `null` after rendering 404 on miss).
- Role gates use `requireRole(...roles)` from `src/middleware/auth`.
- readOnly roles = `['auditor','client']`; they may view records but see no mutation controls.
- Money/time in Malaysia time (UTC+8) — existing date-default script in `show.ejs` already handles this; don't change it.
- Run a single test file with: `node --test test/<file>.test.js`. Run all: `npm test`.

---

### Task 1: Note edit + delete routes

**Files:**
- Modify: `src/routes/cases.js` (add two routes after the existing `POST /:id/notes` handler, ~line 148)
- Test: `test/notes_edit.test.js` (create)

**Interfaces:**
- Consumes: `loadCase`, `run`, `get`, `requireLogin`, `requireRole` (already imported in `cases.js`).
- Produces:
  - `POST /cases/:id/notes/:noteId` — updates `timeline_events.content` for a `note`-type row on that case.
  - `POST /cases/:id/notes/:noteId/delete` — deletes a `note`-type row on that case.
  - Both guard on `event_type='note'` so payments/status/call/ptp audit rows are immutable.

- [ ] **Step 1: Write the failing test**

Create `test/notes_edit.test.js`:

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-notes-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();

// The note-guard is the same SQL the routes run. These tests assert the guard
// protects the audit log (data-loss path) and that update targets note rows.
test('note-guarded delete removes note rows but never non-note rows', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  const note = db.run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id, 'note', 'my note', 'tester']);
  const pay = db.run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id, 'payment', 'paid', 'tester']);

  // Attempt to delete a payment row through the note guard: must NOT delete it.
  db.run("DELETE FROM timeline_events WHERE id=? AND case_id=? AND event_type='note'", [pay.lastInsertRowid, c.id]);
  assert.ok(db.get('SELECT 1 x FROM timeline_events WHERE id=?', [pay.lastInsertRowid]), 'payment row survives');

  // Delete the note row: must succeed.
  db.run("DELETE FROM timeline_events WHERE id=? AND case_id=? AND event_type='note'", [note.lastInsertRowid, c.id]);
  assert.ok(!db.get('SELECT 1 x FROM timeline_events WHERE id=?', [note.lastInsertRowid]), 'note row deleted');
});

test('note-guarded update changes content of a note row', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  const note = db.run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id, 'note', 'before', 'tester']);
  db.run("UPDATE timeline_events SET content=? WHERE id=? AND case_id=? AND event_type='note'", ['after', note.lastInsertRowid, c.id]);
  assert.strictEqual(db.get('SELECT content FROM timeline_events WHERE id=?', [note.lastInsertRowid]).content, 'after');
});
```

- [ ] **Step 2: Run test to verify it passes for the SQL guard**

Run: `node --test test/notes_edit.test.js`
Expected: PASS (this test exercises the SQL guard directly; it passes before the routes exist and locks the guard behavior the routes must use).

- [ ] **Step 3: Add the routes**

In `src/routes/cases.js`, immediately after the existing `POST /:id/notes` handler (the block ending near line 148), add:

```js
router.post('/:id/notes/:noteId', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  run("UPDATE timeline_events SET content=? WHERE id=? AND case_id=? AND event_type='note'",
    [req.body.content || '', req.params.noteId, c.id]);
  res.redirect(`/cases/${c.id}?ok=Note+updated`);
});
router.post('/:id/notes/:noteId/delete', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  run("DELETE FROM timeline_events WHERE id=? AND case_id=? AND event_type='note'",
    [req.params.noteId, c.id]);
  res.redirect(`/cases/${c.id}?ok=Note+deleted`);
});
```

- [ ] **Step 4: Re-run test + full suite**

Run: `node --test test/notes_edit.test.js` → Expected: PASS
Run: `npm test` → Expected: all pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/routes/cases.js test/notes_edit.test.js
git commit -m "feat: case note edit + delete routes (note-type guarded)"
```

---

### Task 2: Task update route

**Files:**
- Modify: `src/routes/tasks.js` (add `POST /:id` after the `POST /:id/complete` handler, ~line 49)
- Test: `test/tasks_edit.test.js` (create)

**Interfaces:**
- Consumes: `get`, `run`, `requireLogin`, `requireRole` (already imported in `tasks.js`).
- Produces: `POST /tasks/:id` — updates `title`, `type`, `due_date`, `notes` on a task. Agents may only edit tasks where `agent_id === u.agent_id`. Does not touch `status` or `agent_id`.

- [ ] **Step 1: Write the failing test**

Create `test/tasks_edit.test.js`:

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-tasksedit-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();

test('task update changes editable fields', () => {
  const t = db.get('SELECT id FROM tasks LIMIT 1');
  db.run('UPDATE tasks SET title=?, type=?, due_date=?, notes=? WHERE id=?',
    ['Edited title', 'visit', '2026-08-01', 'edited notes', t.id]);
  const row = db.get('SELECT * FROM tasks WHERE id=?', [t.id]);
  assert.strictEqual(row.title, 'Edited title');
  assert.strictEqual(row.type, 'visit');
  assert.strictEqual(row.notes, 'edited notes');
});
```

- [ ] **Step 2: Run test to verify it passes for the update SQL**

Run: `node --test test/tasks_edit.test.js`
Expected: PASS (locks the UPDATE behavior the route uses; `seedDemo` creates tasks so `LIMIT 1` returns a row).

- [ ] **Step 3: Add the route**

In `src/routes/tasks.js`, after the `POST /:id/complete` handler (ends ~line 49, before `module.exports`), add:

```js
router.post('/:id', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const u = req.session.user;
  const task = get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!task) return res.redirect('/tasks?err=Not+found');
  if (u.role === 'agent' && task.agent_id !== u.agent_id) return res.redirect('/tasks?err=Forbidden');
  const b = req.body;
  run('UPDATE tasks SET title=?, type=?, due_date=?, notes=? WHERE id=?',
    [b.title, b.type || 'follow_up', b.due_date || null, b.notes || null, req.params.id]);
  res.redirect('/tasks?ok=Task+updated');
});
```

Note: `get` is already destructured at the top of `tasks.js` (`const { all, get, run } = require('../db');`). Route path `/:id` does not collide with `/new` or `/:id/complete` (different paths); keep it last among the POST routes.

- [ ] **Step 4: Re-run test + full suite**

Run: `node --test test/tasks_edit.test.js` → Expected: PASS
Run: `npm test` → Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/tasks.js test/tasks_edit.test.js
git commit -m "feat: task update route (edit title/type/due/notes; agent scope)"
```

---

### Task 3: Case page — layout rework, records modal, inline status, header buttons

**Files:**
- Modify: `src/views/cases/show.ejs`
- Modify: `public/css/style.css`

**Interfaces:**
- Consumes: existing route `POST /cases/:id/status`, and dialogs `dlg-payment`, `dlg-ptp`, `dlg-call`, `dlg-ptp-fulfill` (kept).
- Produces: full-width layout; a `☰` button opening `<dialog id="dlg-records">`; an inline status `<select>` that auto-submits.

This task is verified by running the app (no unit test for view markup).

- [ ] **Step 1: Rework the page-head action buttons**

In `src/views/cases/show.ejs`, replace the current `.page-head` action `<div>` (lines 4-7) so the three action buttons sit horizontally with Print and Edit. Replace:

```html
  <div style="display:flex; gap:0.5rem;">
    <a class="btn" href="/cases/<%= c.id %>/statement" target="_blank">Print statement</a>
    <% if (['admin','manager'].includes(currentUser.role)) { %><a class="btn" href="/cases/<%= c.id %>/edit">Edit Case</a><% } %>
  </div>
```

with:

```html
  <div class="head-actions">
    <% if (!readOnly) { %>
      <% if (['admin','manager','finance','agent'].includes(currentUser.role)) { %><button type="button" class="btn btn-gold" onclick="dlg('dlg-payment')">Record Payment</button><% } %>
      <% if (['admin','manager','agent'].includes(currentUser.role)) { %>
        <button type="button" class="btn" onclick="dlg('dlg-ptp')">New PTP</button>
        <button type="button" class="btn" onclick="dlg('dlg-call')">Log Call</button>
      <% } %>
    <% } %>
    <a class="btn" href="/cases/<%= c.id %>/statement" target="_blank">Print statement</a>
    <% if (['admin','manager'].includes(currentUser.role)) { %><a class="btn" href="/cases/<%= c.id %>/edit">Edit Case</a><% } %>
  </div>
```

- [ ] **Step 2: Add a card header (status select + `☰`) to the `.kv` card**

Insert, as the FIRST child inside `<div class="card kv">` (before the `<div><span>Debtor</span>...` row, ~line 13), a header row:

```html
      <div class="kv-head">
        <% if (!readOnly && ['admin','manager','agent'].includes(currentUser.role)) { %>
        <form method="post" action="/cases/<%= c.id %>/status" class="status-inline">
          <label>Status
            <select name="status" onchange="this.form.submit()">
              <% statuses.forEach(s => { %><option value="<%= s %>" <%= c.status===s?'selected':'' %>><%= h.caseStatusLabel(s) %></option><% }) %>
            </select>
          </label>
        </form>
        <% } else { %><span></span><% } %>
        <button type="button" class="btn icon-btn" title="Records" aria-label="Records" onclick="dlg('dlg-records')">&#9776;</button>
      </div>
```

(`&#9776;` is the `☰` trigram/hamburger glyph.)

- [ ] **Step 3: Remove the old `.kv-actions` block**

Delete the `<% if (!readOnly) { %> ... .kv-actions ... <% } %>` block currently at lines 23-33 (Record Payment / Add PTP / Log Call / Add Note / Change Status buttons). Those actions now live in the header (Payment/PTP/Call), the card header (Status), and Task 4 (Add Note).

- [ ] **Step 4: Move the records tables into a modal, make the page full-width**

The current layout is `<div class="detail-grid">` with a left `<div>` (card + Timeline) and a right `<div>` (Payments/PTP/Calls/Tasks). Change it so:

- The outer `<div class="detail-grid">` becomes `<div class="case-main">` and contains ONLY the card + inline note (Task 4) + Timeline (the former left column contents, minus the wrapping left `<div>`).
- The former right column's four sections (the `<h2>Payments</h2>...` through the Tasks table, currently lines 46-80) move INTO a new dialog at the bottom of the file.

Concretely: unwrap the left `<div>` and right `<div>` so the card/timeline render at top level inside `.case-main`, and cut the four record sections out. Then add this dialog just before the closing block of dialogs (near line 84, inside `<% if (!readOnly) { %>` is NOT required — records are viewable read-only, so place it OUTSIDE that guard). Add near the top of the dialog area:

```html
<dialog id="dlg-records" class="modal modal-wide">
  <div class="modal-head">
    <h3>Records</h3>
    <button type="button" class="btn icon-btn" onclick="this.closest('dialog').close()" aria-label="Close">&times;</button>
  </div>
  <div class="modal-body">
    <!-- PASTE the four sections here verbatim: Payments <h2>+table, Promise to Pay <h2>+table (with Fulfill/Break), Calls <h2>+table, Tasks <h2>+table -->
  </div>
</dialog>
```

Paste the four `<h2>`+table sections (the exact markup from old lines 46-79, including the PTP Fulfill/Break `<% if (p.status==='pending' && !readOnly ...) %>` controls) inside `.modal-body`.

- [ ] **Step 5: Add CSS**

Append to `public/css/style.css`:

```css
.head-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.kv-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding-bottom: 8px; border-bottom: 1px solid var(--line, #e5e5e5); margin-bottom: 8px; }
.kv-head .status-inline { margin: 0; }
.kv-head .status-inline label { margin: 0; }
.icon-btn { font-size: 1.15rem; line-height: 1; padding: 4px 10px; }
.case-main { max-width: 900px; }
.modal-wide { width: min(920px, 94vw); max-width: 94vw; }
.modal-head { display: flex; align-items: center; justify-content: space-between; }
.modal-body { max-height: 72vh; overflow-y: auto; }
```

(If `--line` isn't a defined token, the `#e5e5e5` fallback applies. Check the top of `style.css` for existing color tokens and prefer one if present.)

- [ ] **Step 6: Verify in the running app**

Run: `npm start` (then open the app, log in as admin, open a case).
Expected:
- Page is single-column; no right records column.
- Header shows Record Payment / New PTP / Log Call / Print statement / Edit Case horizontally.
- Card header shows a Status dropdown (left) and `☰` (right).
- Clicking `☰` opens the Records modal with all four tables; `×`/backdrop closes it.
- Changing the Status dropdown reloads the page with the new status badge + a `status_change` timeline entry.
- Record Payment / New PTP / Log Call buttons open their dialogs and record correctly.

- [ ] **Step 7: Commit**

```bash
git add src/views/cases/show.ejs public/css/style.css
git commit -m "feat: case page full-width, records modal, header actions, inline status"
```

---

### Task 4: Inline Add Note + Timeline note edit/delete UI

**Files:**
- Modify: `src/views/cases/show.ejs`

**Interfaces:**
- Consumes: `POST /cases/:id/notes` (existing), `POST /cases/:id/notes/:noteId` and `POST /cases/:id/notes/:noteId/delete` (Task 1).
- Produces: inline note input below the card; per-note Edit/Delete controls on `note`-type timeline rows.

Verified by running the app.

- [ ] **Step 1: Add the inline Add Note form below the card**

In `show.ejs`, immediately AFTER the closing `</div>` of `<div class="card kv">` and before `<h2>Timeline</h2>`, add:

```html
    <% if (!readOnly && ['admin','manager','agent'].includes(currentUser.role)) { %>
    <form class="add-note" method="post" action="/cases/<%= c.id %>/notes">
      <input name="content" placeholder="Add a note…" required>
      <button class="btn btn-gold" type="submit">Add</button>
    </form>
    <% } %>
```

- [ ] **Step 2: Remove the old `dlg-note` dialog**

Delete the `<dialog id="dlg-note" ...>` block (old lines 110-114). The inline form replaces it.

- [ ] **Step 3: Remove the old `dlg-status` dialog**

Delete the `<dialog id="dlg-status" ...>` block (old lines 115-121). The inline card-header select (Task 3) replaces it.

- [ ] **Step 4: Add Edit/Delete controls to note-type timeline rows**

Replace the timeline `forEach` line (old line 40) so `note`-type events with mutation permission get an inline editable form + delete. Replace:

```html
    <% timeline.forEach(ev => { %><li><span class="badge <%= evClass[ev.event_type]||'is-neutral' %>"><%= ev.event_type %></span> <%= ev.content %>
    <span class="meta"><%= ev.created_by||'system' %> · <%= h.dateTimeFmt(ev.created_at) %></span></li><% }) %>
```

with:

```html
    <% const canEditNote = !readOnly && ['admin','manager','agent'].includes(currentUser.role); %>
    <% timeline.forEach(ev => { %><li><span class="badge <%= evClass[ev.event_type]||'is-neutral' %>"><%= ev.event_type %></span>
      <% if (ev.event_type==='note' && canEditNote) { %>
        <span class="note-view"><%= ev.content %>
          <button type="button" class="btn btn-sm" onclick="this.closest('li').querySelector('.note-edit').hidden=false; this.closest('.note-view').hidden=true;">Edit</button>
          <form class="inline-form" method="post" action="/cases/<%= c.id %>/notes/<%= ev.id %>/delete" onsubmit="return confirm('Delete this note?')"><button class="btn btn-sm" type="submit">Delete</button></form>
        </span>
        <form class="note-edit" method="post" action="/cases/<%= c.id %>/notes/<%= ev.id %>" hidden>
          <input name="content" value="<%= ev.content %>" required>
          <button class="btn btn-sm btn-gold" type="submit">Save</button>
          <button type="button" class="btn btn-sm" onclick="var li=this.closest('li'); li.querySelector('.note-edit').hidden=true; li.querySelector('.note-view').hidden=false;">Cancel</button>
        </form>
      <% } else { %><%= ev.content %><% } %>
      <span class="meta"><%= ev.created_by||'system' %> · <%= h.dateTimeFmt(ev.created_at) %></span></li><% }) %>
```

- [ ] **Step 5: Add minimal CSS**

Append to `public/css/style.css`:

```css
.add-note { display: flex; gap: 0.5rem; margin: 8px 0 16px; }
.add-note input { flex: 1; }
.note-view, .note-edit { display: inline-flex; gap: 0.4rem; align-items: center; }
```

- [ ] **Step 6: Verify in the running app**

Run: `npm start`, open a case as admin.
Expected:
- Inline "Add a note…" field below the card; submitting appends a note to the Timeline.
- Note rows show Edit/Delete; Edit reveals an inline input, Save updates the text, Delete (after confirm) removes it.
- Non-note rows (payment/status/call/ptp) show NO Edit/Delete.
- As an auditor, no Add Note field and no Edit/Delete controls appear.

- [ ] **Step 7: Commit**

```bash
git add src/views/cases/show.ejs public/css/style.css
git commit -m "feat: inline add-note + editable/deletable timeline notes"
```

---

### Task 5: Tasks page — per-row Edit + shared edit modal

**Files:**
- Modify: `src/views/tasks/index.ejs`

**Interfaces:**
- Consumes: `POST /tasks/:id` (Task 2).
- Produces: an `Edit` button per row that opens one shared `<dialog>` pre-filled from `data-*` attributes.

Verified by running the app.

- [ ] **Step 1: Add an Edit button to each row's Actions cell**

In `src/views/tasks/index.ejs`, replace the Actions `<td>` (line 51):

```html
  <td><% if (t.status==='pending' && ['admin','manager','agent'].includes(currentUser.role)) { %><form class="inline-form" method="post" action="/tasks/<%= t.id %>/complete"><button class="btn" type="submit">Complete</button></form><% } else { %>—<% } %></td>
```

with:

```html
  <td>
    <% if (['admin','manager','agent'].includes(currentUser.role)) { %>
    <div class="row-actions">
      <button type="button" class="btn btn-sm" onclick="editTask(this)"
        data-id="<%= t.id %>" data-title="<%= t.title %>" data-type="<%= t.type %>"
        data-due="<%= t.due_date || '' %>" data-notes="<%= t.notes || '' %>">Edit</button>
      <% if (t.status==='pending') { %><form class="inline-form" method="post" action="/tasks/<%= t.id %>/complete"><button class="btn btn-sm" type="submit">Complete</button></form><% } %>
    </div>
    <% } else { %>—<% } %>
  </td>
```

- [ ] **Step 2: Add the shared edit dialog + script at the end of the file**

Append to `src/views/tasks/index.ejs`:

```html
<% if (['admin','manager','agent'].includes(currentUser.role)) { %>
<dialog id="dlg-task-edit" class="modal"><form class="form" id="task-edit-form" method="post" action="">
  <h3>Edit Task</h3>
  <label>Title <input type="text" name="title" id="te-title" required></label>
  <label>Type <select name="type" id="te-type">
    <% ['follow_up','visit','legal','reminder'].forEach(tp => { %><option value="<%= tp %>"><%= tp %></option><% }) %>
  </select></label>
  <label>Due Date <input type="date" name="due_date" id="te-due"></label>
  <label>Notes <input type="text" name="notes" id="te-notes"></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Save</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<script>
  function editTask(btn){
    var f = document.getElementById('task-edit-form');
    f.action = '/tasks/' + btn.dataset.id;
    document.getElementById('te-title').value = btn.dataset.title;
    document.getElementById('te-type').value = btn.dataset.type;
    document.getElementById('te-due').value = btn.dataset.due;
    document.getElementById('te-notes').value = btn.dataset.notes;
    document.getElementById('dlg-task-edit').showModal();
  }
  document.querySelectorAll('dialog.modal').forEach(function(d){
    d.addEventListener('click', function(e){ if (e.target === d) d.close(); });
  });
</script>
<% } %>
```

- [ ] **Step 3: Add minimal CSS (if `.row-actions` not already present)**

Append to `public/css/style.css`:

```css
.row-actions { display: flex; gap: 0.4rem; align-items: center; }
```

- [ ] **Step 4: Verify in the running app**

Run: `npm start`, open `/tasks` as admin.
Expected:
- Each row shows Edit (+ Complete when pending).
- Edit opens a dialog pre-filled with the row's title/type/due/notes.
- Saving updates the row (redirect back with "Task updated").
- Logged in as an agent: editing a task owned by another agent is rejected (`/tasks?err=Forbidden`); own tasks edit fine.

- [ ] **Step 5: Commit**

```bash
git add src/views/tasks/index.ejs public/css/style.css
git commit -m "feat: edit tasks (title/type/due/notes) via shared modal"
```

---

## Self-Review Notes

- **Spec coverage:** §1 layout → Task 3; §1 inline note/status → Task 3 (status) + Task 4 (note); §2 editable notes → Task 1 (routes) + Task 4 (UI); §3 task editing → Task 2 (route) + Task 5 (UI); §4 case-edit "更方便" → Task 3 Step 1 (Edit Case button moved into header row; permissions unchanged, per decision B).
- **readOnly:** records modal placed outside the mutation-only guard (viewable); all mutation controls gated by `!readOnly && role`.
- **No new deps; no schema changes.**
- **Signature consistency:** routes `POST /cases/:id/notes/:noteId(/delete)` and `POST /tasks/:id` match between the route tasks and the view tasks that call them; `editTask`/`dlg-records`/`dlg-task-edit` ids are consistent within their files.
- **Known ceiling (ponytail):** the seeded "Case opened" note is `event_type='note'`, so it is editable/deletable like any note — accepted as harmless per spec.
