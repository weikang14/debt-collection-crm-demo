# C-Group: PTP Fulfill Payment + Case Detail Modals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fulfilling a PTP records a payment (so outstanding drops), and the case-detail action forms move into native `<dialog>` modals triggered by buttons inside the case facts card.

**Architecture:** Task 1 makes `POST /ptps/:id/fulfill` record a payment via the existing `applyPayment`, extracted into a testable `recordFulfillment`. Task 2 rewrites `cases/show.ejs` so the 5 action forms live in `<dialog>` modals opened from buttons in the `.kv` card; read-only lists stay. No schema change, no new deps.

**Tech Stack:** Node.js, `node:sqlite`, Express, EJS, native HTML `<dialog>`, `node:test`.

## Global Constraints

- Node ≥ 22.5; run with `node --no-warnings`. Zero new dependencies. Native `<dialog>` only — no JS framework.
- Spec: `docs/superpowers/specs/2026-07-05-case-detail-C-design.md`.
- Reuse `applyPayment(caseId, {payment_date, amount, method, reference, bank, remark}, req)` from `src/services/payments.js` (records payment, recomputes outstanding = max(0, principal+interest-SUM(payments)), updates status via `statusAfterPayment` which never overwrites terminal statuses, writes timeline, audits). Do NOT modify it.
- PTP scope: `POST /ptps/:id/fulfill` and `/break` re-check the parent case via `caseWhere` (403 if out of scope). Keep that.
- Fulfill must be idempotent-safe: a non-`pending` PTP must NOT record another payment (guard → redirect `?err=`).
- Case-detail action routes are unchanged: `POST /cases/:id/payments|ptps|calls|notes|status` and `POST /ptps/:id/fulfill|break`. Only the VIEW moves the forms into dialogs.
- `readOnly` (auditor/client) sees no action buttons and no dialogs. Role gating per action stays exactly as today: payment = admin/manager/finance/agent; ptp/call/note/status = admin/manager/agent.
- Tests use isolated DB via `process.env.CRM_DB_PATH` set at the top of the test file before requiring `../src/db`.
- MYT "today" default (no dep): `new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10)`.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/routes/ptps.js` — add `recordFulfillment(ptpId, body, req)`; rewrite `POST /:id/fulfill` to use it; export the helper; keep `/break`.
- `test/ptp_fulfill.test.js` — NEW, integration test that fulfilling a pending PTP records a payment and lowers outstanding, and a second fulfill is a no-op.
- `src/views/cases/show.ejs` — rewrite: action buttons in the `.kv` card open `<dialog>` modals holding the (moved) forms; read-only lists kept; PTP Fulfill opens a prefilled dialog.
- `public/css/style.css` — `dialog.modal` + `.kv-actions` styles.

---

### Task 1: PTP fulfill records a payment

**Files:**
- Modify: `src/routes/ptps.js`
- Create: `test/ptp_fulfill.test.js`

**Interfaces:**
- Produces: `recordFulfillment(ptpId, body, req)` → `{ ok: true, caseId }` on success, or `{ ok: false, error }` if the PTP is missing or not pending. Marks the PTP fulfilled and records a payment (amount = `Number(body.amount) || ptp.amount`) via `applyPayment`. Exported off the router (`module.exports.recordFulfillment`).

- [ ] **Step 1: Write the failing test `test/ptp_fulfill.test.js`**

```js
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-ptpf-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
const { recordFulfillment } = require('../src/routes/ptps');

const fakeReq = { session: { user: { full_name: 'Tester', username: 'tester' } }, ip: '127.0.0.1' };

test('fulfilling a pending PTP records a payment and lowers outstanding', () => {
  seed.seedDemo();
  const ptp = db.get("SELECT * FROM ptps WHERE status='pending' LIMIT 1");
  const before = db.get('SELECT outstanding_amount FROM cases WHERE id=?', [ptp.case_id]).outstanding_amount;
  const paysBefore = db.get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [ptp.case_id]).c;

  const r = recordFulfillment(ptp.id, {}, fakeReq);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [ptp.id]).status, 'fulfilled');
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [ptp.case_id]).c, paysBefore + 1);
  const after = db.get('SELECT outstanding_amount FROM cases WHERE id=?', [ptp.case_id]).outstanding_amount;
  assert.ok(after < before, 'outstanding should drop');
});

