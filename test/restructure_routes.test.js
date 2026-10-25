process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsroutes-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const { router } = require('../src/routes/cases');
const { recordFulfillment } = require('../src/routes/ptps');
const { recomputeOutstanding } = require('../src/services/payments');
const { createRestructure } = require('../src/services/restructure');

const req = { session: { user: { username: 'mgr', full_name: 'Manager', role: 'manager' } }, ip: '127.0.0.1' };

// Each route's stack is [requireLogin, requireRole(...), handler].
function roleGuard(path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods.post);
  assert.ok(layer, `route ${path} exists`);
  return layer.route.stack[1].handle;
}
function allowed(mw, role) {
  let passed = false;
  const res = { status() { return this; }, render() {}, redirect() {} };
  mw({ session: { user: { role } } }, res, () => { passed = true; });
  return passed;
}

test('only admin and manager can restructure or undo', () => {
  for (const p of ['/:id/restructures', '/:id/restructures/:rid/undo']) {
    const mw = roleGuard(p);
    const roles = ['admin', 'manager', 'finance', 'agent', 'auditor', 'client'].filter(r => allowed(mw, r));
    assert.deepStrictEqual(roles, ['admin', 'manager'], p);
  }
});

test('fulfilling a PTP with a payment dated before the restructure is refused', () => {
  db.run("INSERT INTO clients (id,company_name,commission_rate) VALUES (1,'X',0)");
  db.run("INSERT INTO debtors (id,name) VALUES (1,'D')");
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from,opened_at,maturity_date)
    VALUES (1,'RT1',1,1,3000,0,3000,'ptp','monthly',3,'2026-01-01','2026-01-01 00:00:00','2026-04-01')`);
  recomputeOutstanding(1);
  assert.ok(createRestructure(1, { effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'r' }, req).ok);
  const ptp = Number(db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (1,10,'2026-02-01','pending','t')").lastInsertRowid);
  const bad = recordFulfillment(ptp, { amount: 10, payment_date: '2026-01-10' }, req);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /restructure date/);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [ptp]).status, 'pending');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payments WHERE case_id=1').n, 0);
  // D-04: the effective date itself belongs to the old terms, so the first allowed date is the day after.
  assert.strictEqual(recordFulfillment(ptp, { amount: 10, payment_date: '2026-01-11' }, req).ok, false);
  assert.ok(recordFulfillment(ptp, { amount: 10, payment_date: '2026-01-12' }, req).ok);
});

// Run a cases-router route's final handler (role/scope checks are covered above
// and in scope_boundary) and return the redirect it issued.
function call(method, path, params, body = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `route ${path} exists`);
  let to = null;
  const res = { redirect: u => { to = u; }, status() { return this; }, render() {} };
  layer.route.stack[layer.route.stack.length - 1].handle({ params, body, session: { user: { ...req.session.user, role: 'admin' } }, ip: req.ip }, res);
  return to;
}

test('routes enforce the restructure locks on payments and loan terms', () => {
  db.run(`INSERT INTO cases (id,case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status,interest_mode,interest_rate,interest_from,opened_at,maturity_date,priority)
    VALUES (2,'RT2',1,1,3000,0,3000,'negotiation','monthly',3,'2026-01-01','2026-01-01 00:00:00','2026-04-01','low')`);
  const old = Number(db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (2,'RT2-OLD','2026-01-05',20)").lastInsertRowid);
  recomputeOutstanding(2);
  assert.ok(createRestructure(2, { effective_date: '2026-01-11', interest_mode: 'monthly', interest_rate: '1.5', tenure: '12', reason: 'r' }, req).ok);
  const count = () => db.get('SELECT COUNT(*) n FROM payments WHERE case_id=2').n;

  assert.match(call('post', '/:id/payments', { id: '2' }, { payment_date: '2026-01-10', amount: '5' }), /restructure%20date/);
  assert.strictEqual(count(), 1, 'early-dated payment not recorded');
  assert.match(call('post', '/:id/payments/:pid', { id: '2', pid: String(old) }, { amount: '1', payment_date: '2026-01-12' }), /restructured%20period/);
  assert.strictEqual(db.get('SELECT amount FROM payments WHERE id=?', [old]).amount, 20, 'old payment not edited');
  assert.match(call('post', '/:id/payments/:pid/void', { id: '2', pid: String(old) }), /restructured%20period/);
  assert.strictEqual(count(), 1, 'old payment not voided');

  assert.match(call('post', '/:id/payments', { id: '2' }, { payment_date: '2026-01-12', amount: '5', method: 'cash' }), /ok=Payment/);
  const fresh = db.get("SELECT id FROM payments WHERE case_id=2 AND payment_date='2026-01-12'").id;
  assert.match(call('post', '/:id/payments/:pid/void', { id: '2', pid: String(fresh) }), /ok=Payment\+voided/);

  assert.match(call('post', '/:id', { id: '2' }, { debtor_id: '1', principal_amount: '1', interest_mode: 'fixed', priority: 'urgent' }), /ok=Saved/);
  const c = db.get('SELECT principal_amount, interest_mode, priority FROM cases WHERE id=2');
  assert.deepStrictEqual({ ...c }, { principal_amount: 3000, interest_mode: 'monthly', priority: 'urgent' });
});

test('restructure timeline events cannot be edited or deleted through the note routes', () => {
  const ev = db.get("SELECT id, content FROM timeline_events WHERE case_id=2 AND content LIKE 'Restructure:%'");
  call('post', '/:id/notes/:noteId', { id: '2', noteId: String(ev.id) }, { content: 'tampered' });
  call('post', '/:id/notes/:noteId/delete', { id: '2', noteId: String(ev.id) });
  assert.strictEqual(db.get('SELECT content FROM timeline_events WHERE id=?', [ev.id]).content, ev.content);
});
