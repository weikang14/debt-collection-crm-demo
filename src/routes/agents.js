const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction, changeList } = require('../utils/audit');
const { parseActive, MAX_NAME } = require('../utils/forms');
const { settlementOn } = require('../services/payments');
const { todayMYT } = require('../utils/helpers');
const router = express.Router();
const { requirePerm } = require('../utils/permissions');
const canView = requirePerm('agents.view');
const canEdit = requirePerm('agents.edit');

// Optional text -> trimmed string or null (never undefined, which SQLite rejects).
const S = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };

// Form numbers: blank → the default; otherwise a finite number in range, else
// null (invalid). `Number(x) || 5` used to turn a deliberate 0% into 5%.
function num(v, dflt, max) {
  if (S(v) === null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}
function agentFields(b) {
  const name = S(b.name);
  if (!name) return { error: 'Name is required' };
  if (name.length > MAX_NAME) return { error: `Name must be at most ${MAX_NAME} characters` };
  const commission_rate = num(b.commission_rate, 5, 100);
  if (commission_rate === null) return { error: 'Commission rate must be 0–100' };
  const target_amount = num(b.target_amount, 0, 1e12);
  if (target_amount === null) return { error: 'Invalid target amount' };
  return { name, commission_rate, target_amount };
}

// The target is monthly (decided 2026-11-01), so Collected, Commission and Attainment here are this
// month's, by payment date; earlier months are on the Commissions page. The first ? is the month (YYYY-MM).
const STAT = `SELECT a.*,
  (SELECT COUNT(*) FROM cases WHERE agent_id=a.id) AS case_count,
  (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.agent_id=a.id AND substr(p.payment_date, 1, 7) = ?) AS collected`; // credited to the collector (D-11)

router.get('/', requireLogin, canView, (req, res) => {
  const where = [];
  const params = [];
  if (req.query.department) { where.push('a.department = ?'); params.push(req.query.department); }
  if (req.query.status === 'active') where.push('a.active = 1');
  else if (req.query.status === 'inactive') where.push('a.active = 0');
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const month = todayMYT().slice(0, 7);
  const agents = all(`${STAT} FROM agents a ${clause} ORDER BY collected DESC`, [month, ...params]);
  const departments = all("SELECT DISTINCT department FROM agents WHERE department IS NOT NULL AND department <> '' ORDER BY department").map(r => r.department);
  res.render('agents/list', { title: 'Agents', agents, departments, month });
});
router.get('/new', requireLogin, canEdit, (req, res) => res.render('agents/form', { title: 'New Agent', agent: {}, action: '/agents' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const f = agentFields(b);
  if (f.error) return res.redirect(`/agents/new?err=${encodeURIComponent(f.error)}`);
  const { name } = f;
  const r = run('INSERT INTO agents (name,contact,department,target_amount,commission_rate,active) VALUES (?,?,?,?,?,?)',
    [name,S(b.contact),S(b.department),f.target_amount,f.commission_rate, parseActive(b.active)]);
  logAction(req,'create','agent',r.lastInsertRowid,`Created agent ${name}`);
  res.redirect('/agents?ok=Agent+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const month = todayMYT().slice(0, 7);
  const agent = get(`${STAT} FROM agents a WHERE a.id=?`, [month, req.params.id]);
  if (!agent) return res.status(404).render('error', { message: 'Agent not found' });
  const cases = all(`SELECT cases.*, debtors.name AS debtor_name FROM cases JOIN debtors ON debtors.id=cases.debtor_id WHERE agent_id=? ORDER BY opened_at DESC`, [req.params.id])
    .map(c => ({ ...c, settlement: settlementOn(c.id, todayMYT()) }));
  const attainment = agent.target_amount ? Math.round((agent.collected / agent.target_amount) * 100) : 0;
  res.render('agents/show', { title: agent.name, agent, cases, attainment, month });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const agent = get('SELECT * FROM agents WHERE id=?', [req.params.id]);
  if (!agent) return res.status(404).render('error', { message: 'Agent not found' });
  res.render('agents/form', { title: 'Edit Agent', agent, action: `/agents/${agent.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const f = agentFields(b);
  if (f.error) return res.redirect(`/agents/${req.params.id}/edit?err=${encodeURIComponent(f.error)}`);
  const { name } = f;
  const old = get('SELECT * FROM agents WHERE id=?', [req.params.id]);
  if (!old) return res.status(404).render('error', { message: 'Agent not found' });
  const next = { name, contact: S(b.contact), department: S(b.department), target_amount: f.target_amount, commission_rate: f.commission_rate, active: parseActive(b.active) };
  run('UPDATE agents SET name=?,contact=?,department=?,target_amount=?,commission_rate=?,active=? WHERE id=?', [...Object.values(next), req.params.id]);
  const changes = changeList(old, next);
  logAction(req,'update','agent',Number(req.params.id),`Updated agent ${name}${changes.length ? ': ' + changes.join('; ') : ' (no field changes)'}`);
  res.redirect(`/agents/${req.params.id}?ok=Saved`);
});
module.exports = router;
