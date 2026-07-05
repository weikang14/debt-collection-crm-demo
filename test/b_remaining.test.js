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

test('statement paid = SUM(payments); fully_paid case has paid == principal+interest', () => {
  seed.seedDemo();
  const c = db.get("SELECT * FROM cases WHERE status='fully_paid' LIMIT 1");
  const paid = db.get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE case_id=?', [c.id]).s;
  assert.ok(paid > 0);
  assert.strictEqual(paid, c.principal_amount + c.interest_amount);   // fully paid → paid covers total
  assert.strictEqual(c.outstanding_amount, 0);
});
