# B-Remaining: Remove client role + Case Statement PDF — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `client` role from the usable surface (no client account can be created or seeded), and add a printable per-case statement page (browser Ctrl+P → Save as PDF).

**Architecture:** Task 1 drops `client` from the user ROLES list, the seed, and docs — leaving the deep scope/report `client` branches as harmless dead code. Task 2 adds `GET /cases/:id/statement` (scoped via `loadCase`) rendering a standalone print-friendly view with a `window.print()` button. No schema change, no new deps.

**Tech Stack:** Node.js, `node:sqlite`, Express, EJS, `@media print` CSS, `node:test`.

## Global Constraints

- Node ≥ 22.5; run with `node --no-warnings`. Zero new dependencies (no PDF library — browser print).
- Spec: `docs/superpowers/specs/2026-07-05-B-remaining-design.md`.
- Client removal is UI-level: drop from `ROLES`, drop the seed `client1` user, fix docs. Do NOT touch the schema CHECK or the defensive `client` branches in scope.js/reports/tasks/search/cases (harmless dead code once no client user exists).
- The statement route reuses `loadCase(req, res)` from cases.js (scope enforcement + 404) so an agent can only generate a statement for their own cases.
- Statement view is STANDALONE (own `<!doctype>`, no sidebar `layout`), like `login.ejs`/`demo-accounts.ejs`. `res.locals.h` (helpers) is available in it. Money shown via `h.money`, dates via `h.dateFmt` (MYT). MYT "today": `new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10)`.
- Tests use isolated DB via `process.env.CRM_DB_PATH` set at the top of the test file before requiring `../src/db`.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/routes/users.js` — drop `'client'` from `ROLES`.
- `src/db/seed.js` — remove the `client1` user insert; fix the completion `console.log` count.
- `README.md` — remove the `client1` demo-accounts row.
- `src/routes/cases.js` — add `GET /:id/statement`.
- `src/views/cases/statement.ejs` — NEW standalone printable statement.
- `src/views/cases/show.ejs` — add a "Print statement" link in the page head.
- `test/b_remaining.test.js` — NEW, tests: no client user after seed; statement paid-sum correctness.

---

### Task 1: Remove the client role (UI + seed + docs)

**Files:**
- Modify: `src/routes/users.js`
- Modify: `src/db/seed.js`
- Modify: `README.md`
- Create: `test/b_remaining.test.js`

**Interfaces:** none new. After this task, `seedDemo()` creates 7 users (admin, manager, agent1-3, finance, auditor) and zero `client`-role users.

- [ ] **Step 1: Write the failing test `test/b_remaining.test.js`**

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-brem-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');

test('seed creates no client-role users', () => {
  seed.seedDemo();
  assert.strictEqual(db.get("SELECT COUNT(*) c FROM users WHERE role='client'").c, 0);
  assert.strictEqual(db.get("SELECT COUNT(*) c FROM users").c, 7);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node --no-warnings --test test/b_remaining.test.js`
Expected: FAIL — seed still inserts `client1` (count is 1 client / 8 total).

- [ ] **Step 3: Drop `'client'` from ROLES in `src/routes/users.js`**

Change:
```js
const ROLES = ['admin', 'manager', 'agent', 'finance', 'auditor', 'client'];
```
to:
```js
const ROLES = ['admin', 'manager', 'agent', 'finance', 'auditor'];
```

- [ ] **Step 4: Remove the client1 user + fix the count in `src/db/seed.js`**

Delete this line (currently line 107):
```js
run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['client1',hash('client123'),'Sinar Consumer Credit','client',null,1]);
```

Change the completion log (currently line 140):
```js
  console.log('Seed complete: 6 users, 5 clients, 12 debtors, 4 agents, 20 cases + related data.');
```
to:
```js
  console.log('Seed complete: 7 users, 5 clients, 12 debtors, 4 agents, 20 cases + related data.');
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `node --no-warnings --test test/b_remaining.test.js`
Expected: PASS.

- [ ] **Step 6: Remove the client1 row from `README.md`**

Delete this line (the demo-accounts table row, currently line 46):
```
| client1  | client123   | Only own company's cases (read-only)              |
```

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: all pass. Report the count.

- [ ] **Step 8: Live smoke (no client login; role dropdown has no client)**

```bash
npm run seed
PORT=4301 node --no-warnings src/app.js & sleep 2
B=http://localhost:4301
# client1 can no longer log in (401)
echo "client1 login: $(curl -s -o /dev/null -w '%{http_code}' -d 'username=client1&password=client123' $B/login) (expect 401)"
# new-user role dropdown has no 'client'
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=admin&password=admin123" $B/login
echo "client option in new-user form (expect 0): $(curl -s -b /tmp/a "$B/users/new" | grep -oE '<option value="client"' | wc -l)"
```
Expected: `client1 login: 401`; `client option ... 0`. Kill server, `npm run seed`.

- [ ] **Step 9: Commit**

```bash
git add src/routes/users.js src/db/seed.js README.md test/b_remaining.test.js
git commit -m "$(printf 'feat: remove client role from usable surface (UI + seed + docs)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Case statement — printable page (Save as PDF)

