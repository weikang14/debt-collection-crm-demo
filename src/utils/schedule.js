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
  let periodStart = c.loan_start_date;
  const today = todayStr();
  return dates.map((due, i) => {
    const isLast = i === dates.length - 1;
    let expected = round2(c.principal_amount * rate * daysBetween(periodStart, due));
    if (isLast) expected = round2(expected + c.principal_amount);
    const paid = round2(Math.min(expected, Math.max(0, pool)));
    pool -= paid;
    periodStart = due;
    const outstanding = round2(Math.max(0, expected - paid));
    const status = paid >= expected ? 'paid'
      : due < today ? 'overdue'
      : paid > 0 ? 'partial'
      : 'pending';
    return { due_date: due, expected_amount: expected, paid_amount: paid, outstanding_amount: outstanding, status };
  });
}

module.exports = { repaymentSchedule };
