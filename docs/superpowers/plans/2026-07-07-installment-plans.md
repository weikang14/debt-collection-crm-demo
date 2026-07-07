# Installment Repayment Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user generate a multi-installment repayment plan on a case — one total split into N monthly PTP rows — reusing the existing PTP fulfill/break/status machinery unchanged.

**Architecture:** A plan is *N grouped PTP rows* sharing a `plan_id`. A pure util splits the total into cent-exact amounts and generates monthly due dates; a new route inserts the rows in one transaction; per-installment fulfill/break are the existing PTP routes; a plan-level cancel breaks all pending rows at once. Display groups PTP rows by plan in the case-show Records dialog.

**Tech Stack:** Node.js ≥22.5, `node:sqlite` (`DatabaseSync`), Express 4, EJS/`ejs-mate`, `dayjs`, `node:test`.

## Global Constraints

- Node.js ≥ 22.5 (`node:sqlite` without `--experimental-sqlite`).
- No new npm dependencies. `dayjs` is already a dependency; use it for month arithmetic.
- Money: payment/PTP amounts are never rounded except deliberate cent-splitting; a split's rows must sum **exactly** to the total.
- DB writes that must be atomic use `db.transaction(fn)()` (from `src/db/index.js`); `node:sqlite` has no nested transactions.
- Tests run with `npm test` (`node --no-warnings --test`); DB tests isolate via `CRM_DB_PATH` env pointing at a temp file.
- `plan_id` NULL on a `ptps` row means a standalone single PTP — existing behavior must be byte-for-byte unchanged for such rows.
- Reuse `validatePayment(rawAmount, outstanding)` from `src/utils/forms.js` for total validation.
- Migrations follow the existing `init()` pattern in `src/db/index.js`: `try { ALTER TABLE ... ADD COLUMN } catch {}`.

---

## File Structure

- **Create** `src/utils/installments.js` — pure functions: `splitInstallments(total, n)`, `dueDates(firstDate, n)`. No DB. Unit-tested like `utils/aging.js`.
- **Create** `test/installments.test.js` — unit tests for the pure util.
- **Create** `test/installment_plans.test.js` — integration tests for generation + cancel + fulfill interaction (isolated DB).
- **Modify** `src/db/schema.sql` — add 3 columns to the `ptps` CREATE.
- **Modify** `src/db/index.js` — add 3 `ALTER TABLE ptps ADD COLUMN` migrations in `init()`.
- **Modify** `src/routes/cases.js` — add `POST /:id/ptp-plans` and `POST /:id/ptp-plans/:planId/cancel`; group PTPs for the show view.
- **Modify** `src/views/cases/show.ejs` — group PTP rows by plan, add "New Plan" button + dialog, add "Cancel plan" button.

---

### Task 1: Pure util — `splitInstallments` and `dueDates`

**Files:**
- Create: `src/utils/installments.js`
- Test: `test/installments.test.js`

**Interfaces:**
- Produces:
  - `splitInstallments(total: number, n: number) => number[]` — length `n`; each > 0; sum **exactly equals** `round2(total)`; first `n-1` equal to `floor(total/n)` at cent precision, last absorbs remainder. Throws `Error` if `total <= 0` or `n` is not an integer in `[2, 60]`.
  - `dueDates(firstDate: string /* 'YYYY-MM-DD' */, n: number) => string[]` — length `n`; `dueDates[k]` = `firstDate` plus `k` months, formatted `YYYY-MM-DD`.

- [ ] **Step 1: Write the failing test**

