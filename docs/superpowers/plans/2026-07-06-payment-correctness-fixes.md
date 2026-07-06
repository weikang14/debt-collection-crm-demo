# Payment / Data-Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four payment-path data-correctness bugs — float "fully-paid" detection, missing amount validation, overpayment block, non-atomic writes, and dashboard timezone — without touching stored payment amounts.

**Architecture:** Server-rendered Express + EJS + better-sqlite3. One pure validator in `src/utils/forms.js` shared by both payment entry points; rounding + transaction confined to the `src/services/payments.js` service; a query-only timezone fix in `src/routes/dashboard.js`.

**Tech Stack:** Node 22, Express 4, better-sqlite3 (via `src/db`), `node --test`.

## Global Constraints

- **Payment amounts are recorded exactly as entered — never rounded, truncated, or altered.** This is a collection system.
- **Only the derived `outstanding_amount` (principal + interest − paid) is rounded to 2 decimals.**
- **Overpayment is blocked:** reject when `amount > outstanding + 0.005`. An amount equal to outstanding (pays off) is allowed.
- No new npm dependencies. DB access only via `src/db` helpers (`get`, `all`, `run`) and the exported `db` (better-sqlite3 instance) for transactions.
- Malaysia time is UTC+8; SQLite date comparisons for "today"/overdue use `date('now','+8 hours')`.
- Run one test file: `node --test test/<file>.test.js`. Full suite: `npm test`.

---

### Task 1: `validatePayment` helper

**Files:**
- Modify: `src/utils/forms.js`
- Test: `test/forms.test.js`

**Interfaces:**
- Produces: `validatePayment(rawAmount, outstanding)` → `{ amount: number }` when valid, or `{ error: string }` when not. `amount` is the input coerced with `Number()` and returned **unrounded**. Errors: `'Invalid amount'` (non-finite or `<= 0`), `'Amount exceeds outstanding'` (`> outstanding + 0.005`).

- [ ] **Step 1: Write the failing test**

Append to `test/forms.test.js`:

```js
const { validatePayment } = require('../src/utils/forms');

test('validatePayment: rejects non-numeric, zero, negative', () => {
  assert.deepStrictEqual(validatePayment('abc', 100), { error: 'Invalid amount' });
  assert.deepStrictEqual(validatePayment('', 100), { error: 'Invalid amount' });
  assert.deepStrictEqual(validatePayment(0, 100), { error: 'Invalid amount' });
  assert.deepStrictEqual(validatePayment(-5, 100), { error: 'Invalid amount' });
});
test('validatePayment: blocks overpayment, allows exact payoff and partial', () => {
  assert.deepStrictEqual(validatePayment(150, 100), { error: 'Amount exceeds outstanding' });
  assert.deepStrictEqual(validatePayment(100, 100), { amount: 100 });
  assert.deepStrictEqual(validatePayment(30, 100), { amount: 30 });
});
test('validatePayment: returns the amount exactly, no rounding', () => {
  assert.deepStrictEqual(validatePayment(12.345, 100), { amount: 12.345 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/forms.test.js`
Expected: FAIL — `validatePayment` is not a function / not exported.

- [ ] **Step 3: Implement the helper**

In `src/utils/forms.js`, add the function and export it:

```js
// Validate a payment amount against the case's current outstanding balance.
// Returns { amount } (exact, never rounded — this is a collection system) or
// { error }. Overpayment is blocked; a sub-cent tolerance absorbs float noise.
function validatePayment(rawAmount, outstanding) {
  const n = Number(rawAmount);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Invalid amount' };
  if (n > Number(outstanding) + 0.005) return { error: 'Amount exceeds outstanding' };
  return { amount: n };
}
module.exports = { parseActive, validatePayment };
```

(Replace the existing `module.exports = { parseActive };` line with the one above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/forms.test.js`
Expected: PASS (all `validatePayment` + existing `parseActive` tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/forms.js test/forms.test.js
git commit -m "feat: validatePayment helper (reject bad amounts + block overpayment)"
```

---

### Task 2: Round derived outstanding, `<= 0` status, atomic writes

**Files:**
- Modify: `src/services/payments.js`
- Test: `test/payment_correctness.test.js` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: unchanged public signatures — `recomputeOutstanding(caseId)` now returns a 2-dp-rounded outstanding; `applyPayment(caseId, p, req)` still returns `{ receipt_no, outstanding, status }` and now performs its writes atomically. `p.amount` is inserted exactly (no rounding).

- [ ] **Step 1: Write the failing test**

Create `test/payment_correctness.test.js`:

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-paycorrect-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();
const { applyPayment } = require('../src/services/payments');

const req = { session: { user: { full_name: 'Tester' } }, ip: '127.0.0.1' };

test('exact payoff clears float residue -> outstanding 0, fully_paid', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  db.run("UPDATE cases SET principal_amount=0.1, interest_amount=0.2, outstanding_amount=0.3, status='negotiation' WHERE id=?", [c.id]);
  applyPayment(c.id, { payment_date: '2026-07-06', amount: 0.3, method: 'cash' }, req);
  const row = db.get('SELECT outstanding_amount, status FROM cases WHERE id=?', [c.id]);
  assert.strictEqual(row.outstanding_amount, 0);
  assert.strictEqual(row.status, 'fully_paid');
});

