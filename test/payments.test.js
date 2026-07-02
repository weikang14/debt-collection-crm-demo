const { test } = require('node:test');
const assert = require('node:assert');
const { statusAfterPayment, TERMINAL_STATUSES } = require('../src/services/payments');

test('terminal statuses are not overwritten', () => {
  for (const s of ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased']) {
    assert.strictEqual(statusAfterPayment(s, 0, 1), s);
  }
});
test('outstanding zero -> fully_paid', () => {
  assert.strictEqual(statusAfterPayment('negotiation', 0, 2), 'fully_paid');
});
test('outstanding remaining with payments -> partial_paid', () => {
  assert.strictEqual(statusAfterPayment('assigned', 500, 1), 'partial_paid');
});
test('no payments yet -> unchanged', () => {
  assert.strictEqual(statusAfterPayment('new', 1000, 0), 'new');
});
