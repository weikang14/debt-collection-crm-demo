const express = require('express');
const { get, all } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { caseWhere, isScoped } = require('../utils/scope');
const { bucketAging, BUCKET_LABELS, bucketDpd, DPD_LABELS } = require('../utils/aging');
const { arrearsOf, restructuresOf } = require('../services/restructure');
const { TERMINAL_STATUSES } = require('../services/payments');
const { followupTasks } = require('../utils/followups');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const u = req.session.user;
  const w = caseWhere(u); // clause on `cases`
  const cq = (extra, params = []) => get(`SELECT COUNT(*) c, COALESCE(SUM(outstanding_amount),0) s FROM cases WHERE ${w.clause} ${extra}`, [...w.params, ...params]);
  // Portfolio balance (D-09): closed / cancelled cases don't count; legal,
  // bankruptcy and deceased do, and are also shown on their own.
  const outstanding = cq("AND status NOT IN ('closed','cancelled')").s;
  const specialOutstanding = cq("AND status IN ('legal','bankruptcy','deceased')").s;
  const legalCount = cq("AND status='legal'").c;
  // opened_at / closed_at are stored in UTC: shift them to MYT before taking the date.
  const openedToday = cq("AND date(opened_at,'+8 hours')=date('now','+8 hours')").c;
  const closedToday = cq("AND date(closed_at,'+8 hours')=date('now','+8 hours')").c;
  // payments today (join to scoped cases)
  const paid = get(`SELECT COALESCE(SUM(p.amount),0) s, COUNT(p.id) n FROM payments p JOIN cases c ON c.id=p.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND date(p.payment_date)=date('now','+8 hours')`, w.params);
  const collectedToday = paid.s, paymentsToday = paid.n;
  const ptpToday = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND date(t.due_date)=date('now','+8 hours')`, w.params).c;
  const brokenPtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='broken'`, w.params).c;
  const overduePtp = get(`SELECT COUNT(*) c FROM ptps t JOIN cases c ON c.id=t.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} AND t.status='pending' AND date(t.due_date) < date('now','+8 hours')`, w.params).c;
  const overdueTasks = isScoped(u)
    ? get("SELECT COUNT(*) c FROM tasks WHERE agent_id=? AND status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')", [u.agent_id]).c
    : get("SELECT COUNT(*) c FROM tasks WHERE status='pending' AND due_date IS NOT NULL AND date(due_date) < date('now','+8 hours')").c;
  // Aging: active outstanding grouped by debt age (days since opened), MYT.
  const tph = TERMINAL_STATUSES.map(() => '?').join(',');
  const agingRows = all(`SELECT CAST(julianday(date('now','+8 hours')) - julianday(date(opened_at,'+8 hours')) AS INTEGER) age, outstanding_amount amt
    FROM cases WHERE ${w.clause} AND outstanding_amount > 0 AND status NOT IN (${tph})`, [...w.params, ...TERMINAL_STATUSES]);
  const aging = bucketAging(agingRows);
  // Aging by days past due (D-09, the primary view): each open case's balance in
  // the bucket of its oldest missed instalment.
  // ponytail: computed per case on every load; cache DPD on the case if the book grows large.
  const dpdRows = all(`SELECT * FROM cases WHERE ${w.clause} AND outstanding_amount > 0 AND status NOT IN (${tph})`, [...w.params, ...TERMINAL_STATUSES])
    .map(c => ({ dpd: arrearsOf(c, all('SELECT amount, payment_date FROM payments WHERE case_id=? ORDER BY payment_date, id', [c.id]), restructuresOf(c.id)).dpd,
      amt: c.outstanding_amount }));
  const agingDpd = bucketDpd(dpdRows);
  // Active = still being worked: not terminal and not already paid off (D-09).
  const activeCases = get(`SELECT COUNT(*) c FROM cases WHERE ${w.clause} AND status NOT IN (${tph}) AND status <> 'fully_paid'`, [...w.params, ...TERMINAL_STATUSES]).c;
  // Upcoming follow-ups: pending tasks linked to a case, due within the next
  // 14 days (including anything already overdue) — see utils/followups.js.
  // followupCount is the full-window total; followups is the top 10 for display.
  const followupRows = followupTasks(u, 14);
  const followups = followupRows.slice(0, 10);
  const followupCount = followupRows.length;
  const recent = all(`SELECT e.*, c.case_no FROM timeline_events e JOIN cases c ON c.id=e.case_id WHERE ${w.clause.replace(/cases\./g,'c.')} ORDER BY e.created_at DESC, e.id DESC LIMIT 12`, w.params);
  let leaderboard = null;
  if (!isScoped(u)) {
    leaderboard = all(`SELECT a.name, COALESCE(SUM(p.amount),0) collected FROM agents a
      LEFT JOIN payments p ON p.agent_id=a.id
      GROUP BY a.id ORDER BY collected DESC LIMIT 5`);
  }
  res.render('dashboard/index', { title: 'Dashboard', kpi: { outstanding, specialOutstanding, legalCount, openedToday, closedToday, collectedToday, paymentsToday, activeCases, ptpToday, brokenPtp, overduePtp, overdueTasks, followupCount },
    aging, agingLabels: BUCKET_LABELS, agingDpd, dpdLabels: DPD_LABELS, followups, leaderboard, recent });
});
module.exports = router;