**Files:**
- Modify: `src/routes/cases.js`
- Create: `src/views/cases/statement.ejs`
- Modify: `src/views/cases/show.ejs`
- Test: `test/b_remaining.test.js` (append)

**Interfaces:**
- Consumes: `loadCase(req, res)` (already in cases.js), `all` (db). Produces: `GET /cases/:id/statement` rendering `cases/statement` with `{ c, payments, paid, today }`.

- [ ] **Step 1: Append a paid-sum test to `test/b_remaining.test.js`**

```js
test('statement paid = SUM(payments); fully_paid case has paid == principal+interest', () => {
  seed.seedDemo();
  const c = db.get("SELECT * FROM cases WHERE status='fully_paid' LIMIT 1");
  const paid = db.get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE case_id=?', [c.id]).s;
  assert.ok(paid > 0);
  assert.strictEqual(paid, c.principal_amount + c.interest_amount);   // fully paid → paid covers total
  assert.strictEqual(c.outstanding_amount, 0);
});
```

- [ ] **Step 2: Run it — expect PASS** (verifies the data the statement will show)

Run: `node --no-warnings --test test/b_remaining.test.js`
Expected: PASS (both tests).

- [ ] **Step 3: Add `GET /:id/statement` in `src/routes/cases.js`**

Find the existing `router.get('/:id/edit', ...)` handler. Immediately AFTER its closing `});`, add:

```js
router.get('/:id/statement', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date', [c.id]);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  res.render('cases/statement', { c, payments, paid, today });
});
```

(`loadCase` and `all` are already imported in cases.js.)

- [ ] **Step 4: Create `src/views/cases/statement.ejs`**

```ejs
<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Case Statement <%= c.case_no %></title>
<link rel="stylesheet" href="/css/style.css">
<style>
  body { background: #fff; padding: 32px; max-width: 820px; margin: 0 auto; color: var(--ink-text); }
  .stmt-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--ink); padding-bottom: 12px; margin-bottom: 22px; }
  .stmt-head h1 { margin: 0; }
  .stmt-actions { margin-bottom: 20px; display: flex; gap: 8px; }
  .stmt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 28px; margin-bottom: 26px; }
  .stmt-grid div span { display: block; font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
  @media print { .stmt-actions { display: none; } body { padding: 0; max-width: none; } }
</style>
</head><body>
  <div class="stmt-actions">
    <button class="btn btn-gold" type="button" onclick="window.print()">Print / Save as PDF</button>
    <a class="btn" href="/cases/<%= c.id %>">&larr; Back</a>
  </div>
  <div class="stmt-head">
    <div><h1>Debt Collection <span style="color:var(--gold)">CRM</span></h1><div>Case Statement</div></div>
    <div style="text-align:right"><div class="mono"><%= c.case_no %></div><div><%= today %></div></div>
  </div>
  <div class="stmt-grid">
    <div><span>Debtor</span><%= c.debtor_name %></div>
    <div><span>Phone</span><%= c.debtor_phone || '—' %></div>
    <div><span>IC/Passport</span><%= c.ic_passport || '—' %></div>
    <div><span>Status</span><%= h.caseStatusLabel(c.status) %></div>
    <div><span>Principal</span>RM <%= h.money(c.principal_amount) %></div>
    <div><span>Interest</span>RM <%= h.money(c.interest_amount) %></div>
    <div><span>Paid</span>RM <%= h.money(paid) %></div>
    <div><span>Outstanding</span>RM <%= h.money(c.outstanding_amount) %></div>
  </div>
  <h2>Payment History</h2>
  <% if (!payments.length) { %><p>No payments recorded.</p><% } else { %>
  <table class="data"><thead><tr><th>Receipt No</th><th>Date</th><th class="num">Amount</th><th>Method</th></tr></thead>
  <tbody><% payments.forEach(p => { %><tr><td class="mono"><%= p.receipt_no %></td><td><%= h.dateFmt(p.payment_date) %></td>
  <td class="num">RM <%= h.money(p.amount) %></td><td><%= p.method %></td></tr><% }) %></tbody></table>
  <% } %>
</body></html>
```

