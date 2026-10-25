const { db, get, all, run } = require('../db');
const { nextReceiptNo } = require('../utils/numbering');
const { logAction } = require('../utils/audit');
const dayjs = require('dayjs');
const { round2, todayMYT } = require('../utils/helpers');

const TERMINAL_STATUSES = ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased'];

function statusAfterPayment(current, outstanding, paymentCount) {
  if (TERMINAL_STATUSES.includes(current)) return current;
  if (outstanding <= 0) return 'fully_paid';
  if (paymentCount > 0) return 'partial_paid';
  // Outstanding reappeared with no payments left (e.g. a payment was voided):
  // a stale fully_paid must revert; any other status is left untouched.
  if (current === 'fully_paid') return 'negotiation';
  return current;
}
// A pending PTP outranks partial_paid: a live promise-to-pay case shouldn't
// flip to partial_paid just because one installment/PTP among several was
// paid. Shared by every write path (paymentWrites, resyncCaseStatus) so the
// invariant holds regardless of which route recorded the payment.
function livePtpGuard(cur, next, caseId) {
  if (next === 'partial_paid' && cur === 'ptp') {
    const pending = get("SELECT COUNT(*) c FROM ptps WHERE case_id=? AND status='pending'", [caseId]).c;
    if (pending > 0) return cur;
  }
  return next;
}
const MS_DAY = 86400000;
const TZ_OFFSET = 8 * 3600000; // dates are entered/stored in Malaysia local time (UTC+8)
// Whole calendar days between two dates, in local time. Fractional wall-clock
// time is dropped, so a case opened today accrues 0 (not a slice of a day that
// creeps up every second the page is reloaded), and interest steps once per day.
// ponytail: +8 offset hardcoded; lift to config/env if this ever runs off-Malaysia.
const localDay = t => Math.floor((new Date(t).getTime() + TZ_OFFSET) / MS_DAY);
const daysBetween = (a, b) => Math.max(0, localDay(b) - localDay(a));

// Per-day interest rate of the daily (annual %) mode: annual rate /365, the
// bank-contract convention. Other modes don't accrue by the day.
function dailyRate(c) {
  return c.interest_mode === 'daily' ? (c.interest_rate || 0) / 100 / 365 : 0;
}

// Malaysia calendar date (YYYY-MM-DD) of a stored date or datetime.
const localDate = t => new Date(localDay(t) * MS_DAY).toISOString().slice(0, 10);
// Months elapsed from `start` to `d`, counted on the loan's own monthly
// anniversaries (31 Jan → 28 Feb → 31 Mar, like the schedule's due dates); a
// part month is the share of that month's days. 0 when d is not after start.
function monthsSince(start, d) {
  const s = dayjs(localDate(start)), e = dayjs(localDate(d));
  if (!e.isAfter(s)) return 0;
  let k = Math.max(0, e.diff(s, 'month') - 1);
  while (!s.add(k + 1, 'month').isAfter(e)) k++;
  const a = s.add(k, 'month'), b = s.add(k + 1, 'month');
  return k + e.diff(a, 'day') / b.diff(a, 'day');
}

// Interest on `principal` from `from` to `to` under segment s (D-01): the
// monthly mode charges principal × monthly rate per whole month — so 1.5%/month
// is 18% a year in any year — and the daily mode annual rate /365 per day.
function accrue(s, principal, from, to) {
  if (s.interest_mode === 'daily') return principal * dailyRate(s) * daysBetween(from, to);
  if (s.interest_mode === 'monthly') {
    return principal * (s.interest_rate || 0) / 100 * Math.max(0, monthsSince(s.start, to) - monthsSince(s.start, from));
  }
  return 0;
}

// A case's loan as consecutive segments: segment 0 is the case's own terms and
// each restructure (sorted by effective_date) starts the next. `lump` is the
// fixed-mode interest, charged in full when its segment starts.
function loanSegments(c, restructures) {
  return [
    { interest_mode: c.interest_mode, interest_rate: c.interest_rate, lump: c.interest_amount || 0,
      start: c.interest_from || c.opened_at, maturity: c.maturity_date },
    ...restructures.map(r => ({ interest_mode: r.interest_mode, interest_rate: r.interest_rate, lump: r.interest_amount || 0,
      start: r.effective_date, maturity: r.maturity_date })),
  ];
}

