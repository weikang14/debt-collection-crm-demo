const express = require('express');
const { all, get, run } = require('../db');
const { commission, round2 } = require('../utils/helpers');
const { logAction } = require('../utils/audit');
const { requireLogin, requireRole } = require('../middleware/auth');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
const router = express.Router();

// One row per in-scope agent for the given 'YYYY-MM' month.
// agent role → only own agent_id; everyone else → all agents.
function commissionRows(user, month) {
  const scoped = user && user.role === 'agent';
  const rows = all(
    `SELECT a.id AS agent_id, a.name, a.commission_rate AS rate,
       COALESCE((SELECT SUM(p.amount) FROM payments p JOIN cases c ON c.id = p.case_id
                 WHERE c.agent_id = a.id AND substr(p.payment_date,1,7) = ?), 0) AS collected,
       COALESCE((SELECT SUM(cs.amount) FROM commission_settlements cs
                 WHERE cs.agent_id = a.id AND cs.period = ?), 0) AS settled
     FROM agents a
     ${scoped ? 'WHERE a.id = ?' : ''}
     ORDER BY a.name`,
    scoped ? [month, month, user.agent_id || -1] : [month, month]);
  return rows.map((r) => {
    const earned = round2(commission(r.collected, r.rate));
    return { ...r, earned, pending: round2(earned - r.settled) };
  });
}

function currentMonth() { return dayjs.utc().add(8, 'hour').format('YYYY-MM'); }

function recordSettlement(body, req) {
  const amount = round2(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return { ok: false, error: 'Invalid amount' };
  const agent = get('SELECT id FROM agents WHERE id=?', [body.agent_id]);
  if (!agent) return { ok: false, error: 'Agent not found' };
  const period = body.period || currentMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return { ok: false, error: 'Invalid period' };
  const r = run('INSERT INTO commission_settlements (agent_id,period,amount,note,settled_by) VALUES (?,?,?,?,?)',
    [agent.id, period, amount, body.note || null, req.session.user.full_name]);
  logAction(req, 'commission_settle', 'agent', agent.id, `Settled RM ${amount} for ${period}`);
  return { ok: true, id: r.lastInsertRowid };
}

function voidSettlement(id, req) {
  const row = get('SELECT * FROM commission_settlements WHERE id=?', [id]);
  if (!row) return { ok: false, error: 'Not found' };
  run('DELETE FROM commission_settlements WHERE id=?', [id]);
  logAction(req, 'commission_void', 'agent', row.agent_id, `Voided settlement ${id} (RM ${row.amount})`);
  return { ok: true };
}

const canView = requireRole('admin', 'manager', 'finance', 'auditor', 'agent'); // excludes client
const canSettle = requireRole('admin', 'manager', 'finance');

router.get('/', requireLogin, canView, (req, res) => {
  const month = req.query.month || currentMonth();
  const rows = commissionRows(req.session.user, month);
  const scoped = req.session.user.role === 'agent';
  const history = all(
    `SELECT cs.*, a.name AS agent_name FROM commission_settlements cs JOIN agents a ON a.id=cs.agent_id
     WHERE cs.period = ? ${scoped ? 'AND cs.agent_id = ?' : ''} ORDER BY cs.created_at DESC`,
    scoped ? [month, req.session.user.agent_id || -1] : [month]);
  res.render('commissions/index', {
    title: 'Commissions', rows, history, month,
    canSettle: ['admin', 'manager', 'finance'].includes(req.session.user.role),
  });
});

router.post('/settle', requireLogin, canSettle, (req, res) => {
  const r = recordSettlement(req.body, req);
  const month = req.body.period || currentMonth();
  if (!r.ok) return res.redirect(`/commissions?month=${encodeURIComponent(month)}&err=${encodeURIComponent(r.error)}`);
  res.redirect(`/commissions?month=${encodeURIComponent(month)}&ok=Settlement+recorded`);
});

router.post('/:id/void', requireLogin, canSettle, (req, res) => {
  const row = get('SELECT period FROM commission_settlements WHERE id=?', [req.params.id]);
  if (!row) return res.redirect('/commissions?err=Settlement+not+found');
  voidSettlement(req.params.id, req);
  res.redirect(`/commissions?month=${encodeURIComponent(row.period)}&ok=Settlement+voided`);
});

module.exports = { router, commissionRows, round2, recordSettlement, voidSettlement };
