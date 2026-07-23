const express = require('express');
const { all, get, run } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { caseWhere, isScoped } = require('../utils/scope');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const u = req.session.user;
  const where = []; const params = [];
  if (u.role === 'agent') { where.push('tasks.agent_id = ?'); params.push(u.agent_id); }
  else if (u.role === 'client') { const w = caseWhere(u); where.push(`tasks.case_id IN (SELECT id FROM cases WHERE ${w.clause})`); params.push(...w.params); }
  if (req.query.status) { where.push('tasks.status=?'); params.push(req.query.status); }
  if (req.query.type) { where.push('tasks.type=?'); params.push(req.query.type); }
  // Overdue = still pending and past its due date (in Malaysia time, UTC+8).
  if (req.query.overdue === '1') where.push("tasks.status='pending' AND tasks.due_date IS NOT NULL AND date(tasks.due_date) < date('now','+8 hours')");
  // Due-date window: an upper bound on how far ahead to look, independent of
  // the overdue flag above (a lower-bound signal). Unset/unknown = no cap.
  const WINDOW_DAYS = { '1': 1, '7': 7, '14': 14, '30': 30 };
  if (WINDOW_DAYS[req.query.window]) {
    where.push("tasks.due_date IS NOT NULL AND date(tasks.due_date) <= date('now','+8 hours', ?)");
    params.push(`+${WINDOW_DAYS[req.query.window]} days`);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const tasks = all(`SELECT tasks.*, cases.case_no, agents.name agent_name FROM tasks
    LEFT JOIN cases ON cases.id=tasks.case_id LEFT JOIN agents ON agents.id=tasks.agent_id
    ${clause} ORDER BY tasks.status, tasks.due_date`, params);
  const scoped = isScoped(u);
  const w2 = caseWhere(u);
  const cases = scoped
    ? all(`SELECT id,case_no,agent_id FROM cases WHERE ${w2.clause} ORDER BY case_no`, w2.params)
    : all('SELECT id,case_no,agent_id FROM cases ORDER BY case_no');
  const agents = scoped ? [] : all('SELECT id,name FROM agents ORDER BY name');
  res.render('tasks/index', { title: 'Tasks', tasks, cases, agents });
});
router.post('/new', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const b = req.body;
  const u = req.session.user;
  const w = caseWhere(u);
  // A task's agent always follows the case it's attached to — never a
  // separate manual pick, so it can never point at the wrong agent. Only
  // a case-less task falls back to the submitting agent's own id, or an
  // admin/manager's manual choice.
  let caseAgentId;
  if (b.case_id) {
    const caseRow = get(`SELECT id, agent_id FROM cases WHERE id=? AND ${w.clause}`, [b.case_id, ...w.params]);
    if (!caseRow) return res.redirect('/tasks?err=Invalid+case');
    caseAgentId = caseRow.agent_id;
  }
  const agentId = b.case_id ? caseAgentId : (u.role === 'agent' ? u.agent_id : (b.agent_id || null));
  run('INSERT INTO tasks (case_id,agent_id,type,title,due_date,notes) VALUES (?,?,?,?,?,?)',
    [b.case_id||null, agentId, b.type||'follow_up', b.title, b.due_date||null, b.notes||null]);
  res.redirect('/tasks?ok=Task+created');
});
router.post('/:id/complete', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const u = req.session.user;
  if (u.role === 'agent') {
    const task = get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
    if (!task) return res.redirect('/tasks?err=Not+found');
    if (task.agent_id !== u.agent_id) return res.redirect('/tasks?err=Forbidden');
  }
  run("UPDATE tasks SET status='done' WHERE id=?", [req.params.id]);
  res.redirect('/tasks?ok=Task+completed');
});
router.post('/:id', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const u = req.session.user;
  const task = get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!task) return res.redirect('/tasks?err=Not+found');
  if (u.role === 'agent' && task.agent_id !== u.agent_id) return res.redirect('/tasks?err=Forbidden');
  const b = req.body;
  run('UPDATE tasks SET title=?, type=?, due_date=?, notes=? WHERE id=?',
    [b.title || '', b.type || 'follow_up', b.due_date || null, b.notes || null, req.params.id]);
  res.redirect('/tasks?ok=Task+updated');
});
module.exports = router;