// Interest-first (先息后本) balance. Walks payments in date order: between events
// interest accrues on the *remaining* principal, and each payment clears unpaid
// interest before it touches principal — so paying down principal shrinks all
// future interest. The loan runs as segments (see loanSegments): at each
// restructure's effective date, unpaid interest is carried as arrears that no
// longer accrues and the remaining principal continues under the new terms. A
// payment belongs to the segment whose window holds its date — one dated ON a
// restructure's effective date still belongs to the earlier segment (D-04).
// Pure; asOf is injectable and otherwise defaults to the last segment's
// maturity — the loan's fixed term, not "today" — falling back to today when
// there is none. `payments` MUST be sorted ascending by payment_date and
// `restructures` by effective_date. The identity outstanding = principal +
// interest − paid holds; `excess` is what payments paid beyond what was owed
// on their date (the write paths refuse any — see overpayError).
function caseBalance(c, payments, asOf, restructures = []) {
  const segs = loanSegments(c, restructures);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  let remP = c.principal_amount, unpaidInt = 0, paidInt = 0, excess = 0, pi = 0;
  segs.forEach((s, k) => {
    const next = segs[k + 1];
    // Interest stops at a segment's maturity — whether the accrual runs to the
    // segment's end or to a late payment — so a matured loan never keeps
    // charging, and restructuring one doesn't back-charge the days since.
    const capped = d => (s.maturity && localDay(d) > localDay(s.maturity) ? s.maturity : d);
    const end = capped(next ? next.start : (asOf || s.maturity || new Date()));
    const accrues = s.interest_mode === 'daily' || s.interest_mode === 'monthly';
    if (!accrues) unpaidInt += s.lump; // fixed: allocation order can't change its totals
    let last = s.start;
    for (; pi < payments.length && (!next || localDate(payments[pi].payment_date) <= localDate(next.start)); pi++) {
      const p = payments[pi];
      if (accrues) unpaidInt += accrue(s, remP, last, capped(p.payment_date));
      const toInt = Math.min(p.amount, unpaidInt); unpaidInt -= toInt; paidInt += toInt;
      excess += Math.max(0, p.amount - toInt - remP);
      remP = Math.max(0, remP - (p.amount - toInt));
      // Never move the accrual origin backwards: a payment dated before interest
      // starts must not make the days before the start count.
      if (accrues && localDay(p.payment_date) > localDay(last)) last = p.payment_date;
    }
    if (accrues) unpaidInt += accrue(s, remP, last, end);
  });
  return { principal: c.principal_amount, interest: round2(paidInt + unpaidInt), paid,
    outstanding: round2(Math.max(0, remP + unpaidInt)),
    principalRemaining: round2(remP), interestUnpaid: round2(unpaidInt), excess: round2(excess) };
}

const loadLedger = caseId => ({
  c: get('SELECT * FROM cases WHERE id = ?', [caseId]),
  payments: all('SELECT id, amount, payment_date FROM payments WHERE case_id = ? ORDER BY payment_date, id', [caseId]),
  restructures: all('SELECT * FROM case_restructures WHERE case_id = ? ORDER BY effective_date, id', [caseId]),
});

// What clears the loan on `date` (D-02): remaining principal plus interest
// accrued up to that day — not the whole contract's interest. Fixed-mode
// interest is charged in full up front, so it stays in. Payments after `date`
// are ignored.
function settlementOn(caseId, date) {
  const { c, payments, restructures } = loadLedger(caseId);
  if (!c) return 0;
  return caseBalance(c, payments.filter(p => localDate(p.payment_date) <= date), date, restructures).outstanding;
}

// Refuse a payment set that would pay more than is owed at some payment's date.
// `change` adds a payment ({amount, payment_date}) and/or replaces one (`replaceId`).
function overpayError(caseId, change) {
  const { c, payments, restructures } = loadLedger(caseId);
  const list = payments.filter(p => p.id !== change.replaceId).concat({ id: 0, amount: Number(change.amount), payment_date: change.payment_date })
    .sort((a, b) => localDate(a.payment_date).localeCompare(localDate(b.payment_date)) || (a.id || Infinity) - (b.id || Infinity));
  const { excess } = caseBalance(c, list, undefined, restructures);
  if (excess <= 0.005) return null;
  return `Amount exceeds what is owed on ${change.payment_date}: at most RM ${(Number(change.amount) - excess).toFixed(2)}`;
}

// Nominal annual rate of a set of loan terms, in % — what the legal cap is
// checked against (D-03). Fixed interest is annualised over the tenure in
// months; null when that can't be done (no tenure).
function nominalAnnualRate(t, principal) {
  if (t.interest_mode === 'monthly') return round2((t.interest_rate || 0) * 12);
  if (t.interest_mode === 'daily') return round2(t.interest_rate || 0);
  if (!t.tenure || !(principal > 0)) return null;
  return round2((t.interest_amount || 0) / principal / (t.tenure / 12) * 100);
}
const maxAnnualRate = () => (get('SELECT max_annual_rate m FROM settings WHERE id = 1') || {}).m ?? 18;
// The cap check shared by Case form and Restructure. null when allowed.
function rateCapError(t, principal) {
  const rate = nominalAnnualRate(t, principal), cap = maxAnnualRate();
  return rate !== null && rate > cap + 1e-9 ? `Interest rate exceeds the ${cap}% p.a. limit (this loan: ${rate}% p.a.)` : null;
}

