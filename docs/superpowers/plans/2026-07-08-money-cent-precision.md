# Money Cent-Precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the residual floating-point accumulation error in stored/exported money **without** a schema migration, by rounding the few un-rounded aggregate boundaries to whole cents.

**Architecture:** Round-at-boundary, not integer-cents storage. The codebase already contains the accumulation error by construction: every *derived stored* money value is `round2`'d (`recomputeOutstanding` → `outstanding_amount` + interest cache; `commissionRows` → `earned`/`pending`) and every *on-screen* money flows through the single `money()` helper (`toLocaleString`, 2 fraction digits). The only leaks left are money **aggregates that are neither round2'd before storage nor rendered through `money()`**: (1) the commission-settlement amount written from user input, and (2) live `SUM(amount)` money written into CSV cells as raw numbers. This plan rounds exactly those, and DRYs the two duplicate `round2` copies into one shared helper.

**Tech Stack:** Node.js, `node:sqlite`, Express, EJS, `node:test`.

## Why not integer cents

Storing money as INTEGER cents (the original P1 idea) was **considered and rejected** as over-engineering for this system: it would touch `schema.sql` + a one-shot data migration on the persistent prod DB (double-multiply risk if it runs twice), `seed.js`, the interest engine, CSV, validation, and ~dozens of test assertions — high risk, high churn — to fix an error that `round2`-on-derived + the `money()` chokepoint already contain. Payments are also stored **exactly** on purpose (see `validatePayment` comment and the `payment_correctness` test "payment amount is stored exactly, not rounded"); an integer-cents scheme would fight that deliberate decision. If a future scale genuinely needs exact integer money, revisit as its own project.

## Global Constraints

- No new dependencies (`node:test`, `node:sqlite`, Express, EJS only).
- Do **not** change how `payments.amount` or `ptps.amount` are stored — those are intentionally exact user input.
- Do **not** alter the schema or add migrations.
- Malaysia-time and existing behaviour unchanged; this is a precision-only change.
- `round2(n) = Math.round((Number(n) || 0) * 100) / 100` — the exact existing definition; reuse verbatim.

---

## File Structure

- `src/utils/helpers.js` — add and export the single shared `round2`. (Currently `round2` is duplicated in `src/services/payments.js:9` and `src/routes/commissions.js:11`.)
- `src/services/payments.js` — import `round2` from helpers, drop the local copy.
- `src/routes/commissions.js` — import `round2` from helpers, drop the local copy; round the settlement amount on write in `recordSettlement`.
- `src/routes/reports.js` — round the raw money SUMs written into CSV cells (`paid`, outstanding `total`).
- `src/routes/cases.js` — round the raw `paid` SUM written into the cases-list CSV.
- Tests: `test/money_precision.test.js` (new).

---

### Task 1: Shared `round2` + round the commission settlement amount

**Files:**
- Modify: `src/utils/helpers.js` (add `round2`, export it)
- Modify: `src/services/payments.js:9` (replace local `round2` with import)
- Modify: `src/routes/commissions.js:11,~40` (replace local `round2` with import; round settlement amount)
- Test: `test/money_precision.test.js`

**Interfaces:**
- Produces: `helpers.round2(n) -> number` (whole-cent rounding).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

```js
// test/money_precision.test.js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-money-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();

const { round2 } = require('../src/utils/helpers');

test('round2 snaps to whole cents and absorbs float residue', () => {
  assert.strictEqual(round2(0.1 + 0.2), 0.3);   // 0.30000000000000004 -> 0.3
  assert.strictEqual(round2(12.345), 12.35);
  assert.strictEqual(round2('7.1'), 7.1);
  assert.strictEqual(round2(null), 0);
});

const { recordSettlement } = require('../src/routes/commissions');

test('commission settlement amount is stored rounded to cents', () => {
  db.run("INSERT INTO agents (id,name,commission_rate) VALUES (1,'A',10)");
  const req = { session: { user: { full_name: 'T' } }, ip: '127.0.0.1' };
  const r = recordSettlement({ agent_id: 1, period: '2026-07', amount: '10.005' }, req);
  assert.strictEqual(r.ok, true);
  const row = db.get('SELECT amount FROM commission_settlements WHERE id=?', [r.id]);
  assert.strictEqual(row.amount, 10.01); // 10.005 -> 10.01, not stored raw
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings test/money_precision.test.js`
Expected: FAIL — `round2 is not a function` (not yet exported) / settlement stores `10.005`.

