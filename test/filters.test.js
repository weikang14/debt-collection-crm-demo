const { test } = require('node:test');
const assert = require('node:assert');
const { debtorFilter } = require('../src/utils/debtorFilter');

test('unrestricted, no filters -> 1=1 no params', () => {
  const r = debtorFilter(null, {});
  assert.strictEqual(r.where, '1=1');
  assert.deepStrictEqual(r.params, []);
});
test('scoped ids -> IN clause', () => {
  const r = debtorFilter([2, 5], {});
  assert.match(r.where, /id IN \(\?,\?\)/);
  assert.deepStrictEqual(r.params, [2, 5]);
});
test('empty scope -> 1=0', () => {
  const r = debtorFilter([], {});
  assert.strictEqual(r.where, '1=0');
});
test('risk + q filters append params', () => {
  const r = debtorFilter(null, { risk: 'high', q: 'ali' });
  assert.match(r.where, /risk_level = \?/);
  assert.match(r.where, /name LIKE \?/);
  assert.deepStrictEqual(r.params, ['high', '%ali%', '%ali%', '%ali%']);
});
test('invalid risk is ignored', () => {
  const r = debtorFilter(null, { risk: 'bogus' });
  assert.strictEqual(r.where, '1=1');
  assert.deepStrictEqual(r.params, []);
});
