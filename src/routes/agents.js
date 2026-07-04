const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const router = express.Router();
const canView = requireRole('admin','manager','auditor');
const canEdit = requireRole('admin','manager');

// Optional text -> trimmed string or null (never undefined, which SQLite rejects).
const S = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };

const STAT = `SELECT a.*,
  (SELECT COUNT(*) FROM cases WHERE agent_id=a.id) AS case_count,
  (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN cases c ON c.id=p.case_id WHERE c.agent_id=a.id) AS collected`;

router.get('/', requireLogin, canView, (req, res) => {
  const agents = all(`${STAT} FROM agents a ORDER BY collected DESC`);
  res.render('agents/list', { title: 'Agents', agents });
});
router.get('/new', requireLogin, canEdit, (req, res) => res.render('agents/form', { title: 'New Agent', agent: {}, action: '/agents' }));
router.post('/', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const name = S(b.name);
  if (!name) return res.redirect('/agents/new?err=Name+is+required');
  const r = run('INSERT INTO agents (name,contact,department,target_amount,commission_rate,active) VALUES (?,?,?,?,?,?)',
    [name,S(b.contact),S(b.department),Number(b.target_amount)||0,Number(b.commission_rate)||5, b.active?1:0]);
  logAction(req,'create','agent',r.lastInsertRowid,`Created agent ${name}`);
  res.redirect('/agents?ok=Agent+created');
});
router.get('/:id', requireLogin, canView, (req, res) => {
  const agent = get(`${STAT} FROM agents a WHERE a.id=?`, [req.params.id]);
  if (!agent) return res.status(404).render('error', { message: 'Agent not found' });
  const cases = all(`SELECT cases.*, debtors.name AS debtor_name FROM cases JOIN debtors ON debtors.id=cases.debtor_id WHERE agent_id=? ORDER BY opened_at DESC`, [req.params.id]);
  const attainment = agent.target_amount ? Math.round((agent.collected / agent.target_amount) * 100) : 0;
  res.render('agents/show', { title: agent.name, agent, cases, attainment });
});
router.get('/:id/edit', requireLogin, canEdit, (req, res) => {
  const agent = get('SELECT * FROM agents WHERE id=?', [req.params.id]);
  if (!agent) return res.status(404).render('error', { message: 'Agent not found' });
  res.render('agents/form', { title: 'Edit Agent', agent, action: `/agents/${agent.id}` });
});
router.post('/:id', requireLogin, canEdit, (req, res) => {
  const b = req.body;
  const name = S(b.name);
  if (!name) return res.redirect(`/agents/${req.params.id}/edit?err=Name+is+required`);
  run('UPDATE agents SET name=?,contact=?,department=?,target_amount=?,commission_rate=?,active=? WHERE id=?',
    [name,S(b.contact),S(b.department),Number(b.target_amount)||0,Number(b.commission_rate)||5, b.active?1:0, req.params.id]);
  logAction(req,'update','agent',Number(req.params.id),`Updated agent ${name}`);
  res.redirect(`/agents/${req.params.id}?ok=Saved`);
});
module.exports = router;