- [ ] **Step 3: Add and export `round2` in helpers.js**

In `src/utils/helpers.js`, add near the top (after the dayjs setup, beside `money`):

```js
// Round a money value to whole cents. Use at any boundary where a derived/aggregate
// amount is stored or exported as a raw number (on-screen money already goes through
// money()). Absorbs float residue like 0.1 + 0.2.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
```

And add `round2` to the `module.exports` list:

```js
module.exports = { money, round2, commission, dateFmt, dateTimeFmt, daysOverdue, statusLabel, statusClass, caseStatusLabel, caseStatusClass, icon };
```

- [ ] **Step 4: Reuse it in payments.js (drop the duplicate)**

In `src/services/payments.js`, change the imports line:

```js
const { db, get, all, run } = require('../db');
const { round2 } = require('../utils/helpers');
```

and delete the local definition at line 9:

```js
// DELETE these two lines:
// const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
```

(Keep the explanatory comment above it if you like, but the `const round2 = ...` must go so the import is used.)

- [ ] **Step 5: Reuse it in commissions.js and round the settlement amount**

In `src/routes/commissions.js`, add to the helpers import and delete the local `round2` (line 11):

```js
const { commission, round2 } = require('../utils/helpers');
```

Then in `recordSettlement`, round the parsed amount before insert:

```js
function recordSettlement(body, req) {
  const amount = round2(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };
  const agent = get('SELECT id FROM agents WHERE id=?', [body.agent_id]);
  if (!agent) return { ok: false, error: 'Agent not found' };
  const period = body.period || currentMonth();
  const r = run('INSERT INTO commission_settlements (agent_id,period,amount,note,settled_by) VALUES (?,?,?,?,?)',
    [agent.id, period, amount, body.note || null, req.session.user.full_name]);
  logAction(req, 'commission_settle', 'agent', agent.id, `Settled RM ${amount} for ${period}`);
  return { ok: true, id: r.lastInsertRowid };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test --no-warnings test/money_precision.test.js`
Expected: PASS (both tests).

- [ ] **Step 7: Run the full suite (no regression)**

Run: `node --test --no-warnings test/*.test.js`
Expected: all pass (was 87; now higher with the new file). In particular `commissions.test.js` and `payment_correctness.test.js` still pass — the shared `round2` is identical to the copies it replaced.

- [ ] **Step 8: Commit**

```bash
git add src/utils/helpers.js src/services/payments.js src/routes/commissions.js test/money_precision.test.js
git commit -m "fix: round commission settlement to cents; DRY round2 into helpers"
```

---

### Task 2: Round money SUMs written into CSV cells

**Files:**
- Modify: `src/routes/reports.js:29,33` (cases-detailed `paid`; outstanding-by-status `total`)
- Modify: `src/routes/cases.js:52` (cases-list `paid`)
- Test: `test/money_precision.test.js` (append)