Create `test/installments.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { splitInstallments, dueDates } = require('../src/utils/installments');

test('splitInstallments: even split sums to total', () => {
  const parts = splitInstallments(10000, 5);
  assert.deepStrictEqual(parts, [2000, 2000, 2000, 2000, 2000]);
  assert.strictEqual(parts.reduce((s, x) => s + x, 0), 10000);
});

test('splitInstallments: remainder goes to last, sum exact', () => {
  const parts = splitInstallments(10003, 3);
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0], 3334.33);
  assert.strictEqual(parts[1], 3334.33);
  assert.strictEqual(parts[2], 3334.34);
  assert.strictEqual(Math.round(parts.reduce((s, x) => s + x, 0) * 100), 1000300);
  parts.forEach(p => assert.ok(p > 0));
});

test('splitInstallments: rejects bad inputs', () => {
  assert.throws(() => splitInstallments(0, 3));
  assert.throws(() => splitInstallments(-5, 3));
  assert.throws(() => splitInstallments(100, 1));
  assert.throws(() => splitInstallments(100, 61));
  assert.throws(() => splitInstallments(100, 2.5));
});

test('dueDates: monthly cadence, length n', () => {
  const ds = dueDates('2026-08-01', 5);
  assert.deepStrictEqual(ds, ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
});

test('dueDates: month-end rolls back (Jan 31 -> Feb 28)', () => {
  const ds = dueDates('2026-01-31', 2);
  assert.strictEqual(ds[0], '2026-01-31');
  assert.strictEqual(ds[1], '2026-02-28');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --no-warnings --test test/installments.test.js`
Expected: FAIL — `Cannot find module '../src/utils/installments'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/installments.js`:

```js
const dayjs = require('dayjs');

const round2 = (n) => Math.round(n * 100) / 100;

// Split `total` into `n` cent-exact installments. First n-1 use the
// floor-to-cent base; the last absorbs the remainder so the array sums to
// exactly round2(total) — no rounding drift across a plan.
function splitInstallments(total, n) {
  if (!(total > 0)) throw new Error('total must be > 0');
  if (!Number.isInteger(n) || n < 2 || n > 60) throw new Error('installments must be an integer 2..60');
  const t = round2(total);
  const base = Math.floor((t / n) * 100) / 100;
  const parts = Array(n - 1).fill(base);
  const last = round2(t - base * (n - 1));
  parts.push(last);
  return parts;
}

// N monthly due dates starting at firstDate ('YYYY-MM-DD'). dayjs handles
// month-end (Jan 31 + 1 month = Feb 28).
function dueDates(firstDate, n) {
  const start = dayjs(firstDate);
  return Array.from({ length: n }, (_, k) => start.add(k, 'month').format('YYYY-MM-DD'));
}

module.exports = { splitInstallments, dueDates };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx node --no-warnings --test test/installments.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/installments.js test/installments.test.js
git commit -m "feat: installments util — cent-exact split + monthly due dates"
```

---

### Task 2: Schema + migration for grouped PTPs

**Files:**
- Modify: `src/db/schema.sql` (the `ptps` CREATE, around lines 87-95)
- Modify: `src/db/index.js:39-40` (add migrations in `init()`)
- Test: `test/installment_plans.test.js` (schema smoke test)

**Interfaces:**
- Produces: `ptps` table gains nullable columns `plan_id TEXT`, `installment_no INTEGER`, `plan_size INTEGER`. Existing rows and inserts that omit them get NULL — unchanged behavior.

- [ ] **Step 1: Write the failing test**

Create `test/installment_plans.test.js`:

```js
const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolated DB per run.
process.env.CRM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-inst-')), 'crm.db');
const { db, init, get, all, run } = require('../src/db');

before(() => { init(); });

test('ptps has plan grouping columns', () => {
  const cols = all('PRAGMA table_info(ptps)').map(c => c.name);
  assert.ok(cols.includes('plan_id'));
  assert.ok(cols.includes('installment_no'));
  assert.ok(cols.includes('plan_size'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --no-warnings --test test/installment_plans.test.js`
Expected: FAIL — `plan_id` not in column list.

- [ ] **Step 3a: Update `schema.sql`**

In `src/db/schema.sql`, change the `ptps` CREATE to include the three columns (add after the `remark TEXT, created_by TEXT,` line):

