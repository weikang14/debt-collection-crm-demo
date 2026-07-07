# PTP / Status Logic Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four logic gaps — PTP-create validation, break-PTP status revert (+ overdue-PTP tile), case-edit status re-run, and dashboard overdue-task scope — in a server-rendered Express + node:sqlite CRM.

**Architecture:** Extract the PTP break logic into a testable `breakPtp(ptpId, req)` in `ptps.js`; reuse the existing `validatePayment` and `statusAfterPayment` helpers; a query/scope fix + one KPI tile on the dashboard. No schema change, no new dependencies.

**Tech Stack:** Node 22, Express 4, node:sqlite `DatabaseSync` (via `src/db`), `node --test`.

## Global Constraints

- No new npm dependencies. DB access only via `src/db` helpers (`get`, `all`, `run`).
- PTP and payment amounts are recorded EXACTLY (via `validatePayment`, which never rounds). Overpayment / over-outstanding is blocked.
- Break-PTP status revert target is `negotiation`, only when the case status is exactly `'ptp'` AND no `pending` PTP remains.
- Malaysia time (UTC+8) for all "today"/overdue date comparisons: `date('now','+8 hours')`.
- The overdue-tasks definition matches the Tasks page: `status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')`.
- Fake `req` objects in tests must include `session.user.username` and `ip` so `logAction` binds cleanly (no `audit failed` noise).
- Run one test file: `node --test test/<file>.test.js`. Full suite: `npm test`.

---

### Task 1: `breakPtp` — extract + status revert (#4a)

**Files:**
- Modify: `src/routes/ptps.js` (break route ~lines 48-56; exports at bottom)
- Test: `test/ptp_status.test.js` (create)

**Interfaces:**
- Consumes: `get`, `run`, `logAction` (already imported in `ptps.js`).
- Produces: `breakPtp(ptpId, req)` → `{ ok: true, caseId }` or `{ ok: false, error }`. Side effect: marks the PTP `broken`, writes a `ptp_broken` timeline event, and — if the case status is exactly `'ptp'` and no `pending` PTP remains — sets status to `'negotiation'` with a `status_change` timeline event. Exported as `module.exports.breakPtp`.

- [ ] **Step 1: Write the failing test**

Create `test/ptp_status.test.js`:

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-ptpstatus-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();
const { breakPtp } = require('../src/routes/ptps');

const req = { session: { user: { full_name: 'Tester', username: 'tester' } }, ip: '127.0.0.1' };

test('breaking the only pending PTP reverts case status ptp -> negotiation', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  db.run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  const p = db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 100, '2026-08-01', 'pending', 'Tester']);
  const r = breakPtp(p.lastInsertRowid, req);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [p.lastInsertRowid]).status, 'broken');
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'negotiation');
});

