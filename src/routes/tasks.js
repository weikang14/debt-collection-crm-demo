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
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const tasks = all(`SELECT tasks.*, cases.case_no FROM tasks LEFT JOIN cases ON cases.id=tasks.case_id ${clause} ORDER BY tasks.status, tasks.due_date`, params);
  const scoped = isScoped(u);
  const w2 = caseWhere(u);
  const cases = scoped
    ? all(`SELECT id,case_no FROM cases WHERE ${w2.clause} ORDER BY case_no`, w2.params)
    : all('SELECT id,case_no FROM cases ORDER BY case_no');
  const agents = scoped ? [] : all('SELECT id,name FROM agents ORDER BY name');
  res.render('tasks/index', { title: 'Tasks', tasks, cases, agents });
});
router.post('/new', requireLogin, requireRole('admin','manager','agent'), (req, res) => {
  const b = req.body;
  const u = req.session.user;
  const scoped = isScoped(u);
  const w = caseWhere(u);
  if (scoped && b.case_id) {
    const ok = get(`SELECT 1 FROM cases WHERE id=? AND ${w.clause}`, [b.case_id, ...w.params]);
    if (!ok) return res.redirect('/tasks?err=Invalid+case');
  }
  const agentId = u.role === 'agent' ? u.agent_id : (b.agent_id || null);
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
module.exports = router;
