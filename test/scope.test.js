process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-scope-' + process.pid + '.db'); // never the real data/crm.db
const { test } = require('node:test');
const assert = require('node:assert');
const scope = require('../src/utils/scope');

test('caseWhere unrestricted for admin', () => {
  const r = scope.caseWhere({ role: 'admin' });
  assert.strictEqual(r.clause, '1=1');
  assert.deepStrictEqual(r.params, []);
});
test('caseWhere for agent filters agent_id', () => {
  const r = scope.caseWhere({ role: 'agent', agent_id: 7 });
  assert.match(r.clause, /agent_id = \?/);
  assert.deepStrictEqual(r.params, [7]);
});
test('caseWhere for client filters client_id', () => {
  const r = scope.caseWhere({ role: 'client', client_id: 3 });
  assert.match(r.clause, /client_id = \?/);
  assert.deepStrictEqual(r.params, [3]);
});
test('isScoped', () => {
  assert.strictEqual(scope.isScoped({ role: 'agent' }), true);
  assert.strictEqual(scope.isScoped({ role: 'manager' }), false);
});
