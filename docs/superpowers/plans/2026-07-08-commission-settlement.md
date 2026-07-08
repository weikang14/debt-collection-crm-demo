# Commission Settlement Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track commission payouts per agent per month — show Earned / Settled / Pending, record settlement payouts, and void mistaken ones.

**Architecture:** A new `commission_settlements` table records payouts. A pure-ish core `commissionRows(user, month)` computes each agent's Earned (collected×rate), Settled (sum of payouts for the month), and Pending — scoped so an `agent` sees only their own row. Thin routes render the page and record/void settlements.

**Tech Stack:** Node.js ≥22.5, node:sqlite (DatabaseSync), Express 4, EJS/ejs-mate, dayjs, node:test.

## Global Constraints

- Node.js ≥22.5; no new npm dependencies (dayjs already present).
- Money: Earned/Pending are derived → round to cents with `round2(n)=Math.round((Number(n)||0)*100)/100`. Settlement `amount` stored exactly as entered (never rounded), like payments.
- Earned per month = `SUM(payments on the agent's cases where substr(payment_date,1,7)=month) × agent.commission_rate/100`. Reuse `helpers.commission(collected, rate)`.
- `period` and month filter use `'YYYY-MM'`; default month = current Malaysia time: `dayjs.utc().add(8,'hour').format('YYYY-MM')`.
- Access: `GET /commissions` allowed for admin/manager/finance/auditor and agent; NOT client. `POST /commissions/settle` and `POST /commissions/:id/void` are admin/manager/finance only.
- Agent scope: an `agent` user sees only their own agent row (`agents.id = user.agent_id`); an agent with null `agent_id` sees no rows (no error).
- Over-settlement is allowed (Pending may go negative); the only settle validation is `amount` is a finite number `> 0`.
- Tests isolate the DB via `process.env.CRM_DB_PATH` set BEFORE requiring `../src/db`.
- Route handlers that create/delete write an audit entry via `logAction`.

---

## File Structure

- **Create** `src/routes/commissions.js` — `commissionRows(user, month)`, `recordSettlement(body, req)`, `voidSettlement(id, req)`, and the 3 routes. Exports `{ router, commissionRows, recordSettlement, voidSettlement }`.
- **Create** `src/views/commissions/index.ejs` — the table + settle dialog + settlement history.
- **Create** `test/commissions.test.js` — DB-isolated tests for the logic + settle/void.
- **Modify** `src/db/schema.sql` — add `commission_settlements` table + index.
- **Modify** `src/app.js` — mount `app.use('/commissions', require('./routes/commissions').router)`.
- **Modify** `src/views/partials/sidebar.ejs` — nav link (admin/manager/finance/auditor/agent).
- **Modify** `src/db/seed.js` — 1–2 demo settlements.
- **Modify** `README.md` — note commission settlement.

---

### Task 1: Schema + `commissionRows` core + tests

**Files:**
- Modify: `src/db/schema.sql` (add table after the `audit_logs` CREATE, before the indexes)
- Create: `src/routes/commissions.js` (logic only this task; routes in Task 2)
- Test: `test/commissions.test.js`

**Interfaces:**
- Produces:
  - Table `commission_settlements(id, agent_id, period TEXT, amount REAL, note, settled_by, is_demo, created_at)`.
  - `commissionRows(user, month) -> Array<{ agent_id, name, rate, collected, earned, settled, pending }>` — one row per in-scope agent (agent role → only own; others → all), ordered by name. `earned = round2(collected*rate/100)`, `pending = round2(earned - settled)`.

- [ ] **Step 1: Write the failing test**

Create `test/commissions.test.js`:

