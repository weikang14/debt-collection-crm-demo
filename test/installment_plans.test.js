const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolated DB per run.
process.env.CRM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-inst-')), 'crm.db');
const { db, init, get, all, run } = require('../src/db');

before(() => { init(); });

test('ptps has plan grouping columns', () => {
  const cols = all('PRAGMA table_info(ptps)').map(c => c.name);
  assert.ok(cols.includes('plan_id'));
  assert.ok(cols.includes('installment_no'));
  assert.ok(cols.includes('plan_size'));
});
