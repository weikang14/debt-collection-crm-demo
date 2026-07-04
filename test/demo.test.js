process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-demo-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const db = require('../src/db');
db.init();

test('is_demo defaults to 0 for app-created rows', () => {
  const r = db.run("INSERT INTO clients (company_name, commission_rate) VALUES ('T', 0)");
  const row = db.get('SELECT is_demo FROM clients WHERE id=?', [r.lastInsertRowid]);
  assert.strictEqual(row.is_demo, 0);
});

const seed = require('../src/db/seed');

test('seedDemo tags all demo rows is_demo=1 with fixed parent ids', () => {
  seed.seedDemo();
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases').c, 20);
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c, 20);
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=1').c, 12);
  // fixed ids: case ids are 1..20
  assert.strictEqual(db.get('SELECT MIN(id) lo, MAX(id) hi FROM cases').lo, 1);
  assert.strictEqual(db.get('SELECT MAX(id) hi FROM cases').hi, 20);
});

test('insertDemoRows is idempotent (no duplicate parents)', () => {
  seed.seedDemo();
  const before = db.get('SELECT COUNT(*) c FROM debtors').c;
  seed.insertDemoRows();
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM debtors').c, before);
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases').c, 20);
});

test('deleteDemo removes demo data but keeps customer rows', () => {
  seed.seedDemo();
  // a customer (is_demo=0) debtor + case, independent of demo data
  const d = db.run("INSERT INTO debtors (name,risk_level) VALUES ('My Debtor','low')");
  const c = db.run("INSERT INTO cases (case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status) VALUES ('CASE-9999-0001',1,?,100,0,100,'new')", [d.lastInsertRowid]);
  seed.deleteDemo();
  // demo gone
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c > 0, false);
  // customer case + debtor survive
  assert.ok(db.get('SELECT id FROM cases WHERE id=?', [c.lastInsertRowid]));
  assert.ok(db.get('SELECT id FROM debtors WHERE id=?', [d.lastInsertRowid]));
});

test('deleteDemo keeps a demo case referenced by customer data', () => {
  seed.seedDemo();
  // customer (is_demo=0) payment on demo case 5
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount,is_demo) VALUES (5,'RCPT-9999-0001','2026-07-04',50,0)");
  seed.deleteDemo();
  // demo case 5 kept because a customer payment references it
  assert.ok(db.get('SELECT id FROM cases WHERE id=5'));
  // an unreferenced demo case (e.g. 1) is gone
  assert.strictEqual(db.get('SELECT id FROM cases WHERE id=1'), undefined);
});

test('reload (deleteDemo + insertDemoRows) restores demo and keeps customer data', () => {
  seed.seedDemo();
  const d = db.run("INSERT INTO debtors (name,risk_level) VALUES ('Keep Me','low')");
  seed.deleteDemo();
  seed.insertDemoRows();               // = reload
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c, 20);   // demo back
  assert.ok(db.get('SELECT id FROM debtors WHERE id=?', [d.lastInsertRowid]));         // customer row kept
  // no duplicate demo debtors
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM debtors WHERE is_demo=1').c, 12);
});

test('per-case paid subquery sums a case\'s payments', () => {
  seed.seedDemo();
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (7,'RCPT-T-1','2026-07-04',30)");
  db.run("INSERT INTO payments (case_id,receipt_no,payment_date,amount) VALUES (7,'RCPT-T-2','2026-07-04',20)");
  const row = db.get("SELECT (SELECT COALESCE(SUM(amount),0) FROM payments WHERE case_id=cases.id) AS paid FROM cases WHERE id=7");
  assert.strictEqual(row.paid, 50);
});

test('reload does not collide when a trial case reused a demo-looking case_no', () => {
  // Repro of the real bug: delete demo -> trial case grabs "CASE-YYYY-0001" ->
  // reload must not crash on a case_no UNIQUE conflict + FK on its timeline row.
  seed.seedDemo();
  seed.deleteDemo();
  const year = new Date().getFullYear();
  const cl = db.run("INSERT INTO clients (company_name,commission_rate) VALUES ('自营业务',0)");
  const dbt = db.run("INSERT INTO debtors (name,risk_level) VALUES ('Trial Debtor','low')");
  db.run(`INSERT INTO cases (case_no,client_id,debtor_id,principal_amount,interest_amount,outstanding_amount,status) VALUES ('CASE-${year}-0001', ?, ?, 100, 0, 100, 'new')`, [cl.lastInsertRowid, dbt.lastInsertRowid]);
  assert.doesNotThrow(() => seed.insertDemoRows());   // was: FOREIGN KEY constraint failed
  assert.strictEqual(db.get('SELECT COUNT(*) c FROM cases WHERE is_demo=1').c, 20);   // full demo restored
  assert.ok(db.get(`SELECT id FROM cases WHERE case_no='CASE-${year}-0001'`));         // trial case kept
});
