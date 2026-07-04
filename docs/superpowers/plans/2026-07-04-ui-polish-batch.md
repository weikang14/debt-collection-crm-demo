# UI Polish Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four independent UI/logic polish items: agent Status dropdown (default Active), detailed Reports per-case CSV, richer Cases-list CSV, and a collapsible "+ New Task" form.

**Architecture:** Small edits to existing routes/views. Two small pure helpers (`parseActive`, and a per-case CSV row query) get unit tests; the rest is verified via live smoke. No schema change.

**Tech Stack:** Node.js, `node:sqlite`, Express, EJS, `node:test`.

## Global Constraints

- Node ≥ 22.5; run with `node --no-warnings`. Zero new dependencies.
- Spec: `docs/superpowers/specs/2026-07-04-ui-polish-batch-design.md`. The interest-model change is OUT of scope (deferred).
- CSV via existing `src/utils/csv.js` (`toCsv(headers, rows)`, `sendCsv(res, filename, csv)` — already UTF-8 BOM). CSV money = raw numeric (no thousands separators). Dates via `dateFmt` (MYT). Status via `caseStatusLabel`.
- All case exports honor row-level scope via `caseWhere(user)` (agent/client only see their own).
- Paid per case = `(SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id)`.
- **Reports detailed columns (financial):** `Case No, Debtor, Agent, Principal, Interest, Paid, Outstanding, Status, Opened`.
- **Cases-list columns (operations):** `Case No, Debtor, Debtor Phone, Agent, Outstanding, Paid, Priority, Status, Opened`.
- agent `active` control becomes a `<select name="active">` (value "1" Active / "0" Inactive), default Active on new. Route must parse the string value correctly (`"0"` is truthy in JS — the old `b.active?1:0` is a bug under a select).
- Tests use the isolated DB via `process.env.CRM_DB_PATH` (set at the top of a test file before requiring `../src/db`).
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/utils/forms.js` — NEW tiny module exporting `parseActive(v)` (shared, unit-tested).
- `src/routes/agents.js` — use `parseActive` in create+update.
- `src/views/agents/form.ejs` — checkbox → Status select.
- `src/routes/reports.js` — add `export=cases` detailed CSV branch.
- `src/views/reports/index.ejs` — add "Export detailed cases (CSV)" button.
- `src/routes/cases.js` — enrich the `format=csv` branch (Debtor Phone + Paid columns).
- `src/views/tasks/index.ejs` — wrap the new-task form in `<details>`.
- `public/css/style.css` — `.new-panel` summary-as-button styles.
- `test/forms.test.js` — NEW, tests `parseActive`.
- `test/demo.test.js` — reused isolated-DB file; add a paid-subquery assertion (Task 3).

---

### Task 1: `parseActive` helper + agent Status dropdown

**Files:**
- Create: `src/utils/forms.js`
- Create: `test/forms.test.js`
- Modify: `src/routes/agents.js`
- Modify: `src/views/agents/form.ejs`

**Interfaces:**
- Produces: `parseActive(v)` → returns `0` only when `v === '0'`, else `1` (missing/`'1'`/`'on'` → 1). Used by agents create+update.

- [ ] **Step 1: Write the failing test `test/forms.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseActive } = require('../src/utils/forms');

test('parseActive: only "0" is inactive; everything else is active', () => {
  assert.strictEqual(parseActive('0'), 0);
  assert.strictEqual(parseActive('1'), 1);
  assert.strictEqual(parseActive(undefined), 1); // create default
  assert.strictEqual(parseActive('on'), 1);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node --no-warnings --test test/forms.test.js`
Expected: FAIL — cannot find module `../src/utils/forms` (or parseActive undefined).

- [ ] **Step 3: Create `src/utils/forms.js`**

```js
// Parse an "active" form value. A <select> sends the string "0" or "1"; note
// that "0" is truthy in JS, so a naive `v?1:0` would wrongly mark Inactive as
// active. Only an explicit "0" means inactive; anything else defaults to active.
function parseActive(v) {
  return v === '0' ? 0 : 1;
}
module.exports = { parseActive };
```

- [ ] **Step 4: Run it — expect PASS**

Run: `node --no-warnings --test test/forms.test.js`
Expected: PASS.

- [ ] **Step 5: Use `parseActive` in `src/routes/agents.js`**

Add the import near the top (after the existing requires):

```js
const { parseActive } = require('../utils/forms');
```

In `router.post('/', ...)` (create), replace the INSERT's active expression. Change:

```js
    [name,S(b.contact),S(b.department),Number(b.target_amount)||0,Number(b.commission_rate)||5, b.active?1:0]);
```
to:
```js
    [name,S(b.contact),S(b.department),Number(b.target_amount)||0,Number(b.commission_rate)||5, parseActive(b.active)]);
