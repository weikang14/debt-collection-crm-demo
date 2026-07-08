const { db, get, all, run } = require('../db');
const { nextReceiptNo } = require('../utils/numbering');
const { logAction } = require('../utils/audit');

const TERMINAL_STATUSES = ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased'];

// Round a *derived* money value (a computed balance) to whole cents. Payments
// themselves are never rounded — only this balance is.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
const daysBetween = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / MS_DAY);

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

// Interest-first (先息后本) balance. Walks payments in date order: between events
// interest accrues on the *remaining* principal, and each payment clears accrued
// interest before it touches principal — so paying down principal shrinks all
// future interest. Pure; asOf is injectable for tests. `payments` MUST be sorted
// ascending by payment_date. `interest` returned is total interest charged to
// asOf, so the identity outstanding = principal + interest − paid still holds.
function caseBalance(c, payments, asOf = new Date()) {
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (c.interest_mode !== 'daily' && c.interest_mode !== 'monthly') {
    // fixed: interest is a lump, allocation order can't change the totals.
    const interest = c.interest_amount || 0;
    return { principal: c.principal_amount, interest, paid,
      outstanding: round2(Math.max(0, c.principal_amount + interest - paid)) };
  }
  const r = dailyRate(c);
  let remP = c.principal_amount, unpaidInt = 0, paidInt = 0, last = c.interest_from || c.opened_at;
  for (const p of payments) {
    unpaidInt += remP * r * daysBetween(last, p.payment_date);
    let amt = p.amount;
    const toInt = Math.min(amt, unpaidInt); unpaidInt -= toInt; amt -= toInt; paidInt += toInt;
    remP = Math.max(0, remP - amt); // remainder pays principal; any overpay is dropped (validatePayment blocks it)
    last = p.payment_date;
  }
  unpaidInt += remP * r * daysBetween(last, asOf);
  return { principal: c.principal_amount, interest: round2(paidInt + unpaidInt), paid,
    outstanding: round2(Math.max(0, remP + unpaidInt)) };
}

function recomputeOutstanding(caseId) {
  const c = get('SELECT principal_amount, interest_amount, interest_mode, interest_rate, interest_from, opened_at FROM cases WHERE id = ?', [caseId]);
  if (!c) return 0; // case gone (e.g. recompute-on-load of an out-of-scope/missing id)
  const payments = all('SELECT amount, payment_date FROM payments WHERE case_id = ? ORDER BY payment_date, id', [caseId]);
  const b = caseBalance(c, payments);
  // Accrual modes: cache the derived interest too, so views reading cases.interest_amount
  // (statement, reports) stay consistent. Fixed mode leaves the user-entered interest alone.
  if (c.interest_mode === 'daily' || c.interest_mode === 'monthly') {
    run("UPDATE cases SET outstanding_amount=?, interest_amount=?, updated_at=datetime('now') WHERE id=?", [b.outstanding, b.interest, caseId]);
  } else {
    run("UPDATE cases SET outstanding_amount=?, updated_at=datetime('now') WHERE id=?", [b.outstanding, caseId]);
  }
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
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, caseBalance, applyPayment, paymentWrites, resyncCaseStatus };
