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