```sql
CREATE TABLE IF NOT EXISTS ptps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  amount REAL NOT NULL, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','broken')),
  remark TEXT, created_by TEXT,
  plan_id TEXT, installment_no INTEGER, plan_size INTEGER,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 3b: Add migrations in `index.js`**

In `src/db/index.js`, immediately after the `next_action_at` migration line (currently line 40), add:

```js
  // Migration: installment-plan grouping on ptps (nullable; NULL = standalone PTP)
  try { db.prepare('ALTER TABLE ptps ADD COLUMN plan_id TEXT').run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE ptps ADD COLUMN installment_no INTEGER').run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE ptps ADD COLUMN plan_size INTEGER').run(); } catch (e) { /* exists */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx node --no-warnings --test test/installment_plans.test.js`
Expected: PASS — schema column test.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/installment_plans.test.js
git commit -m "feat: add plan_id/installment_no/plan_size to ptps (schema + migration)"
```

---

### Task 3: Generate-plan route — `POST /cases/:id/ptp-plans`

**Files:**
- Modify: `src/routes/cases.js` (add route after the existing `POST /:id/ptps`, ~line 174)
- Test: `test/installment_plans.test.js` (append)

**Interfaces:**
- Consumes: `splitInstallments`, `dueDates` (Task 1); `validatePayment` (`src/utils/forms.js`); `TERMINAL_STATUSES` (already imported in `cases.js`); `next... ` not needed (PTPs have no receipt number).
- Produces: route `POST /cases/:id/ptp-plans` with body `{ total_amount, num_installments, first_due_date }`. On success inserts N `ptps` rows (same `crypto.randomUUID()` `plan_id`, `installment_no` 1..N, `plan_size` N, `status='pending'`), sets case → `ptp` if not terminal, writes one timeline event, logs `ptp_plan_create`, redirects `/cases/:id?ok=...`. On validation error redirects `/cases/:id?err=...`.

- [ ] **Step 1: Write the failing test**

Append to `test/installment_plans.test.js`. First add a small seed helper + fake req near the top (after `before`), then the tests:

```js
// --- helpers: seed a client/debtor/case directly (no HTTP) ---
function seedCase(principal, interest) {
  const cl = run("INSERT INTO clients (company_name, commission_rate) VALUES ('T', 0)").lastInsertRowid;
  const d = run("INSERT INTO debtors (name) VALUES ('D')").lastInsertRowid;
  const out = principal + interest;
  const r = run(`INSERT INTO cases (case_no, client_id, debtor_id, principal_amount, interest_amount, outstanding_amount, status)
    VALUES (?,?,?,?,?,?, 'negotiation')`, ['C-' + Date.now() + Math.random(), cl, d, principal, interest, out]);
  return r.lastInsertRowid;
}
const fakeReq = (body) => ({ body, session: { user: { full_name: 'Tester', role: 'admin' } }, params: {}, ip: '::1' });

test('generate plan: N pending rows share plan_id, sum = total, case -> ptp', () => {
  const cid = seedCase(10000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const res = createPtpPlan(cid, { total_amount: '10000', num_installments: '5', first_due_date: '2026-08-01' }, fakeReq({}));
  assert.strictEqual(res.ok, true);
  const rows = all("SELECT * FROM ptps WHERE case_id=? AND status='pending' ORDER BY installment_no", [cid]);
  assert.strictEqual(rows.length, 5);
  const planIds = new Set(rows.map(r => r.plan_id));
  assert.strictEqual(planIds.size, 1);
  assert.ok([...planIds][0]);
  assert.deepStrictEqual(rows.map(r => r.installment_no), [1, 2, 3, 4, 5]);
  assert.strictEqual(Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100), 1000000);
  assert.strictEqual(get('SELECT status FROM cases WHERE id=?', [cid]).status, 'ptp');
});

test('generate plan: total over outstanding is rejected, no rows inserted', () => {
  const cid = seedCase(1000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const res = createPtpPlan(cid, { total_amount: '5000', num_installments: '3', first_due_date: '2026-08-01' }, fakeReq({}));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(all('SELECT * FROM ptps WHERE case_id=?', [cid]).length, 0);
});

test('generate plan: bad installment count is rejected', () => {
  const cid = seedCase(1000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const res = createPtpPlan(cid, { total_amount: '900', num_installments: '1', first_due_date: '2026-08-01' }, fakeReq({}));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(all('SELECT * FROM ptps WHERE case_id=?', [cid]).length, 0);
});
```

Note: the route delegates to a testable `createPtpPlan(caseId, body, req)` helper (like `payments.js` splits logic from the HTTP handler). The HTTP route is a thin wrapper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --no-warnings --test test/installment_plans.test.js`
Expected: FAIL — `createPtpPlan is not a function`.

- [ ] **Step 3: Implement `createPtpPlan` + route**

In `src/routes/cases.js`, add the requires near the other utils at top:

```js
const { splitInstallments, dueDates } = require('../utils/installments');
const crypto = require('node:crypto');
```

Add the helper and route after the existing `POST /:id/ptps` handler (after ~line 174):

```js
// Generate an installment plan: split a total into N monthly PTP rows sharing a
// plan_id. Each row is a normal PTP — existing fulfill/break/status logic applies
// per installment. Returns { ok, error?, planId?, count? } for testability.
function createPtpPlan(caseId, body, req) {
  const c = get('SELECT id, outstanding_amount, status FROM cases WHERE id=?', [caseId]);
  if (!c) return { ok: false, error: 'Case not found' };
  const v = validatePayment(body.total_amount, c.outstanding_amount);
  if (v.error) return { ok: false, error: v.error };
  const n = Number(body.num_installments);
  if (!Number.isInteger(n) || n < 2 || n > 60) return { ok: false, error: 'Installments must be 2–60' };
  if (!body.first_due_date) return { ok: false, error: 'First due date is required' };
  const amounts = splitInstallments(v.amount, n);
  const dates = dueDates(body.first_due_date, n);
  const planId = crypto.randomUUID();
  const by = req.session.user.full_name;
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      run('INSERT INTO ptps (case_id,amount,due_date,status,remark,created_by,plan_id,installment_no,plan_size) VALUES (?,?,?,?,?,?,?,?,?)',
        [caseId, amounts[i], dates[i], 'pending', `Installment ${i + 1}/${n}`, by, planId, i + 1, n]);
    }
    if (!TERMINAL_STATUSES.includes(c.status)) run("UPDATE cases SET status='ptp' WHERE id=?", [caseId]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [caseId, 'ptp_created', `Installment plan created: RM ${v.amount.toFixed(2)} in ${n} installments`, by]);
  })();
  logAction(req, 'ptp_plan_create', 'case', caseId, `Installment plan (${n}) for case ${caseId}`);
  return { ok: true, planId, count: n };
}