```js
const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.CRM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-comm-')), 'crm.db');
const { init, run, get } = require('../src/db');
const { commissionRows } = require('../src/routes/commissions');

// Seed: 2 agents (rate 5% and 6%), each a case, agent A has 2 payments in
// 2026-07 (10000 total), agent B one payment in 2026-07 (5000).
before(() => {
  init();
  run("INSERT INTO agents (id,name,commission_rate,active) VALUES (1,'Agent A',5,1)");
  run("INSERT INTO agents (id,name,commission_rate,active) VALUES (2,'Agent B',6,1)");
  run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'C',0)");
  run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,status) VALUES (1,'K1',1,1,1,10000,0,0,'partial_paid')");
  run("INSERT INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,status) VALUES (2,'K2',1,1,2,5000,0,0,'partial_paid')");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,'R1','2026-07-03',6000)");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,'R2','2026-07-20 10:00:00',4000)");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (2,'R3','2026-07-10',5000)");
  run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (1,'R4','2026-06-30',9999)"); // out of month
});

const admin = { role: 'admin' };
const agentA = { role: 'agent', agent_id: 1 };

test('earned = collected-in-month * rate, rounded', () => {
  const rows = commissionRows(admin, '2026-07');
  const a = rows.find(r => r.agent_id === 1);
  assert.strictEqual(a.collected, 10000);      // 6000+4000, June payment excluded
  assert.strictEqual(a.earned, 500);           // 10000 * 5%
  assert.strictEqual(a.settled, 0);
  assert.strictEqual(a.pending, 500);
});

test('all agents visible to admin, ordered by name', () => {
  const rows = commissionRows(admin, '2026-07');
  assert.deepStrictEqual(rows.map(r => r.name), ['Agent A', 'Agent B']);
  assert.strictEqual(rows.find(r => r.agent_id === 2).earned, 300); // 5000 * 6%
});

test('agent sees only own row', () => {
  const rows = commissionRows(agentA, '2026-07');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].agent_id, 1);
});

test('settled + pending reflect a recorded settlement', () => {
  run("INSERT INTO commission_settlements (agent_id,period,amount) VALUES (1,'2026-07',300)");
  const a = commissionRows(admin, '2026-07').find(r => r.agent_id === 1);
  assert.strictEqual(a.settled, 300);
  assert.strictEqual(a.pending, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --no-warnings --test test/commissions.test.js`
Expected: FAIL — `Cannot find module '../src/routes/commissions'`.

- [ ] **Step 3a: Add the table to `schema.sql`**

In `src/db/schema.sql`, after the `audit_logs` CREATE (around line 126) and before the `CREATE INDEX` lines, add:

```sql
CREATE TABLE IF NOT EXISTS commission_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  period TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT, settled_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commission_agent_period ON commission_settlements(agent_id, period);
```

(`init()` runs the whole schema via `db.exec`, so the `CREATE TABLE IF NOT EXISTS` is picked up on next boot — no ALTER migration needed for a brand-new table.)

- [ ] **Step 3b: Create `commissions.js` with the logic only**

Create `src/routes/commissions.js`:

```js
const express = require('express');
const { all } = require('../db');
const { commission } = require('../utils/helpers');
const router = express.Router();

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One row per in-scope agent for the given 'YYYY-MM' month.
// agent role → only own agent_id; everyone else → all agents.
function commissionRows(user, month) {
  const scoped = user && user.role === 'agent';
  const rows = all(
    `SELECT a.id AS agent_id, a.name, a.commission_rate AS rate,
       COALESCE((SELECT SUM(p.amount) FROM payments p JOIN cases c ON c.id = p.case_id
                 WHERE c.agent_id = a.id AND substr(p.payment_date,1,7) = ?), 0) AS collected,
       COALESCE((SELECT SUM(cs.amount) FROM commission_settlements cs
                 WHERE cs.agent_id = a.id AND cs.period = ?), 0) AS settled
     FROM agents a
     ${scoped ? 'WHERE a.id = ?' : ''}
     ORDER BY a.name`,
    scoped ? [month, month, user.agent_id || -1] : [month, month]);
  return rows.map((r) => {
    const earned = round2(commission(r.collected, r.rate));
    return { ...r, earned, pending: round2(earned - r.settled) };
  });
}

module.exports = { router, commissionRows, round2 };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx node --no-warnings --test test/commissions.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/routes/commissions.js test/commissions.test.js
git commit -m "feat: commission_settlements table + commissionRows(user,month) core"
```

---

### Task 2: Settle/void logic, routes, view, mount, nav

**Files:**
- Modify: `src/routes/commissions.js` (add helpers + routes)
- Create: `src/views/commissions/index.ejs`
- Modify: `src/app.js` (mount)
- Modify: `src/views/partials/sidebar.ejs` (nav link)
- Test: `test/commissions.test.js` (append settle/void tests)

**Interfaces:**
- Consumes: `commissionRows` (Task 1); `logAction` (`src/utils/audit.js`); `requireLogin`, `requireRole` (`src/middleware/auth.js`); `get`, `run` (`src/db`).
- Produces:
  - `recordSettlement(body, req) -> { ok, error?, id? }` — validates `amount` finite `>0`, inserts a row (`settled_by = req.session.user.full_name`), audit-logs. On bad amount returns `{ ok:false, error }` and writes nothing.
  - `voidSettlement(id, req) -> { ok }` — deletes the settlement, audit-logs.
  - Routes: `GET /` (render), `POST /settle`, `POST /:id/void`.

