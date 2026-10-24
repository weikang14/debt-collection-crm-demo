process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-rsdemo-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
db.init();
const seed = require('../src/db/seed');
seed.seedDemo();

test('demo seed restructures case 14 with carried arrears', () => {
  const r = db.get('SELECT * FROM case_restructures WHERE case_id=14');
  assert.ok(r, 'restructure row exists');
  assert.strictEqual(r.is_demo, 1);
  assert.strictEqual(r.tenure, 18);
  assert.ok(r.arrears_at_cut > 0);
  const c = db.get('SELECT outstanding_amount FROM cases WHERE id=14');
  assert.ok(c.outstanding_amount > r.principal_at_cut + r.arrears_at_cut, 'new-term interest on top');
});

test('deleteDemo removes demo restructures together with their case', () => {
  seed.deleteDemo();
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM case_restructures').n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM cases WHERE id=14').n, 0);
});

test('demo payments are stored as plain dates', () => {
  seed.insertDemoRows();
  const bad = db.all('SELECT payment_date FROM payments WHERE is_demo=1').filter(p => !/^\d{4}-\d{2}-\d{2}$/.test(p.payment_date));
  assert.deepStrictEqual(bad, []);
});

test('deleteDemo keeps a demo restructure whose case still has customer payments', () => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount,is_demo) VALUES (14,'CUST-1',?,50,0)", [today]);
  seed.deleteDemo();
  assert.ok(db.get('SELECT 1 x FROM cases WHERE id=14'), 'case kept for the customer payment');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM case_restructures WHERE case_id=14').n, 1, 'its restructure kept too');
  seed.insertDemoRows();
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM case_restructures WHERE case_id=14').n, 1, 'reload does not duplicate it');
});

test('reload skips the demo restructure when case 14 has a payment on or after its date', () => {
  db.run('DELETE FROM case_restructures WHERE case_id=14');
  seed.insertDemoRows();
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM case_restructures WHERE case_id=14').n, 0);
});
