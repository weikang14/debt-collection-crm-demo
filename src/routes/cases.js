const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { caseWhere } = require('../utils/scope');
const { nextCaseNo, nextReceiptNo } = require('../utils/numbering');
const { recomputeOutstanding, TERMINAL_STATUSES } = require('../services/payments');
const router = express.Router();

const CASE_STATUSES = ['new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased'];
const PRIORITIES = ['low','medium','high','urgent'];
const noAgentCreate = requireRole('admin','manager'); // who can create/edit cases

// shared loader with scope enforcement
function loadCase(req, res) {
  const w = caseWhere(req.session.user);
  const c = get(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name,
    debtors.phone AS debtor_phone, debtors.ic_passport, agents.name AS agent_name
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE cases.id=? AND ${w.clause}`, [req.params.id, ...w.params]);
  if (!c) { res.status(404).render('error', { message: 'Case not found or access denied' }); return null; }
  return c;
}

router.get('/', requireLogin, (req, res) => {
  const w = caseWhere(req.session.user);
  const filters = [w.clause]; const params = [...w.params];
  if (req.query.status) { filters.push('cases.status = ?'); params.push(req.query.status); }
  if (req.query.priority) { filters.push('cases.priority = ?'); params.push(req.query.priority); }
  if (req.query.q) { filters.push('(cases.case_no LIKE ? OR debtors.name LIKE ?)'); params.push('%'+req.query.q+'%','%'+req.query.q+'%'); }
  const cases = all(`SELECT cases.*, clients.company_name AS client_name, debtors.name AS debtor_name, agents.name AS agent_name
    FROM cases JOIN clients ON clients.id=cases.client_id JOIN debtors ON debtors.id=cases.debtor_id
    LEFT JOIN agents ON agents.id=cases.agent_id WHERE ${filters.join(' AND ')} ORDER BY cases.opened_at DESC`, params);
  res.render('cases/list', { title: 'Cases', cases, statuses: CASE_STATUSES, priorities: PRIORITIES });
});

router.get('/new', requireLogin, noAgentCreate, (req, res) => {
  res.render('cases/form', { title: 'New Case', c: {}, action: '/cases',
    clients: all('SELECT id,company_name FROM clients ORDER BY company_name'),
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES });
});
router.post('/', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  const principal = Number(b.principal_amount)||0, interest = Number(b.interest_amount)||0;
  const case_no = nextCaseNo();
  const r = run(`INSERT INTO cases (case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,remark)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [case_no, b.client_id, b.debtor_id, b.agent_id||null, principal, interest, principal+interest, b.priority||'medium', b.status||'new', b.remark]);
  run('INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)', [r.lastInsertRowid,'note',`Case ${case_no} created`,req.session.user.full_name]);
  logAction(req,'create','case',r.lastInsertRowid,`Created case ${case_no}`);
  res.redirect(`/cases/${r.lastInsertRowid}?ok=Case+created`);
});
router.get('/:id/edit', requireLogin, noAgentCreate, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  res.render('cases/form', { title: 'Edit Case', c, action: `/cases/${c.id}`,
    clients: all('SELECT id,company_name FROM clients ORDER BY company_name'),
    debtors: all('SELECT id,name FROM debtors ORDER BY name'),
    agents: all('SELECT id,name FROM agents WHERE active=1 ORDER BY name'),
    statuses: CASE_STATUSES, priorities: PRIORITIES });
});
router.post('/:id', requireLogin, noAgentCreate, (req, res) => {
  const b = req.body;
  const principal = Number(b.principal_amount)||0, interest = Number(b.interest_amount)||0;
  run(`UPDATE cases SET client_id=?,debtor_id=?,agent_id=?,principal_amount=?,interest_amount=?,priority=?,remark=?,updated_at=datetime('now') WHERE id=?`,
    [b.client_id,b.debtor_id,b.agent_id||null,principal,interest,b.priority,b.remark,req.params.id]);
  recomputeOutstanding(Number(req.params.id));
  logAction(req,'update','case',Number(req.params.id),`Updated case ${req.params.id}`);
  res.redirect(`/cases/${req.params.id}?ok=Saved`);
});

router.get('/:id', requireLogin, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const timeline = all('SELECT * FROM timeline_events WHERE case_id=? ORDER BY created_at DESC', [c.id]);
  const payments = all('SELECT * FROM payments WHERE case_id=? ORDER BY payment_date DESC', [c.id]);
  const ptps = all('SELECT * FROM ptps WHERE case_id=? ORDER BY due_date DESC', [c.id]);
  const tasks = all('SELECT * FROM tasks WHERE case_id=? ORDER BY due_date', [c.id]);
  const calls = all('SELECT * FROM call_logs WHERE case_id=? ORDER BY call_time DESC', [c.id]);
  res.render('cases/show', { title: c.case_no, c, timeline, payments, ptps, tasks, calls,
    statuses: CASE_STATUSES, terminal: TERMINAL_STATUSES,
    readOnly: ['auditor','client'].includes(req.session.user.role) });
});

const { applyPayment } = require('../services/payments');
router.post('/:id/payments', requireLogin, requireRole('admin','manager','finance','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const r = applyPayment(c.id, req.body, req);
  res.redirect(`/cases/${c.id}?ok=Payment+${r.receipt_no}+recorded`);
});

router.post('/:id/ptps', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const by = req.session.user.full_name;
  run('INSERT INTO ptps (case_id,amount,due_date,remark,created_by) VALUES (?,?,?,?,?)', [c.id, Number(req.body.amount), req.body.due_date, req.body.remark||null, by]);
  if (!TERMINAL_STATUSES.includes(c.status)) run("UPDATE cases SET status='ptp' WHERE id=?", [c.id]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)", [c.id,'ptp_created',`PTP RM ${Number(req.body.amount).toFixed(2)} due ${req.body.due_date}`,by]);
  logAction(req,'ptp_create','case',c.id,`PTP created for case ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=PTP+created`);
});

router.post('/:id/calls', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const by = req.session.user.full_name;
  const dur = Number(req.body.duration_seconds)||0;
  run('INSERT INTO call_logs (case_id,agent_id,duration_seconds,result,notes) VALUES (?,?,?,?,?)',
    [c.id, req.session.user.agent_id||c.agent_id||null, dur, req.body.result||'no_answer', req.body.notes||null]);
  run("INSERT INTO timeline_events (case_id,event_type,content,created_by) VALUES (?,?,?,?)",
    [c.id,'call',`Call: ${req.body.result||'no_answer'} (${dur}s)${req.body.notes?' — '+req.body.notes:''}`, by]);
  logAction(req,'call','case',c.id,`Logged call for ${c.case_no}`);
  res.redirect(`/cases/${c.id}?ok=Call+logged`);
});

module.exports = { router, loadCase };
