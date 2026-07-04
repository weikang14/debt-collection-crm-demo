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
