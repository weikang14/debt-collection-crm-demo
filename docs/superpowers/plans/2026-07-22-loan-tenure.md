# Loan Tenure & Maturity Date Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `loan_start_date`, `tenure`, `tenure_unit` to `cases`, and auto-derive a cached `maturity_date` — purely additive, no interaction with the existing interest engine, PTP plans, or payment allocation.

**Architecture:** Four new nullable columns on `cases` (schema.sql for fresh DBs + an `ALTER TABLE` migration in `src/db/index.js` for existing DBs, following the exact pattern already used for `interest_mode`/`interest_rate`/`interest_from`). A pure `maturityDate(startDate, tenure, unit)` function in `src/utils/installments.js` (dayjs-based, same file as the existing `dueDates()`). A `tenureFields(b)` request-parsing helper in `src/routes/cases.js`, mirroring the existing `interestFields(b)`, wired into both the create and update routes. Two view edits: three new form inputs in `form.ejs`, one new read-only ledger cell in `show.ejs`.

**Tech Stack:** Node.js `node:sqlite` (`DatabaseSync`), Express, EJS (`ejs-mate` layouts), dayjs, `node:test` + `node:assert` for unit tests.

## Global Constraints

- Node test runner only: `node --no-warnings --test` (no test framework dependency to add).
- All dates stored/passed as `'YYYY-MM-DD'` strings — matches existing `due_date`/`payment_date`/`loan_start_date`-style fields, no `Date` objects crossing module boundaries.
- No new npm dependencies — dayjs is already a dependency and already does this exact kind of date math in `dueDates()`.
- New DB columns must be nullable with no default that implies a value (except `tenure_unit`, which defaults to `'months'`) — hundreds of existing cases have none of this data and must not break.
- Follow the existing migration pattern in `src/db/index.js`: `try { db.prepare('ALTER TABLE ...').run(); } catch (e) { /* exists */ }`.

---

### Task 1: `maturityDate()` util + unit tests

**Files:**
- Modify: `src/utils/installments.js`
- Test: `test/tenure.test.js` (create)

**Interfaces:**
- Produces: `maturityDate(startDate: string, tenure: number, unit: 'days'|'months'|'years') => string` — exported from `src/utils/installments.js` alongside `splitInstallments`/`dueDates`. Later tasks (`tenureFields` in `src/routes/cases.js`) import this by name.

- [ ] **Step 1: Write the failing tests**

Create `test/tenure.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { maturityDate } = require('../src/utils/installments');

test('maturityDate: days unit adds calendar days', () => {
  assert.strictEqual(maturityDate('2026-07-01', 30, 'days'), '2026-07-31');
});

test('maturityDate: months unit adds calendar months', () => {
  assert.strictEqual(maturityDate('2026-07-01', 12, 'months'), '2027-07-01');
});

test('maturityDate: years unit adds calendar years', () => {
  assert.strictEqual(maturityDate('2026-07-01', 1, 'years'), '2027-07-01');
});

test('maturityDate: month-end rolls back (Jan 31 + 1 month -> Feb 28)', () => {
  assert.strictEqual(maturityDate('2026-01-31', 1, 'months'), '2026-02-28');
});

test('maturityDate: unknown unit falls back to months', () => {
  assert.strictEqual(maturityDate('2026-07-01', 1, 'bogus'), '2026-08-01');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern=maturityDate`
Expected: FAIL — `maturityDate is not a function` (not yet exported).

- [ ] **Step 3: Implement `maturityDate()`**

In `src/utils/installments.js`, add the function and export it (file currently ends with `module.exports = { splitInstallments, dueDates };` at line 26):