- [ ] **Step 5: Add the "Print statement" link in `src/views/cases/show.ejs` page head**

The page head currently is:
```ejs
<div class="page-head">
  <h1><%= c.case_no %> <%- include('../partials/statusBadge', { status: c.status }) %></h1>
  <% if (['admin','manager'].includes(currentUser.role)) { %><a class="btn" href="/cases/<%= c.id %>/edit">Edit Case</a><% } %>
</div>
```

Add a Print statement link so it becomes:
```ejs
<div class="page-head">
  <h1><%= c.case_no %> <%- include('../partials/statusBadge', { status: c.status }) %></h1>
  <div style="display:flex; gap:0.5rem;">
    <a class="btn" href="/cases/<%= c.id %>/statement" target="_blank">Print statement</a>
    <% if (['admin','manager'].includes(currentUser.role)) { %><a class="btn" href="/cases/<%= c.id %>/edit">Edit Case</a><% } %>
  </div>
</div>
```

- [ ] **Step 6: Load + compile check**

Run: `node -e "require('./src/routes/cases').router; const ejs=require('ejs'),fs=require('fs'); for(const f of ['src/views/cases/statement.ejs','src/views/cases/show.ejs']) ejs.compile(fs.readFileSync(f,'utf8'),{filename:f}); console.log('OK')"` then `npm test`
Expected: `OK`; all tests pass.

- [ ] **Step 7: Live smoke (statement renders; scope 404)**

```bash
npm run seed
PORT=4302 node --no-warnings src/app.js & sleep 2
B=http://localhost:4302
curl -s -c /tmp/m -b /tmp/m -o /dev/null -d "username=manager&password=manager123" $B/login
# a fully_paid case has payments to show
CID=$(node -e "const d=require('./src/db');d.init();console.log(d.get(\"SELECT id FROM cases WHERE status='fully_paid' LIMIT 1\").id)")
echo "statement http: $(curl -s -b /tmp/m -o /dev/null -w '%{http_code}' $B/cases/$CID/statement)"
echo "has Case Statement + print button: $(curl -s -b /tmp/m $B/cases/$CID/statement | grep -c 'window.print()')"
echo "show page has Print statement link: $(curl -s -b /tmp/m $B/cases/$CID | grep -c '/statement')"
# agent scope: agent1 gets 404 on a case that isn't theirs
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=agent1&password=agent123" $B/login
OOS=$(node -e "const d=require('./src/db');d.init();console.log(d.get('SELECT id FROM cases WHERE agent_id IS NULL OR agent_id<>1 LIMIT 1').id)")
echo "agent1 out-of-scope statement (expect 404): $(curl -s -b /tmp/a -o /dev/null -w '%{http_code}' $B/cases/$OOS/statement)"
```
Expected: `statement http: 200`, print button present (1), show-page link present (≥1), agent1 out-of-scope → 404. Kill server, `npm run seed`.

- [ ] **Step 8: Commit**

```bash
git add src/routes/cases.js src/views/cases/statement.ejs src/views/cases/show.ejs test/b_remaining.test.js
git commit -m "$(printf 'feat: printable per-case statement (Save as PDF via browser print)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- Remove client from ROLES (can't create/edit to client) → Task 1 Step 3. ✓
- Remove client1 seed user + fix count → Task 1 Steps 4. ✓
- README client row removed → Task 1 Step 6. ✓
- Keep schema CHECK + defensive client branches (dead code) → not touched by any task. ✓
- Statement route scoped via loadCase (agent only own cases, 404) → Task 2 Step 3 + smoke. ✓
- Standalone printable statement (debtor + principal/interest/paid/outstanding + payment history), print button, @media print hides actions → Task 2 Step 4. ✓
- Print statement entry link on case detail → Task 2 Step 5. ✓
- Tests: no client user after seed; statement paid-sum correctness → Task 1 + Task 2 tests. ✓
- Zero deps, no schema change → both tasks. ✓

**Placeholder scan:** none — full code for every edit, the whole statement view, and both tests.

**Type consistency:** `seedDemo()` (from src/db/seed.js) used in tests matches existing export. `loadCase(req,res)`/`all` already exist in cases.js. Statement render locals `{c, payments, paid, today}` match the fields the view reads (`c.debtor_name/debtor_phone/ic_passport/status/principal_amount/interest_amount/outstanding_amount/case_no/id`, `payments[].receipt_no/payment_date/amount/method`, `paid`, `today`). `h.money`/`h.dateFmt`/`h.caseStatusLabel` are exported from helpers and available via res.locals.h. The `/statement` route (two path segments) does not collide with `/:id`.
