const { test } = require('node:test');
const assert = require('node:assert');
const { parseActive, validatePayment } = require('../src/utils/forms');

test('parseActive: only "0" is inactive; everything else is active', () => {
  assert.strictEqual(parseActive('0'), 0);
  assert.strictEqual(parseActive('1'), 1);
  assert.strictEqual(parseActive(undefined), 1); // create default
  assert.strictEqual(parseActive('on'), 1);
});

test('validatePayment: rejects non-numeric, zero, negative', () => {
  assert.deepStrictEqual(validatePayment('abc', 100), { error: 'Invalid amount' });
  assert.deepStrictEqual(validatePayment('', 100), { error: 'Invalid amount' });
  assert.deepStrictEqual(validatePayment(0, 100), { error: 'Invalid amount' });
  assert.deepStrictEqual(validatePayment(-5, 100), { error: 'Invalid amount' });
});
test('validatePayment: blocks overpayment, allows exact payoff and partial', () => {
  assert.deepStrictEqual(validatePayment(150, 100), { error: 'Amount exceeds outstanding' });
  assert.deepStrictEqual(validatePayment(100, 100), { amount: 100 });
  assert.deepStrictEqual(validatePayment(30, 100), { amount: 30 });
});
test('validatePayment: returns the amount exactly, no rounding', () => {
  assert.deepStrictEqual(validatePayment(12.345, 100), { amount: 12.345 });
});