- [ ] **Step 1: Write the failing test**

Append to `test/commissions.test.js`:

```js
const { recordSettlement, voidSettlement } = require('../src/routes/commissions');
const fakeReq = (body) => ({ body, session: { user: { full_name: 'Boss', role: 'manager' } }, ip: '::1' });

test('recordSettlement inserts and rejects bad amounts', () => {
  const bad = recordSettlement({ agent_id: 2, period: '2026-07', amount: '0' }, fakeReq({}));
  assert.strictEqual(bad.ok, false);
  const bad2 = recordSettlement({ agent_id: 2, period: '2026-07', amount: 'abc' }, fakeReq({}));
  assert.strictEqual(bad2.ok, false);
  const ok = recordSettlement({ agent_id: 2, period: '2026-07', amount: '180', note: 'partial' }, fakeReq({}));
  assert.strictEqual(ok.ok, true);
  const b = commissionRows({ role: 'admin' }, '2026-07').find(r => r.agent_id === 2);
  assert.strictEqual(b.settled, 180);
  assert.strictEqual(b.pending, 120); // earned 300 - 180
});

test('over-settlement allowed (pending goes negative)', () => {
  recordSettlement({ agent_id: 2, period: '2026-07', amount: '500' }, fakeReq({}));
  const b = commissionRows({ role: 'admin' }, '2026-07').find(r => r.agent_id === 2);
  assert.strictEqual(b.settled, 680);   // 180 + 500
  assert.strictEqual(b.pending, -380);  // 300 - 680
});

test('voidSettlement removes a payout', () => {
  const row = get("SELECT id FROM commission_settlements WHERE agent_id=2 AND amount=500");
  const r = voidSettlement(row.id, fakeReq({}));
  assert.strictEqual(r.ok, true);
  const b = commissionRows({ role: 'admin' }, '2026-07').find(r => r.agent_id === 2);
  assert.strictEqual(b.settled, 180);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --no-warnings --test test/commissions.test.js`
Expected: FAIL — `recordSettlement is not a function`.

- [ ] **Step 3a: Add helpers + routes to `commissions.js`**

In `src/routes/commissions.js`, add these requires at the top (after the existing ones):

```js
const { get, run } = require('../db');
const { logAction } = require('../utils/audit');
const { requireLogin, requireRole } = require('../middleware/auth');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
```

Add before `module.exports`:

```js
function currentMonth() { return dayjs.utc().add(8, 'hour').format('YYYY-MM'); }

function recordSettlement(body, req) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };
  const agent = get('SELECT id FROM agents WHERE id=?', [body.agent_id]);
  if (!agent) return { ok: false, error: 'Agent not found' };
  const period = body.period || currentMonth();
  const r = run('INSERT INTO commission_settlements (agent_id,period,amount,note,settled_by) VALUES (?,?,?,?,?)',
    [agent.id, period, amount, body.note || null, req.session.user.full_name]);
  logAction(req, 'commission_settle', 'agent', agent.id, `Settled RM ${amount} for ${period}`);
  return { ok: true, id: r.lastInsertRowid };
}

function voidSettlement(id, req) {
  const row = get('SELECT * FROM commission_settlements WHERE id=?', [id]);
  if (!row) return { ok: false, error: 'Not found' };
  run('DELETE FROM commission_settlements WHERE id=?', [id]);
  logAction(req, 'commission_void', 'agent', row.agent_id, `Voided settlement ${id} (RM ${row.amount})`);
  return { ok: true };
}

const canView = requireRole('admin', 'manager', 'finance', 'auditor', 'agent'); // excludes client
const canSettle = requireRole('admin', 'manager', 'finance');

router.get('/', requireLogin, canView, (req, res) => {
  const month = req.query.month || currentMonth();
  const rows = commissionRows(req.session.user, month);
  const scoped = req.session.user.role === 'agent';
  const history = all(
    `SELECT cs.*, a.name AS agent_name FROM commission_settlements cs JOIN agents a ON a.id=cs.agent_id
     WHERE cs.period = ? ${scoped ? 'AND cs.agent_id = ?' : ''} ORDER BY cs.created_at DESC`,
    scoped ? [month, req.session.user.agent_id || -1] : [month]);
  res.render('commissions/index', {
    title: 'Commissions', rows, history, month,
    canSettle: ['admin', 'manager', 'finance'].includes(req.session.user.role),
  });
});

router.post('/settle', requireLogin, canSettle, (req, res) => {
  const r = recordSettlement(req.body, req);
  const month = req.body.period || currentMonth();
  if (!r.ok) return res.redirect(`/commissions?month=${month}&err=${encodeURIComponent(r.error)}`);
  res.redirect(`/commissions?month=${month}&ok=Settlement+recorded`);
});

router.post('/:id/void', requireLogin, canSettle, (req, res) => {
  const row = get('SELECT period FROM commission_settlements WHERE id=?', [req.params.id]);
  voidSettlement(req.params.id, req);
  res.redirect(`/commissions?month=${row ? row.period : currentMonth()}&ok=Settlement+voided`);
});
```

