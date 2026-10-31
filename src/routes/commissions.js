const express = require('express');
const { all, get, run } = require('../db');
const { commission, round2 } = require('../utils/helpers');
const { logAction } = require('../utils/audit');
const { parseMoney } = require('../utils/forms');
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
       COALESCE((SELECT SUM(p.amount) FROM payments p
                 WHERE p.agent_id = a.id AND substr(p.payment_date,1,7) = ?), 0) AS collected,
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

// Earned minus settled for one agent and month; negative when over-settled.
function pendingFor(agentId, period) {
  const a = get('SELECT commission_rate r FROM agents WHERE id=?', [agentId]);
  if (!a) return 0;
  const collected = get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE agent_id=? AND substr(payment_date,1,7)=?', [agentId, period]).s;
  const settled = get('SELECT COALESCE(SUM(amount),0) s FROM commission_settlements WHERE agent_id=? AND period=?', [agentId, period]).s;
  return round2(round2(commission(collected, a.r)) - settled);
}
// K-05: after a payment changes, the months it touched that are now settled
// beyond what was earned — reported to whoever made the change.
function overSettledNotes(touched) {
  const seen = new Set(), notes = [];
  for (const { agentId, date } of touched) {
    const period = String(date || '').slice(0, 7), key = agentId + '|' + period;
    if (!agentId || !period || seen.has(key)) continue;
    seen.add(key);
    const p = pendingFor(agentId, period);
    if (p < -0.005) notes.push(`commission for ${(get('SELECT name FROM agents WHERE id=?', [agentId]) || {}).name} in ${period} is now over-settled by RM ${(-p).toFixed(2)}`);
  }
  return notes;
}

function recordSettlement(body, req) {
  // parseMoney, not Number(): '0x10' and '1e2' are not amounts (G-28).
  const amount = parseMoney(body.amount);
  if (!(amount > 0) || amount > 1e9) return { ok: false, error: 'Invalid amount' };
  const agent = get('SELECT id FROM agents WHERE id=?', [body.agent_id]);
  if (!agent) return { ok: false, error: 'Agent not found' };
  const period = body.period || currentMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return { ok: false, error: 'Invalid period' };
  // K-05: never pay out more than was earned and is still unsettled for the month.
  const pending = pendingFor(agent.id, period);
  if (amount > pending + 0.005) return { ok: false, error: `Settlement exceeds the pending commission for ${period} (RM ${pending.toFixed(2)})` };
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

const { requirePerm, can } = require('../utils/permissions');
const canView = requirePerm('commissions.view');
const canSettle = requirePerm('commissions.settle');

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
    canSettle: can(req, 'commissions.settle'),
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

module.exports = { router, commissionRows, round2, recordSettlement, voidSettlement, pendingFor, overSettledNotes };