**Interfaces:**
- Consumes: `helpers.round2` (from Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test (append to the file)**

```js
// append to test/money_precision.test.js
const { toCsv } = require('../src/utils/csv');
const { round2 } = require('../src/utils/helpers');

test('CSV money cells carry no sub-cent float noise', () => {
  // Simulate a paid SUM that is float-noisy (three 0.1-type payments).
  const paidRaw = 0.1 + 0.2 + 0.1;            // 0.4000000000000001
  const cell = round2(paidRaw);
  const csv = toCsv(['Paid'], [[cell]]);
  assert.ok(!/0\.4000000000000001/.test(csv), 'raw float leaked into CSV');
  assert.ok(/0\.4(\D|$)/.test(csv), 'expected 0.4 in CSV');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings test/money_precision.test.js`
Expected: FAIL — the test asserts the *rounded* behaviour that the CSV routes don't yet apply. (The unit test above proves the helper; Steps 3–4 apply it in the routes so real exports are clean. If the assertion passes trivially, tighten it by building the row without `round2` first to see the raw noise, then keep the `round2` version.)

- [ ] **Step 3: Round the CSV money in reports.js**

In `src/routes/reports.js`, add `round2` to the helpers import:

```js
const { caseStatusLabel, dateFmt, round2 } = require('../utils/helpers');
```

(adjust to match the existing destructure on that line). Then in the cases-detailed export mapping (line ~29), wrap the money SUM `paid` (and, for symmetry, the already-rounded columns are left as-is):

```js
      .map(c => [c.case_no, c.debtor_name, c.agent_name || '', c.principal_amount, c.interest_amount, round2(c.paid), c.outstanding_amount, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
```

And in the outstanding-by-status export (line ~33), round the `total` SUM:

```js
    const rows = outstanding.map(r => [caseStatusLabel(r.status), r.cnt, round2(r.total)]);
```

- [ ] **Step 4: Round the CSV money in cases.js (cases list)**

In `src/routes/cases.js`, add `round2` to the `../utils/helpers` import:

```js
const { caseStatusLabel, dateFmt, round2 } = require('../utils/helpers');
```

Then in the cases-list CSV mapping (line ~52), round the `paid` SUM:

```js
    const rows = cases.map(c => [c.case_no, c.debtor_name, c.debtor_phone || '', c.agent_name || '', c.outstanding_amount, round2(c.paid), c.priority, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --no-warnings test/money_precision.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `node --test --no-warnings test/*.test.js`
Expected: all pass. `filters.test.js` / any CSV-export test still pass (rounded values equal the old values for cent-aligned data).

- [ ] **Step 7: Commit**

```bash
git add src/routes/reports.js src/routes/cases.js test/money_precision.test.js
git commit -m "fix: round money SUMs in CSV exports to cents"
```

---

### Task 3: Update the launch checklist

**Files:**
- Modify: `docs/正式上线待办.md` (section 3, the money-float item)

- [ ] **Step 1: Mark the float item resolved**

In `docs/正式上线待办.md`, replace the money-float line in section 3 with:

```markdown
- [x] ~~金额用浮点存储（SQLite `REAL`）~~ —— ✅ **已处理（按边界四舍五入，非整数分迁移）**：所有派生/合计金额入库前 `round2`（`outstanding`、利息缓存、佣金 earned/pending 本已 round2；本次补齐佣金结算金额、CSV 导出的 SUM）；显示统一走 `money()`（2 位小数）。还款金额按设计保持精确存储。整数分迁移评估为过度工程，未做（见 `docs/superpowers/plans/2026-07-08-money-cent-precision.md`）。
```

- [ ] **Step 2: Commit**

```bash
git add docs/正式上线待办.md
git commit -m "docs: mark money-float P1 item resolved (round-at-boundary)"
```

---

## Self-Review

- **Spec coverage:** Goal = remove residual float accumulation in stored/exported money without migration. Task 1 closes the settlement-write leak + DRYs `round2`; Task 2 closes the three CSV SUM leaks; Task 3 records the decision. Already-rounded boundaries (`outstanding`, interest cache, commission `earned`/`pending`) and the `money()` display chokepoint need no change — verified in survey. No gaps.
- **Placeholder scan:** every code step shows exact code and exact commands. No TBDs.
- **Type consistency:** `round2(n) -> number` used identically in helpers, payments, commissions, reports, cases. Import name `round2` consistent across all files. `recordSettlement(body, req) -> { ok, id } | { ok, error }` unchanged in shape.