```js
// Loan maturity date: startDate + tenure, in the given unit. Unknown/missing
// unit falls back to months (same default as tenure_unit's DB column default).
function maturityDate(startDate, tenure, unit) {
  const u = unit === 'years' ? 'year' : unit === 'days' ? 'day' : 'month';
  return dayjs(startDate).add(tenure, u).format('YYYY-MM-DD');
}

module.exports = { splitInstallments, dueDates, maturityDate };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern=maturityDate`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/installments.js test/tenure.test.js
git commit -m "feat: add maturityDate() for loan tenure calculation"
```

---

### Task 2: Schema + migration for `cases` tenure columns

**Files:**
- Modify: `src/db/schema.sql` (the `cases` table definition, lines 46-73)
- Modify: `src/db/index.js` (the `init()` migration block, lines 33-51)

**Interfaces:**
- Consumes: nothing.
- Produces: `cases` table gains columns `loan_start_date TEXT`, `tenure INTEGER`, `tenure_unit TEXT NOT NULL DEFAULT 'months'`, `maturity_date TEXT`. Task 3 (`tenureFields` in `cases.js`) writes to these columns; Task 4/5 (views) read them as `c.loan_start_date`, `c.tenure`, `c.tenure_unit`, `c.maturity_date`.

- [ ] **Step 1: Add the columns to `schema.sql`**

In `src/db/schema.sql`, the `cases` table currently ends its interest-related fields at `interest_from TEXT,` (line 63). Add the four new columns right after `interest_from TEXT,` and before `priority TEXT NOT NULL DEFAULT 'medium' ...` (line 64):

```sql
  interest_from TEXT,
  loan_start_date TEXT,
  tenure INTEGER,
  tenure_unit TEXT NOT NULL DEFAULT 'months' CHECK (tenure_unit IN ('days','months','years')),
  maturity_date TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