test('fulfilling an already-fulfilled PTP does not record another payment', () => {
  seed.seedDemo();
  const ptp = db.get("SELECT * FROM ptps WHERE status='pending' LIMIT 1");
  recordFulfillment(ptp.id, {}, fakeReq);
  const paysAfterFirst = db.get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [ptp.case_id]).c;
  const r2 = recordFulfillment(ptp.id, {}, fakeReq);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [ptp.case_id]).c, paysAfterFirst);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `node --no-warnings --test test/ptp_fulfill.test.js`
Expected: FAIL — `recordFulfillment` is not a function.

- [ ] **Step 3: Rewrite `src/routes/ptps.js`**

Replace the entire file with:

```js
const express = require('express');
const { get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const { applyPayment } = require('../services/payments');
const router = express.Router();

// Fulfilling a PTP means the promised money was actually paid, so we record a
// payment (which lowers outstanding) in addition to marking the PTP fulfilled.
// Guarded: a non-pending PTP won't record another payment.
function recordFulfillment(ptpId, body, req) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [ptpId]);
  if (!ptp) return { ok: false, error: 'PTP not found' };
  if (ptp.status !== 'pending') return { ok: false, error: 'PTP already resolved' };
  run("UPDATE ptps SET status='fulfilled' WHERE id=?", [ptp.id]);
  const amount = Number(body.amount) || ptp.amount;
  const payment_date = body.payment_date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const method = body.method || 'bank_transfer';
  applyPayment(ptp.case_id, { payment_date, amount, method, remark: `PTP fulfilled` }, req);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
    [ptp.case_id, 'ptp_fulfilled', `PTP fulfilled (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_fulfilled', 'case', ptp.case_id, `PTP ${ptp.id} fulfilled`);
  return { ok: true, caseId: ptp.case_id };
}

// scope check shared by fulfill + break
function loadScopedCaseId(req, res) {
  const ptp = get('SELECT case_id FROM ptps WHERE id=?', [req.params.id]);
  if (!ptp) { res.status(404).render('error', { message: 'PTP not found' }); return null; }
  const w = caseWhere(req.session.user);
  const c = get(`SELECT id FROM cases WHERE id=? AND ${w.clause}`, [ptp.case_id, ...w.params]);
  if (!c) { res.status(403).render('error', { message: 'Forbidden' }); return null; }
  return ptp.case_id;
}

router.post('/:id/fulfill', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const caseId = loadScopedCaseId(req, res); if (caseId === null) return;
  const r = recordFulfillment(req.params.id, req.body, req);
  if (!r.ok) return res.redirect(`/cases/${caseId}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${caseId}?ok=PTP+fulfilled+and+payment+recorded`);
});

