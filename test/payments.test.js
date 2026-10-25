process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-payments-' + process.pid + '.db'); // never the real data/crm.db
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
test('void restores balance: stale fully_paid reverts (some payments -> partial, none -> negotiation)', () => {
  assert.strictEqual(statusAfterPayment('fully_paid', 500, 1), 'partial_paid');
  assert.strictEqual(statusAfterPayment('fully_paid', 500, 0), 'negotiation');
});

const { bucketAging } = require('../src/utils/aging');
test('aging buckets: sums outstanding into 0-30/31-60/61-90/90+ by age', () => {
  assert.deepStrictEqual(
    bucketAging([{ age: 10, amt: 10 }, { age: 30, amt: 5 }, { age: 45, amt: 7 }, { age: 90, amt: 3 }, { age: 200, amt: 100 }]),
    [15, 7, 3, 100]);
});