```

In `router.post('/:id', ...)` (update), change:

```js
    [name,S(b.contact),S(b.department),Number(b.target_amount)||0,Number(b.commission_rate)||5, b.active?1:0, req.params.id]);
```
to:
```js
    [name,S(b.contact),S(b.department),Number(b.target_amount)||0,Number(b.commission_rate)||5, parseActive(b.active), req.params.id]);
```

- [ ] **Step 6: Replace the checkbox in `src/views/agents/form.ejs`**

Replace this line:

```ejs
  <label><input type="checkbox" name="active" value="1" <%= agent.active!=null ? (agent.active?'checked':'') : 'checked' %>> Active</label>
```

with:

```ejs
  <label>Status <select name="active">
    <option value="1" <%= agent.active===0 ? '' : 'selected' %>>Active</option>
    <option value="0" <%= agent.active===0 ? 'selected' : '' %>>Inactive</option>
  </select></label>
```

- [ ] **Step 7: Verify load + full suite**

Run: `node -e "require('./src/routes/agents'); const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/agents/form.ejs','utf8'),{filename:'a'}); console.log('OK')"` then `npm test`
Expected: `OK`; all tests pass.

- [ ] **Step 8: Live smoke (agent active)**

```bash
npm run seed
PORT=4090 node --no-warnings src/app.js & sleep 2
B=http://localhost:4090
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=admin&password=admin123" $B/login
# new form defaults to Active selected
curl -s -b /tmp/a "$B/agents/new" | grep -o 'value="1" selected' && echo "default=Active OK"
# create an Inactive agent -> stored active=0
curl -s -b /tmp/a -o /dev/null -d "name=Inactive+Guy&active=0" "$B/agents"
node -e "const d=require('./src/db');d.init();console.log('stored active =', d.get(\"SELECT active FROM agents WHERE name='Inactive Guy'\").active)"
```
Expected: `default=Active OK`; `stored active = 0`. Kill the server and `npm run seed` afterward.

- [ ] **Step 9: Commit**

```bash
git add src/utils/forms.js test/forms.test.js src/routes/agents.js src/views/agents/form.ejs
git commit -m "$(printf 'feat: agent Status dropdown (default Active) via parseActive\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Collapsible "+ New Task" form

**Files:**
- Modify: `src/views/tasks/index.ejs`
- Modify: `public/css/style.css`

**Interfaces:** none (view/CSS only). The form's fields, `action="/tasks/new"`, and role guard are unchanged — only wrapped in `<details>`.

- [ ] **Step 1: Wrap the form in `src/views/tasks/index.ejs`**

The current block is:

```ejs
<% if (['admin','manager','agent'].includes(currentUser.role)) { %>
<form class="card form" method="post" action="/tasks/new">
  ... fields ...
  <div class="form-actions"><button class="btn btn-gold" type="submit">Save</button></div>
</form>
<% } %>
```

Wrap the `<form>` (keep all fields byte-for-byte) so it becomes:

```ejs
<% if (['admin','manager','agent'].includes(currentUser.role)) { %>
<details class="new-panel">
  <summary class="btn btn-gold">+ New Task</summary>
  <form class="card form" method="post" action="/tasks/new">
    ... fields unchanged ...
    <div class="form-actions"><button class="btn btn-gold" type="submit">Save</button></div>
  </form>
</details>
<% } %>
```

Do not change any `<label>`/`<input>`/`<select>` inside the form.

- [ ] **Step 2: Add `.new-panel` styles to `public/css/style.css`**

Append near the form styles:

```css
/* Collapsible "+ New" panel (native <details>) */
.new-panel { margin-bottom: 16px; }
.new-panel > summary {
  display: inline-flex; align-items: center; cursor: pointer; list-style: none;
}
.new-panel > summary::-webkit-details-marker { display: none; }
.new-panel[open] > summary { margin-bottom: 12px; }
```

- [ ] **Step 3: Compile check**

Run: `node -e "const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/tasks/index.ejs','utf8'),{filename:'t'}); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: Live smoke (form collapsed, still works)**

```bash
npm run seed
PORT=4091 node --no-warnings src/app.js & sleep 2
B=http://localhost:4091
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=manager&password=manager123" $B/login
# details present, form collapsed by default (no `open` attribute on the details)
curl -s -b /tmp/a "$B/tasks" | grep -o '<details class="new-panel">' && echo "collapsible present"
# creating a task still works
curl -s -b /tmp/a -o /dev/null -d "title=Smoke+Task&type=follow_up" "$B/tasks/new"
node -e "const d=require('./src/db');d.init();console.log('task created:', !!d.get(\"SELECT id FROM tasks WHERE title='Smoke Task'\"))"
```
Expected: `collapsible present`; `task created: true`. Kill server, `npm run seed`.

- [ ] **Step 5: Commit**

```bash
git add src/views/tasks/index.ejs public/css/style.css
git commit -m "$(printf 'feat: collapse new-task form behind a + New Task toggle\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Detailed Reports per-case CSV export