router.post('/:id/ptp-plans', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = createPtpPlan(c.id, req.body, req);
  if (!r.ok) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${c.id}?ok=Installment+plan+created`);
});
```

At the bottom of `cases.js`, extend the export (currently `module.exports = { router, loadCase };`):

```js
module.exports = { router, loadCase, createPtpPlan };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx node --no-warnings --test test/installment_plans.test.js`
Expected: PASS — generation tests green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/cases.js test/installment_plans.test.js
git commit -m "feat: generate installment plan route (split total into N PTP rows)"
```

---

### Task 4: Cancel-plan route + fulfill-interaction test

**Files:**
- Modify: `src/routes/cases.js` (add after the generate route)
- Test: `test/installment_plans.test.js` (append)

**Interfaces:**
- Consumes: `resyncCaseStatus` (already imported in `cases.js`), `recordFulfillment` (from `routes/ptps.js`) for the interaction test only.
- Produces: `cancelPtpPlan(caseId, planId, req) => { ok, broken }` — breaks all pending rows of the plan in one transaction, one timeline event, then runs the existing revert check via `resyncCaseStatus`. Route `POST /cases/:id/ptp-plans/:planId/cancel`.

- [ ] **Step 1: Write the failing test**

Append to `test/installment_plans.test.js`:

```js
test('cancel plan: all pending broken, case ptp -> negotiation when none paid', () => {
  const cid = seedCase(9000, 0);
  const { createPtpPlan, cancelPtpPlan } = require('../src/routes/cases');
  const gen = createPtpPlan(cid, { total_amount: '9000', num_installments: '3', first_due_date: '2026-08-01' }, fakeReq({}));
  const res = cancelPtpPlan(cid, gen.planId, fakeReq({}));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.broken, 3);
  assert.strictEqual(all("SELECT * FROM ptps WHERE case_id=? AND status='pending'", [cid]).length, 0);
  assert.strictEqual(get('SELECT status FROM cases WHERE id=?', [cid]).status, 'negotiation');
});

