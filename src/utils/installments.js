const dayjs = require('dayjs');

const round2 = (n) => Math.round(n * 100) / 100;

// Split `total` into `n` cent-exact installments. First n-1 use the
// floor-to-cent base; the last absorbs the remainder so the array sums to
// exactly round2(total) — no rounding drift across a plan.
function splitInstallments(total, n) {
  if (!(total > 0)) throw new Error('total must be > 0');
  if (!Number.isInteger(n) || n < 2 || n > 60) throw new Error('installments must be an integer 2..60');
  const t = round2(total);
  const base = Math.floor((t / n) * 100) / 100;
  const parts = Array(n - 1).fill(base);
  const last = round2(t - base * (n - 1));
  parts.push(last);
  return parts;
}

// N monthly due dates starting at firstDate ('YYYY-MM-DD'). dayjs handles
// month-end (Jan 31 + 1 month = Feb 28).
function dueDates(firstDate, n) {
  const start = dayjs(firstDate);
  return Array.from({ length: n }, (_, k) => start.add(k, 'month').format('YYYY-MM-DD'));
}

module.exports = { splitInstallments, dueDates };