**Files:**
- Modify: `src/routes/reports.js`
- Modify: `src/views/reports/index.ejs`
- Test: `test/demo.test.js` (append one assertion)

**Interfaces:**
- Consumes: `caseWhere`, `toCsv`, `sendCsv`, `caseStatusLabel`, `dateFmt`.
- Produces: `GET /reports?export=cases` → downloads `cases-detailed.csv` with the financial columns, scoped.

- [ ] **Step 1: Add a paid-subquery assertion to `test/demo.test.js`**

Append (this file already sets `CRM_DB_PATH` and requires `../src/db` + seeds):

```js
test('per-case paid subquery sums a case\'s payments', () => {
  seed.seedDemo();
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (7,'RCPT-T-1','2026-07-04',30)");
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (7,'RCPT-T-2','2026-07-04',20)");
  const row = db.get("SELECT (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid FROM cases WHERE id=7");
  assert.strictEqual(row.paid, 50);
});
```

- [ ] **Step 2: Run it — expect PASS** (it just verifies the SQL shape)

Run: `node --no-warnings --test test/demo.test.js`
Expected: PASS. (Confirms the paid subquery works before wiring the route.)

- [ ] **Step 3: Add the `export=cases` branch in `src/routes/reports.js`**

The route already imports `caseWhere, toCsv, sendCsv, caseStatusLabel`. Add `dateFmt` to the helpers import — change:

```js
const { caseStatusLabel } = require('../utils/helpers');
```
to:
```js
const { caseStatusLabel, dateFmt } = require('../utils/helpers');
```

Then, immediately BEFORE the existing `if (req.query.export === 'outstanding') {` block, add:

```js
  if (req.query.export === 'cases') {
    const rows = all(`SELECT cases.case_no, debtors.name AS debtor_name, agents.name AS agent_name,
        cases.principal_amount, cases.interest_amount, cases.outstanding_amount, cases.status, cases.opened_at,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid
      FROM cases JOIN debtors ON debtors.id=cases.debtor_id
      LEFT JOIN agents ON agents.id=cases.agent_id
      WHERE ${w.clause} ORDER BY cases.opened_at DESC`, w.params)
      .map(c => [c.case_no, c.debtor_name, c.agent_name || '', c.principal_amount, c.interest_amount, c.paid, c.outstanding_amount, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
    return sendCsv(res, 'cases-detailed.csv', toCsv(['Case No', 'Debtor', 'Agent', 'Principal', 'Interest', 'Paid', 'Outstanding', 'Status', 'Opened'], rows));
  }
```

(`w` is already defined above as `const w = caseWhere(req.session.user);`.)

- [ ] **Step 4: Add the button in `src/views/reports/index.ejs`**

Right after the date-range filter form (the `<form class="card filters" method="get" action="/reports"> ... </form>` block), add:

```ejs
<p><a class="btn" href="/reports?export=cases">Export detailed cases (CSV)</a></p>
```

- [ ] **Step 5: Load + compile check**

Run: `node -e "require('./src/routes/reports'); const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/reports/index.ejs','utf8'),{filename:'r'}); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 6: Live smoke (detailed CSV + scope)**

```bash
npm run seed
PORT=4092 node --no-warnings src/app.js & sleep 2
B=http://localhost:4092
curl -s -c /tmp/m -b /tmp/m -o /dev/null -d "username=manager&password=manager123" $B/login
curl -s -b /tmp/m -D - -o /tmp/rep.csv "$B/reports?export=cases" | grep -i "content-disposition"
head -1 /tmp/rep.csv    # header row
echo "manager rows: $(wc -l < /tmp/rep.csv)"
# agent1 scope -> fewer rows
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=agent1&password=agent123" $B/login
curl -s -b /tmp/a -o /tmp/rep_a.csv "$B/reports?export=cases"
echo "agent1 rows: $(wc -l < /tmp/rep_a.csv)"
```
Expected: `content-disposition: attachment; filename="cases-detailed.csv"`; header = `Case No,Debtor,Agent,Principal,Interest,Paid,Outstanding,Status,Opened` (with a leading BOM); manager rows (21 = header + 20 cases) > agent1 rows. Kill server, `npm run seed`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/reports.js src/views/reports/index.ejs test/demo.test.js
git commit -m "$(printf 'feat: detailed per-case CSV export on Reports (scoped)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Richer Cases-list CSV

**Files:**
- Modify: `src/routes/cases.js`

**Interfaces:**
- Consumes: existing `toCsv`, `sendCsv`, `caseStatusLabel`, `dateFmt` (already imported in cases.js).
- Produces: `GET /cases?format=csv` → `cases.csv` with operations columns incl. Debtor Phone + Paid.

- [ ] **Step 1: Enrich the list query + CSV branch in `src/routes/cases.js`**

The list query currently selects `cases.*, clients.company_name AS client_name, debtors.name AS debtor_name, agents.name AS agent_name`. Add debtor phone and a paid subquery. Change the SELECT list to also include:

```sql
      debtors.phone AS debtor_phone,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid
```

so the full query becomes:

```js
  const cases = all(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name, debtors.phone AS debtor_phone, agents.name AS agent_name,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE ${filters.join(' AND ')} ORDER BY cases.opened_at DESC`, params);
```

Then replace the CSV branch:

```js
  if (req.query.format === 'csv') {
    const rows = cases.map(c => [c.case_no, c.debtor_name, c.agent_name || '', c.outstanding_amount, c.priority, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
    return sendCsv(res, 'cases.csv', toCsv(['Case No', 'Debtor', 'Agent', 'Outstanding', 'Priority', 'Status', 'Opened'], rows));
  }
```
with:

```js
  if (req.query.format === 'csv') {
    const rows = cases.map(c => [c.case_no, c.debtor_name, c.debtor_phone || '', c.agent_name || '', c.outstanding_amount, c.paid, c.priority, caseStatusLabel(c.status), dateFmt(c.opened_at)]);
    return sendCsv(res, 'cases.csv', toCsv(['Case No', 'Debtor', 'Debtor Phone', 'Agent', 'Outstanding', 'Paid', 'Priority', 'Status', 'Opened'], rows));
  }
```

The `cases/list` render below is unchanged (list.ejs ignores the extra columns).

- [ ] **Step 2: Load check + full suite**

Run: `node -e "require('./src/routes/cases').router; console.log('OK')"` then `npm test`
Expected: `OK`; all tests pass.

- [ ] **Step 3: Live smoke (richer cases CSV, filters respected)**

```bash
npm run seed
PORT=4093 node --no-warnings src/app.js & sleep 2
B=http://localhost:4093
curl -s -c /tmp/m -b /tmp/m -o /dev/null -d "username=manager&password=manager123" $B/login
curl -s -b /tmp/m -o /tmp/cases.csv "$B/cases?format=csv"
head -1 /tmp/cases.csv     # header incl Debtor Phone + Paid
echo "all rows: $(wc -l < /tmp/cases.csv)"
# filter respected: status=legal narrows
curl -s -b /tmp/m -o /tmp/legal.csv "$B/cases?format=csv&status=legal"
echo "legal rows: $(wc -l < /tmp/legal.csv)"
```
Expected: header = `Case No,Debtor,Debtor Phone,Agent,Outstanding,Paid,Priority,Status,Opened` (leading BOM); `legal rows` < `all rows`. Kill server, `npm run seed`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/cases.js
git commit -m "$(printf 'feat: richer Cases-list CSV (debtor phone + paid columns)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- #1 agent active dropdown default Active + route parse fix → Task 1 (`parseActive`, form select). ✓
- #2 Reports detailed per-case CSV (financial columns, scoped) → Task 3. ✓
- #3 Cases-list CSV enriched (operations columns: Debtor Phone + Paid) → Task 4. ✓
- #4 collapsible new-task form (`<details>` + "+ New Task") → Task 2. ✓
- Distinct Reports vs Cases columns → Tasks 3 & 4 use the two column sets from Global Constraints. ✓
- Paid subquery correctness → Task 3 test. ✓
- Scope honored on exports → Task 3 (reports uses `caseWhere`); Task 4 (cases list already applies `caseWhere` in `filters`). ✓
- Interest model → explicitly deferred (not in any task). ✓

**Placeholder scan:** none — every code step shows the exact change. (The task-form "... fields unchanged ..." explicitly means keep the existing markup byte-for-byte; not a placeholder for new code.)

**Type consistency:** `parseActive(v)` name consistent across forms.js, test, and both agent routes. CSV `toCsv(headers, rows)` / `sendCsv(res, filename, csv)` signatures match existing usage. Column header arrays match the Global Constraints column sets. `dateFmt`/`caseStatusLabel` imported where used (reports.js gains `dateFmt`; cases.js already has both).