Update the export line to:

```js
module.exports = { router, commissionRows, round2, recordSettlement, voidSettlement };
```

- [ ] **Step 3b: Create the view**

Create `src/views/commissions/index.ejs`:

```html
<% layout('layout') -%>
<div class="page-head"><h1>Commissions</h1></div>

<form class="card filters" method="get" action="/commissions">
  <label>Month <input type="month" name="month" value="<%= month %>"></label>
  <button class="btn btn-gold" type="submit">Apply</button>
</form>

<div class="card">
  <h2>Commission — <%= month %></h2>
  <% if (!rows.length) { %><%- include('../partials/empty', { msg: 'No agents in scope.' }) %><% } else { %>
  <table class="data"><thead><tr><th>Agent</th><th class="num">Collected</th><th class="num">Rate %</th><th class="num">Earned</th><th class="num">Settled</th><th class="num">Pending</th><% if (canSettle) { %><th>Action</th><% } %></tr></thead>
  <tbody><% rows.forEach(r => { %><tr>
    <td><%= r.name %></td>
    <td class="num"><%= h.money(r.collected) %></td>
    <td class="num"><%= r.rate %></td>
    <td class="num"><%= h.money(r.earned) %></td>
    <td class="num"><%= h.money(r.settled) %></td>
    <td class="num <%= r.pending < 0 ? 'is-red' : '' %>"><%= h.money(r.pending) %></td>
    <% if (canSettle) { %><td><button type="button" class="btn btn-sm" onclick="openSettle(<%= r.agent_id %>, '<%= r.name %>', <%= r.pending %>)">Settle</button></td><% } %>
  </tr><% }) %></tbody>
  </table>
  <% } %>
</div>

<div class="card">
  <h2>Settlement history — <%= month %></h2>
  <% if (!history.length) { %><%- include('../partials/empty', { msg: 'No settlements this month.' }) %><% } else { %>
  <table class="data"><thead><tr><th>Agent</th><th class="num">Amount</th><th>Note</th><th>When</th><th>By</th><% if (canSettle) { %><th></th><% } %></tr></thead>
  <tbody><% history.forEach(s => { %><tr>
    <td><%= s.agent_name %></td><td class="num"><%= h.money(s.amount) %></td>
    <td><%= s.note || '' %></td><td><%= h.dateTimeFmt(s.created_at) %></td><td><%= s.settled_by || '' %></td>
    <% if (canSettle) { %><td><form method="post" action="/commissions/<%= s.id %>/void" style="margin:0;" onsubmit="return confirm('Void this settlement?')"><button class="btn btn-sm" type="submit">Void</button></form></td><% } %>
  </tr><% }) %></tbody>
  </table>
  <% } %>
</div>

<% if (canSettle) { %>
<dialog id="dlg-settle" class="modal"><form class="form" method="post" action="/commissions/settle">
  <h3>Record Settlement</h3>
  <input type="hidden" name="agent_id" id="st-agent">
  <input type="hidden" name="period" value="<%= month %>">
  <p id="st-who" class="muted"></p>
  <label>Amount (RM) <input type="number" step="0.01" min="0.01" name="amount" id="st-amount" required></label>
  <label>Note <input name="note"></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Record</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<script>
  function openSettle(agentId, name, pending){
    document.getElementById('st-agent').value = agentId;
    document.getElementById('st-who').textContent = name + ' · ' + '<%= month %>';
    var amt = document.getElementById('st-amount');
    amt.value = pending > 0 ? pending.toFixed(2) : '';
    document.getElementById('dlg-settle').showModal();
  }
  document.querySelectorAll('dialog.modal').forEach(function(d){
    d.addEventListener('click', function(e){ if (e.target === d) d.close(); });
  });
</script>
<% } %>
```

