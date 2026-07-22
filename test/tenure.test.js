const { test } = require('node:test');
const assert = require('node:assert');
const { maturityDate } = require('../src/utils/installments');

test('maturityDate: days unit adds calendar days', () => {
  assert.strictEqual(maturityDate('2026-07-01', 30, 'days'), '2026-07-31');
});

test('maturityDate: months unit adds calendar months', () => {
  assert.strictEqual(maturityDate('2026-07-01', 12, 'months'), '2027-07-01');
});

test('maturityDate: years unit adds calendar years', () => {
  assert.strictEqual(maturityDate('2026-07-01', 1, 'years'), '2027-07-01');
});

test('maturityDate: month-end rolls back (Jan 31 + 1 month -> Feb 28)', () => {
  assert.strictEqual(maturityDate('2026-01-31', 1, 'months'), '2026-02-28');
});

test('maturityDate: unknown unit falls back to months', () => {
  assert.strictEqual(maturityDate('2026-07-01', 1, 'bogus'), '2026-08-01');
});
