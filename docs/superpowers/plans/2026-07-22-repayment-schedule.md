# Repayment Schedule (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a projected monthly repayment schedule on the case detail page for `interest_mode='monthly'` + `tenure_unit='months'` cases, computed live from the existing interest-first accrual engine — no new DB table, no new interest model.

**Architecture:** A pure function `repaymentSchedule(c, payments)` in a new `src/utils/schedule.js` projects `caseBalance()`'s interest-first (先息后本) model onto n monthly periods (interest-only for periods 1..n-1, interest+principal at maturity), then derives each period's paid/outstanding/status by a FIFO waterfall over the case's actual `payments` total. Wired into the existing `GET /cases/:id` route and rendered as a new read-only table in `src/views/cases/show.ejs`.

**Tech Stack:** Node.js, Express, EJS, dayjs, node:sqlite, node:test (existing stack — no new dependencies).

## Global Constraints

- No new database table or columns — this is a computed-on-read projection, per [2026-07-22-repayment-schedule-design.md](../specs/2026-07-22-repayment-schedule-design.md).
- Reuse `dailyRate()`/`daysBetween()` from `src/services/payments.js` rather than reimplementing rate/day-count math.
- Schedule generation is gated to `interest_mode==='monthly' && tenure_unit==='months' && tenure && loan_start_date` — every other combination returns `[]`.
- Every test file that (transitively) requires `src/db` must set `process.env.CRM_DB_PATH` to a temp path *before* that require, so tests never touch the real `data/crm.db` (which the local dev server has open).
- Money values always go through `round2()` from `src/utils/helpers.js`.

---

### Task 1: Export `dailyRate` and `daysBetween` from payments.js

**Files:**
- Modify: `src/services/payments.js:135`
- Test: run existing suite, no new test file (pure export addition, already covered by every existing `payments.js` test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `dailyRate(c)` and `daysBetween(a, b)`, now importable via `require('../services/payments')`, for Task 2 to consume.

- [ ] **Step 1: Widen the module.exports line**

In `src/services/payments.js`, line 135 currently reads:

```js
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, caseBalance, applyPayment, paymentWrites, resyncCaseStatus };
```

Change it to:

```js
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, caseBalance, applyPayment, paymentWrites, resyncCaseStatus, dailyRate, daysBetween };
```

- [ ] **Step 2: Run the full test suite to confirm nothing broke**

Run: `npm test`
Expected: `# pass 100`, `# fail 0` (same counts as before this change — this step only widens an export list, it changes no behavior).

- [ ] **Step 3: Commit**

```bash
git add src/services/payments.js
git commit -m "refactor: export dailyRate/daysBetween for reuse by repayment schedule"
```

---

### Task 2: `repaymentSchedule()` pure function + tests

**Files:**
- Create: `src/utils/schedule.js`
- Create: `test/schedule.test.js`

**Interfaces:**
- Consumes: `dailyRate(c)`, `daysBetween(a, b)` from `src/services/payments.js` (Task 1); `dueDates(firstDate, n)` from `src/utils/installments.js` (already exported); `round2(n)` from `src/utils/helpers.js` (already exported).
- Produces: `repaymentSchedule(c, payments)` — signature: `c` is a case-like object with `interest_mode`, `tenure_unit`, `tenure`, `loan_start_date`, `principal_amount`, `interest_rate`; `payments` is an array of `{ amount, payment_date }` (order doesn't matter — only the sum is used). Returns an array of `{ due_date, expected_amount, paid_amount, outstanding_amount, status }`, where `status` is one of `'pending' | 'partial' | 'paid' | 'overdue'`. Task 3 imports this function by name.

- [ ] **Step 1: Write the failing tests**

Create `test/schedule.test.js`:

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-schedule-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const { repaymentSchedule } = require('../src/utils/schedule');
const { caseBalance } = require('../src/services/payments');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

// principal 3000, 3%/month => dailyRate = 0.001/day exactly (clean numbers for
// hand-checked assertions). Jan has 31 days, Feb 2026 has 28 (not a leap year),
// March has 31.
function baseCase(overrides = {}) {
  return {
    interest_mode: 'monthly',
    tenure_unit: 'months',
    tenure: 3,
    loan_start_date: '2026-01-01',
    interest_from: '2026-01-01',
    principal_amount: 3000,
    interest_rate: 3,
    ...overrides,
  };
}

test('one row per tenure month; last row bundles principal', () => {
  const rows = repaymentSchedule(baseCase(), []);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].due_date, '2026-02-01');
  assert.strictEqual(rows[1].due_date, '2026-03-01');
  assert.strictEqual(rows[2].due_date, '2026-04-01');
  near(rows[0].expected_amount, 93, 'Jan (31d) interest-only');
  near(rows[1].expected_amount, 84, 'Feb (28d) interest-only');
  near(rows[2].expected_amount, 3093, 'Mar (31d) interest + principal');
});

