const express = require('express');
const { get, all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere, isScoped } = require('../utils/scope');
const { bucketAging, BUCKET_LABELS, bucketDpd, DPD_LABELS } = require('../utils/aging');
const { todayFigures } = require('../services/restructure');
const { TERMINAL_STATUSES, settlementOn } = require('../services/payments');
const { round2, todayMYT, daysOverdue, dateFmt } = require('../utils/helpers');
const { followupTasks } = require('../utils/followups');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const u = req.session.user;
  const w = caseWhere(u); // clause on `cases`
  const cq = (extra, params = []) => get(`SELECT COUNT(*) c, COALESCE(SUM(outstanding_amount),0) s FROM cases WHERE ${w.clause} ${extra}`, [...w.params, ...params]);
  // Portfolio balance (D-09): closed / cancelled cases don't count; legal,
  // bankruptcy and deceased do, and are also shown on their own. Totals are
  // today's settlement amounts (N-07, G-24); the contract balance, which
  // includes interest not yet due, is shown beside it.
  const open = all(`SELECT * FROM cases WHERE ${w.clause} AND status NOT IN ('closed','cancelled')`, w.params).map(c => ({ ...c, ...todayFigures(c) }));
  const sum = rows => round2(rows.reduce((s, c) => s + c.settlement, 0));
  const outstanding = sum(open);
  const contractOutstanding = round2(open.reduce((s, c) => s + c.outstanding_amount, 0));
  const specialOutstanding = sum(open.filter(c => ['legal', 'bankruptcy', 'deceased'].includes(c.status)));
  const legalCount = cq("AND status='legal'").c;
  // opened_at / closed_at are stored in UTC: shift them to MYT before taking the date.
  const openedToday = cq("AND date(opened_at,'+8 hours')=date('now','+8 hours')").c;
  const closedToday = cq("AND date(closed_at,'+8 hours')=date('now','+8 hours')").c;
  // payments today (join to scoped cases)
  const paid = get(`SELECT COALESCE(SUM(p.amount),0) s, COUNT(p.id) n FROM payments p JOIN cases c ON c.id=p.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND date(p.payment_date)=date('now','+8 hours')`, w.params);
  const collectedToday = paid.s, paymentsToday = paid.n;
  const ptpToday = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND c.status NOT IN ('bankruptcy','deceased') AND date(t.due_date)=date('now','+8 hours')`, w.params).c;
  const brokenPtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='broken'`, w.params).c;
  const overduePtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND c.status NOT IN ('bankruptcy','deceased') AND date(t.due_date) < date('now','+8 hours')`, w.params).c;
  const overdueTasks = isScoped(u)
    ? get("SELECT COUNT(*) c FROM tasks WHERE agent_id=? AND status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')", [u.agent_id]).c
    : get("SELECT COUNT(*) c FROM tasks WHERE status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')").c;
  // Aging of the cases still being worked (not terminal, not paid off), by
  // settlement amount: by days past due (D-09, the primary view: the bucket of
  // the oldest missed instalment) and by debt age (days since opened, MYT).
  const tph = TERMINAL_STATUSES.map(() => '?').join(',');
  const working = open.filter(c => c.outstanding_amount > 0 && !TERMINAL_STATUSES.includes(c.status));
  const aging = bucketAging(working.map(c => ({ age: daysOverdue(dateFmt(c.opened_at)), amt: c.settlement })));
  const agingDpd = bucketDpd(working.map(c => ({ dpd: c.dpd, amt: c.settlement })));
  // Active = still being worked: not terminal and not already paid off (D-09).
  const activeCases = get(`SELECT COUNT(*) c FROM cases WHERE ${w.clause} AND status NOT IN (${tph}) AND status <> 'fully_paid'`, [...w.params, ...TERMINAL_STATUSES]).c;
  // Upcoming follow-ups: pending tasks linked to a case, due within the next
  // 14 days (including anything already overdue) — see utils/followups.js.
  // followupCount is the full-window total; followups is the top 10 for display.
  const followupRows = followupTasks(u, 14);
  const followups = followupRows.slice(0, 10).map(f => ({ ...f, settlement: settlementOn(f.case_id, todayMYT()) }));
  const followupCount = followupRows.length;
  const recent = all(`SELECT e.*, c.case_no FROM timeline_events e JOIN cases c ON c.id=e.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} ORDER BY e.created_at DESC, e.id DESC LIMIT 12`, w.params);
  let leaderboard = null;
  if (!isScoped(u)) {
    leaderboard = all(`SELECT a.name, COALESCE(SUM(p.amount),0) collected FROM agents a
      LEFT JOIN payments p ON p.agent_id=a.id
      GROUP BY a.id ORDER BY collected DESC LIMIT 5`);
  }
  res.render('dashboard/index', { title: 'Dashboard', kpi: { outstanding, contractOutstanding, specialOutstanding, legalCount, openedToday, closedToday, collectedToday, paymentsToday, activeCases, ptpToday, brokenPtp, overduePtp, overdueTasks, followupCount },
    aging, agingLabels: BUCKET_LABELS, agingDpd, dpdLabels: DPD_LABELS, followups, leaderboard, recent });
});
module.exports = router;