test('payment amount is stored exactly, not rounded', () => {
  const c = db.get('SELECT id FROM cases WHERE id NOT IN (SELECT id FROM cases LIMIT 1) LIMIT 1');
  db.run("UPDATE cases SET principal_amount=100, interest_amount=0, outstanding_amount=100, status='negotiation' WHERE id=?", [c.id]);
  applyPayment(c.id, { payment_date: '2026-07-06', amount: 12.345, method: 'cash' }, req);
  const pay = db.get('SELECT amount FROM payments WHERE case_id=? ORDER BY id DESC LIMIT 1', [c.id]);
  assert.strictEqual(pay.amount, 12.345);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/payment_correctness.test.js`
Expected: FAIL — first test fails with `outstanding_amount` ≈ `5.5e-17` and `status` `'partial_paid'`.

- [ ] **Step 3: Implement the fixes**

In `src/services/payments.js`:

Change the imports line to also pull in `db`:

```js
const { db, get, run } = require('../db');
```

Add a rounding helper below the imports (after the `TERMINAL_STATUSES` line):

```js
// Round a *derived* money value (a computed balance) to whole cents. Payments
// themselves are never rounded — only this balance is.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
```

In `statusAfterPayment`, change the zero check:

```js
  if (outstanding <= 0) return 'fully_paid';
```

In `recomputeOutstanding`, round the derived outstanding:

```js
function recomputeOutstanding(caseId) {
  const c = get('SELECT principal_amount, interest_amount FROM cases WHERE id = ?', [caseId]);
  const paid = get('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE case_id = ?', [caseId]).s;
  const outstanding = round2(Math.max(0, (c.principal_amount + c.interest_amount) - paid));
  run('UPDATE cases SET outstanding_amount = ?, updated_at = datetime(\'now\') WHERE id = ?', [outstanding, caseId]);
  return outstanding;
}
```

Wrap the writes in `applyPayment` in a transaction (amount stays exact — `Number(p.amount)`, no rounding):

```js
function applyPayment(caseId, p, req) {
  const receipt_no = nextReceiptNo();
  const by = req.session.user.full_name;
  let outstanding, next;
  db.transaction(() => {
    run(`INSERT INTO payments (case_id, receipt_no, payment_date, amount, method, reference, bank, remark, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      [caseId, receipt_no, p.payment_date, Number(p.amount), p.method || 'bank_transfer', p.reference || null, p.bank || null, p.remark || null, by]);
    outstanding = recomputeOutstanding(caseId);
    const cnt = get('SELECT COUNT(*) AS c FROM payments WHERE case_id = ?', [caseId]).c;
    const cur = get('SELECT status FROM cases WHERE id = ?', [caseId]).status;
    next = statusAfterPayment(cur, outstanding, cnt);
    if (next !== cur) run('UPDATE cases SET status = ? WHERE id = ?', [next, caseId]);
    run(`INSERT INTO timeline_events (case_id, event_type, content, created_by) VALUES (?,?,?,?)`,
      [caseId, 'payment', `Payment ${receipt_no}: RM ${Number(p.amount).toFixed(2)} via ${p.method || 'bank_transfer'}`, by]);
  })();
  logAction(req, 'payment', 'case', caseId, `Recorded payment ${receipt_no} amount ${p.amount}`);
  return { receipt_no, outstanding, status: next };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/payment_correctness.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full suite (guard against regressions)**

Run: `npm test`
Expected: all pass — the existing `test/payments.test.js` (`statusAfterPayment`) and `test/ptp_fulfill.test.js` still pass; `<= 0` does not change any of their assertions.

- [ ] **Step 6: Commit**

```bash
git add src/services/payments.js test/payment_correctness.test.js
git commit -m "fix: round derived outstanding to cents (fixes stuck partial_paid) + atomic applyPayment"
```

---

### Task 3: Wire `validatePayment` into both payment routes

**Files:**
- Modify: `src/routes/cases.js` (payment route, ~line 116)
- Modify: `src/routes/ptps.js` (`recordFulfillment`, ~lines 12-25)
- Test: `test/payment_correctness.test.js` (append)

**Interfaces:**
- Consumes: `validatePayment(rawAmount, outstanding)` from Task 1; `applyPayment` (validated amount passed through) from Task 2.
- Produces: `POST /cases/:id/payments` and `POST /ptps/:id/fulfill` reject invalid/overpayment amounts before any write; `recordFulfillment` returns `{ ok:false, error }` on a bad amount.

- [ ] **Step 1: Write the failing test**

Append to `test/payment_correctness.test.js`:

```js
const { recordFulfillment } = require('../src/routes/ptps');

test('recordFulfillment blocks overpayment and records nothing', () => {
  const c = db.get('SELECT id FROM cases ORDER BY id DESC LIMIT 1');
  db.run("UPDATE cases SET principal_amount=100, interest_amount=0, outstanding_amount=100, status='negotiation' WHERE id=?", [c.id]);
  const ptp = db.run("INSERT INTO ptps (case_id, amount, due_date, status, created_by) VALUES (?,?,?,?,?)",
    [c.id, 500, '2026-08-01', 'pending', 'Tester']);
  const before = db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [c.id]).n;
  const r = recordFulfillment(ptp.lastInsertRowid, {}, req);
  assert.deepStrictEqual(r, { ok: false, error: 'Amount exceeds outstanding' });
  const after = db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [c.id]).n;
  assert.strictEqual(after, before);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [ptp.lastInsertRowid]).status, 'pending');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/payment_correctness.test.js`
Expected: FAIL — `recordFulfillment` currently records the payment (no overpayment guard), so `after !== before` and the PTP flips to `fulfilled`.

- [ ] **Step 3: Add the guard to `recordFulfillment` (`src/routes/ptps.js`)**

Add the import near the top (after the existing `require` lines):

```js
const { validatePayment } = require('../utils/forms');
```

Replace the body of `recordFulfillment` (the current lines 12-25) with:

```js
function recordFulfillment(ptpId, body, req) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [ptpId]);
  if (!ptp) return { ok: false, error: 'PTP not found' };
  if (ptp.status !== 'pending') return { ok: false, error: 'PTP already resolved' };
  const rawAmount = (body.amount !== undefined && body.amount !== '') ? body.amount : ptp.amount;
  const cs = get('SELECT outstanding_amount FROM cases WHERE id=?', [ptp.case_id]);
  const v = validatePayment(rawAmount, cs.outstanding_amount);
  if (v.error) return { ok: false, error: v.error };
  run("UPDATE ptps SET status='fulfilled' WHERE id=?", [ptp.id]);
  const payment_date = body.payment_date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const method = body.method || 'bank_transfer';
  applyPayment(ptp.case_id, { payment_date, amount: v.amount, method, remark: `PTP fulfilled` }, req);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
    [ptp.case_id, 'ptp_fulfilled', `PTP fulfilled (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_fulfilled', 'case', ptp.case_id, `PTP ${ptp.id} fulfilled`);
  return { ok: true, caseId: ptp.case_id };
}
```

- [ ] **Step 4: Add the guard to the cases payment route (`src/routes/cases.js`)**

Add the import near the other requires at the top of `src/routes/cases.js`:

```js
const { validatePayment } = require('../utils/forms');
```

Replace the payment route (currently):

```js
router.post('/:id/payments', requireLogin, requireRole('admin','manager','finance','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = applyPayment(c.id, req.body, req);
  res.redirect(`/cases/${c.id}?ok=Payment+${r.receipt_no}+recorded`);
});
```

with:

```js
router.post('/:id/payments', requireLogin, requireRole('admin','manager','finance','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const v = validatePayment(req.body.amount, c.outstanding_amount);
  if (v.error) return res.redirect(`/cases/${c.id}?err=${encodeURIComponent(v.error)}`);
  const r = applyPayment(c.id, { ...req.body, amount: v.amount }, req);
  res.redirect(`/cases/${c.id}?ok=Payment+${r.receipt_no}+recorded`);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/payment_correctness.test.js`
Expected: PASS (all four tests in the file).

- [ ] **Step 6: Live-verify the cases route guard**

```bash
export CRM_DB_PATH="$(mktemp -d)/smoke.db"
node -e "const db=require('./src/db');db.init();require('./src/db/seed').seedDemo();"
PORT=3210 node --no-warnings src/app.js & SRV=$!
sleep 2
J=$(mktemp); curl -s -c $J -d 'username=admin&password=admin123' http://localhost:3210/login -o /dev/null
CID=$(curl -s -b $J http://localhost:3210/cases | grep -oE '/cases/[0-9]+' | head -1 | grep -oE '[0-9]+')
# outstanding of that case:
OUT=$(node -e "process.env.CRM_DB_PATH='$CRM_DB_PATH';const db=require('./src/db');console.log(db.get('SELECT outstanding_amount o FROM cases WHERE id=?',[$CID]).o)")
echo "outstanding=$OUT"
# negative amount -> expect redirect back with err, no new payment
curl -s -b $J -o /dev/null -w "negative -> %{http_code} %{redirect_url}\n" -d "payment_date=2026-07-06&amount=-50&method=cash" http://localhost:3210/cases/$CID/payments
# overpayment -> expect err
curl -s -b $J -o /dev/null -w "overpay -> %{http_code} %{redirect_url}\n" -d "payment_date=2026-07-06&amount=99999999&method=cash" http://localhost:3210/cases/$CID/payments
kill $SRV; rm -f $J
```

Expected: both redirect URLs contain `err=Invalid+amount` and `err=Amount+exceeds+outstanding` respectively (HTTP 302).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass (existing `ptp_fulfill.test.js` still green — a valid fulfill within outstanding is unaffected).

- [ ] **Step 8: Commit**

```bash
git add src/routes/cases.js src/routes/ptps.js test/payment_correctness.test.js
git commit -m "fix: validate + block overpayment on payment and PTP-fulfill routes"
```

---

### Task 4: Dashboard timezone (MYT)

**Files:**
- Modify: `src/routes/dashboard.js`

**Interfaces:**
- Consumes/Produces: nothing shared — a self-contained query fix.

- [ ] **Step 1: Replace UTC `date('now')` with MYT in the dashboard KPIs**

In `src/routes/dashboard.js`, change every `date('now')` used for "today"/overdue comparisons to `date('now','+8 hours')`. The affected lines are:

- `openedToday`: `AND date(opened_at)=date('now')` → `AND date(opened_at)=date('now','+8 hours')`
- `closedToday`: `AND date(closed_at)=date('now')` → `AND date(closed_at)=date('now','+8 hours')`
- `collectedToday`: `AND date(p.payment_date)=date('now')` → `AND date(p.payment_date)=date('now','+8 hours')`
- `ptpToday`: `AND date(t.due_date)=date('now')` → `AND date(t.due_date)=date('now','+8 hours')`
- `overdueTasks`: `AND t.due_date < date('now')` → `AND t.due_date < date('now','+8 hours')`

- [ ] **Step 2: Verify no bare `date('now')` remains and the app boots**

```bash
grep -n "date('now')" src/routes/dashboard.js || echo "none remaining (good)"
node -e "const ejs=1" # noop
export CRM_DB_PATH="$(mktemp -d)/tz.db"; node -e "const db=require('./src/db');db.init();require('./src/db/seed').seedDemo();"
PORT=3211 node --no-warnings src/app.js & SRV=$!; sleep 2
J=$(mktemp); curl -s -c $J -d 'username=admin&password=admin123' http://localhost:3211/login -o /dev/null
curl -s -b $J -o /dev/null -w "dashboard -> %{http_code}\n" http://localhost:3211/
kill $SRV; rm -f $J
```

Expected: `none remaining (good)` and `dashboard -> 200`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass (no test targets dashboard timezone; this confirms no import/syntax breakage).

- [ ] **Step 4: Commit**

```bash
git add src/routes/dashboard.js
git commit -m "fix: dashboard today/overdue KPIs use Malaysia time (UTC+8)"
```

---

## Self-Review Notes

- **Spec coverage:** Fix 1 (float/round + `<=0`) → Task 2; Fix 2 (validation + overpayment block) → Task 1 (helper) + Task 3 (both routes); Fix 3 (transaction) → Task 2; Fix 4 (dashboard TZ) → Task 4. All four spec fixes are covered.
- **No payment-amount rounding:** verified in Task 2 Step 3 (`Number(p.amount)`, no `round2`) and asserted by the "stored exactly" test.
- **Signature consistency:** `validatePayment(rawAmount, outstanding) → {amount}|{error}` is defined in Task 1 and consumed identically in Task 3 (both routes). `recordFulfillment` keeps its `{ok, error/caseId}` shape.
- **No new deps; no schema change.** `db.transaction` is a better-sqlite3 built-in already available via the exported `db`.
- **Known ceiling (out of scope, documented in spec):** #4/#5 status-machine, #7 dashboard join, #8 numbering, #9 audit swallow, #10 auth.