test('zero payments, due dates already past => all overdue', () => {
  const rows = repaymentSchedule(baseCase({ loan_start_date: '2020-01-01', interest_from: '2020-01-01' }), []);
  rows.forEach(r => assert.strictEqual(r.status, 'overdue'));
});

test('zero payments, due dates far in the future => all pending', () => {
  const rows = repaymentSchedule(baseCase({ loan_start_date: '2099-01-01', interest_from: '2099-01-01' }), []);
  rows.forEach(r => assert.strictEqual(r.status, 'pending'));
});

test('lump payment covering first 2 periods exactly: waterfall fills oldest first', () => {
  const rows = repaymentSchedule(baseCase(), [{ amount: 177, payment_date: '2026-02-15' }]);
  assert.strictEqual(rows[0].status, 'paid');
  assert.strictEqual(rows[1].status, 'paid');
  near(rows[0].paid_amount, 93, 'period 1 fully paid');
  near(rows[1].paid_amount, 84, 'period 2 fully paid');
  near(rows[2].paid_amount, 0, 'period 3 untouched');
  assert.strictEqual(rows[2].status, 'overdue'); // due 2026-04-01, long past, unpaid
  near(rows[2].outstanding_amount, 3093, 'period 3 fully outstanding');
});

test('overpayment: no row paid_amount exceeds its expected_amount, excess is unused', () => {
  const rows = repaymentSchedule(baseCase(), [{ amount: 5000, payment_date: '2026-01-15' }]);
  rows.forEach(r => assert.ok(r.paid_amount <= r.expected_amount));
  const totalPaid = rows.reduce((s, r) => s + r.paid_amount, 0);
  near(totalPaid, 3270, 'total applied caps at total expected, not the 5000 paid'); // 93+84+3093
  rows.forEach(r => assert.strictEqual(r.status, 'paid'));
});

test('interest_mode other than monthly => no schedule', () => {
  assert.deepStrictEqual(repaymentSchedule(baseCase({ interest_mode: 'daily' }), []), []);
  assert.deepStrictEqual(repaymentSchedule(baseCase({ interest_mode: 'fixed' }), []), []);
});

test('tenure_unit other than months => no schedule', () => {
  assert.deepStrictEqual(repaymentSchedule(baseCase({ tenure_unit: 'days' }), []), []);
  assert.deepStrictEqual(repaymentSchedule(baseCase({ tenure_unit: 'years' }), []), []);
});

test('missing tenure or loan_start_date => no schedule', () => {
  assert.deepStrictEqual(repaymentSchedule(baseCase({ tenure: null }), []), []);
  assert.deepStrictEqual(repaymentSchedule(baseCase({ loan_start_date: null }), []), []);
});

