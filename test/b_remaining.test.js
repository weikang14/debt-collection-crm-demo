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
