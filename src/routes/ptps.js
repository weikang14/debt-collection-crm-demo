const express = require('express');
const { db, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const { paymentWrites, overpayError } = require('../services/payments');
const { validatePayment, methodError } = require('../utils/forms');
const { paymentDateError } = require('../services/restructure');
const router = express.Router();

// Fulfilling a PTP means the promised money was actually paid, so we record a
// payment (which lowers outstanding) in addition to marking the PTP fulfilled.
// Guarded: a non-pending PTP won't record another payment.
function recordFulfillment(ptpId, body, req) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [ptpId]);
  if (!ptp) return { ok: false, error: 'PTP not found' };
  if (ptp.status !== 'pending') return { ok: false, error: 'PTP already resolved' };
  const rawAmount = (body.amount !== undefined && body.amount !== '') ? body.amount : ptp.amount;
  const cs = get('SELECT outstanding_amount, status FROM cases WHERE id=?', [ptp.case_id]);
  // Bankrupt / deceased (D-13): money is taken through Record Payment with a reason.
  if (['bankruptcy', 'deceased'].includes(cs.status)) return { ok: false, error: 'Record this payment with a reason instead (bankrupt / deceased case)' };
  const v = validatePayment(rawAmount, cs.outstanding_amount);
  if (v.error) return { ok: false, error: v.error };
  const payment_date = body.payment_date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const dateErr = paymentDateError(ptp.case_id, payment_date) || methodError(body.method)
    || overpayError(ptp.case_id, { amount: v.amount, payment_date });
  if (dateErr) return { ok: false, error: dateErr };
  const method = body.method || 'bank_transfer';
  const by = req.session.user.full_name;
  // Less than promised = "partially kept" (D-10); no new promise is created for the rest.
  const partial = v.amount < ptp.amount - 0.005;
  const status = partial ? 'partially_kept' : 'fulfilled';
  const note = partial ? `PTP partially kept: RM ${v.amount.toFixed(2)} of RM ${ptp.amount.toFixed(2)}` : `PTP fulfilled (RM ${v.amount.toFixed(2)})`;
  // One transaction covers the PTP flip + payment writes + timeline, so a
  // payment failure can't leave an orphaned "fulfilled PTP, no payment".
  let receipt_no;
  db.transaction(() => {
    run('UPDATE ptps SET status=? WHERE id=?', [status, ptp.id]);
    ({ receipt_no } = paymentWrites(ptp.case_id, { payment_date, amount: v.amount, method, remark: note, created_by: by }));
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
      [ptp.case_id, 'ptp_fulfilled', note, by]);
  })();
  logAction(req, 'payment', 'case', ptp.case_id, `Recorded payment ${receipt_no} amount ${v.amount}`);
  logAction(req, 'ptp_fulfilled', 'case', ptp.case_id, `PTP ${ptp.id} ${partial ? 'partially kept' : 'fulfilled'}`);
  return { ok: true, caseId: ptp.case_id };
}

function breakPtp(ptpId, req) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [ptpId]);
  if (!ptp) return { ok: false, error: 'PTP not found' };
  // Same guard as recordFulfillment: a stale page or resubmit must not flip a
  // fulfilled PTP to broken or count one breach twice.
  if (ptp.status !== 'pending') return { ok: false, error: 'PTP already resolved' };
  run("UPDATE ptps SET status='broken' WHERE id=?", [ptp.id]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
    [ptp.case_id, 'ptp_broken', `PTP broken (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_broken', 'case', ptp.case_id, `PTP ${ptp.id} broken`);
  const cur = get('SELECT status FROM cases WHERE id=?', [ptp.case_id]).status;
  const pending = get("SELECT COUNT(*) c FROM ptps WHERE case_id=? AND status='pending'", [ptp.case_id]).c;
  if (cur === 'ptp' && pending === 0) {
    run("UPDATE cases SET status='negotiation', updated_at=datetime('now') WHERE id=?", [ptp.case_id]);
    run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
      [ptp.case_id, 'status_change', 'Status changed ptp → negotiation', req.session.user.full_name]);
  }
  return { ok: true, caseId: ptp.case_id };
}

// scope check shared by fulfill + break
function loadScopedCaseId(req, res) {
  const ptp = get('SELECT case_id FROM ptps WHERE id=?', [req.params.id]);
  if (!ptp) { res.status(404).render('error', { message: 'PTP not found' }); return null; }
  const w = caseWhere(req.session.user);
  const c = get(`SELECT id FROM cases WHERE id=? AND ${w.clause}`, [ptp.case_id, ...w.params]);
  if (!c) { res.status(403).render('error', { message: 'Forbidden' }); return null; }
  return ptp.case_id;
}

router.post('/:id/fulfill', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const caseId = loadScopedCaseId(req, res); if (caseId === null) return;
  const r = recordFulfillment(req.params.id, req.body, req);
  if (!r.ok) return res.redirect(`/cases/${caseId}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${caseId}?ok=PTP+payment+recorded`);
});

router.post('/:id/break', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const caseId = loadScopedCaseId(req, res); if (caseId === null) return;
  const r = breakPtp(req.params.id, req);
  if (!r.ok) return res.redirect(`/cases/${caseId}?err=${encodeURIComponent(r.error)}`);
  res.redirect(`/cases/${caseId}?ok=PTP+broken`);
});

module.exports = router;
module.exports.recordFulfillment = recordFulfillment;
module.exports.breakPtp = breakPtp;