router.post('/:id/break', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const caseId = loadScopedCaseId(req, res); if (caseId === null) return;
  const ptp = get('SELECT * FROM ptps WHERE id=?', [req.params.id]);
  run("UPDATE ptps SET status='broken' WHERE id=?", [ptp.id]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
    [caseId, 'ptp_broken', `PTP broken (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_broken', 'case', caseId, `PTP ${ptp.id} broken`);
  res.redirect(`/cases/${caseId}?ok=PTP+broken`);
});

module.exports = router;
module.exports.recordFulfillment = recordFulfillment;
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `node --no-warnings --test test/ptp_fulfill.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all tests pass. Report the count.

- [ ] **Step 6: Live smoke (fulfill lowers outstanding)**

```bash
npm run seed
PORT=4201 node --no-warnings src/app.js & sleep 2
B=http://localhost:4201
curl -s -c /tmp/a -b /tmp/a -o /dev/null -d "username=manager&password=manager123" $B/login
# a pending PTP + its case
node -e "const d=require('./src/db');d.init();const p=d.get(\"SELECT id,case_id FROM ptps WHERE status='pending' LIMIT 1\");const c=d.get('SELECT outstanding_amount FROM cases WHERE id=?',[p.case_id]);console.log('ptp',p.id,'case',p.case_id,'outstanding_before',c.outstanding_amount)"
PID=$(node -e "const d=require('./src/db');d.init();console.log(d.get(\"SELECT id FROM ptps WHERE status='pending' LIMIT 1\").id)")
curl -s -b /tmp/a -o /dev/null -w "fulfill status: %{http_code}\n" -d "" "$B/ptps/$PID/fulfill"
node -e "const d=require('./src/db');d.init();const p=d.get('SELECT case_id FROM ptps WHERE id=$PID');const c=d.get('SELECT outstanding_amount FROM cases WHERE id=?',[p.case_id]);console.log('outstanding_after',c.outstanding_amount,'payments',d.get('SELECT COUNT(*) c FROM payments WHERE case_id=?',[p.case_id]).c)"
```
Expected: `fulfill status: 302`; outstanding_after < outstanding_before; payments count went up by 1. Kill server, `npm run seed`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/ptps.js test/ptp_fulfill.test.js
git commit -m "$(printf 'fix: fulfilling a PTP records a payment so outstanding drops\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Case detail — action buttons in the facts card + dialog modals

**Files:**
- Modify: `src/views/cases/show.ejs` (full rewrite)
- Modify: `public/css/style.css`

**Interfaces:** none new. Uses the existing render locals (`c, timeline, payments, ptps, tasks, calls, statuses, terminal, readOnly`, `currentUser`, `h`). Posts to existing routes. Task 1's `/ptps/:id/fulfill` accepts optional `amount`/`payment_date`/`method` (the fulfill dialog sends them).

- [ ] **Step 1: Replace `src/views/cases/show.ejs` entirely**

```ejs
<% layout('layout'); -%>
<div class="page-head">
  <h1><%= c.case_no %> <%- include('../partials/statusBadge', { status: c.status }) %></h1>
  <% if (['admin','manager'].includes(currentUser.role)) { %><a class="btn" href="/cases/<%= c.id %>/edit">Edit Case</a><% } %>
</div>

<div class="detail-grid">
  <div>
    <div class="card kv">
      <div><span>Debtor</span><a href="/debtors/<%= c.debtor_id %>"><%= c.debtor_name %></a></div>
      <div><span>Debtor Phone</span><span class="mono"><%= c.debtor_phone||'—' %></span></div>
      <div><span>IC/Passport</span><span class="mono"><%= c.ic_passport||'—' %></span></div>
      <div><span>Agent</span><%= c.agent_name||'—' %></div>
      <div><span>Principal</span><span class="num"><%= h.money(c.principal_amount) %></span></div>
      <div><span>Interest</span><span class="num"><%= h.money(c.interest_amount) %></span></div>
      <div><span>Outstanding</span><span class="num"><%= h.money(c.outstanding_amount) %></span></div>
      <div><span>Priority</span><span class="badge <%= c.priority==='urgent'||c.priority==='high'?'is-red':c.priority==='low'?'is-neutral':'is-gold' %>"><%= c.priority %></span></div>
      <div><span>Opened</span><%= h.dateFmt(c.opened_at) %></div>
      <div><span>Remark</span><%= c.remark||'—' %></div>
      <% if (!readOnly) { %>
      <div class="kv-actions">
        <% if (['admin','manager','finance','agent'].includes(currentUser.role)) { %><button type="button" class="btn btn-gold" onclick="dlg('dlg-payment')">Record Payment</button><% } %>
        <% if (['admin','manager','agent'].includes(currentUser.role)) { %>
        <button type="button" class="btn" onclick="dlg('dlg-ptp')">Add PTP</button>
        <button type="button" class="btn" onclick="dlg('dlg-call')">Log Call</button>
        <button type="button" class="btn" onclick="dlg('dlg-note')">Add Note</button>
        <button type="button" class="btn" onclick="dlg('dlg-status')">Change Status</button>
        <% } %>
      </div>
      <% } %>
    </div>

    <h2>Timeline</h2>
    <% if (!timeline.length) { %><%- include('../partials/empty', { msg: 'No activity yet.' }) %><% } else { %>
    <% const evClass = { payment:'is-green', ptp_fulfilled:'is-green', ptp_broken:'is-red', ptp_created:'is-gold', status_change:'is-blue', legal:'is-red', call:'is-blue' }; %>
    <ul class="timeline">
    <% timeline.forEach(ev => { %><li><span class="badge <%= evClass[ev.event_type]||'is-neutral' %>"><%= ev.event_type %></span> <%= ev.content %>
    <span class="meta"><%= ev.created_by||'system' %> · <%= h.dateTimeFmt(ev.created_at) %></span></li><% }) %>
    </ul>
    <% } %>
  </div>

  <div>
    <h2>Payments</h2>
    <% if (!payments.length) { %><%- include('../partials/empty', { msg: 'No payments recorded.' }) %><% } else { %>
    <table class="data"><thead><tr><th>Receipt No</th><th>Date</th><th class="num">Amount</th><th>Method</th></tr></thead>
    <tbody><% payments.forEach(p => { %><tr><td class="mono"><%= p.receipt_no %></td><td><%= h.dateFmt(p.payment_date) %></td>
    <td class="num"><%= h.money(p.amount) %></td><td><%= p.method %></td></tr><% }) %></tbody></table>
    <% } %>

    <h2>Promise to Pay</h2>
    <% if (!ptps.length) { %><%- include('../partials/empty', { msg: 'No PTPs recorded.' }) %><% } else { %>
    <table class="data"><thead><tr><th class="num">Amount</th><th>Due Date</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody><% ptps.forEach(p => { %><tr><td class="num"><%= h.money(p.amount) %></td><td><%= h.dateFmt(p.due_date) %></td>
    <td><span class="badge <%= p.status==='fulfilled'?'is-green':p.status==='broken'?'is-red':'is-gold' %>"><%= p.status %></span></td>
    <td><% if (p.status==='pending' && !readOnly && ['admin','manager','agent'].includes(currentUser.role)) { %>
    <div style="display:flex; gap:0.5rem;">
      <button type="button" class="btn btn-sm" onclick="openFulfill(<%= p.id %>, <%= p.amount %>)">Fulfill</button>
      <form method="post" action="/ptps/<%= p.id %>/break" style="margin:0;"><button class="btn btn-sm" type="submit">Break</button></form>
    </div>
    <% } else { %>—<% } %></td></tr><% }) %></tbody></table>
    <% } %>

    <h2>Calls</h2>
    <% if (!calls.length) { %><%- include('../partials/empty', { msg: 'No calls logged.' }) %><% } else { %>
    <table class="data"><thead><tr><th>Time</th><th>Duration</th><th>Result</th><th>Notes</th></tr></thead>
    <tbody><% calls.forEach(call => { %><tr><td><%= h.dateTimeFmt(call.call_time) %></td><td><%= call.duration_seconds %>s</td>
    <td><span class="badge <%= call.result==='answered'?'is-green':'is-neutral' %>"><%= call.result %></span></td><td><%= call.notes||'' %></td></tr><% }) %></tbody></table>
    <% } %>

    <h2>Tasks</h2>
    <% if (!tasks.length) { %><%- include('../partials/empty', { msg: 'No tasks for this case.' }) %><% } else { %>
    <table class="data"><thead><tr><th>Title</th><th>Due Date</th><th>Status</th></tr></thead>
    <tbody><% tasks.forEach(t => { %><tr><td><%= t.title %></td><td><%= h.dateFmt(t.due_date) %></td>
    <td><span class="badge <%= t.status==='done'?'is-green':'is-gold' %>"><%= t.status %></span></td></tr><% }) %></tbody></table>
    <% } %>
  </div>
</div>

<% if (!readOnly) { %>
<% if (['admin','manager','finance','agent'].includes(currentUser.role)) { %>
<dialog id="dlg-payment" class="modal"><form class="form" method="post" action="/cases/<%= c.id %>/payments">
  <h3>Record Payment</h3>
  <label>Date <input type="date" name="payment_date" required></label>
  <label>Amount (RM) <input type="number" step="0.01" name="amount" required></label>
  <label>Method <select name="method"><option>bank_transfer</option><option>cash</option><option>cheque</option><option>online</option></select></label>
  <label>Reference <input name="reference"></label>
  <label>Bank <input name="bank"></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Add Payment</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<% } %>
<% if (['admin','manager','agent'].includes(currentUser.role)) { %>
<dialog id="dlg-ptp" class="modal"><form class="form" method="post" action="/cases/<%= c.id %>/ptps">
  <h3>New PTP</h3>
  <label>Amount (RM) <input type="number" step="0.01" name="amount" required></label>
  <label>Due Date <input type="date" name="due_date" required></label>
  <label>Remark <input name="remark"></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Add PTP</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<dialog id="dlg-call" class="modal"><form class="form" method="post" action="/cases/<%= c.id %>/calls">
  <h3>Log Call</h3>
  <label>Result <select name="result"><option>answered</option><option>no_answer</option><option>busy</option><option>wrong_number</option><option>refused</option></select></label>
  <label>Duration (s) <input type="number" name="duration_seconds" min="0" value="0"></label>
  <label>Notes <input name="notes"></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Log Call</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<dialog id="dlg-note" class="modal"><form class="form" method="post" action="/cases/<%= c.id %>/notes">
  <h3>Add Note</h3>
  <label>Note <textarea name="content" required></textarea></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Add Note</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<dialog id="dlg-status" class="modal"><form class="form" method="post" action="/cases/<%= c.id %>/status">
  <h3>Change Status</h3>
  <label>Status <select name="status">
    <% statuses.forEach(s => { %><option value="<%= s %>" <%= c.status===s?'selected':'' %>><%= h.caseStatusLabel(s) %></option><% }) %>
  </select></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Update Status</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<dialog id="dlg-ptp-fulfill" class="modal"><form class="form" id="fulfill-form" method="post" action="">
  <h3>Fulfill PTP — Record Payment</h3>
  <label>Amount (RM) <input type="number" step="0.01" name="amount" id="fulfill-amount" required></label>
  <label>Date <input type="date" name="payment_date" required></label>
  <label>Method <select name="method"><option>bank_transfer</option><option>cash</option><option>cheque</option><option>online</option></select></label>
  <div class="form-actions"><button class="btn btn-gold" type="submit">Confirm &amp; Record</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
</form></dialog>
<% } %>
<script>
  function dlg(id){ document.getElementById(id).showModal(); }
  function openFulfill(id, amount){
    var f = document.getElementById('fulfill-form');
    f.action = '/ptps/' + id + '/fulfill';
    document.getElementById('fulfill-amount').value = amount;
    dlg('dlg-ptp-fulfill');
  }
  document.querySelectorAll('dialog.modal').forEach(function(d){
    d.addEventListener('click', function(e){ if (e.target === d) d.close(); });
  });
  (function(){
    var today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
    document.querySelectorAll('dialog.modal input[type=date]').forEach(function(i){ if(!i.value) i.value = today; });
  })();
</script>
<% } %>
```

- [ ] **Step 2: Add modal + kv-actions CSS to `public/css/style.css`**

Append:

```css
/* Action buttons inside the case facts card */
.kv-actions {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin-top: 14px; padding-top: 14px;
  border-top: 1px solid var(--paper-line);
}

/* Native dialog modals for case actions */
dialog.modal {
  border: none; border-radius: var(--radius); padding: 0;
  box-shadow: 0 12px 32px rgba(0,0,0,0.35);
  max-width: 460px; width: 92vw;
}
dialog.modal::backdrop { background: rgba(16,21,31,0.45); }
dialog.modal .form { margin: 0; padding: 20px 22px; }
dialog.modal h3 { margin-bottom: 12px; }
```

- [ ] **Step 3: Compile check**

Run: `node -e "const ejs=require('ejs'),fs=require('fs'); ejs.compile(fs.readFileSync('src/views/cases/show.ejs','utf8'),{filename:'s'}); console.log('OK')"` then `npm test`
Expected: `OK`; all tests pass (view change doesn't affect the suite).

- [ ] **Step 4: Live smoke (buttons, dialogs present, actions still work, readOnly hidden)**

```bash
npm run seed
PORT=4202 node --no-warnings src/app.js & sleep 2
B=http://localhost:4202
curl -s -c /tmp/m -b /tmp/m -o /dev/null -d "username=manager&password=manager123" $B/login
CID=$(node -e "const d=require('./src/db');d.init();console.log(d.get(\"SELECT id FROM cases WHERE status='negotiation' LIMIT 1\").id)")
echo "action buttons present: $(curl -s -b /tmp/m "$B/cases/$CID" | grep -c "onclick=\"dlg('dlg-payment')\"")"
echo "dialogs present: $(curl -s -b /tmp/m "$B/cases/$CID" | grep -oE '<dialog id="dlg-[a-z-]+"' | wc -l)"
# a normal payment via the (unchanged) route still works
curl -s -b /tmp/m -o /dev/null -w "payment post: %{http_code}\n" -d "payment_date=2026-07-05&amount=50&method=cash" "$B/cases/$CID/payments"
# readOnly (auditor) sees no action buttons
curl -s -c /tmp/au -b /tmp/au -o /dev/null -d "username=auditor&password=auditor123" $B/login
echo "auditor action buttons (expect 0): $(curl -s -b /tmp/au "$B/cases/$CID" | grep -c 'kv-actions')"
```
Expected: action buttons present (1), 6 dialogs, `payment post: 302`, auditor sees 0 `kv-actions`. Kill server, `npm run seed`.

- [ ] **Step 5: Commit**

```bash
git add src/views/cases/show.ejs public/css/style.css
git commit -m "$(printf 'feat: case detail action buttons in facts card open dialog modals\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- C1 PTP fulfill records payment (amount prefilled/editable, date, method; outstanding drops; status updates via applyPayment; terminal not overwritten) → Task 1 (`recordFulfillment`). ✓
- C1 duplicate-fulfill guard (non-pending → no extra payment) → Task 1 test + guard. ✓
- C1 scope re-check on fulfill/break preserved → Task 1 `loadScopedCaseId`. ✓
- C2 action buttons inside the `.kv` facts card, role-gated, hidden for readOnly → Task 2 `.kv-actions`. ✓
- C2 native `<dialog>` modals holding the moved forms; Cancel/Esc/backdrop close → Task 2 dialogs + script. ✓
- C2 read-only lists kept (payments/ptps/calls/tasks/timeline) → Task 2. ✓
- C2 PTP row Fulfill opens a prefilled dialog posting to `/ptps/:id/fulfill` → Task 2 `openFulfill`. ✓
- Existing action routes unchanged; reuse applyPayment; no schema change; zero deps → both tasks. ✓

**Placeholder scan:** none — full code for the route, the test, and the entire new show.ejs + CSS.

**Type consistency:** `recordFulfillment(ptpId, body, req) → {ok, caseId|error}` matches the Task 1 test import (`require('../src/routes/ptps').recordFulfillment`) and the route call. The fulfill dialog posts `amount`/`payment_date`/`method`, which `recordFulfillment` reads (`body.amount` etc.). Dialog ids (`dlg-payment/ptp/call/note/status/ptp-fulfill`) match the `dlg(...)`/`openFulfill` calls. `applyPayment` param shape matches services/payments.js. Role gates match the current view exactly.
