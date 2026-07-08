const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolated DB per run.
process.env.CRM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-inst-')), 'crm.db');
const { db, init, get, all, run } = require('../src/db');

before(() => { init(); });

test('ptps has plan grouping columns', () => {
  const cols = all('PRAGMA table_info(ptps)').map(c => c.name);
  assert.ok(cols.includes('plan_id'));
  assert.ok(cols.includes('installment_no'));
  assert.ok(cols.includes('plan_size'));
});

// --- helpers: seed a client/debtor/case directly (no HTTP) ---
function seedCase(principal, interest) {
  const cl = run("INSERT INTO clients (company_name, commission_rate) VALUES ('T', 0)").lastInsertRowid;
  const d = run("INSERT INTO debtors (name) VALUES ('D')").lastInsertRowid;
  const out = principal + interest;
  const r = run(`INSERT INTO cases (case_no, client_id, debtor_id, principal_amount, interest_amount, outstanding_amount, status)
    VALUES (?,?,?,?,?,?, 'negotiation')`, ['C-' + Date.now() + Math.random(), cl, d, principal, interest, out]);
  return r.lastInsertRowid;
}
const fakeReq = (body) => ({ body, session: { user: { full_name: 'Tester', role: 'admin' } }, params: {}, ip: '::1' });

test('generate plan: N pending rows share plan_id, sum = total, case -> ptp', () => {
  const cid = seedCase(10000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const res = createPtpPlan(cid, { total_amount: '10000', num_installments: '5', first_due_date: '2026-08-01' }, fakeReq({}));
  assert.strictEqual(res.ok, true);
  const rows = all("SELECT * FROM ptps WHERE case_id=? AND status='pending' ORDER BY installment_no", [cid]);
  assert.strictEqual(rows.length, 5);
  const planIds = new Set(rows.map(r => r.plan_id));
  assert.strictEqual(planIds.size, 1);
  assert.ok([...planIds][0]);
  assert.deepStrictEqual(rows.map(r => r.installment_no), [1, 2, 3, 4, 5]);
  assert.strictEqual(Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100), 1000000);
  assert.strictEqual(get('SELECT status FROM cases WHERE id=?', [cid]).status, 'ptp');
});

test('generate plan: total over outstanding is rejected, no rows inserted', () => {
  const cid = seedCase(1000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const res = createPtpPlan(cid, { total_amount: '5000', num_installments: '3', first_due_date: '2026-08-01' }, fakeReq({}));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(all('SELECT * FROM ptps WHERE case_id=?', [cid]).length, 0);
});

test('generate plan: bad installment count is rejected', () => {
  const cid = seedCase(1000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const res = createPtpPlan(cid, { total_amount: '900', num_installments: '1', first_due_date: '2026-08-01' }, fakeReq({}));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(all('SELECT * FROM ptps WHERE case_id=?', [cid]).length, 0);
});

test('cancel plan: all pending broken, case ptp -> negotiation when none paid', () => {
  const cid = seedCase(9000, 0);
  const { createPtpPlan, cancelPtpPlan } = require('../src/routes/cases');
  const gen = createPtpPlan(cid, { total_amount: '9000', num_installments: '3', first_due_date: '2026-08-01' }, fakeReq({}));
  const res = cancelPtpPlan(cid, gen.planId, fakeReq({}));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.broken, 3);
  assert.strictEqual(all("SELECT * FROM ptps WHERE case_id=? AND status='pending'", [cid]).length, 0);
  assert.strictEqual(get('SELECT status FROM cases WHERE id=?', [cid]).status, 'negotiation');
});

test('fulfilling one installment lowers outstanding, case stays ptp while siblings pending', () => {
  const cid = seedCase(6000, 0);
  const { createPtpPlan } = require('../src/routes/cases');
  const gen = createPtpPlan(cid, { total_amount: '6000', num_installments: '3', first_due_date: '2026-08-01' }, fakeReq({}));
  const first = get("SELECT id FROM ptps WHERE case_id=? ORDER BY installment_no LIMIT 1", [cid]);
  const { recordFulfillment } = require('../src/routes/ptps');
  const r = recordFulfillment(first.id, {}, fakeReq({}));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(get('SELECT status FROM cases WHERE id=?', [cid]).status, 'ptp');
  assert.strictEqual(Math.round(get('SELECT outstanding_amount o FROM cases WHERE id=?', [cid]).o * 100), 400000);
});