test('identity: sum of expected_amount (zero payments) matches caseBalance at maturity', () => {
  const c = baseCase();
  const rows = repaymentSchedule(c, []);
  const sumExpected = rows.reduce((s, r) => s + r.expected_amount, 0);
  const b = caseBalance(c, [], rows[rows.length - 1].due_date);
  near(sumExpected, b.interest + c.principal_amount, 'schedule total agrees with ledger total');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --no-install node --test test/schedule.test.js`
Expected: FAIL — `Cannot find module '../src/utils/schedule'`

- [ ] **Step 3: Write the implementation**

Create `src/utils/schedule.js`:

```js
const { dailyRate, daysBetween } = require('../services/payments');
const { dueDates } = require('./installments');
const { round2 } = require('./helpers');

// "Today" in Malaysia local time (UTC+8) as YYYY-MM-DD, to compare against
// due_date strings. Same +8h-then-truncate idiom as payments.js's daysBetween
// and the date-input default in cases/show.ejs.
// ponytail: TZ offset duplicated a third time; extract to a shared const if a
// 4th call site shows up.
function todayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// Projects caseBalance()'s interest-first (先息后本) model (src/services/payments.js)
// onto a monthly schedule: assuming on-time payment, periods 1..n-1 are
// interest-only and period n (maturity) also clears the full principal.
// Only generated for interest_mode='monthly' + tenure_unit='months' — daily
// accrual has no natural period boundary, fixed has no periodic rate, and
// days/years tenure would need an arbitrary conversion into monthly periods.
// Paid/outstanding/status are derived live from `payments` (a FIFO waterfall
// in schedule order, independent of each payment's actual date) — nothing
// here is persisted, so editing tenure/rate takes effect on the next read.
function repaymentSchedule(c, payments) {
  if (c.interest_mode !== 'monthly' || c.tenure_unit !== 'months' || !c.tenure || !c.loan_start_date) {
    return [];
  }
  const rate = dailyRate(c);
  const dates = dueDates(c.loan_start_date, c.tenure);
  let pool = payments.reduce((s, p) => s + p.amount, 0);
  let periodStart = c.loan_start_date;
  const today = todayStr();
  return dates.map((due, i) => {
    const isLast = i === dates.length - 1;
    let expected = round2(c.principal_amount * rate * daysBetween(periodStart, due));
    if (isLast) expected = round2(expected + c.principal_amount);
    const paid = round2(Math.min(expected, Math.max(0, pool)));
    pool -= paid;
    periodStart = due;
    const outstanding = round2(Math.max(0, expected - paid));
    const status = paid >= expected ? 'paid'
      : due < today ? 'overdue'
      : paid > 0 ? 'partial'
      : 'pending';
    return { due_date: due, expected_amount: expected, paid_amount: paid, outstanding_amount: outstanding, status };
  });
}

module.exports = { repaymentSchedule };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --no-install node --test test/schedule.test.js`
Expected: all 9 tests pass, e.g. ending in `# pass 9`, `# fail 0`.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: `# pass 109` (100 existing + 9 new), `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/schedule.js test/schedule.test.js
git commit -m "feat: add repaymentSchedule() — projected monthly schedule from interest-first model"
```

---

### Task 3: Wire schedule into the case detail route

**Files:**
- Modify: `src/routes/cases.js:10` (require), `src/routes/cases.js:140-149` (route handler)

**Interfaces:**
- Consumes: `repaymentSchedule(c, payments)` from `src/utils/schedule.js` (Task 2).
- Produces: `schedule` array now present in the render locals for `cases/show`, for Task 4's template to consume.

- [ ] **Step 1: Add the require**

In `src/routes/cases.js`, line 10 currently reads:

```js
const { splitInstallments, dueDates, maturityDate } = require('../utils/installments');
```

Add a line directly after it:

```js
const { repaymentSchedule } = require('../utils/schedule');
```

- [ ] **Step 2: Compute and pass `schedule` in the show route**

The route at `src/routes/cases.js:140-149` currently reads:

```js
router.get('/:id', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const timeline = all('SELECT * FROM timeline_events WHERE case_id=? ORDER BY created_at DESC', [c.id]);
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date DESC', [c.id]);
  const ptps = all('SELECT * FROM ptps WHERE case_id=? ORDER BY (plan_id IS NULL), plan_id, installment_no, due_date DESC', [c.id]);
  const tasks = all('SELECT * FROM tasks WHERE case_id=? ORDER BY due_date', [c.id]);
  const calls = all('SELECT * FROM call_logs WHERE case_id=? ORDER BY call_time DESC', [c.id]);
  res.render('cases/show', { title: c.case_no, c, timeline, payments, ptps, tasks, calls,
    statuses: CASE_STATUSES, terminal: TERMINAL_STATUSES,
    readOnly: ['auditor','client'].includes(req.session.user.role) });
});
```

Change it to:

```js
router.get('/:id', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const timeline = all('SELECT * FROM timeline_events WHERE case_id=? ORDER BY created_at DESC', [c.id]);
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date DESC', [c.id]);
  const ptps = all('SELECT * FROM ptps WHERE case_id=? ORDER BY (plan_id IS NULL), plan_id, installment_no, due_date DESC', [c.id]);
  const tasks = all('SELECT * FROM tasks WHERE case_id=? ORDER BY due_date', [c.id]);
  const calls = all('SELECT * FROM call_logs WHERE case_id=? ORDER BY call_time DESC', [c.id]);
  const schedule = repaymentSchedule(c, payments);
  res.render('cases/show', { title: c.case_no, c, timeline, payments, ptps, tasks, calls, schedule,
    statuses: CASE_STATUSES, terminal: TERMINAL_STATUSES,
    readOnly: ['auditor','client'].includes(req.session.user.role) });
});
```

Note: `payments` here is already `SELECT *` (has `amount`/`payment_date` plus other columns) — `repaymentSchedule` only reads `.amount`, so no query change needed.

- [ ] **Step 3: Verify the app still boots and the page still renders**

Run: `npm test` (Expected: `# pass 109`, `# fail 0` — same as Task 2, this task adds no new automated test since it's pure wiring already covered by Task 2's unit tests).

