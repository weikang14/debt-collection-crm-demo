process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-schedule-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const { repaymentSchedule } = require('../src/utils/schedule');
const { caseBalance } = require('../src/services/payments');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

// principal 3000, 3%/month => dailyRate = 0.001/day exactly (clean numbers for
// hand-checked assertions). Jan has 31 days, Feb 2026 has 28 (not a leap year),
// March has 31.
function baseCase(overrides = {}) {
  return {
    interest_mode: 'monthly',
    tenure_unit: 'months',
    tenure: 3,
    loan_start_date: '2026-01-01',
    interest_from: '2026-01-01',
    principal_amount: 3000,
    interest_rate: 3,
    ...overrides,
  };
}

test('one row per tenure month; last row bundles principal', () => {
  const rows = repaymentSchedule(baseCase(), []);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].due_date, '2026-02-01');
  assert.strictEqual(rows[1].due_date, '2026-03-01');
  assert.strictEqual(rows[2].due_date, '2026-04-01');
  near(rows[0].expected_amount, 93, 'Jan (31d) interest-only');
  near(rows[1].expected_amount, 84, 'Feb (28d) interest-only');
  near(rows[2].expected_amount, 3093, 'Mar (31d) interest + principal');
});

test('zero payments, due dates already past => all overdue', () => {
  const rows = repaymentSchedule(baseCase({ loan_start_date: '2020-01-01', interest_from: '2020-01-01' }), []);
  rows.forEach(r => assert.strictEqual(r.status, 'overdue'));
});

test('zero payments, due dates far in the future => all pending', () => {
  const rows = repaymentSchedule(baseCase({ loan_start_date: '2099-01-01', interest_from: '2099-01-01' }), []);
  rows.forEach(r => assert.strictEqual(r.status, 'pending'));
});

test('lump payment covering first 2 periods exactly: waterfall fills oldest first', () => {
  const rows = repaymentSchedule(baseCase(), [{ amount: 177, payment_date: '2026-02-15' }]);
  assert.strictEqual(rows[0].status, 'paid');
  assert.strictEqual(rows[1].status, 'paid');
  near(rows[0].paid_amount, 93, 'period 1 fully paid');
  near(rows[1].paid_amount, 84, 'period 2 fully paid');
  near(rows[2].paid_amount, 0, 'period 3 untouched');
  assert.strictEqual(rows[2].status, 'overdue'); // due 2026-04-01, long past, unpaid
  near(rows[2].outstanding_amount, 3093, 'period 3 fully outstanding');
});

test('overpayment: no row paid_amount exceeds its expected_amount, excess is unused', () => {
  const rows = repaymentSchedule(baseCase(), [{ amount: 5000, payment_date: '2026-01-15' }]);
  rows.forEach(r => assert.ok(r.paid_amount <= r.expected_amount));
  const totalPaid = rows.reduce((s, r) => s + r.paid_amount, 0);
  near(totalPaid, 3270, 'total applied caps at total expected, not the 5000 paid'); // 93+84+3093
  rows.forEach(r => assert.strictEqual(r.status, 'paid'));
});

test('interest_mode other than monthly => no schedule', () => {
  assert.deepStrictEqual(repaymentSchedule(baseCase({ interest_mode: 'daily' }), []), []);
  assert.deepStrictEqual(repaymentSchedule(baseCase({ interest_mode: 'fixed' }), []), []);
});

test('tenure_unit other than months => no schedule', () => {
  assert.deepStrictEqual(repaymentSchedule(baseCase({ tenure_unit: 'days' }), []), []);
  assert.deepStrictEqual(repaymentSchedule(baseCase({ tenure_unit: 'years' }), []), []);
});

test('missing tenure or loan_start_date => no schedule', () => {
  assert.deepStrictEqual(repaymentSchedule(baseCase({ tenure: null }), []), []);
  assert.deepStrictEqual(repaymentSchedule(baseCase({ loan_start_date: null }), []), []);
});

test('identity: sum of expected_amount (zero payments) matches caseBalance at maturity', () => {
  const c = baseCase();
  const rows = repaymentSchedule(c, []);
  const sumExpected = rows.reduce((s, r) => s + r.expected_amount, 0);
  const b = caseBalance(c, [], rows[rows.length - 1].due_date);
  near(sumExpected, b.interest + c.principal_amount, 'schedule total agrees with ledger total');
});