test('fulfilling one installment lowers outstanding, case stays ptp while siblings pending', () => {
  const cid = seedCase(6000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const gen = createPtpPlan(cid, { total_amount: '6000', num_installments: '3', first_due_date: '2026-08-01' }, fakeReq({}));
  const first = get("SELECT id FROM ptps WHERE case_id=? ORDER BY installment_no LIMIT 1", [cid]);
  const { recordFulfillment } = require('../src/routes/ptps');
  const r = recordFulfillment(first.id, {}, fakeReq({}));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(get('SELECT status FROM cases WHERE id=?', [cid]).status, 'ptp');
  assert.strictEqual(Math.round(get('SELECT outstanding_amount o FROM cases WHERE id=?', [cid]).o * 100), 400000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --no-warnings --test test/installment_plans.test.js`
Expected: FAIL — `cancelPtpPlan is not a function`.

- [ ] **Step 3: Implement `cancelPtpPlan` + route**

In `src/routes/cases.js`, after the generate route add:

```js
// Cancel a whole installment plan: break every still-pending installment in one
// action, then let the shared status rule revert the case if nothing is left.
function cancelPtpPlan(caseId, planId, req) {
  const by = req.session.user.full_name;
  let broken = 0;
  db.transaction(() => {
    const r = run("UPDATE ptps SET status='broken' WHERE case_id=? AND plan_id=? AND status='pending'", [caseId, planId]);
    broken = r.changes;
    if (broken > 0) {
      run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
        [caseId, 'ptp_broken', `Installment plan cancelled (${broken} pending installment(s) broken)`, by]);
      resyncCaseStatus(caseId, by);
    }
  })();
  logAction(req, 'ptp_plan_cancel', 'case', caseId, `Cancelled installment plan ${planId} (${broken} broken)`);
  return { ok: true, broken };
}

router.post('/:id/ptp-plans/:planId/cancel', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  cancelPtpPlan(c.id, req.params.planId, req);
  res.redirect(`/cases/${c.id}?ok=Installment+plan+cancelled`);
});
```

Extend the export to include `cancelPtpPlan`:

```js
module.exports = { router, loadCase, createPtpPlan, cancelPtpPlan };
```

**Note on `resyncCaseStatus` + break:** breaking the pending rows sets outstanding-derived status. Because the plan had no payments here, `statusAfterPayment` sees `paymentCount === 0` and `outstanding > 0` and leaves a non-`fully_paid` status untouched — but the case is currently `ptp`. To mirror the existing single-PTP break revert (`ptp` → `negotiation` when no pending remains), `cancelPtpPlan` relies on the same rule already used by `breakPtp`. Verify the test asserts `negotiation`; if `resyncCaseStatus` alone does not revert `ptp`, add the same explicit revert `breakPtp` uses:

```js
      const cur = get('SELECT status FROM cases WHERE id=?', [caseId]).status;
      const pending = get("SELECT COUNT(*) c FROM ptps WHERE case_id=? AND status='pending'", [caseId]).c;
      if (cur === 'ptp' && pending === 0) {
        run("UPDATE cases SET status='negotiation', updated_at=datetime('now') WHERE id=?", [caseId]);
        run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
          [caseId, 'status_change', 'Status changed ptp → negotiation', by]);
      }
```

Prefer this explicit block over `resyncCaseStatus` for the revert, since it matches `breakPtp` exactly. Replace the `resyncCaseStatus(caseId, by);` call in the transaction with the block above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx node --no-warnings --test test/installment_plans.test.js`
Expected: PASS — cancel + fulfill-interaction tests green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/cases.js test/installment_plans.test.js
git commit -m "feat: cancel-plan route (batch-break pending installments + revert)"
```

---

### Task 5: Show-view grouping + New Plan / Cancel plan UI

**Files:**
- Modify: `src/routes/cases.js` (the `GET /:id` handler, ~line 104-114 — pass grouped PTPs)
- Modify: `src/views/cases/show.ejs` (PTP section ~line 107-120; add dialog + button)

**Interfaces:**
- Consumes: `ptps` rows with `plan_id`/`installment_no`/`plan_size` from Task 2.
- Produces: rendered PTP section groups installment rows under a plan header with a Cancel-plan button; standalone PTPs (null `plan_id`) render unchanged; a "New Plan" dialog posts to `/cases/:id/ptp-plans`.

This task is UI; it is verified by manual smoke test (no unit test — matches how existing EJS views are covered).

- [ ] **Step 1: Order PTPs by plan in the route**

In `src/routes/cases.js` `GET /:id`, change the ptps query so grouped rows are contiguous and ordered (currently `ORDER BY due_date DESC`):

```js
  const ptps = all("SELECT * FROM ptps WHERE case_id=? ORDER BY (plan_id IS NULL), plan_id, installment_no, due_date DESC", [c.id]);
```

- [ ] **Step 2: Group + render in the view**

In `src/views/cases/show.ejs`, replace the "Promise to Pay" `<section>` (currently lines ~107-120) with a version that emits a plan header when `plan_id` changes and labels installment rows. Full replacement block:

```html
    <section class="rec-section">
    <h2>Promise to Pay</h2>
    <% if (!ptps.length) { %><%- include('../partials/empty', { msg: 'No PTPs recorded.' }) %><% } else { %>
    <%
      // Group by plan_id for headers/progress. Nulls (standalone PTPs) stay ungrouped.
      const planGroups = {};
      ptps.forEach(p => { if (p.plan_id) { (planGroups[p.plan_id] ||= []).push(p); } });
      const canManagePtp = !readOnly && ['admin','manager','agent'].includes(currentUser.role);
      let lastPlan = undefined;
    %>
    <table class="data"><thead><tr><th>Installment</th><th class="num">Amount</th><th>Due Date</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody><% ptps.forEach(p => { %>
      <% if (p.plan_id && p.plan_id !== lastPlan) { lastPlan = p.plan_id;
           const g = planGroups[p.plan_id];
           const paid = g.filter(x => x.status==='fulfilled').length;
           const total = g.reduce((s,x)=>s+x.amount,0);
           const hasPending = g.some(x => x.status==='pending'); %>
      <tr class="plan-head"><td colspan="4"><b>Installment Plan</b> · RM <%= h.money(total) %> · <%= paid %>/<%= g[0].plan_size %> paid</td>
        <td><% if (hasPending && canManagePtp) { %>
          <form method="post" action="/cases/<%= c.id %>/ptp-plans/<%= p.plan_id %>/cancel" style="margin:0;" onsubmit="return confirm('Cancel this installment plan? All pending installments will be broken.')"><button class="btn btn-sm" type="submit">Cancel plan</button></form>
        <% } %></td></tr>
      <% } %>
      <tr><td><%= p.plan_id ? (p.installment_no + '/' + p.plan_size) : '—' %></td>
      <td class="num"><%= h.money(p.amount) %></td><td><%= h.dateFmt(p.due_date) %></td>
      <td><span class="badge <%= p.status==='fulfilled'?'is-green':p.status==='broken'?'is-red':'is-gold' %>"><%= p.status %></span></td>
      <td><% if (p.status==='pending' && canManagePtp) { %>
      <div style="display:flex; gap:0.5rem;">
        <button type="button" class="btn btn-sm" onclick="openFulfill(<%= p.id %>, <%= p.amount %>)">Fulfill</button>
        <form method="post" action="/ptps/<%= p.id %>/break" style="margin:0;"><button class="btn btn-sm" type="submit">Break</button></form>
      </div>
      <% } else { %>—<% } %></td></tr>
    <% }) %></tbody></table>
    <% } %>
    </section>
```

- [ ] **Step 3: Add the "New Plan" button + dialog**

In `show.ejs` head-actions, next to the existing New PTP button (line ~8), add:

```html
        <button type="button" class="btn" onclick="dlg('dlg-plan')">New Plan</button>
```

In the dialogs block guarded by `['admin','manager','agent'].includes(currentUser.role)` (after the `dlg-ptp` dialog, ~line 172), add:

```html
<dialog id="dlg-plan" class="modal"><form class="form" method="post" action="/cases/<%= c.id %>/ptp-plans">
  <h3>New Installment Plan</h3>
  <label>Total Amount (RM) <input type="number" step="0.01" min="0" name="total_amount" required></label>
  <label>Number of Installments <input type="number" min="2" max="60" step="1" name="num_installments" value="3" required></label>
  <label>First Due Date <input type="date" name="first_due_date" required></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Create Plan</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
```

- [ ] **Step 4: Smoke-test manually**

```bash
npm run reset && npm start
```

Then in the browser (http://localhost:3000, login `admin`/`admin123`):
1. Open a case with outstanding > 0 → **New Plan** → Total 9000, Installments 3, a future first date → Create.
   Expect: case badge shows `ptp`; Records dialog PTP section shows a "Installment Plan · RM 9,000.00 · 0/3 paid" header and rows `1/3, 2/3, 3/3` (RM 3,000 each).
2. **Fulfill** installment 1/3 → outstanding drops by 3,000; header shows `1/3 paid`; case still `ptp`.
3. **Cancel plan** → remaining pending rows show `broken`; case reverts to `negotiation`.
4. A standalone **New PTP** still renders with `—` in the Installment column and works as before.

- [ ] **Step 5: Commit**

```bash
git add src/routes/cases.js src/views/cases/show.ejs
git commit -m "feat: installment plan UI — grouped PTP rows, New Plan + Cancel plan"
```

---

### Task 6: Full regression + docs

**Files:**
- Modify: `README.md` (Deferred / out-of-scope — installment note), `docs/正式上线待办.md` if the PTP line needs updating.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all tests pass (existing 59 + new installment tests), 0 fail.

- [ ] **Step 2: Update README deferred list**

In `README.md`, under "Deferred / out-of-scope → Business scope", change the PTP line from stating installments are unsupported to noting they are now supported:

```markdown
- **Business scope**: automatic case assignment rules, automatic commission
  calculation/settlement, a legal-case sub-module (hearing dates, counsel,
  litigation progress), multi-creditor debtor↔case relationships. (Installment
  repayment plans are now supported: a plan is N grouped PTP rows.)
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note installment repayment plans are now supported"
```

---

## Self-Review Notes

- **Spec coverage:** schema (Task 2), pure util split/dates (Task 1), generate route + validation (Task 3), per-installment fulfill/break reuse (verified in Task 4 test, no new code), cancel plan (Task 4), grouped display + New Plan/Cancel UI (Task 5), dashboard-no-change (explicitly nothing to do), tests (Tasks 1/3/4), YAGNI items excluded. All spec sections mapped.
- **Naming consistency:** `createPtpPlan(caseId, body, req)` and `cancelPtpPlan(caseId, planId, req)` used identically in route + tests + exports. `splitInstallments`/`dueDates` signatures match Task 1 across all callers.
- **Reuse:** `validatePayment`, `TERMINAL_STATUSES`, `db.transaction`, `resyncCaseStatus`/`breakPtp` revert pattern, existing fulfill/break routes — no duplication of the payment/status machine.
