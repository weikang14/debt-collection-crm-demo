process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-paycorrect-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();
const { applyPayment } = require('../src/services/payments');

const req = { session: { user: { username: 'tester', full_name: 'Tester' } }, ip: '127.0.0.1' };

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

const { resyncCaseStatus } = require('../src/services/payments');

test('void path: deleting a payment + resyncCaseStatus restores outstanding and status', () => {
  const c = db.get('SELECT id FROM cases ORDER BY id DESC LIMIT 1');
  db.run("UPDATE cases SET principal_amount=100, interest_amount=0, outstanding_amount=100, status='negotiation' WHERE id=?", [c.id]);
  applyPayment(c.id, { payment_date: '2026-07-06', amount: 100, method: 'cash' }, req); // -> fully_paid
  assert.strictEqual(db.get('SELECT status FROM cases WHERE id=?', [c.id]).status, 'fully_paid');
  const pay = db.get('SELECT id FROM payments WHERE case_id=? ORDER BY id DESC LIMIT 1', [c.id]);
  db.run('DELETE FROM payments WHERE id=?', [pay.id]); // simulate void
  resyncCaseStatus(c.id, 'Tester');
  const row = db.get('SELECT outstanding_amount, status FROM cases WHERE id=?', [c.id]);
  assert.strictEqual(row.outstanding_amount, 100);
  assert.strictEqual(row.status, 'negotiation'); // stale fully_paid reverted
});

const { nextReceiptNo } = require('../src/utils/numbering');

test('#8 receipt numbering does not reuse a deleted number', () => {
  const c = db.get('SELECT id FROM cases LIMIT 1');
  const r1 = nextReceiptNo();
  db.run("INSERT INTO payments (case_id, receipt_no, payment_date, amount, method, created_by) VALUES (?,?,?,?,?,?)",
    [c.id, r1, '2026-07-06', 1, 'cash', 'Tester']);
  const r2 = nextReceiptNo();
  db.run("INSERT INTO payments (case_id, receipt_no, payment_date, amount, method, created_by) VALUES (?,?,?,?,?,?)",
    [c.id, r2, '2026-07-06', 1, 'cash', 'Tester']);
  db.run('DELETE FROM payments WHERE receipt_no=?', [r1]); // delete the earlier one
  assert.notStrictEqual(nextReceiptNo(), r2); // must not reuse r2's still-taken number
  assert.notStrictEqual(nextReceiptNo(), r1); // nor the freed earlier one (MAX+1)
});

const { recordFulfillment } = require('../src/routes/ptps');

test('recordFulfillment is atomic: payment failure reverts the PTP flip', () => {
  const c = db.get('SELECT id FROM cases ORDER BY id DESC LIMIT 1');
  db.run("UPDATE cases SET principal_amount=100, interest_amount=0, outstanding_amount=100, status='negotiation' WHERE id=?", [c.id]);
  const ptp = db.run("INSERT INTO ptps (case_id, amount, due_date, status, created_by) VALUES (?,?,?,?,?)",
    [c.id, 50, '2026-08-01', 'pending', 'Tester']);
  const before = db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [c.id]).n;
  // Force the payment INSERT to blow up mid-transaction.
  const orig = db.db.prepare.bind(db.db);
  db.db.prepare = (sql) => { if (/INSERT INTO payments/.test(sql)) throw new Error('boom'); return orig(sql); };
  try {
    assert.throws(() => recordFulfillment(ptp.lastInsertRowid, {}, req), /boom/);
  } finally {
    db.db.prepare = orig;
  }
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [ptp.lastInsertRowid]).status, 'pending');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [c.id]).n, before);
});

test('recordFulfillment happy path: PTP fulfilled + payment recorded + outstanding reduced', () => {
  const c = db.get('SELECT id FROM cases ORDER BY id DESC LIMIT 1');
  db.run("UPDATE cases SET principal_amount=100, interest_amount=0, outstanding_amount=100, status='negotiation' WHERE id=?", [c.id]);
  const ptp = db.run("INSERT INTO ptps (case_id, amount, due_date, status, created_by) VALUES (?,?,?,?,?)",
    [c.id, 40, '2026-08-01', 'pending', 'Tester']);
  const r = recordFulfillment(ptp.lastInsertRowid, {}, req);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [ptp.lastInsertRowid]).status, 'fulfilled');
  assert.strictEqual(db.get('SELECT outstanding_amount FROM cases WHERE id=?', [c.id]).outstanding_amount, 60);
});

test('recordFulfillment blocks overpayment and records nothing', () => {
  const c = db.get('SELECT id FROM cases ORDER BY id DESC LIMIT 1');
  db.run("UPDATE cases SET principal_amount=100, interest_amount=0, outstanding_amount=100, status='negotiation' WHERE id=?", [c.id]);
  const ptp = db.run("INSERT INTO ptps (case_id, amount, due_date, status, created_by) VALUES (?,?,?,?,?)",
    [c.id, 500, '2026-08-01', 'pending', 'Tester']);
  const before = db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [c.id]).n;
  const r = recordFulfillment(ptp.lastInsertRowid, {}, req);
  assert.deepStrictEqual(r, { ok: false, error: 'Amount exceeds outstanding' });
  const after = db.get('SELECT COUNT(*) n FROM payments WHERE case_id=?', [c.id]).n;
  assert.strictEqual(after, before);
  assert.strictEqual(db.get('SELECT status FROM ptps WHERE id=?', [ptp.lastInsertRowid]).status, 'pending');
});