```

- [ ] **Step 2: Add the migration block to `src/db/index.js`**

In `init()`, right after the existing interest-mode migration lines (after line 51, `try { db.prepare('ALTER TABLE cases ADD COLUMN interest_from TEXT').run(); } catch (e) { /* exists */ }`), add:

```js
  // Migration: loan tenure & maturity date on cases (nullable; both start_date and
  // tenure must be present for maturity_date to be computed — see tenureFields()).
  try { db.prepare('ALTER TABLE cases ADD COLUMN loan_start_date TEXT').run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE cases ADD COLUMN tenure INTEGER').run(); } catch (e) { /* exists */ }
  try { db.prepare("ALTER TABLE cases ADD COLUMN tenure_unit TEXT NOT NULL DEFAULT 'months'").run(); } catch (e) { /* exists */ }
  try { db.prepare('ALTER TABLE cases ADD COLUMN maturity_date TEXT').run(); } catch (e) { /* exists */ }
```

- [ ] **Step 3: Verify migration runs cleanly against the existing dev DB**

Run: `node -e "require('./src/db').init(); console.log('ok')"`
Expected: prints `ok` with no thrown error (columns either created fresh or the `ALTER TABLE` throws-and-is-caught because they already exist from a prior run of this same command).

- [ ] **Step 4: Verify the columns exist**

Run: `node -e "require('./src/db').init(); const {all}=require('./src/db'); console.log(all(\"PRAGMA table_info(cases)\").map(r=>r.name).join(','))"`
Expected: output includes `loan_start_date,tenure,tenure_unit,maturity_date` among the column names.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/index.js
git commit -m "feat: add loan tenure columns to cases table"
```

---

### Task 3: Wire `tenureFields()` into case create/update routes

**Files:**
- Modify: `src/routes/cases.js`

**Interfaces:**
- Consumes: `maturityDate(startDate, tenure, unit)` from `src/utils/installments.js` (Task 1); `loan_start_date`/`tenure`/`tenure_unit`/`maturity_date` columns on `cases` (Task 2).
- Produces: `tenureFields(b) => { start: string|null, tenure: number|null, unit: 'days'|'months'|'years', maturity: string|null }`, module-local to `cases.js` (not exported — same visibility as the existing `interestFields`). Later view tasks rely on `c.loan_start_date`, `c.tenure`, `c.tenure_unit`, `c.maturity_date` being populated on the row returned by `loadCase()` and by the `SELECT cases.*` in `GET /`.

- [ ] **Step 1: Add the `maturityDate` import**

In `src/routes/cases.js` line 10, change:

```js
const { splitInstallments, dueDates } = require('../utils/installments');
```

to:

```js
const { splitInstallments, dueDates, maturityDate } = require('../utils/installments');
```

- [ ] **Step 2: Add `tenureFields()` helper**

Immediately after `interestFields()` (after line 41, before the `internalClientId()` comment on line 43), add:

```js
// Parse the loan-tenure form fields. maturity_date is only derived when both
// loan_start_date and tenure are present; otherwise it's left null so the UI
// hides the Maturity Date display rather than showing a bogus computed date.
function tenureFields(b) {
  const unit = ['days', 'months', 'years'].includes(b.tenure_unit) ? b.tenure_unit : 'months';
  const start = b.loan_start_date || null;
  const tenure = (b.tenure !== undefined && b.tenure !== '') ? Number(b.tenure) : null;
  const maturity = (start && tenure) ? maturityDate(start, tenure, unit) : null;
  return { start, tenure, unit, maturity };
}
```

- [ ] **Step 3: Wire into `POST /` (create)**

Replace lines 83-90:

```js
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  // Accrual modes start with ~0 interest; the manual interest field only applies to fixed.
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  const case_no = nextCaseNo();
  const r = run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,remark,next_action_at,interest_mode,interest_rate,interest_from)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [case_no, internalClientId(), b.debtor_id, b.agent_id||null, principal, interest, principal+interest, b.priority||'medium', b.status||'new', b.remark||null, b.next_action_at||null, mode, rate, from]);
```

with:

```js
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  // Accrual modes start with ~0 interest; the manual interest field only applies to fixed.
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  const { start: loanStart, tenure, unit: tenureUnit, maturity } = tenureFields(b);
  const case_no = nextCaseNo();
  const r = run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,remark,next_action_at,interest_mode,interest_rate,interest_from,loan_start_date,tenure,tenure_unit,maturity_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [case_no, internalClientId(), b.debtor_id, b.agent_id||null, principal, interest, principal+interest, b.priority||'medium', b.status||'new', b.remark||null, b.next_action_at||null, mode, rate, from, loanStart, tenure, tenureUnit, maturity]);
```

- [ ] **Step 4: Wire into `POST /:id` (update)**

Replace lines 115-119:

```js
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  run(`UPDATE cases SET debtor_id=?,agent_id=?,principal_amount=?,interest_amount=?,priority=?,remark=?,next_action_at=?,interest_mode=?,interest_rate=?,interest_from=?,updated_at=datetime('now') WHERE id=?`,
    [b.debtor_id,b.agent_id||null,principal,interest,b.priority||'medium',b.remark||null,b.next_action_at||null,mode,rate,from,req.params.id]);
```

with:

```js
  const principal = Number(b.principal_amount)||0;
  const { mode, rate, from } = interestFields(b);
  const interest = mode === 'fixed' ? (Number(b.interest_amount)||0) : 0;
  const { start: loanStart, tenure, unit: tenureUnit, maturity } = tenureFields(b);
  run(`UPDATE cases SET debtor_id=?,agent_id=?,principal_amount=?,interest_amount=?,priority=?,remark=?,next_action_at=?,interest_mode=?,interest_rate=?,interest_from=?,loan_start_date=?,tenure=?,tenure_unit=?,maturity_date=?,updated_at=datetime('now') WHERE id=?`,
    [b.debtor_id,b.agent_id||null,principal,interest,b.priority||'medium',b.remark||null,b.next_action_at||null,mode,rate,from,loanStart,tenure,tenureUnit,maturity,req.params.id]);
```

- [ ] **Step 5: Verify the module still loads cleanly**

`tenureFields`/`interestFields` are module-local (not exported), matching the existing convention — so this task's logic can't be unit-invoked from outside the module. Task 1's tests already cover `maturityDate()`'s calculation logic; this step only confirms the edit didn't introduce a syntax error.

Run: `node -e "require('./src/routes/cases'); console.log('ok')"`
Expected: prints `ok`, no thrown error.

The real end-to-end check (form submit → `tenureFields()` → DB write → read back) happens in Task 5's manual verification step, since that's the only point where all the pieces are wired together.

- [ ] **Step 6: Commit**

```bash
git add src/routes/cases.js
git commit -m "feat: wire loan tenure fields into case create/update routes"
```

---

### Task 4: Add tenure inputs to the case form

**Files:**
- Modify: `src/views/cases/form.ejs`

**Interfaces:**
- Consumes: `c.loan_start_date`, `c.tenure`, `c.tenure_unit` (row passed in from `cases.js` `GET /new` and `GET /:id/edit`, Task 3's `SELECT cases.*` already includes the new columns via `loadCase()`).
- Produces: form fields named `loan_start_date`, `tenure`, `tenure_unit` in the submitted POST body, consumed by `tenureFields(b)` (Task 3).

- [ ] **Step 1: Add the three inputs**

In `src/views/cases/form.ejs`, after line 12 (`<label>Principal Amount ...</label>`) and before line 13 (`<label>Interest Mode ...`), insert:

```html
  <label>Loan Start Date <input type="date" name="loan_start_date" value="<%= c.loan_start_date||'' %>"></label>
  <label>Tenure <input name="tenure" type="number" step="1" min="1" value="<%= c.tenure||'' %>"></label>
  <label>Tenure Unit <select name="tenure_unit">
    <% ['days','months','years'].forEach(u => { %><option value="<%= u %>" <%= (c.tenure_unit||'months')===u?'selected':'' %>><%= u %></option><% }) %>
  </select></label>
```

- [ ] **Step 2: Manual verification**

Run: `npm start`, log in, open `/cases/new`. Confirm the three new fields render between Principal Amount and Interest Mode, Tenure Unit defaults to "months", and the page has no console errors.

- [ ] **Step 3: Commit**

```bash
git add src/views/cases/form.ejs
git commit -m "feat: add loan tenure inputs to case form"
```

---

### Task 5: Show Maturity Date on the case detail page

**Files:**
- Modify: `src/views/cases/show.ejs`

**Interfaces:**
- Consumes: `c.maturity_date` (populated by Task 3's `tenureFields()` write, read back via `loadCase()`'s `SELECT cases.*`); `h.dateFmt` (existing helper from `src/utils/helpers.js`, already used elsewhere in this file for `due_date`/`payment_date`).

- [ ] **Step 1: Add the Maturity Date ledger cell**

In `src/views/cases/show.ejs`, the `ledger-break` div (lines 33-37) currently reads:

```html
  <div class="ledger-break">
    <div><div class="ledger-lbl">Principal</div><div class="ledger-val"><%= h.money(c.principal_amount) %></div></div>
    <div><div class="ledger-lbl">Interest</div><div class="ledger-val"><%= h.money(c.interest_amount) %></div></div>
    <div><div class="ledger-lbl">Paid</div><div class="ledger-val pos"><%= h.money(paid) %></div></div>
  </div>
```

Change to:

```html
  <div class="ledger-break">
    <div><div class="ledger-lbl">Principal</div><div class="ledger-val"><%= h.money(c.principal_amount) %></div></div>
    <div><div class="ledger-lbl">Interest</div><div class="ledger-val"><%= h.money(c.interest_amount) %></div></div>
    <div><div class="ledger-lbl">Paid</div><div class="ledger-val pos"><%= h.money(paid) %></div></div>
    <% if (c.maturity_date) { %>
    <div><div class="ledger-lbl">Maturity Date</div><div class="ledger-val"><%= h.dateFmt(c.maturity_date) %></div></div>
    <% } %>
  </div>
```

- [ ] **Step 2: Manual verification — full end-to-end flow**

Run: `npm start`, log in, go to `/cases/new`, fill in a debtor, Principal Amount, Loan Start Date `2026-07-01`, Tenure `12`, Tenure Unit `months`, save. Confirm:
- Redirected to the new case's detail page.
- The ledger row now shows a fourth "Maturity Date" cell reading `2027-07-01`.

Then open a case that was created *before* this change (or create one leaving Loan Start Date / Tenure blank) and confirm the Maturity Date cell does not render at all (no empty/blank cell, no "Invalid date" text).

- [ ] **Step 3: Commit**

```bash
git add src/views/cases/show.ejs
git commit -m "feat: display maturity date on case detail page"
```

---

### Task 6: Full test suite regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the 5 new `tenure.test.js` tests, with no failures introduced in `installments.test.js`, `interest_accrual.test.js`, or any other existing suite.

- [ ] **Step 2: If anything fails, fix and re-run**

Do not commit a red suite. If a failure traces back to this plan's changes, fix the offending task's code and re-run `npm test` until green.
