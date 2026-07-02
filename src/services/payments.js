const { get, run } = require('../db');
const { nextReceiptNo } = require('../utils/numbering');
const { logAction } = require('../utils/audit');

const TERMINAL_STATUSES = ['legal', 'closed', 'cancelled', 'bankruptcy', 'deceased'];

function statusAfterPayment(current, outstanding, paymentCount) {
  if (TERMINAL_STATUSES.includes(current)) return current;
  if (outstanding === 0) return 'fully_paid';
  if (paymentCount > 0) return 'partial_paid';
  return current;
}
function recomputeOutstanding(caseId) {
  const c = get('SELECT principal_amount, interest_amount FROM cases WHERE id = ?', [caseId]);
  const paid = get('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE case_id = ?', [caseId]).s;
  const outstanding = Math.max(0, (c.principal_amount + c.interest_amount) - paid);
  run('UPDATE cases SET outstanding_amount = ?, updated_at = datetime(\'now\') WHERE id = ?', [outstanding, caseId]);
  return outstanding;
}
function applyPayment(caseId, p, req) {
  const receipt_no = nextReceiptNo();
  const by = req.session.user.full_name;
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
  logAction(req, 'payment', 'case', caseId, `Recorded payment ${receipt_no} amount ${p.amount}`);
  return { receipt_no, outstanding, status: next };
}
module.exports = { TERMINAL_STATUSES, statusAfterPayment, recomputeOutstanding, applyPayment };
