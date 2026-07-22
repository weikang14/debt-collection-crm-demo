const { dailyRate, daysBetween } = require('../services/payments');
const { dueDates } = require('./installments');
const { round2 } = require('./helpers');

// "Today" in Malaysia local time (UTC+8) as YYYY-MM-DD, to compare against
// due_date strings. Same +8h-then-truncate idiom as payments.js's daysBetween
// and the date-input default in cases/show.ejs.
// ponytail: TZ offset duplicated a third time; extract to a shared const if a
// 4th call site shows up.
function todayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// Projects caseBalance()'s interest-first (先息后本) model (src/services/payments.js)
// onto a monthly schedule: assuming on-time payment, periods 1..n-1 are
// interest-only and period n (maturity) also clears the full principal.
// Only generated for interest_mode='monthly' + tenure_unit='months' — daily
// accrual has no natural period boundary, fixed has no periodic rate, and
// days/years tenure would need an arbitrary conversion into monthly periods.
// Paid/outstanding/status are derived live from `payments` (a FIFO waterfall
// in schedule order, independent of each payment's actual date) — nothing
// here is persisted, so editing tenure/rate takes effect on the next read.
function repaymentSchedule(c, payments) {
  if (c.interest_mode !== 'monthly' || c.tenure_unit !== 'months' || !c.tenure || !c.loan_start_date) {
    return [];
  }
  const rate = dailyRate(c);
  const dates = dueDates(c.loan_start_date, c.tenure + 1).slice(1);
  let pool = payments.reduce((s, p) => s + p.amount, 0);
  // Match caseBalance()'s accrual origin (src/services/payments.js) so period 1's
  // "Expected" interest never disagrees with the ledger's interest figure shown
  // elsewhere on the case page. Trailing `|| c.loan_start_date` is a fallback for
  // pure-function callers/tests that don't set opened_at; never triggers on real
  // DB rows since opened_at is NOT NULL in schema.
  let periodStart = c.interest_from || c.opened_at || c.loan_start_date;
  const today = todayStr();
  return dates.map((due, i) => {
    const isLast = i === dates.length - 1;
    let expected = round2(c.principal_amount * rate * daysBetween(periodStart, due));
    if (isLast) expected = round2(expected + c.principal_amount);
    const paid = round2(Math.min(expected, Math.max(0, pool)));
    pool -= paid;
    periodStart = due;
    const outstanding = round2(Math.max(0, expected - paid));
    // A period with expected_amount === 0 (e.g. interest_rate: 0) has nothing owed,
    // so paid(0) >= expected(0) is intentionally 'paid' even with zero actual payment —
    // 0 owed = nothing outstanding = satisfied, not a bug.
    const status = paid >= expected ? 'paid'
      : due < today ? 'overdue'
      : paid > 0 ? 'partial'
      : 'pending';
    return { due_date: due, expected_amount: expected, paid_amount: paid, outstanding_amount: outstanding, status };
  });
}

module.exports = { repaymentSchedule };
