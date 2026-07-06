const express = require('express');
const { get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const { applyPayment } = require('../services/payments');
const { validatePayment } = require('../utils/forms');
const router = express.Router();

// Fulfilling a PTP means the promised money was actually paid, so we record a
// payment (which lowers outstanding) in addition to marking the PTP fulfilled.
// Guarded: a non-pending PTP won't record another payment.
function recordFulfillment(ptpId, body, req) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [ptpId]);
  if (!ptp) return { ok: false, error: 'PTP not found' };
  if (ptp.status !== 'pending') return { ok: false, error: 'PTP already resolved' };
  const rawAmount = (body.amount !== undefined && body.amount !== '') ? body.amount : ptp.amount;
  const cs = get('SELECT outstanding_amount FROM cases WHERE id=?', [ptp.case_id]);
  const v = validatePayment(rawAmount, cs.outstanding_amount);
  if (v.error) return { ok: false, error: v.error };
  run("UPDATE ptps SET status='fulfilled' WHERE id=?", [ptp.id]);
  const payment_date = body.payment_date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const method = body.method || 'bank_transfer';
  applyPayment(ptp.case_id, { payment_date, amount: v.amount, method, remark: `PTP fulfilled` }, req);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
    [ptp.case_id, 'ptp_fulfilled', `PTP fulfilled (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_fulfilled', 'case', ptp.case_id, `PTP ${ptp.id} fulfilled`);
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
  res.redirect(`/cases/${caseId}?ok=PTP+fulfilled+and+payment+recorded`);
});

router.post('/:id/break', requireLogin, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const caseId = loadScopedCaseId(req, res); if (caseId === null) return;
  const ptp = get('SELECT * FROM ptps WHERE id=?', [req.params.id]);
  run("UPDATE ptps SET status='broken' WHERE id=?", [ptp.id]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)',
    [caseId, 'ptp_broken', `PTP broken (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_broken', 'case', caseId, `PTP ${ptp.id} broken`);
  res.redirect(`/cases/${caseId}?ok=PTP+broken`);
});

module.exports = router;
module.exports.recordFulfillment = recordFulfillment;