function recomputeOutstanding(caseId) {
  const c = get('SELECT principal_amount, interest_amount, interest_mode, interest_rate, interest_from, opened_at, maturity_date FROM cases WHERE id = ?', [caseId]);
  if (!c) return 0; // case gone (e.g. recompute-on-load of an out-of-scope/missing id)
  const payments = all('SELECT amount, payment_date FROM payments WHERE case_id = ? ORDER BY payment_date, id', [caseId]);
  const restructures = all('SELECT * FROM case_restructures WHERE case_id = ? ORDER BY effective_date, id', [caseId]);
  const b = caseBalance(c, payments, undefined, restructures);
  // interest_charged caches total interest for every mode. interest_amount is the
  // fixed-mode input and is never overwritten: a restructure can switch a fixed
  // loan to an accrual mode, and segment 0 still needs its original lump.
  run("UPDATE cases SET outstanding_amount=?, interest_charged=?, updated_at=datetime('now') WHERE id=?", [b.outstanding, b.interest, caseId]);
  return b.outstanding;
}
// Accrual balances without a maturity grow every day, but lists, the dashboard
// and reports read the cached outstanding_amount. Refresh every accrual case
// once per Malaysia day (balances step by whole days, so once is enough).
// ponytail: per-process memo on each request; a nightly job if case counts grow large.
let refreshedOn = null;
function refreshStaleAccruals() {
  const today = todayMYT();
  if (refreshedOn === today) return;
  refreshedOn = today;
  for (const { id } of all("SELECT id FROM cases WHERE interest_mode IN ('monthly','daily')")) recomputeOutstanding(id);
}

// The 4 DB writes of a payment, WITHOUT a transaction wrapper or audit log, so a
// caller (recordFulfillment) can run them inside its own larger transaction —
// node:sqlite has no nested transactions/savepoints. Returns the receipt_no so
// the caller can log the payment after its transaction commits.
function paymentWrites(caseId, p) {
  const receipt_no = nextReceiptNo();
  const by = p.created_by;
  // agent_id = who held the case when the money came in, so commission stays
  // with the collector after a reassignment (D-11).
  run(`INSERT INTO payments (case_id, receipt_no, payment_date, amount, method, reference, bank, remark, created_by, agent_id)
       VALUES (?,?,?,?,?,?,?,?,?,(SELECT agent_id FROM cases WHERE id = ?))`,
    [caseId, receipt_no, p.payment_date, Number(p.amount), p.method || 'bank_transfer', p.reference || null, p.bank || null, p.remark || null, by, caseId]);
  run(`INSERT INTO timeline_events (case_id, event_type, content, created_by) VALUES (?,?,?,?)`,
    [caseId, 'payment', `Payment ${receipt_no}: RM ${Number(p.amount).toFixed(2)} via ${p.method || 'bank_transfer'}`, by]);
  const outstanding = resyncCaseStatus(caseId, by);
  return { receipt_no, outstanding, status: get('SELECT status FROM cases WHERE id = ?', [caseId]).status };
}
function applyPayment(caseId, p, req) {
  let r;
  db.transaction(() => { r = paymentWrites(caseId, { ...p, created_by: req.session.user.full_name }); })();
  logAction(req, 'payment', 'case', caseId, `Recorded payment ${r.receipt_no} amount ${p.amount}`);
  return r;
}

// Recompute outstanding + case status after a payment or case change. Honors the
// live-PTP guard (#5): a pending PTP outranks partial_paid. Writes a status_change
// timeline event when the status actually moves; paying off closes the case
// (closed_at, so it counts as closed today — D-09) and a revert reopens it.
// Call inside a transaction.
function resyncCaseStatus(caseId, by) {
  const outstanding = recomputeOutstanding(caseId);
  const cnt = get('SELECT COUNT(*) AS c FROM payments WHERE case_id = ?', [caseId]).c;
  const cur = get('SELECT status FROM cases WHERE id = ?', [caseId]).status;
  const next = livePtpGuard(cur, statusAfterPayment(cur, outstanding, cnt), caseId);
  if (next !== cur) {
    run(`UPDATE cases SET status=?, closed_at = CASE WHEN ? = 'fully_paid' THEN datetime('now') WHEN ? = 'fully_paid' THEN NULL ELSE closed_at END,
      updated_at=datetime('now') WHERE id=?`, [next, next, cur, caseId]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [caseId, 'status_change', `Status changed ${cur} → ${next}`, by]);
  }
  return outstanding;
}
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, refreshStaleAccruals, caseBalance, applyPayment, paymentWrites,
  resyncCaseStatus, dailyRate, daysBetween, accrue, monthsSince, localDate, settlementOn, overpayError, nominalAnnualRate, maxAnnualRate, rateCapError };