Then manually confirm the page doesn't 500 (the template doesn't read `schedule` yet, so this only proves the route computes it safely):

```bash
node --no-warnings src/app.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health
kill %1
```

Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/cases.js
git commit -m "feat: compute repayment schedule in case detail route"
```

---

### Task 4: Render the schedule table on the case detail page

**Files:**
- Modify: `src/views/cases/show.ejs:100-114`

**Interfaces:**
- Consumes: `schedule` array (from Task 3) with rows `{ due_date, expected_amount, paid_amount, outstanding_amount, status }`, where `status ∈ {'pending','partial','paid','overdue'}`.
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Add the table section**

In `src/views/cases/show.ejs`, the `#dlg-records` modal body currently opens like this (lines 100-103):

```ejs
  <div class="modal-body">
    <section class="rec-section">
    <% const canEditPay = !readOnly && ['admin','manager','finance'].includes(currentUser.role); %>
    <h2>Payments</h2>
```

Insert a new section between `<div class="modal-body">` and the Payments `<section>`, so the reading order is: what was expected (Schedule) → what actually happened (Payments) → what's promised (PTP) → Calls → Tasks:

```ejs
  <div class="modal-body">
    <% if (schedule.length) { %>
    <section class="rec-section">
    <h2>Repayment Schedule</h2>
    <% const schedClass = { paid:'is-green', overdue:'is-red', partial:'is-gold', pending:'is-neutral' }; %>
    <% const schedLabel = { paid:'Paid', overdue:'Overdue', partial:'Partially Paid', pending:'Pending' }; %>
    <table class="data"><thead><tr><th>Due Date</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th></tr></thead>
    <tbody><% schedule.forEach(row => { %><tr>
      <td><%= h.dateFmt(row.due_date) %></td>
      <td class="num"><%= h.money(row.expected_amount) %></td>
      <td class="num"><%= h.money(row.paid_amount) %></td>
      <td class="num"><%= h.money(row.outstanding_amount) %></td>
      <td><span class="badge <%= schedClass[row.status] %>"><%= schedLabel[row.status] %></span></td>
    </tr><% }) %></tbody></table>
    </section>
    <% } %>

    <section class="rec-section">
    <% const canEditPay = !readOnly && ['admin','manager','finance'].includes(currentUser.role); %>
    <h2>Payments</h2>
```

- [ ] **Step 2: Restart the dev server on the new template**

```bash
tasklist //FI "IMAGENAME eq node.exe"
```

Kill whatever's holding port 3000 (the existing dev server process from this session), then:

```bash
npm start > server.log 2>&1 &
sleep 1
cat server.log
```

Expected: `CRM demo running: http://localhost:3000`, no stack trace.

- [ ] **Step 3: Manually verify against a real case in the browser**

Log in at `http://localhost:3000/login`, open (or create) a case with `Interest Mode = monthly`, `Tenure Unit = months`, a `Tenure` and `Loan Start Date` set, then open its detail page → Records → confirm the "Repayment Schedule" section appears above "Payments" with the expected number of rows, the last row's Expected amount visibly larger (includes principal), and status badges colored per `paid`/`overdue`/`partial`/`pending`.

Also open a `fixed`- or `daily`-mode case (or a monthly case with `tenure_unit` other than `months`) and confirm no "Repayment Schedule" section renders — behavior must be unchanged for those cases.

- [ ] **Step 4: Run the full suite one more time**

Run: `npm test`
Expected: `# pass 109`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/views/cases/show.ejs
git commit -m "feat: display Repayment Schedule table on case detail page"
```

---

## Out of Scope (unchanged from the spec)

- Payment principal/interest portion columns (Phase 4).
- PTP-to-schedule linkage (Phase 5).
- Extension / Restructure (Phase 6).
