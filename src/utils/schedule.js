const { accrue } = require('../services/payments');
const { dueDates } = require('./installments');
const { round2, todayMYT } = require('./helpers');

// Monthly repayment schedule over the loan tenure, one row per month.
// - monthly / daily (accrual modes): projects caseBalance()'s interest-first
//   (先息后本) model (src/services/payments.js) — assuming on-time payment,
//   periods 1..n-1 are interest-only and period n (maturity) also clears the
//   full principal. Repayment is monthly either way; interest per period comes
//   from the ledger's own accrue(): monthly mode principal × rate per month,
//   daily mode annual ÷365 per day.
// - fixed: principal + the lump interest split into n equal instalments (等额分期).
// days/years tenure gets no schedule — it would need an arbitrary conversion
// into monthly periods (legacy rows only; the form now always saves months).
// Paid/outstanding/status are derived live from `payments` (a FIFO waterfall
// in schedule order, independent of each payment's actual date) — nothing
// here is persisted, so editing tenure/rate takes effect on the next read.
// opts.arrears: a restructure's carried unpaid interest (kind 'arrears'), due
//   with the first new instalment (N-01) — so a fresh restructure isn't overdue
//   the next day — and first in FIFO.
// opts.superseded: a schedule replaced by a restructure — shown as history, so
//   the ledger-settled override is skipped and unpaid rows read 'restructured'.
function repaymentSchedule(c, payments, opts = {}) {
  if (c.tenure_unit !== 'months' || !c.tenure || !c.loan_start_date) {
    return [];
  }
  const dates = dueDates(c.loan_start_date, c.tenure + 1).slice(1);
  const n = dates.length;
  let expectedList;
  if (c.interest_mode === 'monthly' || c.interest_mode === 'daily') {
    // Match caseBalance()'s accrual origin (src/services/payments.js) so period 1's
    // "Expected" interest never disagrees with the ledger's interest figure shown
    // elsewhere on the case page. Trailing `|| c.loan_start_date` is a fallback for
    // pure-function callers/tests that don't set opened_at; never triggers on real
    // DB rows since opened_at is NOT NULL in schema.
    const start = c.interest_from || c.opened_at || c.loan_start_date;
    const seg = { interest_mode: c.interest_mode, interest_rate: c.interest_rate, start };
    let periodStart = start;
    expectedList = dates.map((due, i) => {
      let expected = round2(accrue(seg, c.principal_amount, periodStart, due));
      if (i === n - 1) expected = round2(expected + c.principal_amount);
      periodStart = due;
      return expected;
    });
  } else {
    // Same cent-exact split as splitInstallments() (last row absorbs the
    // remainder), inlined because that one enforces the PTP plan's 2..60 limit
    // and a 1- or 72-month loan must not throw on the case page.
    const total = round2(c.principal_amount + (c.interest_amount || 0));
    const base = Math.floor((total / n) * 100) / 100;
    expectedList = dates.map((_, i) => (i === n - 1 ? round2(total - base * (n - 1)) : base));
  }
  const periods = dates.map((due, i) => ({ due, expected: expectedList[i], kind: 'regular' }));
  if (opts.arrears > 0) periods.unshift({ due: dates[0], expected: round2(opts.arrears), kind: 'arrears' });
  let pool = payments.reduce((s, p) => s + p.amount, 0);
  // The schedule projects on-time payment, but the ledger accrues by actual
  // payment date — paying early cuts interest below the projection. Once the
  // ledger is settled, nothing is owed on any row (paid_amount stays truthful).
  // ponytail: only the fully-settled case is reconciled; a partial prepayment is
  // re-planned through an explicit restructure.
  const settled = !opts.superseded && c.outstanding_amount <= 0;
  const today = todayMYT();
  return periods.map(({ due, expected, kind }) => {
    const paid = round2(Math.min(expected, Math.max(0, pool)));
    pool -= paid;
    const outstanding = settled ? 0 : round2(Math.max(0, expected - paid));
    // A period with expected_amount === 0 (e.g. interest_rate: 0) has nothing owed,
    // so paid(0) >= expected(0) is intentionally 'paid' even with zero actual payment —
    // 0 owed = nothing outstanding = satisfied, not a bug.
    const status = settled || paid >= expected ? 'paid'
      : opts.superseded ? 'restructured'
      : due < today ? 'overdue'
      : paid > 0 ? 'partial'
      : 'pending';
    return { due_date: due, expected_amount: expected, paid_amount: paid, outstanding_amount: outstanding, status, kind };
  });
}

module.exports = { repaymentSchedule };
