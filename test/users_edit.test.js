// isolate the DB the users route opens at module load, so this never touches data/crm.db
process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-uedit-test-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const { userEditGuard } = require('../src/routes/users');

const meAdmin = { id: 1, role: 'admin' };

test('blocks self-demotion from admin', () => {
  assert.match(userEditGuard(meAdmin, 1, 'manager', 1) || '', /role/i);
});
test('blocks self-deactivation', () => {
  assert.match(userEditGuard(meAdmin, 1, 'admin', 0) || '', /deactivat|disable|inactive/i);
});
test('allows editing self while staying admin+active', () => {
  assert.strictEqual(userEditGuard(meAdmin, 1, 'admin', 1), null);
});
test('allows editing another user freely', () => {
  assert.strictEqual(userEditGuard(meAdmin, 2, 'manager', 0), null);
});
