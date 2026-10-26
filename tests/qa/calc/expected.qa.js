// Role 2 (business) — INDEPENDENT expected-value calculator.
// Written from the business rules in the QA manual ch.5, NOT from src/.
// Exact arithmetic: BigInt fractions, half-up rounding to sen only at the end.
// Dates: own calendar math (no dayjs, no system helpers).
'use strict';

// ---------- exact fractions ----------
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
class F {
  constructor(n, d = 1n) { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); this.n = n / g; this.d = d / g; }
  static of(x) { // number | decimal string -> exact
    if (x instanceof F) return x;
    const s = String(x);
    const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.');
    const n = BigInt(i + f) * (neg ? -1n : 1n); return new F(n, 10n ** BigInt(f.length));
  }
  add(o) { o = F.of(o); return new F(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = F.of(o); return new F(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = F.of(o); return new F(this.n * o.n, this.d * o.d); }
  div(o) { o = F.of(o); return new F(this.n * o.d, this.d * o.n); }
  cmp(o) { o = F.of(o); const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  min(o) { return this.cmp(o) <= 0 ? this : F.of(o); }
  max(o) { return this.cmp(o) >= 0 ? this : F.of(o); }
  isPos() { return this.n > 0n; }
  // half-up (away from zero) to 2 dp -> string "1234.56"
  r2() {
    const neg = this.n < 0n; const n = neg ? -this.n : this.n;
    let sen = (n * 100n) / this.d; const rem = (n * 100n) % this.d;
    if (rem * 2n >= this.d) sen += 1n;
    const s = (sen / 100n).toString() + '.' + (sen % 100n).toString().padStart(2, '0');
    return (neg && sen !== 0n ? '-' : '') + s;
  }
  // floor to sen (non-negative use)
  floor2() { return new F((this.n * 100n) / this.d, 100n); }
  toNumber() { return Number(this.n) / Number(this.d); }
}
const r2 = (x) => F.of(x).r2();
const ZERO = new F(0n);

// ---------- calendar (MYT dates as YYYY-MM-DD) ----------
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dim = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const parse = (s) => s.split('-').map(Number);
const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dayNo = (s) => { const [y, m, d] = parse(s); return Date.UTC(y, m - 1, d) / 86400000; };
const days = (a, b) => Math.max(0, dayNo(b) - dayNo(a)); // whole days, same day = 0
// start + k months, clamped to month end, always measured from the ORIGINAL start
function addMonths(start, k) {
  const [y, m, d] = parse(start); const t = (m - 1) + k;
  const ny = y + Math.floor(t / 12), nm = (t % 12 + 12) % 12 + 1;
  return fmt(ny, nm, Math.min(d, dim(ny, nm)));
}
const addDays = (s, k) => { const t = new Date((dayNo(s) + k) * 86400000); return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

// per-day rate as exact fraction: monthly ÷30, annual ÷365
const dayRate = (mode, rate) => mode === 'monthly' ? F.of(rate).div(100).div(30)
  : mode === 'daily' ? F.of(rate).div(100).div(365) : ZERO;
const accrues = (mode) => mode === 'monthly' || mode === 'daily';

// ---------- ledger: interest-first, capped at maturity ----------
// loan: { principal, mode, rate, lump, start, maturity }   (maturity may be null)
// restructures: [{ effective, mode, rate, lump, maturity }] sorted
// payments: [{ date, amount }]  any order
// asOf: date the open-ended accrual runs to (default: last maturity, else today)
function ledger(loan, payments, { restructures = [], today, asOf } = {}) {
  const segs = [{ ...loan }, ...restructures.map((r) => ({ mode: r.mode, rate: r.rate, lump: r.lump || 0, start: r.effective, maturity: r.maturity }))];
  const pays = payments.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let remP = F.of(loan.principal), unpaid = ZERO, intTotal = ZERO, excess = ZERO, pi = 0;
  const cuts = [];
  segs.forEach((s, k) => {
    const next = segs[k + 1];
    const cap = (d) => (s.maturity && d > s.maturity ? s.maturity : d);
    const r = dayRate(s.mode, s.rate);
    if (!accrues(s.mode) && s.lump) { unpaid = unpaid.add(s.lump); intTotal = intTotal.add(s.lump); }
    let last = s.start;
    const accrue = (to) => { const t = cap(to); if (accrues(s.mode) && t > last) { const i = remP.mul(r).mul(days(last, t)); unpaid = unpaid.add(i); intTotal = intTotal.add(i); last = t; } };
    for (; pi < pays.length && (!next || pays[pi].date < next.start); pi++) {
      const p = pays[pi]; accrue(p.date);
      const amt = F.of(p.amount); const toInt = amt.min(unpaid); unpaid = unpaid.sub(toInt);
      const toP = amt.sub(toInt);
      if (toP.cmp(remP) > 0) { excess = excess.add(toP.sub(remP)); remP = ZERO; } else remP = remP.sub(toP);
    }
    const end = next ? next.start : (asOf || s.maturity || today);
    accrue(end);
    if (next) cuts.push({ effective: next.start, principal: remP.r2(), arrears: unpaid.r2() });
  });
  const paid = pays.reduce((s, p) => s.add(p.amount), ZERO);
  return { principalRemaining: remP.r2(), interestUnpaid: unpaid.r2(), interest: intTotal.r2(),
    outstanding: remP.add(unpaid).r2(), paid: paid.r2(), excess: excess.r2(), cuts };
}

// payoff as of a date (business view: interest accrued to that date only)
function payoffAsOf(loan, payments, date, opts = {}) {
  return ledger(loan, payments.filter((p) => p.date <= date), { ...opts, asOf: date, today: date, payoffMode: true });
}

// ---------- schedules ----------
function splitEqual(total, n) { // floor to sen, last absorbs remainder
  const t = F.of(total); const base = t.div(n).floor2();
  const parts = Array(n - 1).fill(base.r2()); parts.push(t.sub(base.mul(n - 1)).r2()); return parts;
}
function schedule({ principal, mode, rate, lump, start, tenure }, payments, { today, arrears, settled } = {}) {
  const dues = Array.from({ length: tenure }, (_, k) => addMonths(start, k + 1));
  let exp;
  if (accrues(mode)) {
    const r = dayRate(mode, rate); let prev = start;
    exp = dues.map((d, i) => { let e = F.of(principal).mul(r).mul(days(prev, d)); prev = d; let s = F.of(e.r2()); if (i === tenure - 1) s = s.add(principal); return s.r2(); });
  } else exp = splitEqual(F.of(principal).add(lump || 0), tenure);
  const rows = dues.map((d, i) => ({ due: d, expected: exp[i], kind: 'regular' }));
  if (arrears && F.of(arrears).isPos()) rows.unshift({ due: start, expected: F.of(arrears).r2(), kind: 'arrears' });
  let pool = payments.reduce((s, p) => s.add(p.amount), ZERO);
  return rows.map((row) => {
    const e = F.of(row.expected); const paid = e.min(pool.max(0)); pool = pool.sub(paid);
    const out = settled ? ZERO : e.sub(paid).max(0);
    const status = settled || paid.cmp(e) >= 0 ? 'Paid' : row.due < today ? 'Overdue' : paid.isPos() ? 'Partially Paid' : 'Pending';
    return { ...row, paid: paid.r2(), outstanding: out.r2(), status };
  });
}
const planDates = (first, n) => Array.from({ length: n }, (_, k) => addMonths(first, k));
const commission = (collected, rate) => F.of(collected).mul(rate).div(100).r2();

module.exports = { F, r2, isLeap, addMonths, addDays, days, dayRate, ledger, payoffAsOf, schedule, splitEqual, planDates, commission };

// self-check against the manual's worked examples (ch.5) — `node tests/qa/calc/expected.qa.js`
if (require.main === module) {
  const assert = require('node:assert');
  const A = { principal: 10000, mode: 'monthly', rate: 1.5, start: '2026-01-01', maturity: '2027-01-01' };
  assert.equal(ledger(A, []).outstanding, '11825.00');
  const a1 = ledger(A, [{ date: '2026-03-02', amount: 1000 }]);
  assert.equal(a1.outstanding, '10718.25'); assert.equal(a1.interest, '1718.25');
  const rs = [{ effective: '2026-04-01', mode: 'monthly', rate: 1.2, maturity: '2027-10-01' }];
  const b = ledger(A, [{ date: '2026-03-02', amount: 1000 }], { restructures: rs });
  assert.equal(b.cuts[0].arrears, '139.50'); assert.equal(b.outstanding, '11478.06'); assert.equal(b.interest, '2478.06');
  assert.deepEqual(schedule({ ...A, tenure: 3 }, [], { today: '2026-10-24' }).map((r) => r.expected), ['155.00', '140.00', '10155.00']);
  assert.deepEqual(splitEqual(1000, 3), ['333.33', '333.33', '333.34']);
  assert.deepEqual(planDates('2026-01-31', 3), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28'); assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(ledger({ principal: 36500, mode: 'daily', rate: 18, start: '2026-01-01', maturity: '2027-01-01' }, []).outstanding, '43070.00');
  assert.equal(r2(F.of('0.005')), '0.01'); assert.equal(commission(10000, 5), '500.00');
  console.log('expected.qa.js self-check ok');
}
