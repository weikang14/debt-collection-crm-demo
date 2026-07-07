const { db, get, run } = require('../db');
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
function recomputeOutstanding(caseId) {
  const c = get('SELECT principal_amount, interest_amount FROM cases WHERE id = ?', [caseId]);
  const paid = get('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE case_id = ?', [caseId]).s;
  const outstanding = round2(Math.max(0, (c.principal_amount + c.interest_amount) - paid));
  run('UPDATE cases SET outstanding_amount = ?, updated_at = datetime(\'now\') WHERE id = ?', [outstanding, caseId]);
  return outstanding;
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
  const next = statusAfterPayment(cur, outstanding, cnt);
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
  let next = statusAfterPayment(cur, outstanding, cnt);
  if (next === 'partial_paid' && cur === 'ptp') {
    const pending = get("SELECT COUNT(*) c FROM ptps WHERE case_id=? AND status='pending'", [caseId]).c;
    if (pending > 0) next = cur; // a live promise-to-pay outranks partial_paid
  }
  if (next !== cur) {
    run('UPDATE cases SET status=? WHERE id=?', [next, caseId]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [caseId, 'status_change', `Status changed ${cur} → ${next}`, by]);
  }
  return outstanding;
}
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, applyPayment, paymentWrites, resyncCaseStatus };
