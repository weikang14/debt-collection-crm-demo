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
