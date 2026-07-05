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
