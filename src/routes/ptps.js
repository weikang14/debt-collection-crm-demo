const express = require('express');
const { get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const router = express.Router();

function transition(req, res, newStatus, eventType, verb) {
  const ptp = get('SELECT * FROM ptps WHERE id=?', [req.params.id]);
  if (!ptp) return res.status(404).render('error', { message: 'PTP not found' });
  const w = caseWhere(req.session.user);
  const c = get(`SELECT * FROM cases WHERE id=? AND ${w.clause}`, [ptp.case_id, ...w.params]);
  if (!c) return res.status(403).render('error', { message: 'Forbidden' });
  run('UPDATE ptps SET status=? WHERE id=?', [newStatus, ptp.id]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [ptp.case_id, eventType, `PTP ${verb} (RM ${ptp.amount.toFixed(2)})`, req.session.user.full_name]);
  logAction(req, 'ptp_' + verb, 'case', ptp.case_id, `PTP ${ptp.id} ${verb}`);
  res.redirect(`/cases/${ptp.case_id}?ok=PTP+${verb}`);
}
router.post('/:id/fulfill', requireLogin, requireRole('admin','manager','agent'), (req, res) => transition(req, res, 'fulfilled', 'ptp_fulfilled', 'fulfilled'));
router.post('/:id/break', requireLogin, requireRole('admin','manager','agent'), (req, res) => transition(req, res, 'broken', 'ptp_broken', 'broken'));
module.exports = router;