- [ ] **Step 3c: Mount the route in `app.js`**

In `src/app.js`, after the `/reports` mount line (line 55), add:

```js
app.use('/commissions', require('./routes/commissions').router);
```

- [ ] **Step 3d: Add the sidebar link**

In `src/views/partials/sidebar.ejs`, after the Reports link (line 12), add:

```html
    <% if (can(['admin','manager','finance','auditor','agent'])) { %><a href="/commissions" class="<%= path.startsWith('/commissions')?'active':'' %>"><%- h.icon('reports') %> Commissions</a><% } %>
```

- [ ] **Step 4: Run tests + boot smoke**

Run: `npx node --no-warnings --test test/commissions.test.js`
Expected: PASS — settle/void tests green.

Then boot smoke:
```
CRM_DB_PATH=/tmp/comm-smoke.db node --no-warnings src/db/seed.js
CRM_DB_PATH=/tmp/comm-smoke.db PORT=3998 SESSION_SECRET=smoke node --no-warnings src/app.js &
```
Log in as admin/admin123, GET `/commissions`, confirm the response contains `Commission —`, an agent row, and a `Settle` button, with no EJS/stack-trace error. Log in as agent1/agent123, GET `/commissions`, confirm exactly one agent row (their own) and NO `Settle` button. Kill the server.

- [ ] **Step 5: Commit**

```bash
git add src/routes/commissions.js src/views/commissions/index.ejs src/app.js src/views/partials/sidebar.ejs test/commissions.test.js
git commit -m "feat: commissions page — settle/void routes, view, nav, agent scope"
```

---

### Task 3: Demo seed + docs + full regression

**Files:**
- Modify: `src/db/seed.js` (add demo settlements in `insertDemoRows`)
- Modify: `README.md` (mention commission settlement)

- [ ] **Step 1: Add demo settlements to the seed**

In `src/db/seed.js`, at the end of `insertDemoRows()` (after the `taskSeed.forEach(...)` block, before the closing `}` at line 102), add:

```js
  const period = dayjs().format('YYYY-MM');
  run('INSERT INTO commission_settlements (agent_id,period,amount,note,settled_by,is_demo) VALUES (?,?,?,?,?,1)', [1, period, 300, 'Partial payout', 'Collection Manager']);
  run('INSERT INTO commission_settlements (agent_id,period,amount,note,settled_by,is_demo) VALUES (?,?,?,?,?,1)', [3, period, 150, 'Advance', 'Collection Manager']);
```

Also add `commission_settlements` to the `deleteDemo()` child-delete loop so "delete demo" cleans them: in `deleteDemo()`, change the first loop array from
`['timeline_events', 'call_logs', 'tasks', 'ptps', 'payments']` to
`['timeline_events', 'call_logs', 'tasks', 'ptps', 'payments', 'commission_settlements']`.

And add `commission_settlements` to `clearAllTables()`'s table list (after `'call_logs'`): change
`['audit_logs','call_logs','tasks',...]` to include `'commission_settlements'` right after `'call_logs'`.

- [ ] **Step 2: Verify seed + full suite**

Run:
```
npm run reset
npm test
```
Expected: seed completes without error; all tests pass (existing 70 + commission tests), 0 fail.

- [ ] **Step 3: README note**

In `README.md`, under the modules sentence or the reports description, add a short line noting commission settlement exists. Minimal edit — one clause, e.g. in the intro paragraph after "reports" add "commission settlement (earned/settled/pending per agent)".

- [ ] **Step 4: Commit**

```bash
git add src/db/seed.js README.md
git commit -m "feat: seed demo commission settlements + README note"
```

---

## Self-Review Notes

- **Spec coverage:** table (T1), commissionRows scope + earned/settled/pending (T1), routes GET/settle/void + access rules (T2), agent-only-own-row (T1 test + T2 route), over-settlement allowed / amount>0 (T2 tests), view + nav (T2), demo seed (T3), tests (T1/T2), YAGNI exclusions honored. All spec sections mapped.
- **Naming consistency:** `commissionRows(user, month)`, `recordSettlement(body, req)`, `voidSettlement(id, req)` used identically across routes, tests, exports. Row shape `{agent_id,name,rate,collected,earned,settled,pending}` consistent between T1 producer and T2 view/tests.
- **Reuse:** `helpers.commission`, `helpers.money/dateTimeFmt`, `logAction`, `requireRole`, existing modal/dialog pattern from cases show. No new deps.
