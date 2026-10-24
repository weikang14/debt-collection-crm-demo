const { db, get, all, run } = require('../db');
const { nextReceiptNo } = require('../utils/numbering');
const { logAction } = require('../utils/audit');
const { round2 } = require('../utils/helpers');

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

// Per-day interest rate for accrual modes. daily: annual rate /365 (bank-contract
// convention). monthly: rate /30 (pro-rata by days — a part-month accrues its
// fraction). fixed returns 0 (no accrual).
// ponytail: monthly is day/30 pro-rata; switch to whole-month steps only if a
// lender demands it.
function dailyRate(c) {
  if (c.interest_mode === 'daily') return (c.interest_rate || 0) / 100 / 365;
  if (c.interest_mode === 'monthly') return (c.interest_rate || 0) / 100 / 30;
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
// payment belongs to the segment whose window holds its date (date < next
// segment's start → earlier segment). Pure; asOf is injectable for tests and
// otherwise defaults to the last segment's maturity — the loan's fixed term,
// not "today" — falling back to today when there is none. `payments` MUST be
// sorted ascending by payment_date and `restructures` by effective_date. The
// identity outstanding = principal + interest − paid holds.
function caseBalance(c, payments, asOf, restructures = []) {
  const segs = loanSegments(c, restructures);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  let remP = c.principal_amount, unpaidInt = 0, paidInt = 0, pi = 0;
  segs.forEach((s, k) => {
    const next = segs[k + 1];
    const end = next ? next.start : (asOf || s.maturity || new Date());
    const accrues = s.interest_mode === 'daily' || s.interest_mode === 'monthly';
    const r = dailyRate(s);
    if (!accrues) unpaidInt += s.lump; // fixed: allocation order can't change its totals
    let last = s.start;
    for (; pi < payments.length && (!next || payments[pi].payment_date < next.start); pi++) {
      const p = payments[pi];
      if (accrues) unpaidInt += remP * r * daysBetween(last, p.payment_date);
      const toInt = Math.min(p.amount, unpaidInt); unpaidInt -= toInt; paidInt += toInt;
      remP = Math.max(0, remP - (p.amount - toInt)); // any overpay is dropped (validatePayment blocks it)
      // Never move the accrual origin backwards: a payment dated before interest
      // starts must not make the days before the start count.
      if (accrues && localDay(p.payment_date) > localDay(last)) last = p.payment_date;
    }
    if (accrues) unpaidInt += remP * r * daysBetween(last, end);
  });
  return { principal: c.principal_amount, interest: round2(paidInt + unpaidInt), paid,
    outstanding: round2(Math.max(0, remP + unpaidInt)),
    principalRemaining: round2(remP), interestUnpaid: round2(unpaidInt) };
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
// The 4 DB writes of a payment, WITHOUT a transaction wrapper or audit log, so a
// caller (recordFulfillment) can run them inside its own larger transaction —
// node:sqlite has no nested transactions/savepoints. Returns the receipt_no so
// the caller can log the payment after its transaction commits.
function paymentWrites(caseId, p) {
  const receipt_no = nextReceiptNo();
  const by = p.created_by;
  run(`INSERT INTO payments (case_id, receipt_no, payment_date, amount, method, reference, bank, remark, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [caseId, receipt_no, p.payment_date, Number(p.amount), p.method || 'bank_transfer', p.reference || null, p.bank || null, p.remark || null, by]);
  const outstanding = recomputeOutstanding(caseId);
  const cnt = get('SELECT COUNT(*) AS c FROM payments WHERE case_id = ?', [caseId]).c;
  const cur = get('SELECT status FROM cases WHERE id = ?', [caseId]).status;
  const next = livePtpGuard(cur, statusAfterPayment(cur, outstanding, cnt), caseId);
  if (next !== cur) run('UPDATE cases SET status = ? WHERE id = ?', [next, caseId]);
  run(`INSERT INTO timeline_events (case_id, event_type, content, created_by) VALUES (?,?,?,?)`,
    [caseId, 'payment', `Payment ${receipt_no}: RM ${Number(p.amount).toFixed(2)} via ${p.method || 'bank_transfer'}`, by]);
  return { receipt_no, outstanding, status: next };
}
function applyPayment(caseId, p, req) {
  let r;
  db.transaction(() => { r = paymentWrites(caseId, { ...p, created_by: req.session.user.full_name }); })();
  logAction(req, 'payment', 'case', caseId, `Recorded payment ${r.receipt_no} amount ${p.amount}`);
  return r;
}

// Recompute outstanding + case status after a payment or case change. Honors the
// live-PTP guard (#5): a pending PTP outranks partial_paid. Writes a status_change
// timeline event when the status actually moves. Call inside a transaction.
function resyncCaseStatus(caseId, by) {
  const outstanding = recomputeOutstanding(caseId);
  const cnt = get('SELECT COUNT(*) AS c FROM payments WHERE case_id = ?', [caseId]).c;
  const cur = get('SELECT status FROM cases WHERE id = ?', [caseId]).status;
  const next = livePtpGuard(cur, statusAfterPayment(cur, outstanding, cnt), caseId);
  if (next !== cur) {
    run('UPDATE cases SET status=? WHERE id=?', [next, caseId]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [caseId, 'status_change', `Status changed ${cur} → ${next}`, by]);
  }
  return outstanding;
}
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, caseBalance, applyPayment, paymentWrites, resyncCaseStatus, dailyRate, daysBetween };
