const { test } = require('node:test');
const assert = require('node:assert');
const { splitInstallments, dueDates } = require('../src/utils/installments');

test('splitInstallments: even split sums to total', () => {
  const parts = splitInstallments(10000, 5);
  assert.deepStrictEqual(parts, [2000, 2000, 2000, 2000, 2000]);
  assert.strictEqual(parts.reduce((s, x) => s + x, 0), 10000);
});

test('splitInstallments: remainder goes to last, sum exact', () => {
  const parts = splitInstallments(10003, 3);
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0], 3334.33);
  assert.strictEqual(parts[1], 3334.33);
  assert.strictEqual(parts[2], 3334.34);
  assert.strictEqual(Math.round(parts.reduce((s, x) => s + x, 0) * 100), 1000300);
  parts.forEach(p => assert.ok(p > 0));
});

test('splitInstallments: rejects bad inputs', () => {
  assert.throws(() => splitInstallments(0, 3));
  assert.throws(() => splitInstallments(-5, 3));
  assert.throws(() => splitInstallments(100, 1));
  assert.throws(() => splitInstallments(100, 61));
  assert.throws(() => splitInstallments(100, 2.5));
});

test('dueDates: monthly cadence, length n', () => {
  const ds = dueDates('2026-08-01', 5);
  assert.deepStrictEqual(ds, ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
});

test('dueDates: month-end rolls back (Jan 31 -> Feb 28)', () => {
  const ds = dueDates('2026-01-31', 2);
  assert.strictEqual(ds[0], '2026-01-31');
  assert.strictEqual(ds[1], '2026-02-28');
});
