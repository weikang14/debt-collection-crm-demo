// Role 2 (business), round 2 — INDEPENDENT expected-value calculator.
// Written from the business rules (QA manual v1.1 ch.5 + decisions D-01…D-13),
// NOT from src/. Nothing here requires any system module.
// Exact arithmetic: BigInt fractions; half-up rounding to sen only when a figure is shown.
// Dates: own calendar (no dayjs). Run `node tests/qa/calc-r2/expected.qa.js` for the self-check.
'use strict';

// ---------- exact fractions ----------
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
class F {
  constructor(n, d = 1n) { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); this.n = n / g; this.d = d / g; }
  static of(x) {
    if (x instanceof F) return x;
    if (typeof x === 'bigint') return new F(x);
    const s = String(x);
    const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.');
    return new F(BigInt((i || '0') + f) * (neg ? -1n : 1n), 10n ** BigInt(f.length));
  }
  add(o) { o = F.of(o); return new F(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = F.of(o); return new F(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = F.of(o); return new F(this.n * o.n, this.d * o.d); }
  div(o) { o = F.of(o); return new F(this.n * o.d, this.d * o.n); }
  cmp(o) { o = F.of(o); const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  min(o) { return this.cmp(o) <= 0 ? this : F.of(o); }
  max(o) { return this.cmp(o) >= 0 ? this : F.of(o); }
  isPos() { return this.n > 0n; }
  r2() { // half-up to sen -> "1234.56"
    const neg = this.n < 0n; const n = neg ? -this.n : this.n;
    let sen = (n * 100n) / this.d; if (((n * 100n) % this.d) * 2n >= this.d) sen += 1n;
    return (neg && sen ? '-' : '') + (sen / 100n) + '.' + String(sen % 100n).padStart(2, '0');
  }
  floor2() { return new F((this.n * 100n) / this.d, 100n); }
  toString() { return `${this.n}/${this.d}`; }
}
const ZERO = new F(0n);
const r2 = x => F.of(x).r2();

// ---------- calendar ----------
const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dim = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const parse = s => s.split('-').map(Number);
const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dayNo = s => { const [y, m, d] = parse(s); return Date.UTC(y, m - 1, d) / 86400000; };
const days = (a, b) => dayNo(b) - dayNo(a);
// start + k months, clamped to month end, always from the ORIGINAL start (1/31 → 2/28 → 3/31)
function addMonths(start, k) {
  const [y, m, d] = parse(start); const t = (m - 1) + k;
  const ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12 + 1;
  return fmt(ny, nm, Math.min(d, dim(ny, nm)));
}
const addDays = (s, k) => { const t = new Date((dayNo(s) + k) * 86400000); return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const minD = (a, b) => (a < b ? a : b);

// D-01: months elapsed from `start` to `d` on the loan's own anniversaries; a part
// month is the share of THAT month's actual days.
function monthsElapsed(start, d) {
  if (d <= start) return ZERO;
  let k = 0; while (addMonths(start, k + 1) <= d) k++;
  const a = addMonths(start, k), b = addMonths(start, k + 1);
  return F.of(BigInt(k)).add(new F(BigInt(days(a, d)), BigInt(days(a, b))));
}
// interest on principal P from `from` to `to` (to > from), segment s = {mode, rate, start}
function interest(s, P, from, to) {
  if (to <= from) return ZERO;
  if (s.mode === 'monthly') return F.of(P).mul(s.rate).div(100).mul(monthsElapsed(s.start, to).sub(monthsElapsed(s.start, from)));
  if (s.mode === 'daily') return F.of(P).mul(s.rate).div(100).div(365).mul(BigInt(days(from, to)));
  return ZERO;
}
const accrues = m => m === 'monthly' || m === 'daily';

// ---------- ledger (先息后本, capped at maturity, segments for restructures) ----------
// loan {principal, mode, rate, lump, start, maturity}; restructures [{effective, mode, rate, lump, maturity}]
// payments [{date, amount}]; a payment ON a restructure date belongs to the earlier segment (D-04).
// asOf: accrual end of the last segment (default its maturity, else `today`).
function ledger(loan, payments, { restructures = [], asOf, today } = {}) {
  const segs = [{ ...loan }, ...restructures.map(r => ({ mode: r.mode, rate: r.rate, lump: r.lump || 0, start: r.effective, maturity: r.maturity }))];
  const pays = payments.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let remP = F.of(loan.principal), unpaid = ZERO, total = ZERO, excess = ZERO, pi = 0;
  const cuts = [], perPayment = [];
  segs.forEach((s, k) => {
    const next = segs[k + 1];
    const cap = d => (s.maturity && d > s.maturity ? s.maturity : d);
    if (!accrues(s.mode) && s.lump) { unpaid = unpaid.add(s.lump); total = total.add(s.lump); }
    let last = s.start;
    const run = to => { const t = cap(to); if (accrues(s.mode) && t > last) { const i = interest(s, remP, last, t); unpaid = unpaid.add(i); total = total.add(i); last = t; } };
    for (; pi < pays.length && (!next || pays[pi].date <= next.start); pi++) {
      const p = pays[pi]; run(p.date);
      const amt = F.of(p.amount); const toInt = amt.min(unpaid); unpaid = unpaid.sub(toInt);
      let toP = amt.sub(toInt), ex = ZERO;
      if (toP.cmp(remP) > 0) { ex = toP.sub(remP); toP = remP; }
      remP = remP.sub(toP); excess = excess.add(ex);
      perPayment.push({ date: p.date, amount: r2(amt), toInterest: r2(toInt), toPrincipal: r2(toP), excess: r2(ex) });
    }
    run(next ? next.start : (asOf || s.maturity || today));
    if (next) cuts.push({ effective: next.start, principal: remP.r2(), arrears: unpaid.r2(), principalExact: remP, arrearsExact: unpaid });
  });
  const paid = pays.reduce((s, p) => s.add(p.amount), ZERO);
  return { principalRemaining: remP.r2(), interestUnpaid: unpaid.r2(), interest: total.r2(), paid: paid.r2(),
    outstanding: remP.add(unpaid).r2(), outstandingExact: remP.add(unpaid), excess: excess.r2(), cuts, perPayment };
}
// D-02: what clears the loan on `date` = remaining principal + interest accrued to that day.
const settlementOn = (loan, payments, date, opts = {}) =>
  ledger(loan, payments.filter(p => p.date <= date), { ...opts, asOf: date, today: date }).outstanding;

// ---------- schedules ----------
function splitEqual(total, n) { // floor to sen; last absorbs the remainder
  const t = F.of(total); const base = t.div(BigInt(n)).floor2();
  return [...Array(n - 1).fill(base.r2()), t.sub(base.mul(BigInt(n - 1))).r2()];
}
// Repayment schedule (manual SCH-03/04/05/06): rows on start+k months; accrual modes are
// interest-only with principal in the last row; fixed = equal split of principal + lump.
// FIFO of all payments in row order; a settled ledger shows every row Paid.
function schedule({ principal, mode, rate, lump = 0, start, tenure, origin }, payments, { today, arrears, settled } = {}) {
  const dues = Array.from({ length: tenure }, (_, k) => addMonths(start, k + 1));
  let exp;
  if (accrues(mode)) {
    const seg = { mode, rate, start: origin || start }; let prev = origin || start;
    exp = dues.map((d, i) => { let e = F.of(interest(seg, principal, prev, d).r2()); prev = d; if (i === tenure - 1) e = e.add(principal); return e.r2(); });
  } else exp = splitEqual(F.of(principal).add(lump), tenure);
  const rows = dues.map((d, i) => ({ due: d, expected: exp[i], kind: 'regular' }));
  if (arrears && F.of(arrears).isPos()) rows.unshift({ due: start, expected: F.of(arrears).r2(), kind: 'arrears' });
  let pool = payments.reduce((s, p) => s.add(p.amount), ZERO);
  return rows.map(row => {
    const e = F.of(row.expected); const paid = e.min(pool.max(ZERO)); pool = pool.sub(paid);
    const out = settled ? ZERO : e.sub(paid).max(ZERO);
    const status = settled || paid.cmp(e) >= 0 ? 'Paid' : row.due < today ? 'Overdue' : paid.isPos() ? 'Partially Paid' : 'Pending';
    return { ...row, paid: paid.r2(), outstanding: out.r2(), status };
  });
}
// D-09: DPD = days from the oldest unpaid instalment's due date to today; overdue = unpaid of rows already due.
function arrears(rows, today) {
  if (!rows.length) return { dpd: null, overdue: null };
  const due = rows.filter(r => r.due < today && F.of(r.outstanding).isPos());
  if (!due.length) return { dpd: 0, overdue: '0.00' };
  return { dpd: days(due[0].due, today), overdue: due.reduce((s, r) => s.add(r.outstanding), ZERO).r2() };
}
const dpdBucket = d => (d === null ? 'No schedule' : d <= 0 ? 'Current' : d <= 30 ? '1–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : '90+');
const ageBucket = a => (a <= 30 ? '0–30' : a <= 60 ? '31–60' : a <= 90 ? '61–90' : '90+');

// ---------- PTP / plans / caps / commission ----------
const planDates = (first, n) => Array.from({ length: n }, (_, k) => addMonths(first, k));
// D-03 nominal annual rate (exact): monthly ×12, annual as is, fixed I ÷ P ÷ (months/12)
function nominalRate({ mode, rate, lump, tenure }, principal) {
  if (mode === 'monthly') return F.of(rate).mul(12n);
  if (mode === 'daily') return F.of(rate);
  if (!tenure) return null;
  return F.of(lump || 0).div(principal).div(new F(BigInt(tenure), 12n)).mul(100n);
}
const commission = (collected, rate) => F.of(collected).mul(rate).div(100n).r2();
const sum2 = xs => xs.reduce((s, x) => s.add(x), ZERO).r2();

module.exports = { F, ZERO, r2, isLeap, addMonths, addDays, days, minD, monthsElapsed, interest, ledger, settlementOn,
  splitEqual, schedule, arrears, dpdBucket, ageBucket, planDates, nominalRate, commission, sum2 };

// ---------- self-check against the manual's worked examples (ch.5, v1.1) ----------
if (require.main === module) {
  const assert = require('node:assert');
  const A = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-01', maturity: '2027-01-01' };
  assert.equal(ledger(A, []).outstanding, '11800.00');                                   // 5.2 / INT-04
  assert.equal(settlementOn(A, [], '2026-03-02'), '10304.84');                           // 5.2 / PAY-17
  const pA = [{ date: '2026-03-02', amount: 1000 }];
  const a1 = ledger(A, pA);
  assert.equal(a1.principalRemaining, '9304.84'); assert.equal(a1.interest, '1696.06'); assert.equal(a1.outstanding, '10696.06'); // INT-06
  assert.equal(settlementOn(A, pA, '2026-06-15'), '9784.19');                            // 5.2
  const rsB = [{ effective: '2026-04-01', mode: 'monthly', rate: 1.2, maturity: '2027-10-01' }];
  const b = ledger(A, pA, { restructures: rsB });
  assert.equal(b.cuts[0].principal, '9304.84'); assert.equal(b.cuts[0].arrears, '135.07');
  assert.equal(b.interest, '2449.75'); assert.equal(b.outstanding, '11449.75');           // 5.3 / RS-11
  assert.deepEqual(schedule({ ...A, tenure: 3 }, [], { today: '2026-10-25' }).map(r => r.expected), ['150.00', '150.00', '10150.00']); // 5.4
  assert.deepEqual(splitEqual(1000, 3), ['333.33', '333.33', '333.34']);                  // 5.5
  const D = schedule({ principal: 10000, mode: 'fixed', lump: 1200, start: '2026-01-01', tenure: 12 }, [{ amount: 2000 }], { today: '2026-01-02' });
  assert.equal(D[2].paid, '133.34'); assert.equal(D[2].outstanding, '799.99'); assert.equal(D[11].expected, '933.37');
  const E = { principal: 1200, mode: 'fixed', lump: 0, start: '2026-01-01', tenure: 12 };
  assert.deepEqual(arrears(schedule(E, [], { today: '2026-04-15' }), '2026-04-15'), { dpd: 73, overdue: '300.00' });  // 5.6
  assert.deepEqual(arrears(schedule(E, [{ amount: 150 }], { today: '2026-04-15' }), '2026-04-15'), { dpd: 45, overdue: '150.00' });
  assert.deepEqual(planDates('2026-11-30', 3), ['2026-11-30', '2026-12-30', '2027-01-30']); // 5.7
  assert.equal(ledger({ principal: 36500, mode: 'daily', rate: 18, start: '2026-01-01', maturity: '2027-01-01' }, []).outstanding, '43070.00'); // 5.8
  assert.equal(commission(10000, 5), '500.00');                                           // 5.9
  // calendar edges
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28'); assert.equal(addMonths('2028-02-29', 1), '2028-03-29');
  assert.equal(monthsElapsed('2026-01-31', '2026-02-28').r2(), '1.00');
  assert.equal(r2(F.of('0.005')), '0.01'); assert.equal(r2(F.of('180.045')), '180.05');
  console.log('calc-r2/expected.qa.js self-check ok');
}
