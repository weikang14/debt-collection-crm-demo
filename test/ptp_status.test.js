process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-ptpstatus-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();
const { breakPtp } = require('../src/routes/ptps');

const req = { session: { user: { full_name: 'Tester', username: 'tester' } }, ip: '127.0.0.1' };

test('breaking the only pending PTP reverts case status ptp -> negotiation', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  db.run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  const p = db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 100, '2026-08-01', 'pending', 'Tester']);
  const r = breakPtp(p.lastInsertRowid, req);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [p.lastInsertRowid]).status, 'broken');
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'negotiation');
});

test('breaking one PTP while another is still pending keeps status ptp', () => {
  const c = db.get('SELECT id FROM cases WHERE id NOT IN (SELECT id FROM cases LIMIT 1) LIMIT 1');
  db.run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  const p1 = db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 100, '2026-08-01', 'pending', 'Tester']);
  db.run("INSERT INTO ptps (case_id,amount,due_date,status,created_by) VALUES (?,?,?,?,?)", [c.id, 200, '2026-09-01', 'pending', 'Tester']);
  breakPtp(p1.lastInsertRowid, req);
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'ptp');
});

const { applyPayment, recomputeOutstanding, statusAfterPayment } = require('../src/services/payments');

test('lowering principal below amount already paid flips status to fully_paid', () => {
  const c = db.get('SELECT id FROM cases ORDER BY id DESC LIMIT 1');
  db.run("UPDATE cases SET principal_amount=1000, interest_amount=0, outstanding_amount=1000, status='negotiation' WHERE id=?", [c.id]);
  applyPayment(c.id, { payment_date: '2026-07-07', amount: 600, method: 'cash' }, req); // -> partial_paid, outstanding 400
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'partial_paid');
  // simulate the edit route's post-update recompute+status logic (principal lowered to 500 < 600 paid):
  db.run("UPDATE cases SET principal_amount=500 WHERE id=?", [c.id]);
  const outstanding = recomputeOutstanding(c.id);
  const paidCount = db.get('SELECT COUNT(*) c FROM payments WHERE case_id=?', [c.id]).c;
  const cur = db.get('SELECT status FROM cases WHERE id=?', [c.id]).status;
  const next = statusAfterPayment(cur, outstanding, paidCount);
  assert.strictEqual(next, 'fully_paid');
});
