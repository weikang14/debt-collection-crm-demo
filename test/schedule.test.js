process.env.CRM_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'crm-schedule-' + process.pid + '.db');
const { test } = require('node:test');
const assert = require('node:assert');
const { repaymentSchedule } = require('../src/utils/schedule');
const { caseBalance } = require('../src/services/payments');
const { round2 } = require('../src/utils/helpers');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

// principal 3000 @ 3%/month => 90.00 per whole month (D-01: the monthly mode
// charges principal × rate per month, whatever the month's length).
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
  near(rows[0].expected_amount, 90, 'Jan interest-only');
  near(rows[1].expected_amount, 90, 'Feb interest-only — same as a 31-day month');
  near(rows[2].expected_amount, 3090, 'Mar interest + principal');
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
  const rows = repaymentSchedule(baseCase(), [{ amount: 180, payment_date: '2026-02-15' }]);
  assert.strictEqual(rows[0].status, 'paid');
  assert.strictEqual(rows[1].status, 'paid');
  near(rows[0].paid_amount, 90, 'period 1 fully paid');
  near(rows[1].paid_amount, 90, 'period 2 fully paid');
  near(rows[2].paid_amount, 0, 'period 3 untouched');
  assert.strictEqual(rows[2].status, 'overdue'); // due 2026-04-01, long past, unpaid
  near(rows[2].outstanding_amount, 3090, 'period 3 fully outstanding');
});

test('overpayment: no row paid_amount exceeds its expected_amount, excess is unused', () => {
  const rows = repaymentSchedule(baseCase(), [{ amount: 5000, payment_date: '2026-01-15' }]);
  rows.forEach(r => assert.ok(r.paid_amount <= r.expected_amount));
  const totalPaid = rows.reduce((s, r) => s + r.paid_amount, 0);
  near(totalPaid, 3270, 'total applied caps at total expected, not the 5000 paid'); // 90+90+3090
  rows.forEach(r => assert.strictEqual(r.status, 'paid'));
});

test('daily mode: same interest-first schedule, per-day rate = annual ÷365, agrees with ledger', () => {
  // 36.5% p.a. => 0.001/day: the daily mode follows the calendar (31/28/31 days).
  const c = baseCase({ interest_mode: 'daily', interest_rate: 36.5 });
  const rows = repaymentSchedule(c, []);
  assert.strictEqual(rows.length, 3);
  near(rows[0].expected_amount, 93, 'Jan (31d) interest-only');
  near(rows[1].expected_amount, 84, 'Feb (28d) interest-only');
  near(rows[2].expected_amount, 3093, 'Mar (31d) interest + principal');
  const sumExpected = rows.reduce((s, r) => s + r.expected_amount, 0);
  near(sumExpected, caseBalance(c, [], rows[2].due_date).interest + c.principal_amount, 'daily schedule total agrees with ledger');
});

test('fixed mode: principal + lump interest in equal instalments, last absorbs the cent remainder', () => {
  const c = baseCase({ interest_mode: 'fixed', interest_amount: 300.01 });
  const rows = repaymentSchedule(c, []);
  assert.deepStrictEqual(rows.map(r => r.expected_amount), [1100, 1100, 1100.01]);
  near(rows.reduce((s, r) => s + r.expected_amount, 0), caseBalance(c, []).outstanding, 'fixed schedule total = ledger outstanding');
  const paid = repaymentSchedule(c, [{ amount: 1100, payment_date: '2026-02-01' }]);
  assert.deepStrictEqual(paid.map(r => r.status), ['paid', 'overdue', 'overdue']);
});

test('ledger settled (early payoff cut interest below projection) => every row paid, nothing outstanding', () => {
  // Paid 3200 of a projected 3270: ledger says 0 left because paying early saved interest.
  const rows = repaymentSchedule(baseCase({ outstanding_amount: 0 }), [{ amount: 3200, payment_date: '2026-01-15' }]);
  rows.forEach(r => { assert.strictEqual(r.status, 'paid'); assert.strictEqual(r.outstanding_amount, 0); });
  near(rows[2].paid_amount, 3020, 'last row shows what was actually paid (3200 - 90 - 90), not the projection');
});

test('fixed mode: 1-month and >60-month tenures do not throw (outside the PTP plan 2..60 limit)', () => {
  assert.deepStrictEqual(repaymentSchedule(baseCase({ interest_mode: 'fixed', interest_amount: 0, tenure: 1 }), []).map(r => r.expected_amount), [3000]);
  const long = repaymentSchedule(baseCase({ interest_mode: 'fixed', interest_amount: 600, tenure: 72 }), []);
  assert.strictEqual(long.length, 72);
  near(long.reduce((s, r) => s + r.expected_amount, 0), 3600, '72 instalments sum to principal + interest');
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

test('interest_from different from loan_start_date: period 1 accrues from interest_from, not loan_start_date', () => {
  // Loan disbursed 2026-01-01 but collection/interest only starts 2026-01-10
  // (a case opened for collection long after the loan was disbursed).
  const c = baseCase({ loan_start_date: '2026-01-01', interest_from: '2026-01-10' });
  const rows = repaymentSchedule(c, []);
  // period 1 due date is still driven off loan_start_date's month boundary
  assert.strictEqual(rows[0].due_date, '2026-02-01');
  // 01-10 -> 02-01 is 22 of the 31 days in the month that starts on 01-10.
  near(rows[0].expected_amount, round2(3000 * 0.03 * 22 / 31), 'period 1 accrues only from interest_from (22/31 month), not a whole month');

  // The real point of the fix: schedule total must never silently disagree with caseBalance.
  const sumExpected = rows.reduce((s, r) => s + r.expected_amount, 0);
  const b = caseBalance(c, [], rows[rows.length - 1].due_date);
  near(sumExpected, b.interest + c.principal_amount, 'schedule total still agrees with ledger total when interest_from != loan_start_date');
});

test('interest_rate 0: every non-final period is paid with nothing owed, even with zero actual payment (documented contract)', () => {
  const rows = repaymentSchedule(baseCase({ interest_rate: 0 }), []);
  rows.forEach((r, i) => {
    if (i === rows.length - 1) return; // final period bundles principal, not expected to be 0
    assert.strictEqual(r.expected_amount, 0, `period ${i} expected_amount`);
    assert.strictEqual(r.paid_amount, 0, `period ${i} paid_amount`);
    assert.strictEqual(r.status, 'paid', `period ${i} status`);
  });
});

test('arrears row comes first and is paid first (FIFO)', () => {
  const rows = repaymentSchedule(baseCase(), [{ amount: 50, payment_date: '2026-02-01' }], { arrears: 40 });
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].kind, 'arrears');
  assert.strictEqual(rows[0].due_date, '2026-02-01', 'N-01: due with the first new instalment, not on the start date');
  assert.strictEqual(rows[0].status, 'paid');
  near(rows[1].paid_amount, 10, 'remaining 10 goes to period 1');
  assert.strictEqual(rows[1].kind, 'regular');
});

test('superseded schedule: unpaid rows read "restructured" and settled logic is skipped', () => {
  const rows = repaymentSchedule(baseCase({ outstanding_amount: 0 }), [{ amount: 100, payment_date: '2026-01-15' }], { superseded: true });
  assert.deepStrictEqual(rows.map(r => r.status), ['paid', 'restructured', 'restructured']);
  near(rows[2].outstanding_amount, 3090, 'not zeroed by a settled ledger');
});
