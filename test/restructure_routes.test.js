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
  assert.ok(recordFulfillment(ptp, { amount: 10, payment_date: '2026-01-11' }, req).ok);
});