test('breaking one PTP while another is still pending keeps status ptp', () => {
  const c = db.get('SELECT id FROM cases WHERE id NOT IN (SELECT id FROM cases LIMIT 1) LIMIT 1');
  db.run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  const p1 = db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 100, '2026-08-01', 'pending', 'Tester']);
  db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 200, '2026-09-01', 'pending', 'Tester']);
  breakPtp(p1.lastInsertRowid, req);
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'ptp');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ptp_status.test.js`
Expected: FAIL — `breakPtp` is not exported / not a function.

- [ ] **Step 3: Implement `breakPtp` and call it from the route**

In `src/routes/ptps.js`, add the function (near `recordFulfillment`):

```js
function breakPtp(ptpId, req) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [ptpId]);
  if (!ptp) return { ok: false, error: 'PTP not found' };
  run("UPDATE ptps SET status='broken' WHERE id=?", [ptp.id]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
    [ptp.case_id, 'ptp_broken', `PTP broken (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_broken', 'case', ptp.case_id, `PTP ${ptp.id} broken`);
  const cur = get('SELECT status FROM cases WHERE id=?', [ptp.case_id]).status;
  const pending = get("SELECT COUNT(*) c FROM ptps WHERE case_id=? AND status='pending'", [ptp.case_id]).c;
  if (cur === 'ptp' && pending === 0) {
    run("UPDATE cases SET status='negotiation', updated_at=datetime('now') WHERE id=?", [ptp.case_id]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [ptp.case_id, 'status_change', 'Status changed ptp → negotiation', req.session.user.full_name]);
  }
  return { ok: true, caseId: ptp.case_id };
}
```

Replace the break route body (currently lines 48-56) with:

```js
router.post('/:id/break', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const caseId = loadScopedCaseId(req, res); if (caseId === null) return;
  breakPtp(req.params.id, req);
  res.redirect(`/cases/${caseId}?ok=PTP+broken`);
});
```

At the bottom of the file, add to the exports (next to `module.exports.recordFulfillment`):

```js
module.exports.breakPtp = breakPtp;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ptp_status.test.js`
Expected: PASS (both tests), no `audit failed` noise.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass (existing `ptp_fulfill.test.js` unaffected — it doesn't break PTPs).

- [ ] **Step 6: Commit**

```bash
git add src/routes/ptps.js test/ptp_status.test.js
git commit -m "fix: breaking last pending PTP reverts case status ptp -> negotiation"
```

---

### Task 2: Case edit re-runs status (#5)

**Files:**
- Modify: `src/routes/cases.js` (imports; `POST /:id` route ~lines 90-101)
- Test: `test/ptp_status.test.js` (append)

**Interfaces:**
- Consumes: `recomputeOutstanding`, `statusAfterPayment` from `src/services/payments.js`; `get`, `run` (already imported).
- Produces: editing a case recomputes outstanding AND re-evaluates status via `statusAfterPayment`, updating status + writing a `status_change` timeline event when it changes.

- [ ] **Step 1: Write the failing test**

Append to `test/ptp_status.test.js`:

```js
const { applyPayment, recomputeOutstanding, statusAfterPayment } = require('../src/services/payments');

test('lowering principal below amount already paid flips status to fully_paid', () => {
  const c = db.get('SELECT id FROM cases ORDER BY id DESC LIMIT 1');
  db.run("UPDATE cases SET principal_amount=1000, interest_amount=0, outstanding_amount=1000, status='negotiation' WHERE id=?", [c.id]);
  applyPayment(c.id, { payment_date: '2026-07-07', amount: 600, method: 'cash' }, req); // -> partial_paid, outstanding 400
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'partial_paid');
  // simulate the edit route's post-update recompute+status logic (principal lowered to 500 < 600 paid):
  db.run("UPDATE cases SET principal_amount=500 WHERE id=?", [c.id]);
  const outstanding = recomputeOutstanding(c.id);
  const paidCount = db.get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [c.id]).c;
  const cur = db.get('SELECT status FROM cases WHERE id=?', [c.id]).status;
  const next = statusAfterPayment(cur, outstanding, paidCount);
  assert.strictEqual(next, 'fully_paid');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ptp_status.test.js`
Expected: FAIL — `statusAfterPayment` / `recomputeOutstanding` are not exported by name yet? They ARE exported (`module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, applyPayment }`). So this test should PASS immediately, proving the *logic* is sound. It locks the behavior the route must wire. (If it fails, the assertion caught a real logic error — fix before proceeding.)

- [ ] **Step 3: Wire the logic into the edit route**

In `src/routes/cases.js`, change the payments-service import to also pull `statusAfterPayment`. The current line is:

```js
const { recomputeOutstanding, TERMINAL_STATUSES } = require('../services/payments');
```

Change it to:

```js
const { recomputeOutstanding, statusAfterPayment, TERMINAL_STATUSES } = require('../services/payments');
```

In the `POST /:id` edit route, replace the `recomputeOutstanding(...)` + `logAction` tail (currently lines 98-100) with:

```js
  const cid = Number(req.params.id);
  const outstanding = recomputeOutstanding(cid);
  const paidCount = get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [cid]).c;
  const cur = get('SELECT status FROM cases WHERE id=?', [cid]).status;
  const next = statusAfterPayment(cur, outstanding, paidCount);
  if (next !== cur) {
    run('UPDATE cases SET status=? WHERE id=?', [next, cid]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [cid, 'status_change', `Status changed ${cur} → ${next}`, req.session.user.full_name]);
  }
  logAction(req, 'update', 'case', cid, `Updated case ${cid}`);
  res.redirect(`/cases/${cid}?ok=Saved`);
```

(This replaces the old `recomputeOutstanding(Number(req.params.id));` line, the `logAction(...)` line, and the `res.redirect(...)` line — do not leave duplicates.)

- [ ] **Step 4: Run test + full suite**

Run: `node --test test/ptp_status.test.js` → Expected: PASS.
Run: `npm test` → Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/cases.js test/ptp_status.test.js
git commit -m "fix: case edit re-evaluates status after recomputing outstanding"
```

---

### Task 3: PTP creation validation (A)

**Files:**
- Modify: `src/routes/cases.js` (`POST /:id/ptps` route ~lines 125-131)

**Interfaces:**
- Consumes: `validatePayment` (already imported in `cases.js`), `c.outstanding_amount` from `loadCase`.
- Produces: `POST /cases/:id/ptps` rejects invalid or over-outstanding amounts with `?err=` before any write; inserts `v.amount` (exact).

- [ ] **Step 1: Replace the PTP create route**

In `src/routes/cases.js`, replace the `POST /:id/ptps` route body with:

```js
router.post('/:id/ptps', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const v = validatePayment(req.body.amount, c.outstanding_amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
  const by = req.session.user.full_name;
  run('INSERT INTO ptps (case_id,amount,due_date,remark,created_by) VALUES (?,?,?,?,?)', [c.id, v.amount, req.body.due_date, req.body.remark||null, by]);
  if (!TERMINAL_STATUSES.includes(c.status)) run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'ptp_created',`PTP RM ${v.amount.toFixed(2)} due ${req.body.due_date}`,by]);
  logAction(req,'ptp_create','case',c.id,`PTP created for case ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=PTP+created`);
});
```

- [ ] **Step 2: Live-verify the guard**

```bash
export CRM_DB_PATH="$(mktemp -d)/ptpsmoke.db"
node -e "const db=require('./src/db');db.init();require('./src/db/seed').seedDemo();"
PORT=3212 node --no-warnings src/app.js & SRV=$!
sleep 2
J=$(mktemp); curl -s -c $J -d 'username=admin&password=admin123' http://localhost:3212/login -o /dev/null
CID=$(curl -s -b $J http://localhost:3212/cases | grep -oE '/cases/[0-9]+' | head -1 | grep -oE '[0-9]+')
BEFORE=$(node -e "process.env.CRM_DB_PATH='$CRM_DB_PATH';const db=require('./src/db');console.log(db.get('SELECT COUNT(*) c FROM ptps WHERE case_id=?',[$CID]).c)")
curl -s -b $J -o /dev/null -w "negative -> %{redirect_url}\n" -d "amount=-50&due_date=2026-08-01" http://localhost:3212/cases/$CID/ptps
curl -s -b $J -o /dev/null -w "overpay -> %{redirect_url}\n" -d "amount=99999999&due_date=2026-08-01" http://localhost:3212/cases/$CID/ptps
AFTER=$(node -e "process.env.CRM_DB_PATH='$CRM_DB_PATH';const db=require('./src/db');console.log(db.get('SELECT COUNT(*) c FROM ptps WHERE case_id=?',[$CID]).c)")
echo "ptp count before=$BEFORE after=$AFTER (expect equal)"
kill $SRV; rm -f $J
```

Expected: both redirect URLs contain `err=Invalid+amount` and `err=Amount+exceeds+outstanding`; `before == after` (no PTP rows written).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass (no test targets this route directly; confirms no breakage).

- [ ] **Step 4: Commit**

```bash
git add src/routes/cases.js
git commit -m "fix: validate PTP creation amount (block invalid + over-outstanding)"
```

---

### Task 4: Dashboard — overdue-PTP tile (#4b) + overdue-task scope (#7)

**Files:**
- Modify: `src/routes/dashboard.js`
- Modify: `src/views/dashboard/index.ejs`

**Interfaces:**
- Consumes: `get`, `caseWhere`, `req.session.user`.
- Produces: `kpi.overduePtp` (count) and a corrected `kpi.overdueTasks` (scoped like the Tasks page, incl. case-less tasks); a new "Overdue PTP" tile.

- [ ] **Step 1: Add the overdue-PTP KPI and fix overdue-task scope (`src/routes/dashboard.js`)**

Add an overdue-PTP count next to the existing `brokenPtp` line:

```js
  const overduePtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND date(t.due_date) < date('now','+8 hours')`, w.params).c;
```

Replace the existing `overdueTasks` line (the one that does `FROM tasks t JOIN cases c ...`) with an agent-vs-all scope that includes case-less tasks:

```js
  const u = req.session.user;
  const overdueTasks = (u.role === 'agent')
    ? get("SELECT COUNT(*) c FROM tasks WHERE agent_id=? AND status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')", [u.agent_id]).c
    : get("SELECT COUNT(*) c FROM tasks WHERE status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')").c;
```

(Note: `const u = req.session.user;` may already exist at the top of the handler — if so, reuse it and don't redeclare. `dashboard.js` currently declares `const u = req.session.user;` as the first line of the handler, so just add the `overdueTasks` reassignment without re-declaring `u`.)

Add `overduePtp` to the `kpi` object in the `res.render(...)` call:

```js
  res.render('dashboard/index', { title: 'Dashboard', kpi: { outstanding, legalCount, openedToday, closedToday, collectedToday, ptpToday, brokenPtp, overduePtp, overdueTasks }, leaderboard, recent });
```

- [ ] **Step 2: Add the tile (`src/views/dashboard/index.ejs`)**

After the "Broken PTP" tile (line 11), add:

```html
  <div class="tile"><div class="label">Overdue PTP</div><div class="value"><%= kpi.overduePtp %></div></div>
```

- [ ] **Step 3: Verify the dashboard boots and scope is correct**

```bash
export CRM_DB_PATH="$(mktemp -d)/dash.db"
node -e "const db=require('./src/db');db.init();require('./src/db/seed').seedDemo();"
PORT=3213 node --no-warnings src/app.js & SRV=$!
sleep 2
J=$(mktemp); curl -s -c $J -d 'username=admin&password=admin123' http://localhost:3213/login -o /dev/null
curl -s -b $J http://localhost:3213/ | grep -c "Overdue PTP" | sed 's/^/admin dashboard "Overdue PTP" tiles: /'
JA=$(mktemp); curl -s -c $JA -d 'username=agent1&password=agent123' http://localhost:3213/login -o /dev/null
curl -s -b $JA -o /dev/null -w "agent1 dashboard -> %{http_code}\n" http://localhost:3213/
kill $SRV; rm -f $J $JA
```

Expected: `admin dashboard "Overdue PTP" tiles: 1` and `agent1 dashboard -> 200` (both roles render without error).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/dashboard.js src/views/dashboard/index.ejs
git commit -m "feat: dashboard overdue-PTP tile; overdue-tasks scoped like Tasks page"
```

---

## Self-Review Notes

- **Spec coverage:** A (PTP-create validation) → Task 3; #4a (break revert) → Task 1; #4b (overdue-PTP tile) → Task 4; #5 (edit re-runs status) → Task 2; #7 (overdue-task scope) → Task 4. All covered.
- **Placeholder scan:** none — every code step has complete code.
- **Signature consistency:** `breakPtp(ptpId, req) → {ok, caseId|error}` (Task 1) matches its export and test. `validatePayment` / `statusAfterPayment` / `recomputeOutstanding` are consumed with the same signatures they already have in the codebase. `kpi.overduePtp` (route) matches `kpi.overduePtp` (view).
- **Test hygiene:** fake `req` includes `username` + `ip` (avoids the `audit failed` noise seen in the prior batch).
- **Accepted edge (from spec):** editing a case to `principal=0` with no payments → `fully_paid` via the shared rule; admin-only, left as-is.
- **Out of scope:** `recordFulfillment` orphan-atomicity, #8/#9/#10, aging buckets.
