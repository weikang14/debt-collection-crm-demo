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
