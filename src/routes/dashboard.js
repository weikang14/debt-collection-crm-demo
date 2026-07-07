const express = require('express');
const { get, all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere, isScoped } = require('../utils/scope');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const u = req.session.user;
  const w = caseWhere(u); // clause on `cases`
  const cq = (extra, params = []) => get(`SELECT COUNT(*) c, COALESCE(SUM(outstanding_amount),0) s FROM cases WHERE ${w.clause} ${extra}`, [...w.params, ...params]);
  const outstanding = cq('').s;
  const legalCount = cq("AND status='legal'").c;
  const openedToday = cq("AND date(opened_at)=date('now','+8 hours')").c;
  const closedToday = cq("AND date(closed_at)=date('now','+8 hours')").c;
  // payments today (join to scoped cases)
  const collectedToday = get(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN cases c ON c.id=p.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND date(p.payment_date)=date('now','+8 hours')`, w.params).s;
  const ptpToday = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND date(t.due_date)=date('now','+8 hours')`, w.params).c;
  const brokenPtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='broken'`, w.params).c;
  const overduePtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND date(t.due_date) < date('now','+8 hours')`, w.params).c;
  const overdueTasks = (u.role === 'agent')
    ? get("SELECT COUNT(*) c FROM tasks WHERE agent_id=? AND status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')", [u.agent_id]).c
    : get("SELECT COUNT(*) c FROM tasks WHERE status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')").c;
  const recent = all(`SELECT e.*, c.case_no FROM timeline_events e JOIN cases c ON c.id=e.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} ORDER BY e.created_at DESC LIMIT 12`, w.params);
  let leaderboard = null;
  if (!isScoped(u)) {
    leaderboard = all(`SELECT a.name, COALESCE(SUM(p.amount),0) collected FROM agents a
      LEFT JOIN cases c ON c.agent_id=a.id LEFT JOIN payments p ON p.case_id=c.id
      GROUP BY a.id ORDER BY collected DESC LIMIT 5`);
  }
  res.render('dashboard/index', { title: 'Dashboard', kpi: { outstanding, legalCount, openedToday, closedToday, collectedToday, ptpToday, brokenPtp, overduePtp, overdueTasks }, leaderboard, recent });
});
module.exports = router;
