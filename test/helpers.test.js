const { test } = require('node:test');
const assert = require('node:assert');
const h = require('../src/utils/helpers');

test('money formats with 2dp and thousands', () => {
  assert.strictEqual(h.money(1234.5), '1,234.50');
  assert.strictEqual(h.money(0), '0.00');
  assert.strictEqual(h.money(1000000), '1,000,000.00');
});
test('caseStatusClass maps semantics', () => {
  assert.strictEqual(h.caseStatusClass('fully_paid'), 'is-green');
  assert.strictEqual(h.caseStatusClass('legal'), 'is-red');
  assert.strictEqual(h.caseStatusClass('ptp'), 'is-gold');
  assert.strictEqual(h.caseStatusClass('new'), 'is-neutral');
});
test('icon returns inline svg string', () => {
  assert.match(h.icon('dashboard'), /^<svg/);
});
